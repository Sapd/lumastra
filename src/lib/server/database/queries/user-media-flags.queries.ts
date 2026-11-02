// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * User Media Flags Query Module
 *
 * Tracks per-user UI intent markers that are orthogonal to watch
 * state — e.g. "I dismissed this from Continue Watching" or (future)
 * "I starred this series". Intentionally extensible via a string
 * `flag_type` so new flags can be added without migrations; the
 * allowlist is enforced in application code instead of a DB enum.
 *
 * For M0 only `'dismissed_cw'` is used. Additional flags are added
 * here as the feature surface grows.
 */

import type postgres from 'postgres';
import { isUuid, normalizeUuid } from '$lib/server/utils/media-key-parser.js';
import type { UserId } from '$lib/shared/user-id';
import { defineQuery, defineWriteQuery } from '../typed-query.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildSeriesOwnedAgeRatingFilter } from './builders/age-rating.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Known flag types. Add here AND to `FLAG_TYPES` below when extending —
 * the array is what routes use to validate incoming requests. The DB
 * CHECK constraint (migration 16.108.0) is the second line of defense
 * against typos.
 *
 *   - `dismissed_cw`                (permanent) — user hid item/series from CW.
 *   - `featured_pick_shown`         (TTL ~7d)   — for-you home stops repeating.
 *   - `request_dismissed`           (permanent) — fulfilled-request banner cleared.
 *                                               (formerly user_notification_dismissals;
 *                                               target_type='request', target_id=composite_key)
 *   - `new_episode_alert_dismissed` (permanent) — series-scoped banner cleared.
 *   - `series_excluded`             (permanent) — series excluded from upcoming/new-episodes.
 *                                               (formerly user_excluded_series;
 *                                               target_type='series' for UUID-keyed rows,
 *                                               'tmdb_tv' / 'tmdb_movie' for TMDB-keyed rows)
 */
export type FlagType =
    | 'dismissed_cw'
    | 'featured_pick_shown'
    | 'request_dismissed'
    | 'new_episode_alert_dismissed'
    | 'series_excluded'
    /** Explicit opt-in: notify when a new episode is playable in Warp. */
    | 'series_episode_notifications';

/**
 * Allowlist used at the API boundary. Runtime equivalent of `FlagType`
 * so values arriving over the wire can be rejected before they reach
 * the DB.
 */
export const FLAG_TYPES: readonly FlagType[] = [
    'dismissed_cw',
    'featured_pick_shown',
    'request_dismissed',
    'new_episode_alert_dismissed',
    'series_excluded',
    'series_episode_notifications',
] as const;

export interface UserMediaFlag {
    id: string;
    user_id: string;
    target_id: string;
    /**
     * Kind of entity `target_id` refers to — typically a media_type
     * ('movie', 'series', 'episode') but deliberately free-form so
     * new UI surfaces can reuse this table without a schema change.
     */
    target_type: string;
    flag_type: FlagType;
    /**
     * TTL for ephemeral flags. NULL means permanent. Read paths must
     * filter via (expires_at IS NULL OR expires_at > now()).
     */
    expires_at: string | null;
    created_at: string;
}

// =============================================================================
// Write queries
// =============================================================================

/**
 * Target types whose `target_id` names a media_items row. A flag on one of
 * these is written only while the row exists, under a KEY SHARE lock, so a
 * write racing unavailable-media retention can never leave an orphan flag.
 */
export const MEDIA_FLAG_TARGET_TYPES = [
    'media',
    'movie',
    'series',
    'tv',
    'season',
    'episode',
    'audiobook',
    'track',
    'album',
    'artist',
    'extra',
] as const;

/**
 * Idempotent insert. `expiresAt` is optional — pass null/undefined for
 * permanent flags (dismissed_cw, request_dismissed,
 * new_episode_alert_dismissed) and an ISO timestamp for ephemeral ones
 * (featured_pick_shown).
 *
 * On conflict the existing row is preserved (DO NOTHING). The silence
 * window for a featured-pick row is therefore anchored on the FIRST
 * insert and not extended by subsequent re-shows; callers that want to
 * forcibly refresh the TTL should call `removeFlag` then `setFlag`
 * again. Earlier drafts used DO UPDATE SET expires_at to refresh the
 * window, but that meant a long session with multiple cache cycles kept
 * pushing the 7-day window forward — opposite of "don't show this for
 * 7 days from the first time the user saw it."
 *
 * Idempotent for retries: a duplicate POST keeps the original row
 * untouched, so `created_at` is stable across the lifetime of a single
 * user-visible dismissal. The rebuilder's auto-clear deletes the flag
 * synchronously inside the same `appendEventAndRebuild` call that
 * processes the engagement event, so any subsequent re-hide hits an
 * already-empty row and the INSERT path runs cleanly with a fresh
 * `created_at` — no DO UPDATE refresh needed.
 */
export const setFlag = defineWriteQuery<
    {
        userId: UserId;
        targetId: string;
        targetType: string;
        flagType: FlagType;
        expiresAt?: string | null;
    },
    { id: string }
>(
    'setFlag',
    (sql, { userId, targetId, targetType, flagType, expiresAt }) => sql`
        INSERT INTO user_media_flags (
            user_id,
            target_id,
            target_type,
            flag_type,
            expires_at
        ) SELECT ${userId}, ${targetId}, ${targetType}, ${flagType}, ${expiresAt ?? null}::timestamptz
        WHERE NOT (${targetType} = ANY(${[...MEDIA_FLAG_TARGET_TYPES]}::text[])) OR EXISTS (
            SELECT 1 FROM media_items WHERE id = ${isUuid(targetId) ? normalizeUuid(targetId) : null}::uuid FOR KEY SHARE
        )
        ON CONFLICT (user_id, target_id, flag_type) DO NOTHING
        RETURNING id
    `,
);

/**
 * Remove a single flag. No-op when the flag is absent so callers can
 * use this as an "ensure not present" primitive.
 */
export async function removeFlag(
    sql: postgres.Sql,
    params: { userId: UserId; targetId: string; flagType: FlagType },
): Promise<void> {
    await sql`
        DELETE FROM user_media_flags
        WHERE user_id = ${params.userId}
          AND target_id = ${params.targetId}
          AND flag_type = ${params.flagType}
    `;
}

/**
 * Remove a flag only when it was created strictly before `createdBefore`.
 * Used by the rebuilder's auto-clear path so a backfill pull catching up
 * with PRE-hide activity (event.occurred_at < flag.created_at) doesn't
 * erroneously undo a deliberate dismiss. Strict-less keeps a just-created
 * hide alive when timestamps tie at the millisecond — the user's intent
 * wins on ambiguity.
 */
export async function removeFlagIfOlderThan(
    sql: postgres.Sql,
    params: {
        userId: UserId;
        targetId: string;
        flagType: FlagType;
        createdBefore: string;
    },
): Promise<void> {
    await sql`
        DELETE FROM user_media_flags
        WHERE user_id = ${params.userId}
          AND target_id = ${params.targetId}
          AND flag_type = ${params.flagType}
          AND created_at < ${params.createdBefore}::timestamptz
    `;
}

// =============================================================================
// Read queries
// =============================================================================

/**
 * Cheap "does this user have ANY flag of this type" probe. Used by the
 * rebuilder's auto-clear path to short-circuit the per-event
 * resolveDismissalTarget + delete round-trips for the common case of a
 * user with zero dismissals — without this gate, a 10k-event Jellyfin
 * sync would issue 20k pointless DB queries.
 */
export async function userHasAnyFlag(
    sql: postgres.Sql,
    params: { userId: UserId; flagType: FlagType },
): Promise<boolean> {
    const rows = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
            SELECT 1
            FROM user_media_flags
            WHERE user_id = ${params.userId}
              AND flag_type = ${params.flagType}
        ) AS exists
    `;
    return rows[0]?.exists ?? false;
}

/**
 * Returns true when the flag exists. Implemented as a small select so
 * it works uniformly whether or not the caller wants the row itself.
 */
export async function hasFlag(
    sql: postgres.Sql,
    params: { userId: UserId; targetId: string; flagType: FlagType },
): Promise<boolean> {
    const rows = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
            SELECT 1
            FROM user_media_flags
            WHERE user_id = ${params.userId}
              AND target_id = ${params.targetId}
              AND flag_type = ${params.flagType}
        ) AS exists
    `;
    return rows[0]?.exists ?? false;
}

/**
 * All flags of a given type for a user. Ordered by creation time so
 * "most recently dismissed" queries don't need their own sort. Includes
 * expired rows — callers that care about active state should use
 * `getActiveFlagTargets` instead.
 *
 * Columns are listed explicitly rather than `SELECT *`, and the two
 * timestamptz columns are cast to `::text`. postgres.js registers a DEFAULT
 * parser for oids 1082/1114/1184 (date/timestamp/timestamptz) that returns a
 * native `Date`; connection.ts overrides only `bigint`. So under `SELECT *`
 * this query's `created_at`/`expires_at` arrived as `Date` while
 * {@link UserMediaFlag} declared them `string` — a type lie with a live
 * consequence: `defs/continue-watching/dismissals.ts` emits
 * `dismissedAt: flag.created_at` into `DismissedItemSchema`, where the field
 * is `z.string()`, and Zod 4 rejects a Date for z.string(). Every user with
 * at least one `dismissed_cw` flag got a 500 from GET
 * /api/v1/continue-watching/dismissals.
 */
export const getUserFlags = defineQuery<{ userId: UserId; flagType: FlagType }, UserMediaFlag>(
    'getUserFlags',
    (sql, { userId, flagType }) => sql`
        SELECT id, user_id, target_id, target_type, flag_type,
               created_at::text AS created_at,
               expires_at::text AS expires_at
        FROM user_media_flags
        WHERE user_id = ${userId}
          AND flag_type = ${flagType}
        ORDER BY created_at DESC
    `,
);

/**
 * The subset of `getUserFlags` callers usually want: just the target_ids
 * for currently-active flags. "Active" means `expires_at IS NULL` (no
 * TTL) OR `expires_at > now()` (TTL not yet reached).
 *
 * Used by anti-join callers (featured-pick exclude set, request feed
 * dismissal filter, new-episode banner suppression) where the row id
 * and timestamps are noise.
 */
export async function getActiveFlagTargets(
    sql: postgres.Sql,
    params: { userId: UserId; flagType: FlagType },
): Promise<string[]> {
    const rows = await sql<{ target_id: string }[]>`
        SELECT target_id
        FROM user_media_flags
        WHERE user_id = ${params.userId}
          AND flag_type = ${params.flagType}
          AND (expires_at IS NULL OR expires_at > NOW())
    `;
    return rows.map((r) => r.target_id);
}

/**
 * Sweep expired ephemeral flags. Suitable for periodic background
 * cleanup; not on the request hot path. Returns the number of rows
 * deleted so the scheduler can log throughput.
 */
export async function deleteExpiredFlags(sql: postgres.Sql): Promise<number> {
    const rows = await sql<{ id: string }[]>`
        DELETE FROM user_media_flags
        WHERE expires_at IS NOT NULL
          AND expires_at <= NOW()
        RETURNING id
    `;
    return rows.length;
}

// =============================================================================
// Dismissal display metadata
// =============================================================================

/**
 * Bare-minimum media metadata needed to render a dismissal ("hidden") card.
 */
export interface DismissalMediaInfo {
    id: string;
    title: string;
    media_type: string;
}

/**
 * Batch-fetch display metadata for dismissal targets, filtered by the caller's
 * access boundary.
 *
 * ACCESS BOUNDARY CONTRACT
 *
 * `access` is REQUIRED — there is no permissive default. A caller that
 * genuinely wants unrestricted results must construct `unrestrictedAccess()`
 * so the decision is greppable. Both axes are spliced with the shared builders:
 * `buildLibraryAccessFilter` hardcodes the `mi` alias and `buildAgeRatingFilter`
 * defaults to it, and this query aliases media_items as `mi`, so no alias
 * override is needed. For an `all`/`any` scope both builders emit an empty
 * fragment, so the SQL an unrestricted caller sees is byte-identical to the
 * hand-inlined predicate this function replaces.
 *
 * A `denyAll` boundary short-circuits to the empty list before issuing any SQL.
 * That is belt-and-braces rather than the sole enforcement — both builders also
 * emit `AND false` for a denyAll scope.
 *
 * Filtering by CURRENT access (rather than trusting the stored flag) is the
 * point: a dismissal written before a policy change must not leak a restricted
 * title afterwards. Rows whose media_items row is gone, non-active, or outside
 * the boundary are simply absent from the result, and callers drop the
 * corresponding flag.
 *
 * Shared by the `/my/hidden` page load and `GET /api/continue-watching/dismissals`
 * so the two entry points cannot drift in what they consider visible.
 */
export async function fetchDismissalMediaInfo(
    sql: postgres.Sql,
    targetIds: readonly string[],
    access: MediaAccessBoundary,
): Promise<DismissalMediaInfo[]> {
    if (targetIds.length === 0) return [];
    if (deniesEverything(access)) return [];

    const rows = await sql<DismissalMediaInfo[]>`
        SELECT mi.id, mi.title, mi.media_type
        FROM media_items mi
        WHERE mi.id = ANY(${targetIds as string[]}::uuid[])
          AND mi.status = 'active'
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildSeriesOwnedAgeRatingFilter(sql, access.age)}
    `;
    return rows.map((row) => ({
        id: row.id,
        title: row.title,
        media_type: row.media_type,
    }));
}

// =============================================================================
// Dismissal target resolver
// =============================================================================

/**
 * Shape returned by `resolveDismissalTarget`. The `id` is always a
 * `media_items.id` UUID; `type` describes what that UUID refers to so
 * callers can pass it straight through to `setFlag`/`removeFlag`.
 */
export interface DismissalTarget {
    id: string;
    type: 'series' | 'movie';
}

/**
 * Resolve the Continue-Watching dismissal target for a given media_id.
 *
 * Episodes dismiss at the series level (grandparent) so a single mark
 * hides every episode of the show from the CW row. Movies dismiss at
 * their own level. Anything else (seasons, collections, music, etc.)
 * has no CW-dismissal semantics so we return `null`.
 *
 * Walks media_items twice for episodes (episode → season → series) and
 * once for movies. Uses CASE to branch so we stay in a single round-trip.
 */
export async function resolveDismissalTarget(
    sql: postgres.Sql,
    mediaId: string,
): Promise<DismissalTarget | null> {
    const rows = await sql<{ target_id: string; target_type: 'series' | 'movie' }[]>`
        WITH self AS (
            SELECT id, media_type, parent_id
            FROM media_items
            WHERE id = ${mediaId}::uuid
            LIMIT 1
        ),
        resolved AS (
            SELECT
                CASE
                    WHEN self.media_type = 'episode' THEN season.parent_id
                    WHEN self.media_type = 'movie'   THEN self.id
                    ELSE NULL
                END AS target_id,
                CASE
                    WHEN self.media_type = 'episode' THEN 'series'
                    WHEN self.media_type = 'movie'   THEN 'movie'
                    ELSE NULL
                END AS target_type
            FROM self
            LEFT JOIN media_items season
                ON season.id = self.parent_id
               AND season.media_type = 'season'
        )
        SELECT target_id, target_type
        FROM resolved
        WHERE target_id IS NOT NULL
        LIMIT 1
    `;
    const row = rows[0];
    if (!row || !row.target_id) return null;
    return { id: row.target_id, type: row.target_type };
}
