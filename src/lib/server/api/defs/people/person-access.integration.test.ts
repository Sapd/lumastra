// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
import { closeTestDb, getTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from '$lib/server/database/queries/builders/media-access-boundary.js';

const { getSql } = vi.hoisted(() => ({ getSql: vi.fn() }));
vi.mock('$lib/server/services/database.service.js', () => ({ aiDbService: { getSql } }));
vi.mock('$lib/server/tasks/plugin-context.js', () => ({
    getProvidersByPriority: () => [],
    invokeProviderGetPersonDetail: vi.fn(),
}));
vi.mock('$lib/server/cache/index.js', () => ({
    CACHE_NAMESPACES: { personDetails: {} },
    cacheManager: { for: () => ({ get: vi.fn(), set: vi.fn() }) },
}));
import {
    applyLibraryAccessFilter,
    toPersonResponse,
    type PersonDetails,
} from '$lib/server/services/person.service.js';

afterAll(closeTestDb);
const rollback = new Error('rollback');

it('filters movie and series credits with real library/age SQL before libraryOnly serialization', async () => {
    await getTestDb()
        .begin(async (sql) => {
            getSql.mockResolvedValue(sql);
            const allowed = randomUUID(),
                denied = randomUUID();
            await sql`INSERT INTO library_groups (id,name) VALUES (${allowed},${'Allowed ' + allowed}), (${denied},${'Denied ' + denied})`;
            const credits: PersonDetails = {
                id: 123,
                name: 'Fixture Person',
                movieCredits: [],
                tvCredits: [],
            };
            let seq = 0;
            for (const type of ['movie', 'tv'] as const) {
                for (const [group, age] of [
                    [allowed, 6],
                    [denied, 6],
                    [allowed, 18],
                ] as const) {
                    const id = randomUUID();
                    await sql`INSERT INTO media_items (id,title,media_type,status,has_files,age_rating)
                    VALUES (${id},${'Fixture ' + id},${type},'active',true,${age})`;
                    let leaf = id;
                    if (type === 'tv') {
                        const season = randomUUID();
                        leaf = randomUUID();
                        await sql`INSERT INTO media_items (id,title,media_type,parent_id) VALUES (${season},'Season','season',${id})`;
                        await sql`INSERT INTO media_items (id,title,media_type,parent_id) VALUES (${leaf},'Episode','episode',${season})`;
                    }
                    const file = randomUUID();
                    await sql`INSERT INTO media_files (id,file_path,library_group_id) VALUES (${file},${'/fixture/' + file + '.mkv'},${group})`;
                    await sql`INSERT INTO media_file_items (file_id,media_item_id) VALUES (${file},${leaf})`;
                    const credit = {
                        externalIds: { internal: id, tmdb: String(++seq) },
                        title: 'Fixture',
                        isAvailable: true,
                        canRequest: false,
                    };
                    if (type === 'movie')
                        credits.movieCredits.push({ ...credit, mediaType: 'movie' });
                    else credits.tvCredits.push({ ...credit, mediaType: 'series' });
                }
            }
            const full = toPersonResponse(
                await applyLibraryAccessFilter(credits, unrestrictedAccess()),
                'v1',
                true,
            );
            expect(full.movieCredits).toHaveLength(3);
            expect(full.tvCredits).toHaveLength(3);
            const boundary = restrictedAccess({
                deniedGroupIds: [denied],
                maxAgeRating: 12,
                allowUnrated: false,
            });
            const filtered = await applyLibraryAccessFilter(credits, boundary);
            const owned = toPersonResponse(filtered, 'v1', true);
            expect(owned.movieCredits.map((c) => c.catalogId)).toEqual([
                credits.movieCredits[0].externalIds.internal,
            ]);
            expect(owned.tvCredits.map((c) => c.catalogId)).toEqual([
                credits.tvCredits[0].externalIds.internal,
            ]);
            const discovery = toPersonResponse(filtered);
            expect(discovery.movieCredits[1]).toMatchObject({
                id: 'tmdb:2:movie',
                catalogId: null,
                availability: { isAvailable: false, canRequest: true },
            });
            expect(
                toPersonResponse(
                    await applyLibraryAccessFilter(credits, denyAllAccess()),
                    'v1',
                    true,
                ).movieCredits,
            ).toEqual([]);
            // Shared cache input must retain its UUIDs for the next user's request.
            expect(credits.movieCredits.every((c) => c.externalIds.internal)).toBe(true);
            throw rollback;
        })
        .catch((error) => {
            if (error !== rollback) throw error;
        });
});
