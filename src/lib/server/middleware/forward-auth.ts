// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import {
    applyLiveTvUserPolicy,
    isLiveTvRouteId,
    isSyntheticLiveTvIdentity,
} from '$lib/server/auth/livetv-user-policy.js';
/**
 * Forward Auth Middleware
 *
 * Extracted from hooks.server.ts — handles all authentication paths:
 * - /j/* routes: pass-through (self-authenticated via X-Emby-Authorization)
 * - /oauth/* routes: public (no auth required)
 * - /api/v1/* routes: the unified bearer-only token surface (PAT, service token,
 *   JWT, stream token, signed-URL/HMAC + query-token bypass sub-paths). Forward-
 *   auth headers are never trusted here (see handleApiV1Auth).
 * - All other routes: session cookie, then forward-auth headers (Authentik) when
 *   FORWARD_AUTH_ENABLED is on and the peer is in TRUSTED_PROXY_IPS
 *
 * Returns either a Response (early return for errors/passthrough) or sets
 * auth context on event.locals and returns undefined to continue.
 */

import {
    AuthDependencyUnavailableError,
    isDependencyError,
    authUnavailableResponse,
} from '$lib/server/auth/dependency-unavailable.js';

import { setRequestTimelineGrant } from '$lib/server/services/playback-timeline-hrefs.js';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { json } from '@sveltejs/kit';
import { config, features } from '$lib/server/config.js';
import { routedPathname } from '$lib/server/auth/routed-pathname.js';
import type { UserContext } from '$lib/server/types.js';
import { dev } from '$app/environment';
import { Logger } from '$lib/server/utils/logger.js';
import { parseList } from '$lib/server/utils/string-utils.js';
import { parseMediaId } from '$lib/server/utils/media-key-parser.js';
import { isAnonymousEntityImagePath } from '$lib/server/utils/entity-image-paths.js';
import {
    isAudiobookByteProxyPath,
    isRetiredAudiobookBytePath,
} from '$lib/server/utils/audiobook-stream-paths.js';
import { isPushRichSignedPath } from '$lib/server/utils/push-rich-paths.js';
import { syncUserGroups } from '$lib/server/services/user-groups.service.js';
import { getUserByUsername, upsertUser } from '$lib/server/database/queries/users.queries.js';
import { isReservedUsername } from '$lib/server/services/reserved-usernames.js';
import { ensureUserProfileExists } from '$lib/server/database/queries/user-ratings.queries.js';
import { sanitizeDisplayName } from '$lib/server/utils/display-name.js';
import { buildUserPermissions, isUserAdmin, hasGroupPermission } from '$lib/server/auth.js';
import { buildPrincipal } from '$lib/server/api/principal.js';
import { mapRequestedScopeToRaw } from '$lib/server/oauth/device-scope-map.js';
import {
    getCachedIsAdmin,
    setCachedIsAdmin,
    getCachedAdminPinned,
    setCachedAdminPinned,
    getCachedDisabled,
    setCachedDisabled,
    getCachedUserId,
    setCachedUserId,
} from '$lib/server/cache/user-admin-cache.js';
import { toUserId } from '$lib/shared/user-id.js';
import { resolveUserIdByUsername } from '$lib/server/auth/resolve-user-id.js';
import { resolveTokenUserAccess } from '$lib/server/auth/resolve-token-user-access.js';
import { computeOwnerIsAdminOverride } from '$lib/server/auth/resolve-owner-admin-status.js';
import {
    getCachedMaxAge,
    setCachedMaxAge,
    MAX_AGE_MISS,
} from '$lib/server/cache/user-max-age-cache.js';
import {
    validateBearerCredential,
    resolveTokenIdentity,
    resolveInAppAccess,
    v1ScopeMethodDenial,
    type TokenRequestCtx,
    type TokenDenial,
} from '$lib/server/auth/token-identity.js';
import {
    getClientIpStrict,
    isForwardAuthPeerTrusted,
    isConfiguredTrustedProxy,
    forwardAuthTrustPosture,
    isPrivateClientIp,
    hasForwardedClientIpHeader,
} from '$lib/server/utils/client-ip.js';
import {
    noteIgnoredForwardAuthHeaders,
    shouldLogUntrustedWhileDisabled,
} from '$lib/server/utils/forward-auth-disabled-observer.js';
import { getTcpPeer } from '$lib/server/utils/tcp-peer.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { problem } from '$lib/server/api/problem.js';
import { getSessionService } from '$lib/server/services/session.service.js';
import {
    buildUserContextFromSession,
    readSessionCookie,
    clearSessionCookie,
} from '$lib/server/auth/native-session.js';
import { adminExists } from '$lib/server/database/queries/users.queries.js';

// =============================================================================
// /api/v1/* FAILED-AUTH RATE LIMIT
// =============================================================================
// Mirrors the /j/* protection in src/lib/server/jellyfin-compat/middleware.ts.
// Same window (60 failures / 60 seconds per IP) so an attacker who walks the
// Bearer space cannot scale up by switching between PAT- and service-token-
// shaped tokens — a single counter covers both.
//
// IMPORTANT: only increment on a true 401 (invalid/expired/missing credential).
// Do NOT increment on 403/405 (valid credential, wrong path/method/scope) —
// those responses indicate the caller HAS a working token and an attacker
// can't trigger them without already having one, but a legitimate user with
// a misconfigured token could and we don't want them DoS'ing themselves.
const PUBAPI_FAILED_AUTH_LIMIT_PER_MINUTE = 60;
const PUBAPI_FAILED_AUTH_WINDOW_SECONDS = 60;

const authLogger = Logger.for('Auth');

// =============================================================================
// JWT STREAM WARNING RATE LIMITING
// =============================================================================
// Tracks last warning time per deviceSessionId to avoid log spam
// (a single stream can have hundreds of segment requests)
const jwtStreamWarningTimes = new Map<string, number>();
const JWT_STREAM_WARNING_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Cleanup old entries every 10 minutes to prevent memory leak
setInterval(
    () => {
        const now = Date.now();
        for (const [deviceId, lastWarned] of jwtStreamWarningTimes.entries()) {
            if (now - lastWarned > JWT_STREAM_WARNING_INTERVAL_MS * 2) {
                jwtStreamWarningTimes.delete(deviceId);
            }
        }
    },
    10 * 60 * 1000,
);

// =============================================================================
// USER GROUPS SYNC (Forward Auth → Database)
// =============================================================================
// Smart sync: throttled by a group-hash cache, only syncs if groups actually changed.
// `users.groups` is what every token-path reader (PAT, device token, Watch
// Together's participant subject) derives groups, admin and age cap from, so
// this write must happen on every install — with or without Valkey.
//
// Flow:
// 1. Check in-memory L1 cache (nanoseconds, per-worker)
// 2. Check Valkey L2 cache (milliseconds, cross-worker) — only when Valkey is ready
// 3. If hash matches → skip (groups unchanged)
// 4. If hash differs or miss → sync to DB, update caches
//
// Performance: Most requests hit L1 cache. The TTL (5 min) controls sync frequency.
// If groups change mid-session, the hash mismatch triggers immediate sync.
//
// Without Valkey (not configured, or down) L1 is the only throttle: each
// replica/worker writes at most once per TTL per user while the groups are
// unchanged, and at once when they change. The write is idempotent (the same
// header list lands on every replica), so the only multi-replica cost is one
// extra UPDATE per replica per TTL. The admin/max-age cache invalidation that
// `syncUserGroups` does is local-only without Valkey, so sibling replicas'
// caches still age out on their own TTL, as for every other writer.
//
// Valkey returning after an outage: an L2 hash written BEFORE the outage can
// still match while `users.groups` holds a list some replica wrote DURING it
// (groups changed and changed back inside one TTL). That lag is bounded by
// twice GROUP_SYNC_TTL_SECONDS (L2 expiry, then the L1 entry it refreshed).

const GROUP_SYNC_TTL_SECONDS = 300; // 5 minutes

// Upper bound on L1 entries. Without Valkey this map is the only throttle, so
// it must not grow without limit between sweeps. Evicting an entry only costs
// one extra idempotent write for that user.
const GROUP_SYNC_L1_MAX_ENTRIES = 10_000;

// L1 in-memory cache: username -> { hash, expiresAt }
// Per-worker, provides fast-path for repeated requests from same user
const groupSyncL1Cache = new Map<string, { hash: string; expiresAt: number }>();

function setGroupSyncL1(userKey: string, hash: string, expiresAt: number): void {
    // Re-insert so Map order is least-recently-written first.
    groupSyncL1Cache.delete(userKey);
    if (groupSyncL1Cache.size >= GROUP_SYNC_L1_MAX_ENTRIES) {
        const oldest = groupSyncL1Cache.keys().next().value;
        if (oldest !== undefined) groupSyncL1Cache.delete(oldest);
    }
    groupSyncL1Cache.set(userKey, { hash, expiresAt });
}

// Pre-compiled regex for static file detection (avoid recompiling on every request)
const STATIC_FILE_REGEX =
    /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|webp|json|webmanifest|map)$/;

// Cleanup L1 cache periodically (every 10 minutes)
setInterval(
    () => {
        const now = Date.now();
        for (const [key, value] of groupSyncL1Cache.entries()) {
            if (now > value.expiresAt) {
                groupSyncL1Cache.delete(key);
            }
        }
    },
    10 * 60 * 1000,
);

// Order-independent hash for group comparison
// Uses JSON.stringify to handle groups containing special characters (|, etc.)
function hashGroups(groups: string[]): string {
    return JSON.stringify([...groups].map((g) => g.toLowerCase()).sort());
}

async function syncUserGroupsIfNeeded(username: string, groups: string[]): Promise<void> {
    const groupHash = hashGroups(groups);
    const now = Date.now();
    // CRITICAL: Always use lowercase for both cache keys AND database storage
    // This prevents duplicate rows when users log in with different case (e.g., "Testuser" vs "testuser")
    const userKey = username.toLowerCase();

    // L1: In-memory cache (fastest, per-worker)
    const l1Cached = groupSyncL1Cache.get(userKey);
    if (l1Cached && l1Cached.hash === groupHash && now < l1Cached.expiresAt) {
        return; // Same groups and not expired - skip
    }

    try {
        // L2: Valkey cache (cross-worker, survives restarts). Optional: when
        // Valkey is not ready, fall through to the DB write with L1 as the only
        // throttle. Returning here instead (as this used to) meant a Valkey-less
        // install never synced `users.groups` from the IdP at all.
        const { isValkeyReady, cacheGet, setEx } = await import('$lib/server/cache/valkey.js');
        const useL2 = isValkeyReady();
        const cacheKey = `user:groups:hash:${userKey}`;

        if (useL2 && (await cacheGet(cacheKey)) === groupHash) {
            // Groups unchanged - update L1 cache and skip DB
            setGroupSyncL1(userKey, groupHash, now + GROUP_SYNC_TTL_SECONDS * 1000);
            return;
        }

        // Groups changed or not in cache - sync to database
        const { aiDbService } = await import('$lib/server/services/database.service.js');
        const sql = await aiDbService.getSql();
        if (!sql) return;

        // Store with lowercase username to ensure case-insensitive uniqueness,
        // and invalidate the admin/max-age caches this write feeds (security
        // review 5, C4 + Shape C) so a reader on this or a sibling replica
        // does not serve a stale groups/admin/age value for up to 10 minutes.
        await syncUserGroups(sql, userKey, groups);
        // Throttle as soon as the groups row is written: a request arriving while
        // the ledger write below is still running must not rewrite the row.
        setGroupSyncL1(userKey, groupHash, now + GROUP_SYNC_TTL_SECONDS * 1000);

        // Record the forward-auth identity in the federation ledger (best-effort,
        // additive). This only runs on the throttled sync-write path (not every
        // request), so the extra id lookup is negligible.
        try {
            const { getUserByUsername } =
                await import('$lib/server/database/queries/users.queries.js');
            const { recordIdentityBestEffort, PROVIDER_FORWARD_AUTH } =
                await import('$lib/server/services/user-identity.service.js');
            const u = await getUserByUsername(sql, userKey);
            if (u) {
                await recordIdentityBestEffort(sql, {
                    provider: PROVIDER_FORWARD_AUTH,
                    subject: userKey,
                    userId: u.id,
                });
            }
        } catch {
            /* ledger is best-effort; never affect auth */
        }

        // Fire-and-forget the Valkey write - don't await
        if (useL2) void setEx(cacheKey, GROUP_SYNC_TTL_SECONDS, groupHash);

        authLogger.debug('Synced user groups to database', {
            username,
            groupCount: groups.length,
        });
    } catch (error) {
        // Best-effort, don't break auth flow
        authLogger.debug('Failed to sync user groups (non-critical)', {
            username,
            error: (error as Error).message,
        });
    }
}

/**
 * Resolve is_admin from DB with L1 cache (user-admin-cache.ts).
 *
 * Uses the "OIDC-authoritative with pin override" pattern:
 * - If admin_pinned: use DB is_admin (manual override, IdP groups ignored)
 * - If not pinned: use IdP groups value (passed as `oidcIsAdmin`)
 * - Falls back to oidcIsAdmin if DB unavailable or user not found yet
 *
 * The cache is invalidated when an admin toggles/unpins via
 * PATCH /api/admin/users/[username].
 */
/**
 * Resolve both isAdmin and maxAgeRating in a single SELECT when both
 * are cold. Saves a round-trip on the user's first request after deploy
 * vs running two separate getUserByUsername / SELECT max_age queries
 * sequentially.
 *
 * Returns the OIDC-derived fallbacks if the DB is unavailable or the
 * user row doesn't exist yet (first-ever request — populated by the
 * fire-and-forget upsertUser path elsewhere).
 */
// resolveInAppAccess() moved to `$lib/server/auth/token-identity.ts` (fix-plan-5
// Task 3) — shared with that module's service-token impersonation branch. Still
// used below by the native-session and SSO paths, imported at the top of this file.

/**
 * Most-restrictive (MIN) merge of two age ceilings. null = unrestricted (most
 * permissive), so a null on either side never lowers the other side's restriction.
 */
function mergeMaxAge(a: number | null, b: number | null): number | null {
    if (a === null) return b;
    if (b === null) return a;
    return Math.min(a, b);
}

/**
 * `adminPinned` (security review 2026-09-23, C6, SSO policy Option A): the
 * caller no longer treats `isAdmin` above as the final admin verdict — it
 * feeds it through `computeOwnerIsAdminOverride(isAdmin, adminPinned)` so an
 * UNPINNED account's in-app `admin` capability can still win the OR, exactly
 * as `resolve-token-user-access.ts` and the service-token impersonation
 * branch already do. The three fallbacks do NOT all mean the same thing:
 * - **no sql / no row**: `adminPinned: false` — there genuinely is no pin to
 *   defer to (no row exists, or the row is provably absent), so the verdict
 *   is correctly left to header groups plus the in-app layer.
 * - **DB error (catch)**: `adminPinned: true` — a deliberate misuse of the
 *   field to force a DEFINED override. The pin state here is UNKNOWN (the
 *   row could not be read), so it might be a pinned-demoted admin; treating
 *   that as "no pin" would let the in-app term elevate during the very
 *   outage window the pin can't be verified in. Fix round 1 (fix-plan-5
 *   task-1 review) corrected this from `false` after review caught the
 *   under-the-pin elevation.
 */
async function resolveDbAuth(
    username: string,
    oidcIsAdmin: boolean,
    oidcMaxAge: number | null,
): Promise<{
    isAdmin: boolean;
    adminPinned: boolean;
    maxAge: number | null;
    disabled: boolean;
    userId: string | null;
}> {
    const cachedAdmin = getCachedIsAdmin(username);
    const cachedAdminPinned = getCachedAdminPinned(username);
    const cachedMax = getCachedMaxAge(username);
    const cachedDisabled = getCachedDisabled(username);
    const cachedUserId = getCachedUserId(username);
    // All five warm — no DB work at all. (userId must be cached too so the
    // warm path can attach UserContext.userId without a round-trip.)
    if (
        cachedAdmin !== null &&
        cachedAdminPinned !== null &&
        cachedMax !== MAX_AGE_MISS &&
        cachedDisabled !== null &&
        cachedUserId !== null
    ) {
        return {
            isAdmin: cachedAdmin,
            adminPinned: cachedAdminPinned,
            maxAge: cachedMax,
            disabled: cachedDisabled,
            userId: cachedUserId,
        };
    }
    try {
        const { aiDbService } = await import('$lib/server/services/database.service.js');
        const sql = await aiDbService.getSql();
        if (!sql)
            return {
                isAdmin: cachedAdmin ?? oidcIsAdmin,
                adminPinned: cachedAdminPinned ?? false,
                maxAge: cachedMax === MAX_AGE_MISS ? oidcMaxAge : cachedMax,
                disabled: cachedDisabled ?? false,
                userId: cachedUserId,
            };

        const dbUser = await getUserByUsername(sql, username);
        if (!dbUser) {
            // No row yet (first request — fire-and-forget upsert hasn't
            // landed). Cache the OIDC-derived fallbacks so subsequent
            // requests within the TTL skip the round-trip too. A non-existent
            // row can't be disabled or pinned. userId stays unresolved
            // (null) — the caller provisions synchronously when an admin
            // already exists.
            setCachedIsAdmin(username, oidcIsAdmin);
            setCachedAdminPinned(username, false);
            setCachedMaxAge(username, oidcMaxAge);
            setCachedDisabled(username, false);
            return {
                isAdmin: oidcIsAdmin,
                adminPinned: false,
                maxAge: oidcMaxAge,
                disabled: false,
                userId: null,
            };
        }
        const adminPinned = dbUser.admin_pinned === true;
        const isAdmin = adminPinned ? dbUser.is_admin : oidcIsAdmin;
        const maxAge = dbUser.age_rating_pinned ? dbUser.max_age_rating : oidcMaxAge;
        const disabled = dbUser.disabled_at !== null;
        setCachedIsAdmin(username, isAdmin);
        setCachedAdminPinned(username, adminPinned);
        setCachedMaxAge(username, maxAge);
        setCachedDisabled(username, disabled);
        setCachedUserId(username, dbUser.id);
        return { isAdmin, adminPinned, maxAge, disabled, userId: dbUser.id };
    } catch (e) {
        if (cachedDisabled === null || isDependencyError(e))
            throw new AuthDependencyUnavailableError(e);
        authLogger.warn('Failed to resolve user auth from DB, using fallback', {
            username,
            error: e,
        });
        // FIX ROUND 1 (fix-plan-5 task-1 review, controller ruling): unlike the
        // no-sql and no-row branches above, the pin state here is genuinely
        // UNKNOWN — the row could not be read at all, so it might be a
        // pinned-demoted admin (admin_pinned:true, is_admin:false). Returning
        // `adminPinned: false` would make computeOwnerIsAdminOverride() yield
        // `undefined`, letting the in-app `admin` capability's OR-term grant
        // admin during exactly the outage window where the pin can't be
        // verified — an elevation, not a denial. `adminPinned: true` here is
        // a deliberate misuse of the field's literal meaning: it forces
        // computeOwnerIsAdminOverride(oidcIsAdmin, true) to return the
        // DEFINED `oidcIsAdmin`, so the override is authoritative and the
        // in-app term cannot add admin — matching this function's pre-C6
        // behaviour on error (header groups decide, in-app cannot elevate).
        // A header-admin still gets admin here; only the in-app-only case is
        // denied. See resolve-owner-admin-status.ts's resolveOwnerAdminStatus
        // for the analogous fail-closed choice on the admin axis.
        return {
            isAdmin: cachedAdmin ?? oidcIsAdmin,
            adminPinned: cachedAdminPinned ?? true,
            maxAge: cachedMax === MAX_AGE_MISS ? oidcMaxAge : cachedMax,
            disabled: cachedDisabled ?? false,
            userId: cachedUserId,
        };
    }
}

/**
 * Narrow/restore admin-scoped PAT + service-token access in lockstep with an
 * IdP-group-driven admin transition (security review 2026-09-16, fix round 1
 * review, Important 3). `upsertUser()`'s `ON CONFLICT` CASE can demote OR
 * promote any UNPINNED user purely from their CURRENT `ADMIN_GROUPS`
 * membership — on an Authentik forward-auth deployment this is the PRIMARY
 * demotion path (dropping someone from the admin group takes effect on their
 * very next login), not a secondary one. A C4 fix that only narrowed the two
 * explicit admin-API write sites (`defs/users/[id].ts`, `defs/admin/users/
 * [username]/index.ts`) left this path completely unnarrowed.
 *
 * Shared by BOTH `upsertUser()` call sites below (`resolveOrProvisionUserId`'s
 * synchronous cold-start provisioning, and the fire-and-forget periodic
 * group-sync) so the demote/promote branching exists in exactly one place —
 * a hand-duplicated copy at each call site is exactly the kind of duplicated
 * security decision this fix round is meant to collapse, not add a second
 * copy of. Best-effort: never throws, only warns — an admin-credential-sync
 * failure must not turn into an auth failure for an ordinary page view.
 *
 * NOT the `resolveOwnerAdminStatus()`-before/after pattern used by
 * `admin-user.service.ts`/`oidc.service.ts` (fix round 2, X3): those run a
 * SINGLE sequential write with no concurrent writer of the same row's
 * `groups` column. Here, `groups` is written by a genuinely CONCURRENT,
 * independently-debounced fire-and-forget call (`syncUserGroupsIfNeeded()`,
 * with its own L1/L2 cache and hash-compare skip logic this function must
 * not disturb) racing against `upsertUser()`'s own fire-and-forget IIFE —
 * fix round 2 briefly tried the before/after pattern here too and it was
 * RIGHT with 80% probability and WRONG the rest: whichever of the two
 * concurrent writers' DB round trips happened to land first decided whether
 * the "before" read saw the OLD or the NEW `groups`, intermittently
 * swallowing a real demotion with no error (both "before" and "after" would
 * read the ALREADY-new groups, so the transition helper saw no change).
 * `upsertUser()`'s own `WITH before AS (...)` CTE reads the COLUMN
 * pre-statement atomically WITHIN its own single statement — no separate
 * round trip, so no race — which is why the column-flag half of this
 * function is safe to keep.
 */
/**
 * Pure X3/MINOR-4-fix core: given `upsertUser()`'s column-only `{isAdmin,
 * demoted,promoted}` result and the target's CURRENT in-app admin status
 * (unaffected by this upsert — it lives in separate tables no writer here
 * touches, so it is the SAME value before and after), compute the Formula-A
 * before/after pair `applyAdminStatusTransition()` should be called with.
 *
 * Exported (and kept side-effect-free) so this decision is unit-testable
 * without mocking the DB round trip `resolveInAppAccess()` needs.
 * `syncAdminCredentialsAfterUpsert()` below is the thin I/O wrapper.
 *
 * `upserted.demoted`/`.promoted` are mutually exclusive and both `false` for
 * an unchanged column; recover the PRE-write column value from them (neither
 * set => unchanged => equals the post-write value).
 *
 * FIX (fix round 2, MINOR 4): `inAppIsAdminNow` must be TRUE via EITHER the
 * `admin` CAPABILITY on an in-app group OR an in-app group whose NAME
 * matches `config.ADMIN_GROUPS` (`hasGroupPermission()`, the same
 * name-match `buildUserPermissions()` uses) — checking the capability alone
 * missed the name-conferred path entirely.
 */
export function computeIdpSyncAdminTransition(
    upserted: { isAdmin: boolean; demoted: boolean; promoted: boolean },
    inAppIsAdminNow: boolean,
): { wasAdmin: boolean; isAdminNow: boolean } {
    const nowColumnAdmin = upserted.isAdmin;
    const wasColumnAdmin = upserted.demoted ? true : upserted.promoted ? false : nowColumnAdmin;
    return {
        wasAdmin: wasColumnAdmin || inAppIsAdminNow,
        isAdminNow: nowColumnAdmin || inAppIsAdminNow,
    };
}

async function syncAdminCredentialsAfterUpsert(
    sql: postgres.Sql,
    upserted:
        | { id: string; isAdmin: boolean; demoted: boolean; promoted: boolean; created?: boolean }
        | undefined,
    username: string,
): Promise<void> {
    // Defensive: a test double or a future caller that doesn't (yet) mirror
    // upsertUser()'s real return shape must not turn a fire-and-forget call
    // into an unhandled rejection.
    if (!upserted) return;
    await followSetupLockAfterIdpTransition(sql, upserted, username);
    if (!upserted.demoted && !upserted.promoted) return;
    try {
        // X3 FIX (security review 2026-09-23, final fix wave): `upserted.
        // {demoted,promoted}` only tracks the `users.is_admin` COLUMN
        // transition — this write never touches the in-app layer, so a
        // dual-membership admin (IdP admin group AND in-app admin) who
        // merely dropped the IdP group used to be narrowed here even though
        // Formula A still said admin, with nothing to ever restore them. See
        // `computeIdpSyncAdminTransition()`'s doc comment (also MINOR 4).
        const { effectiveGroups, extraCapabilities } = await resolveInAppAccess(upserted.id, []);
        const inAppIsAdminNow =
            extraCapabilities.ownerIsAdmin === true ||
            hasGroupPermission(effectiveGroups, config.ADMIN_GROUPS);
        const { wasAdmin, isAdminNow } = computeIdpSyncAdminTransition(upserted, inAppIsAdminNow);

        const { applyAdminStatusTransition } =
            await import('$lib/server/services/credential-revocation.service.js');
        const { failedStores } = await applyAdminStatusTransition(
            sql,
            upserted.id,
            username,
            wasAdmin,
            isAdminNow,
        );
        if (failedStores.length > 0) {
            authLogger.warn(
                'Admin-scoped credential sync after IdP admin transition: some stores failed',
                {
                    username,
                    failedStores,
                },
            );
        }
    } catch (e) {
        authLogger.warn(
            'Failed to sync admin-scoped credential narrowing after IdP admin transition',
            {
                username,
                demoted: upserted.demoted,
                promoted: upserted.promoted,
                error: e,
            },
        );
    }
}

/**
 * Setup-lock side of an IdP admin transition (security review 6, ruling
 * S-C5c-2). Runs only on a column transition or a new row, never on an
 * ordinary request.
 *
 * Demotion: warn when no effective admin is left (`warnIfLastAdminDemoted`).
 *
 * Promotion, or a new row created as admin: write the setup lock if it is
 * missing. That happens only for an admin gained while setup was open after a
 * `SETUP_UNLOCK`, in a worker that had cached "an admin exists" before the
 * unlock (so forward-auth provisioned and synced as if set up).
 */
async function followSetupLockAfterIdpTransition(
    sql: postgres.Sql,
    upserted: {
        id: string;
        isAdmin: boolean;
        demoted: boolean;
        promoted: boolean;
        created?: boolean;
    },
    username: string,
): Promise<void> {
    const gainedAdmin = upserted.promoted || (upserted.created === true && upserted.isAdmin);
    if (!upserted.demoted && !gainedAdmin) return;
    try {
        const { warnIfLastAdminDemoted, ensureSetupLocked } =
            await import('$lib/server/services/setup-lock.service.js');
        if (upserted.demoted) {
            await warnIfLastAdminDemoted(sql, {
                username,
                source: 'forward-auth',
                adminGroupNames: config.ADMIN_GROUPS,
            });
        } else {
            await ensureSetupLocked(sql, upserted.id);
        }
    } catch (e) {
        authLogger.warn('Setup-lock check after an IdP admin transition failed', {
            username,
            error: e,
        });
    }
}

/**
 * Resolve the stable users.id for a forward-auth username, provisioning the row
 * synchronously if it doesn't exist yet (the cold-start window before the
 * fire-and-forget upsert lands). Respects the first-run guard: never provisions
 * while setup is not complete — no `setup_lock` row and no counted admin
 * (`anAdminExists` → the setup gate in `users.queries.ts`); the first admin
 * comes from the /setup wizard. Once the lock row exists this keeps
 * provisioning even if every admin has since been demoted: a locked install is
 * set up, admin or not. Returns null only when no identity can be established
 * (setup incomplete, or DB unavailable) — the caller then fails closed rather
 * than build an identity-less UserContext.
 */
async function resolveOrProvisionUserId(
    username: string,
    isAdmin: boolean,
    maxAgeRating: number | null,
    displayName: string | null,
): Promise<string | null> {
    const cached = getCachedUserId(username);
    if (cached) return cached;
    if (isReservedUsername(username)) {
        // A name reserved for an internal actor (e.g. `system`) must never be
        // provisioned from a trusted-but-external header — a real account of
        // that name could collide with a sentinel a security check treats
        // specially (watch-together's endSession used to trust a literal
        // userId === 'system'). Fail closed rather than provision; this only
        // blocks a brand-NEW row — an account already provisioned under this
        // name before this guard existed is unaffected (resolveDbAuth already
        // resolves it by the time this function would be reached).
        authLogger.warn('Forward-auth: refusing to provision a reserved username', {
            username,
        });
        return null;
    }
    try {
        const { aiDbService } = await import('$lib/server/services/database.service.js');
        const sql = await aiDbService.getSql();
        if (!sql) return null;
        // First-run guard: do not auto-provision before an admin exists.
        if (!(await anAdminExists())) return null;
        const upserted = await upsertUser(sql, { username, isAdmin, maxAgeRating, displayName });
        // Fire-and-forget: an admin-credential-sync hiccup must not delay
        // resolving the caller's own userId (see syncAdminCredentialsAfterUpsert).
        void syncAdminCredentialsAfterUpsert(sql, upserted, username);
        const row = await getUserByUsername(sql, username);
        if (!row) return null;
        // user_profiles.user_id is the users.id UUID since mig 16.46.0.
        await ensureUserProfileExists(sql, toUserId(row.id));
        setCachedUserId(username, row.id);
        return row.id;
    } catch (e) {
        authLogger.warn('Failed to resolve/provision userId for forward-auth user', {
            username,
            error: e,
        });
        return null;
    }
}

// =============================================================================
// PUBLIC API AUTH: Playback grants
// =============================================================================

const GRANT_FAILURE_TEXT: Record<string, string> = {
    expired: 'Playback grant has expired; renew it or start a new playback session',
    revoked: 'Playback grant was revoked',
    session_ended:
        'The playback session of this grant has ended (completed, stopped or replaced); start a new one',
    invalid: 'Playback grant is invalid',
};

/**
 * One problem+json per grant failure. `reason` is the machine detail (also in
 * X-Playback-Grant-Reason): an IP-pinned grant used from another address is a
 * 403 `ip_mismatch` (start with castTarget), a grant on a non-delivery URL a 403
 * `forbidden`, a server-restart orphan a recoverable 410, and every other
 * failure a 401 `invalid_grant`.
 */
function playbackGrantFailure(reason: string, error?: string): Response {
    const headers = { 'X-Playback-Grant-Reason': reason };
    if (reason === 'session_restarted')
        return problem('gone', {
            error: 'Playback session expired after a server restart; start a new one',
            reason,
            headers: {
                ...headers,
                'X-Lumastra-Diagnostic-Code': 'session-expired',
                'X-Lumastra-Session-Terminal': 'false',
            },
        });
    if (reason === 'ip_mismatch') return problem('ip_mismatch', { reason, headers });
    if (reason === 'wrong_scope')
        return problem('forbidden', {
            error: 'A playback grant is only valid on the media delivery URLs of its session',
            reason,
            headers,
        });
    return problem('invalid_grant', {
        error: error ?? GRANT_FAILURE_TEXT[reason] ?? GRANT_FAILURE_TEXT.invalid,
        reason,
        headers,
    });
}

async function handleStreamToken(
    event: RequestEvent,
    path: string,
    streamTokenParam: string,
): Promise<Response | undefined> {
    let grantId: string | undefined;
    try {
        // Get client IP for the stream-token IP-pinning check below (security
        // review P2). STRICT, not the implicit-trust getClientIp: when
        // TRUSTED_PROXY_IPS is unset, getClientIp still honors a
        // client-supplied X-Forwarded-For (implicit trust exists so per-client
        // features don't collapse to the single proxy IP — see client-ip.ts),
        // which would let an attacker spoof ANY XFF value and have it accepted
        // as "their" IP by sessionService.validate()'s binding check below —
        // the binding wouldn't just be weak, the attacker would be choosing
        // the value it's compared against. getClientIpStrict falls back to the
        // raw TCP peer in that case, so mint/refresh/validate must all agree
        // on the strict value or a legitimate client would mint under one IP
        // and fail validation under another.
        const clientIp = getClientIpStrict(event);

        const { resolvePlaybackGrantRoute, validatePlaybackGrant } =
            await import('$lib/server/services/playback-grant.js');
        const routedUrl = new URL(event.url);
        routedUrl.pathname = path;
        const route = await resolvePlaybackGrantRoute(routedUrl);
        if (!route || !(route.methods ?? ['GET', 'HEAD']).includes(event.request.method)) {
            authLogger.warn('Playback grant rejected', { path, grantId, reason: 'wrong_scope' });
            return playbackGrantFailure('wrong_scope');
        }
        const session = await validatePlaybackGrant(streamTokenParam, { clientIp, route });
        if (!session || 'reason' in session) {
            const reason = session?.reason ?? 'invalid';
            grantId = session?.grantId;
            authLogger.warn('Playback grant rejected', { path, grantId: session?.grantId, reason });
            if (route.kind === 'live' && reason === 'revoked') return problem('not_found');
            return playbackGrantFailure(reason);
        }

        grantId = session.id;

        // Build user context from validated session.
        // session.userId is the JELLYFIN user id (used for /j compat), NOT the
        // stable users.id. Resolve the real users.id from the session's username
        // for the user-data key; fail closed if it can't be resolved.
        const streamUserId = await resolveUserIdByUsername(session.username);
        if (!streamUserId) {
            authLogger.warn('Stream token rejected: no resolvable users.id for session user', {
                path,
                username: session.username,
                grantId,
            });
            return playbackGrantFailure('revoked', 'Account not provisioned');
        }
        // userGroups / maxAgeRating / isAgeRestricted / isAdmin are resolved
        // LIVE from the DB on every call via resolveTokenUserAccess (the same
        // derivation the forward-auth cookie session path uses), not
        // hardcoded. This token is minted for the MUSIC surface (wildcard or
        // per-item) and used on every HLS segment/track request, so it must
        // keep reflecting the account's current groups/age cap for as long as
        // the session is renewed by heartbeats — previously it carried a
        // permanent isAgeRestricted:false/userGroups:[], which meant the age
        // gate in media-access.ts never ran, and the empty group list masked
        // that by fail-closing the library axis first (security review C4).
        //
        // Item/session-scoped VOD grants keep their playback capabilities.
        // Live grants additionally require the owner's current group permission.
        const streamAccess = await resolveTokenUserAccess(session.username, {
            freshGroups: route.kind === 'live',
        });
        if (!streamAccess || streamAccess.disabled || streamAccess.deleted) {
            // SECURITY (review 2026-09-16, task 6 fix round 1, Important 2):
            // `.deleted` (users.deleted_at) added alongside the pre-existing
            // `.disabled` check — resolveTokenUserAccess() has resolved both
            // through the same seam since this round's earlier commit, but
            // this producer (the music/HLS stream-token path) only tested
            // `.disabled`, leaving a soft-deleted account's stream token
            // valid for as long as it kept being renewed by heartbeats.
            authLogger.warn('Stream token rejected: account not resolvable, disabled, or deleted', {
                path,
                username: session.username,
                grantId,
            });
            return playbackGrantFailure(
                'revoked',
                streamAccess?.disabled || streamAccess?.deleted
                    ? 'Account disabled'
                    : 'Account not provisioned',
            );
        }
        // Media admin capability is what the MINTING principal had (stored on
        // the row), and only while the owner is still an admin. Tokens minted
        // by a scoped credential, or before 16.301.0, stay non-admin.
        const mediaAccessIsAdmin = streamTokenMediaAdmin(
            session,
            streamAccess.permissions.ownerIsAdmin,
        );
        const streamMaxAge = mediaAccessIsAdmin
            ? streamAccess.permissions.maxAgeRating
            : (streamAccess.nonAdminMaxAgeRating ?? streamAccess.permissions.maxAgeRating);
        const userContext: UserContext = {
            userId: streamUserId,
            username: session.username,
            groups: streamAccess.userGroups.join('|'),
            userGroups: streamAccess.userGroups,
            hasWatchPermission: true, // Stream tokens are only for playback
            hasLiveTvPermission:
                route.kind === 'live' ? streamAccess.permissions.hasLiveTvPermission : true,
            hasRequestPermission: true,
            ownerIsAdmin: streamAccess.permissions.ownerIsAdmin,
            mediaAccessIsAdmin,
            maxAgeRating: streamMaxAge,
            isAgeRestricted: streamMaxAge !== null,
            isModerator: streamAccess.permissions.isModerator,
            // Admin-ness gave an admin owner 'high'; a token minted by a narrowed credential
            // (mediaAccessIsAdmin false) must not keep that and evict other viewers.
            liveTvPriority:
                streamAccess.permissions.ownerIsAdmin && !mediaAccessIsAdmin
                    ? 'low'
                    : streamAccess.permissions.liveTvPriority,
        };

        event.locals.user = userContext;
        event.locals.jellyfinUserId = session.userId;
        event.locals.deviceSessionId = session.deviceSessionId || undefined;
        event.locals.liveTvCredentialId = session.deviceSessionId
            ? `device:${session.deviceSessionId}`
            : `stream:${session.id}`;
        // Delivery uses the viewer admitted by start, including PAT and browser starts.
        if (route.kind === 'live' && route.liveTvViewerKey?.startsWith(`${session.username}:`))
            event.locals.liveTvCredentialId = route.liveTvViewerKey.slice(
                session.username.length + 1,
            );
        event.locals.authMethod = 'stream_token';
        event.locals.streamingSession = session;
        setRequestTimelineGrant({
            token: streamTokenParam,
            playbackSessionId: session.playbackSessionId ?? null,
        });
        // Store token for HLS URL rewriting
        event.locals.accessToken = streamTokenParam;
        // Normalized identity for enforce(). Stream tokens are never admin
        // here, even when minted by an admin: that grant covers media access
        // only (mediaAccessIsAdmin above), not admin-gated routes.
        event.locals.principal = buildPrincipal({
            kind: 'stream_token',
            userId: userContext.userId,
            username: userContext.username,
            userGroups: userContext.userGroups,
            tokenScopes: [],
            sessionIsAdmin: false,
            ownerIsAdmin: false,
            credentialId: session.id,
        });

        authLogger.debug('Stream token authenticated', {
            username: session.username,
            itemId: session.mediaItemId,
            sessionId: session.id.substring(0, 8) + '...',
        });

        return undefined; // Continue to resolve
    } catch {
        // The grant could not be checked (database/cache down): not the client's fault,
        // so a retryable 503 rather than a 401 that makes players drop the grant.
        authLogger.warn('Playback grant validation failed', { reason: 'unavailable', grantId });
        return problem('dependency_unavailable', {
            error: 'Playback grant check temporarily unavailable, retry shortly',
            retryAfter: 5,
            headers: { 'X-Playback-Grant-Reason': 'unavailable' },
        });
    }
}

// =============================================================================
// PUBLIC API AUTH: Bearer Tokens (PAT, Service Token, JWT)
// =============================================================================

// isUsernameDisabled() moved to `$lib/server/auth/token-identity.ts` (fix-plan-5
// Task 3) — its one caller (the non-impersonating service-token creator axis)
// moved with it.

async function handlePublicApiAuth(
    event: RequestEvent,
    path: string,
    bearerOnly = false,
): Promise<Response | undefined> {
    // Check if device auth is enabled
    if (!features.deviceAuth) {
        // problem+json (application/problem+json), consistent with the /api/v1 error contract.
        // error(...,503) → code dependency_unavailable with a verbatim message (serviceUnavailable
        // would append "temporarily unavailable", which misreads for a disabled feature).
        return ApiResponses.error('Public API is not enabled', undefined, 503);
    }

    // === ENTITY IMAGE ENDPOINTS: ?sig= HMAC is the auth, OR fully anonymous ===
    // /api/v1/{media|people|users|libraries}/{id}/images/{role}/{index} validate
    // an HMAC ?sig= credential in-route (auth: 'none' in their _openapi) and also
    // serve anonymous UUID requests (artwork only — see the route's docstring).
    //
    // security review 2026-09-12, C10: this used to short-circuit unconditionally,
    // BEFORE Bearer/?api_key=/stream_token parsing below — so a request that DID
    // present a real credential never got `locals.user` populated, and the route's
    // `checkMediaAccess` library/age gate was dead on this surface (anyone with an
    // internal UUID could read a group-restricted/age-gated item's artwork). Only
    // take the early exit when there's a `?sig=` (validated in-route) or no
    // credential at all; otherwise fall through so the credential below is parsed
    // and `locals.user` gets populated, letting the route's access gate run.
    // External provider lookups require a user even with ?sig=, so on those
    // requests a real bearer/grant must still be parsed when sig is present.
    // /api/v1/users/{id}/images/** is excluded: user images need a credential.
    if (isAnonymousEntityImagePath(path)) {
        const hasSig = event.url.searchParams.has('sig');
        const hasBearer = /^bearer\s+\S/i.test(event.request.headers.get('Authorization') ?? '');
        const hasGrant = event.url.searchParams.has('grant');
        const imageId = event.params.id ?? event.url.searchParams.get('externalId') ?? '';
        const externalLookup = parseMediaId(imageId).type === 'composite';
        if ((hasSig && !externalLookup) || !(hasBearer || hasGrant)) {
            return undefined; // Continue to resolve
        }
        // else: fall through to Bearer/?api_key=/stream_token parsing below.
    }

    // === TOP SHELF PREVIEW/CINEMAGRAPH MP4s: ?sig= HMAC is the auth ===
    // /api/v1/media/{id}/topshelf-preview/file/{variant} validates an HMAC
    // ?sig= credential in-route (purpose 'topshelf-preview', auth: 'public' in
    // its def). Scoped to the /file/ sub-path ONLY — the mint endpoint
    // (…/topshelf-preview without /file/) is NOT exempted here and still
    // requires a real authenticated user below.
    if (path.startsWith('/api/v1/media/') && path.includes('/topshelf-preview/file/')) {
        return undefined; // Continue to resolve
    }

    // A grant is exclusively a media-delivery credential, even on routes that
    // perform additional upstream ownership checks in their own handler.
    // Bearer-only callers (the /api/v1/server bootstrap) never honour a URL
    // credential: a stray ?grant= must not outrank a valid Authorization header.
    const grant = bearerOnly ? null : event.url.searchParams.get('grant');
    if (grant) return handleStreamToken(event, path, grant);

    // Retired singular byte routes disclose only their static 410 response.
    // Match the hook backstop exactly; mutations still require a bearer token.
    if (
        (event.request.method === 'GET' || event.request.method === 'HEAD') &&
        isRetiredAudiobookBytePath(path)
    )
        return undefined;

    // Audiobook byte handlers also resolve upstream ownership and credentials.
    // Bearer requests still pass through the account-token parser below.
    if (
        isAudiobookByteProxyPath(path) &&
        !/^bearer\s+\S/i.test(event.request.headers.get('Authorization') ?? '')
    ) {
        return undefined;
    }

    // === PUSH RICH-NOTIFICATION PAIR: ?sig= HMAC is the auth ===
    // /api/v1/notifications/{id}/push-image and
    // /api/v1/notifications/{id}/push-content/{locale} are fetched by an iOS
    // Notification Service Extension — a separate process that holds no usable
    // bearer token, which is precisely why their URLs are signed at send time.
    // Without this branch the bearer check below answers 401 and the route's
    // verifySignedUrl never runs, so the signature is not the credential at all
    // and the feature cannot work (that is what shipped).
    //
    // The route is still the only gate: it verifies the HMAC BEFORE any DB read
    // and returns 403 on a missing/invalid/expired/wrong-purpose signature, so
    // an unsigned caller learns nothing about which notification ids exist.
    //
    // Anchored full-path match, NOT a substring test — a bare
    // '/api/v1/notifications/' prefix would unauthenticate the list, mark-read
    // and preference routes too. Shared with the hooks.server.ts backstop so
    // the two cannot drift.
    if (isPushRichSignedPath(path)) {
        return undefined; // Continue to resolve; the route validates.
    }

    // Account credentials are accepted only in the Authorization header.
    const authHeader = event.request.headers.get('Authorization');
    const bearerMatch = /^bearer\s+(\S+)\s*$/i.exec(authHeader ?? '');
    const token = bearerMatch ? bearerMatch[1] : null;

    if (!token) {
        // problem+json (application/problem+json), consistent with the /api/v1 error contract.
        return ApiResponses.unauthorized('Bearer token required');
    }

    // SECURITY: Limit token length to prevent DoS via hash computation
    // PAT/Service tokens are 52 chars, JWTs vary by payload size
    // JWTs with groups array and device_session_id can reach 600+ chars
    // 1000 chars provides headroom while still preventing abuse
    if (token.length > 1000) {
        return problem('invalid_token', { error: 'Token exceeds maximum length' });
    }

    try {
        // Get client IP for token validation (used for IP whitelisting and logging).
        //
        // security review 2026-09-12, C15: use the STRICT (non-spoofable) IP, not
        // getClientIp. This value flows into PAT/service-token `.validate()` below,
        // which compares it against the token's `allowed_ips` and persists it to
        // `last_used_ip` — getClientIp honors an attacker-supplied X-Forwarded-For
        // by implicit proxy trust when TRUSTED_PROXY_IPS is unset, so a thief of an
        // IP-bound token could forge the header to defeat the allowlist and poison
        // the audit trail.
        const clientIp = getClientIpStrict(event);

        // Determine token type and validate accordingly
        // - pat_ prefix: Personal Access Token (user-created)
        // - svc_ prefix: Service Token (admin-created)
        // - Other: JWT access token (OAuth device flow)

        let userContext: UserContext;
        const jellyfinUserId: string | undefined = undefined;
        let deviceSessionId: string | undefined;
        let authMethod: 'bearer' | 'pat' | 'service_token' = 'bearer';
        // JWT `scope` claim, hoisted out of the bearer branch below so the
        // buildPrincipal() call after the if/else can read it.
        let jwtRequestedScope: string | undefined;
        let jwtNonAdminMaxAgeRating: number | null = null;
        // Device-flow client_id, hoisted out of the JWT block the same way
        // deviceSessionId/jwtRequestedScope are. Attribution only — it reaches
        // deriveSurface() via Principal and must never gate access.
        let jwtClientId: string | undefined;

        if (token.startsWith('pat_')) {
            // === Personal Access Token ===
            const response = await handlePatAuth(event, token, path, clientIp);
            if (response) {
                return await maybeRateLimitFailedAuth(response, event, clientIp, path);
            }
            return undefined; // locals already set by handlePatAuth
        } else if (token.startsWith('svc_')) {
            // === Service Token ===
            const response = await handleServiceTokenAuth(event, token, path, clientIp);
            if (response) {
                return await maybeRateLimitFailedAuth(response, event, clientIp, path);
            }
            return undefined; // locals already set
        } else {
            // === JWT Access Token (OAuth device flow) ===
            const { verifyAccessToken } = await import('$lib/server/oauth/jwt.js');
            const payload = await verifyAccessToken(token);

            if (!payload) {
                authLogger.warn('JWT REJECTED: Invalid or expired access token', {
                    path,
                    tokenPrefix: token.substring(0, 20) + '...',
                    clientIp,
                    hint: 'JWT may be expired (1h TTL), malformed, or signature invalid. User should refresh token.',
                });
                return await maybeRateLimitFailedAuth(
                    problem('invalid_token', { error: 'Invalid or expired access token' }),
                    event,
                    clientIp,
                    path,
                );
            }

            // A logged-out or revoked device's JWT stops here instead of
            // living on until `exp` (up to 24 h). Cached per replica and
            // evicted cluster-wide on revoke. See
            // oauth/device-session-liveness.ts.
            if (payload.deviceSessionId) {
                const { checkDeviceSessionLiveness } =
                    await import('$lib/server/oauth/device-session-liveness.js');
                const liveness = await checkDeviceSessionLiveness(payload.deviceSessionId);
                if (liveness === 'revoked') {
                    authLogger.warn('JWT REJECTED: device session revoked', {
                        path,
                        username: payload.username,
                        deviceSessionId: payload.deviceSessionId.substring(0, 8) + '...',
                    });
                    return await maybeRateLimitFailedAuth(
                        problem('invalid_token', { error: 'Device session has been revoked' }),
                        event,
                        clientIp,
                        path,
                    );
                }
                if (liveness === 'unknown') {
                    // Cold cache + DB unavailable: we cannot vouch for the
                    // session, but the credential is not at fault. 503, not
                    // 401 (a client would treat 401 as "signed out"), and not
                    // counted as a failed auth attempt.
                    authLogger.warn('JWT DEFERRED: device session liveness unavailable', {
                        path,
                        deviceSessionId: payload.deviceSessionId.substring(0, 8) + '...',
                    });
                    return authUnavailableResponse({ beforeHandler: true });
                }
            }

            // Resolve the stable users.id (the user-data key) from the JWT's
            // username. The row must already exist (the token was minted at
            // device-flow enrolment); if it can't be resolved (deleted user, DB
            // down) fail closed rather than build an identity-less context.
            const jwtUserId = await resolveUserIdByUsername(payload.username);
            if (!jwtUserId) {
                authLogger.warn('JWT REJECTED: no resolvable users.id for token subject', {
                    path,
                    username: payload.username,
                });
                return await maybeRateLimitFailedAuth(
                    problem('invalid_token', { error: 'Account not provisioned' }),
                    event,
                    clientIp,
                    path,
                );
            }

            // Live-resolve groups, the admin pin, the age-rating pin
            // (`age_rating_pinned`/`max_age_rating`) and the in-app merge via
            // the SAME canonical resolver the /j and play-token paths use,
            // instead of `payload.groups` (a login-time JWT snapshot) plus a
            // bare in-app merge. Before this fix (security review C10,
            // 2026-09-15/16) the device-flow JWT path never applied the
            // admin's per-user age cap or the in-app ceiling at all. This
            // also subsumes the disabled_at kill-switch (security review
            // 2026-09-13, C2) that `isUsernameDisabled()` used to provide
            // here — resolveTokenUserAccess() reads the same column and
            // fails CLOSED on a DB error (isUsernameDisabled() failed open),
            // which is the stricter, correct posture for a token with no
            // header fallback to fall back to.
            const tokenAccess = await resolveTokenUserAccess(payload.username);
            if (!tokenAccess || tokenAccess.disabled || tokenAccess.deleted) {
                // SECURITY (review 2026-09-16, task 6 fix round 1, Important 2):
                // `.deleted` added alongside `.disabled` — this is the OAuth
                // device-flow JWT path (the TV client surface), which only
                // tested `.disabled` even though resolveTokenUserAccess()
                // already resolves `.deleted` too.
                authLogger.warn(
                    'JWT REJECTED: token user access unresolvable, disabled, or deleted',
                    {
                        path,
                        username: payload.username,
                    },
                );
                return await maybeRateLimitFailedAuth(
                    problem('invalid_token', { error: 'Account disabled' }),
                    event,
                    clientIp,
                    path,
                );
            }
            // Create user context from the resolved live access (case-insensitive
            // group matching happens inside resolveTokenUserAccess/buildUserPermissions)
            userContext = {
                userId: jwtUserId,
                username: payload.username,
                groups: tokenAccess.userGroups.join('|'),
                userGroups: tokenAccess.userGroups,
                ...tokenAccess.permissions,
            };
            // jellyfinUserId not read from JWT — resolved lazily via resolveJellyfinUserId() at point of use
            deviceSessionId = payload.deviceSessionId;
            jwtRequestedScope = payload.scope;
            jwtNonAdminMaxAgeRating =
                tokenAccess.nonAdminMaxAgeRating ?? tokenAccess.permissions.maxAgeRating;
            jwtClientId = payload.clientId;
            authMethod = 'bearer';
        }

        // Release review 2026-10-21 (finding 1): a `scope=media:read` device
        // token is read-only like a `read` PAT. `{kind:'user'}` defs ignore
        // scopes, so the method gate has to run here, for every /api/v1 route.
        // Full-grant tokens (`media`, absent or unrecognised scope) carry
        // `write` and pass.
        const jwtMethodDenial = v1ScopeMethodDenial(
            mapRequestedScopeToRaw(jwtRequestedScope),
            event.request.method,
        );
        if (jwtMethodDenial) {
            authLogger.warn('Device token scope insufficient for request', {
                username: userContext.username,
                scope: jwtRequestedScope,
                method: event.request.method,
                path,
            });
            return problem('forbidden', {
                error: "This device token is read-only (scope 'media:read'); request scope 'media' to change data",
                reason: 'scope_insufficient',
            });
        }

        event.locals.user = userContext;
        event.locals.jellyfinUserId = jellyfinUserId;
        event.locals.deviceSessionId = deviceSessionId;
        event.locals.liveTvCredentialId = `device:${deviceSessionId}`;
        event.locals.authMethod = authMethod;
        // Store raw token for HLS URL rewriting (AVPlayer can't send headers)
        event.locals.accessToken = token;
        // Normalized identity for enforce() — JWT bearer path.
        // ownerIsAdmin: the JWT's payload doesn't carry an explicit admin flag,
        // but userContext.isAdmin was derived from the user's current groups (via
        // resolveInAppAccess). Use that as the ownerIsAdmin signal.
        event.locals.principal = buildPrincipal({
            kind: 'bearer',
            userId: userContext.userId,
            username: userContext.username,
            userGroups: userContext.userGroups,
            // JWT `scope` claim → raw scopes via the closed device-scope
            // allowlist (never a raw split of the claim — see
            // device-scope-map.ts for why that would be a privilege
            // escalation, and forward-auth.ts's own doc comment above this
            // block for the backward-compat ruling: absent/unrecognized
            // scope always maps to the full grant, never a narrower one).
            tokenScopes: mapRequestedScopeToRaw(jwtRequestedScope),
            sessionIsAdmin: false, // JWT is a token credential, not a session
            ownerIsAdmin: userContext.ownerIsAdmin,
            forceNonAdmin: false,
            // Attribution only — lets deriveSurface() tell our own iOS/tvOS
            // apps apart from third parties on the same public device flow.
            // Self-declared and never an auth input; see Principal.clientId.
            clientId: jwtClientId,
            // Attribution only — see Principal.credentialId. Absent when the
            // JWT carries no deviceSessionId claim.
            credentialId: deviceSessionId,
        });

        if (!event.locals.principal.isAdmin) {
            userContext.maxAgeRating = jwtNonAdminMaxAgeRating;
            userContext.isAgeRestricted = jwtNonAdminMaxAgeRating !== null;
        }

        // WARN: JWT being used for streaming content instead of stream_token
        if (authMethod === 'bearer') {
            warnJwtStreaming(path, userContext, deviceSessionId);
        }

        return undefined; // Continue to resolve
    } catch (error) {
        if (isDependencyError(error)) {
            authLogger.warn('Token validation temporarily unavailable', {
                error: String(error),
                path,
            });
            return authUnavailableResponse({ beforeHandler: true });
        }
        authLogger.warn('Token verification failed', { error: String(error), path });
        return await maybeRateLimitFailedAuth(
            problem('invalid_token', { error: 'Token verification failed' }),
            event,
            getClientIpStrict(event),
            path,
        );
    }
}

/**
 * If `response.status === 401`, increment the per-IP failed-auth counter for
 * /api/v1/*. When the counter exceeds the limit, return 429 instead of
 * the original 401 — denies further attempts cheaply without surfacing the
 * underlying auth error.
 *
 * Non-401 responses (403/405/400) pass through unchanged: those indicate a
 * valid credential that's been gated for a different reason (wrong path,
 * wrong method, insufficient scope), and a legitimate caller with a
 * misconfigured token would otherwise lock themselves out.
 *
 * SECURITY (H8): the rate-limit bucket key uses `getClientIpStrict`, NOT the
 * `clientIp` param (which is `getClientIp` — spoofable via `X-Forwarded-For`
 * when `TRUSTED_PROXY_IPS` is unset). Keying the bucket on the spoofable IP
 * would let an attacker rotate `X-Forwarded-For` per request to get a fresh
 * bucket every time, defeating the limit entirely. `clientIp` is kept for the
 * warn-log fields below (non-security telemetry).
 */
async function maybeRateLimitFailedAuth(
    response: Response,
    event: RequestEvent,
    clientIp: string,
    path: string,
): Promise<Response> {
    if (response.status !== 401) return response;

    // Fail-open if Valkey is unreachable: a rate-limit backend outage must
    // not transform every legitimate 401 (bad token, expired credential)
    // into an opaque 500. We log a warn and let the original 401 surface
    // unchanged — at worst, an attacker walking the Bearer space loses
    // its rate-limit cap during the outage, which is preferable to
    // breaking auth-error feedback for real users.
    try {
        const rateLimitIp = getClientIpStrict(event);
        const rate = await checkRateLimit(
            `apiv1:auth_fail:${rateLimitIp}`,
            PUBAPI_FAILED_AUTH_LIMIT_PER_MINUTE,
            PUBAPI_FAILED_AUTH_WINDOW_SECONDS,
        );
        if (!rate.allowed) {
            authLogger.warn('Public API auth failure rate limit exceeded', {
                clientIp,
                path,
                resetAt: rate.resetAt,
            });
            return ApiResponses.rateLimited(rate.resetAt * 1000, path);
        }
        return response;
    } catch (err) {
        authLogger.warn('Public API rate-limit check failed; passing 401 through', {
            clientIp,
            path,
            error: String(err),
        });
        return response;
    }
}

// =============================================================================
// PAT AUTH
// =============================================================================

/**
 * Map a `token-identity.ts` denial to problem+json, the one /api/v1 error
 * shape. A machine-readable denial code that is not itself the problem code
 * (e.g. `invalid_impersonation`) travels in `reason`.
 */
function denialToResponse(denial: TokenDenial): Response {
    const machine = /^[a-z_]+$/.test(denial.error) ? denial.error : undefined;
    const text = denial.message ?? (machine ? undefined : denial.error);
    if (denial.status === 401) {
        return problem('invalid_token', {
            error: text,
            reason: machine && machine !== 'invalid_token' ? machine : undefined,
        });
    }
    if (denial.status === 500) return problem('internal_error', { error: text, reason: machine });
    // A token whose owner cannot be resolved is as good as invalid: re-authenticate.
    if (machine === 'invalid_token') return problem('invalid_token', { error: text });
    if (machine === 'insufficient_scope') return problem('scope_required', { error: text });
    return problem('forbidden', {
        error: text,
        reason: denial.status === 405 ? 'method_not_permitted' : machine,
    });
}

async function handlePatAuth(
    event: RequestEvent,
    token: string,
    path: string,
    clientIp: string,
): Promise<Response | undefined> {
    // FIX (security review 5, fix-plan-5 Task 3): the credential-validation
    // and identity-resolution logic that used to live here now lives in
    // `$lib/server/auth/token-identity.ts`'s two exported steps, shared with
    // `resolve-bearer-principal.ts` (the /api/admin TERTIARY fallback) and
    // `tasks/api-auth.ts`'s `authenticate()` (the {kind:'scope'} fallback) —
    // see that module's doc comment for why (C1, C2, the IP outage). This
    // function is now a thin adapter: build the request context, call the
    // two steps, map a denial to the exact same Response this producer
    // returned before the extraction, and on success perform the `locals`
    // writes that are specific to being the /api/v1 PRIMARY authority.
    const ctx: TokenRequestCtx = { clientIp, method: event.request.method, pathname: path };

    const step1 = await validateBearerCredential(token, ctx);
    if (!step1.ok) return denialToResponse(step1.denial);
    if (step1.credential.kind !== 'pat') {
        // Unreachable in practice: this function is only ever called for a
        // token already known to start with `pat_`.
        return denialToResponse({
            status: 401,
            error: 'invalid_token',
            message: 'Invalid or expired personal access token',
        });
    }
    const { validated } = step1.credential;

    // FIX (Task 3 review, RULING not accepted): identity resolution runs
    // BEFORE the /api/v1-only scope/method gate — restoring the PRE-
    // extraction order. A version of this adapter briefly ran the gate
    // first, which meant an unresolvable/disabled PAT owner with a
    // read-only scope doing a POST got a 403 "insufficient_scope" instead
    // of the 401 "invalid_token" the identity check would have produced —
    // both wrong (a dead/disabled owner is not a scope problem) and a
    // silent behaviour change (that 401 is what feeds
    // `maybeRateLimitFailedAuth`'s failed-auth counter; a 403 does not).
    const step2 = await resolveTokenIdentity(step1.credential, { resolveJellyfinId: false });
    if (!step2.ok) return denialToResponse(step2.denial);
    const { userContext, principal } = step2.identity;

    // /api/v1-only scope-based HTTP method restriction (read = GET/HEAD
    // only; write/admin = every method). OPTIONS is deliberately NOT exempt.
    // NOT part of the shared step 1 (token-identity.ts) — see that
    // function's doc comment for why: it would pre-empt the internal
    // `/api/admin/*` surface's own per-def `{kind:'scope'}` gate for D7
    // hierarchical scopes like `library:admin`. Collapsed with the
    // service-token copy below into ONE shared helper (Global Constraint 4,
    // Task 3 review Important 3) — `v1ScopeMethodDenial()` in
    // token-identity.ts, called ONLY by these two /api/v1 adapters.
    const methodDenial = v1ScopeMethodDenial(validated.scopes, event.request.method);
    if (methodDenial) {
        authLogger.warn('PAT scope insufficient for request', {
            username: validated.username,
            tokenPrefix: validated.tokenPrefix,
            scopes: validated.scopes,
            method: event.request.method,
            path,
        });
        return denialToResponse(methodDenial);
    }

    authLogger.debug('PAT authenticated', {
        username: validated.username,
        tokenPrefix: validated.tokenPrefix,
        scopes: validated.scopes,
        path,
    });

    event.locals.user = userContext;
    // jellyfinUserId not read from PAT — resolved lazily via resolveJellyfinUserId() at point of use
    event.locals.authMethod = 'pat';
    event.locals.liveTvCredentialId = `pat:${validated.id}`;
    event.locals.accessToken = token;
    // Normalized identity for enforce() — PAT path. `principal` already
    // reflects the resolved Formula-A ownerIsAdmin verdict and forceNonAdmin
    // kill-switch (token-identity.ts's resolvePatIdentity).
    event.locals.principal = principal;

    return undefined; // Continue to resolve
}

// =============================================================================
// SERVICE TOKEN AUTH
// =============================================================================

async function handleServiceTokenAuth(
    event: RequestEvent,
    token: string,
    path: string,
    clientIp: string,
): Promise<Response | undefined> {
    // See handlePatAuth's doc comment immediately above — same extraction,
    // same shared producer (token-identity.ts).
    const ctx: TokenRequestCtx = { clientIp, method: event.request.method, pathname: path };

    const step1 = await validateBearerCredential(token, ctx);
    if (!step1.ok) return denialToResponse(step1.denial);
    if (step1.credential.kind !== 'service_token') {
        // Unreachable in practice: this function is only ever called for a
        // token already known to start with `svc_`.
        return denialToResponse({
            status: 401,
            error: 'invalid_token',
            message: 'Invalid or expired service token',
        });
    }
    const { validated } = step1.credential;

    // /api/v1-only scope gate: read scope (no literal 'admin'/'write') is
    // GET/HEAD only. NOT part of the shared step 1 (token-identity.ts) — see
    // that function's doc comment for why: it would pre-empt the internal
    // `/api/admin/*` surface's own per-def `{kind:'scope'}` gate for D7
    // hierarchical scopes like `library:admin`. Collapsed with the PAT
    // copy above into ONE shared helper (Global Constraint 4, Task 3 review
    // Important 3) — `v1ScopeMethodDenial()` in token-identity.ts, called
    // ONLY by these two /api/v1 adapters. Unlike the PAT branch, this gate
    // stays BEFORE identity resolution — that already matched the
    // pre-extraction order here (envelope and scope gates run before the
    // impersonation/creator identity lookup for service tokens).
    const requestMethod = event.request.method;
    const methodDenial = v1ScopeMethodDenial(validated.scopes, requestMethod);
    if (methodDenial) {
        authLogger.warn('Service token rejected: scope insufficient for method', {
            tokenPrefix: validated.tokenPrefix,
            scopes: validated.scopes,
            method: requestMethod,
            path: event.url.pathname,
        });
        return denialToResponse(methodDenial);
    }

    // Impersonation target comes EXCLUSIVELY from the DB-stored act_as_user
    // column, set at token creation time. The X-Act-As-User request header
    // is intentionally ignored: a stolen "monitor-only" token (no
    // act_as_user configured) must not be able to escalate by sending
    // X-Act-As-User: <victim>. This diagnostic-only warn stays here (not in
    // the shared producer) — it is about a REQUEST HEADER the impersonation
    // decision never reads, not a fact identity resolution needs.
    if (event.request.headers.has('X-Act-As-User')) {
        // Truncate so an attacker can't use an unbounded header value to
        // bloat log lines / fill disk on a server they're probing.
        const headerValue = event.request.headers.get('X-Act-As-User')?.slice(0, 64) ?? '';
        authLogger.warn(
            'X-Act-As-User header ignored — impersonation target is DB-bound at token creation',
            {
                tokenName: validated.name,
                tokenPrefix: validated.tokenPrefix,
                headerValue,
            },
        );
    }

    const step2 = await resolveTokenIdentity(step1.credential, { resolveJellyfinId: true });
    if (!step2.ok) return denialToResponse(step2.denial);
    const { userContext, principal, jellyfinUserId } = step2.identity;

    authLogger.debug('Service token authenticated', {
        tokenName: validated.name,
        tokenPrefix: validated.tokenPrefix,
        actAsUser: validated.actAsUser || '(admin)',
        path,
    });

    event.locals.user = userContext;
    event.locals.jellyfinUserId = jellyfinUserId;
    event.locals.authMethod = 'service_token';
    event.locals.liveTvCredentialId = `service:${validated.id}`;
    event.locals.accessToken = token;
    // Normalized identity for enforce() — service token path. `principal`
    // already reflects the resolved Formula-A verdict (impersonation target
    // or non-impersonating creator) and the post-downgrade/forceNonAdmin
    // state (token-identity.ts's resolveTokenIdentity()'s service-token
    // branch).
    event.locals.principal = principal;

    return undefined; // Continue to resolve
}

// =============================================================================
// JWT STREAMING WARNING
// =============================================================================

function warnJwtStreaming(
    path: string,
    userContext: UserContext,
    deviceSessionId: string | undefined,
): void {
    // WARN: JWT being used for streaming content instead of stream_token
    // This is suboptimal because:
    // 1. JWT expires in 1h vs stream_token's 24h - causes mid-playback auth failures for movies >1h
    // 2. No item-scoped validation - JWT works for any item
    // 3. No inactivity tracking - can't auto-end abandoned sessions
    //
    // Client SHOULD (but not required):
    // 1. Create streaming session: POST /api/v1/playback/{itemId}/session (with JWT)
    // 2. Use returned stream_token as URL parameter for HLS/streaming requests
    //
    // Rate-limited to once per 5 minutes per device to avoid log spam
    const isStreamingContent =
        /\.(m3u8|ts|mp4|m4s|vtt)$/i.test(path) ||
        /\/(Videos|Audio)\/[^/]+\/(stream|universal)/i.test(path);
    if (isStreamingContent && deviceSessionId) {
        const now = Date.now();
        const lastWarned = jwtStreamWarningTimes.get(deviceSessionId) || 0;
        if (now - lastWarned > JWT_STREAM_WARNING_INTERVAL_MS) {
            jwtStreamWarningTimes.set(deviceSessionId, now);
            authLogger.warn(
                'JWT used for streaming: Consider using stream_token for long content',
                {
                    path: path.split('/').slice(-3).join('/'),
                    username: userContext.username,
                    deviceSessionId: deviceSessionId.substring(0, 8) + '...',
                    hint: 'stream_token lasts 24h vs JWT 1h. Create via POST /api/v1/playback/{itemId}/session',
                },
            );
        }
    }
}

// =============================================================================
// NATIVE LOGIN (session cookie) — coexists with forward auth
// =============================================================================

/**
 * Decide how a present-and-valid native session cookie interacts with a
 * *trusted* forward-auth header on the SAME request. Pure so it can be unit
 * tested in isolation.
 *
 * A trusted forward-auth header is the live front-door assertion of identity AND
 * current group membership. When one is present it is authoritative for this
 * request, so the session cookie must never override it — otherwise a session's
 * groups (captured at login, valid up to the 30-day TTL) silently shadow the
 * user's live IdP groups. A stale admin session can hide a newly granted
 * `LiveTV` group and incorrectly redirect /livetv to `/`.
 *
 * - No trusted header        → `use-session`       (native-only deployments, or
 *                                                    header-stripped surfaces like /api/v1)
 * - Header, different user    → `clear-and-defer`   (cookie is stale/wrong — drop it)
 * - Header, same user         → `defer-keep-cookie` (live header wins for THIS request;
 *                                                    cookie stays valid for /api/v1)
 *
 * `forwardUsername` is already lowercased by `readTrustedForwardAuthIdentity`; we
 * lowercase the session username here to match case-insensitively.
 */
export function resolveSessionVsForwardAuth(input: {
    sessionUsername: string;
    forwardUsername: string | null;
}): 'use-session' | 'clear-and-defer' | 'defer-keep-cookie' {
    const { sessionUsername, forwardUsername } = input;
    if (!forwardUsername) return 'use-session';
    return forwardUsername === sessionUsername.toLowerCase()
        ? 'defer-keep-cookie'
        : 'clear-and-defer';
}

/**
 * Populate `event.locals.user` from a native-login session cookie, if present
 * and valid. Returns true when an identity was established (caller should treat
 * the request as authenticated), false otherwise.
 *
 * An invalid/expired/revoked cookie is cleared so the browser stops resending a
 * dead token. This runs BEFORE forward-auth header logic so a logged-in native /
 * OIDC user is recognized; if no cookie is present the request falls through to the
 * existing Authentik-header path (the two coexist).
 *
 * PROXY-WINS-WHEN-PRESENT: when a request ALSO carries a *trusted* forward-auth
 * header, the proxy's live assertion is authoritative and we defer to the header
 * path — even when it names the SAME user. The header carries live group
 * membership; the cookie's groups are a snapshot from login and can be stale. A
 * DIFFERENT-user cookie is additionally cleared (it's genuinely wrong); a
 * same-user cookie is kept (still valid for header-less surfaces). The header
 * path still honors a DB admin pin via `resolveDbAuth`, so deferring never loses
 * a pinned admin — only stale group data is discarded in favor of the live set.
 * This is what makes native/OIDC + forward-auth coexistence safe.
 */
export async function populateSessionUser(event: RequestEvent): Promise<boolean> {
    const token = readSessionCookie(event.cookies);
    if (!token) return false;

    try {
        const row = await getSessionService().validate(token);
        if (!row) {
            // Dead token — clear it so the browser stops resending.
            clearSessionCookie(event.cookies);
            return false;
        }

        // If a trusted proxy asserts identity on THIS request, defer to the live
        // header (see PROXY-WINS-WHEN-PRESENT above) so stale session groups can't
        // shadow live IdP membership.
        {
            const forwardIdentity = readTrustedForwardAuthIdentity(event);
            const decision = resolveSessionVsForwardAuth({
                sessionUsername: row.username,
                forwardUsername: forwardIdentity?.username ?? null,
            });
            if (decision === 'clear-and-defer') {
                authLogger.warn(
                    'Session cookie identity differs from trusted forward-auth header; clearing cookie and deferring to proxy',
                    { cookieUser: row.username, headerUser: forwardIdentity?.username },
                );
                clearSessionCookie(event.cookies);
                return false;
            }
            if (decision === 'defer-keep-cookie') {
                // Same user: live header is authoritative for this request, but the
                // cookie stays valid for header-less surfaces.
                return false;
            }
        }

        // Merge the in-app access layer (standalone multi-user) — this is the
        // PRIMARY path for a no-IdP install. The session row carries the user id,
        // so resolve in-app group memberships + capabilities and thread them in
        // (keeps buildUserContextFromSession pure). Dependency failures remain temporary.
        const sessAccess = await resolveInAppAccess(row.user_id, row.groups ?? [], {
            requireAvailable: true,
        });
        const sessionUserContext = buildUserContextFromSession(row, {
            // Pass ONLY the in-app group names — buildUserContextFromSession merges
            // them onto the session's own groups itself. Passing the already-merged
            // effectiveGroups would double-feed the synced groups (the dedupe saves
            // correctness today, but the SessionEffectiveAccess contract is that
            // extraGroups AUGMENTS the session list).
            extraGroups: sessAccess.inAppGroupNames,
            extraCapabilities: sessAccess.extraCapabilities,
        });
        event.locals.user = sessionUserContext;
        event.locals.authMethod = 'session';
        event.locals.liveTvCredentialId = `session:${row.session_id}`;
        event.locals.jellyfinUserId = undefined;
        // Normalized identity for enforce() — native/OIDC session path.
        // sessionUserContext.isAdmin is `buildUserContextFromSession()`'s
        // Formula-A verdict — `native-session.ts`'s own pin-conditional
        // override (`row.admin_pinned ? { isAdminOverride: row.is_admin } :
        // {}`) merged with `sessAccess.extraCapabilities` above, NOT a raw
        // `users.is_admin` column read. This session path already applied
        // the pin-conditional override before the C6 fix (security review
        // 2026-09-23) — it is `resolveDbAuth`'s forward-auth/SSO session
        // (below) that needed the same treatment.
        event.locals.principal = buildPrincipal({
            kind: 'session',
            userId: sessionUserContext.userId,
            username: sessionUserContext.username,
            userGroups: sessionUserContext.userGroups,
            tokenScopes: [],
            sessionIsAdmin: sessionUserContext.ownerIsAdmin,
            ownerIsAdmin: sessionUserContext.ownerIsAdmin,
            credentialId: row.session_id,
        });
        return true;
    } catch (error) {
        if (isDependencyError(error)) {
            authLogger.warn(
                'Native session validation temporarily unavailable; preserving cookie',
                {
                    error: String(error),
                },
            );
            throw new AuthDependencyUnavailableError(error);
        }
        authLogger.warn('Native session validation errored; ignoring cookie', {
            error: String(error),
        });
        return false;
    }
}

/**
 * First-run state: whether setup is complete — the `setup_lock` row exists, or
 * (before the lock existed) a counted admin does (`adminExists`, the lock-aware
 * setup gate). Cached because an unauthenticated request would otherwise hit
 * the DB on every page load. Completion does not revert at runtime (only
 * `SETUP_UNLOCK` at boot clears the lock), so we cache `true` permanently;
 * `false` is re-checked with a short TTL so the first admin creation is seen
 * promptly.
 */
let adminExistsCache: { value: boolean; expiresAt: number } | null = null;
const ADMIN_EXISTS_FALSE_TTL_MS = 10_000;

async function anAdminExists(): Promise<boolean> {
    if (adminExistsCache?.value === true) return true;
    if (adminExistsCache && Date.now() < adminExistsCache.expiresAt) {
        return adminExistsCache.value;
    }
    try {
        const { aiDbService } = await import('$lib/server/services/database.service.js');
        const sql = await aiDbService.getSql();
        if (!sql) {
            // DB unavailable — don't claim first-run (avoid exposing /setup
            // spuriously); assume an admin exists and let normal auth proceed.
            return true;
        }
        const exists = await adminExists(sql, config.ADMIN_GROUPS);
        adminExistsCache = exists
            ? { value: true, expiresAt: Number.POSITIVE_INFINITY }
            : { value: false, expiresAt: Date.now() + ADMIN_EXISTS_FALSE_TTL_MS };
        return exists;
    } catch (error) {
        authLogger.warn('adminExists check failed; assuming an admin exists', {
            error: String(error),
        });
        return true;
    }
}

/**
 * Invalidate the first-run cache. Called immediately after the first admin is
 * created so the very next request stops redirecting to /setup.
 */
export function invalidateAdminExistsCache(): void {
    adminExistsCache = null;
}

/**
 * Public native-auth surfaces reachable WITHOUT forward-auth headers or an
 * existing session. The login/setup pages and their POST endpoints must be
 * usable by an unauthenticated visitor. (change-password is intentionally NOT
 * here — it requires an authenticated session and routes through normal auth.)
 */
const NATIVE_AUTH_PUBLIC_PATHS = new Set([
    '/login',
    '/setup',
    // Static "setup is locked" explanation (no data, no actions) shown to a
    // completed install that has lost every admin. Reachable anonymously for
    // the same reason as /setup: nobody on such an install can sign in as admin.
    '/setup/locked',
    '/api/auth/native/login',
    '/api/auth/native/setup',
    '/api/auth/native/logout',
    // First-run OIDC "Test connection" probe on the /setup wizard: runs pre-admin
    // (before any session exists), so it must be reachable unauthenticated. It has
    // its own first-run guard (404 once an admin exists) and only probes the
    // server-configured issuer, so it's inert post-onboarding.
    '/api/setup/oidc-test',
    // First-run OIDC configuration write (issuer/client id/secret) from the wizard.
    // Same pre-admin + first-run-guarded posture as native admin creation above.
    '/api/setup/oidc-config',
    // OIDC login initiation + provider callback must be reachable by an
    // unauthenticated browser (they self-authenticate via the IdP). When a
    // forward-auth proxy fronts the app, the operator must likewise allow these
    // through unauthenticated for OIDC to be reachable.
    '/auth/oidc/login',
    '/auth/oidc/callback',
    // Back-channel logout receiver: Authentik (server-to-server, no cookie) POSTs
    // a signed logout_token here. It self-authenticates by that token's signature.
    '/auth/oidc/backchannel-logout',
    // PWA web manifest — non-sensitive static metadata (app name, icons, theme)
    // linked from every page incl. the public /login + /setup. Gating it makes the
    // browser receive HTML for a .json and log a manifest parse error on those
    // unauthenticated pages, so serve it through to anyone.
    '/manifest.json',
]);

export function isNativeAuthPublicPath(path: string): boolean {
    return NATIVE_AUTH_PUBLIC_PATHS.has(path);
}

/**
 * Auth-provider plugin login routes.
 *
 * Pre-auth by necessity — they exist to establish a session — and reachable
 * only when an operator has named the provider in `AUTH_PLUGIN_PROVIDERS`; the
 * route itself 404s otherwise, so this carve-out opens a door that is closed
 * again one layer down.
 *
 * SECURITY: anchored on the trailing slash, exactly like the plugin-webhook
 * bypass. `startsWith('/api/auth/plugin')` without it would also open
 * `/api/auth/plugin-admin` and every other lookalike sibling. Pinned by tests.
 */
export function isPluginAuthPublicPath(path: string): boolean {
    return path.startsWith('/api/auth/plugin/');
}

/**
 * Forward-auth identity as seen on the current request, AFTER the trusted-peer
 * check. Used by the onboarding wizard (page load + /api/auth/setup) to detect
 * and display the headers the proxy is sending and to verify admin-group
 * membership — outside the normal handleForwardAuth flow (those routes are in the
 * public-auth set and don't run it).
 */
export interface TrustedForwardAuthIdentity {
    /** Lowercased username from USERHEADER. */
    username: string;
    /** Parsed group list from GROUPHEADER. */
    groups: string[];
    /** Whether `groups` includes a member of ADMIN_GROUPS. */
    isAdmin: boolean;
}

/**
 * A reverse proxy that fails to expand its header template forwards the LITERAL
 * placeholder string (e.g. an unconfigured Caddy
 * `{http.reverse_proxy.header.x-authentik-username}`). Real usernames never
 * contain `{`/`}`, so such a value is a proxy misconfiguration, not an identity —
 * reject it so a bad header can't auto-provision a junk `users` row.
 */
export function isUnexpandedProxyPlaceholder(value: string): boolean {
    return value.includes('{') || value.includes('}');
}

/**
 * Actual TCP peer for identity trust and diagnostics. An unavailable peer is
 * empty and fails the trusted-peer check, so callers stay fail-closed.
 */
function peerOf(event: RequestEvent): string {
    return getTcpPeer(event);
}

/**
 * Whether the caller is plausibly the OPERATOR rather than an anonymous visitor,
 * and may therefore be shown verbose setup diagnostics.
 *
 * True only for a DIRECT request from loopback / RFC1918 / link-local — the
 * `docker run` + `curl localhost` case the setup guidance exists for. The
 * forwarded-header check is what makes the private-address test meaningful:
 * behind a reverse proxy the TCP peer is the proxy, which is itself almost
 * always on a private container network, so peer-privacy ALONE would hand the
 * full diagnostics to every visitor of a normal proxied deployment.
 *
 * ⚠️ NOT an authorization decision — it grants no access and gates no data.
 * It chooses only how much configuration detail a rejection spells out, so the
 * public internet cannot use a 401 to fingerprint the product or enumerate the
 * configured identity-header names. The private-peer test below is meaningful
 * ONLY when the reverse proxy in front of this app actually annotates the
 * request with `X-Forwarded-For` / `X-Real-IP` (the `hasForwardedClientIpHeader`
 * check just above it is what makes that true). A peer explicitly pinned in
 * `TRUSTED_PROXY_IPS` is never treated as proximate, forwarded header or not
 * — see `isConfiguredTrustedProxy` below. But an UNPINNED proxy that adds no
 * forwarded header at all (`TRUSTED_PROXY_IPS` unset — the likely shape of an
 * OPTION 1 native-login deployment before its `proxy_set_header` lines are
 * added) is STILL treated as the operator, since neither check catches it;
 * closing that residual is `.env.example`'s job, not this function's. A
 * caller who ADDS a forwarded-for header only makes their own response more
 * generic, so the spoofable direction is the safe one.
 */
function isOperatorProximate(event: RequestEvent): boolean {
    if (hasForwardedClientIpHeader(event.request.headers)) return false;
    const peer = peerOf(event);
    // A peer explicitly pinned in TRUSTED_PROXY_IPS is a KNOWN reverse proxy,
    // never the operator — even if it (mis)forwards without annotating
    // X-Forwarded-For / X-Real-IP. Allowlist-only: do NOT use
    // `isForwardAuthPeerTrusted` here, which also returns true for every peer
    // under LUMASTRA_TRUST_ANY_PROXY and would wrongly deny a genuine
    // `curl localhost` operator their setup guidance on that opt-in.
    if (isConfiguredTrustedProxy(peer)) return false;
    return isPrivateClientIp(peer);
}

/** Posture-dependent remediation for "identity headers came from the wrong peer". */
function untrustedPeerHint(): string {
    const peerHint =
        forwardAuthTrustPosture() === 'fail-closed'
            ? 'TRUSTED_PROXY_IPS is unset (fail-closed). Set it to your reverse-proxy IP(s), or LUMASTRA_TRUST_ANY_PROXY=true for a single-host deploy.'
            : 'Only peers in TRUSTED_PROXY_IPS may set USERHEADER/GROUPHEADER.';
    return isForwardAuthEnabled()
        ? peerHint
        : `${peerHint} Forward auth is also off: set FORWARD_AUTH_ENABLED=true only if you sign in through a forward-auth proxy. Logged at most once every 10 minutes while it is off.`;
}

/**
 * Remediation for "the proxy forwarded its own header template". Posture-independent
 * — no amount of trust configuration fixes an unexpanded `{…}` value.
 */
const PLACEHOLDER_HINT =
    'The reverse proxy forwarded a literal, unexpanded header template (a value containing {…}) instead of the real value. Fix the proxy header mapping (Caddy `header_up`, nginx `proxy_set_header`, Traefik `authResponseHeaders`), or unset the header.';

/**
 * The diagnostic payload shape shared by EVERY forward-auth header rejection —
 * peer, path, trust posture, remediation hint. Previously only the
 * untrusted-peer path logged this much; the placeholder paths logged `{ path }`
 * alone, which cannot tell an operator which host sent the bad header.
 */
function headerRejectionContext(
    event: RequestEvent,
    path: string,
    hint: string,
): { peer: string; path: string; posture: string; hint: string } {
    return { peer: peerOf(event), path, posture: forwardAuthTrustPosture(), hint };
}

/**
 * Whether forward-auth identity headers may be read at all. Opt-in
 * (FORWARD_AUTH_ENABLED, default off): TRUSTED_PROXY_IPS is also set only to get
 * real client IPs, and no proxy strips client-sent identity headers by default,
 * so peer trust alone let an anonymous `X-Forwarded-User: <admin>` sign in as
 * that admin. Strict `=== true` so a test or settings mock that omits the key
 * fails closed.
 */
export function isForwardAuthEnabled(): boolean {
    return config.FORWARD_AUTH_ENABLED === true;
}

/**
 * The single decision every identity-header reader in this file applies, in this
 * order: an untrusted peer is reported as possible forgery first (whatever the
 * flag says, matching the long-standing log and setup diagnostics), then the
 * opt-in flag. Only `accept` lets USERHEADER / GROUPHEADER / NAMEHEADER through.
 */
export type IdentityHeaderVerdict = 'accept' | 'untrusted-peer' | 'disabled';

export function identityHeaderVerdict(event: RequestEvent): IdentityHeaderVerdict {
    // best-effort/fail-closed: an unknowable peer yields a sentinel that fails the check.
    if (!isForwardAuthPeerTrusted(peerOf(event))) return 'untrusted-peer';
    if (!isForwardAuthEnabled()) return 'disabled';
    return 'accept';
}

/** Rate-limited log + health-check record for identity headers ignored while forward auth is off. */
function noteDisabledHeaders(event: RequestEvent, path: string, present: string[]): void {
    noteIgnoredForwardAuthHeaders({
        peer: peerOf(event),
        path,
        headerNames: present,
        request: event.request,
    });
}

/**
 * Whether to emit the per-request "untrusted peer" warning. Always with forward
 * auth on (possible forgery). With it off, at most once per window: the headers
 * could not sign anyone in, and an anonymous scanner must not flood the log.
 */
function shouldWarnUntrustedPeer(): boolean {
    return isForwardAuthEnabled() || shouldLogUntrustedWhileDisabled();
}

/**
 * Read forward-auth identity headers for the current request, honoring the same
 * trusted-peer gate as handleForwardAuth (forged headers from an untrusted TCP
 * peer are discarded). Returns null when no usable identity header is present
 * (or it was rejected as untrusted).
 */
/**
 * HTTP header values are transported as opaque bytes and Node decodes them as
 * ISO-8859-1 (Latin-1). A reverse proxy (e.g. Authentik) that forwards a UTF-8
 * username such as "björn" therefore arrives mojibaked ("bjÃ¶rn"), which then
 * gets stored/displayed wrong. Re-interpret the Latin-1 bytes as UTF-8, but ONLY
 * when they form valid UTF-8 (round-trip check) so pure-ASCII and genuine
 * Latin-1 values pass through unchanged.
 */
export function decodeProxyHeaderValue(raw: string | null): string | null {
    if (!raw) return raw;
    try {
        const bytes = Buffer.from(raw, 'latin1');
        const utf8 = bytes.toString('utf8');
        if (utf8 !== raw && Buffer.from(utf8, 'utf8').equals(bytes)) return utf8;
    } catch {
        /* fall through — leave the value untouched */
    }
    return raw;
}

export function readTrustedForwardAuthIdentity(
    event: RequestEvent,
): TrustedForwardAuthIdentity | null {
    const rawUserHeader =
        decodeProxyHeaderValue(event.request.headers.get(config.USERHEADER))?.trim() || null;
    const rawGroupHeader =
        decodeProxyHeaderValue(event.request.headers.get(config.GROUPHEADER))?.trim() || null;
    if (!rawUserHeader && !rawGroupHeader) return null;

    const path = event.url.pathname;
    const verdict = identityHeaderVerdict(event);
    if (verdict === 'untrusted-peer') {
        // Previously a SILENT null: the caller saw "no identity" and nothing
        // anywhere said why. Same payload shape as handleForwardAuth's rejection
        // so one grep finds both.
        if (shouldWarnUntrustedPeer()) {
            authLogger.warn(
                'Forward-auth: identity headers ignored — untrusted TCP peer',
                headerRejectionContext(event, path, untrustedPeerHint()),
            );
        }
        return null;
    }
    if (verdict === 'disabled') {
        noteDisabledHeaders(
            event,
            path,
            [
                rawUserHeader ? config.USERHEADER : null,
                rawGroupHeader ? config.GROUPHEADER : null,
            ].filter((h): h is string => h !== null),
        );
        return null;
    }

    if (!rawUserHeader || isUnexpandedProxyPlaceholder(rawUserHeader)) {
        if (rawUserHeader) {
            authLogger.warn(
                'Forward-auth: identity headers ignored — unexpanded reverse-proxy placeholder',
                {
                    ...headerRejectionContext(event, path, PLACEHOLDER_HINT),
                    header: config.USERHEADER,
                    value: rawUserHeader.slice(0, 120),
                },
            );
        }
        return null;
    }
    const username = rawUserHeader.toLowerCase();
    const groups = parseList(rawGroupHeader || '');
    return {
        username,
        groups,
        isAdmin: isUserAdmin(groups),
    };
}

/**
 * The TCP peer whose forward-auth identity headers were DISCARDED because it is
 * not a trusted proxy — or null when no identity header is present or the peer
 * is trusted. Lets the first-run wizard say "your proxy's headers arrived but
 * were rejected: add <peer> to TRUSTED_PROXY_IPS" instead of the misleading "no
 * headers detected". The caller decides who may see the address (the /setup
 * load only exposes it pre-admin / to a resuming admin). Same header + peer
 * reads as readTrustedForwardAuthIdentity, which already logged the rejection.
 */
export function readRejectedForwardAuthPeer(event: RequestEvent): string | null {
    // Peer-only on purpose: with forward auth off, an untrusted peer still needs
    // TRUSTED_PROXY_IPS once the operator turns it on, so the hint stays useful.
    const hasIdentityHeader =
        Boolean(event.request.headers.get(config.USERHEADER)?.trim()) ||
        Boolean(event.request.headers.get(config.GROUPHEADER)?.trim());
    if (!hasIdentityHeader) return null;
    const peer = peerOf(event);
    if (isForwardAuthPeerTrusted(peer)) return null;
    // Show IPv4-mapped IPv6 as the plain IPv4 the operator would type.
    return /^::ffff:/i.test(peer) ? peer.slice(7) : peer;
}

/**
 * True when identity headers came from a TRUSTED peer but were ignored because
 * FORWARD_AUTH_ENABLED is off. Lets the first-run wizard say "your proxy is
 * sending identity headers; set FORWARD_AUTH_ENABLED=true" instead of "no
 * headers detected". Reads names only, never values.
 */
export function readDisabledForwardAuthHeaders(event: RequestEvent): boolean {
    const hasIdentityHeader =
        Boolean(event.request.headers.get(config.USERHEADER)?.trim()) ||
        Boolean(event.request.headers.get(config.GROUPHEADER)?.trim());
    return hasIdentityHeader && identityHeaderVerdict(event) === 'disabled';
}

/**
 * Does a request with no identity header fall back to `DEFAULT_USER` with
 * `ADMIN_GROUPS`? Only under `vite dev`, and not when
 * `LUMASTRA_DEV_NO_DEFAULT_USER=true`.
 *
 * The opt-out exists for Playwright, whose webServer is `vite dev`: with the
 * fallback on, a spec that blanks or omits the forward-auth headers to test an
 * unauthenticated or bearer-only call was admin instead, so its 401/403
 * expectations could pass vacuously or fail for the wrong reason.
 * playwright.config.ts sets it. Read per request so tests can toggle it.
 *
 * Production builds are unaffected: `dev` is statically false there, so the
 * variable is never consulted.
 */
function devDefaultUserFallback(): boolean {
    return dev && (process.env.LUMASTRA_DEV_NO_DEFAULT_USER ?? '').trim().toLowerCase() !== 'true';
}

/** 303 redirect Response (no body) for use inside the auth middleware. */
function redirectResponse(location: string): Response {
    return new Response(null, {
        status: 303,
        headers: { location, 'cache-control': 'no-store' },
    });
}

/**
 * Is this an HTML page navigation (GET, accepts text/html, not an asset / API /
 * SvelteKit data request)? Only such requests get redirected to /login or /setup;
 * API and asset requests keep their existing 401 behavior.
 */
function isHtmlPageRequest(event: RequestEvent, path: string): boolean {
    if (event.request.method !== 'GET') return false;
    if (path.startsWith('/api/')) return false;
    if (path.startsWith('/_app/')) return false;
    if (path === '/oauth' || path.startsWith('/oauth/')) return false;
    if (STATIC_FILE_REGEX.test(path)) return false;
    // SvelteKit client-side nav data requests carry __data.json; let those 401
    // rather than 303 so the client router surfaces the auth error cleanly.
    if (path.endsWith('/__data.json')) return false;
    const accept = event.request.headers.get('accept') ?? '';
    return accept.includes('text/html') || accept === '' || accept.includes('*/*');
}

// =============================================================================
// FORWARD AUTH (Authentik headers)
// =============================================================================

async function handleForwardAuth(
    event: RequestEvent,
    path: string,
    ensureDatabaseMigration: () => Promise<void>,
    migrationCompleted: boolean,
): Promise<Response | undefined> {
    // === NATIVE SESSION COOKIE (coexists with forward auth) ===
    // A valid native-login session takes precedence and short-circuits the
    // Authentik-header path. If there's no cookie (or it's dead) we fall through
    // to the existing forward-auth logic unchanged.
    if (await populateSessionUser(event)) {
        return undefined;
    }

    // === FIRST-RUN ONBOARDING (guided, regardless of forward-auth headers) ===
    // On a fresh install (no admin exists yet) send EVERY HTML page visitor to
    // /setup — even one already presenting forward-auth headers — so the operator
    // is walked through verifying the proxy headers + admin-group membership (or
    // creating a native admin) instead of being silently auto-provisioned. Once
    // any admin exists this never fires again, so existing deployments (which
    // already have an admin row) are unaffected. Non-HTML (API/asset) requests
    // fall through to the normal logic below.
    if (!dev && isHtmlPageRequest(event, path) && !(await anAdminExists())) {
        return redirectResponse('/setup');
    }

    // Trim whitespace: "   " must be treated as absent, not as a valid username.
    // decodeProxyHeaderValue repairs UTF-8 usernames the proxy sent as bytes that
    // Node decoded as Latin-1 (e.g. "björn" → "bjÃ¶rn").
    let rawUserHeader =
        decodeProxyHeaderValue(event.request.headers.get(config.USERHEADER))?.trim() || null;
    // The groups header keeps ABSENT (null) and PRESENT-but-EMPTY ('') apart —
    // `?? null`, not `|| null`. Authentik always sets it (`groups.join('|')`),
    // so '' is the IdP saying "this user has no groups" and must clear the
    // stored groups; null is a proxy that did not forward it (or a strip
    // below) and must never write, or age-cap groups would drop and fail open.
    // Every truthiness check below treats '' exactly like null; only
    // `groupsHeaderPresent` further down distinguishes them.
    let rawGroupHeader =
        decodeProxyHeaderValue(event.request.headers.get(config.GROUPHEADER))?.trim() ?? null;
    // Optional third identity header: the IdP's human-readable name for the user,
    // used to populate users.display_name. Handled EXACTLY like the other two —
    // same decode, same showcase strip, same placeholder discard, same
    // trusted-peer gate below — because it is rendered to OTHER users (the
    // "who else watched this" list), so a client that could set it directly would
    // get to pick the label everyone else sees. An operator who blanks NAMEHEADER
    // turns the feature off; `headers.get('')` would throw, so guard the name.
    const nameHeaderName = config.NAMEHEADER.trim();
    let rawNameHeader = nameHeaderName
        ? decodeProxyHeaderValue(event.request.headers.get(nameHeaderName))?.trim() || null
        : null;

    // S-8: Belt-and-suspenders — actively strip identity headers on showcase paths.
    // The bypass below fires only when headers are ABSENT; this guard ensures that
    // even a forged USERHEADER/GROUPHEADER sent on /showcase* (e.g. by an attacker
    // who can reach the app directly with TRUSTED_PROXY_IPS=* or on a
    // misconfigured reverse proxy that omits the strip) can NEVER be read by
    // downstream code.  Showcase pages and HLS routes are public-unauthenticated;
    // any identity header on them is noise at best and a privilege-escalation
    // vector at worst.
    if (
        config.FEATURE_PUBLIC_SHOWCASE &&
        (path === '/showcase' ||
            path.startsWith('/showcase/') ||
            path === '/api/showcase' ||
            path.startsWith('/api/showcase/'))
    ) {
        rawUserHeader = null;
        rawGroupHeader = null;
        rawNameHeader = null;
    }

    // F1: forward-auth headers carry identity (USERHEADER/GROUPHEADER) and are
    // only trustworthy when the TCP peer is the reverse proxy that set them. If
    // TRUSTED_PROXY_IPS is configured and the peer is NOT in it, an attacker has
    // reached the app directly and forged the headers — discard them and treat
    // the request as unauthenticated (fail-closed). When TRUSTED_PROXY_IPS is
    // unset we preserve the default proxy-fronted deployment (a startup warning
    // nudges operators to pin the proxy IP).
    // Tracks the case where identity headers WERE sent but discarded because the
    // peer isn't trusted — used to give a tailored "set TRUSTED_PROXY_IPS"
    // message instead of the generic "no proxy" one.
    //
    // This gate runs BEFORE the placeholder inspection below, matching
    // readTrustedForwardAuthIdentity. Order is load-bearing twice over: an
    // untrusted peer's header VALUE must never be echoed into the log (it is
    // attacker-chosen text), and a forged header must be reported as forgery
    // rather than diagnosed as a proxy-template misconfiguration. Running the
    // placeholder check first would null the headers and skip this gate entirely.
    let rejectedUntrustedPeer = false;
    const headerVerdict =
        rawUserHeader || rawGroupHeader || rawNameHeader ? identityHeaderVerdict(event) : 'accept';
    if (headerVerdict === 'untrusted-peer') {
        // Only identity headers indicate forgery; a lone display-name header is
        // dropped silently (it authenticates nothing and never reached this warn).
        if (rawUserHeader || rawGroupHeader) {
            if (shouldWarnUntrustedPeer()) {
                authLogger.warn(
                    'Forward-auth headers from an untrusted TCP peer were ignored (possible header forgery)',
                    headerRejectionContext(event, path, untrustedPeerHint()),
                );
            }
            rejectedUntrustedPeer = true;
        }
        rawUserHeader = null;
        rawGroupHeader = null;
        rawNameHeader = null;
    }

    // Forward auth is opt-in (FORWARD_AUTH_ENABLED). A trusted peer's identity
    // headers are dropped when it is off: TRUSTED_PROXY_IPS alone only means
    // "this peer may tell me the client IP". Logged once per window without
    // values, and recorded for the admin security self-check. The request then
    // continues exactly like one that never carried the headers (session cookie
    // already handled above, else /login or the 401 below). A lone display-name
    // header is dropped silently, as on the untrusted path.
    if (headerVerdict === 'disabled') {
        if (rawUserHeader || rawGroupHeader) {
            noteDisabledHeaders(
                event,
                path,
                [
                    rawUserHeader ? config.USERHEADER : null,
                    rawGroupHeader ? config.GROUPHEADER : null,
                ].filter((h): h is string => h !== null),
            );
        }
        rawUserHeader = null;
        rawGroupHeader = null;
        rawNameHeader = null;
    }

    // A reverse proxy that didn't expand its header template forwards the LITERAL
    // placeholder (e.g. an unconfigured Caddy
    // `{http.reverse_proxy.header.x-authentik-username}`). Real usernames have no
    // braces — discard both headers so a misconfigured proxy routes to the
    // missing-auth path instead of auto-provisioning a junk `users` row.
    // Only reachable for a TRUSTED peer, so the logged value below is our own
    // proxy's config string.
    let rejectedPlaceholder = false;
    if (rawUserHeader && isUnexpandedProxyPlaceholder(rawUserHeader)) {
        rejectedPlaceholder = true;
        authLogger.warn('Forward-auth: discarded unexpanded reverse-proxy username placeholder', {
            ...headerRejectionContext(event, path, PLACEHOLDER_HINT),
            header: config.USERHEADER,
            value: rawUserHeader.slice(0, 120),
        });
        rawUserHeader = null;
        rawGroupHeader = null;
        rawNameHeader = null;
    }

    // The name header can be an unexpanded placeholder on its own — a proxy may
    // template the username correctly and the display name not at all. Drop just
    // that one rather than the whole identity: the user still authenticates, they
    // simply keep the username fallback.
    if (rawNameHeader && isUnexpandedProxyPlaceholder(rawNameHeader)) {
        authLogger.warn(
            'Forward-auth: discarded unexpanded reverse-proxy display-name placeholder',
            {
                ...headerRejectionContext(event, path, PLACEHOLDER_HINT),
                header: nameHeaderName,
                value: rawNameHeader.slice(0, 120),
            },
        );
        rawNameHeader = null;
    }

    // A groups header with no usable username header is not an identity. Left
    // in, it passed `hasAuthHeaders` below and `username` fell back to
    // DEFAULT_USER ('admin' by default) — outside dev too, since `isDev` is
    // false once a groups header is present — so a trusted proxy that emits
    // the groups header without checking the username (an nginx server-level
    // `proxy_set_header` inherited by a location without `auth_request`, or a
    // `map` turning an empty value into `|`) authenticated anonymous visitors
    // as that row. Treat it like no headers, matching
    // readTrustedForwardAuthIdentity. Dev keeps its DEFAULT_USER fallback
    // (devDefaultUserFallback).
    // Only reachable for a TRUSTED peer, so the logged value is our proxy's.
    if (!devDefaultUserFallback() && !rawUserHeader && rawGroupHeader) {
        authLogger.warn(
            'Forward-auth: ignored a groups header without a username header — treated as unauthenticated',
            {
                ...headerRejectionContext(
                    event,
                    path,
                    'The reverse proxy set GROUPHEADER without USERHEADER. Set both only on locations behind forward auth, and never synthesize a groups value for a request without a username.',
                ),
                header: config.GROUPHEADER,
                value: rawGroupHeader.slice(0, 120),
            },
        );
        rawGroupHeader = null;
        rawNameHeader = null;
    }

    const hasAuthHeaders = rawUserHeader || rawGroupHeader;

    if (!devDefaultUserFallback() && !hasAuthHeaders) {
        // /api/health is intentionally public so load balancers and Docker health
        // checks can poll without surfacing Authentik. The route serves basic status
        // when locals.user is undefined and gates ?detail=true on isAdmin. Suppresses
        // ~2880 noisy WARN logs/day. Note we deliberately do NOT bypass
        // /api/health/migration — it's admin-only via requireAdmin, so bypassing here
        // would just trade this WARN source for the requireAdmin one downstream.
        if (path === '/api/health' || path === '/api/health/') {
            return undefined;
        }

        // /api/health/ready is the readiness probe and must be reachable by the
        // same anonymous callers for the same reason. It is listed separately
        // rather than by prefix so the admin-only siblings (/migration, /config,
        // /components) keep needing identity — a `startsWith('/api/health')`
        // here would hand all four to unauthenticated callers.
        //
        // Safe to bypass: the route already withholds the per-component `checks`
        // object from anyone who is neither admin nor holds `metrics:read`, so an
        // anonymous caller sees only {status:'pass'|'fail'} and no topology.
        //
        // Without this, wiring a Kubernetes readinessProbe to the route is an
        // outage: the kubelet sends no cookie and no forward-auth headers, falls
        // through to handleMissingAuthHeaders() and gets a 401, so EVERY web pod
        // goes NotReady and the Service loses all its endpoints.
        if (path === '/api/health/ready' || path === '/api/health/ready/') {
            return undefined;
        }

        // === PLUGIN WEBHOOK ingress bypass ===
        // /api/plugin-webhooks/<integrationId> receives webhooks from external
        // systems (an *arr app, a chat platform, a CI job). They hold no session
        // and no forward-auth headers by nature, so this middleware cannot be
        // their gate. Authentication happens in the route: a per-integration
        // shared secret (`webhookSecret`) presented as X-Plugin-Webhook-Secret
        // and compared in constant time, on top of the author's
        // `capabilities.webhook` opt-in. Neither gate open ⇒ 404.
        //
        // SECURITY: scoped to the prefix WITH its trailing slash. The bare
        // collection path and any lookalike sibling (`/api/plugin-webhooks-*`)
        // stay gated, and no identity is materialized here — an inbound webhook
        // is a message, not a user.
        if (path.startsWith('/api/plugin-webhooks/')) {
            return undefined;
        }

        // Bearer exception (P0 fix): admin-scoped PAT/svc tokens must be accepted
        // on /api/admin/* even though this path has no forward-auth headers (the
        // reverse proxy doesn't inject them for Bearer clients). No identity is
        // materialized here — the route's own gate is the primary authority:
        // `mount.ts`'s `enforce()` {kind:'admin'} TERTIARY fallback, the 22
        // total `requireAdmin()`-gated route files (`middleware/auth.ts`;
        // counted at HEAD, matches `resolve-bearer-principal.ts`'s count —
        // 5 of the 22 are under `src/routes/api/admin`), and
        // `mount.ts`'s {kind:'scope'} fallback (`tasks/api-auth.ts`'s
        // `authenticate()`) each resolve the credential via the SAME shared
        // `$lib/server/auth/token-identity.ts` producer this file's OWN
        // /api/v1 PRIMARY authority uses (fix-plan-5 Task 3) — TERTIARY and
        // `requireAdmin()` via `resolve-bearer-principal.ts`'s
        // `resolveBearerAdminPrincipal()`. (Corrected Shape-A comment,
        // security review 5 §9: `handleApiV1Auth` below is a one-line
        // delegation, not a parallel "route-bearer branch" — there never was
        // a second copy of this logic in that function.)
        //
        // Gated on `features.deviceAuth` (fix-plan-5 Task 4, security review
        // 5 §7 item 1): PAT/service-token minting itself requires
        // `FEATURE_DEVICE_AUTH` (`defs/service-tokens/index.ts`,
        // `defs/admin/pats.ts`), so a fresh deployment with the flag off can
        // hold no such token — EXCEPT a self-minted user PAT
        // (`defs/user/tokens.ts`, gated on `FEATURE_USER_PATS` only, not
        // device auth). When the flag is off, THIS exception takes no
        // exception at all: fall through to the same
        // `handleMissingAuthHeaders()` 401 a headerless request to any other
        // internal route gets.
        //
        // This gate covers only the header-only path through THIS file. It
        // does NOT, by itself, cover `requireAdmin()` / `mount.ts` TERTIARY —
        // those reach a Bearer identity through a
        // SEPARATE helper, `resolve-bearer-principal.ts`'s
        // `resolveBearerAdminPrincipal()`, reached from `hooks.server.ts`'s
        // OWN `hasBearer` carve-out (a session-carrying request never even
        // reaches this exception). Fix round 1 (Important 2) found and
        // closed that gap: both `resolveBearerAdminPrincipal()` and the
        // `hooks.server.ts` carve-out now have their OWN `features.deviceAuth`
        // check — read those two sites, not this comment, for their gating.
        // `/metrics` and the `{kind:'scope'}` fallback (`tasks/api-auth.ts`'s
        // `authenticate()`) go through `token-identity.ts` directly, never
        // through `resolveBearerAdminPrincipal()`. `/metrics` genuinely has
        // no `deviceAuth` gate anywhere on its path — it isn't under
        // `/api/admin/`, so the `if` below never touches it, and
        // `token-identity.ts` must not 503 the scrape; that part is
        // deliberately NOT placed inside `token-identity.ts`. The
        // `{kind:'scope'}` fallback on `/api/admin/*` is a DIFFERENT case:
        // it IS killed by THIS SAME `features.deviceAuth` check when the
        // flag is off — the `if` below only returns `undefined` (deferring
        // to the route/mount TERTIARY, where `authenticate()` eventually
        // runs) when `deviceAuth` is true; when it's false this Bearer
        // request falls through to `handleMissingAuthHeaders()`'s 401
        // before `authenticate()` is ever reached, so `authenticate()`
        // needs no gate of its own here. "Correctly not gated" was true
        // only for `/metrics`, not for the `/api/admin` scope-fallback case.
        if (
            features.deviceAuth &&
            path.startsWith('/api/admin/') &&
            !!event.request.headers.get('authorization')?.match(/^bearer[ \t]+\S/i)
        ) {
            return undefined;
        }

        // === PUBLIC SHOWCASE surface bypass ===
        // /showcase* is intentionally unauthenticated when FEATURE_PUBLIC_SHOWCASE is
        // on. The bypass is feature-gated so that disabling the feature instantly
        // closes the public path (switching presets turns FEATURE_PUBLIC_SHOWCASE OFF,
        // which removes the bypass).
        // SECURITY: The bypass is scoped strictly to /showcase* and
        // /api/showcase/* (the public stream-token endpoint). All other paths remain
        // gated.  Edge note (prod): nginx must also have a no-auth_request location
        // for /showcase and must strip x-authentik-* headers on that path to prevent
        // header-forgery elevation (same rule as the /api/v1 edge-auth carve-out).
        if (config.FEATURE_PUBLIC_SHOWCASE) {
            if (
                path === '/showcase' ||
                path.startsWith('/showcase/') ||
                path === '/api/showcase' ||
                path.startsWith('/api/showcase/')
            ) {
                return undefined;
            }
        }

        // === BUILT-IN LOGIN redirect (HTML pages only) ===
        // First-run onboarding is already handled earlier (it fires regardless of
        // headers). Here we only have the steady-state case: an admin exists, the
        // visitor has no session and no forward-auth headers. If ANY built-in
        // sign-in method is enabled — native login or OIDC SSO — send them to the
        // login screen (preserving the requested path); otherwise fall through to
        // the forward-auth "not configured" guidance.
        //
        // OIDC must be *fully* configured (issuer + client id), not merely flagged
        // on: /login bounces visitors straight back when it can render no sign-in
        // control, so redirecting a half-configured OIDC deployment would loop.
        // AUTH_OIDC_LOGIN_AVAILABLE is the shared predicate /login itself uses —
        // the two MUST agree or that ping-pong is exactly what happens.
        //
        // Deliberately does NOT consult `rejectedUntrustedPeer`. When a proxy IS
        // sending identity headers that were discarded as forgeable, users with a
        // working sign-in method still get in through it; the misconfiguration
        // reaches the OPERATOR via the warning logged above plus the
        // proxy.unpinned / proxy.trust-any security self-check findings. Gating
        // this on !rejectedUntrustedPeer would lock every user out of a working
        // login over one mistyped proxy IP, and would serve the config-hint page
        // to anyone who sends a stray identity header. Pinned by the
        // "identity headers rejected as untrusted" tests.
        if (
            isHtmlPageRequest(event, path) &&
            (config.AUTH_NATIVE_LOGIN_ENABLED || config.AUTH_OIDC_LOGIN_AVAILABLE)
        ) {
            const target = `/login?redirect=${encodeURIComponent(event.url.pathname + event.url.search)}`;
            return redirectResponse(target);
        }

        return handleMissingAuthHeaders(event, path, {
            rejectedUntrustedPeer,
            rejectedPlaceholder,
        });
    }

    // Run database migration on startup
    if (!migrationCompleted) {
        const migrationLogger = Logger.for('Migration');
        migrationLogger.info('Triggering automatic database migration on first request...');
        try {
            await ensureDatabaseMigration();
        } catch (error) {
            migrationLogger.error(
                'Failed to complete migration, but continuing startup',
                error as Error,
            );
        }
    }

    // Extract user information from sanitized Authentik headers
    // Normalize username to lowercase for consistent storage/lookup across all tables
    // (Jellyfin preserves case, authentik may not - lowercase ensures no mismatches)
    const username = (rawUserHeader || config.DEFAULT_USER).toLowerCase();
    // Display name for users.display_name. Conditioned on rawUserHeader so the
    // dev-mode DEFAULT_USER (reached with no identity header at all) can never
    // pick up a name off a stray header. sanitizeDisplayName strips bidi
    // overrides, zero-width padding and control characters and bounds the length
    // — this value is IdP-chosen and gets rendered to other users, so it is
    // cleaned here, at the boundary where it enters, not at each read site.
    // An empty result means "no usable name": stays null, and the username
    // fallback in social.queries.ts keeps covering it.
    const displayName =
        rawUserHeader && rawNameHeader ? sanitizeDisplayName(rawNameHeader) || null : null;
    const groupsHeader = rawGroupHeader || '';
    // Use parseList for flexible parsing (supports both comma and pipe separators)
    let userGroups = parseList(groupsHeader);
    // Did the (trusted, unstripped) proxy send the groups header at all? Only
    // then is `userGroups` the IdP's statement — including an EMPTY one, which
    // clears `users.groups`. See the rawGroupHeader read above.
    //
    // FORWARD_AUTH_GROUPS_ALWAYS_SENT (D1, runtime pass 2026-09-26): nginx does
    // not forward an empty header, so behind an nginx `auth_request` edge a user
    // with no IdP groups arrives with NO groups header and the present-empty
    // path above was unreachable — the row kept its admin projection on every
    // token path. When the operator states their proxy always sends the header,
    // its absence on a request whose username header survived every strip above
    // (trusted peer, not showcase, not a placeholder) is that same statement.
    // `userGroups` is already `[]` (parseList('')), and everything below —
    // sync, upsert, `locals.idpGroups` — keys on this one flag.
    const groupsHeaderPresent =
        rawGroupHeader !== null ||
        (rawUserHeader !== null && config.FORWARD_AUTH_GROUPS_ALWAYS_SENT);

    // In dev environment (no headers present), assume admin group for default user
    const isDev = !rawUserHeader && !rawGroupHeader;
    if (isDev && username === config.DEFAULT_USER.toLowerCase()) {
        userGroups = config.ADMIN_GROUPS;
    }

    // Resolve is_admin and maxAgeRating in a single SELECT when both
    // caches are cold (otherwise the cache covers it). One round-trip
    // total on the auth path. Lumastra-first principle: don't pre-fetch
    // Jellyfin-only data here — only `/api/user` (quick-connect) reads
    // jellyfinUserId, so resolving it on every authenticated request
    // (image, for-you, etc.) was wasted Valkey work even when sync is
    // enabled. The /api/user endpoint resolves on demand instead.
    // Group-derived permissions feed resolveDbAuth the OIDC fallbacks (admin /
    // max-age) it uses when the DB has no pin. The pin-aware final permissions are
    // rebuilt below once dbIsAdmin is known.
    const groupPermissions = buildUserPermissions(userGroups);
    const {
        isAdmin: dbIsAdmin,
        adminPinned,
        maxAge: dbMaxAge,
        disabled,
        userId: resolvedUserId,
    } = await resolveDbAuth(username, groupPermissions.ownerIsAdmin, groupPermissions.maxAgeRating);

    // Local kill-switch: a disabled account is denied even with valid forward-auth
    // headers (the disable is a Lumastra-side override on top of the IdP). HTML
    // navigations go to /login; everything else gets a 403. Never sets locals.user.
    if (disabled) {
        authLogger.warn('Forward-auth login blocked: account disabled', { username });
        if (isHtmlPageRequest(event, path)) {
            return redirectResponse('/login?error=account_disabled');
        }
        return new Response(JSON.stringify({ error: 'Account disabled' }), {
            status: 403,
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        });
    }

    // Resolve the stable users.id (the user-data key). Cold-start window: the row
    // may not exist yet — provision synchronously (past first-run). If still
    // unresolvable (first-run pre-admin, or DB down), fail closed rather than
    // build a UserContext with no real identity.
    const userIdStr =
        resolvedUserId ??
        (await resolveOrProvisionUserId(username, dbIsAdmin, dbMaxAge, displayName));
    if (!userIdStr) {
        authLogger.warn('Forward-auth: no resolvable users.id (first-run or DB down)', {
            username,
        });
        if (isHtmlPageRequest(event, path)) {
            // Brand-new install pre-admin → onboarding; otherwise login.
            return redirectResponse('/setup');
        }
        return new Response(JSON.stringify({ error: 'Account not provisioned' }), {
            status: 503,
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        });
    }

    // Merge the in-app access layer (standalone multi-user): augment groups with
    // in-app group names and OR-in their capability map. Best-effort/fail-open.
    const { effectiveGroups, extraCapabilities } = await resolveInAppAccess(userIdStr, userGroups);

    // Rebuild permissions over the effective (merged) group set with the
    // authoritative pin verdict AND the in-app capabilities. FIX (security
    // review 2026-09-23, C6, SSO policy Option A): `dbIsAdmin` is ALWAYS a
    // defined boolean, so passing it as `isAdminOverride` unconditionally
    // used to suppress the in-app OR-term for every UNPINNED account —
    // `buildUserPermissions`'s `isAdminOverride ?? (groups || inApp)` never
    // fell through. `computeOwnerIsAdminOverride(dbIsAdmin, adminPinned)`
    // turns that into the same pin-conditional tri-state
    // `resolve-token-user-access.ts` and `native-session.ts` already use: a
    // pin still wins UNCONDITIONALLY for admin (in either direction — it can
    // elevate or demote), but an unpinned account's in-app `admin`
    // capability now counts here too, closing the "relative over-grant"
    // review 5 §3 C6 names (an in-app admin was already admin on every
    // token-based surface but not in their own browser session). Age uses
    // the most-restrictive (MIN) of the DB ceiling and the in-app cap (a
    // permissive cohort can't raise the ceiling) — admin short-circuits to
    // unrestricted as before.
    const mergedPermissions = buildUserPermissions(effectiveGroups, {
        isAdminOverride: computeOwnerIsAdminOverride(dbIsAdmin, adminPinned),
        extraCapabilities,
    });
    const effectiveMaxAge = mergedPermissions.ownerIsAdmin
        ? null
        : mergeMaxAge(dbMaxAge, mergedPermissions.maxAgeRating);

    // Create user context
    const userContext: UserContext = {
        userId: toUserId(userIdStr),
        username,
        groups:
            isDev && username === config.DEFAULT_USER
                ? config.ADMIN_GROUPS.join('|')
                : effectiveGroups.join('|'),
        userGroups: effectiveGroups,
        ...mergedPermissions,
        // permissions.isAdmin === dbIsAdmin only when PINNED — the override
        // is pin-conditional (C6), so an unpinned account's isAdmin can also
        // come from effectiveGroups or the in-app `admin` capability.
        // Age rating respects the DB pin ceiling AND the in-app MIN merge.
        maxAgeRating: effectiveMaxAge,
        isAgeRestricted: effectiveMaxAge !== null,
    };

    // Add user context to locals for use in API routes
    event.locals.user = userContext;
    event.locals.authMethod = 'forward_auth';
    // The raw header-only projection (pre in-app merge) — security review 6,
    // P2. The only reader is the device-authorize route, which must persist
    // THIS list, not the merged `userContext.userGroups`. Undefined when the
    // groups header was absent — no IdP statement, so nothing to persist;
    // `[]` when it was present and empty — the IdP revoked every group — or
    // absent under FORWARD_AUTH_GROUPS_ALWAYS_SENT (see `groupsHeaderPresent`).
    event.locals.idpGroups = groupsHeaderPresent || isDev ? userGroups : undefined;
    // jellyfinUserId is intentionally NOT pre-resolved here. The only
    // consumer (/api/user quick-connect) imports the resolver lazily.
    // Pre-fetching on every request meant a Valkey roundtrip on every
    // image / for-you / catalog response that never read the value.
    event.locals.jellyfinUserId = undefined;
    // Normalized identity for enforce() — forward-auth (Authentik) path.
    // userContext.isAdmin is `mergedPermissions.isAdmin` from above — the
    // FULL Formula-A verdict (pin-conditional override via
    // computeOwnerIsAdminOverride(dbIsAdmin, adminPinned), OR'd with the
    // in-app `admin` capability when unpinned) — NOT the raw `dbIsAdmin`
    // group/pin projection `resolveDbAuth()` returns. `dbIsAdmin` itself
    // stays the group/pin-only value used for the `upsertUser()` persistence
    // path above (the in-app term must never be written back to
    // `users.is_admin`); this Principal reads the merged verdict instead.
    event.locals.principal = buildPrincipal({
        kind: 'forward_auth',
        userId: userContext.userId,
        username: userContext.username,
        userGroups: userContext.userGroups,
        tokenScopes: [],
        sessionIsAdmin: userContext.ownerIsAdmin,
        ownerIsAdmin: userContext.ownerIsAdmin,
    });

    // Sync user groups to database (smart: async, throttled, only if changed)
    // Skip for: dev mode, an ABSENT groups header (unless
    // FORWARD_AUTH_GROUPS_ALWAYS_SENT reads it as empty), static assets, image
    // proxy, SvelteKit internals. A PRESENT-but-empty header syncs `[]` (its hash is
    // "[]", so the throttle treats it like any other list) and runs the upsert
    // below with a non-admin projection, so an unpinned admin whose IdP groups
    // were all revoked is demoted and has admin-scoped credentials narrowed.
    const pathname = event.url.pathname;
    const shouldSyncGroups =
        !isDev &&
        groupsHeaderPresent &&
        !pathname.startsWith('/_app/') &&
        !pathname.startsWith('/api/image/') &&
        !pathname.startsWith('/api/playback/') && // HLS segments - very frequent
        !STATIC_FILE_REGEX.test(pathname);

    if (shouldSyncGroups) {
        // Fire-and-forget: don't await, don't block the request
        syncUserGroupsIfNeeded(username, userGroups).catch(() => {
            // Silently ignore errors - this is best-effort
        });
        // Upsert user record (fire-and-forget — never blocks the request).
        //
        // FIRST-RUN GUARD: do NOT auto-provision while setup is not complete
        // (no setup lock and no admin yet).
        // Otherwise a background request carrying admin headers (a SvelteKit
        // __data.json prefetch, an API/image call, etc.) — which bypasses the
        // HTML-only /setup redirect — would silently create the first admin and
        // skip the guided onboarding (and its admin-group verification). The
        // first admin must be created explicitly via the /setup wizard
        // (completeForwardAuthSetup); after that, anAdminExists() is cached true
        // and normal auto-provisioning resumes for all users.
        void (async () => {
            try {
                if (!(await anAdminExists())) return;
                const { aiDbService } = await import('$lib/server/services/database.service.js');
                const sql = await aiDbService.getSql();
                if (!sql) return;
                // Persist the IdP/pin-derived projection only — NOT the in-app
                // access merge. In-app capabilities/admin must never be written
                // back into the users.is_admin / groups projection (they live in
                // the separate access-groups tables and merge at read time).
                //
                // C5 FIX (fix plan 6, S-C5a): `isAdmin` used to be `dbIsAdmin`
                // — `resolveDbAuth()`'s return value, which on a WARM L1 cache
                // is the header-groups verdict of an EARLIER request (up to
                // the cache TTL stale, or up to 10 minutes on a sibling
                // replica of a Valkey-less install, where the group sync's
                // cache invalidation is local-only and never published).
                // `groupPermissions.isAdmin` is THIS request's live
                // projection of the CURRENT header groups (computed above,
                // before `resolveDbAuth()` is even called) — using it here
                // means an IdP promotion or demotion lands on THIS request
                // (R1) instead of waiting for the next one that happens to
                // find a cold cache (R2). Not the
                // `adminPinned ? dbIsAdmin : groupPermissions.isAdmin` ternary
                // the review report first suggested: `upsertUser()`'s own SQL
                // `CASE WHEN users.admin_pinned THEN users.is_admin ELSE
                // ${isAdmin} END` (`users.queries.ts`) is ALREADY the only pin
                // guard this write needs — a pinned row ignores the parameter
                // unconditionally, so gating the parameter on the (cached,
                // possibly stale) pin flag can only make things WORSE: if the
                // cached pin says "pinned" but the row is actually unpinned by
                // now, the ternary would write the stale cached `dbIsAdmin`
                // into an unpinned row instead of the live verdict.
                // `groupPermissions`, never `mergedPermissions` (defined
                // earlier, ~:2362, from the SYNCHRONOUS request path above —
                // this write is inside the LATER fire-and-forget IIFE, not
                // "further below"): `mergedPermissions` folds in the in-app
                // `admin` capability, which must never reach this column (the
                // very rule this comment already states) — `groupPermissions`
                // has no in-app term at all.
                //
                // `maxAgeRating` follows the same rule (security review 7, A1):
                // it used to be `dbMaxAge`, which on a warm L1 cache is an
                // EARLIER request's cap. `groupPermissions.maxAgeRating` is
                // this request's header cap; `upsertUser()`'s
                // `CASE WHEN users.age_rating_pinned` keeps a pinned row's
                // column, exactly as the admin pin guard does. No enforcement
                // reader of an unpinned row reads this column except Watch
                // Together's MIN merge (F-I2), which it can only make fresher;
                // unpinned token-path caps come from `users.groups`, the
                // write S-P2 kept on the authorize route.
                const upserted = await upsertUser(sql, {
                    username,
                    isAdmin: groupPermissions.ownerIsAdmin,
                    maxAgeRating: groupPermissions.maxAgeRating,
                    // null when the proxy sends no name header — the query
                    // COALESCEs, so an existing name is never blanked.
                    displayName,
                });
                // Security review 2026-09-16, fix round 1 review, Important
                // 3: this periodic re-sync is the PRIMARY place an unpinned
                // user's admin status changes on an Authentik deployment —
                // narrow/restore admin-scoped PAT/service-token access in
                // lockstep. See syncAdminCredentialsAfterUpsert()'s doc
                // comment (fix round 2: NOT the before/after
                // resolveOwnerAdminStatus() pattern — see that function's
                // doc comment for why this specific call site can't use it).
                await syncAdminCredentialsAfterUpsert(sql, upserted, username);
                // Ensure user_profiles row exists so FK-dependent tables
                // (watchlist, ratings, etc.) don't hit constraint errors.
                // user_profiles.user_id is the users.id UUID (mig 16.46.0).
                await ensureUserProfileExists(sql, toUserId(userIdStr));
            } catch {
                // Best-effort, never block auth
            }
        })();
    }

    return undefined; // Continue to resolve
}

// =============================================================================
// MISSING AUTH HEADERS RESPONSE
// =============================================================================

/**
 * The single fixed rejection shown to every non-operator caller. It must stay
 * identical across every configuration and every rejection reason — that
 * invariance is the whole point, and is pinned by
 * forward-auth-unauth-fingerprint.test.ts.
 */
const GENERIC_UNAUTH_MESSAGE = 'Sign in to continue.';

// OPERATOR-ONLY (gated by isOperatorProximate): `/login` is public and already
// shows which built-in sign-in methods are enabled, so naming them here is not
// itself a new oracle — this text is still gated to a direct caller on
// loopback / the LAN (and never a peer in TRUSTED_PROXY_IPS, a known proxy)
// so the unauthenticated rejection doesn't become a SECOND place to confirm
// the same thing without ever reaching /login.
//
// The API-route equivalent of the "BUILT-IN LOGIN redirect" HTML branch above
// (there's no redirect for an API caller, so this only affects the message
// text): when native login or a fully-configured OIDC is available, a caller
// hitting this path simply has no active session — direct them to sign in
// instead of blaming a forward-auth proxy that may not even be part of this
// deployment. Falls back to the original forward-auth guidance only when
// neither built-in method actually works, matching AUTH_OIDC_LOGIN_AVAILABLE's
// "fully configured, not merely flagged on" rule so the message never claims a
// half-configured OIDC setup is usable.
function noAuthHeadersMessage(): string {
    if (config.AUTH_NATIVE_LOGIN_ENABLED || config.AUTH_OIDC_LOGIN_AVAILABLE) {
        return 'No active session. Sign in at /login.';
    }
    return 'No authentication headers present. Lumastra requires a forward-auth reverse proxy (e.g. Authentik) that sets the configured USERHEADER/GROUPHEADER, with FORWARD_AUTH_ENABLED=true. See https://lumastra.org/guides/authentication/.';
}

function handleMissingAuthHeaders(
    event: RequestEvent,
    path: string,
    opts?: { rejectedUntrustedPeer?: boolean; rejectedPlaceholder?: boolean },
): Response {
    // We reach here when a request arrives with no usable identity headers.
    // Two distinct situations:
    //   (a) A real forward-auth deployment whose IdP session expired (the
    //       cookie lingers but the proxy stopped injecting headers) — a single
    //       reload re-triggers the IdP login.
    //   (b) A misconfigured/first-run deploy: no proxy in front at all, OR a
    //       proxy IS sending headers but they were rejected because the peer
    //       isn't trusted (TRUSTED_PROXY_IPS unset / wrong). Reloading here
    //       loops forever — so the HTML branch reloads at most ONCE, then shows
    //       a self-documenting setup page instead of looping.
    const rejectedUntrustedPeer = opts?.rejectedUntrustedPeer === true;
    // The proxy IS reachable and IS sending the header — it just forwarded its own
    // unexpanded template. That is a completely different fix from both "no proxy"
    // and "untrusted peer", so it gets its own guidance rather than the generic list.
    // Mutually exclusive with rejectedUntrustedPeer by construction: the caller's
    // peer-trust gate runs first and discards the headers, so an untrusted peer can
    // never also be diagnosed as a placeholder misconfiguration.
    const rejectedPlaceholder = opts?.rejectedPlaceholder === true;
    const posture = forwardAuthTrustPosture();
    // Every branch below picks between operator guidance and one fixed generic
    // response. The diagnostics still reach the operator unconditionally through
    // the warn() calls — only what is written back to the CALLER is gated.
    const operatorProximate = isOperatorProximate(event);

    // For API routes, return 401
    if (path.startsWith('/api/')) {
        // An ordinary missing-session request (no identity headers at all) is
        // routine: a stale tab or an expired session polling a data endpoint. Only a
        // rejected untrusted peer / placeholder is an operator misconfiguration
        // worth a WARN.
        const missingAuthLog = rejectedUntrustedPeer || rejectedPlaceholder ? 'warn' : 'debug';
        authLogger[missingAuthLog]('API request without authentication headers', {
            path,
            rejectedUntrustedPeer,
            rejectedPlaceholder,
            posture,
        });

        // For WebVTT requests (subtitle files), return empty valid WebVTT
        // This prevents AVPlayer from trying to parse JSON error as WebVTT
        // which would cause error -12783 (AVErrorMalformedDocument)
        if (path.endsWith('.vtt')) {
            authLogger.debug('Returning empty WebVTT for unauthenticated subtitle request', {
                path,
            });
            return new Response('WEBVTT\n\n', {
                status: 401,
                headers: {
                    'Content-Type': 'text/vtt',
                    'X-Auth-Required': 'true',
                    'Access-Control-Allow-Origin': '*',
                },
            });
        }

        return new Response(
            JSON.stringify({
                error: 'Authentication required',
                message: !operatorProximate
                    ? GENERIC_UNAUTH_MESSAGE
                    : rejectedUntrustedPeer
                      ? 'Forward-auth identity headers were received but rejected because the TCP peer is not trusted. Set TRUSTED_PROXY_IPS to your reverse-proxy IP(s), or LUMASTRA_TRUST_ANY_PROXY=true for a single-host deployment, together with FORWARD_AUTH_ENABLED=true.'
                      : rejectedPlaceholder
                        ? 'The reverse proxy forwarded a literal, unexpanded header template instead of a username. Fix the proxy header mapping so it sends the real value.'
                        : noAuthHeadersMessage(),
            }),
            {
                status: 401,
                headers: {
                    'Content-Type': 'application/json',
                    'X-Auth-Required': 'true',
                },
            },
        );
    }

    // For HTML pages: reload at most ONCE to re-trigger an expired IdP session,
    // then — if we still land here — show a self-documenting setup page instead
    // of an infinite reload loop (the failure mode a bare `docker run` hits).
    authLogger.warn('HTML request without authentication headers', {
        path,
        rejectedUntrustedPeer,
        rejectedPlaceholder,
        posture,
    });

    // An operator who set AUTH_OIDC_ENABLED=true but left the issuer / client id
    // empty lands here rather than on /login (which can render no sign-in control
    // and would bounce straight back). Name the missing keys instead of repeating
    // the generic three-methods list — "but I DID enable OIDC" is otherwise a
    // dead end.
    const oidcHalfConfigured =
        config.AUTH_OIDC_ENABLED &&
        (config.AUTH_OIDC_ISSUER.length === 0 || config.AUTH_OIDC_CLIENT_ID.length === 0);
    const missingOidcKeys = [
        config.AUTH_OIDC_ISSUER.length === 0 ? 'AUTH_OIDC_ISSUER' : null,
        config.AUTH_OIDC_CLIENT_ID.length === 0 ? 'AUTH_OIDC_CLIENT_ID' : null,
    ].filter((k): k is string => k !== null);

    // Tailor the guidance: headers-rejected-as-untrusted vs half-configured OIDC
    // vs no-proxy-at-all.
    const setupHtml = !operatorProximate
        ? `<p>${GENERIC_UNAUTH_MESSAGE}</p>`
        : rejectedPlaceholder
          ? `<p>Lumastra received a forward-auth username header, but <strong>its value was a literal, unexpanded header template</strong> (a string containing <code>{…}</code>) rather than a username &mdash; so it was discarded instead of creating a junk account.</p>
           <p>Your reverse proxy is forwarding its own placeholder syntax. Fix the header mapping where you set the header named by <code>USERHEADER</code>:</p>
           <ul>
             <li>Caddy: <code>header_up</code> inside <code>reverse_proxy</code>, with the variable spelled exactly as your auth module documents it.</li>
             <li>nginx: <code>proxy_set_header</code> using a variable that <code>auth_request_set</code> actually populated.</li>
             <li>Traefik / Authentik: list the header in <code>authResponseHeaders</code> so the middleware copies it through.</li>
           </ul>
           <p>Check the server log for <code>discarded unexpanded reverse-proxy username placeholder</code> &mdash; it records the peer, the header name and the literal value that arrived.</p>`
          : rejectedUntrustedPeer
            ? `<p>Lumastra received forward-auth identity headers, but <strong>rejected them because the request's network peer isn't trusted</strong> — a safety measure against header forgery.</p>
           <p>Fix it by telling Lumastra which proxy may set identity headers:</p>
           <ul>
             <li>Set <code>TRUSTED_PROXY_IPS</code> to your reverse-proxy's IP address(es) or CIDR(s), <em>or</em></li>
             <li>For a single-host / private deployment, set <code>LUMASTRA_TRUST_ANY_PROXY=true</code>.</li>
           </ul>
           <p>Forward auth must also be turned on with <code>FORWARD_AUTH_ENABLED=true</code>.</p>`
            : oidcHalfConfigured
              ? `<p><strong><code>AUTH_OIDC_ENABLED</code> is set, but the OIDC provider is incomplete</strong>, so Lumastra can't offer a sign-in button yet.</p>
           <p>Still missing: ${missingOidcKeys.map((k) => `<code>${k}</code>`).join(' and ')}.</p>
           <p>Set ${missingOidcKeys.length > 1 ? 'both' : 'it'} to your identity provider's values — e.g. <code>AUTH_OIDC_ISSUER=https://idp.example.com/application/o/lumastra/</code> (discovery appends <code>/.well-known/openid-configuration</code>) and the client id you registered for Lumastra — then restart the container. A “Sign in with …” button then appears on <code>/login</code>.</p>
           <p>Confidential clients also need <code>AUTH_OIDC_CLIENT_SECRET</code>; public (PKCE-only) clients may leave it empty. To become an admin, your provider must place your user in a group named in <code>ADMIN_GROUPS</code> (default <code>admin</code>).</p>`
              : `<p>Lumastra didn't receive any authentication headers, and no built-in sign-in method is enabled yet. Lumastra supports three sign-in methods — pick whichever fits your setup:</p>
           <ul>
             <li><strong>Built-in login</strong> (username / password): the quickest start. Enable <code>AUTH_NATIVE_LOGIN_ENABLED</code> (set automatically when you create the first admin via the setup wizard) to get a <code>/login</code> page.</li>
             <li><strong>OIDC single sign-on</strong> (recommended for teams): set <code>AUTH_OIDC_ENABLED</code> + <code>AUTH_OIDC_ISSUER</code> + <code>AUTH_OIDC_CLIENT_ID</code> to sign in through Authentik / Keycloak / Entra / Okta. A “Sign in with …” button then appears on <code>/login</code>.</li>
             <li><strong>Forward auth</strong> (reverse-proxy headers): put a proxy (e.g. Authentik, Authelia) in front that sets the configured <code>USERHEADER</code> / <code>GROUPHEADER</code>, set <code>FORWARD_AUTH_ENABLED=true</code>, and pin the proxy with <code>TRUSTED_PROXY_IPS</code> (or <code>LUMASTRA_TRUST_ANY_PROXY=true</code> for a single host).</li>
           </ul>
           <p>To become an admin, your identity provider (or the first-run wizard) must place your user in a group named in <code>ADMIN_GROUPS</code> (default <code>admin</code>).</p>`;

    return new Response(
        `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${operatorProximate ? 'Lumastra — Authentication not configured' : 'Sign in required'}</title>
	<meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate">
	<style>
		:root { color-scheme: dark; }
		body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:#0b0f17; color:#e5e9f0; margin:0; display:flex; min-height:100vh; align-items:center; justify-content:center; padding:1.5rem; }
		.card { max-width: 640px; background:#131a26; border:1px solid #243044; border-radius:14px; padding:2rem 2.25rem; box-shadow:0 10px 40px rgba(0,0,0,.4); }
		h1 { font-size:1.35rem; margin:.2rem 0 1rem; }
		p { line-height:1.55; }
		code { background:#0b1220; border:1px solid #243044; border-radius:5px; padding:1px 6px; font-size:.9em; }
		ul { line-height:1.7; }
		a { color:#7aa2f7; }
		.muted { color:#94a3b8; font-size:.9rem; margin-top:1.25rem; }
		button { margin-top:1.25rem; background:#2952cc; color:#fff; border:0; border-radius:8px; padding:.6rem 1.1rem; font-size:.95rem; cursor:pointer; }
		.hidden { display:none; }
	</style>
</head>
<body>
	<div class="card">
		<div id="checking">
			<h1>Checking your session…</h1>
			<p class="muted">If this doesn't clear in a moment, setup instructions will appear.</p>
		</div>
		<div id="help" class="hidden">
			<h1>${operatorProximate ? "Lumastra is running — but authentication isn't set up" : 'Sign in required'}</h1>
			${setupHtml}
			${
                operatorProximate
                    ? '<p class="muted">Full guide: <a href="https://lumastra.org/guides/configuration/">lumastra.org/guides/configuration</a>. After changing environment variables, restart the container.</p>'
                    : ''
            }
			<button onclick="retry()">Try again</button>
		</div>
	</div>
	<script>
		var KEY = 'auth-reload-ts';
		function showHelp() {
			document.getElementById('checking').classList.add('hidden');
			document.getElementById('help').classList.remove('hidden');
		}
		function retry() {
			try { sessionStorage.removeItem(KEY); } catch (e) {}
			location.href = location.origin + location.pathname;
		}
		(function () {
			var now = Date.now();
			var last = 0;
			try { last = parseInt(sessionStorage.getItem(KEY) || '0', 10) || 0; } catch (e) {}
			// If we already reloaded within the last 12s and are still here, auth
			// is genuinely not working — stop looping and show guidance.
			if (now - last < 12000) {
				try { sessionStorage.removeItem(KEY); } catch (e) {}
				showHelp();
				return;
			}
			// First attempt (or a long-ago one): clear cookies and reload ONCE so
			// an expired IdP session gets a chance to re-authenticate.
			try { sessionStorage.setItem(KEY, String(now)); } catch (e) {}
			document.cookie.split(';').forEach(function (c) {
				document.cookie = c.replace(/^ +/, '').replace(/=.*/, '=;expires=' + new Date().toUTCString() + ';path=/');
			});
			location.href = location.origin + location.pathname;
		})();
	</script>
</body>
</html>`,
        {
            status: 200,
            headers: {
                'Content-Type': 'text/html',
                'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
                Pragma: 'no-cache',
                Expires: '0',
            },
        },
    );
}

// =============================================================================
// OAUTH ROUTES
// =============================================================================

function handleOAuthRoute(): Response | undefined {
    if (!features.deviceAuth) {
        return json(
            {
                error: 'unsupported_grant_type',
                error_description: 'Device authorization is not enabled',
            },
            { status: 400 },
        ) as Response;
    }
    return undefined; // Continue to resolve (no auth needed)
}

/**
 * /oauth/links/* (account-linking callbacks): who is linking, read-only.
 *
 * The provider redirects the user's browser here; the handler needs only the
 * user's id and name to bind the link (and checks the `state` it stored for
 * that user). Sources, in order:
 *  - a native/OIDC session cookie (populateSessionUser, the full identity);
 *  - trusted forward-auth headers (FORWARD_AUTH_ENABLED, TRUSTED_PROXY_IPS:
 *    readTrustedForwardAuthIdentity) naming a user that ALREADY exists and is
 *    neither disabled nor deleted.
 * The header path deliberately does NOT run handleForwardAuth: no user
 * provisioning, no group sync, no admin promotion. /oauth/ used to ignore
 * identity headers entirely, so a self-run proxy whose /oauth/ bypass forgets
 * to strip them must not become a way to create users or rewrite their
 * groups. The resulting `locals.user` is link-only: no permissions, no admin,
 * age-restricted, and no principal, so nothing else can treat it as a login.
 *
 * Not gated on `features.deviceAuth` (linking has nothing to do with the
 * device flow). Only a request SvelteKit routed to an /oauth/links/ route is
 * considered; any other /oauth/links/ path is served by the public
 * `/oauth/[...path]` catch-all (or by nothing). Never answers itself: without
 * an identity the handler redirects to its "linking failed" page.
 */
async function handleOAuthLinkRoute(event: RequestEvent, path: string): Promise<undefined> {
    if (!event.route?.id?.startsWith('/oauth/links/')) return undefined;
    try {
        if (await populateSessionUser(event)) return undefined;

        const identity = readTrustedForwardAuthIdentity(event);
        if (!identity) return undefined;
        const { aiDbService } = await import('$lib/server/services/database.service.js');
        const sql = await aiDbService.getSql();
        if (!sql) return undefined;
        const row = await getUserByUsername(sql, identity.username);
        if (!row || row.disabled_at || row.deleted_at) return undefined;

        event.locals.user = {
            userId: toUserId(row.id),
            username: row.username,
            groups: '',
            userGroups: [],
            hasWatchPermission: false,
            hasLiveTvPermission: false,
            hasRequestPermission: false,
            hasReviewPermission: false,
            hasMediaAnnotationPermission: false,
            ownerIsAdmin: false,
            maxAgeRating: 0,
            isAgeRestricted: true,
            isModerator: false,
            liveTvPriority: 'low',
        };
        event.locals.authMethod = 'forward_auth';
    } catch (error) {
        // The provider sent the browser here; it must land on the "linking
        // failed" page, not a sanitized 404.
        authLogger.error('Account-linking callback: identity lookup failed', error as Error, {
            path,
        });
        const locals = event.locals as Partial<App.Locals>;
        locals.user = undefined;
        locals.principal = undefined;
        locals.authMethod = undefined;
    }
    return undefined;
}

// =============================================================================
// /api/v1/* AUTH
// =============================================================================

/**
 * Auth for the unified `/api/v1/*` surface — a bearer-only token surface.
 *
 * `/api/v1` is the public API and an *unauthenticated* edge bypass: the reverse
 * proxy does not run Authentik on it, so client-supplied `x-authentik-*`
 * forward-auth headers are attacker-controlled and are NEVER consulted here.
 * Identity comes only from a Bearer credential (PAT `pat_` / service token
 * `svc_` / device-flow JWT) or one of the credential-in-URL streaming bypasses
 * (`grant` query param, entity-image `?sig=` HMAC) — all
 * validated inside `handlePublicApiAuth`. The browser admin/ops UI does NOT use
 * this surface; it calls the cookie/forward-auth `/api/*` mirror instead.
 *
 * The app-layer backstop in hooks.server.ts rejects anything that exits without
 * an established identity AND isn't a recognized credential-in-URL bypass.
 */
async function handleApiV1Auth(event: RequestEvent, path: string): Promise<Response | undefined> {
    // Full token auth (Bearer PAT/svc/JWT) plus the HMAC/query-token streaming
    // bypasses (entity-image ?sig=, grant) are all handled
    // inside handlePublicApiAuth.
    return handlePublicApiAuth(event, path);
}

// =============================================================================
// MAIN EXPORT: resolveAuth
// =============================================================================

/**
 * Resolve authentication for an incoming request.
 *
 * @returns A Response if the request should be short-circuited (error or passthrough),
 *          or undefined if auth was resolved and event.locals was populated.
 */
async function resolveAuthInner(
    event: RequestEvent,
    ensureDatabaseMigration: () => Promise<void>,
    migrationCompleted: boolean,
): Promise<Response | undefined> {
    // The ROUTED path, not event.url.pathname: `/de/api/v1/…` and `/api/%76%31/…`
    // run the /api/v1 handlers, and classifying them on the raw path sent them
    // through the forward-auth branch below (see routed-pathname.ts).
    const path = routedPathname(event.url);

    // === /j/* ROUTES: Jellyfin client compatibility (self-authenticated) ===
    if (path.startsWith('/j/')) {
        // Gate the entire /j surface on the compat feature flag (default ON).
        // When an operator disables Jellyfin compatibility, the routes must not
        // be reachable at all — return a clean 404 (no auth challenge) before
        // the self-authenticating pass-through. Lumastra's own frontend never
        // calls /j (it uses /api), so this only affects external Jellyfin clients.
        if (!config.FEATURE_JELLYFIN_COMPAT) {
            return new Response('Not Found', { status: 404 });
        }
        return undefined; // Pass through to resolve
    }

    // === /subsonic/* ROUTES: OpenSubsonic client compatibility (self-authenticated) ===
    // Subsonic clients carry credentials as query params (u/p/t/s) on every request.
    // The dispatcher validates them via parseSubsonicAuth — no Authentik session needed.
    if (path === '/subsonic' || path.startsWith('/subsonic/')) {
        // Central kill-switch, symmetric with /j above: when Subsonic compat is
        // disabled (default OFF — it's opt-in) the whole surface must be
        // unreachable, as a fail-closed backstop independent of each route's own
        // flag check. Prevents a future /subsonic route that forgets the check
        // from being reachable while the feature is off. (The dispatcher still
        // returns a Subsonic-format "not enabled" envelope when it IS reached —
        // e.g. via a direct handler call in tests — so nothing regresses.)
        if (!config.FEATURE_SUBSONIC_COMPAT) {
            return new Response('Not Found', { status: 404 });
        }
        return undefined; // Pass through to resolve
    }

    // === /oauth/links/* ROUTES: account-linking callbacks (browser identity) ===
    // The provider redirects the user's BROWSER here, and the handler binds the
    // link to `locals.user`. The public device-flow branch below never loaded an
    // identity, so these callbacks always answered `?<provider>_link=error`.
    // See handleOAuthLinkRoute: session cookie, or trusted forward-auth headers
    // of an existing user, resolved without any write.
    if (path.startsWith('/oauth/links/')) {
        return handleOAuthLinkRoute(event, path);
    }

    // === /oauth/* ROUTES: Public device flow (token-only, no browser identity) ===
    if (path === '/oauth' || path.startsWith('/oauth/')) {
        return handleOAuthRoute();
    }

    if (path.startsWith('/api/') && path !== '/api/v1' && !path.startsWith('/api/v1/')) {
        const grant = event.url.searchParams.get('grant');
        if (grant) return handleStreamToken(event, path, grant);
        if (/^bearer\s+\S/i.test(event.request.headers.get('Authorization') ?? '')) {
            // Classifying a path needs no grant store or database dependencies.
            const { resolvePlaybackGrantRoute } =
                await import('$lib/server/services/playback-grant-routes.js');
            const routedUrl = new URL(event.url);
            routedUrl.pathname = path;
            if (await resolvePlaybackGrantRoute(routedUrl)) return handlePublicApiAuth(event, path);
        }
    }

    // Exact routed endpoint only: discovery must survive stale credentials.
    // No proxy identity headers or URL-carried streaming credentials are accepted.
    if (
        event.route?.id === '/api/v1/server' &&
        (event.request.method === 'GET' || event.request.method === 'HEAD')
    ) {
        if (!migrationCompleted) await ensureDatabaseMigration();
        const { resolveOptionalServerCredential } = await import('./server-bootstrap-auth.js');
        return resolveOptionalServerCredential(event, {
            bearer: (request) => handlePublicApiAuth(request, '/api/v1/server', true),
        });
    }

    // === /api/v1/* ROUTES: the unified bearer-only token surface ===
    // /api/v1 is the public API: a bearer-only (PAT/svc/JWT) token surface plus
    // the credential-in-URL streaming bypasses (grant/?sig=). It
    // is an unauthenticated edge bypass, so forward-auth headers are never
    // trusted here. The browser admin/ops UI uses the cookie/forward-auth /api/*
    // mirror instead. See handleApiV1Auth.
    if (path === '/api/v1' || path.startsWith('/api/v1/')) {
        return handleApiV1Auth(event, path);
    }

    // === /metrics: Prometheus exposition — self-gated by the route ===
    // The route (src/routes/metrics/+server.ts) fails closed on its own: it
    // serves only for LUMASTRA_METRICS_PUBLIC, a static LUMASTRA_METRICS_BEARER_
    // TOKEN, or a PAT/svc token (or admin session) with `metrics:read` scope,
    // else 401. Without this case it would fall into the generic branch and,
    // because a Prometheus scrape's Accept isn't HTML-specific but also isn't
    // /api/*, get redirected to /login — making its own auth logic dead code and
    // breaking the zero-DB bootstrap + opt-in-public scrape paths. Populate the
    // session principal (so an admin cookie session satisfies the scope path)
    // then pass through; the route enforces. Token-only callers are handled by
    // the route's enforce() → authenticate() fallback, so no header trust here.
    if (path === '/metrics') {
        await populateSessionUser(event);
        return undefined;
    }

    // === NATIVE AUTH PUBLIC SURFACE: /login, /setup, /api/auth/{login,setup,logout} ===
    // Reachable WITHOUT forward-auth headers or an existing session. We still
    // populate locals.user from a session cookie if present (so an already-logged-in
    // user hitting /login can be redirected away, and so logout can read identity),
    // then let the route render/handle. These do their own first-run / auth gating.
    if (isPluginAuthPublicPath(path)) {
        return undefined;
    }
    if (isNativeAuthPublicPath(path)) {
        // On a fresh boot the HTTP server accepts requests before migrations
        // finish, and /setup (then /login) are the very FIRST pages a fresh
        // install hits. Their route loads query `users`/`user_sessions` directly
        // (adminExists, session validation) with no error tolerance, so a request
        // landing in the ~1s migration window 500s with "relation does not exist".
        // Unlike the forward-auth path (whose anAdminExists() swallows DB errors),
        // these need the schema present — so block on migration here. ensureDatabase-
        // Migration() short-circuits once complete, so this is a no-op after boot.
        if (!migrationCompleted) {
            try {
                await ensureDatabaseMigration();
            } catch (error) {
                if (isDependencyError(error)) throw new AuthDependencyUnavailableError(error);
                throw error;
            }
        }
        await populateSessionUser(event);
        return undefined;
    }

    // === UNROUTED PATHS: never provision, write or authenticate ===
    // Defence-in-depth (security runtime pass 2026-09-26). A path that matches
    // no SvelteKit route gets a 404 regardless; running the forward-auth header
    // path on it buys nothing except the fire-and-forget `upsertUser` /
    // `syncUserGroups` write below. That write turns any edge location which
    // forwards `x-authentik-*` on an unrouted path without an `auth_request`
    // (a stale `location /ws` / `location /public-api/` with no header strip)
    // into a DB-write primitive: an unauthenticated client forges
    // `x-authentik-username` + an admin `x-authentik-groups`, the app
    // creates/updates that user as admin, THEN SvelteKit returns 404 — measured
    // reachable through the real edge on preprod. The edge is the primary fix
    // (strip the headers / drop the stale location); this closes the app side
    // so an unrouted path can never be that primitive even if an edge location
    // leaks. `event.route.id` is null exactly when no route matched (SvelteKit
    // populates it in `handle` for every routed request — the metrics hook
    // already relies on it). Falling through here renders the 404 with no
    // identity and no write. Fail-closed: a manipulated route.id can only WITHHOLD
    // identity on a real route, never grant it on an unrouted one. dev keeps its
    // DEFAULT_USER page fallback (an unrouted dev 404 needs no identity either;
    // see devDefaultUserFallback).
    if (!devDefaultUserFallback() && event.route?.id == null) {
        return undefined;
    }

    // === ALL OTHER ROUTES: Forward Auth (now session-cookie aware) ===
    return handleForwardAuth(event, path, ensureDatabaseMigration, migrationCompleted);
}

/**
 * Media admin capability of a stream token: the minting principal had real
 * admin capability AND the owner is still an admin now.
 */
export function streamTokenMediaAdmin(
    session: { mintedByAdmin?: boolean },
    ownerIsAdminNow: boolean,
): boolean {
    return session.mintedByAdmin === true && ownerIsAdminNow;
}

/** Carry the credential's admin capability to helpers that receive only UserContext. */
export async function resolveAuth(
    event: RequestEvent,
    ensureDatabaseMigration: () => Promise<void>,
    migrationCompleted: boolean,
): Promise<Response | undefined> {
    const path = routedPathname(event.url);
    // Native logout revokes the original cookie and clears it in its own handler.
    // It needs neither a validated identity nor a startup schema check.
    if (event.request.method === 'POST' && path === '/api/auth/native/logout') return undefined;
    let response: Response | undefined;
    try {
        response = await resolveAuthInner(event, ensureDatabaseMigration, migrationCompleted);
    } catch (error) {
        if (!(error instanceof AuthDependencyUnavailableError)) throw error;
        if (routedPathname(event.url) === '/login') return undefined;
        response = authUnavailableResponse({ beforeHandler: true });
    }
    if (response && event.route?.id === '/api/v1/oauth/device/approve') {
        const { auditDeviceApprovalFailure } =
            await import('$lib/server/oauth/device-approval-audit.js');
        await auditDeviceApprovalFailure(event, response);
    }
    if (event.locals.user && event.locals.principal) {
        // A stream token's principal is never admin; its media capability comes
        // from the validated session's mint-time flag and the owner's live
        // admin flag (handleStreamToken set user.isAdmin from the DB), never
        // from a field some earlier code may have copied.
        const session = event.locals.streamingSession;
        const streamTokenMedia =
            event.locals.authMethod === 'stream_token' &&
            session !== undefined &&
            // eslint-disable-next-line callback-safety/no-locals-user-is-admin -- a stream token's grant also needs the owner to still be admin (set from the DB in handleStreamToken)
            streamTokenMediaAdmin(session, event.locals.user.ownerIsAdmin === true);
        event.locals.user.mediaAccessIsAdmin = event.locals.principal.isAdmin || streamTokenMedia;
    }
    if (!response)
        await applyLiveTvUserPolicy(event.locals.user, {
            syntheticIdentity: isSyntheticLiveTvIdentity(event.locals.principal),
            routeId: event.route.id,
            continuation:
                event.locals.authMethod === 'stream_token' && isLiveTvRouteId(event.route.id),
        });
    return response;
}
