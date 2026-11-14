// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Route tests for the filter menus and search (cloud-parity brief 12):
 * `/Items/Filters`, `/Items/Filters2`, `/Genres`, `/Genres/{name}`,
 * `/MusicGenres` and `/Search/Hints`, over real PG. Every parameter the
 * routes honour, and access scoping: a genre, rating, year or hint that only
 * exists in a library the user may not see never appears.
 *
 * withJellyfinAuth is replaced by a pass-through so a test can pick the
 * caller's groups; the contract suite covers the real auth path.
 */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import { toUserId } from '$lib/shared/user-id';
import { upsertLibraryGroupPermission } from '$lib/server/database/queries/library-group-permissions.queries.js';
import { invalidateLibraryGroupPermissionsCache } from '$lib/server/cache/library-group-permissions-cache.js';
import { clearVideoGenreCache } from '$lib/server/jellyfin-compat/genres';
import { clearItemFilterCache } from '$lib/server/jellyfin-compat/item-filters';
import { config } from '$lib/server/config';
import { getEpisodesOfAgeHiddenSeries } from '$lib/server/database/queries/jellyfin-filters.queries';
import { restrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import {
    clearMusicGenreCache,
    musicGenreId,
} from '$lib/server/jellyfin-compat/music-genres';

vi.setConfig({ testTimeout: 30_000 });

vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

vi.mock('$lib/server/database', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database')>();
    const { getTestDb: getSql } =
        await import('../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

vi.mock('$lib/server/database/connection.js', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database/connection.js')>();
    const { getTestDb: getSql } =
        await import('../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

type Handler = (e: never) => Promise<Response> | Response;

/** A user in `groups` (the denied libraries allow only 'adults'). */
function userIn(groups: string[], maxAgeRating: number | null = null) {
    return {
        username: 'filters-test',
        userId: toUserId('00000000-0000-4000-8000-0000000f17e5'),
        groups: '',
        userGroups: groups,
        hasWatchPermission: true,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        isAdmin: false,
        maxAgeRating,
        isAgeRestricted: maxAgeRating !== null,
        isModerator: false,
        liveTvPriority: 'low',
    };
}
const KIDS = userIn(['kids']);
const ADULTS = userIn(['adults']);
/** Age-limited to 12 (and in the allowed groups, so only the age rule bites). */
const TWELVE = userIn(['adults'], 12);

async function call<T = unknown>(
    handler: Handler,
    path: string,
    opts: { user?: ReturnType<typeof userIn>; params?: Record<string, string> } = {},
): Promise<{ status: number; body: T }> {
    const url = new URL(`http://localhost${path}`);
    const event = {
        url,
        request: new Request(url),
        locals: { user: opts.user ?? KIDS },
        params: opts.params ?? {},
        route: { id: null },
        cookies: { get: () => undefined },
        getClientAddress: () => '127.0.0.1',
        setHeaders: () => {},
    } as unknown as RequestEvent;
    const res = await (handler as (e: RequestEvent) => Promise<Response>)(event);
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

function genreId(name: string): string {
    const h = createHash('md5').update(name.trim().toLowerCase()).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

interface Fixture {
    movies: string;
    denied: string;
    tv: string;
    music: string;
    deniedMusic: string;
    movie: string;
    deniedMovie: string;
    series: string;
    season: string;
    episode: string;
    artist: string;
    album: string;
    track: string;
}

let sql: postgres.Sql;
let f: Fixture;
const groupIds: string[] = [];

async function group(name: string, mediaType: string, allowedGroups?: string[]): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO library_groups (id, name) VALUES (${id}::uuid, ${name})`;
    await sql`INSERT INTO library_paths (library_group_id, path, media_type, enabled)
              VALUES (${id}::uuid, ${'/data/' + id}, ${mediaType}, true)`;
    if (allowedGroups) {
        await upsertLibraryGroupPermission(sql, { libraryGroupId: id, allowedGroups });
    }
    groupIds.push(id);
    return id;
}

async function item(
    title: string,
    mediaType: string,
    parentId: string | null,
    extra: {
        year?: number;
        season?: number;
        episode?: number;
        hasFiles?: boolean;
        customMetadata?: Record<string, unknown>;
    } = {},
): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, status, parent_id, has_files, season_number, episode_number, year, custom_metadata)
        VALUES (${title}, ${mediaType}, 'active', ${parentId}, ${extra.hasFiles ?? true},
                ${extra.season ?? null}, ${extra.episode ?? null}, ${extra.year ?? null},
                ${sql.json((extra.customMetadata ?? {}) as never)})
        RETURNING id`;
    return row.id;
}

async function fileIn(itemId: string, groupId: string, audio = false): Promise<void> {
    const [file] = await sql<{ id: string }[]>`
        INSERT INTO media_files (file_path, file_size_bytes, container_format, duration_seconds, library_group_id)
        VALUES (${`/data/${groupId}/${itemId}.${audio ? 'flac' : 'mkv'}`}, 1000, ${audio ? 'flac' : 'matroska'}, 100, ${groupId}::uuid)
        RETURNING id`;
    await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${file.id}, ${itemId}, true)`;
}

async function tmdb(itemId: string, genres: string[], rating: string): Promise<void> {
    await sql`INSERT INTO provider_metadata (media_id, provider, metadata)
              VALUES (${itemId}, 'tmdb', ${sql.json({
                  genres: genres.map((name, i) => ({ id: i + 1, name })),
                  content_rating: rating,
              } as never)})`;
}

async function seed(): Promise<Fixture> {
    const movies = await group('Filter Movies', 'movie');
    const denied = await group('Filter Denied', 'movie', ['adults']);
    const tv = await group('Filter TV', 'tv');
    const music = await group('Filter Music', 'music');
    const deniedMusic = await group('Filter Denied Music', 'music', ['adults']);

    const movie = await item('Filter Movie One', 'movie', null, { year: 2020 });
    await fileIn(movie, movies);
    await tmdb(movie, ['Action', 'Drama'], 'PG-13');

    const deniedMovie = await item('Forbidden Horror', 'movie', null, { year: 1999 });
    await fileIn(deniedMovie, denied);
    await tmdb(deniedMovie, ['Horror', 'Drama'], 'R');

    const series = await item('Filter Series', 'tv', null, { year: 2018, hasFiles: false });
    await tmdb(series, ['Animation'], 'TV-14');
    const season = await item('Season 1', 'season', series, { season: 1, hasFiles: false });
    const episode = await item('Searchable Pilot', 'episode', season, {
        season: 1,
        episode: 3,
        year: 2018,
    });
    await fileIn(episode, tv);
    // A genre only the episode carries (no rating, so the rating menus stay put).
    await sql`INSERT INTO provider_metadata (media_id, provider, metadata)
              VALUES (${episode}, 'tmdb', ${sql.json({ genres: [{ id: 99, name: 'Reality' }] } as never)})`;

    const artist = await item('Filter Jazz Artist', 'artist', null);
    const album = await item('Filter Jazz Album', 'album', artist);
    // The genre cover is an album with artwork.
    await sql`UPDATE media_items SET custom_poster_url = '/covers/jazz.jpg' WHERE id = ${album}`;
    const track = await item('Blue Filter Track', 'track', album, {
        customMetadata: { genre: 'Jazz' },
    });
    await fileIn(track, music, true);
    const deniedArtist = await item('Denied Metal Artist', 'artist', null);
    const deniedAlbum = await item('Denied Metal Album', 'album', deniedArtist);
    const deniedTrack = await item('Denied Metal Track', 'track', deniedAlbum, {
        customMetadata: { genre: 'Metal' },
    });
    await fileIn(deniedTrack, deniedMusic, true);

    return {
        movies,
        denied,
        tv,
        music,
        deniedMusic,
        movie,
        deniedMovie,
        series,
        season,
        episode,
        artist,
        album,
        track,
    };
}

describe.runIf(RUN)('/j filter menus, genres and search hints', () => {
    let filtersGet: Handler;
    let filters2Get: Handler;
    let genresGet: Handler;
    let genreGet: Handler;
    let musicGenresGet: Handler;
    let hintsGet: Handler;
    let itemsGet: Handler;

    beforeAll(async () => {
        sql = getTestDb();
        await truncateTables(sql, [...TEST_TABLES.media]);
        f = await seed();
        invalidateLibraryGroupPermissionsCache();
        clearVideoGenreCache();
        clearMusicGenreCache();
        clearItemFilterCache();
        filtersGet = (await import('./Items/Filters/+server')).GET;
        filters2Get = (await import('./Items/Filters2/+server')).GET;
        genresGet = (await import('./Genres/+server')).GET;
        genreGet = (await import('./Genres/[genreName]/+server')).GET;
        musicGenresGet = (await import('./MusicGenres/+server')).GET;
        hintsGet = (await import('./Search/Hints/+server')).GET;
        itemsGet = (await import('./Items/+server')).GET;
    });

    afterAll(async () => {
        await truncateTables(sql, [...TEST_TABLES.media]);
        for (const id of groupIds) {
            await sql`DELETE FROM library_group_permissions WHERE library_group_id = ${id}::uuid`;
            await sql`DELETE FROM library_paths WHERE library_group_id = ${id}::uuid`;
            await sql`DELETE FROM library_groups WHERE id = ${id}::uuid`;
        }
        invalidateLibraryGroupPermissionsCache();
        await closeTestDb();
    });

    // -----------------------------------------------------------------------
    // /Items/Filters
    // -----------------------------------------------------------------------

    describe('GET /Items/Filters', () => {
        interface Legacy {
            Genres: string[];
            Tags: string[];
            OfficialRatings: string[];
            Years: number[];
        }

        it('lists genres, ratings and years over everything the user can see', async () => {
            const { status, body } = await call<Legacy>(filtersGet, '/j/Items/Filters');
            expect(status).toBe(200);
            expect(body.Genres).toEqual(expect.arrayContaining(['Action', 'Animation', 'Drama']));
            expect(body.Genres).not.toContain('Horror');
            expect(body.OfficialRatings).toEqual(['PG-13', 'TV-14']);
            expect(body.Years).toEqual([2018, 2020]);
            expect(body.Tags).toEqual([]);
        });

        it('shows the denied library only to users allowed into it', async () => {
            const { body } = await call<Legacy>(filtersGet, '/j/Items/Filters', { user: ADULTS });
            expect(body.Genres).toContain('Horror');
            expect(body.OfficialRatings).toContain('R');
            expect(body.Years).toContain(1999);
        });

        it('ParentId + IncludeItemTypes narrow to that library and type', async () => {
            const { body } = await call<Legacy>(
                filtersGet,
                `/j/Items/Filters?ParentId=${f.movies}&IncludeItemTypes=Movie`,
            );
            expect(body).toEqual({
                Genres: ['Action', 'Drama'],
                Tags: [],
                OfficialRatings: ['PG-13'],
                Years: [2020],
            });
        });

        it('a series ParentId reaches its episodes (recursive)', async () => {
            const { body } = await call<Legacy>(
                filtersGet,
                `/j/Items/Filters?ParentId=${f.series}&IncludeItemTypes=Episode`,
            );
            expect(body.Years).toEqual([2018]);
        });

        it('a denied library ParentId answers like an empty one', async () => {
            const denied = await call<Legacy>(filtersGet, `/j/Items/Filters?ParentId=${f.denied}`);
            const unknown = await call<Legacy>(
                filtersGet,
                `/j/Items/Filters?ParentId=${randomUUID()}`,
            );
            expect(denied).toEqual(unknown);
            expect(denied.body).toEqual({ Genres: [], Tags: [], OfficialRatings: [], Years: [] });
        });

        it('a non-folder ParentId, unknown types and junk ids give empty filters', async () => {
            for (const q of [`ParentId=${f.movie}`, 'IncludeItemTypes=BoxSet', 'MediaTypes=Book']) {
                const { status, body } = await call<Legacy>(filtersGet, `/j/Items/Filters?${q}`);
                expect(status).toBe(200);
                expect(body.Genres).toEqual([]);
                expect(body.Years).toEqual([]);
            }
        });

        it('a malformed ParentId is rejected like Jellyfin model binding (validation error)', async () => {
            for (const handler of [filtersGet, filters2Get, genresGet, musicGenresGet, hintsGet]) {
                const { status } = await call(handler, '/j/x?SearchTerm=a&ParentId=not-a-guid');
                expect(status).toBe(422);
            }
        });

        it('MediaTypes=Video keeps movies and episodes; music types list music genres', async () => {
            const video = await call<Legacy>(filtersGet, '/j/Items/Filters?MediaTypes=Video');
            expect(video.body.OfficialRatings).toEqual(['PG-13']);
            const music = await call<Legacy>(filtersGet, '/j/Items/Filters?IncludeItemTypes=Audio');
            expect(music.body.Genres).toEqual(['Jazz']);
        });

        it('the user root folder ParentId means everything', async () => {
            const { body } = await call<Legacy>(
                filtersGet,
                '/j/Items/Filters?ParentId=f27caa37e5142225cceded48f6553502',
            );
            expect(body.Years).toEqual([2018, 2020]);
        });
    });

    // -----------------------------------------------------------------------
    // /Items/Filters2
    // -----------------------------------------------------------------------

    describe('GET /Items/Filters2', () => {
        interface Filters {
            Genres: { Name: string; Id: string }[];
            Tags: string[];
        }

        it('lists genre name/Id pairs whose Id filters /Items', async () => {
            const { status, body } = await call<Filters>(
                filters2Get,
                '/j/Items/Filters2?IncludeItemTypes=Movie',
            );
            expect(status).toBe(200);
            expect(body).toEqual({
                Genres: [
                    { Name: 'Action', Id: genreId('Action') },
                    { Name: 'Drama', Id: genreId('Drama') },
                ],
                Tags: [],
            });

            const items = await call<{ Items: { Id: string }[] }>(
                itemsGet,
                `/j/Items?Recursive=true&IncludeItemTypes=Movie&GenreIds=${genreId('Drama')}`,
            );
            expect(items.body.Items.map((i) => i.Id)).toEqual([f.movie]);
        });

        it('never offers a genre that only exists in a denied library', async () => {
            const kids = await call<Filters>(filters2Get, '/j/Items/Filters2');
            expect(kids.body.Genres.map((g) => g.Name)).not.toContain('Horror');
            const adults = await call<Filters>(filters2Get, '/j/Items/Filters2', { user: ADULTS });
            expect(adults.body.Genres.map((g) => g.Name)).toContain('Horror');
        });

        it('music types list the music genres with /MusicGenres Ids', async () => {
            const { body } = await call<Filters>(
                filters2Get,
                '/j/Items/Filters2?IncludeItemTypes=MusicAlbum',
            );
            expect(body.Genres).toEqual([{ Name: 'Jazz', Id: musicGenreId('Jazz') }]);
            const adults = await call<Filters>(
                filters2Get,
                '/j/Items/Filters2?IncludeItemTypes=Audio',
                { user: ADULTS },
            );
            expect(adults.body.Genres.map((g) => g.Name)).toEqual(['Jazz', 'Metal']);
        });

        it('a music library ParentId lists its music genres', async () => {
            const { body } = await call<Filters>(
                filters2Get,
                `/j/Items/Filters2?ParentId=${f.music}`,
            );
            expect(body.Genres.map((g) => g.Name)).toEqual(['Jazz']);
            const denied = await call<Filters>(
                filters2Get,
                `/j/Items/Filters2?ParentId=${f.deniedMusic}`,
            );
            expect(denied.body.Genres).toEqual([]);
        });

        it('applies the program flags the way Jellyfin does for library items', async () => {
            for (const q of [
                'IsSeries=true',
                'IsKids=true',
                'IsNews=true',
                'IsSports=true',
                'IsAiring=true',
                'IsMovie=true&IncludeItemTypes=Series',
            ]) {
                const { body } = await call<Filters>(filters2Get, `/j/Items/Filters2?${q}`);
                expect(body.Genres).toEqual([]);
            }
            const movies = await call<Filters>(
                filters2Get,
                '/j/Items/Filters2?IsMovie=true&IsSeries=false&IncludeItemTypes=Movie',
            );
            expect(movies.body.Genres.map((g) => g.Name)).toEqual(['Action', 'Drama']);
        });

        it('Recursive=false under a folder looks at direct children only', async () => {
            const direct = await call<Filters>(
                filters2Get,
                `/j/Items/Filters2?ParentId=${f.artist}&Recursive=false&IncludeItemTypes=Audio`,
            );
            // Music: the genre tags live on tracks two levels down.
            expect(direct.body.Genres.map((g) => g.Name)).toEqual(['Jazz']);
            const flat = await call<Filters>(
                filters2Get,
                `/j/Items/Filters2?ParentId=${f.series}&Recursive=false&IncludeItemTypes=Season`,
            );
            expect(flat.body.Genres).toEqual([]);
        });

        it('a playable ParentId has no filters', async () => {
            const { body } = await call<Filters>(
                filters2Get,
                `/j/Items/Filters2?ParentId=${f.movie}`,
            );
            expect(body).toEqual({ Genres: [], Tags: [] });
        });
    });

    // -----------------------------------------------------------------------
    // /Genres and /Genres/{name}
    // -----------------------------------------------------------------------

    describe('GET /Genres', () => {
        interface Genre {
            Name: string;
            Id: string;
            Type: string;
            ChildCount?: number;
            EpisodeCount?: number;
            MovieCount?: number;
            SeriesCount?: number;
            SongCount?: number;
        }
        interface Page {
            Items: Genre[];
            TotalRecordCount: number;
            StartIndex: number;
        }
        const names = (p: Page): string[] => p.Items.map((g) => g.Name);

        it('lists movie and series genres the user can see, with counts', async () => {
            const { status, body } = await call<Page>(genresGet, '/j/Genres');
            expect(status).toBe(200);
            expect(names(body)).toEqual(['Action', 'Animation', 'Drama']);
            expect(body.TotalRecordCount).toBe(3);
            expect(body.Items[2]).toMatchObject({
                Name: 'Drama',
                Id: genreId('Drama'),
                Type: 'Genre',
                ChildCount: 1,
            });
            expect(body.Items[0].MovieCount).toBeUndefined();

            const adults = await call<Page>(genresGet, '/j/Genres', { user: ADULTS });
            expect(names(adults.body)).toEqual(['Action', 'Animation', 'Drama', 'Horror']);
            expect(adults.body.Items.find((g) => g.Name === 'Drama')?.ChildCount).toBe(2);
        });

        it('IncludeItemTypes / ExcludeItemTypes scope the genres and add item counts', async () => {
            const series = await call<Page>(genresGet, '/j/Genres?IncludeItemTypes=Series');
            expect(names(series.body)).toEqual(['Animation']);
            expect(series.body.Items[0]).toMatchObject({ SeriesCount: 1, MovieCount: 0 });

            const noMovies = await call<Page>(genresGet, '/j/Genres?ExcludeItemTypes=Movie');
            expect(names(noMovies.body)).toEqual(['Animation']);

            const counted = await call<Page>(genresGet, '/j/Genres?Fields=ItemCounts');
            expect(counted.body.Items[0]).toMatchObject({ Name: 'Action', MovieCount: 1 });
        });

        it('SearchTerm, NameStartsWith, NameStartsWithOrGreater and NameLessThan filter by name', async () => {
            expect(names((await call<Page>(genresGet, '/j/Genres?SearchTerm=RAM')).body)).toEqual([
                'Drama',
            ]);
            expect(names((await call<Page>(genresGet, '/j/Genres?NameStartsWith=a')).body)).toEqual(
                ['Action', 'Animation'],
            );
            expect(
                names((await call<Page>(genresGet, '/j/Genres?NameStartsWithOrGreater=B')).body),
            ).toEqual(['Drama']);
            expect(
                names((await call<Page>(genresGet, '/j/Genres?NameLessThan=Animation')).body),
            ).toEqual(['Action']);
        });

        it('SortBy / SortOrder / StartIndex / Limit / EnableTotalRecordCount', async () => {
            const desc = await call<Page>(
                genresGet,
                '/j/Genres?SortBy=SortName&SortOrder=Descending',
            );
            expect(names(desc.body)).toEqual(['Drama', 'Animation', 'Action']);

            const page = await call<Page>(genresGet, '/j/Genres?StartIndex=1&Limit=1');
            expect(page.body).toMatchObject({ TotalRecordCount: 3, StartIndex: 1 });
            expect(names(page.body)).toEqual(['Animation']);

            const noTotal = await call<Page>(
                genresGet,
                '/j/Genres?Limit=2&EnableTotalRecordCount=false',
            );
            expect(noTotal.body.TotalRecordCount).toBe(2);

            const byCount = await call<Page>(
                genresGet,
                '/j/Genres?SortBy=ChildCount,SortName&SortOrder=Descending,Ascending',
                { user: ADULTS },
            );
            expect(names(byCount.body)[0]).toBe('Drama');
        });

        it('IsFavorite=true is empty (no favourite genres), false is everything', async () => {
            expect((await call<Page>(genresGet, '/j/Genres?IsFavorite=true')).body.Items).toEqual(
                [],
            );
            expect(
                names((await call<Page>(genresGet, '/j/Genres?IsFavorite=false')).body),
            ).toHaveLength(3);
        });

        it('ParentId scopes to a library; a denied one is empty; a music library lists music genres', async () => {
            expect(
                names((await call<Page>(genresGet, `/j/Genres?ParentId=${f.movies}`)).body),
            ).toEqual(['Action', 'Drama']);
            expect(
                (await call<Page>(genresGet, `/j/Genres?ParentId=${f.denied}`)).body.Items,
            ).toEqual([]);
            const music = await call<Page>(genresGet, `/j/Genres?ParentId=${f.music}`);
            expect(music.body.Items).toEqual([
                expect.objectContaining({ Name: 'Jazz', Type: 'MusicGenre', SongCount: 1 }),
            ]);
            const movie = await call<Page>(genresGet, `/j/Genres?ParentId=${f.movie}`);
            expect(names(movie.body)).toEqual(['Action', 'Drama']);
        });

        it('a series ParentId lists the genres of its episodes', async () => {
            const { body } = await call<Page>(genresGet, `/j/Genres?ParentId=${f.series}`);
            expect(names(body)).toEqual(['Reality']);
            const episodes = await call<Page>(genresGet, '/j/Genres?IncludeItemTypes=Episode');
            expect(episodes.body.Items).toEqual([
                expect.objectContaining({
                    Name: 'Reality',
                    Id: genreId('Reality'),
                    EpisodeCount: 1,
                }),
            ]);
        });

        it('GET /Genres/{name} also resolves a genre only episodes carry', async () => {
            const { status, body } = await call<Genre>(genreGet, '/j/Genres/Reality', {
                params: { genreName: 'reality' },
            });
            expect(status).toBe(200);
            expect(body).toMatchObject({ Name: 'Reality', Id: genreId('Reality') });
        });

        it('GET /Genres/{name} resolves by name, slug and Id; 404 when not visible', async () => {
            const byName = await call<Genre>(genreGet, '/j/Genres/drama', {
                params: { genreName: 'drama' },
            });
            expect(byName.status).toBe(200);
            expect(byName.body).toMatchObject({
                Name: 'Drama',
                Type: 'Genre',
                Id: genreId('Drama'),
                MovieCount: 1,
                SeriesCount: 0,
                ChildCount: 1,
            });

            const byId = await call<Genre>(genreGet, '/j/Genres/x', {
                params: { genreName: genreId('Action').replace(/-/g, '') },
            });
            expect(byId.body.Name).toBe('Action');

            const hidden = await call(genreGet, '/j/Genres/Horror', {
                params: { genreName: 'Horror' },
            });
            const unknown = await call(genreGet, '/j/Genres/Nope', {
                params: { genreName: 'Nope' },
            });
            expect(hidden.status).toBe(404);
            expect(hidden).toEqual(unknown);

            clearVideoGenreCache();
            const allowed = await call<Genre>(genreGet, '/j/Genres/Horror', {
                params: { genreName: 'Horror' },
                user: ADULTS,
            });
            expect(allowed.status).toBe(200);

            const blank = await call(genreGet, '/j/Genres/%20', { params: { genreName: ' ' } });
            expect(blank.status).toBe(422);
        });
    });

    // -----------------------------------------------------------------------
    // /MusicGenres
    // -----------------------------------------------------------------------

    describe('GET /MusicGenres', () => {
        interface Page {
            Items: {
                Name: string;
                Id: string;
                Type: string;
                SongCount: number;
                AlbumCount: number;
                ImageTags: Record<string, string>;
            }[];
            TotalRecordCount: number;
            StartIndex: number;
        }

        it('lists the music genres the user can see, with counts and cover', async () => {
            clearMusicGenreCache();
            const { status, body } = await call<Page>(musicGenresGet, '/j/MusicGenres');
            expect(status).toBe(200);
            expect(body.TotalRecordCount).toBe(1);
            expect(body.Items[0]).toMatchObject({
                Name: 'Jazz',
                Id: musicGenreId('Jazz'),
                Type: 'MusicGenre',
                SongCount: 1,
                AlbumCount: 1,
                ImageTags: { Primary: f.album.replace(/-/g, '') },
            });

            clearMusicGenreCache();
            const adults = await call<Page>(musicGenresGet, '/j/MusicGenres', { user: ADULTS });
            expect(adults.body.Items.map((g) => g.Name)).toEqual(['Jazz', 'Metal']);
            clearMusicGenreCache();
        });

        it('reads SearchTerm, NameStartsWith, paging, sort, IsFavorite and ParentId', async () => {
            const q = async (query: string): Promise<string[]> =>
                (
                    await call<Page>(musicGenresGet, `/j/MusicGenres?${query}`, { user: ADULTS })
                ).body.Items.map((g) => g.Name);
            expect(await q('SearchTerm=met')).toEqual(['Metal']);
            expect(await q('NameStartsWith=j')).toEqual(['Jazz']);
            expect(await q('SortBy=SortName&SortOrder=Descending')).toEqual(['Metal', 'Jazz']);
            expect(await q('StartIndex=1&Limit=1')).toEqual(['Metal']);
            expect(await q('IsFavorite=true')).toEqual([]);
            expect(await q(`ParentId=${f.album}`)).toEqual(['Jazz']);
            expect(await q(`ParentId=${f.artist}`)).toEqual(['Jazz']);
            expect(await q(`ParentId=${f.music}`)).toEqual(['Jazz']);
            expect(await q('IncludeItemTypes=MusicAlbum')).toEqual(['Jazz', 'Metal']);
        });

        it('a denied music library ParentId is empty for a user outside it', async () => {
            const { body } = await call<Page>(
                musicGenresGet,
                `/j/MusicGenres?ParentId=${f.deniedMusic}`,
            );
            expect(body.Items).toEqual([]);
        });
    });

    // -----------------------------------------------------------------------
    // /Search/Hints
    // -----------------------------------------------------------------------

    describe('GET /Search/Hints', () => {
        interface Hint {
            Id: string;
            Name: string;
            Type: string;
            Series?: string;
            IndexNumber?: number;
            ParentIndexNumber?: number;
        }
        interface Result {
            SearchHints: Hint[];
            TotalRecordCount: number;
        }
        const hints = async (query: string, user = KIDS): Promise<Result> => {
            const { status, body } = await call<Result>(hintsGet, `/j/Search/Hints?${query}`, {
                user,
            });
            expect(status).toBe(200);
            return body;
        };

        it('finds episodes with their series name and numbers', async () => {
            const body = await hints('SearchTerm=searchable');
            expect(body.SearchHints).toEqual([
                expect.objectContaining({
                    Id: f.episode,
                    Type: 'Episode',
                    Series: 'Filter Series',
                    ParentIndexNumber: 1,
                    IndexNumber: 3,
                }),
            ]);
            expect(body.TotalRecordCount).toBe(1);
        });

        it('never returns items from a denied library', async () => {
            expect((await hints('SearchTerm=forbidden')).SearchHints).toEqual([]);
            expect(
                (await hints('SearchTerm=forbidden', ADULTS)).SearchHints.map((h) => h.Id),
            ).toEqual([f.deniedMovie]);
            expect((await hints('SearchTerm=metal')).SearchHints).toEqual([]);
        });

        it('finds music and genres, and honours IncludeItemTypes / MediaTypes', async () => {
            const all = await hints('SearchTerm=filter');
            expect(all.SearchHints.map((h) => h.Type).sort()).toEqual(
                ['Audio', 'Movie', 'MusicAlbum', 'MusicArtist', 'Series'].sort(),
            );
            expect(all.TotalRecordCount).toBe(5);

            const movies = await hints('SearchTerm=filter&IncludeItemTypes=Movie');
            expect(movies.SearchHints.map((h) => h.Id)).toEqual([f.movie]);

            const audio = await hints('SearchTerm=filter&MediaTypes=Audio');
            expect(audio.SearchHints.map((h) => h.Id)).toEqual([f.track]);

            const genre = await hints('SearchTerm=drama');
            expect(genre.SearchHints).toEqual([
                expect.objectContaining({ Type: 'Genre', Name: 'Drama', Id: genreId('Drama') }),
            ]);
            const jazz = await hints('SearchTerm=jazz&IncludeItemTypes=MusicGenre');
            expect(jazz.SearchHints).toEqual([
                expect.objectContaining({ Type: 'MusicGenre', Id: musicGenreId('Jazz') }),
            ]);
            expect((await hints('SearchTerm=drama&IncludeGenres=false')).SearchHints).toEqual([]);
        });

        it('ExcludeItemTypes and IncludeArtists=false remove kinds', async () => {
            const body = await hints(
                'SearchTerm=filter&ExcludeItemTypes=Movie,Series&IncludeArtists=false',
            );
            expect(body.SearchHints.map((h) => h.Type).sort()).toEqual(['Audio', 'MusicAlbum']);
        });

        it('ParentId limits hits to that library and drops genres', async () => {
            const body = await hints(`SearchTerm=filter&ParentId=${f.movies}`);
            expect(body.SearchHints.map((h) => h.Id)).toEqual([f.movie]);
            const series = await hints(`SearchTerm=pilot&ParentId=${f.series}`);
            expect(series.SearchHints.map((h) => h.Id)).toEqual([f.episode]);
            const denied = await hints(`SearchTerm=forbidden&ParentId=${f.denied}`, KIDS);
            expect(denied).toEqual({ SearchHints: [], TotalRecordCount: 0 });
            expect((await hints(`SearchTerm=drama&ParentId=${f.movies}`)).SearchHints).toEqual([]);
        });

        it('pages with StartIndex / Limit and keeps the real total', async () => {
            const first = await hints('SearchTerm=filter&Limit=2');
            const second = await hints('SearchTerm=filter&Limit=2&StartIndex=2');
            const third = await hints('SearchTerm=filter&Limit=2&StartIndex=4');
            expect(first.TotalRecordCount).toBe(5);
            expect(second.TotalRecordCount).toBe(5);
            const ids = [...first.SearchHints, ...second.SearchHints, ...third.SearchHints].map(
                (h) => h.Id,
            );
            expect(ids).toHaveLength(5);
            expect(new Set(ids).size).toBe(5);
        });

        it('program flags no library item has return nothing', async () => {
            expect((await hints('SearchTerm=filter&IsSeries=true')).SearchHints).toEqual([]);
            expect(
                (await hints('SearchTerm=filter&IsMovie=true&IncludeItemTypes=Movie')).SearchHints,
            ).toHaveLength(1);
        });

        it("holds episodes to their series' age rating", async () => {
            const unrated = vi
                .spyOn(config, 'UNRATED_CONTENT_VISIBLE', 'get')
                .mockReturnValue(true);
            await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${f.series}`;
            try {
                // Unrated episodes are visible to the 12-year-old, but not those of an 18 series.
                expect((await hints('SearchTerm=searchable', TWELVE)).SearchHints).toEqual([]);
                expect((await hints('SearchTerm=searchable', ADULTS)).SearchHints).toHaveLength(1);

                clearItemFilterCache();
                const filters = await call<{ Years: number[] }>(
                    filtersGet,
                    '/j/Items/Filters?IncludeItemTypes=Episode',
                    { user: TWELVE },
                );
                expect(filters.body.Years).toEqual([]);

                await sql`UPDATE media_items SET age_rating = 6 WHERE id = ${f.series}`;
                clearItemFilterCache();
                expect((await hints('SearchTerm=searchable', TWELVE)).SearchHints).toHaveLength(1);
                const allowed = await call<{ Years: number[] }>(
                    filtersGet,
                    '/j/Items/Filters?IncludeItemTypes=Episode',
                    { user: TWELVE },
                );
                expect(allowed.body.Years).toEqual([2018]);
            } finally {
                await sql`UPDATE media_items SET age_rating = NULL WHERE id = ${f.series}`;
                clearItemFilterCache();
                unrated.mockRestore();
            }
        });

        it('reports orphan episodes (no season or series row) as hidden for age-limited users', async () => {
            const noSeason = await item('Orphan A', 'episode', null, { season: 1, episode: 1 });
            const emptySeason = await item('Empty Season', 'season', null, { hasFiles: false });
            const noSeries = await item('Orphan B', 'episode', emptySeason, {
                season: 1,
                episode: 2,
            });
            const limited = restrictedAccess({
                deniedGroupIds: [],
                maxAgeRating: 12,
                allowUnrated: true,
            });
            const unrestricted = restrictedAccess({
                deniedGroupIds: [],
                maxAgeRating: null,
                allowUnrated: true,
            });
            const ids = [noSeason, noSeries, f.episode];
            try {
                expect((await getEpisodesOfAgeHiddenSeries(sql, ids, limited)).sort()).toEqual(
                    [noSeason, noSeries].sort(),
                );
                expect(await getEpisodesOfAgeHiddenSeries(sql, ids, unrestricted)).toEqual([]);
            } finally {
                await sql`DELETE FROM media_items WHERE id = ANY(${[noSeason, noSeries, emptySeason]}::uuid[])`;
            }
        });

        it('bad paging parameters fall back to defaults', async () => {
            const body = await hints('SearchTerm=filter&Limit=abc&StartIndex=-4');
            expect(body.SearchHints).toHaveLength(5);
        });
    });
});
