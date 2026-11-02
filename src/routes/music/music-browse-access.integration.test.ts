// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Route-level integration test: the /music/albums, /music/artists and
 * /music/genres/[genre] page-loads, the genre-rail section endpoint and the
 * genre carousel plan apply the caller's real access boundary.
 *
 * All of them used to query with `unrestrictedAccess()`, so a user denied a
 * library group (or under an age limit) saw those albums and artists in the
 * first SSR page of the grid, while /api/music/albums and /api/music/artists —
 * which serve every later page — filtered them out. The genre-rail endpoint's
 * `?ids=` path served any track id the client named.
 *
 * Drives the REAL `load` exports against a real Postgres database. Each case
 * also loads as an admin and asserts the hidden rows ARE there for them: the
 * loads swallow errors into an empty list, so "the denied album is absent" on
 * its own would also pass for a load that failed outright.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
import type { UserContext } from '$lib/server/types.js';
import { getTestDb, closeTestDb } from '../../../tests/integration/setup/test-database.js';
import { createAndInsertTestMusicHierarchy } from '../../../tests/integration/fixtures/index.js';
import { createLibraryGroup } from '$lib/server/database/queries/library-groups.queries.js';
import { upsertLibraryGroupPermission } from '$lib/server/database/queries/library-group-permissions.queries.js';
import { invalidateLibraryGroupPermissionsCache } from '$lib/server/cache/library-group-permissions-cache.js';
import { computeGenrePlan } from '$lib/server/services/music/genre-plan.service.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';

vi.setConfig({ testTimeout: 30_000 });

vi.mock('$lib/server/services/database.service.js', async () => {
    const { getTestDb: getSql } = await import('../../../tests/integration/setup/test-database.js');
    return { aiDbService: { getSql: async () => getSql() } };
});

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

const { load: loadAlbums } = await import('./albums/+page.server.js');
const { load: loadMusicHome } = await import('./+page.server.js');
const { load: loadArtists } = await import('./artists/+page.server.js');
const { load: loadGenre } = await import('./genres/[genre]/+page.server.js');
const { GET: getGenreSection } = await import('../api/music/sections/genre/[name]/+server.js');

function fullUser(overrides: Partial<UserContext> = {}): UserContext {
    // Every field UserContext declares, typed against the real interface so a
    // missing field is a compile error rather than a silently-passing gate.
    return {
        userId: toUserId(randomUUID()),
        username: `music-browse-${randomUUID()}`,
        groups: '',
        userGroups: [],
        hasWatchPermission: true,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        ownerIsAdmin: false,
        maxAgeRating: null,
        isAgeRestricted: false,
        isModerator: false,
        liveTvPriority: 'low',
        ...overrides,
    };
}

/** The fields these loads read; the rest of the load event is irrelevant. */
function event(path: string, user: UserContext, params: Record<string, string> = {}): never {
    return { url: new URL(`http://localhost${path}`), locals: { user }, params } as never;
}

type IdRows = { id: string }[];

async function albumIds(user: UserContext): Promise<string[]> {
    const data = (await loadAlbums(event('/music/albums', user))) as { albums: IdRows };
    return data.albums.map((a) => a.id);
}

async function artistIds(user: UserContext): Promise<string[]> {
    const data = (await loadArtists(event('/music/artists', user))) as { artists: IdRows };
    return data.artists.map((a) => a.id);
}

async function genre(user: UserContext): Promise<{ albums: string[]; tracks: string[] }> {
    const data = (await loadGenre(event('/music/genres/Rock', user, { genre: 'Rock' }))) as {
        albums: IdRows;
        tracks: IdRows;
    };
    return { albums: data.albums.map((a) => a.id), tracks: data.tracks.map((t) => t.id) };
}

type GenreSectionEvent = Parameters<NonNullable<typeof getGenreSection>>[0];

/** Track ids in a genre-rail section response (`null` body = no rail). */
async function sectionTrackIds(user: UserContext, query: string): Promise<string[]> {
    const url = new URL(`http://localhost/api/music/sections/genre/Rock${query}`);
    const res = await getGenreSection!({
        params: { name: 'Rock' },
        url,
        request: new Request(url),
        locals: { user },
    } as unknown as GenreSectionEvent);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string }[] } | null;
    return body ? body.items.map((i) => i.id) : [];
}

async function planTrackIds(sql: postgres.Sql, user: UserContext): Promise<string[]> {
    const plan = await computeGenrePlan(sql, String(user.userId), {
        recentlyPlayedIds: [],
        genreCarouselNames: ['Rock'],
        access: searchAccessBoundary(await buildSearchAccessContext(sql, user)),
    });
    return plan.Rock ?? [];
}

describe.runIf(RUN)('music browse page-loads apply the caller access boundary', () => {
    let sql: postgres.Sql;
    const groupIds: string[] = [];
    let allowed: Awaited<ReturnType<typeof createAndInsertTestMusicHierarchy>>;
    let denied: Awaited<ReturnType<typeof createAndInsertTestMusicHierarchy>>;
    let adult: Awaited<ReturnType<typeof createAndInsertTestMusicHierarchy>>;

    const admin = () => fullUser({ ownerIsAdmin: true });
    // Not in 'adults', so denied the restricted library group.
    const groupDenied = () => fullUser({ userGroups: ['kids'] });
    // In 'adults' (no library restriction) but age-limited to 12.
    const ageLimited = () =>
        fullUser({ userGroups: ['adults'], maxAgeRating: 12, isAgeRestricted: true });

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        // Deleting the groups also cascades their permissions. beforeEach's
        // TRUNCATE alone leaves the last case's global restriction for the next file.
        await sql`DELETE FROM library_groups WHERE id = ANY(${groupIds}::uuid[])`;
        invalidateLibraryGroupPermissionsCache();
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql.unsafe(
            'TRUNCATE TABLE media_embeddings, media_file_items, media_files, watch_history, media_items, library_group_permissions CASCADE',
        );
        invalidateLibraryGroupPermissionsCache();

        allowed = await createAndInsertTestMusicHierarchy(sql, {
            artistTitle: 'Allowed Artist',
            trackCount: 2,
            genre: 'Rock',
        });
        denied = await createAndInsertTestMusicHierarchy(sql, {
            artistTitle: 'Denied Artist',
            trackCount: 2,
            genre: 'Rock',
        });
        adult = await createAndInsertTestMusicHierarchy(sql, {
            artistTitle: 'Adult Artist',
            trackCount: 2,
            genre: 'Rock',
        });

        // Unrated items are hidden under an age limit by default
        // (UNRATED_CONTENT_VISIBLE=false), so rate the allowed tree explicitly.
        await sql`UPDATE media_items SET age_rating = 6
                  WHERE id = ANY(${[allowed.artistId, allowed.albumId, ...allowed.trackIds]}::uuid[])`;
        await sql`UPDATE media_items SET age_rating = 18
                  WHERE id = ANY(${[adult.artistId, adult.albumId, ...adult.trackIds]}::uuid[])`;

        const group = await createLibraryGroup(sql, { name: `Restricted ${randomUUID()}` });
        groupIds.push(group.id);
        await sql`UPDATE media_files SET library_group_id = ${group.id}
                  WHERE id IN (SELECT file_id FROM media_file_items
                               WHERE media_item_id = ANY(${denied.trackIds}::uuid[]))`;
        await upsertLibraryGroupPermission(sql, {
            libraryGroupId: group.id,
            allowedGroups: ['adults'],
        });
        invalidateLibraryGroupPermissionsCache();
    });

    /**
     * Admin control for the curated paths: they cap tracks per album, so not
     * every track appears, but each hidden album must contribute at least one
     * — otherwise "absent for the restricted user" proves nothing.
     */
    function expectSomeOfEach(ids: string[]): void {
        expect(denied.trackIds.some((id) => ids.includes(id))).toBe(true);
        expect(adult.trackIds.some((id) => ids.includes(id))).toBe(true);
    }

    it('/music/albums hides albums in a denied library group', async () => {
        expect(await albumIds(admin())).toEqual(
            expect.arrayContaining([allowed.albumId, denied.albumId]),
        );

        const ids = await albumIds(groupDenied());
        expect(ids).toContain(allowed.albumId);
        expect(ids).not.toContain(denied.albumId);
    });

    it('/music/albums hides albums above the age limit', async () => {
        expect(await albumIds(admin())).toContain(adult.albumId);

        const ids = await albumIds(ageLimited());
        expect(ids).toContain(allowed.albumId);
        expect(ids).not.toContain(adult.albumId);
    });

    it('/music/artists hides artists whose only tracks are in a denied library group', async () => {
        expect(await artistIds(admin())).toEqual(
            expect.arrayContaining([allowed.artistId, denied.artistId]),
        );

        const ids = await artistIds(groupDenied());
        expect(ids).toContain(allowed.artistId);
        expect(ids).not.toContain(denied.artistId);
    });

    it('/music/artists hides artists whose only tracks are above the age limit', async () => {
        expect(await artistIds(admin())).toContain(adult.artistId);

        const ids = await artistIds(ageLimited());
        expect(ids).toContain(allowed.artistId);
        expect(ids).not.toContain(adult.artistId);
    });

    it('/music/genres/[genre] hides denied-group and over-age albums and tracks', async () => {
        const all = await genre(admin());
        expect(all.albums).toEqual(
            expect.arrayContaining([allowed.albumId, denied.albumId, adult.albumId]),
        );
        expect(all.tracks).toEqual(
            expect.arrayContaining([...allowed.trackIds, ...denied.trackIds, ...adult.trackIds]),
        );

        const byGroup = await genre(groupDenied());
        expect(byGroup.albums).toContain(allowed.albumId);
        expect(byGroup.albums).not.toContain(denied.albumId);
        expect(byGroup.tracks).toEqual(expect.arrayContaining(allowed.trackIds));
        for (const id of denied.trackIds) expect(byGroup.tracks).not.toContain(id);

        const byAge = await genre(ageLimited());
        expect(byAge.albums).toContain(allowed.albumId);
        expect(byAge.albums).not.toContain(adult.albumId);
        for (const id of adult.trackIds) expect(byAge.tracks).not.toContain(id);
    });
    it('/music/genres/[genre] counts only the tracks of a partly denied album', async () => {
        // Deny one of the allowed album's two tracks: the album stays, but its
        // card must not count (or time) the track the viewer cannot play.
        const [deniedGroupId] = (
            await sql<{ library_group_id: string }[]>`
                SELECT library_group_id::text FROM media_files
                WHERE library_group_id IS NOT NULL LIMIT 1`
        ).map((r) => r.library_group_id);
        await sql`UPDATE media_files SET library_group_id = ${deniedGroupId}
                  WHERE id IN (SELECT file_id FROM media_file_items
                               WHERE media_item_id = ${allowed.trackIds[0]})`;

        const data = (await loadGenre(
            event('/music/genres/Rock', groupDenied(), { genre: 'Rock' }),
        )) as { albums: { id: string; trackCount: number }[] };
        expect(data.albums.find((a) => a.id === allowed.albumId)?.trackCount).toBe(1);

        const asAdmin = (await loadGenre(
            event('/music/genres/Rock', admin(), { genre: 'Rock' }),
        )) as { albums: { id: string; trackCount: number }[] };
        expect(asAdmin.albums.find((a) => a.id === allowed.albumId)?.trackCount).toBe(2);
    });

    it('genre-rail section endpoint hides denied-group and over-age tracks on every path', async () => {
        const everything = [...allowed.trackIds, ...denied.trackIds, ...adult.trackIds];
        const hidden = { group: denied.trackIds, age: adult.trackIds };

        // ?ids= — the ids come from the client, so naming a hidden track
        // must not be enough to receive it.
        expect(await sectionTrackIds(admin(), `?ids=${everything.join(',')}`)).toEqual(
            expect.arrayContaining(everything),
        );
        for (const [user, ids] of [
            [groupDenied(), hidden.group],
            [ageLimited(), hidden.age],
        ] as const) {
            const served = await sectionTrackIds(user, `?ids=${everything.join(',')}`);
            expect(served).toEqual(expect.arrayContaining(allowed.trackIds));
            for (const id of ids) expect(served).not.toContain(id);
        }

        // Unplanned fallback and "load more" (?exclude=).
        for (const query of ['', '?exclude=&limit=20']) {
            expectSomeOfEach(await sectionTrackIds(admin(), query));

            const byGroup = await sectionTrackIds(groupDenied(), query);
            expect(byGroup.length).toBeGreaterThan(0);
            for (const id of hidden.group) expect(byGroup).not.toContain(id);

            const byAge = await sectionTrackIds(ageLimited(), query);
            expect(byAge.length).toBeGreaterThan(0);
            for (const id of hidden.age) expect(byAge).not.toContain(id);
        }
    });

    it('genre carousel plan never plans a track the viewer cannot play', async () => {
        expectSomeOfEach(await planTrackIds(sql, admin()));

        const byGroup = await planTrackIds(sql, groupDenied());
        expect(byGroup.length).toBeGreaterThan(0);
        for (const id of denied.trackIds) expect(byGroup).not.toContain(id);

        const byAge = await planTrackIds(sql, ageLimited());
        expect(byAge.length).toBeGreaterThan(0);
        for (const id of adult.trackIds) expect(byAge).not.toContain(id);
    });

    // Last on purpose: the /music home load leaves fire-and-forget queries
    // running, and the next case's TRUNCATE deadlocks against them.
    it('/music home radio shelf hides stations above the age limit', async () => {
        const kids = randomUUID();
        const late = randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, age_rating, created_at, updated_at)
            VALUES (${kids}::uuid, 'Kids Radio', 'radio', 'active', 6, NOW(), NOW()),
                   (${late}::uuid, 'Late Night Radio', 'radio', 'active', 18, NOW(), NOW())
        `;
        const stations = async (user: UserContext): Promise<string[]> => {
            const data = (await loadMusicHome(event('/music', user))) as {
                radioStations: IdRows;
            };
            return data.radioStations.map((s) => s.id);
        };
        // Admin control: both are there, so absence below is the filter, not a failed load.
        expect(await stations(admin())).toEqual(expect.arrayContaining([kids, late]));
        const limited = await stations(ageLimited());
        expect(limited).toContain(kids);
        expect(limited).not.toContain(late);
    });
});
