// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Route-level integration tests for the /j related-media routes: LocalTrailers,
 * SpecialFeatures, Theme*, Trailers, Movies/Recommendations and the Similar
 * aliases. withJellyfinAuth is bypassed and getDb points at the test database,
 * so the real handlers and queries run. What is under test is scoping: a
 * movie in a denied library group or above the user's age limit is 404 and
 * never leaks through a list, and bad ids are 404, not 500.
 */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    upsertLibraryGroupPermission,
    deleteLibraryGroupPermission,
} from '$lib/server/database/queries/library-group-permissions.queries.js';
import { invalidateLibraryGroupPermissionsCache } from '$lib/server/cache/library-group-permissions-cache.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/user.fixtures.js';
import {
    seedEmbedding,
    seedExtra,
    seedMovieEmbeddedSubs,
    seedProviderMetadata,
    seedUserState,
} from '../../../../../tests/jellyfin-contract/seed.js';

vi.setConfig({ testTimeout: 30_000 });

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

vi.mock('$lib/server/database', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database')>();
    const { getTestDb: getSql } =
        await import('../../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

const R = '../../../../routes/(proprietary)/j';

interface TestUser {
    userId: string;
    userGroups?: string[];
    maxAgeRating?: number | null;
}

function event(path: string, params: Record<string, string>, user: TestUser): RequestEvent {
    const url = new URL(`http://localhost/j${path}`);
    const restricted = user.maxAgeRating != null;
    return {
        url,
        request: new Request(url),
        locals: {
            user: {
                username: 'related-media-test',
                userId: toUserId(user.userId),
                groups: (user.userGroups ?? []).join(','),
                userGroups: user.userGroups ?? [],
                hasWatchPermission: true,
                hasLiveTvPermission: false,
                hasRequestPermission: false,
                ownerIsAdmin: false,
                maxAgeRating: user.maxAgeRating ?? null,
                isAgeRestricted: restricted,
                isModerator: false,
                liveTvPriority: 'low',
            },
        },
        params,
        route: { id: null },
        cookies: {} as never,
        fetch,
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
        depends: () => undefined,
        untrack: <T>(fn: () => T) => fn(),
    } as unknown as RequestEvent;
}

type Handler = (e: RequestEvent) => Promise<Response>;

async function call(
    handler: unknown,
    path: string,
    params: Record<string, string>,
    user: TestUser,
): Promise<{ status: number; body: unknown }> {
    const res = await (handler as Handler)(event(path, params, user));
    return { status: res.status, body: await res.json() };
}

describe.runIf(RUN)('/j related-media routes — access scoping', () => {
    let sql: postgres.Sql;
    let deniedGroupId: string;
    const kids: TestUser = { userId: randomUUID(), userGroups: ['kids'] };
    const adults: TestUser = { userId: randomUUID(), userGroups: ['adults'] };
    const age12: TestUser = { userId: randomUUID(), userGroups: ['adults'], maxAgeRating: 12 };

    /** visible: plain movie; hidden: in the adults-only group; mature: age_rating 18. */
    let visible: string;
    let hidden: string;
    let mature: string;
    let visibleTrailer: string;
    let hiddenTrailer: string;
    let matureTrailer: string;

    beforeAll(async () => {
        sql = getTestDb();
        deniedGroupId = randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroupId}::uuid, 'Related Media Adults')`;
        await upsertLibraryGroupPermission(sql, {
            libraryGroupId: deniedGroupId,
            allowedGroups: ['adults'],
        });
        invalidateLibraryGroupPermissionsCache();
    });

    afterAll(async () => {
        await deleteLibraryGroupPermission(sql, deniedGroupId);
        await sql`DELETE FROM library_groups WHERE id = ${deniedGroupId}::uuid`;
        invalidateLibraryGroupPermissionsCache();
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
        for (const u of [kids, adults, age12]) await ensureTestUser(sql, u.userId);
        visible = (await seedMovieEmbeddedSubs(sql)).itemId;
        const h = await seedMovieEmbeddedSubs(sql);
        hidden = h.itemId;
        await sql`UPDATE media_files SET library_group_id = ${deniedGroupId}::uuid WHERE id = ${h.fileId}::uuid`;
        mature = (await seedMovieEmbeddedSubs(sql)).itemId;
        await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${mature}::uuid`;
        await sql`UPDATE media_items SET age_rating = 6 WHERE id IN (${visible}::uuid, ${hidden}::uuid)`;
        await sql`UPDATE media_items SET title = 'Hidden Movie' WHERE id = ${hidden}::uuid`;
        await sql`UPDATE media_items SET title = 'Mature Movie' WHERE id = ${mature}::uuid`;
        visibleTrailer = (await seedExtra(sql, visible, 'trailer', 'trailer')).itemId;
        hiddenTrailer = (await seedExtra(sql, hidden, 'trailer', 'trailer')).itemId;
        matureTrailer = (await seedExtra(sql, mature, 'trailer', 'trailer')).itemId;
        // A featurette whose file is gone stays out of every list.
        const lost = await seedExtra(sql, visible, 'featurette', 'Luma Featurette');
        await sql`UPDATE media_files SET is_missing = true WHERE id = ${lost.fileId}::uuid`;
        await seedExtra(sql, visible, 'behind_the_scenes', 'On Set');
    });

    it('LocalTrailers / SpecialFeatures: 404 for a denied or age-limited movie, data otherwise', async () => {
        const { GET: trailers } = await import(`${R}/Items/[itemId]/LocalTrailers/+server`);
        const { GET: features } = await import(`${R}/Items/[itemId]/SpecialFeatures/+server`);

        expect((await call(trailers, '', { itemId: hidden }, kids)).status).toBe(404);
        expect((await call(features, '', { itemId: hidden }, kids)).status).toBe(404);
        expect((await call(trailers, '', { itemId: mature }, age12)).status).toBe(404);

        const ok = await call(trailers, '', { itemId: hidden }, adults);
        expect(ok.status).toBe(200);
        expect((ok.body as { Id: string }[]).map((i) => i.Id)).toEqual([hiddenTrailer]);

        const f = await call(features, '', { itemId: visible }, kids);
        expect(f.status).toBe(200);
        expect(
            (f.body as { Name: string; ExtraType: string }[]).map((i) => [i.Name, i.ExtraType]),
        ).toEqual([['On Set', 'BehindTheScenes']]);
    });

    it('legacy /Users/{userId}/Items/{itemId}/LocalTrailers applies the same gate', async () => {
        const { GET } = await import(`${R}/Users/[userId]/Items/[itemId]/LocalTrailers/+server`);
        const params = { userId: kids.userId, itemId: hidden };
        expect((await call(GET, '', params, kids)).status).toBe(404);
        const ok = await call(GET, '', { ...params, itemId: visible }, kids);
        expect((ok.body as { Id: string }[]).map((i) => i.Id)).toEqual([visibleTrailer]);
    });

    it('unknown and malformed ids are 404', async () => {
        const { GET: trailers } = await import(`${R}/Items/[itemId]/LocalTrailers/+server`);
        const { GET: features } = await import(`${R}/Items/[itemId]/SpecialFeatures/+server`);
        const { GET: similar } = await import(`${R}/Movies/[itemId]/Similar/+server`);
        for (const itemId of [randomUUID(), 'not-a-uuid']) {
            expect((await call(trailers, '', { itemId }, adults)).status).toBe(404);
            expect((await call(features, '', { itemId }, adults)).status).toBe(404);
            expect((await call(similar, '', { itemId }, adults)).status).toBe(404);
        }
    });

    it('Theme*: always an empty result owned by the id, whoever asks; malformed id 404', async () => {
        const { GET: media } = await import(`${R}/Items/[itemId]/ThemeMedia/+server`);
        const { GET: songs } = await import(`${R}/Items/[itemId]/ThemeSongs/+server`);
        // A hidden item and a non-media id (library view, person) answer alike,
        // so the route cannot tell a caller which ids are hidden media.
        const unknown = randomUUID();
        for (const itemId of [visible, hidden, unknown]) {
            const res = await call(media, '', { itemId }, kids);
            expect(res).toEqual({
                status: 200,
                body: {
                    ThemeVideosResult: {
                        Items: [],
                        TotalRecordCount: 0,
                        StartIndex: 0,
                        OwnerId: itemId,
                    },
                    ThemeSongsResult: {
                        Items: [],
                        TotalRecordCount: 0,
                        StartIndex: 0,
                        OwnerId: itemId,
                    },
                    SoundtrackSongsResult: {
                        Items: [],
                        TotalRecordCount: 0,
                        StartIndex: 0,
                        OwnerId: itemId,
                    },
                },
            });
        }
        expect((await call(songs, '', { itemId: 'not-a-uuid' }, kids)).status).toBe(404);
    });

    it('an age-limited user only gets extras PlaybackInfo would let them play', async () => {
        const { GET: trailers } = await import(`${R}/Items/[itemId]/LocalTrailers/+server`);
        const { GET: item } = await import(`${R}/Items/[itemId]/+server`);
        // Extras carry no age_rating; with unrated content hidden (the default)
        // PlaybackInfo refuses them, so the list and the count leave them out.
        expect((await call(trailers, '', { itemId: visible }, age12)).body).toEqual([]);
        const detail = (await call(item, '', { itemId: visible }, age12)).body as {
            LocalTrailerCount: number;
            SpecialFeatureCount: number;
        };
        expect([detail.LocalTrailerCount, detail.SpecialFeatureCount]).toEqual([0, 0]);
        await sql`UPDATE media_items SET age_rating = 6 WHERE id = ${visibleTrailer}::uuid`;
        const ok = await call(trailers, '', { itemId: visible }, age12);
        expect((ok.body as { Id: string }[]).map((i) => i.Id)).toEqual([visibleTrailer]);
        const unrestricted = (await call(item, '', { itemId: visible }, kids)).body as {
            LocalTrailerCount: number;
            SpecialFeatureCount: number;
        };
        expect([unrestricted.LocalTrailerCount, unrestricted.SpecialFeatureCount]).toEqual([1, 1]);
    });

    it('Similar: a dashless id never lists itself; a trailer answers for its movie; an orphaned extra is 404', async () => {
        const { GET } = await import(`${R}/Trailers/[itemId]/Similar/+server`);
        for (const [id, n] of [
            [visible, 0],
            [mature, 1],
        ] as const) {
            await seedEmbedding(sql, id, n);
        }
        const ids = async (itemId: string): Promise<string[]> =>
            ((await call(GET, '', { itemId }, kids)).body as { Items: { Id: string }[] }).Items.map(
                (i) => i.Id,
            );
        expect(await ids(visible.replace(/-/g, ''))).toEqual([mature]);
        expect(await ids(visibleTrailer)).toEqual([mature]);
        // A hidden movie's trailer is gated on the movie.
        expect((await call(GET, '', { itemId: hiddenTrailer }, kids)).status).toBe(404);
        await sql`UPDATE media_items SET parent_id = NULL WHERE id = ${visibleTrailer}::uuid`;
        expect((await call(GET, '', { itemId: visibleTrailer }, kids)).status).toBe(404);
    });

    it('/Trailers lists only trailers of visible movies, and pages', async () => {
        const { GET } = await import(`${R}/Trailers/+server`);
        type Page = { Items: { Id: string }[]; TotalRecordCount: number; StartIndex: number };
        const ids = async (u: TestUser, q = ''): Promise<Page> =>
            (await call(GET, `/Trailers${q}`, {}, u)).body as Page;

        expect((await ids(kids)).Items.map((i) => i.Id).sort()).toEqual(
            [visibleTrailer, matureTrailer].sort(),
        );
        // Unrated extras are hidden from an age-limited user (see above); rated
        // ones show unless their movie is above the limit.
        expect((await ids(age12)).Items).toEqual([]);
        await sql`UPDATE media_items SET age_rating = 6 WHERE media_type = 'extra'`;
        expect((await ids(age12)).Items.map((i) => i.Id).sort()).toEqual(
            [visibleTrailer, hiddenTrailer].sort(),
        );
        const page = await ids(adults, '?SortBy=SortName&Limit=1&StartIndex=1');
        expect(page).toMatchObject({ TotalRecordCount: 3, StartIndex: 1 });
        expect(page.Items.map((i) => i.Id)).toEqual([hiddenTrailer]); // Contract, Hidden, Mature
        const past = await ids(adults, '?Limit=5&StartIndex=10');
        expect(past).toMatchObject({ Items: [], TotalRecordCount: 3 });
        const search = await ids(adults, '?SearchTerm=hidden');
        expect(search.Items.map((i) => i.Id)).toEqual([hiddenTrailer]);
        // LIKE wildcards are literal.
        expect((await ids(adults, '?SearchTerm=%25')).Items).toEqual([]);
    });

    it('Movies/Recommendations never recommends what the user cannot see', async () => {
        const { GET } = await import(`${R}/Movies/Recommendations/+server`);
        const people = { actors: ['Shared Actor'], directors: [] };
        for (const [id, n] of [
            [visible, 0],
            [hidden, 1],
            [mature, 2],
        ] as const) {
            await seedEmbedding(sql, id, n);
            await seedProviderMetadata(sql, id, people);
        }
        const other = (await seedMovieEmbeddedSubs(sql)).itemId;
        await seedEmbedding(sql, other, 3);
        await seedProviderMetadata(sql, other, people);
        await seedUserState(sql, kids.userId, other, { watched: true });

        const res = await call(GET, '/Movies/Recommendations', {}, kids);
        expect(res.status).toBe(200);
        const cats = res.body as { RecommendationType: string; Items: { Id: string }[] }[];
        const all = cats.flatMap((c) => c.Items.map((i) => i.Id));
        expect(all).not.toContain(hidden);
        expect(all).not.toContain(other);
        expect(all.sort()).toEqual([visible, mature].sort());

        // No history → no categories.
        expect((await call(GET, '/Movies/Recommendations', {}, adults)).body).toEqual([]);
        // categoryLimit=0 → empty, not an error.
        const zero = await call(GET, '/Movies/Recommendations?categoryLimit=0', {}, kids);
        expect(zero).toEqual({ status: 200, body: [] });
    });

    it('Shows/{id}/Similar answers an empty list for an episode, as Jellyfin does', async () => {
        const { GET } = await import(`${R}/Shows/[seriesId]/Similar/+server`);
        const [ep] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, has_files)
            VALUES ('Lone Episode', 'episode', 'active', true) RETURNING id`;
        const res = await call(GET, '', { seriesId: ep.id }, adults);
        expect(res).toEqual({
            status: 200,
            body: { Items: [], TotalRecordCount: 0, StartIndex: 0 },
        });
    });
});
