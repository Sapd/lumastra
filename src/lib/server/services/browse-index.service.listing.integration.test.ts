// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { closeTestDb, getTestDb } from '../../../../tests/integration/setup/test-database.js';
import { TEST_TABLES, truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import { placeInLibraryGroup } from '../../../../tests/integration/fixtures/library-access.fixtures.js';
import { toUserId } from '$lib/shared/user-id.js';
import type { UserContext } from '$lib/server/types.js';
import * as accessContext from '$lib/server/utils/search-access-context.js';
import { loadMediaListing } from './browse-index.service.js';

const user: UserContext = {
    userId: toUserId(randomUUID()),
    username: 'listing-test',
    groups: '',
    userGroups: [],
    hasWatchPermission: true,
    hasLiveTvPermission: false,
    hasRequestPermission: false,
    ownerIsAdmin: true,
    maxAgeRating: null,
    isAgeRestricted: false,
    isModerator: false,
    liveTvPriority: 'low',
};

describe('public media listing against seeded PostgreSQL', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        vi.spyOn(accessContext, 'buildSearchAccessContext').mockResolvedValue({
            username: user.username,
            deniedGroupIds: null,
            ageRating: null,
            liveTvAllowed: false,
            showUnavailableMedia: false,
        });
    });
    afterAll(async () => {
        vi.restoreAllMocks();
        await closeTestDb();
    });
    async function seed(
        title: string,
        year: number,
        rating: number,
        runtime: number,
    ): Promise<string> {
        const [row] = await sql<Array<{ id: string }>>`INSERT INTO media_items
            (media_type, title, sort_title, year, status, has_files, runtime_seconds)
            VALUES ('movie', ${title}, ${title.toLowerCase()}, ${year}, 'active', true, ${
                runtime * 60
            }) RETURNING id`;
        await sql`INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
            VALUES (${row.id}::uuid, 'tmdb', ${sql.json({
                imdb_rating: rating,
                runtime_minutes: runtime,
                genres: [{ id: 28, name: 'Action' }],
            })}, NOW())`;
        return row.id;
    }
    const options = { sort: 'title', order: 'asc', limit: 1, offset: 0 } as const;
    it('pages stable title ties without duplicates and reports totals', async () => {
        const first = await seed('Alpha', 2000, 6, 90);
        const second = await seed('Alpha', 2010, 8, 120);
        const a = await loadMediaListing(sql, user, 'v1', options);
        const b = await loadMediaListing(sql, user, 'v1', { ...options, offset: 1 });
        expect([a.items[0].id, b.items[0].id]).toEqual([first, second].sort());
        expect(a.page).toMatchObject({ total: 2, hasMore: true });
        expect(b.page.hasMore).toBe(false);
    });
    it('composes letter, genre and year filters and returns optional facets', async () => {
        await seed('Alpha', 2000, 6, 90);
        await seed('Zulu', 2010, 8, 120);
        const page = await loadMediaListing(sql, user, 'v1', {
            ...options,
            letter: 'A',
            genre: 'Action',
            year: 2000,
            include: 'facets',
        });
        expect(page.items.map((item) => item.title)).toEqual(['Alpha']);
        expect(page.facets?.letterCounts).toContainEqual({ letter: 'A', count: 1 });
    });
    it('orders newly added titles in both directions', async () => {
        const older = await seed('Alpha', 2000, 6, 90);
        const newer = await seed('Zulu', 2010, 8, 120);
        await sql`UPDATE media_items SET library_added_at = '2026-01-01' WHERE id = ${older}::uuid`;
        await sql`UPDATE media_items SET library_added_at = '2026-02-01' WHERE id = ${newer}::uuid`;
        expect(
            (await loadMediaListing(sql, user, 'v1', { ...options, sort: 'added', order: 'desc' }))
                .items[0].id,
        ).toBe(newer);
        expect(
            (await loadMediaListing(sql, user, 'v1', { ...options, sort: 'added', order: 'asc' }))
                .items[0].id,
        ).toBe(older);
    });
    it.each(['year', 'rating', 'runtime'] as const)('sorts %s in both directions', async (sort) => {
        await seed('Alpha', 2000, 6, 90);
        await seed('Zulu', 2010, 8, 120);
        expect(
            (await loadMediaListing(sql, user, 'v1', { ...options, sort, order: 'desc' })).items[0]
                .title,
        ).toBe('Zulu');
        expect(
            (await loadMediaListing(sql, user, 'v1', { ...options, sort, order: 'asc' })).items[0]
                .title,
        ).toBe('Alpha');
    });
    it('excludes a denied library from items, totals and facets', async () => {
        const hidden = await seed('Hidden', 2000, 6, 90);
        await seed('Visible', 2010, 8, 120);
        const group = randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${group}::uuid, 'Listing denied')`;
        await placeInLibraryGroup(sql, {
            mediaItemId: hidden,
            mediaType: 'movie',
            libraryGroupId: group,
        });
        vi.mocked(accessContext.buildSearchAccessContext).mockResolvedValue({
            username: user.username,
            deniedGroupIds: [group],
            ageRating: null,
            liveTvAllowed: false,
            showUnavailableMedia: false,
        });
        const page = await loadMediaListing(sql, user, 'v1', { ...options, include: 'facets' });
        expect(page.items.map((item) => item.title)).toEqual(['Visible']);
        expect(page.page.total).toBe(1);
        expect(page.facets?.letterCounts).not.toContainEqual({ letter: 'H', count: 1 });
    });
    it('applies libraryGroupId and age restrictions before offset, totals and facets', async () => {
        const shelf = randomUUID();
        const otherShelf = randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES
            (${shelf}::uuid, 'Selected shelf'), (${otherShelf}::uuid, 'Other shelf')`;
        const rows = [
            [await seed('A Other shelf', 2000, 6, 90), otherShelf, 0],
            [await seed('B Adult', 2000, 6, 90), shelf, 18],
            [await seed('C First child title', 2000, 6, 90), shelf, 6],
            [await seed('D Second child title', 2000, 6, 90), shelf, 6],
        ] as const;
        for (const [id, libraryGroupId, age] of rows) {
            await placeInLibraryGroup(sql, { mediaItemId: id, mediaType: 'movie', libraryGroupId });
            await sql`UPDATE media_items SET age_rating = ${age} WHERE id = ${id}::uuid`;
        }
        vi.mocked(accessContext.buildSearchAccessContext).mockResolvedValue({
            username: user.username,
            deniedGroupIds: null,
            ageRating: { maxAgeRating: 12, allowUnrated: false },
            liveTvAllowed: false,
            showUnavailableMedia: false,
        });
        const page = await loadMediaListing(sql, user, 'v1', {
            ...options,
            libraryGroupId: shelf,
            offset: 1,
            include: 'facets',
        });
        expect(page.items.map((item) => item.title)).toEqual(['D Second child title']);
        expect(page.page).toMatchObject({ total: 2, hasMore: false, offset: 1 });
        expect(page.facets?.letterCounts).toEqual([
            { letter: 'C', count: 1 },
            { letter: 'D', count: 1 },
        ]);
        vi.mocked(accessContext.buildSearchAccessContext).mockResolvedValue({
            username: user.username,
            deniedGroupIds: [shelf],
            ageRating: null,
            liveTvAllowed: false,
            showUnavailableMedia: false,
        });
        const denied = await loadMediaListing(sql, user, 'v1', {
            ...options,
            libraryGroupId: shelf,
            include: 'facets',
        });
        expect(denied.items).toEqual([]);
        expect(denied.page.total).toBe(0);
    });
});
