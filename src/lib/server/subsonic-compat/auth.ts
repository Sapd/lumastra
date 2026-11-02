// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Token Auth Service
// Manages per-user Subsonic tokens and validates incoming credentials.
//
// Subsonic auth requires the server to RECOVER the token: clients send
// `t = MD5(token + salt)`, so the server must hold the value itself and cannot
// hash it the way an ordinary password would be hashed. The token is generated
// server-side and is a long-lived bearer credential scoped to a single user.
//
// Because hashing is off the table, the token is instead ENCRYPTED at rest
// (AES-256-GCM via secret-box, keyed by the deployment master key) so a
// database-only compromise — a backup dump, a replica, SQL injection — does not
// by itself yield working credentials. Two columns back this:
//
//   token_sealed  the envelope, decrypted per auth (microseconds; the 60 s
//                 auth cache holds the envelope, not the plaintext)
//   token_lookup  HMAC-SHA256(masterKey, token) — a blind index, required
//                 because AES-GCM's random IV makes the envelope
//                 non-deterministic and therefore unsearchable. The
//                 apiKeyAuthentication reverse lookup matches on this.
//
// `token` (legacy plaintext) is still read so pre-migration rows keep working;
// they are upgraded in place on the next successful authentication. If no
// master key can be derived, everything degrades to the old plaintext
// behaviour rather than locking users out.

import { AuthDependencyUnavailableError } from '$lib/server/auth/dependency-unavailable.js';
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'crypto';
import { toUserId, type UserId } from '$lib/shared/user-id';
import type { Sql } from 'postgres';
import { cacheGet, cacheSet, cacheDel } from '$lib/server/cache/valkey';
import { aiDbService } from '$lib/server/services/database.service';
import {
    getTokenByUserId,
    getTokenByUsername,
    getTokenByValue,
    getTokenWithUserByUserId,
    upsertToken,
    upgradeTokenToSealed,
    updateLastUsed,
    deleteToken,
    type SubsonicPasswordRow,
} from '$lib/server/database/queries/subsonic-client-passwords.queries';
import {
    deriveMasterKey,
    sealSecret,
    openSecret,
    isSealed,
    isAadBound,
} from '$lib/server/crypto/secret-box';
import { resolveMasterKey } from '$lib/server/crypto/master-key';
import { Logger } from '$lib/server/utils/logger';
import type { StoreRotationResult } from '$lib/server/tasks/secrets.js';
import { buildUserPermissions } from '$lib/server/auth';
import {
    resolveTokenUserAccess,
    MOST_RESTRICTIVE_AGE_RATING,
} from '$lib/server/auth/resolve-token-user-access.js';
import { TOKEN_CACHE_PREFIX, TOKEN_CACHE_TTL } from './constants';

const logger = Logger.for('SubsonicCompat:Auth');

// 20 random bytes → 40 hex chars. High enough entropy that brute-forcing
// over the network is impractical.
const TOKEN_LENGTH = 20;

// Module-level dummy token used for constant-time comparisons when the
// requested user/key does not exist. Keeps the execution path (and therefore
// wall-clock timing) indistinguishable from a valid-user-wrong-credential
// path, preventing user-enumeration via timing.
const DUMMY_TOKEN = randomBytes(TOKEN_LENGTH).toString('hex');
// Placeholder UserId for the constant-time dummy-auth path only. The dummy
// CachedAuth is never returned (the caller returns null right after the
// timing-safe compare), so this value is never used as a data key.
const DUMMY_USER_ID = toUserId('00000000-0000-0000-0000-000000000000');

// =============================================================================
// Types
// =============================================================================

interface CachedAuth {
    /** Negative cache entries do the same credential work but can never authenticate. */
    credentialMissing?: true;
    userId: UserId;
    /**
     * The token as an `enc:v2:` envelope (bound to the username this entry is
     * filed under) whenever a master key is available,
     * so the 60 s Valkey cache — which lives on the EVICTABLE general instance,
     * not the noeviction coordination one — never holds a usable credential.
     * Falls back to plaintext only in the no-master-key degraded mode. Always
     * read it through `resolveToken()`, never directly.
     */
    token: string;
    isAdmin: boolean;
    displayName: string | null;
    groups: string[] | null;
    maxAgeRating: number | null;
    isAgeRestricted: boolean;
}

// =============================================================================
// Encryption at rest
// =============================================================================

let cachedMasterKey: Buffer | null = null;

/** Returns null when no master key can be derived — callers then stay on plaintext. */
function masterKey(): Buffer | null {
    if (cachedMasterKey) return cachedMasterKey;
    try {
        cachedMasterKey = deriveMasterKey(resolveMasterKey());
        return cachedMasterKey;
    } catch (err) {
        logger.warn('No master key available; Subsonic tokens stay in plaintext at rest', {
            error: String(err),
        });
        return null;
    }
}

/**
 * Deterministic blind index over a token. Distinct from any other HMAC use via
 * the domain-separation label, so a lookup value cannot be replayed as, or
 * correlated with, a digest computed elsewhere from the same master key.
 */
function tokenLookup(token: string): string | null {
    const key = masterKey();
    if (!key) return null;
    try {
        return createHmac('sha256', key)
            .update('subsonic-token-lookup-v1:' + token)
            .digest('hex');
    } catch {
        return null;
    }
}

// ── Row-binding contexts (security review 2026-09-13, C19) ────────────────────
//
// An envelope says nothing about WHICH row it came from, so `UPDATE
// subsonic_client_passwords SET token_sealed = <the admin's> WHERE user_id =
// <mine>` used to make /password/reveal hand back the admin's token. Binding
// the row identity in as AES-GCM AAD makes that transplant fail its auth tag.
//
// The id is lower-cased: the uuid column stores lower-case, but a caller can
// hand us the same id in any case (iOS sends upper-case UUIDs), and a write and
// a later read of the same row must agree on the exact byte string.

/** AAD context for a `subsonic_client_passwords` row. */
export function tokenContext(userId: string): string {
    return `subsonic_client_passwords:${userId.toLowerCase()}`;
}

/**
 * AAD context for a 60 s Valkey auth-cache entry, which is keyed by username.
 * The cache is a second copy of the same credential on an EVICTABLE instance —
 * binding it stops an entry being moved from one username's key to another's.
 */
function cacheContext(username: string): string {
    return `subsonic_auth_cache:${username.toLowerCase()}`;
}

/**
 * Re-seal every stored Subsonic token from `oldMasterKey` to `newMasterKey`
 * and recompute its blind index (security review 2026-09-12, C9).
 *
 * BOTH columns have to move together. `token_sealed` is AES-GCM under the
 * master key, and `token_lookup` is HMAC-SHA256 under the SAME key (see
 * `tokenLookup()` above) — rotating only the envelope would leave every
 * apiKeyAuthentication reverse lookup matching a digest nobody can reproduce,
 * so the token would still "exist" and never authenticate.
 *
 * Legacy plaintext rows are sealed under the new key in the same pass, so a
 * rotation does not leave a plaintext credential behind, and every row is
 * re-sealed BOUND to its own user_id (security review 2026-09-13, C19) — so a
 * rotation is also how an install upgrades its `enc:v1:` envelopes to `enc:v2:`.
 *
 * Per-row and idempotent: a token that already opens under the NEW key is
 * counted as rotated and its lookup rewritten under that key, so re-running
 * after a partial failure finishes the job rather than corrupting the rows
 * that did succeed.
 */
export async function rotateSubsonicTokens(
    sql: Sql,
    oldMasterKey: Buffer,
    newMasterKey: Buffer,
): Promise<StoreRotationResult> {
    const rows = await sql<
        { user_id: string; token: string | null; token_sealed: string | null }[]
    >`
        SELECT user_id::text, token, token_sealed
        FROM subsonic_client_passwords
        WHERE token_sealed IS NOT NULL OR token IS NOT NULL
    `;

    let rotated = 0;
    let skipped = 0;
    let legacyUpgraded = 0;
    const reasons: string[] = [];

    const lookupUnder = (key: Buffer, token: string): string =>
        createHmac('sha256', key)
            .update('subsonic-token-lookup-v1:' + token)
            .digest('hex');

    for (const row of rows) {
        const context = tokenContext(row.user_id);
        let plaintext: string | null = null;
        if (row.token_sealed && isSealed(row.token_sealed)) {
            for (const key of [newMasterKey, oldMasterKey]) {
                try {
                    plaintext = openSecret(row.token_sealed, key, context);
                    break;
                } catch {
                    // try the next key
                }
            }
        } else if (row.token) {
            plaintext = row.token;
        } else {
            // Nothing stored for this user — nothing to rotate.
            continue;
        }

        if (!plaintext) {
            skipped++;
            reasons.push(
                `subsonic_client_passwords user_id=${row.user_id}: token opens under neither the old nor the new master key`,
            );
            logger.warn('rotate: skipping unreadable Subsonic token', { userId: row.user_id });
            continue;
        }

        // Read BEFORE the write: plaintext counts as legacy too, because a
        // `token` column is every bit as transplantable as an unbound envelope.
        const wasLegacy = !row.token_sealed || !isAadBound(row.token_sealed);

        try {
            await sql`
                UPDATE subsonic_client_passwords
                SET token        = NULL,
                    token_sealed = ${sealSecret(plaintext, newMasterKey, context)},
                    token_lookup = ${lookupUnder(newMasterKey, plaintext)}
                WHERE user_id = ${row.user_id}::uuid
            `;
            if (wasLegacy) legacyUpgraded++;
            rotated++;
        } catch (err) {
            skipped++;
            reasons.push(
                `subsonic_client_passwords user_id=${row.user_id}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    }

    // Self-heal THIS process: the rows this replica just rewrote no longer open
    // under the key it cached at boot. Other replicas still need the env swap
    // and a restart — see docs/security/master-key-rotation.md.
    if (rotated > 0 && skipped === 0) cachedMasterKey = newMasterKey;

    // The 60 s auth cache holds tokens sealed under the OLD key; resolveToken()
    // would now fail to open them and fail closed for up to a minute. Entries
    // are per-username and we do not have the list here, so callers that need
    // immediate effect invalidate per user; the TTL bounds the rest.
    return { rotated, skipped, reasons, legacyUpgraded };
}

/**
 * Encode a token for storage. Returns the sealed pair when encryption is
 * available, otherwise the plaintext fallback — never throws, because failing
 * here would mean a user cannot get a Subsonic token at all.
 */
function encodeForStorage(
    userId: string,
    token: string,
): {
    token: string | null;
    tokenSealed: string | null;
    tokenLookup: string | null;
} {
    const key = masterKey();
    if (key) {
        try {
            const lookup = tokenLookup(token);
            if (lookup) {
                return {
                    token: null,
                    tokenSealed: sealSecret(token, key, tokenContext(userId)),
                    tokenLookup: lookup,
                };
            }
        } catch (err) {
            logger.warn('Could not seal Subsonic token; storing plaintext', {
                error: String(err),
            });
        }
    }
    return { token, tokenSealed: null, tokenLookup: null };
}

/**
 * Recover the plaintext token from a stored row (sealed or legacy plaintext).
 * Returns null when neither representation yields a value — an unopenable
 * envelope (rotated/mismatched master key) fails CLOSED: the user can no
 * longer authenticate and must reset, which is correct, since the alternative
 * would be silently accepting a token nobody can verify.
 */
function decodeFromStorage(
    row: Pick<SubsonicPasswordRow, 'user_id' | 'token' | 'token_sealed'>,
): string | null {
    if (row.token_sealed) {
        const key = masterKey();
        if (!key) return null;
        try {
            // Bound to THIS row: an envelope copied in from another user's row
            // fails the auth tag and the caller fails closed, exactly as it
            // does for an envelope under a retired master key.
            return openSecret(row.token_sealed, key, tokenContext(row.user_id)) || null;
        } catch (err) {
            logger.warn('Could not open sealed Subsonic token; user must reset', {
                error: String(err),
            });
            return null;
        }
    }
    return row.token || null;
}

/** Encode a token for the auth cache — sealed when possible, plaintext otherwise. */
function encodeForCache(username: string, token: string): string {
    const key = masterKey();
    if (!key) return token;
    try {
        return sealSecret(token, key, cacheContext(username));
    } catch {
        return token;
    }
}

/**
 * Recover the plaintext from a cache entry. Returns '' on failure; callers MUST
 * treat an empty result as invalid rather than comparing it, or a decrypt
 * failure would make an empty client-supplied password compare equal.
 */
function resolveToken(username: string, cached: CachedAuth): string {
    if (!isSealed(cached.token)) return cached.token;
    const key = masterKey();
    if (!key) return '';
    try {
        return openSecret(cached.token, key, cacheContext(username));
    } catch {
        return '';
    }
}

// =============================================================================
// Token generation / display
// =============================================================================

export function generateToken(): string {
    return randomBytes(TOKEN_LENGTH).toString('hex');
}

/**
 * Format a 40-char hex token for human-readable display as 8 groups of 5.
 * Returns the input unchanged if it doesn't match the expected shape.
 */
export function formatTokenForDisplay(token: string): string {
    return token.match(/.{1,5}/g)?.join(' ') ?? token;
}

// =============================================================================
// Cache helpers
// =============================================================================

async function getCachedAuth(username: string): Promise<CachedAuth | null> {
    const raw = await cacheGet(`${TOKEN_CACHE_PREFIX}${username}`);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as CachedAuth;
    } catch {
        return null;
    }
}

async function setCachedAuth(username: string, data: CachedAuth): Promise<void> {
    await cacheSet(`${TOKEN_CACHE_PREFIX}${username}`, JSON.stringify(data), TOKEN_CACHE_TTL);
}

/**
 * Invalidate the auth cache entry for a username. Called from admin paths
 * that mutate the token (reset, delete) so the change propagates immediately
 * rather than waiting for the natural TTL.
 */
export async function invalidateCacheForUser(username: string): Promise<void> {
    await cacheDel(`${TOKEN_CACHE_PREFIX}${username}`);
}

/**
 * Migrate a legacy plaintext row to the sealed representation, in place, the
 * first time it authenticates. Fire-and-forget: this never affects the auth
 * result, and a failure just means the row is retried on the next login.
 *
 * There is no eager backfill because sealing needs the master key, which SQL
 * does not have — so without this, existing tokens would stay in plaintext
 * until each user happened to reset one.
 */
function upgradeLegacyRow(
    sql: Sql,
    row: Pick<SubsonicPasswordRow, 'user_id' | 'token_sealed'>,
    plaintext: string,
): void {
    if (row.token_sealed) return;
    const key = masterKey();
    if (!key) return;

    void (async () => {
        try {
            const lookup = tokenLookup(plaintext);
            if (!lookup) return;
            await upgradeTokenToSealed.execute(sql, {
                userId: row.user_id,
                tokenSealed: sealSecret(plaintext, key, tokenContext(row.user_id)),
                tokenLookup: lookup,
            });
        } catch (err) {
            logger.warn('Failed to seal legacy Subsonic token; will retry on next auth', {
                userId: row.user_id,
                error: String(err),
            });
        }
    })();
}

// =============================================================================
// API key auth (apiKeyAuthentication extension)
// =============================================================================

export interface ApiKeyAuthResult {
    userId: UserId;
    username: string;
    isAdmin: boolean;
    displayName: string | null;
    userGroups: string[];
    maxAgeRating: number | null;
    isAgeRestricted: boolean;
}

/**
 * Validate an OpenSubsonic API key (same token as the Subsonic password,
 * looked up by value instead of by username). Strips display-format spaces
 * and lowercases (tokens are stored as lowercase hex; display/copy may vary).
 * Populates the per-username auth cache as a side effect.
 */
export async function validateApiKey(apiKey: string, sql: Sql): Promise<ApiKeyAuthResult | null> {
    // Spec max is 2048 URL-encoded chars; reject before hitting the DB.
    if (apiKey.length > 2048) return null;
    const normalized = apiKey.replace(/ /g, '').toLowerCase();
    if (!normalized) return null;

    // Matches the blind index for sealed rows and the raw column for legacy
    // ones; see getTokenByValue.
    const row = await getTokenByValue.one(sql, {
        token: normalized,
        lookup: tokenLookup(normalized),
    });

    // F53: Re-verify with timing-safe compare in application code. SQL equality
    // can leak timing information through query plan / short-circuit behaviour;
    // a constant-time comparison here eliminates that oracle. When no row is
    // found — or its envelope cannot be opened — we compare against a dummy
    // token to keep the execution path (and wall-clock time) indistinguishable
    // from the wrong-credential case.
    const stored = row ? decodeFromStorage(row) : null;
    const rowToken = stored ?? DUMMY_TOKEN;
    const providedBuf = Buffer.from(normalized, 'utf8');
    const storedBuf = Buffer.from(rowToken, 'utf8');
    const tokenMatch =
        providedBuf.length === storedBuf.length && timingSafeEqual(providedBuf, storedBuf);
    if (!row || !stored || !tokenMatch) return null;

    // Resolve the permission surface through the canonical resolver instead of
    // a bare `buildUserPermissions(row.groups)` — see `validateCredentials`
    // below for why that call dropped the in-app age ceiling outright. Only
    // reached once the token has already matched, so the wrong-credential and
    // unknown-key paths above keep their F53 timing shape.
    const access = await resolveTokenUserAccess(row.username.toLowerCase());
    // `.disabled` / `.deleted` alongside the null check — the established
    // idiom at every other resolveTokenUserAccess caller. `getTokenByValue`
    // filters `u.disabled_at IS NOT NULL` in SQL but says nothing about
    // `deleted_at`, and this module checked neither; per
    // `TokenUserAccess.deleted`'s contract every caller testing `disabled`
    // must test `deleted` beside it.
    if (!access || access.disabled || access.deleted) return null;
    const perms = access.permissions;

    // Warm the username cache so regular-auth requests from the same client hit it.
    // Non-fatal if the cache backend is unavailable.
    await setCachedAuth(row.username, {
        userId: toUserId(row.user_id),
        token: encodeForCache(row.username, stored),
        isAdmin: perms.ownerIsAdmin,
        displayName: row.display_name,
        groups: access.userGroups,
        maxAgeRating: perms.maxAgeRating,
        isAgeRestricted: perms.isAgeRestricted,
    }).catch(() => {});

    void upgradeLegacyRow(sql, row, stored);
    void updateLastUsed.execute(sql, { userId: row.user_id }).catch(() => {});

    return {
        userId: toUserId(row.user_id),
        username: row.username,
        isAdmin: perms.ownerIsAdmin,
        displayName: row.display_name,
        userGroups: access.userGroups,
        maxAgeRating: perms.maxAgeRating,
        isAgeRestricted: perms.isAgeRestricted,
    };
}

// =============================================================================
// Token CRUD
// =============================================================================

/**
 * Generate and persist a new token for the given user. Always issues a fresh
 * token — the previous value cannot be recovered after this call.
 * Invalidates the auth cache so clients are forced to re-authenticate with
 * the new token immediately.
 */
export async function getOrCreateToken(userId: string): Promise<string> {
    const sql = await aiDbService.getSql();
    if (!sql) {
        throw new Error('Database unavailable');
    }
    const token = generateToken();
    await upsertToken.execute(sql, { userId, ...encodeForStorage(userId, token) });
    const row = await getTokenWithUserByUserId.one(sql, { userId });
    if (row) await invalidateCacheForUser(row.username);
    logger.info(`Subsonic token created for user ${userId}`);
    return token;
}

/**
 * Reset (regenerate) the Subsonic token for a user.
 */
export async function resetToken(userId: string): Promise<string> {
    return getOrCreateToken(userId);
}

/**
 * Delete the stored token for a user (revokes Subsonic compat access).
 * Invalidates the auth cache immediately so the revocation takes effect
 * without waiting for the 60 s TTL.
 */
export async function deleteUserToken(userId: string, transactionSql?: Sql): Promise<void> {
    const sql = transactionSql ?? (await aiDbService.getSql());
    if (!sql) {
        throw new Error('Database unavailable');
    }
    const row = await getTokenWithUserByUserId.one(sql, { userId });
    await deleteToken.execute(sql, { userId });
    if (row) await invalidateCacheForUser(row.username);
    logger.info(`Subsonic token deleted for user ${userId}`);
}

/**
 * Read back a user's current Subsonic token for display in settings.
 *
 * Returns null when no token is configured, and also when one exists but its
 * envelope cannot be opened (master key rotated or not shared across
 * replicas). That second case is the same state authentication sees, so the
 * "reset it" the UI then offers is the genuine remedy, not a cosmetic
 * fallback.
 */
export async function revealToken(userId: string): Promise<string | null> {
    const sql = await aiDbService.getSql();
    if (!sql) return null;
    const row = await getTokenByUserId.one(sql, { userId });
    if (!row) return null;
    return decodeFromStorage(row);
}

/**
 * Returns true if the user has a stored Subsonic token.
 */
export async function getTokenStatus(userId: string): Promise<boolean> {
    const sql = await aiDbService.getSql();
    if (!sql) return false;
    const row = await getTokenByUserId.one(sql, { userId });
    return row !== null;
}

// =============================================================================
// Credential validation
// =============================================================================

/**
 * F52: Constant-time dummy comparison executed when a username is not found.
 * Performs the same hash / buffer work as the real comparison path so that
 * the wall-clock time is indistinguishable from the wrong-credential case,
 * preventing user-enumeration via response-time timing attacks.
 *
 * The result is intentionally discarded — this is pure side-effect timing work.
 */
function _dummyCompare(
    username: string,
    opts: { password: string } | { token: string; salt: string },
    dummy: CachedAuth,
): void {
    // Resolve exactly as the real path does — the dummy CachedAuth carries a
    // sealed token, so this performs the same AES-GCM decrypt. Skipping it
    // would make the unknown-user path measurably faster than the
    // wrong-credential path and reopen the enumeration oracle this guards.
    const dummyToken = resolveToken(username, dummy);
    if ('password' in opts) {
        let provided = opts.password;
        if (provided.startsWith('enc:')) {
            try {
                provided = Buffer.from(provided.slice(4), 'hex').toString('utf8');
            } catch {
                return;
            }
        }
        provided = provided.replace(/ /g, '');
        try {
            const a = Buffer.from(provided, 'utf8');
            const b = Buffer.from(dummyToken, 'utf8');
            void (a.length === b.length && timingSafeEqual(a, b));
        } catch {
            // intentional no-op
        }
    } else {
        const expected = createHash('md5')
            .update(dummyToken + opts.salt)
            .digest('hex');
        try {
            const a = Buffer.from(expected, 'utf8');
            const b = Buffer.from(opts.token.toLowerCase(), 'utf8');
            void (a.length === b.length && timingSafeEqual(a, b));
        } catch {
            // intentional no-op
        }
    }
}

/**
 * Validate Subsonic credentials. Supports both Subsonic auth modes:
 *
 *   Password mode: client sends `p=<token>` (or `p=enc:<hex>` — the
 *     hex-encoded token, used by some clients to avoid URL escaping issues).
 *
 *   Token mode: client sends `t=MD5(token+salt), s=<salt>`. The server
 *     recomputes the digest and compares.
 *
 * Returns the cached auth context on success, or null on any failure
 * (unknown user, missing token, mismatch). Updates `last_used_at` as a
 * fire-and-forget side effect on success.
 */
export async function validateCredentials(
    username: string,
    opts: { password: string } | { token: string; salt: string },
): Promise<CachedAuth | null> {
    let cached = await getCachedAuth(username);
    if (cached?.credentialMissing) {
        _dummyCompare(username, opts, cached);
        return null;
    }
    // Set on the cache-MISS path, where we already hold the decrypted token.
    // Reusing it avoids sealing and immediately re-opening the same value —
    // which was both wasted work and a timing asymmetry: the real path did two
    // decrypts while the unknown-user dummy path did one, so a cold-cache probe
    // could distinguish 'no such user' from 'wrong password'.
    let freshPlaintext: string | null = null;
    if (!cached) {
        const sql = await aiDbService.getSql();
        if (!sql) throw new AuthDependencyUnavailableError();
        const row = await getTokenByUsername.one(sql, { username });
        if (!row) {
            // F52: Perform a dummy constant-time comparison so that requests for
            // nonexistent users take the same amount of time as requests for
            // existing users with wrong credentials. Without this, an attacker
            // can enumerate valid usernames by measuring response latency.
            const dummyPerms = buildUserPermissions([]);
            const dummyCached: CachedAuth = {
                credentialMissing: true,
                userId: DUMMY_USER_ID,
                // Sealed like a real cache entry so _dummyCompare's resolve
                // step does the same decrypt work as the genuine path.
                token: encodeForCache(username, DUMMY_TOKEN),
                isAdmin: false,
                displayName: null,
                groups: null,
                maxAgeRating: dummyPerms.maxAgeRating,
                isAgeRestricted: dummyPerms.isAgeRestricted,
            };
            // Cache absent users too: repeated bad credentials must not reveal
            // existence by skipping the DB only for real usernames. The marker
            // keeps the dummy credential from ever authenticating.
            await setCachedAuth(username, dummyCached);
            void _dummyCompare(username, opts, dummyCached);
            return null;
        }
        const stored = decodeFromStorage(row);
        if (!stored) {
            // A row exists but its token is unrecoverable (envelope written
            // under a different master key). Fail closed, and still burn the
            // dummy comparison so this is timing-indistinguishable from a wrong
            // credential rather than becoming its own oracle.
            const dummyPerms = buildUserPermissions([]);
            void _dummyCompare(username, opts, {
                userId: DUMMY_USER_ID,
                token: encodeForCache(username, DUMMY_TOKEN),
                isAdmin: false,
                displayName: null,
                groups: null,
                maxAgeRating: dummyPerms.maxAgeRating,
                isAgeRestricted: dummyPerms.isAgeRestricted,
            });
            return null;
        }
        // isAdmin/maxAgeRating/isAgeRestricted here are placeholders only —
        // NOT a third permission formula. They used to be computed from the
        // raw `row.is_admin` column and a bare `buildUserPermissions(row.
        // groups ?? [])` (groups only, no pin, no in-app capability term),
        // which would disagree with the canonical resolver for a pinned or
        // in-app-restricted account. Fix-plan-5 Task 9 review round 1,
        // Minor 5: only the SUCCESS return at the bottom of this function
        // overwrites these three fields with `resolveTokenUserAccess()`'s
        // verdict (see the comment there) before handing the result to a
        // caller — the rejection paths below (wrong credential, disabled,
        // soft-deleted) return `null` without ever reading this cache entry
        // back out. `validateApiKey` DOES write this same cache key
        // (`row.username`, `setCachedAuth` at ~:500) — it is NOT true that it
        // never touches this slot. It is simply not the OVERRIDE protecting
        // THIS call's return value: that write happens on a separate
        // invocation, for a different code path's success case, and this
        // function's own safety comes entirely from its own control flow (the
        // success return below overwrites these three fields with
        // `resolveTokenUserAccess()`'s verdict; the rejection paths never
        // read this cache entry back out). So they are seeded fail-closed
        // here in case a future code path reads this specific cache entry
        // without going through the success return's override.
        cached = {
            userId: toUserId(row.user_id),
            token: encodeForCache(username, stored),
            isAdmin: false,
            displayName: row.display_name,
            groups: row.groups,
            maxAgeRating: MOST_RESTRICTIVE_AGE_RATING,
            isAgeRestricted: true,
        };
        await setCachedAuth(username, cached);
        freshPlaintext = stored;
        upgradeLegacyRow(sql, row, stored);
    }

    // One decrypt per request, matching what the dummy path does. Empty means
    // the envelope failed to open — never compare it, or an empty
    // client-supplied password would match (`timingSafeEqual` of two
    // zero-length buffers is true).
    const storedToken = freshPlaintext ?? resolveToken(username, cached);
    if (!storedToken) return null;

    let valid: boolean;

    if ('password' in opts) {
        // Password mode — `p=token` or `p=enc:<hex>`
        let provided = opts.password;
        if (provided.startsWith('enc:')) {
            try {
                provided = Buffer.from(provided.slice(4), 'hex').toString('utf8');
            } catch {
                return null;
            }
        }
        // Strip spaces: the UI displays the token with spaces for readability
        // (e.g. "12345 67890 ...") but the stored value is unspaced hex.
        provided = provided.replace(/ /g, '');
        // Constant-time compare; mismatched lengths are a guaranteed mismatch
        // and would throw inside timingSafeEqual otherwise.
        try {
            const a = Buffer.from(provided, 'utf8');
            const b = Buffer.from(storedToken, 'utf8');
            valid = a.length === b.length && timingSafeEqual(a, b);
        } catch {
            // fail-closed: any comparison error → invalid credential.
            valid = false;
        }
    } else {
        // Token mode — t = MD5(token + salt)
        const expected = createHash('md5')
            .update(storedToken + opts.salt)
            .digest('hex');
        // MD5 hex output is fixed-length, so a direct string compare is fine
        // for correctness. Use timingSafeEqual to avoid timing leaks.
        // Lowercase the client digest — some Android clients send uppercase hex.
        try {
            const a = Buffer.from(expected, 'utf8');
            const b = Buffer.from(opts.token.toLowerCase(), 'utf8');
            valid = a.length === b.length && timingSafeEqual(a, b);
        } catch {
            // fail-closed: any comparison error → invalid credential.
            valid = false;
        }
    }

    if (!valid) return null;

    // Fire-and-forget last_used_at update. We deliberately don't await this:
    // it's a write that doesn't affect the auth result, and Subsonic auth
    // happens on every API call so blocking would amplify latency.
    void aiDbService
        .getSql()
        .then((sql) => {
            if (!sql) return;
            return updateLastUsed.execute(sql, { userId: cached.userId }).catch((err: unknown) => {
                logger.warn('Failed to update last_used_at for Subsonic token', {
                    userId: cached.userId,
                    error: String(err),
                });
            });
        })
        .catch(() => {
            // sql lookup itself failed — already-degraded path, swallow.
        });

    // Resolve the permission surface through the canonical resolver rather than
    // returning the cache entry's own age fields.
    //
    // Pre-fix, both producers here derived permissions with a bare
    // `buildUserPermissions(row.groups ?? [])` — no `extraCapabilities` — and
    // this module read neither `users.age_rating_pinned` nor
    // `users.max_age_rating` anywhere. Per `access-control.service.ts` the
    // in-app layer drives age ONLY through the MIN-merged `max_age_rating`
    // capability (age-NAMED in-app groups are stripped so a permissive cohort
    // can never RAISE a ceiling), so a bare call dropped an in-app-conferred
    // restriction outright — permanently, not just during a fault. On a
    // standalone (no-IdP) install the in-app cohort IS the age mechanism.
    // `toUserContext` (media-access.ts) feeds these two fields straight into
    // the age gate.
    //
    // Deliberately placed AFTER the credential comparison: the unknown-user
    // and wrong-credential paths do no extra work, so the F52/F53 constant-time
    // shape that keeps them indistinguishable is untouched. It also means the
    // 60s auth cache never decides the age axis — that entry is keyed on the
    // token, but in-app cohort membership changes independently of it.
    //
    // `users.username` is stored lower-cased (`upsertUser`), and this cache is
    // keyed by the client-supplied spelling, so lower-case to hit the
    // resolver's exact-match `getUserByUsername` lookup.
    const access = await resolveTokenUserAccess(username.toLowerCase());
    // See validateApiKey above: `deleted_at` has no SQL filter on either
    // lookup, and a warm 60s cache entry skips the `disabled_at` one too, so
    // both lifecycle flags are enforced here at the seam.
    if (!access || access.disabled || access.deleted) return null;

    return {
        ...cached,
        isAdmin: access.permissions.ownerIsAdmin,
        groups: access.userGroups,
        maxAgeRating: access.permissions.maxAgeRating,
        isAgeRestricted: access.permissions.isAgeRestricted,
    };
}
