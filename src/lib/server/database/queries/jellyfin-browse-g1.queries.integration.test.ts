// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin `/Items` parity in the browse query module (2026-10-07 audit gaps
 * 2, 5, 6, 9, 13): multi-key sorting, the user-data / folder / media-type
 * filters, recursion under a series, real totals, and Next Up paging — each
 * also under a restricted access boundary, so a filter can never become a way
 * around library or age scoping.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/index.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { ensureWatchlistPlaylist } from './watchlist-playlist.queries.js';
import {
    browseMediaItems,
    getNextUpEpisodes,
    getNextUpEpisodesPage,
    getLibraryItemCounts,
    type BrowseItemsOptions,
} from './jellyfin-browse.queries.js';
import { restrictedAccess, unrestrictedAccess } from './builders/media-access-boundary.js';

let sql: postgres.Sql;
let userId: UserId;

beforeAll(() => {
    sql = getTestDb();
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    await truncateTables(sql, [
        'play_sessions',
        'playlist_items',
        'playlists',
        'user_media_flags',
        'user_media_state',
        'provider_metadata',
        'media_file_items',
        'media_files',
        'library_groups',
        'media_items',
        'external_ids',
    ]);
    userId = toUserId(randomUUID());
    await ensureTestUser(sql, userId);
});

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function libraryGroup(name: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO library_groups (name, sort_order, created_at, updated_at)
        VALUES (${name}, 1, NOW(), NOW()) RETURNING id`;
    return row.id;
}

async function attachFile(itemId: string, groupId: string | null): Promise<void> {
    const [f] = await sql<{ id: string }[]>`
        INSERT INTO media_files (file_path, library_group_id, created_at, updated_at)
        VALUES (${`/g1/${itemId}.mkv`}, ${groupId}, NOW(), NOW()) RETURNING id`;
    await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default)
              VALUES (${f.id}::uuid, ${itemId}::uuid, true)`;
}

interface ItemSeed {
    title: string;
    type?: string;
    parentId?: string | null;
    year?: number | null;
    createdAt?: string;
    premiere?: string | null;
    runtime?: number | null;
    season?: number | null;
    episode?: number | null;
    ageRating?: number | null;
    vote?: number | null;
    genres?: string[];
    /** Library group of the item's file; `undefined` = no file (folders). */
    group?: string | null;
}

async function item(seed: ItemSeed): Promise<string> {
    const type = seed.type ?? 'movie';
    const leaf = ['movie', 'episode', 'track'].includes(type);
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, status, parent_id, has_files, year, created_at,
                                 premiere_date, runtime_seconds, season_number, episode_number, age_rating)
        VALUES (${seed.title}, ${type}, 'active', ${seed.parentId ?? null}, ${leaf || seed.group !== undefined},
                ${seed.year ?? null}, ${seed.createdAt ?? new Date().toISOString()}, ${seed.premiere ?? null},
                ${seed.runtime ?? null}, ${seed.season ?? null}, ${seed.episode ?? null}, ${seed.ageRating ?? null})
        RETURNING id`;
    if (seed.vote !== undefined || seed.genres) {
        const metadata = {
            vote_average: seed.vote ?? null,
            genres: (seed.genres ?? []).map((name, i) => ({ id: i + 1, name })),
        };
        await sql`INSERT INTO provider_metadata (media_id, provider, metadata)
                  VALUES (${row.id}::uuid, 'tmdb', ${sql.json(metadata)})`;
    }
    if (leaf) await attachFile(row.id, seed.group ?? null);
    return row.id;
}

/** Series → seasons → file-backed episodes; returns ids in episode order. */
async function series(
    title: string,
    seasons: number,
    perSeason: number,
    opts: { group?: string | null; ageRating?: number | null } = {},
): Promise<{ seriesId: string; seasonIds: string[]; episodeIds: string[] }> {
    const seriesId = await item({ title, type: 'tv', ageRating: opts.ageRating ?? null });
    const seasonIds: string[] = [];
    const episodeIds: string[] = [];
    // Insert seasons/episodes in REVERSE so insertion order never fakes the expected order.
    for (let s = seasons; s >= 1; s--) {
        const seasonId = await item({
            title: `Season ${s}`,
            type: 'season',
            parentId: seriesId,
            season: s,
        });
        seasonIds.unshift(seasonId);
        const eps: string[] = [];
        for (let e = perSeason; e >= 1; e--) {
            eps.unshift(
                await item({
                    title: `${title} ${s}x${e} ${String.fromCharCode(90 - e)}`,
                    type: 'episode',
                    parentId: seasonId,
                    season: s,
                    episode: e,
                    group: opts.group ?? null,
                    ageRating: opts.ageRating ?? null,
                }),
            );
        }
        episodeIds.unshift(...eps);
    }
    return { seriesId, seasonIds, episodeIds };
}

async function watched(mediaId: string, opts: { at?: string; count?: number } = {}): Promise<void> {
    await sql`
        INSERT INTO user_media_state (user_id, media_id, is_watched, resume_position_ms, runtime_ms,
                                      watch_count, last_watched_at, last_event_source)
        VALUES (${userId}::uuid, ${mediaId}::uuid, true, 0, 2700000, ${opts.count ?? 1},
                ${opts.at ?? new Date().toISOString()}, 'lumastra')`;
}

async function inProgress(mediaId: string, positionMs = 600_000): Promise<void> {
    await sql`
        INSERT INTO user_media_state (user_id, media_id, is_watched, resume_position_ms, runtime_ms,
                                      last_watched_at, last_event_source)
        VALUES (${userId}::uuid, ${mediaId}::uuid, false, ${positionMs}, 2700000, NOW(), 'lumastra')`;
}

async function favorite(mediaId: string): Promise<void> {
    const playlistId = await ensureWatchlistPlaylist(sql, userId);
    await sql`INSERT INTO playlist_items (playlist_id, media_id, title, position)
              VALUES (${playlistId}, ${mediaId}::uuid, 'fav', 0)`;
}

function opts(overrides: Partial<BrowseItemsOptions> = {}): BrowseItemsOptions {
    return {
        mediaTypes: [],
        parentId: null,
        searchTerm: null,
        genres: [],
        years: [],
        nameStartsWith: null,
        isFavoriteFilter: false,
        isPlayedFilter: false,
        isUnplayedFilter: false,
        enableUserData: true,
        userId,
        idList: [],
        sortBy: 'SortName',
        sortOrder: 'Ascending',
        limit: 100,
        startIndex: 0,
        access: unrestrictedAccess(),
        ...overrides,
    };
}

async function ids(o: Partial<BrowseItemsOptions>): Promise<string[]> {
    const { rows } = await browseMediaItems(sql, opts(o));
    return rows.map((r) => r.id as string);
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe('browseMediaItems — multi-key SortBy', () => {
    it('orders by ProductionYear desc, then SortName asc within a year', async () => {
        const b2020 = await item({ title: 'Bravo', year: 2020 });
        const a2020 = await item({ title: 'Alpha', year: 2020 });
        const c2021 = await item({ title: 'Charlie', year: 2021 });
        const d2019 = await item({ title: 'Delta', year: 2019 });

        expect(
            await ids({
                mediaTypes: ['movie'],
                sortBy: 'ProductionYear,SortName',
                sortOrder: 'Descending,Ascending',
            }),
        ).toEqual([c2021, a2020, b2020, d2019]);
    });

    it('a single SortOrder applies to every key', async () => {
        const a = await item({ title: 'Alpha', year: 2020 });
        const b = await item({ title: 'Bravo', year: 2020 });
        const c = await item({ title: 'Charlie', year: 2021 });

        expect(
            await ids({
                mediaTypes: ['movie'],
                sortBy: 'ProductionYear,SortName',
                sortOrder: 'Descending',
            }),
        ).toEqual([c, b, a]);
    });

    it('skips unknown keys instead of collapsing to name ascending', async () => {
        const old = await item({ title: 'Alpha', createdAt: '2020-01-01T00:00:00Z' });
        const recent = await item({ title: 'Zulu', createdAt: '2026-01-01T00:00:00Z' });

        expect(
            await ids({
                mediaTypes: ['movie'],
                sortBy: 'Budget,DateCreated',
                sortOrder: 'Ascending,Descending',
            }),
        ).toEqual([recent, old]);
    });

    it.each([
        ['CommunityRating', 'Descending'],
        ['Runtime', 'Ascending'],
        ['PremiereDate', 'Descending'],
        ['OfficialRating', 'Ascending'],
    ])('orders by %s %s', async (key, order) => {
        const low = await item({
            title: 'Zulu Low',
            vote: 5.1,
            runtime: 3000,
            premiere: '2001-01-01',
            ageRating: 6,
        });
        const high = await item({
            title: 'Alpha High',
            vote: 8.9,
            runtime: 9000,
            premiere: '2024-01-01',
            ageRating: 16,
        });
        const expected = order === 'Descending' ? [high, low] : [low, high];
        expect(await ids({ mediaTypes: ['movie'], sortBy: key, sortOrder: order })).toEqual(
            expected,
        );
    });

    it('PremiereDate falls back to the production year (Jellyfin OrderMapper)', async () => {
        const dated = await item({ title: 'Alpha', premiere: '2010-06-01' });
        const yearOnly = await item({ title: 'Bravo', year: 2015, premiere: null });

        expect(
            await ids({ mediaTypes: ['movie'], sortBy: 'PremiereDate', sortOrder: 'Descending' }),
        ).toEqual([yearOnly, dated]);
    });

    it('DatePlayed and PlayCount read the calling user’s state', async () => {
        const a = await item({ title: 'Alpha' });
        const b = await item({ title: 'Bravo' });
        const never = await item({ title: 'Charlie' });
        await watched(a, { at: '2026-01-01T00:00:00Z', count: 5 });
        await watched(b, { at: '2026-09-01T00:00:00Z', count: 1 });

        expect(
            await ids({ mediaTypes: ['movie'], sortBy: 'DatePlayed', sortOrder: 'Descending' }),
        ).toEqual([b, a, never]);
        expect(
            await ids({ mediaTypes: ['movie'], sortBy: 'PlayCount', sortOrder: 'Descending' }),
        ).toEqual([a, b, never]);
    });

    it('SeriesSortName,ParentIndexNumber,IndexNumber orders episodes across series', async () => {
        const zulu = await series('Zulu Show', 2, 2);
        const alpha = await series('Alpha Show', 1, 2);

        expect(
            await ids({
                mediaTypes: ['episode'],
                sortBy: 'SeriesSortName,ParentIndexNumber,IndexNumber',
                sortOrder: 'Ascending',
            }),
        ).toEqual([...alpha.episodeIds, ...zulu.episodeIds]);
    });

    it('SortName orders episodes by season and episode number, not title', async () => {
        const show = await series('Show', 2, 3);
        expect(await ids({ mediaTypes: ['episode'], sortBy: 'SortName' })).toEqual(show.episodeIds);
    });

    it('breaks ties deterministically so paging never repeats or skips rows', async () => {
        const all: string[] = [];
        for (let i = 0; i < 7; i++) all.push(await item({ title: 'Same', year: 2020 }));
        const pages: string[] = [];
        for (let start = 0; start < 7; start += 3) {
            pages.push(
                ...(await ids({
                    mediaTypes: ['movie'],
                    sortBy: 'ProductionYear',
                    limit: 3,
                    startIndex: start,
                })),
            );
        }
        expect(pages).toHaveLength(7);
        expect(new Set(pages).size).toBe(7);
        expect([...pages].sort()).toEqual([...all].sort());
    });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe('browseMediaItems — Jellyfin filters', () => {
    it('isFavorite true / false', async () => {
        const fav = await item({ title: 'Alpha' });
        const other = await item({ title: 'Bravo' });
        await favorite(fav);

        expect(await ids({ mediaTypes: ['movie'], isFavorite: true })).toEqual([fav]);
        expect(await ids({ mediaTypes: ['movie'], isFavorite: false })).toEqual([other]);
    });

    it('isPlayed on leaves, and folder-aware on series (played = no unplayed episode)', async () => {
        const seen = await item({ title: 'Alpha' });
        const unseen = await item({ title: 'Bravo' });
        await watched(seen);
        const done = await series('Done Show', 1, 2);
        const partial = await series('Partial Show', 1, 2);
        for (const ep of done.episodeIds) await watched(ep);
        await watched(partial.episodeIds[0]);

        expect(await ids({ mediaTypes: ['movie', 'tv'], isPlayed: true })).toEqual([
            seen,
            done.seriesId,
        ]);
        expect(await ids({ mediaTypes: ['movie', 'tv'], isPlayed: false })).toEqual([
            unseen,
            partial.seriesId,
        ]);
    });

    it('the legacy IsUnplayed flag no longer needs EnableUserData and sees series', async () => {
        const done = await series('Done Show', 1, 1);
        await watched(done.episodeIds[0]);
        const fresh = await series('Fresh Show', 1, 1);

        expect(
            await ids({ mediaTypes: ['tv'], isUnplayedFilter: true, enableUserData: false }),
        ).toEqual([fresh.seriesId]);
    });

    it('IsResumable: in-progress leaves; series in progress or partly watched', async () => {
        const resumable = await item({ title: 'Alpha' });
        await inProgress(resumable);
        await item({ title: 'Bravo' });
        const midEpisode = await series('Mid Episode', 1, 2);
        await inProgress(midEpisode.episodeIds[0]);
        const partly = await series('Partly', 1, 2);
        await watched(partly.episodeIds[0]);
        const done = await series('Done', 1, 1);
        await watched(done.episodeIds[0]);
        await series('Untouched', 1, 1);

        expect(await ids({ mediaTypes: ['movie', 'tv'], isResumable: true })).toEqual([
            resumable,
            midEpisode.seriesId,
            partly.seriesId,
        ]);
    });

    it('IsFolder / IsNotFolder', async () => {
        const movie = await item({ title: 'Alpha' });
        const show = await series('Bravo Show', 1, 1);

        expect(await ids({ mediaTypes: ['movie', 'tv'], isFolder: true })).toEqual([show.seriesId]);
        expect(await ids({ mediaTypes: ['movie', 'tv'], isFolder: false })).toEqual([movie]);
    });

    it('ExcludeItemTypes and MediaTypes', async () => {
        const movie = await item({ title: 'Alpha' });
        const show = await series('Bravo Show', 1, 1);

        expect(await ids({ mediaTypes: ['movie', 'tv'], excludeMediaTypes: ['movie'] })).toEqual([
            show.seriesId,
        ]);
        // MediaTypes=Video: playable videos only — the series folder carries none.
        expect(
            await ids({ mediaTypes: ['movie', 'tv'], playableMediaTypes: ['movie', 'episode'] }),
        ).toEqual([movie]);
        // A MediaTypes the library has none of (Photo) matches nothing.
        expect(await ids({ mediaTypes: ['movie', 'tv'], playableMediaTypes: [] })).toEqual([]);
    });

    it('Genres by name and GenreIds by the emitted md5 id', async () => {
        const drama = await item({ title: 'Alpha', genres: ['Drama'] });
        await item({ title: 'Bravo', genres: ['Comedy'] });
        const { createHash } = await import('crypto');
        const dramaId = createHash('md5').update('drama').digest('hex');

        expect(await ids({ mediaTypes: ['movie'], genres: ['Drama'] })).toEqual([drama]);
        expect(await ids({ mediaTypes: ['movie'], genreIds: [dramaId] })).toEqual([drama]);
    });

    it('Years', async () => {
        const y2020 = await item({ title: 'Alpha', year: 2020 });
        await item({ title: 'Bravo', year: 2021 });
        expect(await ids({ mediaTypes: ['movie'], years: [2020] })).toEqual([y2020]);
    });
});

// ---------------------------------------------------------------------------
// Recursion under a series / season (play all, shuffle)
// ---------------------------------------------------------------------------

describe('browseMediaItems — Recursive under a series or season', () => {
    it('ParentId=<series>&Recursive&IncludeItemTypes=Episode is every episode in order', async () => {
        const show = await series('Show', 3, 2);
        await series('Other Show', 1, 2);

        expect(
            await ids({
                parentId: show.seriesId,
                recursive: true,
                mediaTypes: ['episode'],
                forceEpisodeOrder: true,
            }),
        ).toEqual(show.episodeIds);
    });

    it('ParentId=<series>&Recursive&Filters=IsNotFolder&SortBy=SortName (jellyfin-web play all)', async () => {
        const show = await series('Show', 2, 3);
        expect(
            await ids({
                parentId: show.seriesId,
                recursive: true,
                isFolder: false,
                playableMediaTypes: ['movie', 'episode'],
                sortBy: 'SortName',
            }),
        ).toEqual(show.episodeIds);
    });

    it('without Recursive a series ParentId still lists its seasons', async () => {
        const show = await series('Show', 2, 1);
        expect(await ids({ parentId: show.seriesId, sortBy: 'SortName' })).toEqual(show.seasonIds);
        expect(
            await ids({ parentId: show.seriesId, mediaTypes: ['episode'], isFolder: false }),
        ).toEqual([]);
    });

    it('a season ParentId with Recursive is that season only', async () => {
        const show = await series('Show', 2, 2);
        expect(
            await ids({
                parentId: show.seasonIds[1],
                recursive: true,
                isFolder: false,
                sortBy: 'SortName',
            }),
        ).toEqual(show.episodeIds.slice(2));
    });

    it('Random under a series returns each episode exactly once (shuffle)', async () => {
        const show = await series('Show', 2, 3);
        const shuffled = await ids({
            parentId: show.seriesId,
            recursive: true,
            isFolder: false,
            sortBy: 'Random',
        });
        expect([...shuffled].sort()).toEqual([...show.episodeIds].sort());
    });
});

// ---------------------------------------------------------------------------
// Totals and access scoping
// ---------------------------------------------------------------------------

describe('browseMediaItems — totals and access scoping', () => {
    it('totalCount is the filtered total, not the page size, also past the end', async () => {
        for (let i = 0; i < 5; i++) await item({ title: `Movie ${i}`, year: 2000 + i });
        const page = await browseMediaItems(sql, opts({ mediaTypes: ['movie'], limit: 2 }));
        expect(page.rows).toHaveLength(2);
        expect(page.totalCount).toBe(5);
        const filtered = await browseMediaItems(
            sql,
            opts({ mediaTypes: ['movie'], years: [2001, 2002, 2003], limit: 1, startIndex: 1 }),
        );
        expect(filtered.rows).toHaveLength(1);
        expect(filtered.totalCount).toBe(3);
        const pastEnd = await browseMediaItems(
            sql,
            opts({ mediaTypes: ['movie'], limit: 2, startIndex: 50 }),
        );
        expect(pastEnd.rows).toHaveLength(0);
        expect(pastEnd.totalCount).toBe(5);
    });

    it('past-the-end totals also hold for a recursive series listing', async () => {
        const show = await series('Show', 2, 2);
        const pastEnd = await browseMediaItems(
            sql,
            opts({ parentId: show.seriesId, recursive: true, isFolder: false, startIndex: 10 }),
        );
        expect(pastEnd.totalCount).toBe(4);
    });

    it('filters and recursion never surface a denied library or an over-age item', async () => {
        const allowed = await libraryGroup('Allowed');
        const denied = await libraryGroup('Denied');
        const ok = await item({ title: 'Alpha', group: allowed, ageRating: 6 });
        const deniedLib = await item({ title: 'Bravo', group: denied, ageRating: 6 });
        const overAge = await item({ title: 'Charlie', group: allowed, ageRating: 18 });
        for (const id of [ok, deniedLib, overAge]) await favorite(id);
        const show = await series('Show', 1, 2, { group: denied, ageRating: 6 });

        const boundary = restrictedAccess({
            deniedGroupIds: [denied],
            maxAgeRating: 12,
            allowUnrated: false,
        });
        expect(await ids({ mediaTypes: ['movie'], isFavorite: true, access: boundary })).toEqual([
            ok,
        ]);
        expect(
            await ids({
                mediaTypes: ['movie'],
                isPlayed: false,
                sortBy: 'Random',
                access: boundary,
            }),
        ).toEqual([ok]);
        expect(
            await ids({
                parentId: show.seriesId,
                recursive: true,
                isFolder: false,
                access: boundary,
            }),
        ).toEqual([]);
        const total = await browseMediaItems(
            sql,
            opts({ mediaTypes: ['movie'], access: boundary, startIndex: 5 }),
        );
        expect(total.totalCount).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Search ids (SearchTerm path): relevance order, filters, real total
// ---------------------------------------------------------------------------

describe('browseMediaItems — ranked id list (search)', () => {
    it('keeps the ranking, applies filters and ParentId, pages after filtering', async () => {
        const lib = await libraryGroup('Movies');
        const other = await libraryGroup('Other');
        const a = await item({ title: 'Alpha', group: lib, year: 2001 });
        const b = await item({ title: 'Bravo', group: lib, year: 2002 });
        const c = await item({ title: 'Charlie', group: lib, year: 2003 });
        const elsewhere = await item({ title: 'Delta', group: other, year: 2004 });
        await watched(b);
        const ranked = [c, elsewhere, b, a];

        const firstPage = await browseMediaItems(
            sql,
            opts({
                idList: ranked,
                orderByIdList: true,
                parentId: lib,
                isPlayed: false,
                sortBy: 'SortName',
                limit: 1,
            }),
        );
        expect(firstPage.rows.map((r) => r.id)).toEqual([c]);
        expect(firstPage.totalCount).toBe(2);

        const secondPage = await ids({
            idList: ranked,
            orderByIdList: true,
            parentId: lib,
            isPlayed: false,
            limit: 1,
            startIndex: 1,
        });
        expect(secondPage).toEqual([a]);
    });
});

// ---------------------------------------------------------------------------
// Next Up
// ---------------------------------------------------------------------------

describe('getNextUpEpisodes — Jellyfin paging and scoping', () => {
    /** A series with the first `watchedCount` episodes watched, `minutesAgo` back. */
    async function inProgressSeries(
        title: string,
        minutesAgo: number,
        opts: { group?: string | null; episodes?: number; watchedCount?: number } = {},
    ): Promise<{ seriesId: string; episodeIds: string[] }> {
        const show = await series(title, 1, opts.episodes ?? 3, { group: opts.group ?? null });
        const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
        for (const ep of show.episodeIds.slice(0, opts.watchedCount ?? 1))
            await watched(ep, { at });
        return show;
    }

    it('StartIndex pages instead of repeating page 1, with a real total', async () => {
        const shows = [];
        for (let i = 0; i < 5; i++) shows.push(await inProgressSeries(`Show ${i}`, 10 + i));
        const expected = shows.map((s) => s.episodeIds[1]);

        const seen: string[] = [];
        for (let start = 0; start < 5; start += 2) {
            const { rows, totalCount } = await getNextUpEpisodesPage(
                sql,
                userId,
                2,
                unrestrictedAccess(),
                null,
                0,
                { startIndex: start },
            );
            expect(totalCount).toBe(5);
            seen.push(...rows.map((r) => r.id as string));
        }
        expect(seen).toEqual(expected);

        const pastEnd = await getNextUpEpisodesPage(sql, userId, 2, unrestrictedAccess(), null, 0, {
            startIndex: 20,
        });
        expect(pastEnd.rows).toHaveLength(0);
        expect(pastEnd.totalCount).toBe(5);
    });

    it('ParentId scopes to one library (or one series)', async () => {
        const tv = await libraryGroup('TV');
        const anime = await libraryGroup('Anime');
        const inTv = await inProgressSeries('TV Show', 5, { group: tv });
        const inAnime = await inProgressSeries('Anime Show', 6, { group: anime });

        const scoped = await getNextUpEpisodes(sql, userId, 10, unrestrictedAccess(), null, 0, {
            parentId: anime,
        });
        expect(scoped.map((r) => r.id)).toEqual([inAnime.episodeIds[1]]);
        const bySeries = await getNextUpEpisodes(sql, userId, 10, unrestrictedAccess(), null, 0, {
            parentId: inTv.seriesId,
        });
        expect(bySeries.map((r) => r.id)).toEqual([inTv.episodeIds[1]]);
    });

    it('enableRewatching=false skips watched episodes after the anchor', async () => {
        // Re-watch: everything watched long ago, then episode 1 re-watched now.
        const show = await series('Rewatch', 1, 3);
        for (const ep of show.episodeIds) {
            await watched(ep, { at: '2025-01-01T00:00:00Z' });
        }
        await sql`UPDATE user_media_state SET last_watched_at = NOW()
                  WHERE user_id = ${userId}::uuid AND media_id = ${show.episodeIds[0]}::uuid`;

        const following = await getNextUpEpisodes(sql, userId, 10, unrestrictedAccess());
        expect(following.map((r) => r.id)).toEqual([show.episodeIds[1]]);
        const strict = await getNextUpEpisodes(sql, userId, 10, unrestrictedAccess(), null, 0, {
            requireUnwatchedNext: true,
        });
        expect(strict).toHaveLength(0);
    });

    it('enableResumable=false drops a next episode that is already in progress', async () => {
        const show = await inProgressSeries('Resume', 5);
        await inProgress(show.episodeIds[1]);

        expect(
            (await getNextUpEpisodes(sql, userId, 10, unrestrictedAccess())).map((r) => r.id),
        ).toEqual([show.episodeIds[1]]);
        expect(
            await getNextUpEpisodes(sql, userId, 10, unrestrictedAccess(), null, 0, {
                excludeResumable: true,
            }),
        ).toHaveLength(0);
    });

    it('nextUpDateCutoff drops series not watched since the cutoff', async () => {
        const recent = await inProgressSeries('Recent', 5);
        await inProgressSeries('Old', 60 * 24 * 30);
        const rows = await getNextUpEpisodes(sql, userId, 10, unrestrictedAccess(), null, 0, {
            minLastWatchedAt: new Date(Date.now() - 24 * 3600_000),
        });
        expect(rows.map((r) => r.id)).toEqual([recent.episodeIds[1]]);
    });

    it('a denied library never shows up, and does not count towards the total', async () => {
        const allowed = await libraryGroup('Allowed');
        const denied = await libraryGroup('Denied');
        const ok = await inProgressSeries('Allowed Show', 5, { group: allowed });
        await inProgressSeries('Denied Show', 4, { group: denied });

        const { rows, totalCount } = await getNextUpEpisodesPage(
            sql,
            userId,
            10,
            restrictedAccess({ deniedGroupIds: [denied], maxAgeRating: null, allowUnrated: true }),
            null,
            0,
            {},
        );
        expect(rows.map((r) => r.id)).toEqual([ok.episodeIds[1]]);
        expect(totalCount).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Item counts (/Items/Counts)
// ---------------------------------------------------------------------------

describe('getLibraryItemCounts', () => {
    it('counts file-backed items by kind, scoped and optionally favourites only', async () => {
        const allowed = await libraryGroup('Allowed');
        const denied = await libraryGroup('Denied');
        const fav = await item({ title: 'Alpha', group: allowed, ageRating: 6 });
        await item({ title: 'Bravo', group: allowed, ageRating: 6 });
        await item({ title: 'Denied', group: denied, ageRating: 6 });
        await item({ title: 'Over Age', group: allowed, ageRating: 18 });
        const [ghost] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, has_files)
            VALUES ('Ghost', 'movie', 'active', false) RETURNING id`;
        await favorite(fav);
        await favorite(ghost.id);
        await series('Show', 2, 3, { group: allowed });

        const open = await getLibraryItemCounts(sql, { access: unrestrictedAccess(), userId });
        expect(open).toMatchObject({ movie: 4, tv: 1, episode: 6 });

        const boundary = restrictedAccess({
            deniedGroupIds: [denied],
            maxAgeRating: 12,
            allowUnrated: true,
        });
        const scoped = await getLibraryItemCounts(sql, { access: boundary, userId });
        expect(scoped.movie).toBe(2);

        const favs = await getLibraryItemCounts(sql, {
            access: boundary,
            userId,
            isFavorite: true,
        });
        expect(favs).toMatchObject({ movie: 1, tv: 0, episode: 0 });
    });
});

// ---------------------------------------------------------------------------
// Review fix: episode order only for season/series parents
// ---------------------------------------------------------------------------

describe('browseMediaItems — ParentId=<library> without SortBy', () => {
    it('keeps SortName order and pages disjoint and complete (no forced episode order)', async () => {
        const lib = await libraryGroup('Movies');
        const all: string[] = [];
        // Same titles on purpose: only the id tiebreak keeps paging stable.
        for (let i = 0; i < 9; i++) all.push(await item({ title: `Film ${i % 3}`, group: lib }));

        const pages: string[] = [];
        for (let start = 0; start < 9; start += 4) {
            pages.push(
                ...(await ids({
                    parentId: lib,
                    forceEpisodeOrder: true,
                    limit: 4,
                    startIndex: start,
                })),
            );
        }
        expect(pages).toHaveLength(9);
        expect(new Set(pages).size).toBe(9);
        expect([...pages].sort()).toEqual([...all].sort());
        const titles = new Map<string, string>();
        for (const id of all) {
            const [r] = await sql<
                { title: string }[]
            >`SELECT title FROM media_items WHERE id = ${id}`;
            titles.set(id, r.title);
        }
        const ordered = pages.map((id) => titles.get(id));
        expect(ordered).toEqual([...ordered].sort());
    });

    it('a season ParentId still gets episode order', async () => {
        const show = await series('Show', 2, 2);
        expect(
            await ids({
                parentId: show.seasonIds[0],
                forceEpisodeOrder: true,
                sortBy: 'SortName',
            }),
        ).toEqual(show.episodeIds.slice(0, 2));
    });
});

describe('browseMediaItems — SortBy=CriticRating with a non-numeric rt_rating', () => {
    it('sorts the numeric ones and does not fail the listing', async () => {
        const bad = await item({ title: 'Alpha' });
        const good = await item({ title: 'Bravo' });
        await sql`INSERT INTO provider_metadata (media_id, provider, metadata)
                  VALUES (${bad}::uuid, 'tmdb', ${sql.json({ rt_rating: 'N/A' })}),
                         (${good}::uuid, 'tmdb', ${sql.json({ rt_rating: '85' })})`;

        expect(
            await ids({ mediaTypes: ['movie'], sortBy: 'CriticRating', sortOrder: 'Descending' }),
        ).toEqual([good, bad]);
    });
});
