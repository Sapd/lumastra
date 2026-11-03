// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// Jellyfin Compatibility Layer — Client Password Auth Service
// Manages short human-readable passwords and Valkey-backed session tokens
// for Jellyfin-compatible clients connecting to Lumastra.

import {
    createHash,
    randomBytes,
    randomInt,
    timingSafeEqual,
    scrypt as scryptCb,
    type ScryptOptions,
} from 'crypto';
import { promisify } from 'node:util';
import type { Sql } from 'postgres';
import { Database } from '$lib/server/database/connection';
import {
    getPasswordByUserId,
    getPasswordByUsername,
    upsertPassword,
    updateLastUsed,
    deletePassword,
    getUsersWithPasswords,
} from '$lib/server/database/queries/jellyfin-client-passwords.queries';
import {
    cacheGet,
    cacheGetOrThrow,
    cacheSet,
    cacheDel,
    cacheExists,
    expire,
    sAdd,
    sRem,
    sMembers,
    getCoordinationClient,
} from '$lib/server/cache/valkey';
import { deriveMasterKey, sealSecret, openSecret, isSealed } from '$lib/server/crypto/secret-box';
import {
    rotateJellyfinClientPasswords,
    jellyfinClientPasswordContext,
    type StoreRotationResult,
} from '$lib/server/tasks/secrets';
import { resolveMasterKey } from '$lib/server/crypto/master-key';
import {
    AuthDependencyUnavailableError,
    isDependencyError,
} from '$lib/server/auth/dependency-unavailable.js';
import { resolveTokenUserAccess } from '$lib/server/auth/resolve-token-user-access';
import { QC_SECRET_PREFIX, QC_CODE_PREFIX, type QuickConnectData } from './quick-connect-utils';
import { Logger } from '$lib/server/utils/logger';

import { withUserCredentialLock } from '$lib/server/services/user-credential-lock';

const logger = Logger.for('JellyfinCompat:Auth');

// Character set: no ambiguous chars (0oO1lLiI removed)
const PASSWORD_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const PASSWORD_LENGTH = 8;

// Valkey key prefix and TTL for Jellyfin compat sessions
const SESSION_KEY_PREFIX = 'jfcompat:session:';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// Per-user index of live session tokens, so "list my connected clients" is an
// O(sessions-for-this-user) SMEMBERS instead of a full `jfcompat:session:*`
// SCAN on every settings page load. The index is a CACHE of the session keys,
// never the source of truth: members whose session key has expired are dropped
// lazily on read (Valkey cannot expire individual set members). Revocation
// still works without it — revokeSessionsForUser() keeps its own SCAN so a
// missing/stale index can never leave a session live.
const SESSION_INDEX_PREFIX = 'jfcompat:user-sessions:';
// Marks that the index for a user has been backfilled from a SCAN at least
// once. Needed because an EMPTY Valkey set does not exist, so "index key
// absent" alone cannot distinguish "never built" from "no sessions" — without
// this marker a user with zero clients would trigger a full SCAN on every load.
const SESSION_INDEX_BUILT_PREFIX = 'jfcompat:user-sessions-built:';

// =============================================================================
// Types
// =============================================================================

export interface JellyfinSession {
    userId: string;
    username: string;
    isAdmin: boolean;
    groups: string[];
    displayName: string | null;
    deviceId: string;
    deviceName: string;
    clientName: string;
    clientVersion: string;
    createdAt: string;
    origin?: 'quick_connect';
    approvedBySessionToken?: string;
}

// =============================================================================
// Internal helpers
// =============================================================================

const scrypt = promisify(scryptCb) as (
    password: string | Buffer,
    salt: string | Buffer,
    keylen: number,
    options: ScryptOptions,
) => Promise<Buffer>;

// scrypt KDF for client-password hashing. Implemented LOCALLY here (deliberately
// NOT importing the AGPL-core `crypto/password.ts`) to respect the one-directional
// open→proprietary boundary documented in that file. Self-describing stored
// format so a future cost bump can be detected and upgraded:
//   scrypt$N=<N>,r=<r>,p=<p>$<saltBase64>$<hashBase64>
// Generated PINs carry ~41 bits of entropy; a memory-hard KDF makes an
// exfiltrated-DB offline crack infeasible (the old raw SHA-256 hex was GPU-
// crackable in seconds). No legacy SHA-256 fallback: pre-scrypt hashes simply
// stop verifying, so existing clients re-pair once (issue a fresh password from
// the Jellyfin connection settings) — an accepted one-time cost.
const SCRYPT_PARAMS = { N: 65536, r: 8, p: 1 } as const;
const SCRYPT_MAXMEM = 128 * 1024 * 1024; // 128 MB headroom for N=65536,r=8
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(SCRYPT_SALT_BYTES);
    const derived = await scrypt(password, salt, SCRYPT_KEYLEN, {
        ...SCRYPT_PARAMS,
        maxmem: SCRYPT_MAXMEM,
    });
    const params = `N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}`;
    return `scrypt$${params}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

interface ParsedScrypt {
    N: number;
    r: number;
    p: number;
    salt: Buffer;
    hash: Buffer;
}

function parseScrypt(stored: string): ParsedScrypt | null {
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'scrypt') return null;
    const params: Record<string, number> = {};
    for (const kv of parts[1].split(',')) {
        const [k, v] = kv.split('=');
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        params[k] = n;
    }
    if (!params.N || !params.r || !params.p) return null;
    try {
        const salt = Buffer.from(parts[2], 'base64');
        const hash = Buffer.from(parts[3], 'base64');
        if (salt.length === 0 || hash.length === 0) return null;
        return { N: params.N, r: params.r, p: params.p, salt, hash };
    } catch {
        return null;
    }
}

/**
 * Constant-time verify of a plaintext password against a stored scrypt hash.
 * Never throws — a corrupt/malformed/legacy (non-scrypt) stored value returns
 * false rather than crashing auth.
 */
async function verifyStoredPassword(password: string, stored: string): Promise<boolean> {
    const parsed = parseScrypt(stored);
    if (!parsed) return false;
    let derived: Buffer;
    try {
        derived = await scrypt(password, parsed.salt, parsed.hash.length, {
            N: parsed.N,
            r: parsed.r,
            p: parsed.p,
            maxmem: SCRYPT_MAXMEM,
        });
    } catch {
        return false;
    }
    return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
}

// ── Reversible display copy ───────────────────────────────────────────────────
//
// `password_hash` (scrypt, above) stays the ONLY thing authentication consults.
// Alongside it we keep an AES-256-GCM sealed copy of the same PIN purely so the
// settings UI can show it again instead of forcing a reset — the PIN is always
// server-generated and never user-chosen, so it is not a credential the user
// reuses elsewhere, and the blast radius of the reversible copy is this app's
// /j surface only. Sealing (rather than plaintext) means a DB-only leak —
// backup dump, replica, SQL injection — does not by itself hand over working
// credentials; the attacker also needs the master key, which lives on the
// config volume rather than in Postgres.
//
// Every helper below fails SOFT: if the master key is unavailable or a stored
// envelope is corrupt, the password simply becomes non-revealable (the UI falls
// back to "reset to see it again"). It must never break password generation or
// login.

let cachedMasterKey: Buffer | null = null;

function masterKey(): Buffer {
    if (!cachedMasterKey) cachedMasterKey = deriveMasterKey(resolveMasterKey());
    return cachedMasterKey;
}

/**
 * Seal a generated PIN for later display. Returns null if sealing is impossible.
 *
 * Bound to the owning `user_id` (security review 2026-09-13, C19): without that
 * binding, `UPDATE jellyfin_client_passwords SET password_sealed = <someone
 * else's> WHERE user_id = <mine>` made the reveal endpoint print their PIN.
 */
function sealForDisplay(userId: string, password: string): string | null {
    try {
        return sealSecret(password, masterKey(), jellyfinClientPasswordContext(userId));
    } catch (err) {
        logger.warn('Could not seal client password for display; reveal will be unavailable', {
            error: String(err),
        });
        return null;
    }
}

/**
 * Re-seal every stored client password from `oldMasterKey` to `newMasterKey`
 * (security review 2026-09-12, C9) and point this module's cached key at the
 * new one.
 *
 * The SQL sweep itself is `rotateJellyfinClientPasswords()` in the AGPL tree:
 * the rotation handler (`admin/secrets-rotate.handler.ts`) is AGPL core and
 * `scripts/check-license-boundary.mjs` forbids it importing this tier in any
 * form, while `jellyfin_client_passwords` is core schema. This wrapper exists
 * so the store's OWN file still names its rotation entry point — keep it a pure
 * delegation so the two can never disagree.
 */
export async function rotateSealedClientPasswords(
    sql: Sql,
    oldMasterKey: Buffer,
    newMasterKey: Buffer,
): Promise<StoreRotationResult> {
    const result = await rotateJellyfinClientPasswords(sql, oldMasterKey, newMasterKey);
    if (result.rotated > 0 && result.skipped === 0) cachedMasterKey = newMasterKey;
    return result;
}

/** Open a sealed PIN. Returns null for NULL/legacy/corrupt/foreign-row values. */
function openForDisplay(userId: string, sealed: string | null): string | null {
    if (!sealed || !isSealed(sealed)) return null;
    try {
        return openSecret(sealed, masterKey(), jellyfinClientPasswordContext(userId));
    } catch (err) {
        // Most likely cause: the master key changed (rotated, or a replica that
        // does not share the config volume generated its own) — or the envelope
        // belongs to a DIFFERENT row and was transplanted into this one, which
        // the AAD binding rejects. Nothing is broken — clients still
        // authenticate — the PIN just can't be shown.
        logger.warn('Could not open sealed client password; reveal unavailable for this user', {
            error: String(err),
        });
        return null;
    }
}

function generatePassword(): string {
    let password = '';
    for (let i = 0; i < PASSWORD_LENGTH; i++) {
        // randomInt rejects out-of-range draws: `byte % 31` favoured the first 8 characters.
        password += PASSWORD_CHARS[randomInt(PASSWORD_CHARS.length)];
    }
    return password;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Format an 8-char password for display as "xxxx xxxx".
 */
export function formatPasswordForDisplay(password: string): string {
    return password.slice(0, 4) + ' ' + password.slice(4);
}

/**
 * Generate and persist a new client password for the given user.
 * Always issues a fresh password — an existing one is replaced, not returned
 * (use `revealPassword()` to read back a password that is already set).
 */
export async function getOrCreatePassword(userId: string): Promise<string> {
    const db = new Database();
    const sql = db.getSql();

    const existing = await getPasswordByUserId.one(sql, { userId });
    const password = generatePassword();
    const passwordHash = await hashPassword(password);
    await withUserCredentialLock(sql, userId, (tx) =>
        upsertPassword.execute(tx, {
            userId,
            passwordHash,
            passwordSealed: sealForDisplay(userId, password),
        }),
    );

    if (!existing) {
        logger.info(`Client password created for user ${userId}`);
    }

    return password;
}

/**
 * Reset the client password for a user, returning the new plaintext password.
 */
export async function resetPassword(userId: string): Promise<string> {
    const db = new Database();
    const sql = db.getSql();

    const password = generatePassword();
    const passwordHash = await hashPassword(password);
    await withUserCredentialLock(sql, userId, (tx) =>
        upsertPassword.execute(tx, {
            userId,
            passwordHash,
            passwordSealed: sealForDisplay(userId, password),
        }),
    );

    logger.info(`Client password reset for user ${userId}`);
    return password;
}

/**
 * Read back the user's current client password for display in settings.
 *
 * Returns null when there is no password at all, or when the stored row
 * predates the sealed-copy column (migration 16.170.0) / its envelope can no
 * longer be opened. Callers must treat null as "cannot be shown — offer a
 * reset" rather than "no password configured"; use `getPasswordByUserId` for
 * the latter distinction.
 */
export async function revealPassword(userId: string): Promise<string | null> {
    const db = new Database();
    const sql = db.getSql();

    const row = await getPasswordByUserId.one(sql, { userId });
    if (!row) return null;

    return openForDisplay(userId, row.password_sealed);
}

/**
 * Validate a username/password pair.
 * Returns a partial JellyfinSession (device fields left empty for caller to fill)
 * or null if credentials are invalid.
 */
export type PasswordUser = Pick<
    JellyfinSession,
    'userId' | 'username' | 'isAdmin' | 'groups' | 'displayName'
>;

interface PasswordSnapshot {
    userId: string;
    username: string;
    clientHash: string;
    nativeHash: string | null;
}
// Verification proofs stay server-local and never enter JSON or Valkey sessions.
const verifiedPasswords = new WeakMap<PasswordUser, PasswordSnapshot>();

export async function validatePassword(
    username: string,
    password: string,
): Promise<PasswordUser | null> {
    const db = new Database();
    const sql = db.getSql();

    const row = await getPasswordByUsername.one(sql, { username }).catch((error: unknown) => {
        if (isDependencyError(error)) throw new AuthDependencyUnavailableError(error);
        throw error;
    });

    // Constant-time work whether or not the user exists: always run the full
    // scrypt verify so timing does NOT distinguish "no such user" from "wrong
    // password" (timing side-channel defense, mirrors native-auth.service.ts).
    // The dummy hash is a well-formed scrypt$N=65536,r=8,p=1 value (matching
    // SCRYPT_PARAMS) so verifyStoredPassword does the same KDF work as a real
    // stored hash, yet can never match any real password.
    const DUMMY_HASH =
        'scrypt$N=65536,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
    // Defensive: schema marks password_hash NOT NULL, but a corrupt or
    // partially-migrated row would crash Buffer.from(null,'utf8'). Fail
    // closed instead of leaking a 500.
    const storedHash =
        row && typeof row.password_hash === 'string' && row.password_hash.length > 0
            ? row.password_hash
            : DUMMY_HASH;
    const ok = await verifyStoredPassword(password, storedHash);

    if (!row || !ok) return null;

    // Update last used timestamp — fire and forget
    updateLastUsed.execute(sql, { userId: row.user_id }).catch((err: unknown) => {
        logger.warn('Failed to update last_used_at for client password', {
            userId: row.user_id,
            error: String(err),
        });
    });

    const user: PasswordUser = {
        userId: row.user_id,
        username: row.username,
        isAdmin: row.is_admin,
        groups: row.groups ?? [],
        displayName: row.display_name ?? null,
    };
    verifiedPasswords.set(user, {
        userId: row.user_id,
        username: row.username,
        clientHash: storedHash,
        nativeHash: row.native_password_hash ?? null,
    });
    return user;
}

// =============================================================================
// Session management via Valkey
// =============================================================================

/**
 * Stable, non-secret handle for a session, used as the id in the settings UI
 * and in revoke requests. Derived from the session token so it needs no extra
 * storage, but one-way so the client-facing list never carries a value that
 * could be replayed as an AccessToken.
 */
function sessionHandle(token: string): string {
    return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

/** Record a freshly-minted session token in its owner's index. */
async function indexSessionForUser(userId: string, token: string): Promise<void> {
    const indexKey = SESSION_INDEX_PREFIX + userId;
    await sAdd(indexKey, token);
    // Refresh the index TTL on every add so it always outlives its newest
    // member; expired members are pruned lazily on read.
    await expire(indexKey, SESSION_TTL_SECONDS);
    await cacheSet(SESSION_INDEX_BUILT_PREFIX + userId, '1', SESSION_TTL_SECONDS);
}

/**
 * One-time backfill of a user's session index from a full `jfcompat:session:*`
 * SCAN. Only runs when the "built" marker is absent — i.e. for users whose
 * clients paired before the index existed, or after a Valkey flush. Without it
 * those sessions would be live but invisible in settings until they re-paired.
 */
async function ensureSessionIndex(userId: string): Promise<void> {
    if (await cacheExists(SESSION_INDEX_BUILT_PREFIX + userId)) return;

    const client = getCoordinationClient();
    if (!client) return;

    const tokens: string[] = [];
    let cursor = '0';
    try {
        do {
            const [nextCursor, scannedKeys] = await client.scan(cursor, {
                match: SESSION_KEY_PREFIX + '*',
                count: 200,
            });
            cursor =
                typeof nextCursor === 'string'
                    ? nextCursor
                    : Buffer.from(nextCursor).toString('utf-8');
            for (const rawKey of scannedKeys) {
                const key =
                    typeof rawKey === 'string' ? rawKey : Buffer.from(rawKey).toString('utf-8');
                const raw = await cacheGet(key);
                if (!raw) continue;
                try {
                    const session = JSON.parse(raw) as JellyfinSession;
                    if (session.userId === userId)
                        tokens.push(key.slice(SESSION_KEY_PREFIX.length));
                } catch {
                    // Corrupt payload — skip; the TTL will reap it.
                }
            }
        } while (cursor !== '0');
    } catch (err) {
        // Leave the marker unset so a later call retries the backfill rather
        // than permanently hiding pre-index sessions.
        logger.warn('jfcompat session index backfill failed; list may be incomplete', {
            userId,
            error: String(err),
        });
        return;
    }

    if (tokens.length > 0) {
        const indexKey = SESSION_INDEX_PREFIX + userId;
        await sAdd(indexKey, ...tokens);
        await expire(indexKey, SESSION_TTL_SECONDS);
    }
    await cacheSet(SESSION_INDEX_BUILT_PREFIX + userId, '1', SESSION_TTL_SECONDS);
}

/** A connected Jellyfin client, as shown in settings. Carries no secret. */
export interface JellyfinClientSessionView {
    /** Opaque handle — pass back to revokeSessionForUser() to sign this client out. */
    id: string;
    deviceId: string;
    deviceName: string;
    clientName: string;
    clientVersion: string;
    createdAt: string;
}

/**
 * List the Jellyfin-compat clients currently signed in as `userId`.
 *
 * Reads the per-user index and drops members whose session key has since
 * expired (Valkey cannot TTL individual set members), so the returned list is
 * exactly the set of live sessions.
 */
export async function listSessionsForUser(userId: string): Promise<JellyfinClientSessionView[]> {
    await ensureSessionIndex(userId);

    const indexKey = SESSION_INDEX_PREFIX + userId;
    const tokens = await sMembers(indexKey);
    if (tokens.length === 0) return [];

    const views: JellyfinClientSessionView[] = [];
    const stale: string[] = [];

    for (const token of tokens) {
        const raw = await cacheGet(SESSION_KEY_PREFIX + token);
        if (!raw) {
            stale.push(token);
            continue;
        }
        let session: JellyfinSession;
        try {
            session = JSON.parse(raw) as JellyfinSession;
        } catch {
            stale.push(token);
            continue;
        }
        // Defensive: an index entry pointing at another user's session would be
        // a cross-user leak. Drop rather than render it.
        if (session.userId !== userId) {
            stale.push(token);
            continue;
        }
        views.push({
            id: sessionHandle(token),
            deviceId: session.deviceId,
            deviceName: session.deviceName,
            clientName: session.clientName,
            clientVersion: session.clientVersion,
            createdAt: session.createdAt,
        });
    }

    if (stale.length > 0) await sRem(indexKey, ...stale);

    // Newest first — most recently paired client is the one a user is looking for.
    views.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return views;
}

/**
 * Revoke a single Jellyfin-compat client belonging to `userId`, addressed by
 * the opaque handle from listSessionsForUser(). Returns true if a session was
 * found and deleted.
 *
 * Scoping the lookup to the caller's own index is what makes the handle safe to
 * expose: a handle guessed or lifted from another account matches nothing here.
 */
export async function revokeSessionForUser(userId: string, id: string): Promise<boolean> {
    await ensureSessionIndex(userId);

    const indexKey = SESSION_INDEX_PREFIX + userId;
    const tokens = await sMembers(indexKey);
    const token = tokens.find((t) => sessionHandle(t) === id);
    if (!token) return false;

    // Re-read and re-check ownership before deleting: the index is a cache, and
    // acting on a stale entry must never delete another user's session.
    const raw = await cacheGet(SESSION_KEY_PREFIX + token);
    if (!raw) {
        await sRem(indexKey, token);
        return false;
    }
    try {
        if ((JSON.parse(raw) as JellyfinSession).userId !== userId) {
            await sRem(indexKey, token);
            return false;
        }
    } catch {
        // Corrupt payload in this user's own index — safe to clean up.
    }

    await revokeSession(token);
    logger.info('jfcompat session revoked by user', { userId });
    return true;
}

/**
 * Create a Valkey-backed session for an authenticated Jellyfin client.
 * Returns a 64-char hex session token, or `null` when the account is
 * disabled, soft-deleted, or unresolvable — the caller must fail closed
 * (401) and MUST NOT write any client-facing token in that case.
 *
 * SECURITY (review 2026-09-16, C5): this check lives HERE, inside the
 * shared mint primitive, rather than in either calling route. Before this
 * fix, `AuthenticateByName` was gated only because its OWN query
 * (`getPasswordByUsername`'s `AND u.disabled_at IS NULL` join) happened to
 * exclude a disabled user's row before `createSession` was ever reached —
 * `AuthenticateWithQuickConnect` has no such query (it reads an
 * already-authorized Quick Connect secret straight out of Valkey) and so
 * minted a fresh 30-day `/j` session for a disabled account with no DB
 * check at all. Placing the check in `createSession` itself means BOTH mint
 * paths inherit it and a third mint path added later cannot forget it —
 * this is the single seam every `/j` session is created through.
 *
 * Uses the SAME `resolveTokenUserAccess` resolver (and its L1 cache) that
 * gates every OTHER token→user resolution in this codebase (the `/j`
 * middleware re-check, `/j` PAT auth, the play-token and Live TV
 * producers), so a disable/delete that has already invalidated that cache
 * is picked up immediately here too, and a mint made shortly after
 * (within the cache's 10-minute TTL) reuses the same warm, correct verdict
 * rather than issuing a second DB round-trip.
 */
export async function createSession(
    session: JellyfinSession,
    verifiedPassword?: PasswordUser,
): Promise<string | null> {
    // Quick Connect has independent proof. Password callers must pass the exact
    // result of validatePassword so final issuance can fence its hash snapshot.
    if (verifiedPassword !== undefined) {
        const proof = verifiedPasswords.get(verifiedPassword);
        if (!proof || proof.userId !== session.userId || proof.username !== session.username)
            return null;
        const sql = new Database().getSql();
        return withUserCredentialLock(sql, proof.userId, async (tx) => {
            const current = await getPasswordByUsername.one(tx, { username: proof.username });
            if (
                !current ||
                current.user_id !== proof.userId ||
                current.password_hash !== proof.clientHash ||
                current.native_password_hash !== proof.nativeHash
            )
                return null;
            // Hold the shared lock through ALL Valkey writes; a reset that runs
            // next must see and revoke this token before it completes. The
            // query above checks account lifecycle on this transaction too.
            return persistSession(session);
        });
    }
    return mintSession(session);
}

async function mintSession(session: JellyfinSession): Promise<string | null> {
    const access = await resolveTokenUserAccess(session.username);
    if (!access || access.disabled || access.deleted) {
        logger.warn('jfcompat: session mint denied — account disabled, deleted, or unresolvable', {
            username: session.username,
            disabled: access?.disabled ?? null,
            deleted: access?.deleted ?? null,
        });
        return null;
    }

    if (session.approvedBySessionToken) {
        const parent = await validateSession(session.approvedBySessionToken);
        if (!parent || parent.userId !== session.userId || parent.origin === 'quick_connect')
            return null;
    }

    return persistSession(session);
}

async function persistSession(session: JellyfinSession): Promise<string | null> {
    const token = randomBytes(32).toString('hex');
    const key = SESSION_KEY_PREFIX + token;

    await cacheSet(key, JSON.stringify(session), SESSION_TTL_SECONDS);
    await indexSessionForUser(session.userId, token);

    // Close revoke-versus-mint: the child is indexed before this final check.
    // Either the parent is already gone and we remove it here, or the parent's
    // subsequent sweep sees it. Parent expiry after mint does not shorten the
    // child's own session lifetime.
    if (session.approvedBySessionToken) {
        const parent = await validateSession(session.approvedBySessionToken);
        if (!parent || parent.userId !== session.userId || parent.origin === 'quick_connect') {
            await cacheDel(key);
            await sRem(SESSION_INDEX_PREFIX + session.userId, token);
            return null;
        }
    }

    logger.info(`Session created for user ${session.username}`, {
        deviceName: session.deviceName,
        clientName: session.clientName,
    });

    return token;
}

/**
 * Look up a session by token.
 * Returns the session or null if expired / not found.
 *
 * Defense-in-depth: when `pathname` is supplied and does NOT start with `/j/`,
 * this function refuses to validate and logs an error. Jellyfin-compat sessions
 * exist solely to authenticate the /j/* compat layer; any caller that tries to
 * validate them outside that prefix is mis-wired and could silently widen the
 * scope of these tokens to the rest of the app. Failing closed (and logging)
 * surfaces the bug instead of leaking access.
 */
export async function validateSession(
    token: string,
    pathname?: string,
): Promise<JellyfinSession | null> {
    if (pathname !== undefined && !pathname.startsWith('/j/')) {
        logger.error(
            'jfcompat session validate refused outside /j/* path prefix',
            new Error('validateSession called outside /j/*'),
            { pathname },
        );
        return null;
    }
    const data = await cacheGetOrThrow(SESSION_KEY_PREFIX + token).catch((error: unknown) => {
        if (isDependencyError(error)) throw new AuthDependencyUnavailableError(error);
        throw error;
    });
    if (!data) return null;

    try {
        return JSON.parse(data) as JellyfinSession;
    } catch {
        return null;
    }
}

/**
 * Revoke a session by deleting its Valkey key.
 *
 * Reads the session first so the owning user's index can be pruned too. A
 * missed prune is harmless (listSessionsForUser drops members whose session key
 * is gone), so a failed read never blocks the delete.
 */
export async function revokeSession(token: string): Promise<void> {
    let userId: string | null = null;
    try {
        const raw = await cacheGet(SESSION_KEY_PREFIX + token);
        if (raw) userId = (JSON.parse(raw) as JellyfinSession).userId;
    } catch {
        // Corrupt or unreadable payload — fall through and delete anyway.
    }

    await cacheDel(SESSION_KEY_PREFIX + token);
    if (userId) {
        await ensureSessionIndex(userId);
        const indexKey = SESSION_INDEX_PREFIX + userId;
        await sRem(indexKey, token);
        // Delete the parent first. A concurrent mint checks it again after
        // indexing the child; an approved secret cannot recreate a revoked child.
        for (const childToken of await sMembers(indexKey)) {
            const raw = await cacheGet(SESSION_KEY_PREFIX + childToken);
            if (!raw) continue;
            let child: JellyfinSession;
            try {
                child = JSON.parse(raw) as JellyfinSession;
            } catch {
                continue;
            }
            if (child.userId === userId && child.approvedBySessionToken === token) {
                await cacheDel(SESSION_KEY_PREFIX + childToken);
                await sRem(indexKey, childToken);
            }
        }
    }
}

/**
 * SCAN every key under `prefix`, parse each value as JSON, and collect the
 * keys whose parsed value matches `userId` per `extractUserId`. Shared by
 * `revokeSessionsForUser`'s live-session sweep and its Quick Connect sweep
 * (security review 2026-09-16, C5) so the two keyspaces are scanned
 * identically — cursor-based, uncapped (unlike the shared `getKeysByPattern`
 * helper, which truncates at 1000 entries and would silently leave some
 * matches live on a high-density deployment), one corrupt/unparsable value
 * skipped rather than aborting the whole scan.
 */
async function scanKeysMatchingUserId(
    client: NonNullable<ReturnType<typeof getCoordinationClient>>,
    prefix: string,
    userId: string,
    extractUserId: (parsed: unknown) => string | null | undefined,
): Promise<Array<{ key: string; parsed: unknown }>> {
    const matched: Array<{ key: string; parsed: unknown }> = [];
    let cursor = '0';
    do {
        const [nextCursor, scannedKeys] = await client.scan(cursor, {
            match: prefix + '*',
            count: 200,
        });
        cursor =
            typeof nextCursor === 'string' ? nextCursor : Buffer.from(nextCursor).toString('utf-8');
        for (const rawKey of scannedKeys) {
            const key = typeof rawKey === 'string' ? rawKey : Buffer.from(rawKey).toString('utf-8');
            const raw = await cacheGet(key);
            if (!raw) continue;
            try {
                const parsed: unknown = JSON.parse(raw);
                if (extractUserId(parsed) === userId) matched.push({ key, parsed });
            } catch {
                // Corrupt payload — leave it; TTL will reap it.
            }
        }
    } while (cursor !== '0');
    return matched;
}

/**
 * Revoke ALL Jellyfin compat sessions belonging to a given user.
 * Scans `jfcompat:session:*`, deserializes each value, and deletes the keys
 * whose `userId` matches. Also sweeps `jfcompat:qc:secret:*` (security review
 * 2026-09-16, C5): a Quick Connect secret that has already been approved for
 * this user (its cached `QuickConnectData.userId` is set) but not yet
 * completed via `AuthenticateWithQuickConnect` is a pending mint for the
 * account being revoked, and — unlike the live session store — nothing else
 * in the disable fan-out could otherwise reach it before its own 5-minute
 * TTL. Returns the combined count of deleted sessions + pending QC secrets.
 *
 * A null coordination client THROWS rather than returning 0 (security review
 * 2026-09-16, C29): the caller (`revokeAllCredentialsForUser`) treats a
 * thrown store as failed and lands it in `failedStores`, so an admin/audit
 * record never reports `revoked: true` for a sweep that could not run at
 * all — the prior `return 0` looked identical to "this user had zero live
 * sessions," which is a lie during a coordination-Valkey outage.
 *
 * Used by:
 *   - DELETE /api/jellyfin-connect/password — invalidates client app tokens
 *     when the user removes their Jellyfin compat password.
 *   - Admin user demotion / soft-delete flows that need to immediately
 *     invalidate active client sessions (otherwise the 30-day Valkey TTL
 *     keeps them live).
 */
export async function revokeSessionsForUser(userId: string): Promise<number> {
    const client = getCoordinationClient();
    if (!client) {
        throw new Error('jfcompat: coordination Valkey client unavailable; cannot sweep sessions');
    }

    // Use cursor-based SCAN with no result-count cap. The shared
    // getKeysByPattern helper truncates at 1000 entries, which would silently
    // leave some user sessions live on a high-density deployment.
    const toDelete: string[] = [];
    try {
        const matches = await scanKeysMatchingUserId(
            client,
            SESSION_KEY_PREFIX,
            userId,
            (parsed) => (parsed as JellyfinSession)?.userId,
        );
        toDelete.push(...matches.map((m) => m.key));
    } catch (err) {
        logger.warn(
            'Failed to scan jfcompat sessions during revoke; some sessions may remain live',
            { userId, error: String(err) },
        );
        // Fall through — delete whatever we did collect, and still attempt
        // the QC sweep below (an independent keyspace/failure domain).
    }

    if (toDelete.length > 0) {
        await cacheDel(toDelete);
        logger.info(`Revoked ${toDelete.length} jfcompat session(s) for user`, {
            userId,
            count: toDelete.length,
        });
    }

    // Drop the per-user index wholesale. Deliberately unconditional (not gated
    // on toDelete.length): this path is also reached when the SCAN failed
    // partway, and a surviving index that still lists deleted tokens would
    // render revoked clients as connected. Clearing the "built" marker too
    // means the next list rebuilds from a fresh SCAN.
    await cacheDel([SESSION_INDEX_PREFIX + userId, SESSION_INDEX_BUILT_PREFIX + userId]);

    // Quick Connect pending-secret sweep (C5). An UNauthorized secret has
    // `userId: null` and can never match; only a secret already approved for
    // THIS user (someone tapped "authorize" but the client hasn't completed
    // yet) is swept here. Independent try/catch from the session scan above —
    // one keyspace's SCAN failure must not skip the other.
    let qcRevoked = 0;
    try {
        const qcMatches = await scanKeysMatchingUserId(
            client,
            QC_SECRET_PREFIX,
            userId,
            (parsed) => (parsed as QuickConnectData)?.userId,
        );
        if (qcMatches.length > 0) {
            const keysToDelete = qcMatches.flatMap(({ key, parsed }) => {
                const code = (parsed as QuickConnectData)?.code;
                return code ? [key, QC_CODE_PREFIX + code] : [key];
            });
            await cacheDel(keysToDelete);
            qcRevoked = qcMatches.length;
            logger.info(`Revoked ${qcRevoked} pending jfcompat Quick Connect secret(s) for user`, {
                userId,
                count: qcRevoked,
            });
        }
    } catch (err) {
        logger.warn(
            'Failed to scan jfcompat Quick Connect secrets during revoke; a pending secret may remain live',
            { userId, error: String(err) },
        );
    }

    return toDelete.length + qcRevoked;
}

// =============================================================================
// Admin / management helpers
// =============================================================================

/**
 * Delete the stored client password for a user (revokes Jellyfin compat access).
 * Also tears down any active Valkey sessions issued to that user — without
 * this, a stolen client app would keep its 30-day session token even after
 * the password is removed.
 */
export async function deletePasswordForUser(userId: string): Promise<void> {
    const db = new Database();
    const sql = db.getSql();
    await withUserCredentialLock(sql, userId, async (tx) => {
        await deletePassword.execute(tx, { userId });
        await revokeSessionsForUser(userId);
    });
    logger.info(`Client password deleted for user ${userId}`);
}

/**
 * Return all users that have a client password configured.
 */
export async function getUsersWithClientPasswords(): Promise<
    Array<{
        user_id: string;
        username: string;
        display_name: string | null;
        is_admin: boolean;
    }>
> {
    const db = new Database();
    const sql = db.getSql();
    return getUsersWithPasswords.all(sql, {});
}
