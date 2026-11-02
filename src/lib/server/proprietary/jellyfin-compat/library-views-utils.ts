// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import {
    getDeniedLibraryGroups,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache';
import { JELLYFIN_SERVER_ID, LIVETV_VIRTUAL_FOLDER_ID } from './constants';
import { libraryImageTag } from './library-image-tag';
import type { JellyfinBaseItemDto } from './types';

// No 'audiobook' entry: the /j compat layer has no playback path for
// Audiobookshelf-backed items (PlaybackInfo/stream-file-handler only resolve
// media_files.file_path; audiobook content is served through a separate ABS
// proxy — see audiobook-stream-auth.ts). Exposing these as browsable
// libraries would let clients navigate in and then fail to play anything.
// Missing from this map = filtered out by every caller's `if (!collectionType)
// continue` (UserViews, VirtualFolders, Ancestors).
export const MEDIA_TYPE_TO_COLLECTION: Record<string, string> = {
    movie: 'movies',
    tv: 'tvshows',
    anime: 'tvshows',
    music: 'music',
    home_video: 'homevideos',
    training: 'homevideos',
    educational: 'homevideos',
    personal: 'homevideos',
};

export function lastSegment(path: string): string {
    const segments = path.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? path;
}

interface LibraryGroupRow {
    library_group_id: string;
    media_type: string;
    group_path: string;
    group_name: string | null;
    item_count: number;
}

/** Minimal shape of `locals.user` needed to scope library views. */
export interface LibraryViewUser {
    ownerIsAdmin?: boolean;
    userGroups?: string[];
    isAgeRestricted?: boolean;
    maxAgeRating?: number | null;
    hasLiveTvPermission?: boolean;
}

/**
 * Build the user's libraries as Jellyfin `CollectionFolder` items.
 *
 * Shared by `/j/UserViews` and the root `/j/Items` request (no parentId,
 * non-recursive, no selective filters). Real Jellyfin returns the user's
 * views for a top-level Items query — findroid's `getLibraries()` calls
 * `getItems(userId)` with no parentId and maps the result via
 * `toFindroidCollection`, so it must receive the libraries, not a recursive
 * dump of every media item.
 */
function imageTagsFor(libraryGroupId: string): Record<string, string> {
    const tag = libraryImageTag(libraryGroupId);
    return tag ? { Primary: tag, Thumb: tag } : {};
}

export async function buildLibraryViews(
    sql: postgres.Sql,
    user: LibraryViewUser,
): Promise<JellyfinBaseItemDto[]> {
    const maxAge = user.isAgeRestricted && user.maxAgeRating != null ? user.maxAgeRating : null;
    const allowUnrated = config.UNRATED_CONTENT_VISIBLE;
    const tvAgeCond =
        maxAge !== null
            ? sql`AND (series.age_rating IS NULL AND ${allowUnrated}::boolean OR series.age_rating <= ${maxAge})`
            : sql``;
    const musicAgeCond =
        maxAge !== null
            ? sql`AND (artist.age_rating IS NULL AND ${allowUnrated}::boolean OR artist.age_rating <= ${maxAge})`
            : sql``;
    const movieAgeCond =
        maxAge !== null
            ? sql`AND (mi_item.age_rating IS NULL AND ${allowUnrated}::boolean OR mi_item.age_rating <= ${maxAge})`
            : sql``;

    const groups = await sql<LibraryGroupRow[]>`
        SELECT
            lp.library_group_id,
            (array_agg(lp.media_type ORDER BY lp.created_at ASC))[1] as media_type,
            (array_agg(lp.path ORDER BY lp.created_at ASC))[1] as group_path,
            COALESCE(lg.display_name, lg.name) as group_name,
            COALESCE(counts.item_count, 0)::int as item_count
        FROM library_paths lp
        LEFT JOIN library_groups lg ON lg.id = lp.library_group_id
        LEFT JOIN LATERAL (
            SELECT COALESCE(
                -- For TV/anime: count distinct series via episode→season→series chain
                CASE WHEN lp.media_type IN ('tv', 'anime')
                THEN (
                    SELECT COUNT(DISTINCT series.id)::int
                    FROM media_file_items mfi
                    JOIN media_files mf ON mf.id = mfi.file_id
                    JOIN media_items ep ON ep.id = mfi.media_item_id
                    LEFT JOIN media_items season ON season.id = ep.parent_id
                    LEFT JOIN media_items series ON series.id = season.parent_id
                    WHERE mf.library_group_id = lp.library_group_id
                    ${tvAgeCond}
                )
                -- For music: count distinct artists
                WHEN lp.media_type = 'music'
                THEN (
                    SELECT COUNT(DISTINCT artist.id)::int
                    FROM media_file_items mfi
                    JOIN media_files mf ON mf.id = mfi.file_id
                    JOIN media_items track ON track.id = mfi.media_item_id
                    LEFT JOIN media_items album ON album.id = track.parent_id
                    LEFT JOIN media_items artist ON artist.id = album.parent_id
                    WHERE mf.library_group_id = lp.library_group_id
                    ${musicAgeCond}
                )
                -- For movies/other: count items directly
                ELSE (
                    SELECT COUNT(DISTINCT mi_item.id)::int
                    FROM media_file_items mfi
                    JOIN media_files mf ON mf.id = mfi.file_id
                    JOIN media_items mi_item ON mi_item.id = mfi.media_item_id
                    WHERE mf.library_group_id = lp.library_group_id
                    ${movieAgeCond}
                )
                END
            , 0) as item_count
        ) counts ON true
        WHERE lp.enabled = true
        GROUP BY lp.library_group_id, lg.display_name, lg.name, counts.item_count
        ORDER BY MIN(lp.created_at) ASC
    `;

    const denied = await getDeniedLibraryGroups(sql, toLibraryAccessUser(user));
    const deniedSet = new Set(denied ?? []);

    const items: JellyfinBaseItemDto[] = [];

    for (const group of groups) {
        if (deniedSet.has(group.library_group_id)) continue;

        const collectionType = MEDIA_TYPE_TO_COLLECTION[group.media_type];
        if (!collectionType) continue;

        const name = group.group_name ?? lastSegment(group.group_path);

        items.push({
            Name: name,
            Id: group.library_group_id,
            ServerId: JELLYFIN_SERVER_ID,
            Type: 'CollectionFolder',
            CollectionType: collectionType,
            IsFolder: true,
            MediaType: 'Unknown',
            LocationType: 'FileSystem',
            ChildCount: group.item_count,
            RecursiveItemCount: group.item_count,
            LocalTrailerCount: 0,
            SpecialFeatureCount: 0,
            PlayAccess: 'Full',
            UserData: {
                PlaybackPositionTicks: 0,
                PlayedPercentage: 0,
                PlayCount: 0,
                IsFavorite: false,
                Played: false,
                Key: group.library_group_id,
                ItemId: group.library_group_id,
            },
            // The library mosaic, behind a signed tag: /j/Items/{id}/Images is
            // public and cannot check who is asking, so it serves the mosaic
            // only for a tag minted here — for a group this user is not denied
            // (see library-image-tag.ts). No secret → no tag → the client
            // keeps its own placeholder, as before. No BackdropImageTags: the
            // image route has no /Images/Backdrop/{index} form.
            ImageTags: imageTagsFor(group.library_group_id),
            BackdropImageTags: [],
        });
    }

    // Live TV isn't a `library_paths` row — it's a separate provider-backed
    // system (see getLiveTvProvider) — so it never appears in `groups` above.
    // Clients (e.g. Moonfin) only show a Live TV nav entry when UserViews
    // contains an item with CollectionType 'livetv'; without this, /LiveTv/*
    // working correctly is invisible — there's nothing to navigate to it.
    if (config.FEATURE_LIVETV && user.hasLiveTvPermission) {
        items.push({
            Name: 'Live TV',
            Id: LIVETV_VIRTUAL_FOLDER_ID,
            ServerId: JELLYFIN_SERVER_ID,
            Type: 'CollectionFolder',
            CollectionType: 'livetv',
            IsFolder: true,
            MediaType: 'Unknown',
            LocationType: 'Virtual',
            ChildCount: 0,
            RecursiveItemCount: 0,
            LocalTrailerCount: 0,
            SpecialFeatureCount: 0,
            PlayAccess: 'Full',
            UserData: {
                PlaybackPositionTicks: 0,
                PlayedPercentage: 0,
                PlayCount: 0,
                IsFavorite: false,
                Played: false,
                Key: LIVETV_VIRTUAL_FOLDER_ID,
                ItemId: LIVETV_VIRTUAL_FOLDER_ID,
            },
            ImageTags: {},
            BackdropImageTags: [],
        });
    }

    return items;
}
