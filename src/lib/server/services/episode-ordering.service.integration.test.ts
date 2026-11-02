// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for EpisodeOrderingService
 *
 * Tests the manual-ordering guard in syncOrderings against a real PostgreSQL
 * database. Requires the lumastra_tests database to be available.
 *
 * Run locally:
 *   npm run test:integration src/lib/server/services/episode-ordering.service.integration.test.ts
 *
 * Run against preprod:
 *   npm run test:integration -- src/lib/server/services/episode-ordering.service.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { EpisodeOrderingService } from './episode-ordering.service.js';
import {
    registerEpisodeGroupProvider,
    type EpisodeGroupProvider,
    type EpisodeGroupDetails,
} from '../providers/episode-group-provider.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_SERIES_ID = '00000000-0000-4000-a000-000000000ee1';
const TEST_PROVIDER = 'mock-test-provider';
const GROUP_G1 = 'group-manual-g1';
const GROUP_G2 = 'group-other-g2';

// ---------------------------------------------------------------------------
// Mock episode group provider
// ---------------------------------------------------------------------------

const mockGroupDetails: EpisodeGroupDetails = {
    groupId: GROUP_G2,
    groupName: 'Test Group G2',
    groupType: 'dvd',
    episodeCount: 2,
    groupCount: 1,
    seasons: [
        {
            order: 0,
            name: 'Season 1',
            episodes: [
                {
                    id: 1001,
                    seasonNumber: 1,
                    episodeNumber: 1,
                    order: 0,
                },
                {
                    id: 1002,
                    seasonNumber: 1,
                    episodeNumber: 2,
                    order: 1,
                },
            ],
        },
    ],
};

const mockProvider: EpisodeGroupProvider = {
    providerId: TEST_PROVIDER,
    async getEpisodeGroups() {
        return [];
    },
    async getGroupDetails(groupId: string): Promise<EpisodeGroupDetails | null> {
        if (groupId === GROUP_G2) {
            return mockGroupDetails;
        }
        return null;
    },
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let sql: postgres.Sql;

beforeAll(async () => {
    sql = getTestDb() as unknown as postgres.Sql;
    // Register the mock provider once for all tests
    registerEpisodeGroupProvider(mockProvider);
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    // Clean up ordering tables and the test series row before each test
    await sql`DELETE FROM episode_orderings WHERE series_media_id = ${TEST_SERIES_ID}`;
    await sql`DELETE FROM series_episode_ordering WHERE media_id = ${TEST_SERIES_ID}`;
    await sql`DELETE FROM media_items WHERE id = ${TEST_SERIES_ID}`;

    // Insert a minimal series row (media_type must use 'tv' — the DB constraint
    // uses lowercase 'tv' for TV series, not 'series')
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files)
        VALUES (
            ${TEST_SERIES_ID},
            'Integration Test Series',
            'tv',
            'active',
            false
        )
    `;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EpisodeOrderingService.syncOrderings — manual-ordering guard', () => {
    it('rejects without force when active ordering is manual and group differs', async () => {
        // Seed a manual ordering with GROUP_G1
        await sql`
            INSERT INTO series_episode_ordering
                (media_id, ordering_type, ordering_source, ordering_provider, ordering_group_id)
            VALUES
                (${TEST_SERIES_ID}, 'dvd', 'manual', ${TEST_PROVIDER}, ${GROUP_G1})
        `;

        const service = new EpisodeOrderingService(sql);

        await expect(
            service.syncOrderings(
                { mediaId: TEST_SERIES_ID },
                'dvd',
                TEST_PROVIDER,
                GROUP_G2,
                // no options → force defaults to false
            ),
        ).rejects.toThrow(/manual/i);
    });

    it('resolves with force:true even when active ordering is manual and group differs', async () => {
        // Seed a manual ordering with GROUP_G1
        await sql`
            INSERT INTO series_episode_ordering
                (media_id, ordering_type, ordering_source, ordering_provider, ordering_group_id)
            VALUES
                (${TEST_SERIES_ID}, 'dvd', 'manual', ${TEST_PROVIDER}, ${GROUP_G1})
        `;

        const service = new EpisodeOrderingService(sql);

        await expect(
            service.syncOrderings({ mediaId: TEST_SERIES_ID }, 'dvd', TEST_PROVIDER, GROUP_G2, {
                force: true,
            }),
        ).resolves.toBeTypeOf('number');
    });

    it('allows sync without force when active ordering source is auto', async () => {
        // Seed an auto ordering (not manually set)
        await sql`
            INSERT INTO series_episode_ordering
                (media_id, ordering_type, ordering_source, ordering_provider, ordering_group_id)
            VALUES
                (${TEST_SERIES_ID}, 'dvd', 'auto', ${TEST_PROVIDER}, ${GROUP_G1})
        `;

        const service = new EpisodeOrderingService(sql);

        await expect(
            service.syncOrderings({ mediaId: TEST_SERIES_ID }, 'dvd', TEST_PROVIDER, GROUP_G2),
        ).resolves.toBeTypeOf('number');
    });

    it('allows sync without force when group is the same as existing manual ordering', async () => {
        // Seed a manual ordering with GROUP_G2 — syncing the same group should be fine
        await sql`
            INSERT INTO series_episode_ordering
                (media_id, ordering_type, ordering_source, ordering_provider, ordering_group_id)
            VALUES
                (${TEST_SERIES_ID}, 'dvd', 'manual', ${TEST_PROVIDER}, ${GROUP_G2})
        `;

        const service = new EpisodeOrderingService(sql);

        await expect(
            service.syncOrderings({ mediaId: TEST_SERIES_ID }, 'dvd', TEST_PROVIDER, GROUP_G2),
        ).resolves.toBeTypeOf('number');
    });

    it('allows sync without force when no existing ordering is present', async () => {
        // No series_episode_ordering row → no guard should trigger
        const service = new EpisodeOrderingService(sql);

        await expect(
            service.syncOrderings({ mediaId: TEST_SERIES_ID }, 'dvd', TEST_PROVIDER, GROUP_G2),
        ).resolves.toBeTypeOf('number');
    });
});
