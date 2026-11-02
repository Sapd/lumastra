// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media Access Middleware
 *
 * Combines library-group access and age-rating gate into a single composition.
 * Routes that already use `withLibraryAccess` should migrate to `withMediaAccess`
 * to pick up the age gate for free.
 *
 * ## Composition Patterns
 *
 * **Pattern A — Auth-gated playback routes:**
 * ```
 * requireAuth(withIdResolution(withMediaAccess(withErrorHandler(handler))))
 * ```
 *
 * **Pattern B — Inline helper (Jellyfin compat / watch-together routes):**
 * ```
 * const allowed = await checkMediaAccess(sql, internalId, user);
 * if (!allowed) return ApiResponses.notFound('Media');
 * ```
 *
 * The invariant: `withIdResolution` → `withMediaAccess` → handler (in that nesting order).
 *
 * ## Age gate behaviour
 *
 * - Unrestricted users (isAgeRestricted === false) always pass through.
 * - Admin-capable credentials pass through even when the DB is unavailable.
 * - Returns 404 (not 403) to avoid revealing that the item exists but is restricted.
 * - Access-check DB errors fail closed for credentials without admin capability.
 */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import type { Sql } from 'postgres';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { getDb } from '$lib/server/database/index.js';
import { Logger } from '$lib/server/utils/logger';
import { config } from '$lib/server/config.js';
import {
    getDeniedLibraryGroups,
    isMediaAccessible,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache.js';
import { publishMessage, subscribeToChannel } from '$lib/server/cache/valkey.js';
import type { UserContext } from '$lib/server/types';
import { buildLibraryAccessFilter } from '$lib/server/database/queries/builders/library-access.builder.js';
import {
    buildSeriesOwnedAgeRatingFilter,
    effectiveAgeRatingExpression,
} from '$lib/server/database/queries/builders/age-rating.builder.js';
import { withLibraryAccess } from './library-access.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';

const logger = Logger.for('AgeGate');

const AGE_CACHE_INVALIDATE_CHANNEL = 'media:age-cache:invalidate';

// ---------------------------------------------------------------------------
// L1 in-process age-rating cache
// ---------------------------------------------------------------------------

const AGE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const AGE_CACHE_MAX_SIZE = 1000;

const ageRatingCache = new Map<string, { value: number | null; expiresAt: number }>();

/** Return cached age_rating (undefined = cache miss, null = cached null). */
function getCachedAgeRating(mediaId: string): number | null | undefined {
    const entry = ageRatingCache.get(mediaId);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
        ageRatingCache.delete(mediaId);
        return undefined;
    }
    return entry.value;
}

function setCachedAgeRating(mediaId: string, value: number | null): void {
    if (ageRatingCache.size >= AGE_CACHE_MAX_SIZE) {
        // Evict the oldest entry (Map insertion-order = LRU-friendly)
        const firstKey = ageRatingCache.keys().next().value;
        if (firstKey !== undefined) {
            ageRatingCache.delete(firstKey);
        }
    }
    ageRatingCache.set(mediaId, {
        value,
        expiresAt: Date.now() + AGE_CACHE_TTL_MS,
    });
}

/**
 * Item id -> id of the row whose `age_rating` applies to it (the series for a
 * season or episode, else the item itself). Ratings are cached under the
 * OWNER id, so `invalidateMediaAgeCache(seriesId)` after a series' rating
 * changes also reaches every episode resolved through it. The mapping itself
 * only changes if an episode is re-parented, so it shares the rating TTL.
 */
const ageOwnerCache = new Map<
    string,
    { ownerId: string; isAudiobook: boolean; expiresAt: number }
>();

function getCachedAgeOwner(mediaId: string): string | undefined {
    const entry = ageOwnerCache.get(mediaId);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
        ageOwnerCache.delete(mediaId);
        return undefined;
    }
    return entry.ownerId;
}

function setCachedAgeOwner(mediaId: string, ownerId: string, isAudiobook: boolean): void {
    if (ageOwnerCache.size >= AGE_CACHE_MAX_SIZE) {
        const firstKey = ageOwnerCache.keys().next().value;
        if (firstKey !== undefined) {
            ageOwnerCache.delete(firstKey);
        }
    }
    ageOwnerCache.set(mediaId, { ownerId, isAudiobook, expiresAt: Date.now() + AGE_CACHE_TTL_MS });
}

/** Drop the local L1 entry only — no cross-replica fan-out. */
function invalidateMediaAgeCacheLocal(mediaId: string): void {
    if (mediaId === '*') {
        ageRatingCache.clear();
        ageOwnerCache.clear();
        return;
    }
    ageRatingCache.delete(mediaId);
    ageOwnerCache.delete(mediaId);
}

/**
 * Invalidate the cached age_rating for a media item across ALL replicas.
 * Call this wherever `age_rating` is written to `media_items`.
 *
 * Drops the entry locally (immediate, no pub/sub latency) and broadcasts to
 * sibling replicas via Valkey pub/sub. Without the broadcast, a replica that
 * never saw the write would keep enforcing the stale age rating for up to the
 * 5-minute TTL — a parental-controls correctness gap behind a load balancer.
 */
export function invalidateMediaAgeCache(mediaId: string): void {
    invalidateMediaAgeCacheLocal(mediaId);

    // publishMessage resolves false (not rejects) when Valkey is down, so check
    // the boolean — a bare .catch would never fire and the failure would be silent.
    publishMessage(AGE_CACHE_INVALIDATE_CHANNEL, mediaId)
        .then((delivered) => {
            if (!delivered) {
                logger.warn(
                    'Failed to broadcast age-cache invalidation — other replicas may serve a stale age rating',
                    { mediaId },
                );
            }
        })
        .catch(() => {
            /* publishMessage swallows its own errors; defensive only */
        });
}

// Receive invalidations from sibling replicas. Local-only drop so we never
// re-broadcast (which would loop). Runs once at module init; logs if Valkey
// is unavailable (cross-replica invalidation then degrades to TTL expiry).
void subscribeToChannel(AGE_CACHE_INVALIDATE_CHANNEL, (mediaId: string) => {
    invalidateMediaAgeCacheLocal(mediaId);
}).catch((err: unknown) => {
    logger.warn(
        'Failed to subscribe to age-cache invalidation channel — cross-replica invalidation unavailable',
        {},
        err as Error,
    );
});

// ---------------------------------------------------------------------------
// Core age-gate logic
// ---------------------------------------------------------------------------

/**
 * The age rating that governs `internalId`. Seasons and episodes never get
 * `age_rating` written, so they are judged by their
 * series — the same rule as the listing queries (`series-episode-counts`,
 * `buildSeriesOwnedAgeRatingFilter`). Reading the episode's own NULL column
 * would 404 every episode for a profile without unrated access.
 */
async function getAgeRating(
    sql: Sql,
    internalId: string,
    checkAudiobookAvailability = false,
    checkLiveTvIdentity = false,
): Promise<number | null> {
    const ownerId = getCachedAgeOwner(internalId);
    // Channel identity is live: an age-cache hit must never bypass a revocation.
    if (!checkLiveTvIdentity && ownerId !== undefined) {
        const cached = getCachedAgeRating(ownerId);
        // Ordinary file-backed streams keep the cached age path. Remote
        // audiobook availability is live, so re-read it in this SAME age query.
        if (
            cached !== undefined &&
            (!checkAudiobookAvailability || !ageOwnerCache.get(internalId)?.isAudiobook)
        )
            return cached;
    }

    const rows = await sql<
        {
            owner_id: string | null;
            age_rating: number | null;
            media_type: string | null;
            has_files: boolean | null;
            is_dismissed: boolean | null;
            is_live_tv: boolean;
        }[]
    >`
        SELECT owner.id::text AS owner_id, ${effectiveAgeRatingExpression(sql, 'owner')} AS age_rating, mi.media_type, mi.has_files, mi.is_dismissed
            , ${
                checkLiveTvIdentity
                    ? sql`EXISTS (SELECT 1 FROM livetv_channels WHERE id = ${internalId}::uuid)
                OR COALESCE(mi.media_type = 'tvchannel', false)`
                    : sql`false`
            } AS is_live_tv
        FROM (VALUES (1)) probe(dummy)
        LEFT JOIN media_items mi ON mi.id = ${internalId}
        LEFT JOIN media_items parent ON parent.id = mi.parent_id
            AND mi.media_type IN ('episode', 'season')
        CROSS JOIN LATERAL (
            SELECT CASE
                -- An episode filed directly under its series takes the parent.
                WHEN mi.media_type = 'episode' AND parent.media_type IN ('tv', 'series') THEN parent.id
                WHEN mi.media_type = 'episode' THEN parent.parent_id
                WHEN mi.media_type = 'season' THEN mi.parent_id
                ELSE mi.id
            END AS id
        ) owner_ref
        LEFT JOIN media_items owner ON owner.id = owner_ref.id
        LIMIT 1
    `;
    const row = rows[0];
    // The seed row keeps identity observable even without a catalog item.
    // Do not cache a Live TV verdict or accept an incomplete identity response.
    if (checkLiveTvIdentity && row?.is_live_tv !== false) {
        throw new Error('Live TV access denied');
    }
    if (
        checkAudiobookAvailability &&
        row?.media_type === 'audiobook' &&
        (!row.has_files || row.is_dismissed)
    ) {
        throw new Error('Audiobook unavailable');
    }
    const value = row?.age_rating ?? null;
    // A season/episode without a resolvable series (ingest has not linked it
    // yet) must NOT be cached: it would pin itself as owner with a NULL rating
    // for the whole TTL after the link lands.
    if (row && !row.owner_id && (row.media_type === 'episode' || row.media_type === 'season')) {
        return value;
    }
    // An unknown id caches as its own owner with a NULL rating, so a repeated
    // probe stays on the L1 cache.
    const owner = row?.owner_id ?? internalId;
    setCachedAgeOwner(internalId, owner, row?.media_type === 'audiobook');
    setCachedAgeRating(owner, value);
    return value;
}

/**
 * Check whether the age gate passes for the given user + media item.
 * Returns true (allow) or false (block).
 */
async function checkAgeGate(
    sql: Sql,
    internalId: string,
    user: UserContext,
    checkAudiobookAvailability = false,
    checkLiveTvIdentity = false,
): Promise<boolean> {
    try {
        const itemAge = await getAgeRating(
            sql,
            internalId,
            checkAudiobookAvailability,
            checkLiveTvIdentity,
        );
        // Unrestricted viewers may still need the live identity/availability read.
        if (!user.isAgeRestricted) return true;
        const maxAge = user.maxAgeRating ?? 0;
        const allowUnrated = config.UNRATED_CONTENT_VISIBLE;

        if (itemAge !== null && itemAge > maxAge) return false;
        if (itemAge === null && !allowUnrated) return false;
        return true;
    } catch {
        // Query failed (uuid cast on non-uuid id, transient db error, missing
        // column on legacy install). Fail closed for non-admin restricted users
        // so a bad id cannot be used as a probe to bypass the gate; admins
        // continue to pass so ops can still investigate when the schema drifts,
        // unless Live TV identity also needs verification (even admins need it).
        return !checkLiveTvIdentity && (toLibraryAccessUser(user)?.isAdmin ?? false);
    }
}

// ---------------------------------------------------------------------------
// withAgeGate middleware
// ---------------------------------------------------------------------------

/**
 * Middleware that blocks age-restricted users from accessing content that
 * exceeds their maximum allowed age rating.
 *
 * Must be composed after `withIdResolution` (depends on `locals.resolvedIds.internalId`).
 * Returns 404 — not 403 — to avoid revealing the item's existence to restricted users.
 */
export function withAgeGate(handler: RequestHandler): RequestHandler {
    return async (event: RequestEvent): Promise<Response> => {
        const user = event.locals.user;

        // Pass through for unauthenticated requests or unrestricted users
        if (!user || !user.isAgeRestricted) {
            return handler(event);
        }

        const { internalId } = event.locals.resolvedIds ?? {};
        if (!internalId) {
            // No resolved ID — let the handler decide (may return 404 itself)
            return handler(event);
        }

        const sql = getDb();
        if (!sql) {
            if (!toLibraryAccessUser(user)?.isAdmin) {
                logger.warn('AgeGate: DB unavailable, blocking non-admin age-restricted user', {
                    username: user.username,
                    internalId,
                });
                return ApiResponses.error('Unable to verify content access');
            }
            return handler(event);
        }

        try {
            const allowed = await checkAgeGate(sql, internalId, user);
            if (!allowed) {
                return ApiResponses.notFound('Media');
            }
        } catch (err) {
            logger.warn('AgeGate: unexpected error, passing through', {
                username: user.username,
                internalId,
                error: err instanceof Error ? err.message : String(err),
            });
            // Graceful degradation — don't block on unexpected errors
        }

        return handler(event);
    };
}

// ---------------------------------------------------------------------------
// withMediaAccess convenience composition
// ---------------------------------------------------------------------------

/**
 * Convenience middleware: library-access check followed by age-rating gate.
 *
 * Equivalent to `withLibraryAccess(withAgeGate(handler))`.
 * Use this instead of bare `withLibraryAccess` on playback routes.
 */
export function withMediaAccess(handler: RequestHandler): RequestHandler {
    return withLibraryAccess(withAgeGate(handler));
}

// ---------------------------------------------------------------------------
// checkMediaAccess inline helper
// ---------------------------------------------------------------------------

/**
 * Inline helper for routes that cannot use middleware composition (e.g. Jellyfin
 * compat routes, watch-together).
 *
 * Combines library-access (`isMediaAccessible`), age-rating, Live TV identity and
 * live audiobook availability checks. Non-admins cannot read retired remote books by known ID.
 * Returns `true` if the user is allowed to access the item, `false` otherwise.
 *
 * @param sql     - Active postgres connection
 * @param internalId - Media item UUID
 * @param user    - Resolved UserContext from `event.locals.user`
 * @param options.fileBacked - Trusted server callers that already bind delivery
 * to a physical file may skip remote-book retirement. Never take this from input.
 */
/**
 * Returns true when the user could plausibly be blocked by either the library
 * gate or the age gate — i.e. checkMediaAccess might do non-trivial work.
 * Returns false when the user is unauthenticated, an admin, or has no library
 * restrictions AND is not age-restricted; in that case checkMediaAccess is a
 * no-op for file-backed media and callers can skip preparatory work (e.g. file → owner resolution)
 * entirely.
 *
 * Cheap to call: getDeniedLibraryGroups is backed by an L1 cache that returns
 * null in O(1) for the common no-restrictions case.
 * This shortcut is for file-backed routes only: remote audiobook metadata must
 * always call checkMediaAccess so retirement is checked even without age limits.
 */
export async function userNeedsMediaAccessCheck(
    sql: Sql,
    user: UserContext | undefined,
): Promise<boolean> {
    if (!user) return false;
    if (config.FEATURE_LIVETV && user.hasLiveTvPermission === false) return true;
    if (toLibraryAccessUser(user)?.isAdmin) return false;
    if (user.isAgeRestricted) return true;
    const accessUser = toLibraryAccessUser(user);
    if (!accessUser) return false;
    try {
        const denied = await getDeniedLibraryGroups(sql, accessUser);
        return denied !== null;
    } catch {
        // Fail closed: if we can't tell, run the full check.
        return true;
    }
}

export async function checkMediaAccess(
    sql: Sql,
    internalId: string,
    user: UserContext | undefined,
    options: { fileBacked?: boolean } = {},
): Promise<boolean> {
    if (!user) return true; // unauthenticated — let auth middleware handle it

    // Generic catalog/image routes accept channel UUIDs, even for admins and
    // file-backed callers while Live TV is enabled. With the feature off, a
    // trusted physical-file binding needs no channel-identity lookup; generic
    // item routes still enforce the feature-off metadata denial.
    const checkLiveTvIdentity =
        user.hasLiveTvPermission === false &&
        (!options.fileBacked || config.FEATURE_LIVETV) &&
        isUuid(internalId);

    const accessUser = toLibraryAccessUser(user);
    if (accessUser) {
        try {
            // These callers already bind playback to a local physical file. ABS
            // books have no such files: their separate byte routes use this gate
            // without fileBacked. Do not add a content read to every HLS segment.
            // Raw provider ids retain the previous library/age behavior; never
            // introduce a UUID cast solely for audiobook retirement.
            const checkAudiobookAvailability =
                !accessUser.isAdmin &&
                !user.isAgeRestricted &&
                !checkLiveTvIdentity &&
                !options.fileBacked &&
                isUuid(internalId);
            const accessible = checkAudiobookAvailability
                ? await isMediaAccessible(sql, internalId, accessUser, {
                      checkAudiobookAvailability: true,
                  })
                : await isMediaAccessible(sql, internalId, accessUser);
            if (!accessible) return false;
        } catch {
            if (!accessUser.isAdmin) return false;
        }
    }

    if (!user.isAgeRestricted && !checkLiveTvIdentity) return true;
    // Share one content read for age, remote-book availability and Live TV
    // identity. The latter must run even without an age restriction.
    return checkAgeGate(
        sql,
        internalId,
        user,
        !accessUser?.isAdmin && !options.fileBacked && isUuid(internalId),
        checkLiveTvIdentity,
    );
}

/**
 * Batched checkMediaAccess: one content query, with the same library and
 * series-owned age rules, unknown-id behavior and fail-closed error handling.
 * Permission configuration is resolved once (normally an L1 cache hit).
 */
export async function checkMediaAccessBatch(
    sql: Sql,
    ids: readonly string[],
    user: UserContext | undefined,
): Promise<Set<string>> {
    if (!user || ids.length === 0) return new Set(ids);
    const accessUser = toLibraryAccessUser(user);
    try {
        if (user.hasLiveTvPermission === false) {
            const channelIds = await sql<{ id: string }[]>`
                SELECT id::text AS id FROM livetv_channels WHERE id = ANY(${ids.filter(isUuid)}::uuid[])
                UNION
                SELECT id::text AS id FROM media_items WHERE id = ANY(${ids.filter(isUuid)}::uuid[]) AND media_type = 'tvchannel'
            `;
            const hidden = new Set(channelIds.map((row) => row.id));
            ids = ids.filter((id) => !hidden.has(id.toLowerCase()));
            if (ids.length === 0) return new Set();
        }
        const denied = accessUser ? await getDeniedLibraryGroups(sql, accessUser) : null;
        const age = user.isAgeRestricted
            ? { maxAgeRating: user.maxAgeRating ?? 0, allowUnrated: config.UNRATED_CONTENT_VISIBLE }
            : null;
        if (accessUser?.isAdmin && !denied?.length && !age) return new Set(ids);
        const rows = await sql<{ id: string }[]>`
            SELECT requested.id AS id
            FROM unnest(${[...ids]}::text[]) AS requested(id)
            LEFT JOIN media_items mi ON mi.id = requested.id::uuid
            WHERE ${accessUser?.isAdmin ? sql`true` : sql`(mi.media_type IS DISTINCT FROM 'audiobook' OR (mi.has_files AND NOT mi.is_dismissed))`}
            AND (mi.id IS NULL OR EXISTS (
                SELECT 1 FROM media_items mi
                WHERE mi.id = requested.id::uuid
                ${buildLibraryAccessFilter(sql, denied, 'mi')}
            ))
            ${buildSeriesOwnedAgeRatingFilter(sql, age, 'mi')}
        `;
        return new Set(rows.map((row) => row.id));
    } catch {
        return accessUser?.isAdmin && user.hasLiveTvPermission !== false ? new Set(ids) : new Set();
    }
}
