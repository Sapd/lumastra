// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Shared playlist and entry projections, including surface-aware artwork and playback state. */

import type postgres from 'postgres';
import {
    playlistImageSet,
    audiobookImageSet,
} from '$lib/server/services/image-descriptor/resources.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { getAudiobookImageRevisions } from '$lib/server/database/queries/resource-images.queries.js';
import { userImageSets } from '$lib/server/services/image-descriptor/avatars.js';
import type {
    PlaylistRow,
    CoverItemRow,
    PlaylistItemRow,
    InsertedItemRow,
} from '$lib/server/database/queries/playlists.queries';
import type { Playlist, PlaylistEntry, PlaylistCoverItem } from '$lib/types/api-playlists';
import type { PlaylistRole } from '$lib/server/utils/playlist-utils';
import { toPublicAuthor } from './public-author.js';
import type { PartialExternalIds } from '$lib/schemas/common';
import { getPrimaryExternalIdProvider } from './provider-config.js';
import { createExternalIds } from '$lib/utils/external-ids.js';
import { entityImageUrl, type ApiSurface } from '$lib/shared/api-urls.js';

/**
 * Remap the internal series token onto the public one for playlist rows.
 *
 * `playlist_items` joins `media_items.media_type`, which stores `tv`, and these
 * transforms cast it straight into the response — so `GET /playlists/{id}/items`
 * emitted `tv` while `playlistItemInfo` (built by a different handler) already
 * emitted `series` for the same row.
 *
 * Inline rather than toPublicMediaType(): playlists legitimately hold `artist`,
 * `album`, `track` and `music` rows, which a converter maps to null — and the
 * standing precedent on null is to DROP the item, which would silently empty a
 * music playlist. Only the one token needs remapping. See
 * docs/dev/media-type-vocabulary.md, "When a hand-written conversion IS correct".
 */
function toPublicItemType<T extends string>(mediaType: T): Exclude<T, 'tv'> | 'series' {
    // The cast is what makes the remap type-visible: the runtime check removes
    // 'tv' from the inhabited set, but TS cannot narrow a generic parameter by
    // an equality test, so `T | 'series'` would keep 'tv' in the return union
    // and every call site would fail against the (tv-free) public enum.
    return (mediaType === 'tv' ? 'series' : mediaType) as Exclude<T, 'tv'> | 'series';
}

/**
 * Transform cover item row to API response shape
 */
export function transformCoverItemRow(item: CoverItemRow): PlaylistCoverItem {
    const externalIds = createExternalIds({
        [getPrimaryExternalIdProvider()]: item.primary_ext_id,
        internal: item.internal_id ?? undefined,
    });

    return {
        externalIds,
        mediaType: toPublicItemType(item.media_type as 'movie' | 'tv' | 'episode'),
        position: item.position,
    };
}

/**
 * Transform playlist row to API response shape
 */
export function transformPlaylistRow(
    row: PlaylistRow,
    role: PlaylistRole,
    surface: ApiSurface,
): Playlist {
    const createdAt =
        row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
    const updatedAt =
        row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at;
    const itemCount =
        typeof row.item_count === 'string' ? Number.parseInt(row.item_count, 10) : row.item_count;
    const memberCount =
        typeof row.member_count === 'string'
            ? Number.parseInt(row.member_count, 10)
            : row.member_count;

    const playlistType = row.playlist_type ?? 'general';
    // cover_items are already access-filtered by coverItemsSubquery. Square
    // collage tiles suit album art; movie/series posters are 2:3 and would crop.
    const images = playlistImageSet(
        surface,
        row.cover_image,
        (row.cover_items ?? []).flatMap((item) =>
            item.internal_id ? [{ id: item.internal_id, revision: item.poster_url ?? '0' }] : [],
        ),
    );

    return {
        id: row.id,
        owner: toPublicAuthor(
            { userId: row.user_id, displayName: row.owner_display_name ?? null },
            surface,
        ),
        revision: row.revision,
        memberCount: memberCount ?? 0,
        name: row.name,
        description: row.description ?? null,
        visibility: row.visibility,
        playlistType,
        isSystem: row.is_system === true,
        images,
        createdAt,
        updatedAt,
        role: role || 'readonly',
        itemCount: itemCount ?? 0,
        coverItems: (row.cover_items || [])
            .filter(
                // Keep items that can resolve an image: a primary ext-id or a
                // poster (movies/TV), OR a music item (track/album/artist) which
                // resolves via the catalog route by internal UUID.
                (item): item is CoverItemRow & { media_type: string } =>
                    item.media_type !== null &&
                    (item.primary_ext_id !== null ||
                        item.poster_url !== null ||
                        ['track', 'album', 'artist'].includes(item.media_type.toLowerCase())),
            )
            .map(transformCoverItemRow),
    };
}

/**
 * The viewer's playback state for one playlist row, projected to the wire shape.
 *
 * Whole seconds, identical to what the continue-watching envelope emits, so any
 * client can draw the same progress bar and offer resume-from-position wherever
 * playlist rows appear.
 */
export interface PlaylistItemPlaybackState {
    positionSeconds?: number;
    durationMs?: number;
    lastPlayedAt?: string;
    playbackWatched?: boolean;
}

/**
 * Project the user_media_state columns on a playlist row into the wire shape.
 *
 * Shared by BOTH playlist surfaces that expose rows to a player —
 * `transformPlaylistItemRow` (GET /playlists/{id}/items) and the browserItems
 * mapping in defs/playlists/[id]/playback-context.ts. They deliberately call the
 * same function: the two feeds returned divergent playback information once
 * already, and a client switching between the detail screen and the in-player
 * panel must not see the progress bar change.
 *
 * `positionSeconds` / `lastPlayedAt` / `playbackWatched` are ABSENT (never
 * null/0) when the viewer has no state row for the item — anonymous request,
 * never played, or music (music playback lives in user_music_state).
 *
 * `durationMs` is the exception and is deliberately NOT gated on the state
 * row: runtime is item metadata, not watch state. It is emitted for every item
 * that has a runtime from either source, so a client can total a playlist's
 * runtime without anyone having played it. It is absent only when neither
 * source has a runtime, which makes such a total a LOWER BOUND.
 *
 * NOTE the naming collision this deliberately avoids: `position` is the slot in
 * the playlist, `positionSeconds` is the playback position.
 */
export function projectPlaybackState(row: PlaylistItemRow): PlaylistItemPlaybackState {
    const durationMs = row.runtime_ms == null ? null : Number(row.runtime_ms);
    const durationSeconds =
        durationMs != null && durationMs > 0 ? Math.round(durationMs / 1000) : undefined;

    const positionMs = row.resume_position_ms == null ? null : Number(row.resume_position_ms);
    // Clamp to duration so the client's `duration - position` can never go
    // negative — mirrors rowToItem() in defs/recommendations/continue-watching.
    const positionSeconds =
        positionMs == null
            ? undefined
            : durationSeconds !== undefined
              ? Math.min(Math.round(positionMs / 1000), durationSeconds)
              : Math.round(positionMs / 1000);

    const lastPlayedAt =
        row.last_played_at instanceof Date
            ? row.last_played_at.toISOString()
            : (row.last_played_at ?? undefined);

    return {
        positionSeconds,
        durationMs: durationMs != null && durationMs > 0 ? durationMs : undefined,
        lastPlayedAt,
        // Completion cannot be inferred from positionSeconds alone: an
        // auto-completed item has its resume position ZEROED, so a finished
        // movie and an untouched one both report 0. This flag is what
        // separates them — and it is the REAL watched state, unlike the
        // playlist-scoped manual `watched` tick that sits beside it.
        playbackWatched: row.playback_watched ?? undefined,
    };
}

/**
 * Internal series UUID for a playlist row. Episodes: the grandparent (the items
 * query exposes it as `artist_id`, named for the music hierarchy), or the parent
 * for a flat episode filed directly under its series. A series row is its own
 * series. Anything else has none.
 */
function playlistRowSeriesId(row: PlaylistItemRow): string | undefined {
    if (row.media_type === 'episode') return row.artist_id ?? row.parent_id ?? undefined;
    if (row.media_type === 'tv' || row.media_type === 'series') return row.media_id;
    return undefined;
}

/**
 * Transform playlist item row to API response shape.
 *
 * `surface` comes from `ctx.surface` at the def that renders the feed. It is
 * REQUIRED because `posterPath` is now a GENERATED entity-image URL rather than
 * the raw stored `playlist_items.poster_path`: the stored value is whatever the
 * ingest happened to write at insert time (a bare TMDB path, an absolute
 * upstream URL, or nothing at all), so it was neither surface-aware nor
 * base-path-aware and gave clients a third image shape to special-case. See
 * `$lib/shared/api-urls.ts`.
 */
export function transformPlaylistItemRow(row: PlaylistItemRow, surface: ApiSurface): PlaylistEntry {
    return {
        id: row.id,
        mediaId: row.media_id,
        mediaType: toPublicItemType(
            row.media_type as 'movie' | 'tv' | 'episode' | 'artist' | 'album' | 'track' | 'music',
        ),
        seriesId: playlistRowSeriesId(row),
        seasonNumber: row.season_number ?? undefined,
        episodeNumber: row.episode_number ?? undefined,
        title: row.title,
        seriesName: row.series_name ?? undefined,
        artist: row.artist ?? undefined,
        artistId: row.artist_id ?? undefined,
        parentId: row.parent_id ?? undefined,
        overview: row.overview ?? undefined,
        // `playlist_items.media_id` is `uuid NOT NULL` AND the items query
        // INNER JOINs media_items on it, so a row without one cannot reach here.
        // The guard keeps a hypothetical hand-built row from emitting a URL with
        // a literal `null`/`undefined` id in it rather than omitting the field.
        //
        // `thumb` matches what every current consumer wants: the playlist detail
        // page renders these as list thumbnails and its own fallback path asks
        // for `{ size: 'thumb' }` (routes/playlists/[id]/+page.svelte), as does
        // the in-player PlaylistBrowser.
        posterPath: row.media_id
            ? entityImageUrl(row.media_id, 'poster', surface, { size: 'thumb' })
            : undefined,
        position: row.position,
        addedAt: row.added_at instanceof Date ? row.added_at.toISOString() : row.added_at,
        watched: row.watched,
        watchedAt: row.watched_at ?? undefined,
        ...projectPlaybackState(row),
    };
}

/**
 * Transform freshly inserted item row to API response shape
 * Uses input values for fields not stored in database (externalIds, mediaType, seriesExternalIds)
 */
export function transformInsertedItemRow(
    row: InsertedItemRow,
    inputExternalIds: PartialExternalIds,
    inputMediaType: string,
    surface: ApiSurface,
    inputSeriesExternalIds?: PartialExternalIds,
): PlaylistEntry {
    return {
        id: row.id,
        mediaId: inputExternalIds.internal!,
        mediaType: toPublicItemType(inputMediaType as 'movie' | 'tv' | 'episode'),
        seasonNumber: row.season_number ?? undefined,
        episodeNumber: row.episode_number ?? undefined,
        seriesId: inputSeriesExternalIds?.internal,
        title: row.title,
        seriesName: row.series_name ?? undefined,
        overview: row.overview ?? undefined,
        // Generated, exactly as in transformPlaylistItemRow — the create (201) and
        // list (200) bodies must agree. InsertedItemRow carries no media_id, but the
        // caller's resolved internal UUID is the same value.
        posterPath: inputExternalIds.internal
            ? entityImageUrl(inputExternalIds.internal, 'poster', surface, { size: 'thumb' })
            : undefined,
        position: row.position,
        addedAt: row.added_at instanceof Date ? row.added_at.toISOString() : row.added_at,
        watched: false,
        watchedAt: undefined,
    };
}

export interface PlaylistImageEntry {
    row: PlaylistRow;
    role: PlaylistRole;
}

/** Resolve authorized list artwork once; preserve each entry's order and role. */
export async function playlistsWithImages(
    sql: postgres.Sql,
    entries: PlaylistImageEntry[],
    surface: ApiSurface,
): Promise<Playlist[]> {
    if (!entries.length) return [];
    const memberIds = [
        ...new Set(
            entries.flatMap(({ row }) =>
                (row.cover_items ?? []).flatMap((item) =>
                    item.internal_id ? [item.internal_id] : [],
                ),
            ),
        ),
    ];
    const ownerIds = [...new Set(entries.map(({ row }) => row.user_id))];
    const [images, avatars, audiobookRevisions] = await Promise.all([
        resolveImageSets(
            sql,
            surface,
            memberIds.map((id) => ({ id })),
        ),
        userImageSets(sql, surface, ownerIds, { external: false }),
        getAudiobookImageRevisions(sql, memberIds),
    ]);
    return entries.map(({ row, role }) => {
        const result = transformPlaylistRow(row, role, surface);
        // Only the reads are deduplicated. Keep the original per-playlist member
        // sequence, including repeats, for the collage URL and revision.
        const members = (row.cover_items ?? []).flatMap((item) =>
            item.internal_id ? [{ id: item.internal_id }] : [],
        );
        result.images = playlistImageSet(
            surface,
            row.cover_image,
            members.flatMap(({ id }) => {
                const image =
                    images.get(id)?.poster ??
                    images.get(id)?.primary ??
                    (audiobookRevisions.has(id)
                        ? audiobookImageSet(surface, id, audiobookRevisions.get(id)!).primary
                        : undefined);
                return image ? [{ id, revision: image.revision }] : [];
            }),
            row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
        );
        result.owner = toPublicAuthor(
            { userId: row.user_id, displayName: row.owner_display_name ?? null },
            surface,
            avatars.get(row.user_id),
        );
        return result;
    });
}

/** Single-resource response boundary, sharing the list projection. */
export async function playlistWithImages(
    sql: postgres.Sql,
    row: PlaylistRow,
    role: PlaylistRole,
    surface: ApiSurface,
): Promise<Playlist> {
    return (await playlistsWithImages(sql, [{ row, role }], surface))[0];
}

/** Entries the video player can navigate to: a catalog movie/series/episode. */
export function isPlayableVideoEntry(item: {
    media_id: string | null;
    media_type: string;
}): boolean {
    return (
        !!item.media_id &&
        (item.media_type === 'movie' || item.media_type === 'tv' || item.media_type === 'episode')
    );
}
