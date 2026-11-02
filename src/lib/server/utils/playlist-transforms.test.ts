// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for playlist response transformers.
 *
 * These are pure functions (no DB) that convert snake_case database rows into
 * the camelCase API shape. They cover both playlist types — video (movie / tv /
 * episode) and music (artist / album / track) — and the owner-username
 * resolution that falls back to the raw users.id UUID when a query did not
 * join the users table.
 */

import { describe, it, expect } from 'vitest';
import {
    transformPlaylistRow,
    transformCoverItemRow,
    transformPlaylistItemRow as transformPlaylistItemRowOnSurface,
    transformInsertedItemRow,
    projectPlaybackState,
    isPlayableVideoEntry,
} from './playlist-transforms';
import { getPrimaryExternalIdProvider } from './provider-config.js';
import type { PlaylistEntry } from '$lib/types/api-playlists';
import type {
    PlaylistRow,
    CoverItemRow,
    PlaylistItemRow,
    InsertedItemRow,
} from '$lib/server/database/queries/playlists.queries';

const PRIMARY = getPrimaryExternalIdProvider();

/**
 * The item transform is surface-aware: `posterPath` is GENERATED from
 * `media_id` per surface, not read from the stored `poster_path` column. Every
 * field below except `posterPath` is surface-independent, so those cases pin
 * the internal surface through this wrapper; the dedicated `posterPath` suite
 * calls the real two-argument function on BOTH surfaces.
 */
function transformPlaylistItemRow(row: PlaylistItemRow): PlaylistEntry {
    return transformPlaylistItemRowOnSurface(row, 'internal');
}

function makePlaylistRow(overrides: Partial<PlaylistRow> = {}): PlaylistRow {
    return {
        id: 1,
        revision: 0,
        user_id: '4de816a1-f799-4d73-8340-a71711273320',
        owner_username: 'alice',
        name: 'My Playlist',
        description: 'desc',
        visibility: 'private',
        playlist_type: 'general',
        cover_image: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        item_count: 3,
        cover_items: null,
        ...overrides,
    };
}

describe('transformPlaylistRow', () => {
    it('maps the core fields and the explicit role argument', () => {
        const result = transformPlaylistRow(makePlaylistRow(), 'owner', 'internal');
        expect(result.id).toBe(1);
        expect(result.revision).toBe(0);
        expect(result).not.toHaveProperty('ownerUsername');
        expect(result.name).toBe('My Playlist');
        expect(result.visibility).toBe('private');
        expect(result.role).toBe('owner');
    });

    it('uses the resolved owner_username when present', () => {
        const result = transformPlaylistRow(
            makePlaylistRow({ owner_username: 'alice' }),
            'owner',
            'internal',
        );
        expect(result.owner.displayName).toBeNull();
    });

    it('falls back to the user_id UUID when owner_username is absent', () => {
        // Some queries return a PlaylistRow without joining users (owner_username
        // undefined). The transform must degrade to the UUID rather than emit
        // `undefined` as the owner name.
        const row = makePlaylistRow({ owner_username: undefined });
        const result = transformPlaylistRow(row, 'owner', 'internal');
        expect(result.owner.userId).toBe('4de816a1-f799-4d73-8340-a71711273320');
    });

    it('defaults playlistType to "general" when undefined', () => {
        const result = transformPlaylistRow(
            makePlaylistRow({ playlist_type: undefined }),
            'owner',
            'internal',
        );
        expect(result.playlistType).toBe('general');
    });

    it.each(['music', 'video', 'general'] as const)('preserves playlistType "%s"', (type) => {
        const result = transformPlaylistRow(
            makePlaylistRow({ playlist_type: type }),
            'owner',
            'internal',
        );
        expect(result.playlistType).toBe(type);
    });

    it('coerces a string item_count to a number', () => {
        const result = transformPlaylistRow(
            makePlaylistRow({ item_count: '7' }),
            'owner',
            'internal',
        );
        expect(result.itemCount).toBe(7);
    });

    it('passes through a numeric item_count unchanged', () => {
        const result = transformPlaylistRow(
            makePlaylistRow({ item_count: 4 }),
            'owner',
            'internal',
        );
        expect(result.itemCount).toBe(4);
    });

    it('converts Date created_at / updated_at to ISO strings', () => {
        const result = transformPlaylistRow(
            makePlaylistRow({
                created_at: new Date('2026-03-04T05:06:07.000Z'),
                updated_at: new Date('2026-03-05T05:06:07.000Z'),
            }),
            'owner',
            'internal',
        );
        expect(result.createdAt).toBe('2026-03-04T05:06:07.000Z');
        expect(result.updatedAt).toBe('2026-03-05T05:06:07.000Z');
    });

    it('passes through string created_at / updated_at unchanged', () => {
        const result = transformPlaylistRow(makePlaylistRow(), 'owner', 'internal');
        expect(result.createdAt).toBe('2026-01-01T00:00:00.000Z');
        expect(result.updatedAt).toBe('2026-01-02T00:00:00.000Z');
    });

    it('maps null description and cover_image to undefined', () => {
        const result = transformPlaylistRow(
            makePlaylistRow({ description: null, cover_image: null }),
            'owner',
            'internal',
        );
        expect(result.description).toBeNull();
        expect(result.images.primary).toBeUndefined();
    });

    it('defaults role to "readonly" when null is passed', () => {
        const result = transformPlaylistRow(makePlaylistRow(), null, 'internal');
        expect(result.role).toBe('readonly');
    });

    it('filters cover items lacking media_type or any usable id, keeps the rest', () => {
        const coverItems: CoverItemRow[] = [
            // kept: has media_type + primary_ext_id
            {
                internal_id: 'uuid-1',
                primary_ext_id: '550',
                media_type: 'movie',
                poster_url: null,
                position: 0,
            },
            // kept: has media_type + poster_url (no ext id)
            {
                internal_id: 'uuid-2',
                primary_ext_id: null,
                media_type: 'tv',
                poster_url: '/poster.jpg',
                position: 1,
            },
            // dropped: media_type null
            {
                internal_id: 'uuid-3',
                primary_ext_id: '99',
                media_type: null,
                poster_url: '/x.jpg',
                position: 2,
            },
            // dropped: no primary_ext_id AND no poster_url
            {
                internal_id: 'uuid-4',
                primary_ext_id: null,
                media_type: 'movie',
                poster_url: null,
                position: 3,
            },
        ];
        const result = transformPlaylistRow(
            makePlaylistRow({ cover_items: coverItems }),
            'owner',
            'internal',
        );
        expect(result.coverItems).toHaveLength(2);
        expect(result.coverItems?.[0]?.mediaType).toBe('movie');
        // stored `tv` surfaces as the public `series` (see transformCoverItemRow)
        expect(result.coverItems?.[1]?.mediaType).toBe('series');
    });

    it('returns an empty coverItems array when cover_items is null', () => {
        const result = transformPlaylistRow(
            makePlaylistRow({ cover_items: null }),
            'owner',
            'internal',
        );
        expect(result.coverItems).toEqual([]);
    });

    it.each(['track', 'album', 'artist'] as const)(
        'keeps a music cover item of type "%s" with no ext-id or poster, on the strength of internal_id',
        (mediaType) => {
            const coverItems: CoverItemRow[] = [
                {
                    internal_id: 'uuid-music-1',
                    primary_ext_id: null,
                    media_type: mediaType,
                    poster_url: null,
                    position: 0,
                },
            ];
            const result = transformPlaylistRow(
                makePlaylistRow({ cover_items: coverItems }),
                'owner',
                'internal',
            );
            expect(result.coverItems).toHaveLength(1);
            expect(result.coverItems?.[0]?.mediaType).toBe(mediaType);
        },
    );

    it('still drops a non-music cover item with no ext-id, poster, or internal_id', () => {
        const coverItems: CoverItemRow[] = [
            {
                internal_id: null,
                primary_ext_id: null,
                media_type: 'movie',
                poster_url: null,
                position: 0,
            },
        ];
        const result = transformPlaylistRow(
            makePlaylistRow({ cover_items: coverItems }),
            'owner',
            'internal',
        );
        expect(result.coverItems).toHaveLength(0);
    });
});

describe('transformPlaylistRow — coverCollage', () => {
    const musicItem = (id: string | null, position: number): CoverItemRow => ({
        internal_id: id,
        primary_ext_id: null,
        media_type: 'track',
        poster_url: null,
        position,
    });

    it('builds a collage href set from a music playlist’s cover items, in order', () => {
        const result = transformPlaylistRow(
            makePlaylistRow({
                playlist_type: 'music',
                cover_items: [musicItem('t2', 0), musicItem('t1', 1)],
            }),
            'owner',
            'v1',
        );
        expect(result.images.primary?.variants?.card).toContain(
            '/api/v1/music/images/collage?ids=t2,t1&size=card&v=',
        );
    });

    it('omits the collage for non-music playlists (2:3 posters would crop badly)', () => {
        const result = transformPlaylistRow(
            makePlaylistRow({ playlist_type: 'video', cover_items: [musicItem('t1', 0)] }),
            'owner',
            'v1',
        );
        expect(result).not.toHaveProperty('coverCollage');
    });

    it('omits the collage when there are no cover items', () => {
        const result = transformPlaylistRow(
            makePlaylistRow({ playlist_type: 'music', cover_items: null }),
            'owner',
            'v1',
        );
        expect(result).not.toHaveProperty('coverCollage');
    });
});

describe('transformPlaylistRow — owner fields', () => {
    const baseRow = {
        id: 1,
        revision: 0,
        user_id: '11111111-2222-3333-4444-555555555555',
        owner_username: 'denis',
        name: 'Test',
        description: null,
        visibility: 'public' as const,
        playlist_type: 'video' as const,
        cover_image: null,
        created_at: '2026-07-21T00:00:00.000Z',
        updated_at: '2026-07-21T00:00:00.000Z',
        item_count: 3,
        cover_items: null,
    };

    it('maps owner id, display name and a UUID-keyed avatar url', () => {
        const result = transformPlaylistRow(
            { ...baseRow, owner_display_name: 'Denis A.', member_count: 2 },
            'readonly',
            'internal',
        );

        expect(result.owner.userId).toBe('11111111-2222-3333-4444-555555555555');
        expect(result.owner.displayName).toBe('Denis A.');
        expect(result.owner.images.primary.href).toBe(
            '/api/users/11111111-2222-3333-4444-555555555555/images/avatar?size=card&v=0&fallback=initials',
        );
        expect(result.memberCount).toBe(2);
    });

    it('omits display name when null rather than emitting null', () => {
        const result = transformPlaylistRow(
            { ...baseRow, owner_display_name: null },
            'readonly',
            'internal',
        );
        expect(result.owner.displayName).toBeNull();
    });

    it('omits memberCount when the query did not select it', () => {
        const result = transformPlaylistRow(baseRow, 'readonly', 'internal');
        expect(result.memberCount).toBe(0);
    });

    it('coerces a string member_count to a number', () => {
        const result = transformPlaylistRow(
            { ...baseRow, member_count: '5' },
            'readonly',
            'internal',
        );
        expect(result.memberCount).toBe(5);
    });

    it('still emits an avatar url when the owner has no display name', () => {
        const result = transformPlaylistRow(baseRow, 'owner', 'internal');
        expect(result.owner.images.primary.href).toBe(
            '/api/users/11111111-2222-3333-4444-555555555555/images/avatar?size=card&v=0&fallback=initials',
        );
    });
});

describe('transformCoverItemRow', () => {
    it('builds externalIds (primary provider + internal) and maps fields', () => {
        const item: CoverItemRow = {
            internal_id: 'uuid-1',
            primary_ext_id: '550',
            media_type: 'movie',
            poster_url: '/poster.jpg',
            position: 2,
        };
        const result = transformCoverItemRow(item);
        expect(result.mediaType).toBe('movie');
        expect(result.position).toBe(2);
        expect(result).not.toHaveProperty('posterUrl');
        expect(result.externalIds.internal).toBe('uuid-1');
        expect(result.externalIds[PRIMARY]).toBe('550');
        expect(result).not.toHaveProperty('mediaId');
    });

    it('maps a null poster_url to undefined', () => {
        const item: CoverItemRow = {
            internal_id: 'uuid-1',
            primary_ext_id: '550',
            media_type: 'movie',
            poster_url: null,
            position: 0,
        };
        const result = transformCoverItemRow(item);
        expect(result).not.toHaveProperty('posterUrl');
    });
});

function makeItemRow(overrides: Partial<PlaylistItemRow> = {}): PlaylistItemRow {
    return {
        id: 10,
        media_id: 'media-uuid',
        primary_ext_id: '550',
        media_type: 'movie',
        season_number: null,
        episode_number: null,
        title: 'A Movie',
        series_name: null,
        artist: null,
        parent_id: null,
        artist_id: null,
        overview: 'overview',
        poster_path: '/p.jpg',
        position: 0,
        added_at: '2026-01-01T00:00:00.000Z',
        watched: false,
        watched_at: null,
        resume_position_ms: null,
        runtime_ms: null,
        playback_watched: null,
        last_played_at: null,
        ...overrides,
    };
}

describe('transformPlaylistItemRow', () => {
    // The stored `tv` is remapped to the public `series`; everything else passes
    // through. This used to assert `tv` in === `tv` out, which pinned the leak
    // that made GET /playlists/{id}/items disagree with playlistItemInfo for the
    // same row.
    it.each([
        ['movie', 'movie'],
        ['tv', 'series'],
        ['episode', 'episode'],
    ] as const)('maps a video item of stored type "%s" to "%s"', (stored, expected) => {
        const result = transformPlaylistItemRow(makeItemRow({ media_type: stored }));
        expect(result.mediaType).toBe(expected);
        expect(result.id).toBe(10);
        expect(result.mediaId).toBe('media-uuid');
        expect(result).not.toHaveProperty('externalIds');
    });

    it('never emits the internal `tv` token', () => {
        expect(transformPlaylistItemRow(makeItemRow({ media_type: 'tv' })).mediaType).not.toBe(
            'tv',
        );
    });

    it.each(['artist', 'album', 'track'] as const)(
        'maps a music item of type "%s"',
        (mediaType) => {
            const result = transformPlaylistItemRow(
                makeItemRow({
                    media_type: mediaType,
                    artist: 'Neon Pulse',
                    artist_id: 'artist-uuid',
                    parent_id: 'album-uuid',
                }),
            );
            expect(result.mediaType).toBe(mediaType);
            expect(result.artist).toBe('Neon Pulse');
            expect(result.artistId).toBe('artist-uuid');
            expect(result.parentId).toBe('album-uuid');
        },
    );

    it('maps episode season/episode numbers and series name', () => {
        const result = transformPlaylistItemRow(
            makeItemRow({
                media_type: 'episode',
                season_number: 2,
                episode_number: 5,
                series_name: 'The Show',
                parent_id: 'season-uuid',
                artist_id: 'series-uuid',
            }),
        );
        expect(result.seasonNumber).toBe(2);
        expect(result.episodeNumber).toBe(5);
        expect(result.seriesName).toBe('The Show');
        expect(result.seriesId).toBe('series-uuid');
        expect(result).not.toHaveProperty('jellyfinSeriesId');
    });

    it('seriesId: a flat episode (no season row) uses its parent, a series row itself', () => {
        expect(
            transformPlaylistItemRow(
                makeItemRow({ media_type: 'episode', parent_id: 'series-uuid', artist_id: null }),
            ).seriesId,
        ).toBe('series-uuid');
        expect(transformPlaylistItemRow(makeItemRow({ media_type: 'tv' })).seriesId).toBe(
            'media-uuid',
        );
        expect(transformPlaylistItemRow(makeItemRow({ media_type: 'movie' })).seriesId).toBe(
            undefined,
        );
    });

    it('maps nullable fields to undefined', () => {
        const result = transformPlaylistItemRow(
            makeItemRow({
                series_name: null,
                artist: null,
                artist_id: null,
                parent_id: null,
                overview: null,
                poster_path: null,
                watched_at: null,
            }),
        );
        expect(result.seriesName).toBeUndefined();
        expect(result.artist).toBeUndefined();
        expect(result.artistId).toBeUndefined();
        expect(result.parentId).toBeUndefined();
        expect(result.overview).toBeUndefined();
        expect(result.watchedAt).toBeUndefined();
        // posterPath is deliberately NOT in this list any more: it no longer
        // mirrors the nullable poster_path column, it is generated from
        // media_id, so a null poster_path still yields a usable URL.
        expect(result.posterPath).toBe('/api/media/media-uuid/images/poster?size=thumb');
    });

    it('converts a Date added_at to an ISO string and preserves watched', () => {
        const result = transformPlaylistItemRow(
            makeItemRow({ added_at: new Date('2026-06-15T10:00:00.000Z'), watched: true }),
        );
        expect(result.addedAt).toBe('2026-06-15T10:00:00.000Z');
        expect(result.watched).toBe(true);
    });

    // posterPath used to be the RAW STORED `playlist_items.poster_path` — a
    // third, surface-blind image shape whose value was whatever the ingest wrote
    // at insert time. It is now derived from `media_id` per surface.
    describe('posterPath', () => {
        it('generates the canonical entity-image URL per surface, ignoring the stored column', () => {
            const row = makeItemRow({ poster_path: '/stale-ingest-value.jpg' });

            expect(transformPlaylistItemRowOnSurface(row, 'internal').posterPath).toBe(
                '/api/media/media-uuid/images/poster?size=thumb',
            );
            expect(transformPlaylistItemRowOnSurface(row, 'v1').posterPath).toBe(
                '/api/v1/media/media-uuid/images/poster?size=thumb',
            );
        });

        it('never leaks the stored value onto the wire', () => {
            const result = transformPlaylistItemRowOnSurface(
                makeItemRow({ poster_path: 'https://image.tmdb.org/t/p/w500/abc.jpg' }),
                'v1',
            );
            expect(result.posterPath).not.toContain('image.tmdb.org');
        });

        // `playlist_items.media_id` is `uuid NOT NULL` and the feed INNER JOINs
        // media_items on it, so this is unreachable in production — but it must
        // omit the field rather than emit `.../media/null/images/poster`.
        it('omits the field entirely rather than emitting a null id', () => {
            const result = transformPlaylistItemRowOnSurface(
                makeItemRow({ media_id: '' as unknown as string }),
                'internal',
            );
            expect(result.posterPath).toBeUndefined();
        });
    });

    describe('playback state', () => {
        it('projects ms watch state as the whole-second CW trio', () => {
            const result = transformPlaylistItemRow(
                makeItemRow({
                    resume_position_ms: 1891000,
                    runtime_ms: 3502000,
                    playback_watched: false,
                    last_played_at: new Date('2026-07-18T12:50:24.190Z'),
                }),
            );
            expect(result.positionSeconds).toBe(1891);
            expect(result.durationMs).toBe(3502000);
            expect(result.lastPlayedAt).toBe('2026-07-18T12:50:24.190Z');
            expect(result.playbackWatched).toBe(false);
        });

        it('omits the per-viewer fields when there is no watch-state row', () => {
            const result = transformPlaylistItemRow(makeItemRow());
            expect(result.positionSeconds).toBeUndefined();
            expect(result.lastPlayedAt).toBeUndefined();
            expect(result.playbackWatched).toBeUndefined();
        });

        // durationMs is item metadata, NOT watch state: a client must be
        // able to total a playlist's runtime on a playlist nobody has played.
        it('still emits durationMs with no watch-state row', () => {
            const result = transformPlaylistItemRow(makeItemRow({ runtime_ms: 3502000 }));
            expect(result.durationMs).toBe(3502000);
            expect(result.positionSeconds).toBeUndefined();
            expect(result.playbackWatched).toBeUndefined();
        });

        it('omits durationMs only when no runtime is known', () => {
            const result = transformPlaylistItemRow(makeItemRow({ runtime_ms: null }));
            expect(result.durationMs).toBeUndefined();
        });

        // An auto-completed item has its resume position zeroed, so
        // positionSeconds alone cannot distinguish "finished" from "untouched".
        it('reports a completed item as position 0 with playbackWatched true', () => {
            const result = transformPlaylistItemRow(
                makeItemRow({
                    resume_position_ms: 0,
                    runtime_ms: 3502000,
                    playback_watched: true,
                }),
            );
            expect(result.positionSeconds).toBe(0);
            expect(result.playbackWatched).toBe(true);
        });

        it('clamps a position past the runtime so duration - position stays >= 0', () => {
            const result = transformPlaylistItemRow(
                makeItemRow({ resume_position_ms: 4000000, runtime_ms: 3502000 }),
            );
            expect(result.positionSeconds).toBe(3502);
            expect(result.durationMs).toBe(3502000);
        });

        it('emits an unclamped position when runtime is unknown', () => {
            const result = transformPlaylistItemRow(
                makeItemRow({ resume_position_ms: 1891000, runtime_ms: null }),
            );
            expect(result.positionSeconds).toBe(1891);
            expect(result.durationMs).toBeUndefined();
        });

        it('treats a zero runtime as unknown rather than a zero-length item', () => {
            const result = transformPlaylistItemRow(
                makeItemRow({ resume_position_ms: 1891000, runtime_ms: 0 }),
            );
            expect(result.durationMs).toBeUndefined();
            expect(result.positionSeconds).toBe(1891);
        });

        it('accepts a string last_played_at unchanged', () => {
            const result = transformPlaylistItemRow(
                makeItemRow({ last_played_at: '2026-07-18T12:50:24.190Z' }),
            );
            expect(result.lastPlayedAt).toBe('2026-07-18T12:50:24.190Z');
        });
    });
});

describe('projectPlaybackState', () => {
    // The playlist-items feed and the playback-context feed (whose browserItems
    // mapping the in-player panels render) MUST agree: a client that switches
    // between the detail screen and the in-player panel must not see the
    // progress bar change. Both call this function — this suite is the contract.
    it('emits exactly the four playback keys and nothing else', () => {
        const result = projectPlaybackState(
            makeItemRow({
                resume_position_ms: 1891000,
                runtime_ms: 3502000,
                playback_watched: false,
                last_played_at: new Date('2026-07-18T12:50:24.190Z'),
            }),
        );
        expect(Object.keys(result).sort()).toEqual([
            'durationMs',
            'lastPlayedAt',
            'playbackWatched',
            'positionSeconds',
        ]);
        expect(result).toEqual({
            positionSeconds: 1891,
            durationMs: 3502000,
            lastPlayedAt: '2026-07-18T12:50:24.190Z',
            playbackWatched: false,
        });
    });

    it('agrees with what transformPlaylistItemRow puts on the items feed', () => {
        const rows: Array<Partial<PlaylistItemRow>> = [
            {}, // no state row at all
            { resume_position_ms: 1891000, runtime_ms: 3502000, playback_watched: false },
            { resume_position_ms: 0, runtime_ms: 3502000, playback_watched: true },
            { resume_position_ms: 4000000, runtime_ms: 3502000 }, // clamped
            { resume_position_ms: 1891000, runtime_ms: null }, // unknown runtime
            { resume_position_ms: 1891000, runtime_ms: 0 }, // zero runtime
        ];

        for (const overrides of rows) {
            const row = makeItemRow(overrides);
            const projected = projectPlaybackState(row);
            const onItemsFeed = transformPlaylistItemRow(row);

            expect(onItemsFeed.positionSeconds).toBe(projected.positionSeconds);
            expect(onItemsFeed.durationMs).toBe(projected.durationMs);
            expect(onItemsFeed.lastPlayedAt).toBe(projected.lastPlayedAt);
            expect(onItemsFeed.playbackWatched).toBe(projected.playbackWatched);
        }
    });

    it('spreads to nothing when the viewer has no playback state', () => {
        // Spreading undefined-valued keys would put explicit `undefined` on the
        // object; JSON.stringify drops them either way, so the wire payload must
        // carry no playback keys at all for a never-played item.
        const spread = { id: 1, ...projectPlaybackState(makeItemRow()) };
        expect(JSON.parse(JSON.stringify(spread))).toEqual({ id: 1 });
    });
});

describe('transformInsertedItemRow', () => {
    function makeInserted(overrides: Partial<InsertedItemRow> = {}): InsertedItemRow {
        return {
            id: 42,
            season_number: null,
            episode_number: null,
            title: 'Inserted',
            series_name: null,
            overview: null,
            poster_path: null,
            position: 0,
            added_at: '2026-01-01T00:00:00.000Z',
            ...overrides,
        };
    }

    it('uses the caller-supplied externalIds and mediaType, marks unwatched', () => {
        const externalIds = { internal: 'media-uuid', [PRIMARY]: '550' };
        const result = transformInsertedItemRow(makeInserted(), externalIds, 'movie', 'internal');
        expect(result.id).toBe(42);
        expect(result.mediaId).toBe(externalIds.internal);
        expect(result.mediaType).toBe('movie');
        expect(result.watched).toBe(false);
        expect(result.watchedAt).toBeUndefined();
    });

    it('carries the optional series externalIds through for episodes', () => {
        const externalIds = { internal: 'ep-uuid' };
        const seriesExternalIds = { [PRIMARY]: '1399' };
        const result = transformInsertedItemRow(
            makeInserted({ season_number: 1, episode_number: 2, series_name: 'GoT' }),
            externalIds,
            'episode',
            'internal',
            seriesExternalIds,
        );
        expect(result.seriesId).toBeUndefined();
        expect(result.seasonNumber).toBe(1);
        expect(result.episodeNumber).toBe(2);
        expect(result.seriesName).toBe('GoT');
    });

    it('converts a Date added_at to an ISO string', () => {
        const result = transformInsertedItemRow(
            makeInserted({ added_at: new Date('2026-06-15T10:00:00.000Z') }),
            { internal: 'x' },
            'movie',
            'internal',
        );
        expect(result.addedAt).toBe('2026-06-15T10:00:00.000Z');
    });
});

describe('isPlayableVideoEntry (playback-context previous/next)', () => {
    it('accepts catalog movie/tv/episode entries and skips music or id-less ones', () => {
        const id = '00000000-0000-4000-8000-000000000001';
        expect(isPlayableVideoEntry({ media_id: id, media_type: 'movie' })).toBe(true);
        expect(isPlayableVideoEntry({ media_id: id, media_type: 'tv' })).toBe(true);
        expect(isPlayableVideoEntry({ media_id: id, media_type: 'episode' })).toBe(true);
        expect(isPlayableVideoEntry({ media_id: id, media_type: 'track' })).toBe(false);
        expect(isPlayableVideoEntry({ media_id: null, media_type: 'movie' })).toBe(false);
    });
});
