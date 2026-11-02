// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { PageBlockSchema } from './pagination';
import { PlaybackProgressSchema } from './api-playback-progress';

export const SyncCatalogKindSchema = z
    .enum(['movie', 'series', 'season', 'episode', 'artist', 'album', 'track', 'audiobook'])
    .describe('Catalog kind used to hydrate the id through media/batch.');
export const SyncUserKindSchema = z
    .enum(['watch_state', 'listen_state', 'rating', 'watchlist', 'playlist'])
    .describe('Caller-owned state projection.');
export const SyncKindSchema = z.union([SyncCatalogKindSchema, SyncUserKindSchema]);
export const SyncErrorReasonSchema = z
    .enum(['cursor_expired', 'access_changed', 'log_reset', 'invalid_cursor'])
    .describe('Reason the client must discard its cursor and reload.');
const timestamp = z.iso.datetime({ offset: true }).nullable();
export const SyncWatchStateSchema = z
    .object({
        progress: PlaybackProgressSchema,
        playCount: z.number().int().describe('Completed plays.'),
        favorite: z.boolean(),
        lastWatchedAt: timestamp,
    })
    .describe(
        'Watch state of a video or audiobook. Positions move in steps of at least 30 s; batch hydrate returns the exact progress.',
    )
    .meta({ id: 'SyncWatchState' });
export const SyncListenStateSchema = z
    .object({
        playCount: z.number().int(),
        skipCount: z.number().int(),
        completeCount: z.number().int(),
        lastPlayedAt: timestamp,
    })
    .describe('Listening counters of a track.')
    .meta({ id: 'SyncListenState' });
export const SyncRatingSchema = z
    .object({
        rating: z.number().int().min(1).max(10).describe('Explicit rating, 1 to 10.'),
        style: z.enum(['quick', 'stars']).nullable().describe('How the rating was given.'),
    })
    .describe("The caller's explicit rating of an item.")
    .meta({ id: 'SyncRating' });
export const SyncWatchlistSchema = z
    .object({
        addedAt: timestamp.describe('Earliest entry for this item.'),
        entries: z
            .array(
                z.object({
                    seasonNumber: z.number().int().nullable(),
                    episodeNumber: z.number().int().nullable(),
                    addedAt: timestamp,
                }),
            )
            .describe('Every watchlist entry for this item (whole item, a season, or an episode).'),
    })
    .describe('Watchlist membership of an item.')
    .meta({ id: 'SyncWatchlist' });
export const SyncPlaylistSchema = z
    .object({
        revision: z
            .number()
            .int()
            .describe(
                'Playlist revision; refetch GET /playlists/{id} and its items when it differs.',
            ),
    })
    .describe('A playlist the caller owns or is an accepted member of.')
    .meta({ id: 'SyncPlaylist' });

/** Per-user state travels in one typed field named after its kind. */
const syncStateFields = {
    watchState: SyncWatchStateSchema.optional().describe(
        'Present on an upsert of kind watch_state.',
    ),
    listenState: SyncListenStateSchema.optional().describe(
        'Present on an upsert of kind listen_state.',
    ),
    rating: SyncRatingSchema.optional().describe('Present on an upsert of kind rating.'),
    watchlist: SyncWatchlistSchema.optional().describe('Present on an upsert of kind watchlist.'),
    playlist: SyncPlaylistSchema.optional().describe('Present on an upsert of kind playlist.'),
};
export const SYNC_STATE_FIELD = {
    watch_state: 'watchState',
    listen_state: 'listenState',
    rating: 'rating',
    watchlist: 'watchlist',
    playlist: 'playlist',
} as const;
export const SYNC_STATE_SCHEMA = {
    watch_state: SyncWatchStateSchema,
    listen_state: SyncListenStateSchema,
    rating: SyncRatingSchema,
    watchlist: SyncWatchlistSchema,
    playlist: SyncPlaylistSchema,
} as const;
export type SyncStateFields = {
    [K in keyof typeof syncStateFields]?: z.infer<
        (typeof SYNC_STATE_SCHEMA)[{
            watchState: 'watch_state';
            listenState: 'listen_state';
            rating: 'rating';
            watchlist: 'watchlist';
            playlist: 'playlist';
        }[K]]
    >;
};

export const SyncChangeSchema = z
    .object({
        kind: SyncKindSchema.describe(
            'Current kind, or the logged kind for a deleted item. Catalog kinds can change for an id: key catalog entries by id alone.',
        ),
        id: z
            .string()
            .describe(
                'Media UUID (catalog and media-keyed state kinds) or playlist id. Catalog entries are unique by id; state entries by (kind, id): a movie and its watch_state share the media UUID.',
            ),
        op: z
            .enum(['upsert', 'delete'])
            .describe(
                'upsert: you can see it now, fetch it or take the inline state. delete: drop it if you have it.',
            ),
        version: z
            .string()
            .regex(/^\d{20}:\d{20}$/)
            .describe(
                'Log position; compares as a string. Ignore an entry older than one you already applied for the same id.',
            ),
        ...syncStateFields,
    })
    .describe('The current state of one entity for the caller.')
    .meta({ id: 'SyncChange' });
export const SyncChangesResponseSchema = z
    .object({
        items: z
            .array(SyncChangeSchema)
            .describe('Changes visible to this caller, at most `limit`.'),
        page: PageBlockSchema.extend({
            nextCursor: z
                .string()
                .describe('Always store this checkpoint, including on empty terminal pages.'),
        }),
        initialLoad: z
            .array(
                z.object({
                    kind: SyncKindSchema,
                    href: z
                        .string()
                        .describe(
                            'First page of the initial load; follow page.nextCursor while page.hasMore is true.',
                        ),
                }),
            )
            .optional()
            .describe('Present only on the first call without a cursor.'),
    })
    .describe("One page of library changes below the server's stable horizon.")
    .meta({ id: 'SyncChangesResponse' });
export const SyncUserStateResponseSchema = z
    .object({
        items: z
            .array(z.object({ id: z.string(), ...syncStateFields }))
            .describe(
                'Current state, in id order. Exactly the field for the requested kind is set.',
            ),
        page: PageBlockSchema,
    })
    .describe("Keyset page of the caller's state of one kind.")
    .meta({ id: 'SyncUserStateResponse' });
export const SyncLibraryResponseSchema = z
    .object({
        items: z
            .array(
                z.object({
                    id: z.string().describe('Media UUID. Hydrate with POST /media/batch.'),
                }),
            )
            .describe(
                'Ids of the requested kind that are in your library and visible to you, in id order.',
            ),
        page: PageBlockSchema,
    })
    .describe(
        'Keyset page of library ids for the initial load. Same rules as the catalog entries of GET /sync/changes.',
    )
    .meta({ id: 'SyncLibraryResponse' });
export type SyncLibraryResponse = z.infer<typeof SyncLibraryResponseSchema>;
export type SyncKind = z.infer<typeof SyncKindSchema>;
export type SyncUserKind = z.infer<typeof SyncUserKindSchema>;
export type SyncChange = z.infer<typeof SyncChangeSchema>;
export type SyncErrorReason = z.infer<typeof SyncErrorReasonSchema>;
export type SyncChangesResponse = z.infer<typeof SyncChangesResponseSchema>;
export type SyncUserStateResponse = z.infer<typeof SyncUserStateResponseSchema>;
