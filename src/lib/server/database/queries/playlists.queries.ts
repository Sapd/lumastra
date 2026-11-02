// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playlists Query Module
 *
 * Centralized queries for playlist operations.
 * All queries follow the three-tier architecture pattern.
 */

import type postgres from 'postgres';
import { isAvailableExpr } from './availability.queries.js';
import type { UserId } from '$lib/shared/user-id';
import type { PreferredExternalId } from '$lib/utils/external-ids';
import { isEpisode } from '$lib/server/utils/media-types';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { buildSeriesOwnedAgeRatingFilter } from './builders/age-rating.builder.js';
import { pgTextTimestamp, PG_TEXT_OID } from './builders/keyset-cursor.builder.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import type { LibraryScope, MediaAccessBoundary } from './builders/media-access-boundary.js';

// =============================================================================
// Types
// =============================================================================

export interface CoverItemRow {
    internal_id: string | null;
    primary_ext_id: string | null;
    media_type: string | null;
    poster_url: string | null;
    position: number;
}

/**
 * Viewer access boundary applied to playlist cover collages.
 *
 * A playlist row is never hidden by it — only the cover items inside it are
 * filtered, so a restricted viewer still sees that the playlist exists but not
 * poster art they may not access. In particular a `denyAll` boundary yields an
 * EMPTY collage while still returning the playlist row; assertions written
 * against these functions must be made over `cover_items`, not over the
 * top-level result.
 *
 * `item_count` is deliberately NOT filtered by this boundary — it counts every
 * item in the playlist, including ones the viewer cannot see. That is
 * pre-existing, pinned behaviour; see the integration test.
 *
 * Previously a local `PlaylistListAccess` duplicate of `MediaAccessBoundary`
 * with a permissive `NO_ACCESS_FILTER` default. The default is gone: every
 * caller must state its boundary, and a caller that genuinely wants no
 * filtering says so with `unrestrictedAccess()`.
 */

/** Decoded keyset cursor for `getPublicPlaylists` — mirrors the `(updated_at, id) DESC` order. */
export interface PublicPlaylistsCursor {
    updatedAt: string;
    id: string;
}

/**
 * Paging mode for `getPublicPlaylists`. A discriminated union so a caller
 * cannot ambiguously pass both an offset and a cursor — offset paging and
 * keyset paging are mutually exclusive per request.
 */
export type PublicPlaylistsPage =
    | { mode: 'offset'; offset: number } // Simple page-number paging
    | { mode: 'cursor'; cursor: PublicPlaylistsCursor }; // Keyset paging

/**
 * Decoded keyset cursor for `getPlaylistItems` — mirrors the feed's real
 * `(position ASC, id ASC)` ordering. `position` and `id` are both `integer`
 * columns kept as exact text (bound pinned to OID 25 / TEXT and cast `::int`)
 * so the cursor round-trips losslessly. `position` is `NOT NULL`, so there is
 * no NULL group to carry (Gate D2b N/A). `id` is the `playlist_items` PK, so
 * `(position, id)` is a deterministic total order even though `position` is not
 * unique per playlist.
 */
export interface PlaylistItemsCursor {
    position: string;
    id: string;
}

/**
 * Paging mode for `getPlaylistItems`. Discriminated union so offset and keyset
 * paging cannot both be supplied. Cursor mode is opt-in; the default
 * `{ mode: 'offset' }` reproduces the historical behaviour byte-for-byte
 * (every row ordered by `position ASC`, no LIMIT — the handler slices).
 */
export type PlaylistItemsPage =
    | { mode: 'offset'; availableOnly?: boolean } // Historical behaviour: full order, no LIMIT (handler slices)
    | { mode: 'cursor'; cursor: PlaylistItemsCursor; limit: number; availableOnly?: boolean }; // Keyset paging

/**
 * Decoded keyset cursor for `getPlaylistMembers` — mirrors the feed's real
 * compound `(status ASC, invited_at DESC, user_id DESC)` ordering. `status` is
 * a `NOT NULL` enum ('accepted' | 'pending') and leads the sort. `invited_at`
 * is nullable and ordered `DESC` (Postgres default puts NULLs FIRST), so a
 * `null` here marks the NULL-invited group Gate D2b must CARRY, never exclude.
 * `user_id` is unique within a playlist (`playlist_members_unique`) and is the
 * deterministic tiebreak.
 */
export interface PlaylistMembersCursor {
    status: 'pending' | 'accepted';
    invitedAt: string | null;
    userId: string;
}

/**
 * Paging mode for `getPlaylistMembers`. Discriminated union; cursor mode is
 * opt-in and the default `{ mode: 'offset' }` reproduces the historical query
 * byte-for-byte (every row ordered by `status ASC, invited_at DESC`, no LIMIT).
 */
export type PlaylistMembersPage =
    | { mode: 'offset'; availableOnly?: boolean } // Historical behaviour: full order, no LIMIT
    | { mode: 'cursor'; cursor: PlaylistMembersCursor; limit: number }; // Keyset paging

/** Every value `playlists.playlist_type` may hold. */
export type PlaylistTypeValue = 'general' | 'music' | 'video' | 'watchlist';

export interface PlaylistRow {
    revision: number;
    id: number;
    user_id: string;
    /**
     * Owner's resolved login name (joined on user_id). Optional because not every
     * query that returns a PlaylistRow populates it; transforms fall back to
     * user_id when absent. playlists.user_id is a users.id UUID (mig 16.46.0).
     */
    owner_username?: string;
    /** Owner's display name from users.display_name; null when unset. */
    owner_display_name?: string | null;
    /**
     * Count of accepted members, excluding the owner and pending invites.
     * Pinned to the definition used by the web SSR page so the field means
     * one thing across surfaces.
     */
    member_count?: string | number;
    name: string;
    description: string | null;
    visibility: 'private' | 'public';
    playlist_type?: PlaylistTypeValue;
    /**
     * True for a playlist the user may not delete, rename, share or reorder.
     * Only the per-user watchlist sets this today. Guards key on THIS, not on
     * playlist_type — playlist_type is writable through PUT, so a guard keyed
     * on it is defeated by flipping the row to 'general' and then deleting.
     */
    is_system?: boolean;
    cover_image: string | null;
    created_at: string | Date;
    updated_at: string | Date;
    /**
     * `p.updated_at::text` — the same instant as `updated_at`, but rendered by
     * Postgres as a raw string instead of being parsed into a JS `Date` by
     * postgres.js's timestamptz type parser. `Date#toISOString()` only carries
     * millisecond precision, while Postgres timestamps (and `now()`, which
     * `touchPlaylist` writes) carry microseconds — round-tripping through a
     * `Date` truncates the cursor and can silently skip a row updated in the
     * same millisecond as the page boundary. Only `getPublicPlaylists`
     * populates this; keep it a bare string, never widen it to `string | Date`.
     */
    updated_at_cursor?: string;
    role?: 'owner' | 'editor' | 'readonly';
    item_count: string | number;
    cover_items?: CoverItemRow[] | null;
}

export interface PlaylistItemRow {
    id: number;
    media_id: string;
    primary_ext_id: string;
    media_type: string;
    season_number: number | null;
    episode_number: number | null;
    title: string;
    series_name: string | null;
    artist: string | null;
    parent_id: string | null;
    artist_id: string | null;
    overview: string | null;
    poster_path: string | null;
    position: number;
    added_at: string | Date;
    /**
     * Playlist-SCOPED manual tick (`playlist_item_watched`), written only by
     * `PUT /playlists/{id}/items/{itemId}/watched`. This is NOT the viewer's
     * real playback state — see `playback_watched` / `resume_position_ms`
     * below, which come from `user_media_state`.
     */
    watched: boolean;
    watched_at: string | null;
    /**
     * Real playback state for the viewer, LEFT JOINed from `user_media_state`
     * (PK `(user_id, media_id)` — one index probe per row, no N+1). All four
     * are null when the viewer has never touched the item, when the request is
     * anonymous, or for music (music playback lives in `user_music_state`).
     */
    resume_position_ms: number | null;
    /**
     * Effective runtime in ms: recorded session runtime, else catalog runtime.
     *
     * ITEM METADATA, not watch state — present for every row that has a runtime
     * from either source, including never-played items and anonymous requests.
     * Null only when neither source has one.
     */
    runtime_ms: number | null;
    /** `user_media_state.is_watched` — completed playback, NOT the playlist tick. */
    playback_watched: boolean | null;
    /** `user_media_state.last_event_at` — last playback activity. */
    last_played_at: string | Date | null;
}

export interface InsertedItemRow {
    id: number;
    season_number: number | null;
    episode_number: number | null;
    title: string;
    series_name: string | null;
    overview: string | null;
    poster_path: string | null;
    position: number;
    added_at: string | Date;
}

export interface PlaylistMemberRow {
    user_id: string;
    /** Resolved login name from the `users` table (joined on user_id). */
    username: string;
    role: 'readonly' | 'editor';
    status: 'pending' | 'accepted';
    invited_at: string | Date;
    /**
     * `pm.invited_at::text` — the same instant as `invited_at`, rendered by
     * Postgres as a raw string (micro precision preserved) instead of parsed
     * into a ms-truncated JS `Date`. Only the keyset-cursor path populates and
     * consumes it; keep it a bare string, never widen to `string | Date`.
     */
    invited_at_cursor?: string;
}

export interface PlaylistInviteRow {
    id: number;
    status: string;
    role: 'editor' | 'readonly';
    playlist_name: string;
    /** Playlist owner's users.id UUID. */
    user_id: string;
    /** Playlist owner's resolved login name (joined on user_id). */
    owner_username: string;
}

// =============================================================================
// Utility Queries
// =============================================================================

/**
 * Resolve an external ID to internal media_id UUID
 * Returns null if not found
 *
 * @param sql - Database connection
 * @param provider - The external ID provider (e.g., 'tmdb', 'imdb', 'jellyfin')
 * @param externalId - The external ID to resolve
 * @param mediaType - The media type (for providers like TMDB where IDs aren't unique across types)
 */
export async function resolveMediaId(
    sql: postgres.Sql,
    provider: string,
    externalId: string | number,
    mediaType: string,
): Promise<string | null> {
    // For episodes, use 'tv' as the media_type in external_ids (episodes are part of TV series)
    const lookupMediaType = isEpisode(mediaType) ? 'tv' : mediaType;
    const result = await sql<{ media_id: string }[]>`
        SELECT media_id FROM external_ids
        WHERE provider = ${provider} AND external_id = ${String(externalId)} AND media_type = ${lookupMediaType}
        LIMIT 1
    `;
    return result[0]?.media_id ?? null;
}

/** One lookup key for {@link resolveMediaIdsBatch}. */
export interface MediaIdLookupKey {
    provider: string;
    externalId: string | number;
    /** Raw media type as supplied by the caller — normalized internally (episodes -> 'tv'), same as `resolveMediaId`. */
    mediaType: string;
}

/**
 * Batch counterpart to {@link resolveMediaId} — resolves many
 * (provider, externalId, mediaType) triples to internal UUIDs in ONE round
 * trip instead of one query per key. LOOKUP-ONLY: never creates a
 * `media_items` stub for a miss (unlike `resolveOrCreateMediaId` in
 * `media-resolution.ts`) — a caller that needs create-on-miss semantics must
 * use that helper per-item instead.
 *
 * Returns a Map keyed by `${provider}:${externalId}:${normalizedMediaType}`
 * (using the SAME normalized media type `resolveMediaId` looks up with, i.e.
 * episodes bucketed under `'tv'`). Keys that do not resolve are simply absent
 * from the map — callers distinguish "not found" from "found" via `.has()`.
 *
 * Existing input order/duplicates are irrelevant to the result — the map is
 * keyed, so callers with duplicate keys across items just read the same
 * entry twice.
 */
export async function resolveMediaIdsBatch(
    sql: postgres.Sql,
    keys: readonly MediaIdLookupKey[],
): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (keys.length === 0) return result;

    const providers = keys.map((k) => k.provider);
    const externalIds = keys.map((k) => String(k.externalId));
    const mediaTypes = keys.map((k) => (isEpisode(k.mediaType) ? 'tv' : k.mediaType));

    const rows = await sql<
        { provider: string; external_id: string; media_type: string; media_id: string }[]
    >`
        SELECT ei.provider, ei.external_id, ei.media_type, ei.media_id
        FROM external_ids ei
        JOIN unnest(${providers}::text[], ${externalIds}::text[], ${mediaTypes}::text[])
            AS k(provider, external_id, media_type)
          ON ei.provider = k.provider
         AND ei.external_id = k.external_id
         AND ei.media_type = k.media_type
    `;

    for (const row of rows) {
        result.set(`${row.provider}:${row.external_id}:${row.media_type}`, row.media_id);
    }
    return result;
}

/**
 * Batch-check which of `mediaIds` (caller-supplied `externalIds.internal`
 * UUIDs — a bulk-add item can name its media directly with no external-id
 * lookup) actually exist in `media_items`. Companion to
 * {@link resolveMediaIdsBatch}: that function looks up external ids and
 * reports a miss as `not_in_catalog`; a caller-supplied internal UUID skips
 * that lookup entirely and was previously trusted verbatim, so a stale or
 * fabricated UUID hit the `playlist_items.media_id` FK INSIDE the single
 * INSERT transaction and failed the WHOLE bulk-add batch with a 500 (final
 * fix wave, 2026-09-13) instead of being reported per-item like every other
 * unresolvable id.
 *
 * Returns the SUBSET of `mediaIds` that exist — callers resolve a
 * `internal` item the same way as an external-id miss: present in the
 * returned set = resolved, absent = skip with `not_in_catalog`.
 */
export async function filterExistingMediaIds(
    sql: postgres.Sql,
    mediaIds: readonly string[],
): Promise<Set<string>> {
    const result = new Set<string>();
    if (mediaIds.length === 0) return result;

    const rows = await sql<{ id: string }[]>`
        SELECT id FROM media_items WHERE id = ANY(${mediaIds}::uuid[])
    `;
    for (const row of rows) {
        result.add(row.id);
    }
    return result;
}

/**
 * Batch-look-up the ACTUAL `media_type` of each id in `mediaIds`.
 *
 * Companion to {@link filterExistingMediaIds} — that function proves a
 * caller-supplied `internal` UUID exists at all; this one is for callers
 * that also need to verify what it actually IS. A restrictive playlist
 * policy (the watchlist) must re-check this: both the `internal`-UUID fast
 * path (this file's `resolvePreferredToMediaId`) and its equivalent in
 * `media-resolution.ts` return a caller-supplied UUID VERBATIM, with no
 * check that the row it names has the type the request CLAIMED — so
 * `{externalIds:{internal:"<episode uuid>"}, mediaType:"movie"}` resolves
 * successfully and would otherwise carry an episode straight past a
 * claimed-type-only gate. See the callers of this function for where that
 * re-check happens.
 *
 * Missing ids are simply absent from the returned map (not an error) —
 * callers treat that the same as "not in catalog" would be handled
 * elsewhere in their own resolution pass.
 */
export async function getMediaTypesForIds(
    sql: postgres.Sql,
    mediaIds: readonly string[],
): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (mediaIds.length === 0) return result;

    const rows = await sql<{ id: string; media_type: string }[]>`
        SELECT id, media_type FROM media_items WHERE id = ANY(${mediaIds}::uuid[])
    `;
    for (const row of rows) {
        result.set(row.id, row.media_type);
    }
    return result;
}

/** What {@link getMediaSummariesForIds} returns per id. */
export interface MediaSummaryRow {
    id: string;
    media_type: string;
    title: string;
}

/**
 * Batch-look-up `media_type` and `title` for caller-supplied media ids, for
 * callers that add items by internal id alone (the /j playlist routes) and so
 * need the type to pick the add path and the title for the playlist row.
 *
 * Not an access check: missing ids are simply absent from the map, and callers
 * gate each id on the viewer separately.
 */
export async function getMediaSummariesForIds(
    sql: postgres.Sql,
    mediaIds: readonly string[],
): Promise<Map<string, MediaSummaryRow>> {
    const result = new Map<string, MediaSummaryRow>();
    if (mediaIds.length === 0) return result;

    const rows = await sql<MediaSummaryRow[]>`
        SELECT id, media_type, title FROM media_items WHERE id = ANY(${mediaIds}::uuid[])
    `;
    for (const row of rows) {
        result.set(row.id, row);
    }
    return result;
}

/**
 * Episode context derived from the media_items hierarchy.
 */
export interface EpisodeContext {
    seriesMediaId: string | null;
    seriesName: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
}

/**
 * Resolve an episode's season/episode numbers and parent series from its own
 * media_items UUID.
 *
 * Episodes carry only episode-level external ids, so the series must come from
 * the parent chain. The COALESCE tolerates both hierarchy shapes present in the
 * data: nested (episode -> season -> series) and flat (episode -> series), the
 * same two cases getPlaylistItems handles.
 *
 * Uses raw season_number/episode_number deliberately — NOT the episode-ordering
 * overrides. Series expansion (getSeriesEpisodesForPlaylist) writes raw numbers,
 * and playlist_items' unique key includes them, so ordering-aware numbering
 * would key TVDB/TMDB-split series differently and defeat dedupe.
 *
 * Returns null when the id is not an episode.
 */
export async function resolveEpisodeContext(
    sql: postgres.Sql,
    episodeMediaId: string,
): Promise<EpisodeContext | null> {
    const rows = await sql<
        {
            series_media_id: string | null;
            series_name: string | null;
            season_number: number | null;
            episode_number: number | null;
        }[]
    >`
        SELECT
            series.id::text AS series_media_id,
            series.title AS series_name,
            ep.season_number,
            ep.episode_number
        FROM media_items ep
        LEFT JOIN media_items season
               ON season.id = ep.parent_id AND season.media_type = 'season'
        LEFT JOIN media_items series
               ON series.id = COALESCE(season.parent_id, ep.parent_id)
              AND series.media_type = 'tv'
        WHERE ep.id = ${episodeMediaId} AND ep.media_type = 'episode'
        LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
        seriesMediaId: row.series_media_id,
        seriesName: row.series_name,
        seasonNumber: row.season_number,
        episodeNumber: row.episode_number,
    };
}

/**
 * Resolve a preferred external ID to an internal media_id UUID.
 * Shortcut when the preferred ID is already an internal UUID.
 */
export async function resolvePreferredToMediaId(
    sql: postgres.Sql,
    preferred: PreferredExternalId | null,
    mediaType: string,
): Promise<string | null> {
    if (!preferred) return null;
    if (preferred.provider === 'internal') return preferred.id;
    return resolveMediaId(sql, preferred.provider, preferred.id, mediaType);
}

// =============================================================================
// Playlist Queries
// =============================================================================

/**
 * Get all playlists owned by a user (with cover items)
 */
/**
 * Cover-collage items for a playlist, de-duplicated by VISUAL GROUP and pulled
 * from across the playlist (not just the first rows) so the collage is diverse
 * instead of four episodes of whichever series happens to sit at the top.
 *
 * Visual group = the SERIES for episodes (every episode of a series renders the
 * same series art, so they collapse to one tile), or the item itself otherwise.
 * The series key is the series media_id resolved up the parent chain
 * (episode -> season -> series via media_items.parent_id) — real episodes carry
 * only episode-level external ids, so the series must come from the hierarchy,
 * not an external id. The COALESCE also handles a flat episode whose parent is
 * the series directly, and falls back to the item's own media_id. DISTINCT ON
 * keeps the earliest-positioned item per group; we then return the first groups
 * by position. A final render-URL dedup runs client-side (catches e.g. repeated
 * album art the SQL can't see).
 *
 * Scans a bounded window (LIMIT 200) so cost stays close to the original while
 * still seeing well past any single series' run. References the outer `p.id`, so
 * it must be interpolated inside a query that aliases `playlists p`.
 */
function coverItemsSubquery(
    sql: postgres.Sql,
    access: MediaAccessBoundary,
): postgres.PendingQuery<postgres.Row[]> {
    const provider = getPrimaryExternalIdProvider();
    return sql`
        (
            SELECT json_agg(cover_item ORDER BY cover_item.position)
            FROM (
                SELECT internal_id, primary_ext_id, media_type, poster_url, position
                FROM (
                    SELECT DISTINCT ON (
                        CASE WHEN media_type = 'episode'
                            THEN 'series:' || series_group_id
                            ELSE 'media:' || internal_id END
                    )
                        internal_id, primary_ext_id, media_type, poster_url, position
                    FROM (
                        SELECT
                            pi2.media_id::text as internal_id,
                            (SELECT external_id FROM external_ids WHERE media_id = pi2.media_id AND provider = ${provider} AND media_type = CASE WHEN pi2.season_number IS NOT NULL AND pi2.episode_number IS NOT NULL THEN 'tv' ELSE mi.media_type END LIMIT 1) as primary_ext_id,
                            CASE WHEN pi2.season_number IS NOT NULL AND pi2.episode_number IS NOT NULL THEN 'episode' ELSE mi.media_type END as media_type,
                            COALESCE(
                                mi.custom_poster_url,
                                (SELECT parent.custom_poster_url FROM media_items parent WHERE parent.id = mi.parent_id)
                            ) as poster_url,
                            pi2.position as position,
                            -- Series media_id up the parent chain (episode -> season ->
                            -- series); falls back to a 1-level parent, then the item id.
                            COALESCE(ep_season.parent_id, mi.parent_id, pi2.media_id)::text as series_group_id
                        FROM (
                            SELECT media_id, season_number, episode_number, position
                            FROM playlist_items
                            WHERE playlist_id = p.id
                            ORDER BY position
                            LIMIT 200
                        ) pi2
                        JOIN media_items mi ON mi.id = pi2.media_id
                        LEFT JOIN media_items ep_season ON ep_season.id = mi.parent_id
                        WHERE true
                        ${buildLibraryAccessFilter(sql, access.library)}
                        ${buildSeriesOwnedAgeRatingFilter(sql, access.age)}
                    ) base
                    ORDER BY
                        CASE WHEN media_type = 'episode'
                            THEN 'series:' || series_group_id
                            ELSE 'media:' || internal_id END,
                        position
                ) distinct_per_group
                ORDER BY position
                LIMIT 12
            ) cover_item
        ) as cover_items
    `;
}

export async function getOwnedPlaylists(
    sql: postgres.Sql,
    userId: UserId,
    playlistType: PlaylistTypeValue | undefined,
    access: MediaAccessBoundary,
): Promise<PlaylistRow[]> {
    const rows = await sql<PlaylistRow[]>`
        SELECT
            p.id,
            p.user_id,
            (SELECT u.username FROM users u WHERE u.id = p.user_id) AS owner_username,
            (SELECT u.display_name FROM users u WHERE u.id = p.user_id) AS owner_display_name,
            p.name,
            p.description,
            p.visibility,
            p.playlist_type,
            p.is_system, p.revision,
            p.cover_image,
            p.created_at,
            p.updated_at,
            'owner' as role,
            (SELECT COUNT(*)::int FROM playlist_members pm2
             WHERE pm2.playlist_id = p.id AND pm2.status = 'accepted') AS member_count,
            COUNT(pi.id) as item_count,
            ${coverItemsSubquery(sql, access)}
        FROM playlists p
        LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
        WHERE p.user_id = ${userId}::uuid
        ${playlistType ? sql`AND p.playlist_type = ${playlistType}` : sql``}
        GROUP BY p.id
        ORDER BY p.updated_at DESC
    `;
    return rows;
}

/**
 * Get all playlists shared with a user (with cover items)
 */
export async function getSharedPlaylists(
    sql: postgres.Sql,
    userId: UserId,
    playlistType: PlaylistTypeValue | undefined,
    access: MediaAccessBoundary,
): Promise<PlaylistRow[]> {
    const rows = await sql<PlaylistRow[]>`
        SELECT
            p.id,
            p.user_id,
            (SELECT u.username FROM users u WHERE u.id = p.user_id) AS owner_username,
            (SELECT u.display_name FROM users u WHERE u.id = p.user_id) AS owner_display_name,
            p.name,
            p.description,
            p.visibility,
            p.playlist_type,
            p.is_system, p.revision,
            p.cover_image,
            p.created_at,
            p.updated_at,
            pm.role,
            (SELECT COUNT(*)::int FROM playlist_members pm2
             WHERE pm2.playlist_id = p.id AND pm2.status = 'accepted') AS member_count,
            COUNT(pi.id) as item_count,
            ${coverItemsSubquery(sql, access)}
        FROM playlists p
        INNER JOIN playlist_members pm ON pm.playlist_id = p.id
        LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
        WHERE pm.user_id = ${userId}::uuid
          AND pm.status = 'accepted'
        ${playlistType ? sql`AND p.playlist_type = ${playlistType}` : sql``}
        GROUP BY p.id, pm.role
        ORDER BY p.updated_at DESC
    `;
    return rows;
}

/**
 * Public playlists for the discover feed.
 *
 * Excludes playlists the viewer owns or is an accepted member of — both already
 * appear in the caller's own list, and clients build Discover as a separate
 * request, so including them renders the same card twice. Pending invites do
 * NOT exclude: the viewer has no access to those yet.
 *
 * Empty playlists are excluded — a playlist with no items is a dead end in a
 * browse tab.
 *
 * Playlists owned by a soft-deleted (users.deleted_at) or disabled
 * (users.disabled_at) user are excluded — deletion is soft, so the owner row
 * (and its username/display name/avatar) still resolves, but this feed is a
 * discover surface that enumerates playlists for every caller, unlike the
 * direct-by-ID lookup those users' playlists remain reachable through.
 *
 * Every returned row has role='readonly' by construction (accepted members are
 * filtered out), matching getUserRole's public branch.
 *
 * TWO-LAYER SHAPE — do not collapse into one query. coverItemsSubquery is a
 * correlated target-list expression that Postgres evaluates below Sort/Limit,
 * so a single-layer `... ORDER BY ... LIMIT n` would still build the 200-row
 * DISTINCT ON collage for EVERY public playlist and then throw them away. The
 * `page` CTE resolves the page's ids with no collage; the outer query attaches
 * the collage to only those rows.
 *
 * Returns up to limit + 1 rows — the caller detects hasMore via
 * `rows.length > limit` and slices, per the paginate() contract.
 *
 * `pagination` selects offset paging (`{ mode: 'offset', offset }`, the
 * default the tvOS client already ships against) or keyset paging
 * (`{ mode: 'cursor', cursor: { updatedAt, id } }`). Keyset mode replaces
 * `OFFSET` with a `(p.updated_at, p.id) < (cursor.updatedAt, cursor.id)`
 * predicate that matches `ORDER BY p.updated_at DESC, p.id DESC` exactly, so a
 * row mutated between page requests (e.g. `touchPlaylist` firing on a member
 * write) can no longer jump across the cursor boundary and cause a
 * duplicate/skipped row the way `OFFSET` can.
 */
export async function getPublicPlaylists(
    sql: postgres.Sql,
    viewerId: UserId,
    // Widened to PlaylistTypeValue for consistency with its two siblings
    // (below) — a watchlist can never be public (it's a non-shareable system
    // playlist, enforced elsewhere), so accepting 'watchlist' here is
    // cosmetic, not a new capability.
    playlistType: PlaylistTypeValue | undefined,
    limit: number,
    pagination: PublicPlaylistsPage,
    access: MediaAccessBoundary,
): Promise<PlaylistRow[]> {
    const rows = await sql<PlaylistRow[]>`
        WITH page AS (
            SELECT p.id
            FROM playlists p
            WHERE p.visibility = 'public'
              AND p.user_id <> ${viewerId}::uuid
              AND NOT EXISTS (
                  SELECT 1 FROM playlist_members pm
                  WHERE pm.playlist_id = p.id
                    AND pm.user_id = ${viewerId}::uuid
                    AND pm.status = 'accepted'
              )
              AND EXISTS (
                  SELECT 1 FROM playlist_items pi WHERE pi.playlist_id = p.id
              )
              AND NOT EXISTS (
                  SELECT 1 FROM users u
                  WHERE u.id = p.user_id
                    AND (u.deleted_at IS NOT NULL OR u.disabled_at IS NOT NULL)
              )
            ${playlistType ? sql`AND p.playlist_type = ${playlistType}` : sql``}
            ${
                pagination.mode === 'cursor'
                    ? // pgTextTimestamp() pins this parameter's wire OID to TEXT (25).
                      // Left as a bare `${...}::timestamptz` bind, postgres.js infers
                      // the parameter's OID from Postgres's own ParameterDescription
                      // (1184/timestamptz, driven by the `::timestamptz` cast) and
                      // serializes ANY value bound to that OID via
                      // `new Date(x).toISOString()` — reintroducing millisecond
                      // truncation on the exact microsecond-precision string
                      // `updated_at_cursor` supplies, even though the value is
                      // already a string. Pinning the OID to text keeps Postgres
                      // parsing the raw string server-side, losslessly. See
                      // `keyset-cursor.builder.ts` for the shared helper.
                      sql`AND (p.updated_at, p.id) < (${pgTextTimestamp(sql, pagination.cursor.updatedAt)}::timestamptz, ${pagination.cursor.id})`
                    : sql``
            }
            ORDER BY p.updated_at DESC, p.id DESC
            LIMIT ${limit + 1} ${pagination.mode === 'offset' ? sql`OFFSET ${pagination.offset}` : sql``}
        )
        SELECT
            p.id,
            p.user_id,
            (SELECT u.username FROM users u WHERE u.id = p.user_id) AS owner_username,
            (SELECT u.display_name FROM users u WHERE u.id = p.user_id) AS owner_display_name,
            p.name,
            p.description,
            p.visibility,
            p.playlist_type, p.revision, p.is_system,
            p.cover_image,
            p.created_at,
            p.updated_at,
            p.updated_at::text AS updated_at_cursor,
            'readonly' as role,
            (SELECT COUNT(*)::int FROM playlist_members pm2
             WHERE pm2.playlist_id = p.id AND pm2.status = 'accepted') AS member_count,
            COUNT(pi.id) as item_count,
            ${coverItemsSubquery(sql, access)}
        FROM playlists p
        JOIN page ON page.id = p.id
        LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
        GROUP BY p.id
        ORDER BY p.updated_at DESC, p.id DESC
    `;
    return rows;
}

/**
 * Get playlist by ID
 */
export async function getPlaylistById(
    sql: postgres.Sql,
    playlistId: number,
): Promise<PlaylistRow | null> {
    const rows = await sql<PlaylistRow[]>`
        SELECT
            p.id,
            p.user_id,
            (SELECT u.username FROM users u WHERE u.id = p.user_id) AS owner_username,
            p.name,
            p.description,
            p.visibility,
            p.playlist_type,
            p.is_system, p.revision,
            p.cover_image,
            p.created_at,
            p.updated_at,
            (SELECT u.display_name FROM users u WHERE u.id = p.user_id) AS owner_display_name,
            (SELECT COUNT(*)::int FROM playlist_items pi WHERE pi.playlist_id = p.id) AS item_count,
            (SELECT COUNT(*)::int FROM playlist_members pm WHERE pm.playlist_id = p.id AND pm.status = 'accepted') AS member_count
        FROM playlists p
        WHERE p.id = ${playlistId}
    `;
    return rows[0] ?? null;
}

/**
 * A playlist's `playlist_type`, or null if the playlist does not exist.
 *
 * A one-column lookup for call sites that only need the type (e.g. picking a
 * per-kind policy from `playlist-kind-policy.ts`) and don't otherwise load a
 * full `PlaylistRow` — prefer `getPlaylistById` when more fields are needed.
 */
export async function getPlaylistType(
    sql: postgres.Sql,
    playlistId: number,
): Promise<PlaylistTypeValue | null> {
    const rows = await sql<{ playlist_type: PlaylistTypeValue }[]>`
        SELECT playlist_type FROM playlists WHERE id = ${playlistId}
    `;
    return rows[0]?.playlist_type ?? null;
}

/**
 * Library predicate for playlist items, keyed on `pi.media_id` rather than the
 * `mi.id` that {@link buildLibraryAccessFilter} hardcodes. The two are equal in
 * this query (`JOIN media_items mi ON mi.id = pi.media_id`), but the predicate
 * is kept verbatim so this migration emits byte-identical SQL for the
 * `denyGroups` case.
 *
 * Scope behaviour IS the shared builder's: `all` and a zero-length
 * `denyGroups` emit nothing (a user denied zero groups is unrestricted, NOT
 * denied everything), `denyAll` emits `AND false`.
 *
 * It used to inline the pre-container predicate correlated to `pi.media_id`.
 * This query's own type lists name containers as first-class items —
 * MUSIC_TYPES = ['track','album','artist'], VIDEO_TYPES =
 * ['movie','tv','episode','season'] — and no container row owns
 * `media_file_items` (0 of 19,836 on production, 2026-09-15), so that copy's
 * `NOT EXISTS (own files)` arm was unconditionally TRUE and the library axis
 * did nothing for a series, season, artist or album sitting in a playlist.
 */
function buildPlaylistItemLibraryFilter(
    sql: postgres.Sql,
    scope: LibraryScope,
): postgres.PendingQuery<postgres.Row[]> {
    // Both call sites join `media_items mi ON mi.id = pi.media_id`, so `mi` is
    // the playlist item's own row and the shared builder can dispatch on its
    // media_type.
    return buildLibraryAccessFilter(sql, scope, 'mi');
}

/**
 * Get playlist items with user's watched status.
 *
 * Unlike the playlist-list queries, this boundary filters the returned ROWS:
 * items whose only files sit in denied library groups, or that exceed the
 * viewer's age limit, are dropped. Critical on public / shared playlists where
 * the viewer differs from the owner.
 *
 * @param access - REQUIRED viewer boundary. There is no permissive default:
 *   a caller that genuinely wants every row (e.g. a mutation path rewriting the
 *   caller's own playlist, where filtering would leave stale rows behind) must
 *   pass `unrestrictedAccess()` explicitly.
 */
export async function getPlaylistItems(
    sql: postgres.Sql,
    playlistId: number,
    userId: UserId | null,
    itemType: 'music' | 'video' | undefined,
    access: MediaAccessBoundary,
    page: PlaylistItemsPage = { mode: 'offset' },
    sort: 'position' | 'added_at_desc' = 'position',
    /** Restrict to these entry ids (a mutation response needs only the rows it touched). */
    onlyEntryIds?: readonly number[],
): Promise<PlaylistItemRow[]> {
    const MUSIC_TYPES = ['track', 'album', 'artist'];
    const VIDEO_TYPES = ['movie', 'tv', 'episode', 'season'];

    const libraryFilter = buildPlaylistItemLibraryFilter(sql, access.library);
    const ageFilter = buildSeriesOwnedAgeRatingFilter(sql, access.age);

    // Keyset predicate over `(position ASC, id ASC)`. `position`/`id` are
    // `integer`; bind the cursor values pinned to TEXT (OID 25) and cast `::int`
    // so postgres.js ships the exact digits and Postgres parses them
    // server-side. Tuple comparison `(position, id) > (cp, ci)` is exactly the
    // rows AFTER the cursor in `position ASC, id ASC` order. See
    // keyset-cursor.builder.ts.
    const onlyEntryIdsPredicate = onlyEntryIds
        ? sql`AND pi.id = ANY(${[...onlyEntryIds]}::int[])`
        : sql``;
    const itemsCursorPredicate =
        page.mode === 'cursor'
            ? sql`AND (pi.position, pi.id) > (${sql.typed(page.cursor.position, PG_TEXT_OID)}::int, ${sql.typed(page.cursor.id, PG_TEXT_OID)}::int)`
            : sql``;
    // Offset mode keeps the historical `ORDER BY pi.position ASC` (byte-identical
    // result) unless `sort` opts into `added_at_desc`. Cursor mode stays on
    // `(position, id)` regardless of `sort` — the keyset predicate above is
    // built over exactly those two columns, so changing this ORDER BY without
    // changing that predicate would silently page wrong. The watchlist reads
    // through offset mode, so `added_at_desc` only ever applies there.
    const itemsOrderBy =
        page.mode === 'cursor'
            ? sql`ORDER BY pi.position ASC, pi.id ASC`
            : sort === 'added_at_desc'
              ? sql`ORDER BY pi.added_at DESC NULLS LAST, pi.id DESC`
              : sql`ORDER BY pi.position ASC`;
    // n+1 lookahead so the caller derives hasMore without a COUNT. Offset mode
    // fetches every row (handler slices) — unchanged.
    const itemsLimit = page.mode === 'cursor' ? sql`LIMIT ${page.limit + 1}` : sql``;

    const rows = userId
        ? await sql<PlaylistItemRow[]>`
            SELECT
                pi.id,
                pi.media_id::text AS media_id,
                (SELECT external_id FROM external_ids WHERE media_id = pi.media_id AND provider = ${getPrimaryExternalIdProvider()} AND media_type = CASE WHEN pi.season_number IS NOT NULL AND pi.episode_number IS NOT NULL THEN 'tv' ELSE mi.media_type END LIMIT 1) as primary_ext_id,
                CASE WHEN pi.season_number IS NOT NULL AND pi.episode_number IS NOT NULL THEN 'episode' ELSE mi.media_type END as media_type,
                pi.season_number,
                pi.episode_number,
                pi.title,
                pi.series_name,
                mi.custom_metadata->>'artist' AS artist,
                mi.parent_id::text AS parent_id,
                (SELECT parent.parent_id::text FROM media_items parent WHERE parent.id = mi.parent_id) AS artist_id,
                pi.overview,
                pi.poster_path,
                pi.position,
                pi.added_at,
                COALESCE(piw.watched, false) as watched,
                piw.watched_at,
                -- Real playback state (user_media_state), distinct from the
                -- playlist tick above. Joined on the PK (user_id, media_id) so
                -- this stays ONE query regardless of playlist size.
                --
                -- Both ms columns are bigint; clamp to int32 before the cast so
                -- a corrupt value can't overflow (mirrors getCwAuditRows).
                --
                -- The ums.user_id IS NULL guard is REQUIRED, not defensive:
                -- Postgres LEAST/GREATEST IGNORE null arguments, so a bare
                -- LEAST(ums.resume_position_ms, 2147483647) on a LEFT JOIN miss
                -- returns 2147483647 — every never-played item would report a
                -- ~24-day resume position. getCwAuditRows can omit the guard
                -- only because it inner-joins on resume_position_ms > 0.
                -- (No backticks in these comments: this is a tagged template.)
                CASE
                    WHEN ums.user_id IS NULL THEN NULL
                    ELSE LEAST(ums.resume_position_ms, 2147483647)::integer
                END AS resume_position_ms,
                -- Runtime fallback chain is deliberately ROW-LOCAL: the CW
                -- query's third fallback (longest probed media_files duration)
                -- is a correlated subquery, and this feed returns up to 1000
                -- rows before any LIMIT. ums.runtime_ms is recorded at session
                -- start, so anything with a resume position from our player
                -- already has it; mi.runtime_seconds covers the rest.
                --
                -- Runtime is ITEM METADATA, not watch state: it is emitted for
                -- EVERY row, including items the viewer has never played. The
                -- guard is on the coalesced runtime, NOT on ums.user_id — gating
                -- it on the state row meant a fresh playlist reported no
                -- durations at all, so a client could not total its runtime.
                --
                -- The NULL guard is still REQUIRED for the same reason as above:
                -- LEAST ignores nulls, so an item with neither runtime source
                -- would report 2147483647 ms (~24 days) instead of nothing.
                -- ::bigint is load-bearing. runtime_seconds is a plain int4 with no
                -- CHECK constraint, so int4*1000 RAISES 'integer out of range'
                -- (Postgres does not wrap) for runtime_seconds > 2147483 — and it
                -- raises while evaluating LEAST's argument, so the clamp cannot
                -- protect it. One corrupt row would 500 the entire playlist rather
                -- than just omit its duration. Widening to int8 makes the clamp the
                -- thing that actually bounds the value.
                --
                -- Both sources are guarded > 0 (not just NULLIF/IS NULL): a zero or
                -- negative runtime is 'unknown', not a real duration. Without the
                -- positivity check on ums.runtime_ms a corrupt negative session
                -- value would win the COALESCE and discard a perfectly good catalog
                -- runtime; without it on runtime_seconds, SQL would emit 0 and the
                -- transform would silently drop it, contradicting the schema.
                CASE
                    WHEN COALESCE(
                            CASE WHEN ums.runtime_ms > 0 THEN ums.runtime_ms END,
                            CASE WHEN mi.runtime_seconds > 0 THEN mi.runtime_seconds::bigint * 1000 END
                         ) IS NULL
                        THEN NULL
                    ELSE LEAST(
                        COALESCE(
                            CASE WHEN ums.runtime_ms > 0 THEN ums.runtime_ms END,
                            CASE WHEN mi.runtime_seconds > 0 THEN mi.runtime_seconds::bigint * 1000 END
                        ),
                        2147483647
                    )::integer
                END AS runtime_ms,
                ums.is_watched AS playback_watched,
                ums.last_event_at AS last_played_at
            FROM playlist_items pi
            JOIN media_items mi ON mi.id = pi.media_id
            LEFT JOIN playlist_item_watched piw ON piw.item_id = pi.id AND piw.user_id = ${userId}::uuid
            LEFT JOIN user_media_state ums ON ums.media_id = pi.media_id AND ums.user_id = ${userId}::uuid
            WHERE pi.playlist_id = ${playlistId}
            ${itemType === 'music' ? sql`AND mi.media_type IN ${sql(MUSIC_TYPES)}` : itemType === 'video' ? sql`AND mi.media_type IN ${sql(VIDEO_TYPES)}` : sql``}
            ${page.availableOnly ? sql`AND ${isAvailableExpr(sql)} AND mi.status = 'active' AND mi.is_dismissed = false` : sql``}
            ${libraryFilter}
            ${ageFilter}
            ${onlyEntryIdsPredicate}
            ${itemsCursorPredicate}
            ${itemsOrderBy}
            ${itemsLimit}
        `
        : await sql<PlaylistItemRow[]>`
            SELECT
                pi.id,
                pi.media_id::text AS media_id,
                (SELECT external_id FROM external_ids WHERE media_id = pi.media_id AND provider = ${getPrimaryExternalIdProvider()} AND media_type = CASE WHEN pi.season_number IS NOT NULL AND pi.episode_number IS NOT NULL THEN 'tv' ELSE mi.media_type END LIMIT 1) as primary_ext_id,
                CASE WHEN pi.season_number IS NOT NULL AND pi.episode_number IS NOT NULL THEN 'episode' ELSE mi.media_type END as media_type,
                pi.season_number,
                pi.episode_number,
                pi.title,
                pi.series_name,
                mi.custom_metadata->>'artist' AS artist,
                mi.parent_id::text AS parent_id,
                (SELECT parent.parent_id::text FROM media_items parent WHERE parent.id = mi.parent_id) AS artist_id,
                pi.overview,
                pi.poster_path,
                pi.position,
                pi.added_at,
                false as watched,
                NULL::text as watched_at,
                -- Anonymous branch: there is no viewer, so there is no playback
                -- state. Typed nulls keep the row shape identical to the
                -- authenticated branch.
                NULL::integer as resume_position_ms,
                -- Runtime is NOT user-specific, so the anonymous branch emits it
                -- too: a public/shared playlist viewed without auth still needs a
                -- total runtime. Only the three genuinely per-viewer fields stay
                -- null here.
                -- The > 0 test is NULL-safe (NULL > 0 is NULL, so it falls to
                -- ELSE) and covers the zero/negative cases too. ::bigint for the
                -- same overflow reason as the authenticated branch above.
                -- (No backticks in these comments: this is a tagged template.)
                CASE
                    WHEN mi.runtime_seconds > 0
                        THEN LEAST(mi.runtime_seconds::bigint * 1000, 2147483647)::integer
                    ELSE NULL
                END AS runtime_ms,
                NULL::boolean as playback_watched,
                NULL::timestamptz as last_played_at
            FROM playlist_items pi
            JOIN media_items mi ON mi.id = pi.media_id
            WHERE pi.playlist_id = ${playlistId}
            ${itemType === 'music' ? sql`AND mi.media_type IN ${sql(MUSIC_TYPES)}` : itemType === 'video' ? sql`AND mi.media_type IN ${sql(VIDEO_TYPES)}` : sql``}
            ${page.availableOnly ? sql`AND ${isAvailableExpr(sql)} AND mi.status = 'active' AND mi.is_dismissed = false` : sql``}
            ${libraryFilter}
            ${ageFilter}
            ${onlyEntryIdsPredicate}
            ${itemsCursorPredicate}
            ${itemsOrderBy}
            ${itemsLimit}
        `;
    return rows;
}

/**
 * Create a new playlist
 */
export async function createPlaylist(
    sql: postgres.Sql,
    userId: UserId,
    name: string,
    description: string | null,
    visibility: 'private' | 'public',
    playlistType: PlaylistTypeValue = 'general',
): Promise<PlaylistRow> {
    const rows = await sql<PlaylistRow[]>`
        INSERT INTO playlists (user_id, name, description, visibility, playlist_type)
        VALUES (${userId}::uuid, ${name}, ${description}, ${visibility}, ${playlistType})
        RETURNING id, user_id, (SELECT username FROM users WHERE id = user_id) AS owner_username, name, description, visibility, playlist_type, is_system, cover_image, created_at, updated_at, revision,
            (SELECT display_name FROM users WHERE id = user_id) AS owner_display_name,
            0::int AS item_count, 0::int AS member_count
    `;
    return rows[0];
}

/**
 * Update playlist metadata
 */
export async function updatePlaylist(
    sql: postgres.Sql,
    playlistId: number,
    updates: {
        name?: string;
        description?: string;
        visibility?: 'private' | 'public';
        playlistType?: PlaylistTypeValue;
    },
): Promise<PlaylistRow | null> {
    const hasUpdates =
        updates.name !== undefined ||
        updates.description !== undefined ||
        updates.visibility !== undefined ||
        updates.playlistType !== undefined;

    if (!hasUpdates) {
        return null;
    }

    const rows = await sql<PlaylistRow[]>`
        UPDATE playlists
        SET
            name = CASE WHEN is_system THEN name
                        ELSE COALESCE(${updates.name ?? null}, name) END,
            description = CASE WHEN ${updates.description !== undefined} THEN ${updates.description ?? null} ELSE description END,
            visibility = CASE WHEN is_system THEN visibility
                              ELSE COALESCE(${updates.visibility ?? null}, visibility) END,
            playlist_type = CASE WHEN is_system THEN playlist_type
                                 ELSE COALESCE(${updates.playlistType ?? null}, playlist_type) END,
            updated_at = NOW()
        WHERE id = ${playlistId}
        RETURNING id, user_id, (SELECT username FROM users WHERE id = user_id) AS owner_username, name, description, visibility, playlist_type, is_system, cover_image, created_at, updated_at, revision
    `;
    return rows[0] ?? null;
}

/**
 * Delete playlist
 */
export async function deletePlaylist(
    sql: postgres.Sql,
    playlistId: number,
    userId: UserId,
): Promise<boolean> {
    const rows = await sql`
        DELETE FROM playlists
        WHERE id = ${playlistId} AND user_id = ${userId}::uuid AND is_system = false
        RETURNING id
    `;
    return rows.length > 0;
}

/**
 * Delete playlist chat messages
 */
export async function deletePlaylistChatMessages(
    sql: postgres.Sql,
    playlistId: number,
): Promise<void> {
    await sql`
        DELETE FROM collaborative_chat_messages
        WHERE context_type = 'playlist' AND context_id = ${playlistId}
    `;
}

/**
 * Update playlist timestamp
 */
export async function touchPlaylist(
    sql: postgres.Sql,
    playlistId: number,
    bumpRevision = true,
): Promise<void> {
    await sql`
        UPDATE playlists SET updated_at = NOW(), revision = revision + ${bumpRevision ? 1 : 0} WHERE id = ${playlistId}
    `;
}

// =============================================================================
// Playlist Summary (for mutation responses)
// =============================================================================

export interface PlaylistSummary {
    revision: number;
    itemCount: number;
    updatedAt: string;
}

/**
 * Get lightweight playlist summary after a mutation.
 * Returns current item count and updatedAt as ISO 8601 string.
 * The playlist is assumed to exist (callers verify via getPlaylistContext).
 */
export async function getPlaylistSummary(
    sql: postgres.Sql,
    playlistId: number,
): Promise<PlaylistSummary> {
    const rows = await sql<{ item_count: number; revision: number; updated_at: string | Date }[]>`
        SELECT
            COUNT(pi.id)::int AS item_count,
            p.updated_at, p.revision
        FROM playlists p
        LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
        WHERE p.id = ${playlistId}
        GROUP BY p.id
    `;
    const row = rows[0];
    if (!row) {
        return { revision: 0, itemCount: 0, updatedAt: new Date().toISOString() };
    }
    return {
        revision: row.revision,
        itemCount: row.item_count,
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    };
}

// =============================================================================
// Playlist Item Queries
// =============================================================================

/**
 * Get next position for new item.
 *
 * @deprecated Use `insertPlaylistItem` without an explicit `position` instead.
 * That overload computes the position atomically inside the INSERT, eliminating
 * the TOCTOU race between this read and the subsequent write.
 */
export async function getNextPosition(sql: postgres.Sql, playlistId: number): Promise<number> {
    const rows = await sql<{ next_position: number }[]>`
        SELECT COALESCE(MAX(position), -1) + 1 as next_position
        FROM playlist_items
        WHERE playlist_id = ${playlistId}
    `;
    return rows[0].next_position;
}

/**
 * Insert playlist item.
 *
 * When `position` is omitted the row's position is computed atomically inside
 * the INSERT via `COALESCE(MAX(position), -1) + 1`, which eliminates the
 * read-then-write race that exists when the caller calls `getNextPosition`
 * separately.  Pass an explicit `position` only when the caller already owns
 * a deterministic sequence (e.g. a full-replace loop that clears the playlist
 * first).
 */
export async function insertPlaylistItem(
    sql: postgres.Sql,
    params: {
        playlistId: number;
        mediaId: string;
        seasonNumber: number | null;
        episodeNumber: number | null;
        title: string;
        seriesName: string | null;
        overview: string | null;
        posterPath: string | null;
        position?: number;
    },
): Promise<InsertedItemRow | null> {
    if (params.position !== undefined) {
        const rows = await sql<InsertedItemRow[]>`
            INSERT INTO playlist_items (
                playlist_id, media_id,
                season_number, episode_number, title, series_name,
                overview, poster_path, position
            )
            VALUES (
                ${params.playlistId}, ${params.mediaId},
                ${params.seasonNumber}, ${params.episodeNumber}, ${params.title}, ${params.seriesName},
                ${params.overview}, ${params.posterPath}, ${params.position}
            )
            ON CONFLICT (playlist_id, media_id, COALESCE(season_number, -1), COALESCE(episode_number, -1))
            DO NOTHING
            RETURNING id, season_number, episode_number, title, series_name,
                      overview, poster_path, position, added_at
        `;
        return rows[0] ?? null;
    }

    const rows = await sql<InsertedItemRow[]>`
        INSERT INTO playlist_items (
            playlist_id, media_id,
            season_number, episode_number, title, series_name,
            overview, poster_path, position
        )
        SELECT
            ${params.playlistId}, ${params.mediaId},
            ${params.seasonNumber}, ${params.episodeNumber}, ${params.title}, ${params.seriesName},
            ${params.overview}, ${params.posterPath},
            COALESCE(MAX(position), -1) + 1
        FROM playlist_items
        WHERE playlist_id = ${params.playlistId}
        ON CONFLICT (playlist_id, media_id, COALESCE(season_number, -1), COALESCE(episode_number, -1))
        DO NOTHING
        RETURNING id, season_number, episode_number, title, series_name,
                  overview, poster_path, position, added_at
    `;
    return rows[0] ?? null;
}

/** One row to insert for {@link bulkInsertPlaylistItems}. */
export interface BulkInsertPlaylistItemInput {
    mediaId: string;
    seasonNumber: number | null;
    episodeNumber: number | null;
    title: string;
    seriesName: string | null;
    overview: string | null;
    posterPath: string | null;
}

/** {@link InsertedItemRow} plus `media_id`, so a caller can reconcile RETURNING rows back to input items. */
export interface BulkInsertedItemRow extends InsertedItemRow {
    media_id: string;
}

/**
 * Batch counterpart to {@link insertPlaylistItem} — inserts many rows in ONE
 * round trip via `INSERT ... SELECT ... FROM UNNEST(...) ... ON CONFLICT DO
 * NOTHING`, instead of one INSERT per item.
 *
 * Positions are assigned atomically INSIDE the statement, consecutively from
 * the playlist's current max position (mirroring `insertPlaylistItem`'s
 * no-explicit-`position` overload) — a row skipped by the conflict leaves a
 * gap in that sequence, so a caller MUST follow this with
 * `recalculatePositions` whenever it inserted at least one row (the same
 * pattern `bulk-delete.ts` already uses after a batch delete).
 *
 * `ON CONFLICT ... DO NOTHING` with a duplicate conflict key WITHIN the same
 * statement is safe in Postgres (unlike `DO UPDATE`, which errors on a
 * repeat-touched row): the first-listed row for a given key is inserted, and
 * a later duplicate in the same batch simply conflicts against it and inserts
 * nothing. Callers MAY pass duplicate keys — the caller here dedupes anyway
 * so it can report a per-item `skipped` reason, but the query does not
 * require that.
 *
 * Returns only the rows that were ACTUALLY inserted — a row skipped by the
 * conflict (a pre-existing item, or a same-batch duplicate) is simply absent
 * from the result. The caller reconciles by (media_id, season_number,
 * episode_number).
 */
export async function bulkInsertPlaylistItems(
    sql: postgres.Sql,
    playlistId: number,
    items: readonly BulkInsertPlaylistItemInput[],
): Promise<BulkInsertedItemRow[]> {
    if (items.length === 0) return [];

    const mediaIds = items.map((i) => i.mediaId);
    const seasonNumbers = items.map((i) => i.seasonNumber);
    const episodeNumbers = items.map((i) => i.episodeNumber);
    const titles = items.map((i) => i.title);
    const seriesNames = items.map((i) => i.seriesName);
    const overviews = items.map((i) => i.overview);
    const posterPaths = items.map((i) => i.posterPath);

    return await sql<BulkInsertedItemRow[]>`
        INSERT INTO playlist_items (
            playlist_id, media_id,
            season_number, episode_number, title, series_name,
            overview, poster_path, position
        )
        SELECT
            ${playlistId}, v.media_id,
            v.season_number, v.episode_number, v.title, v.series_name,
            v.overview, v.poster_path,
            (SELECT COALESCE(MAX(position), -1) FROM playlist_items WHERE playlist_id = ${playlistId}) + v.ord
        FROM UNNEST(
            ${mediaIds}::uuid[],
            ${seasonNumbers}::int[],
            ${episodeNumbers}::int[],
            ${titles}::text[],
            ${seriesNames}::text[],
            ${overviews}::text[],
            ${posterPaths}::text[]
        ) WITH ORDINALITY AS v(
            media_id, season_number, episode_number, title, series_name,
            overview, poster_path, ord
        )
        ON CONFLICT (playlist_id, media_id, COALESCE(season_number, -1), COALESCE(episode_number, -1))
        DO NOTHING
        RETURNING id, media_id, season_number, episode_number, title, series_name,
                  overview, poster_path, position, added_at
    `;
}

/**
 * Delete a playlist item and atomically decrement the positions of all
 * subsequent items in one CTE, eliminating the TOCTOU race between a
 * separate `getItemPosition` read and the later reorder UPDATE.
 *
 * Returns the deleted row's position, or null when no row matched.
 */
export async function deletePlaylistItemAndReorder(
    sql: postgres.Sql,
    itemId: number,
    playlistId: number,
): Promise<number | null> {
    const rows = await sql<{ position: number }[]>`
        WITH deleted AS (
            DELETE FROM playlist_items
            WHERE id = ${itemId} AND playlist_id = ${playlistId}
            RETURNING position
        )
        UPDATE playlist_items
        SET position = position - 1
        WHERE playlist_id = ${playlistId}
          AND position > (SELECT position FROM deleted)
        RETURNING (SELECT position FROM deleted) AS position
    `;
    if (rows.length === 0) {
        const deletedOnly = await sql<{ position: number }[]>`
            WITH deleted AS (
                DELETE FROM playlist_items
                WHERE id = ${itemId} AND playlist_id = ${playlistId}
                RETURNING position
            )
            SELECT position FROM deleted
        `;
        return deletedOnly[0]?.position ?? null;
    }
    return rows[0].position;
}

/**
 * Get item position before deletion
 */
export async function getItemPosition(
    sql: postgres.Sql,
    itemId: number,
    playlistId: number,
): Promise<number | null> {
    const rows = await sql<{ position: number }[]>`
        SELECT position
        FROM playlist_items
        WHERE id = ${itemId} AND playlist_id = ${playlistId}
    `;
    return rows[0]?.position ?? null;
}

/**
 * Delete playlist item
 */
export async function deletePlaylistItem(
    sql: postgres.Sql,
    itemId: number,
    playlistId: number,
): Promise<boolean> {
    const rows = await sql`
        DELETE FROM playlist_items
        WHERE id = ${itemId} AND playlist_id = ${playlistId}
        RETURNING id
    `;
    return rows.length > 0;
}

/**
 * Reorder items after deletion (fill gap)
 */
export async function reorderItemsAfterDelete(
    sql: postgres.Sql,
    playlistId: number,
    deletedPosition: number,
): Promise<void> {
    await sql`
        UPDATE playlist_items
        SET position = position - 1
        WHERE playlist_id = ${playlistId} AND position > ${deletedPosition}
    `;
}

/** One row of {@link getPlaylistEntries}. */
export interface PlaylistEntryRow {
    id: number;
    media_id: string;
    position: number;
}

/**
 * Every entry of a playlist in display order, unfiltered by any viewer
 * boundary. For mutation paths that must see all rows (reorder, bulk remove,
 * full replace): filtering here would leave hidden rows behind or shift
 * positions around them. Never return these rows to a client as-is.
 */
export async function getPlaylistEntries(
    sql: postgres.Sql,
    playlistId: number,
): Promise<PlaylistEntryRow[]> {
    return sql<PlaylistEntryRow[]>`
        SELECT id, media_id, position
        FROM playlist_items
        WHERE playlist_id = ${playlistId}
        ORDER BY position ASC, id ASC
    `;
}

/**
 * Verify items belong to playlist
 */
export async function verifyItemsBelongToPlaylist(
    sql: postgres.Sql,
    playlistId: number,
    itemIds: number[],
): Promise<number[]> {
    const rows = await sql<{ id: number }[]>`
        SELECT id
        FROM playlist_items
        WHERE playlist_id = ${playlistId} AND id = ANY(${itemIds}::int[])
    `;
    return rows.map((r) => r.id);
}

/**
 * Update item position
 */
export async function updateItemPosition(
    sql: postgres.Sql,
    itemId: number,
    playlistId: number,
    position: number,
): Promise<void> {
    await sql`
        UPDATE playlist_items
        SET position = ${position}
        WHERE id = ${itemId} AND playlist_id = ${playlistId}
    `;
}

/**
 * Bulk delete playlist items
 */
export async function bulkDeletePlaylistItems(
    sql: postgres.Sql,
    playlistId: number,
    itemIds: number[],
): Promise<number> {
    const rows = await sql`
        DELETE FROM playlist_items
        WHERE playlist_id = ${playlistId} AND id = ANY(${itemIds}::int[])
        RETURNING id
    `;
    return rows.length;
}

/**
 * Recalculate all positions (after bulk delete)
 */
export async function recalculatePositions(sql: postgres.Sql, playlistId: number): Promise<void> {
    await sql`
        WITH ordered AS (
            SELECT id, ROW_NUMBER() OVER (ORDER BY position) - 1 AS new_position
            FROM playlist_items
            WHERE playlist_id = ${playlistId}
        )
        UPDATE playlist_items pi
        SET position = ordered.new_position
        FROM ordered
        WHERE pi.id = ordered.id
    `;
}

// =============================================================================
// Watched Status Queries
// =============================================================================

/**
 * Verify playlist item exists
 */
export async function verifyItemExists(
    sql: postgres.Sql,
    itemId: number,
    playlistId: number,
): Promise<boolean> {
    const rows = await sql`
        SELECT id
        FROM playlist_items
        WHERE id = ${itemId} AND playlist_id = ${playlistId}
    `;
    return rows.length > 0;
}

/**
 * Upsert watched status for item
 */
export async function upsertWatchedStatus(
    sql: postgres.Sql,
    playlistId: number,
    itemId: number,
    userId: UserId,
    watched: boolean,
): Promise<{ watched: boolean; watched_at: string | Date | null }> {
    const rows = await sql<{ watched: boolean; watched_at: string | Date | null }[]>`
        INSERT INTO playlist_item_watched (playlist_id, item_id, user_id, watched, watched_at)
        VALUES (${playlistId}, ${itemId}, ${userId}::uuid, ${watched}, ${watched ? sql`NOW()` : null})
        ON CONFLICT (item_id, user_id)
        DO UPDATE SET
            watched = EXCLUDED.watched,
            watched_at = CASE WHEN EXCLUDED.watched THEN NOW() ELSE NULL END
        RETURNING watched, watched_at
    `;
    return rows[0];
}

// =============================================================================
// Per-user playlist view state (collapsed series/season groups)
// =============================================================================

/**
 * Stable collapsed-group keys for a playlist's grouped view. Series keys are
 * provider-agnostic (external id or series name); season keys are
 * `${seriesKey}-S${n}`. Stored as jsonb in playlist_view_state.collapsed_groups.
 */
export type CollapsedGroups = {
    series: string[];
    season: string[];
};

/** Defensively coerce a jsonb value into the CollapsedGroups shape. */
function normalizeCollapsedGroups(value: unknown): CollapsedGroups {
    const record = (value ?? {}) as Record<string, unknown>;
    const toStringArray = (x: unknown): string[] =>
        Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [];
    return { series: toStringArray(record.series), season: toStringArray(record.season) };
}

/**
 * Resolve the collapsed groups a user should see for a playlist.
 *
 * Inheritance is resolved here, not stored: prefer the requesting user's own
 * saved row; otherwise fall back to the OWNER's row so a freshly-invited viewer
 * inherits everything the owner collapsed. An anonymous viewer (no userId)
 * always gets the owner's view. Returns empty groups when neither row exists.
 */
export async function getEffectiveCollapsedGroups(
    sql: postgres.Sql,
    playlistId: number,
    userId: string | null,
    ownerUserId: string,
): Promise<CollapsedGroups> {
    const ids = userId && userId !== ownerUserId ? [userId, ownerUserId] : [ownerUserId];
    const rows = await sql<Array<{ user_id: string; collapsed_groups: unknown }>>`
        SELECT user_id, collapsed_groups
        FROM playlist_view_state
        WHERE playlist_id = ${playlistId} AND user_id = ANY(${ids}::uuid[])
    `;
    const own = userId ? rows.find((r) => r.user_id === userId) : undefined;
    const owner = rows.find((r) => r.user_id === ownerUserId);
    const chosen = own ?? owner;
    return chosen ? normalizeCollapsedGroups(chosen.collapsed_groups) : { series: [], season: [] };
}

/**
 * Upsert the requesting user's own collapsed-groups row for a playlist. A user
 * may only ever write their OWN row (keyed by user_id), so this is inherently
 * safe regardless of playlist role — and it never touches the playlist itself.
 */
export async function upsertPlaylistViewState(
    sql: postgres.Sql,
    playlistId: number,
    userId: string,
    groups: CollapsedGroups,
): Promise<void> {
    await sql`
        INSERT INTO playlist_view_state (playlist_id, user_id, collapsed_groups, updated_at)
        VALUES (${playlistId}, ${userId}::uuid, ${sql.json(groups)}, NOW())
        ON CONFLICT (playlist_id, user_id)
        DO UPDATE SET
            collapsed_groups = EXCLUDED.collapsed_groups,
            updated_at = NOW()
    `;
}

// =============================================================================
// Member Queries
// =============================================================================

/**
 * Get playlist members
 */
export async function getPlaylistMembers(
    sql: postgres.Sql,
    playlistId: number,
    page: PlaylistMembersPage = { mode: 'offset' },
): Promise<PlaylistMemberRow[]> {
    // Keyset predicate over the feed's real compound order
    // `(status ASC, invited_at DESC NULLS FIRST, user_id DESC)`.
    //   • `status > cursor.status` advances into every later status group whole
    //     ('accepted' < 'pending' lexically, matching status ASC).
    //   • within the SAME status the branch depends on the cursor's group:
    //       - Gate D2b NULL group (cursor.invitedAt === null): NULLs sort FIRST
    //         under `DESC`, so the rows after such a cursor are the remaining
    //         NULL rows (smaller user_id) PLUS every non-NULL row in that status
    //         — the NULL tail is CARRIED, never excluded.
    //       - value group: strictly-after non-NULL rows by
    //         `(invited_at, user_id) < (cursor.invitedAt, cursor.userId)`, with
    //         `invited_at` bound as micro-precision TEXT (pgTextTimestamp) so a
    //         boundary row sharing the millisecond is never skipped.
    let membersCursorPredicate = sql``;
    if (page.mode === 'cursor') {
        const c = page.cursor;
        membersCursorPredicate =
            c.invitedAt === null
                ? sql`AND (
                        pm.status > ${c.status}
                        OR (pm.status = ${c.status} AND (
                            (pm.invited_at IS NULL AND pm.user_id < ${c.userId}::uuid)
                            OR pm.invited_at IS NOT NULL
                        ))
                    )`
                : sql`AND (
                        pm.status > ${c.status}
                        OR (pm.status = ${c.status}
                            AND pm.invited_at IS NOT NULL
                            AND (pm.invited_at, pm.user_id) < (${pgTextTimestamp(sql, c.invitedAt)}::timestamptz, ${c.userId}::uuid))
                    )`;
    }
    // Offset mode keeps the historical `status ASC, invited_at DESC`
    // (byte-identical). Cursor mode adds the `user_id DESC` tiebreak for a
    // deterministic total order the keyset predicate can page.
    const membersOrderBy =
        page.mode === 'cursor'
            ? sql`ORDER BY pm.status ASC, pm.invited_at DESC, pm.user_id DESC`
            : sql`ORDER BY pm.status ASC, pm.invited_at DESC`;
    const membersLimit = page.mode === 'cursor' ? sql`LIMIT ${page.limit + 1}` : sql``;

    // `invited_at_cursor` is always projected — offset callers ignore it; the
    // cursor def reads it to mint the next page token at micro precision.
    const rows = await sql<PlaylistMemberRow[]>`
        SELECT pm.user_id, u.username, pm.role, pm.status, pm.invited_at, pm.invited_at::text AS invited_at_cursor
        FROM playlist_members pm
        JOIN users u ON u.id = pm.user_id
        WHERE pm.playlist_id = ${playlistId}
        ${membersCursorPredicate}
        ${membersOrderBy}
        ${membersLimit}
    `;
    return rows;
}

/**
 * Invite member to playlist
 */
export async function inviteMember(
    sql: postgres.Sql,
    playlistId: number,
    userId: UserId,
    role: 'editor' | 'readonly',
): Promise<PlaylistMemberRow> {
    const rows = await sql<PlaylistMemberRow[]>`
        WITH ins AS (
            INSERT INTO playlist_members (playlist_id, user_id, role, status)
            VALUES (${playlistId}, ${userId}::uuid, ${role}, 'pending')
            ON CONFLICT (playlist_id, user_id)
            DO UPDATE SET role = EXCLUDED.role, invited_at = NOW()
            RETURNING user_id, role, status, invited_at
        )
        SELECT ins.user_id, u.username, ins.role, ins.status, ins.invited_at
        FROM ins
        JOIN users u ON u.id = ins.user_id
    `;
    return rows[0];
}

/**
 * Get playlist invite
 */
export async function getPlaylistInvite(
    sql: postgres.Sql,
    playlistId: number,
    userId: UserId,
): Promise<PlaylistInviteRow | null> {
    const rows = await sql<PlaylistInviteRow[]>`
        SELECT pm.id, pm.status, pm.role, p.name as playlist_name, p.user_id,
               COALESCE(owner.username, p.user_id::text) AS owner_username
        FROM playlist_members pm
        JOIN playlists p ON p.id = pm.playlist_id
        LEFT JOIN users owner ON owner.id = p.user_id
        WHERE pm.playlist_id = ${playlistId} AND pm.user_id = ${userId}::uuid
    `;
    return rows[0] ?? null;
}

/**
 * Accept playlist invite
 */
export async function acceptInvite(
    sql: postgres.Sql,
    playlistId: number,
    userId: UserId,
): Promise<void> {
    await sql`
        UPDATE playlist_members
        SET status = 'accepted'
        WHERE playlist_id = ${playlistId} AND user_id = ${userId}::uuid
    `;
}

/**
 * Delete playlist invite/membership
 */
export async function deleteInvite(
    sql: postgres.Sql,
    playlistId: number,
    userId: UserId,
): Promise<void> {
    await sql`
        DELETE FROM playlist_members
        WHERE playlist_id = ${playlistId} AND user_id = ${userId}::uuid
    `;
}

/**
 * Update member role
 */
export async function updateMemberRole(
    sql: postgres.Sql,
    playlistId: number,
    userId: UserId,
    role: 'editor' | 'readonly',
): Promise<PlaylistMemberRow | null> {
    const rows = await sql<PlaylistMemberRow[]>`
        WITH upd AS (
            UPDATE playlist_members
            SET role = ${role}
            WHERE playlist_id = ${playlistId} AND user_id = ${userId}::uuid
            RETURNING user_id, role, status, invited_at
        )
        SELECT upd.user_id, u.username, upd.role, upd.status, upd.invited_at
        FROM upd
        JOIN users u ON u.id = upd.user_id
    `;
    return rows[0] ?? null;
}

/**
 * Delete member from playlist
 */
export async function deleteMember(
    sql: postgres.Sql,
    playlistId: number,
    userId: UserId,
): Promise<boolean> {
    const rows = await sql`
        DELETE FROM playlist_members
        WHERE playlist_id = ${playlistId} AND user_id = ${userId}::uuid
        RETURNING user_id
    `;
    return rows.length > 0;
}

/**
 * Delete member's watched status
 */
export async function deleteMemberWatchedStatus(
    sql: postgres.Sql,
    playlistId: number,
    userId: UserId,
): Promise<void> {
    await sql`
        DELETE FROM playlist_item_watched
        WHERE playlist_id = ${playlistId} AND user_id = ${userId}::uuid
    `;
}

// =============================================================================
// Progress Queries
// =============================================================================

export interface PlaylistItemIdRow {
    id: number;
}

export interface MembershipCheckRow {
    exists: number;
}

export interface MemberProgressRow {
    user_id: string;
    /** Resolved login name from the `users` table (joined on user_id). */
    username: string;
    playlist_watched_count: number | null;
    last_watched_at: Date | null;
}

export interface ItemWatcherRow {
    item_id: number;
    user_id: string;
}

/**
 * Get the ids of a playlist's items (progress counting).
 */
export async function getPlaylistItemIds(
    sql: postgres.Sql,
    playlistId: number,
): Promise<PlaylistItemIdRow[]> {
    return sql<PlaylistItemIdRow[]>`
        SELECT pi.id
        FROM playlist_items pi
        WHERE pi.playlist_id = ${playlistId}
    `;
}

/**
 * Check if user is owner or accepted member of playlist
 */
export async function checkPlaylistMembership(
    sql: postgres.Sql,
    playlistId: number,
    userId: UserId,
): Promise<MembershipCheckRow[]> {
    const rows = await sql<MembershipCheckRow[]>`
        SELECT 1 as exists FROM playlists WHERE id = ${playlistId} AND user_id = ${userId}
        UNION
        SELECT 1 as exists FROM playlist_members WHERE playlist_id = ${playlistId} AND user_id = ${userId} AND status = 'accepted'
    `;
    return rows;
}

/**
 * Get member progress stats for a playlist
 */
export async function getMemberPlaylistProgress(
    sql: postgres.Sql,
    playlistId: number,
): Promise<MemberProgressRow[]> {
    const rows = await sql<MemberProgressRow[]>`
        WITH all_members AS (
            SELECT user_id FROM playlists WHERE id = ${playlistId}
            UNION
            SELECT user_id FROM playlist_members WHERE playlist_id = ${playlistId} AND status = 'accepted'
        )
        SELECT
            am.user_id,
            u.username,
            COUNT(piw.id) FILTER (WHERE piw.watched = true) as playlist_watched_count,
            MAX(piw.watched_at) as last_watched_at
        FROM all_members am
        JOIN users u ON u.id = am.user_id
        LEFT JOIN playlist_item_watched piw ON piw.user_id = am.user_id AND piw.playlist_id = ${playlistId}
        GROUP BY am.user_id, u.username
        ORDER BY am.user_id
    `;
    return rows;
}

/**
 * Get playlist item watchers (watched items per user)
 */
export async function getPlaylistItemWatchers(
    sql: postgres.Sql,
    playlistId: number,
): Promise<ItemWatcherRow[]> {
    const rows = await sql<ItemWatcherRow[]>`
        SELECT
            piw.item_id,
            piw.user_id
        FROM playlist_item_watched piw
        INNER JOIN playlist_items pi ON pi.id = piw.item_id
        WHERE pi.playlist_id = ${playlistId} AND piw.watched = true
    `;
    return rows;
}

export interface PlaylistWatchProgress {
    playlist_id: number;
    total_items: number;
    watched_items: number;
}

/**
 * Get watched item counts for a set of playlists for a given user.
 * Used to compute Played / PlayedPercentage in Jellyfin UserData responses.
 */
export async function getPlaylistWatchProgress(
    sql: postgres.Sql,
    playlistIds: number[],
    userId: UserId,
): Promise<PlaylistWatchProgress[]> {
    if (playlistIds.length === 0) return [];
    return sql<PlaylistWatchProgress[]>`
        SELECT
            pi.playlist_id,
            COUNT(pi.id)::int AS total_items,
            COUNT(piw.id) FILTER (WHERE piw.watched = true)::int AS watched_items
        FROM playlist_items pi
        LEFT JOIN playlist_item_watched piw
            ON piw.item_id = pi.id AND piw.user_id = ${userId}::uuid
        WHERE pi.playlist_id = ANY(${sql.array(playlistIds)}::int[])
        GROUP BY pi.playlist_id
    `;
}
