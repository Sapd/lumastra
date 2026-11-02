// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for season-structure-reconciliation.service
 *
 * Exercises detectSeasonStructureFix / applySeasonStructureFix /
 * maybeAutoFixSeasonStructure against a real PostgreSQL database, plus a
 * direct Tier-3 check of linkEpisodeMediaIds. Requires the lumastra_tests
 * database to be available.
 *
 * Run locally:
 *   npm run test:integration src/lib/server/services/season-structure-reconciliation.service.integration.test.ts
 *
 * Run against preprod:
 *   npm run test:integration -- src/lib/server/services/season-structure-reconciliation.service.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    detectSeasonStructureFix,
    applySeasonStructureFix,
    maybeAutoFixSeasonStructure,
} from './season-structure-reconciliation.service.js';
import {
    registerEpisodeGroupProvider,
    type EpisodeGroupProvider,
    type EpisodeGroupDetails,
    type EpisodeGroupSummary,
} from '../providers/episode-group-provider.js';
import { linkEpisodeMediaIds } from '../database/queries/episode-orderings.queries.js';
import type { TmdbCatalogEpisode } from './episode-reconciliation.service.js';
import { ensureTestUser } from '../../../../tests/integration/fixtures/index.js';
import { undoReconciliationMove } from './episode-reconciliation-undo.service.js';

// The blocked-pair lookup runs after the holders are read and before the first
// binding: a window the TOCTOU test uses to change the ghost.
const blockedLookup = vi.hoisted(() => ({
    fn: undefined as unknown as ReturnType<typeof vi.fn>,
    real: undefined as unknown as (...args: unknown[]) => Promise<unknown>,
}));
vi.mock('../database/queries/episode-reconciliation-moves.queries.js', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('../database/queries/episode-reconciliation-moves.queries.js')
        >();
    blockedLookup.real = actual.loadBlockedPairKeys as unknown as typeof blockedLookup.real;
    blockedLookup.fn = vi.fn(actual.loadBlockedPairKeys);
    return { ...actual, loadBlockedPairKeys: blockedLookup.fn };
});

// ---------------------------------------------------------------------------
// Fixed UUIDs
// ---------------------------------------------------------------------------

// Main fixture: TVDB-style season split (season 1 canonical on TMDB, split
// into disk seasons 1+2 by the provider episode group).
const SERIES_ID = '00000000-0000-4000-a000-000000001001';
const SEASON1_ID = '00000000-0000-4000-a000-000000001002';
const SEASON2_ID = '00000000-0000-4000-a000-000000001003';
const S1E1_ID = '00000000-0000-4000-a000-000000001004';
const S1E2_ID = '00000000-0000-4000-a000-000000001005';
const S1E3_ID = '00000000-0000-4000-a000-000000001006'; // ghost holder
const S1E4_ID = '00000000-0000-4000-a000-000000001007'; // ghost holder
const S2E1_ID = '00000000-0000-4000-a000-000000001008';
const S2E2_ID = '00000000-0000-4000-a000-000000001009';
// Ghost holder for a group position with no local file (the trailing,
// not-yet-downloaded tail of the last bucket — Re:Zero S4E12-19 on prod).
const S1E5_ID = '00000000-0000-4000-a000-00000000100a';
// Occupies the relocation target (season 2 episode 3) in the collision test.
// metadata_locked so it is excluded from bindings and cannot absorb id 105.
const S2E3_LOCKED_ID = '00000000-0000-4000-a000-00000000100b';

// Lock fixture: same shape, but the second unmatched episode is metadata_locked.
const LOCK_SERIES_ID = '00000000-0000-4000-a000-000000002001';
const LOCK_SEASON1_ID = '00000000-0000-4000-a000-000000002002';
const LOCK_SEASON2_ID = '00000000-0000-4000-a000-000000002003';
const LOCK_S1E1_ID = '00000000-0000-4000-a000-000000002004';
const LOCK_S1E2_ID = '00000000-0000-4000-a000-000000002005';
const LOCK_S1E3_ID = '00000000-0000-4000-a000-000000002006';
const LOCK_S1E4_ID = '00000000-0000-4000-a000-000000002007';
const LOCK_S2E1_ID = '00000000-0000-4000-a000-000000002008';
const LOCK_S2E2_ID = '00000000-0000-4000-a000-000000002009';

// Tier-3 fixture: minimal series for a direct linkEpisodeMediaIds check.
const T3_SERIES_ID = '00000000-0000-4000-a000-000000003001';
const T3_SEASON_ID = '00000000-0000-4000-a000-000000003002';
const T3_EP1_ID = '00000000-0000-4000-a000-000000003003';
const T3_EP2_ID = '00000000-0000-4000-a000-000000003004';

// Test user for the ghost→successor user-state migration test. Uses a
// non-'00000000'-prefixed id: ensureTestUser derives the username from the
// first 8 hex chars, and the shared test DB already has other fixtures
// registered under the all-zero prefix — colliding on the users.username
// UNIQUE constraint even though the ids themselves differ.
const TEST_USER_ID = '9f3e7a21-0000-4000-b000-000000000001';

const EPISODE_IDS = [
    S1E1_ID,
    S1E2_ID,
    S1E3_ID,
    S1E4_ID,
    S1E5_ID,
    S2E1_ID,
    S2E2_ID,
    S2E3_LOCKED_ID,
    LOCK_S1E1_ID,
    LOCK_S1E2_ID,
    LOCK_S1E3_ID,
    LOCK_S1E4_ID,
    LOCK_S2E1_ID,
    LOCK_S2E2_ID,
    T3_EP1_ID,
    T3_EP2_ID,
];

const CONTAINER_IDS = [
    SERIES_ID,
    SEASON1_ID,
    SEASON2_ID,
    LOCK_SERIES_ID,
    LOCK_SEASON1_ID,
    LOCK_SEASON2_ID,
    T3_SERIES_ID,
    T3_SEASON_ID,
];

// ---------------------------------------------------------------------------
// Mock episode group provider
// ---------------------------------------------------------------------------

const MOCK_PROVIDER = 'mock-season-structure-provider';
const GROUP_SPLIT = 'g-split';
const GROUP_WRONG = 'g-wrong';
const GROUP_DUP = 'g-dup';
const GROUP_SPECIALS = 'g-specials';
const GROUP_TAIL = 'g-tail';

const GROUP_SPLIT_SUMMARY: EpisodeGroupSummary = {
    groupId: GROUP_SPLIT,
    groupName: 'TVDB Split (Test)',
    groupType: 'other',
    episodeCount: 4,
    groupCount: 2,
};

const GROUP_WRONG_SUMMARY: EpisodeGroupSummary = {
    groupId: GROUP_WRONG,
    groupName: 'Contradicting Group (Test)',
    groupType: 'other',
    episodeCount: 2,
    groupCount: 1,
};

const GROUP_DUP_SUMMARY: EpisodeGroupSummary = {
    groupId: GROUP_DUP,
    groupName: 'Duplicate Id (Test)',
    groupType: 'other',
    episodeCount: 4,
    groupCount: 2,
};

const GROUP_SPECIALS_SUMMARY: EpisodeGroupSummary = {
    groupId: GROUP_SPECIALS,
    groupName: 'Specials Bucket (Test)',
    groupType: 'other',
    episodeCount: 6,
    groupCount: 3,
};

// group index+1 = season, order+1 = episode: season1={101(S1E1),102(S1E2)},
// season2={103(S1E3),104(S1E4)} — matches the disk-side S1/S2 split while
// TMDB's own numbering (seasonNumber/episodeNumber) stays season 1 throughout.
const GROUP_SPLIT_DETAILS: EpisodeGroupDetails = {
    groupId: GROUP_SPLIT,
    groupName: 'TVDB Split (Test)',
    groupType: 'other',
    episodeCount: 4,
    groupCount: 2,
    seasons: [
        {
            order: 0,
            name: 'Season 1',
            episodes: [
                { id: 101, seasonNumber: 1, episodeNumber: 1, order: 0, name: 'Ep1 Name' },
                { id: 102, seasonNumber: 1, episodeNumber: 2, order: 1, name: 'Ep2 Name' },
            ],
        },
        {
            order: 1,
            name: 'Season 2',
            episodes: [
                { id: 103, seasonNumber: 1, episodeNumber: 3, order: 0, name: 'Real Title E3' },
                { id: 104, seasonNumber: 1, episodeNumber: 4, order: 1, name: 'Real Title E4' },
            ],
        },
    ],
};

// Contradicts the existing S1E1 tmdb binding (101) by mapping position 1:1 to
// a different tmdb episode id (999).
const GROUP_WRONG_DETAILS: EpisodeGroupDetails = {
    groupId: GROUP_WRONG,
    groupName: 'Contradicting Group (Test)',
    groupType: 'other',
    episodeCount: 2,
    groupCount: 1,
    seasons: [
        {
            order: 0,
            name: 'Season 1',
            episodes: [
                { id: 999, seasonNumber: 1, episodeNumber: 1, order: 0, name: 'Wrong Ep1' },
                { id: 998, seasonNumber: 1, episodeNumber: 2, order: 1, name: 'Wrong Ep2' },
            ],
        },
    ],
};

// Both season-2 positions resolve to the SAME tmdb id (103) — malformed group
// data that must be rejected rather than colliding in upsertExternalId.
const GROUP_DUP_DETAILS: EpisodeGroupDetails = {
    groupId: GROUP_DUP,
    groupName: 'Duplicate Id (Test)',
    groupType: 'other',
    episodeCount: 4,
    groupCount: 2,
    seasons: [
        {
            order: 0,
            name: 'Season 1',
            episodes: [
                { id: 101, seasonNumber: 1, episodeNumber: 1, order: 0, name: 'Ep1 Name' },
                { id: 102, seasonNumber: 1, episodeNumber: 2, order: 1, name: 'Ep2 Name' },
            ],
        },
        {
            order: 1,
            name: 'Season 2',
            episodes: [
                { id: 103, seasonNumber: 1, episodeNumber: 3, order: 0, name: 'Real Title E3' },
                { id: 103, seasonNumber: 1, episodeNumber: 4, order: 1, name: 'Real Title E3 Dup' },
            ],
        },
    ],
};

// A leading pure-specials bucket (all episodes at TMDB original season 0)
// followed by the same two real buckets as GROUP_SPLIT_DETAILS. The specials
// bucket must be filtered out BEFORE group-season numbers are assigned, so
// the real buckets still resolve to groupSeasonNumber 1/2 (not 2/3).
const GROUP_SPECIALS_DETAILS: EpisodeGroupDetails = {
    groupId: GROUP_SPECIALS,
    groupName: 'Specials Bucket (Test)',
    groupType: 'other',
    episodeCount: 6,
    groupCount: 3,
    seasons: [
        {
            order: 0,
            name: 'Specials',
            episodes: [
                { id: 9001, seasonNumber: 0, episodeNumber: 1, order: 0, name: 'Special 1' },
                { id: 9002, seasonNumber: 0, episodeNumber: 2, order: 1, name: 'Special 2' },
            ],
        },
        {
            order: 1,
            name: 'Season 1',
            episodes: [
                { id: 101, seasonNumber: 1, episodeNumber: 1, order: 0, name: 'Ep1 Name' },
                { id: 102, seasonNumber: 1, episodeNumber: 2, order: 1, name: 'Ep2 Name' },
            ],
        },
        {
            order: 2,
            name: 'Season 2',
            episodes: [
                { id: 103, seasonNumber: 1, episodeNumber: 3, order: 0, name: 'Real Title E3' },
                { id: 104, seasonNumber: 1, episodeNumber: 4, order: 1, name: 'Real Title E4' },
            ],
        },
    ],
};

const GROUP_TAIL_SUMMARY: EpisodeGroupSummary = {
    groupId: GROUP_TAIL,
    groupName: 'Specials + Trailing Tail (Test)',
    groupType: 'other',
    episodeCount: 7,
    groupCount: 3,
};

/**
 * Re:Zero's real prod shape: a leading specials bucket (filtered from the
 * position map, so the group can never be activated as the display ordering)
 * plus a last bucket whose tail positions have no local file yet.
 */
const GROUP_TAIL_DETAILS: EpisodeGroupDetails = {
    groupId: GROUP_TAIL,
    groupName: 'Specials + Trailing Tail (Test)',
    groupType: 'other',
    episodeCount: 7,
    groupCount: 3,
    seasons: [
        {
            order: 0,
            name: 'Specials',
            episodes: [
                { id: 9001, seasonNumber: 0, episodeNumber: 1, order: 0, name: 'Special 1' },
                { id: 9002, seasonNumber: 0, episodeNumber: 2, order: 1, name: 'Special 2' },
            ],
        },
        {
            order: 1,
            name: 'Season 1',
            episodes: [
                { id: 101, seasonNumber: 1, episodeNumber: 1, order: 0, name: 'Ep1 Name' },
                { id: 102, seasonNumber: 1, episodeNumber: 2, order: 1, name: 'Ep2 Name' },
            ],
        },
        {
            order: 2,
            name: 'Season 2',
            episodes: [
                { id: 103, seasonNumber: 1, episodeNumber: 3, order: 0, name: 'Real Title E3' },
                { id: 104, seasonNumber: 1, episodeNumber: 4, order: 1, name: 'Real Title E4' },
                // No local file at group position 2:3 — the ghost holding this
                // id must be RELOCATED to season 2 episode 3, not left stranded
                // at its canonical season-1 position.
                { id: 105, seasonNumber: 1, episodeNumber: 5, order: 2, name: 'Real Title E5' },
            ],
        },
    ],
};

// Controls what getEpisodeGroups() returns; reset per-test.
let groupsToReturn: EpisodeGroupSummary[] = [];

const mockProvider: EpisodeGroupProvider = {
    providerId: MOCK_PROVIDER,
    async getEpisodeGroups() {
        return groupsToReturn;
    },
    async getGroupDetails(groupId: string): Promise<EpisodeGroupDetails | null> {
        if (groupId === GROUP_SPLIT) return GROUP_SPLIT_DETAILS;
        if (groupId === GROUP_WRONG) return GROUP_WRONG_DETAILS;
        if (groupId === GROUP_DUP) return GROUP_DUP_DETAILS;
        if (groupId === GROUP_SPECIALS) return GROUP_SPECIALS_DETAILS;
        if (groupId === GROUP_TAIL) return GROUP_TAIL_DETAILS;
        return null;
    },
};

const CATALOG: TmdbCatalogEpisode[] = [
    {
        tmdbEpisodeId: '101',
        name: 'Ep1 Name',
        altNames: [],
        overview: 'Overview 1',
        seasonNumber: 1,
        episodeNumber: 1,
        stillPath: null,
    },
    {
        tmdbEpisodeId: '102',
        name: 'Ep2 Name',
        altNames: [],
        overview: 'Overview 2',
        seasonNumber: 1,
        episodeNumber: 2,
        stillPath: null,
    },
    {
        tmdbEpisodeId: '103',
        name: 'Real Title E3',
        altNames: [],
        overview: 'Overview 3',
        seasonNumber: 1,
        episodeNumber: 3,
        stillPath: '/still103.jpg',
    },
    {
        tmdbEpisodeId: '104',
        name: 'Real Title E4',
        altNames: [],
        overview: 'Overview 4',
        seasonNumber: 1,
        episodeNumber: 4,
        stillPath: '/still104.jpg',
    },
    {
        tmdbEpisodeId: '105',
        name: 'Real Title E5',
        altNames: [],
        overview: 'Overview 5',
        seasonNumber: 1,
        episodeNumber: 5,
        stillPath: null,
    },
];

const DEPS = { provider: MOCK_PROVIDER, seriesExternalId: 'ext-series-1', catalog: CATALOG };

// ---------------------------------------------------------------------------
// Fixture seeding helpers
// ---------------------------------------------------------------------------

async function seedMainFixture(sql: postgres.Sql): Promise<void> {
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files)
        VALUES (${SERIES_ID}, 'Shangri-La Frontier (Test)', 'tv', 'active', true)
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number)
        VALUES (${SEASON1_ID}, 'Season 1', 'season', 'active', true, ${SERIES_ID}, 1)
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number)
        VALUES (${SEASON2_ID}, 'Season 2', 'season', 'active', true, ${SERIES_ID}, 2)
    `;

    // File-backed, already tmdb-bound episodes (season 1).
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
        VALUES (${S1E1_ID}, 'Ep1 Name', 'episode', 'active', true, ${SEASON1_ID}, 1, 1)
    `;
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
        VALUES (${S1E1_ID}, 'tmdb', '101', 'episode', true, 'test-fixture')
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
        VALUES (${S1E2_ID}, 'Ep2 Name', 'episode', 'active', true, ${SEASON1_ID}, 1, 2)
    `;
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
        VALUES (${S1E2_ID}, 'tmdb', '102', 'episode', true, 'test-fixture')
    `;

    // File-less ghost holders at TMDB's canonical positions (season 1, episodes 3-4).
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
        VALUES (${S1E3_ID}, 'Ghost Ep3', 'episode', 'active', false, ${SEASON1_ID}, 1, 3)
    `;
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
        VALUES (${S1E3_ID}, 'tmdb', '103', 'episode', true, 'test-fixture')
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
        VALUES (${S1E4_ID}, 'Ghost Ep4', 'episode', 'active', false, ${SEASON1_ID}, 1, 4)
    `;
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
        VALUES (${S1E4_ID}, 'tmdb', '104', 'episode', true, 'test-fixture')
    `;

    // File-backed, unmatched episodes (season 2 — the disk-side TVDB split).
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
        VALUES (${S2E1_ID}, 'Show.S02E01', 'episode', 'active', true, ${SEASON2_ID}, 2, 1)
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
        VALUES (${S2E2_ID}, 'Show.S02E02', 'episode', 'active', true, ${SEASON2_ID}, 2, 2)
    `;
}

/**
 * Main fixture plus one extra file-less ghost at canonical season 1 episode 5,
 * holding the tmdb id that GROUP_TAIL maps to season 2 episode 3 (a position
 * with no local file).
 */
async function seedTailFixture(sql: postgres.Sql): Promise<void> {
    await seedMainFixture(sql);
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
        VALUES (${S1E5_ID}, 'Ghost Ep5', 'episode', 'active', false, ${SEASON1_ID}, 1, 5)
    `;
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
        VALUES (${S1E5_ID}, 'tmdb', '105', 'episode', true, 'test-fixture')
    `;
}

async function seedLockFixture(sql: postgres.Sql): Promise<void> {
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files)
        VALUES (${LOCK_SERIES_ID}, 'Shangri-La Frontier Locked (Test)', 'tv', 'active', true)
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number)
        VALUES (${LOCK_SEASON1_ID}, 'Season 1', 'season', 'active', true, ${LOCK_SERIES_ID}, 1)
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number)
        VALUES (${LOCK_SEASON2_ID}, 'Season 2', 'season', 'active', true, ${LOCK_SERIES_ID}, 2)
    `;

    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
        VALUES (${LOCK_S1E1_ID}, 'Ep1 Name', 'episode', 'active', true, ${LOCK_SEASON1_ID}, 1, 1)
    `;
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
        VALUES (${LOCK_S1E1_ID}, 'tmdb', '101', 'episode', true, 'test-fixture')
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
        VALUES (${LOCK_S1E2_ID}, 'Ep2 Name', 'episode', 'active', true, ${LOCK_SEASON1_ID}, 1, 2)
    `;
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
        VALUES (${LOCK_S1E2_ID}, 'tmdb', '102', 'episode', true, 'test-fixture')
    `;

    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
        VALUES (${LOCK_S1E3_ID}, 'Ghost Ep3', 'episode', 'active', false, ${LOCK_SEASON1_ID}, 1, 3)
    `;
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
        VALUES (${LOCK_S1E3_ID}, 'tmdb', '103', 'episode', true, 'test-fixture')
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
        VALUES (${LOCK_S1E4_ID}, 'Ghost Ep4', 'episode', 'active', false, ${LOCK_SEASON1_ID}, 1, 4)
    `;
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
        VALUES (${LOCK_S1E4_ID}, 'tmdb', '104', 'episode', true, 'test-fixture')
    `;

    // Unmatched season-2 episodes — the second one is metadata_locked and must
    // be excluded from both detection's `fixable` set and any title/id write.
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
        VALUES (${LOCK_S2E1_ID}, 'Show.S02E01', 'episode', 'active', true, ${LOCK_SEASON2_ID}, 2, 1)
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number, metadata_locked)
        VALUES (${LOCK_S2E2_ID}, 'Show.S02E02', 'episode', 'active', true, ${LOCK_SEASON2_ID}, 2, 2, true)
    `;
}

async function seedTier3Fixture(sql: postgres.Sql): Promise<void> {
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files)
        VALUES (${T3_SERIES_ID}, 'Tier3 Series (Test)', 'tv', 'active', true)
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number)
        VALUES (${T3_SEASON_ID}, 'Season 2', 'season', 'active', true, ${T3_SERIES_ID}, 2)
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
        VALUES (${T3_EP1_ID}, 'Show.S02E01', 'episode', 'active', true, ${T3_SEASON_ID}, 2, 1)
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
        VALUES (${T3_EP2_ID}, 'Show.S02E02', 'episode', 'active', true, ${T3_SEASON_ID}, 2, 2)
    `;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let sql: postgres.Sql;

beforeAll(async () => {
    sql = getTestDb() as unknown as postgres.Sql;
    registerEpisodeGroupProvider(mockProvider);
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    blockedLookup.fn.mockReset();
    blockedLookup.fn.mockImplementation(blockedLookup.real);
    groupsToReturn = [];
    await sql`DROP TRIGGER IF EXISTS test_block_ghost_delete ON media_items`;
    await sql`DROP FUNCTION IF EXISTS test_block_ghost_delete()`;
    await sql`DELETE FROM sync_quarantine WHERE provider IN ('lumastra-reconcile-absolute', 'lumastra-reconcile-season-structure')`;

    // episode_orderings / series_episode_ordering cascade from media_items,
    // but are cleared explicitly first since Tier-3 rows may reference a
    // series without necessarily being re-created inside the same test.
    await sql`DELETE FROM episode_orderings WHERE series_media_id = ANY(${CONTAINER_IDS})`;
    await sql`DELETE FROM series_episode_ordering WHERE media_id = ANY(${CONTAINER_IDS})`;
    // Undo records outlive their episode (episode_id is SET NULL): clear them by series.
    await sql`DELETE FROM episode_reconciliation_moves WHERE series_id = ANY(${CONTAINER_IDS})`;
    // Episodes (children) before seasons/series (parents) — parent_id is
    // ON DELETE SET NULL, not CASCADE.
    await sql`DELETE FROM media_items WHERE id = ANY(${EPISODE_IDS})`;
    await sql`DELETE FROM media_items WHERE id = ANY(${CONTAINER_IDS})`;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectSeasonStructureFix', () => {
    it('finds group g-split covering the unmatched season-2 episodes', async () => {
        await seedMainFixture(sql);
        groupsToReturn = [GROUP_SPLIT_SUMMARY];

        const detection = await detectSeasonStructureFix(sql, SERIES_ID, DEPS);

        expect(detection).not.toBeNull();
        expect(detection?.groupId).toBe(GROUP_SPLIT);
        expect(detection?.agreements).toBe(2);
        expect(detection?.exactStructure).toBe(true);
        expect(detection?.bindings).toHaveLength(2);

        const bindingByPosition = new Map(
            detection?.bindings.map((b) => [`${b.seasonNumber}:${b.episodeNumber}`, b]),
        );
        expect(bindingByPosition.get('2:1')?.tmdbEpisodeId).toBe('103');
        expect(bindingByPosition.get('2:2')?.tmdbEpisodeId).toBe('104');
    });

    it('returns null when a manual series ordering exists', async () => {
        await seedMainFixture(sql);
        await sql`
            INSERT INTO series_episode_ordering
                (media_id, ordering_type, ordering_source, ordering_provider, ordering_group_id)
            VALUES
                (${SERIES_ID}, 'dvd', 'manual', ${MOCK_PROVIDER}, 'some-manual-group')
        `;
        groupsToReturn = [GROUP_SPLIT_SUMMARY];

        const detection = await detectSeasonStructureFix(sql, SERIES_ID, DEPS);

        expect(detection).toBeNull();
    });

    it('rejects a group that contradicts an existing tmdb binding', async () => {
        await seedMainFixture(sql);
        groupsToReturn = [GROUP_WRONG_SUMMARY];

        const detection = await detectSeasonStructureFix(sql, SERIES_ID, DEPS);

        expect(detection).toBeNull();
    });

    it('excludes metadata_locked episodes from bindings', async () => {
        await seedLockFixture(sql);
        groupsToReturn = [GROUP_SPLIT_SUMMARY];

        const detection = await detectSeasonStructureFix(sql, LOCK_SERIES_ID, DEPS);

        expect(detection).not.toBeNull();
        expect(detection?.bindings).toHaveLength(1);
        expect(detection?.bindings[0]?.episodeId).toBe(LOCK_S2E1_ID);
        expect(detection?.bindings[0]?.tmdbEpisodeId).toBe('103');
    });

    it('rejects a group whose position map resolves two fixable episodes to the same tmdb id', async () => {
        await seedMainFixture(sql);
        groupsToReturn = [GROUP_DUP_SUMMARY];

        const detection = await detectSeasonStructureFix(sql, SERIES_ID, DEPS);

        expect(detection).toBeNull();
    });

    it('skips a pure-specials (season 0) bucket without shifting later season numbers', async () => {
        await seedMainFixture(sql);
        groupsToReturn = [GROUP_SPECIALS_SUMMARY];

        const detection = await detectSeasonStructureFix(sql, SERIES_ID, DEPS);

        expect(detection).not.toBeNull();
        expect(detection?.groupId).toBe(GROUP_SPECIALS);
        expect(detection?.bindings).toHaveLength(2);

        const bindingByPosition = new Map(
            detection?.bindings.map((b) => [`${b.seasonNumber}:${b.episodeNumber}`, b]),
        );
        expect(bindingByPosition.get('2:1')?.tmdbEpisodeId).toBe('103');
        expect(bindingByPosition.get('2:2')?.tmdbEpisodeId).toBe('104');
    });
});

describe('applySeasonStructureFix', () => {
    it('binds tmdb identity onto the file rows, deletes ghosts, and activates the ordering', async () => {
        await seedMainFixture(sql);
        groupsToReturn = [GROUP_SPLIT_SUMMARY];
        const detection = await detectSeasonStructureFix(sql, SERIES_ID, DEPS);
        expect(detection).not.toBeNull();

        const result = await applySeasonStructureFix(sql, detection!, DEPS);

        expect(result.bound).toBe(2);
        expect(result.skipped).toBe(0);
        expect(result.ghostsDeleted).toBe(2);
        expect(result.emptySeasonsDeleted).toBe(0);
        expect(result.orderingApplied).toBe(true);

        const s2e1 = await sql<{ external_id: string; title: string; title_binding: string }[]>`
            SELECT ei.external_id, mi.title, mi.title_binding
            FROM media_items mi
            JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'tmdb'
            WHERE mi.id = ${S2E1_ID}
        `;
        expect(s2e1[0]?.external_id).toBe('103');
        expect(s2e1[0]?.title).toBe('Real Title E3');
        expect(s2e1[0]?.title_binding).toBe('identity');

        const s2e2 = await sql<{ external_id: string; title: string; title_binding: string }[]>`
            SELECT ei.external_id, mi.title, mi.title_binding
            FROM media_items mi
            JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'tmdb'
            WHERE mi.id = ${S2E2_ID}
        `;
        expect(s2e2[0]?.external_id).toBe('104');
        expect(s2e2[0]?.title).toBe('Real Title E4');
        expect(s2e2[0]?.title_binding).toBe('identity');

        const ghosts = await sql`SELECT id FROM media_items WHERE id = ANY(${[S1E3_ID, S1E4_ID]})`;
        expect(ghosts).toHaveLength(0);

        const ordering = await sql<
            { ordering_source: string; ordering_group_id: string; ordering_provider: string }[]
        >`
            SELECT ordering_source, ordering_group_id, ordering_provider
            FROM series_episode_ordering
            WHERE media_id = ${SERIES_ID}
        `;
        expect(ordering[0]?.ordering_source).toBe('auto');
        expect(ordering[0]?.ordering_group_id).toBe(GROUP_SPLIT);
        expect(ordering[0]?.ordering_provider).toBe(MOCK_PROVIDER);

        const orderS2Rows = await sql<{ provider_episode_id: string; episode_media_id: string }[]>`
            SELECT provider_episode_id, episode_media_id
            FROM episode_orderings
            WHERE series_media_id = ${SERIES_ID}
              AND provider = ${MOCK_PROVIDER}
              AND ordering_group_id = ${GROUP_SPLIT}
              AND order_season_number = 2
            ORDER BY order_episode_number
        `;
        expect(orderS2Rows).toHaveLength(2);
        expect(orderS2Rows[0]?.episode_media_id).toBe(S2E1_ID);
        expect(orderS2Rows[1]?.episode_media_id).toBe(S2E2_ID);

        // control: still_path is written for both unlocked destinations
        // (C3, 2026-09-24 security review) - this write previously had no
        // lock guard at all, unlike the sibling media_items title UPDATE.
        const [s2e1Pm] = await sql<{ metadata: Record<string, unknown> }[]>`
            SELECT metadata FROM provider_metadata WHERE media_id = ${S2E1_ID} AND provider = 'tmdb'
        `;
        const [s2e2Pm] = await sql<{ metadata: Record<string, unknown> }[]>`
            SELECT metadata FROM provider_metadata WHERE media_id = ${S2E2_ID} AND provider = 'tmdb'
        `;
        expect(s2e1Pm.metadata.still_path).toBe('/still103.jpg');
        expect(s2e2Pm.metadata.still_path).toBe('/still104.jpg');
    });

    // C3 (2026-09-24 security review): the still_path provider_metadata write
    // previously had NO lock guard at all, unlike the sibling media_items
    // title UPDATE a few lines above it. Lock the binding TARGET after
    // detection (a TOCTOU race, same shape as this file's other staleness
    // tests) so the still-path write is the only thing under test.
    it('does NOT write still_path when the destination is locked after detection (TOCTOU)', async () => {
        await seedMainFixture(sql);
        groupsToReturn = [GROUP_SPLIT_SUMMARY];
        const detection = await detectSeasonStructureFix(sql, SERIES_ID, DEPS);
        expect(detection).not.toBeNull();
        await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${S2E1_ID}`;

        const result = await applySeasonStructureFix(sql, detection!, DEPS);

        // Identity binding still proceeds for both - only display metadata
        // (title, still_path) is frozen for the locked one.
        expect(result.bound).toBe(2);
        const s2e1ExtIds = await sql<{ external_id: string }[]>`
            SELECT external_id FROM external_ids WHERE media_id = ${S2E1_ID} AND provider = 'tmdb'
        `;
        expect(s2e1ExtIds[0]?.external_id).toBe('103');

        const [s2e1Pm] = await sql<{ metadata: Record<string, unknown> }[]>`
            SELECT metadata FROM provider_metadata WHERE media_id = ${S2E1_ID} AND provider = 'tmdb'
        `;
        expect(s2e1Pm).toBeUndefined();

        // The unlocked sibling in the same apply is unaffected.
        const [s2e2Pm] = await sql<{ metadata: Record<string, unknown> }[]>`
            SELECT metadata FROM provider_metadata WHERE media_id = ${S2E2_ID} AND provider = 'tmdb'
        `;
        expect(s2e2Pm.metadata.still_path).toBe('/still104.jpg');
    });

    // C3 fix-round-2 (2026-09-25 security review, Minor 1): round 1 threaded
    // a series-level `force` down into this child-row still_path write, but
    // `force` is documented (metadata-sync-single.service.ts SyncOptions) to
    // cover the series row only — children follow `forceChildren`, which is
    // not wired here. That produced a split outcome (still_path forced
    // through while the sibling media_items title UPDATE stayed
    // lock-respecting). `force` no longer reaches this layer at all: both
    // writes now consistently SKIP a locked destination episode.
    it('a locked destination episode is skipped for BOTH the still_path AND the title write (no series-level force override)', async () => {
        await seedMainFixture(sql);
        groupsToReturn = [GROUP_SPLIT_SUMMARY];
        const detection = await detectSeasonStructureFix(sql, SERIES_ID, DEPS);
        expect(detection).not.toBeNull();
        await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${S2E1_ID}`;

        await applySeasonStructureFix(sql, detection!, DEPS);

        const [s2e1Pm] = await sql<{ metadata: Record<string, unknown> }[]>`
            SELECT metadata FROM provider_metadata WHERE media_id = ${S2E1_ID} AND provider = 'tmdb'
        `;
        expect(s2e1Pm).toBeUndefined();

        const [s2e1] = await sql<{ title: string; title_binding: string | null }[]>`
            SELECT title, title_binding FROM media_items WHERE id = ${S2E1_ID}
        `;
        expect(s2e1.title).toBe('Show.S02E01');
        expect(s2e1.title_binding).not.toBe('identity');
    });

    it('leaves a metadata_locked sibling untouched while binding the unlocked one', async () => {
        await seedLockFixture(sql);
        groupsToReturn = [GROUP_SPLIT_SUMMARY];
        const detection = await detectSeasonStructureFix(sql, LOCK_SERIES_ID, DEPS);
        expect(detection).not.toBeNull();

        const result = await applySeasonStructureFix(sql, detection!, DEPS);

        expect(result.bound).toBe(1);

        const s2e1ExtIds = await sql<{ external_id: string }[]>`
            SELECT external_id FROM external_ids WHERE media_id = ${LOCK_S2E1_ID} AND provider = 'tmdb'
        `;
        expect(s2e1ExtIds[0]?.external_id).toBe('103');

        const s2e2 = await sql<{ title: string; metadata_locked: boolean }[]>`
            SELECT title, metadata_locked FROM media_items WHERE id = ${LOCK_S2E2_ID}
        `;
        expect(s2e2[0]?.title).toBe('Show.S02E02');
        expect(s2e2[0]?.metadata_locked).toBe(true);

        const s2e2ExtIds = await sql`
            SELECT 1 FROM external_ids WHERE media_id = ${LOCK_S2E2_ID}
        `;
        expect(s2e2ExtIds).toHaveLength(0);

        // The ghost holding tmdb 104 was never targeted by a binding, so it
        // must survive (only ghosts whose id was actually bound are deleted).
        const untouchedGhost = await sql`SELECT id FROM media_items WHERE id = ${LOCK_S1E4_ID}`;
        expect(untouchedGhost).toHaveLength(1);
    });

    it('aborts without writing when a manual ordering is set after detection (TOCTOU)', async () => {
        await seedMainFixture(sql);
        groupsToReturn = [GROUP_SPLIT_SUMMARY];
        const detection = await detectSeasonStructureFix(sql, SERIES_ID, DEPS);
        expect(detection).not.toBeNull();

        // An admin sets a manual ordering AFTER detection snapshotted the
        // series but BEFORE apply's transaction runs.
        await sql`
            INSERT INTO series_episode_ordering
                (media_id, ordering_type, ordering_source, ordering_provider, ordering_group_id)
            VALUES
                (${SERIES_ID}, 'dvd', 'manual', 'some-other-provider', 'manual-group-x')
        `;

        const result = await applySeasonStructureFix(sql, detection!, DEPS);

        expect(result.bound).toBe(0);
        expect(result.skipped).toBe(0);
        expect(result.ghostsDeleted).toBe(0);
        expect(result.emptySeasonsDeleted).toBe(0);
        expect(result.orderingApplied).toBe(false);

        // No external_ids were moved: season-2 episodes remain unbound.
        const s2Bound = await sql`
            SELECT ei.media_id
            FROM external_ids ei
            WHERE ei.provider = 'tmdb' AND ei.media_id = ANY(${[S2E1_ID, S2E2_ID]})
        `;
        expect(s2Bound).toHaveLength(0);

        // Ghost holders untouched.
        const ghosts = await sql`SELECT id FROM media_items WHERE id = ANY(${[S1E3_ID, S1E4_ID]})`;
        expect(ghosts).toHaveLength(2);

        // The manual ordering row itself is untouched.
        const ordering = await sql<
            { ordering_source: string; ordering_provider: string; ordering_group_id: string }[]
        >`
            SELECT ordering_source, ordering_provider, ordering_group_id
            FROM series_episode_ordering
            WHERE media_id = ${SERIES_ID}
        `;
        expect(ordering).toHaveLength(1);
        expect(ordering[0]?.ordering_source).toBe('manual');
        expect(ordering[0]?.ordering_provider).toBe('some-other-provider');
        expect(ordering[0]?.ordering_group_id).toBe('manual-group-x');
    });

    it('skips a binding whose ghost holder is metadata_locked, without blocking other bindings', async () => {
        await seedMainFixture(sql);
        // Lock the ghost holding tmdb 103 — apply must refuse to steal its id
        // even though the file-backed row (S2E1) is itself unlocked.
        await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${S1E3_ID}`;
        groupsToReturn = [GROUP_SPLIT_SUMMARY];
        const detection = await detectSeasonStructureFix(sql, SERIES_ID, DEPS);
        expect(detection).not.toBeNull();
        expect(detection?.bindings).toHaveLength(2);

        const result = await applySeasonStructureFix(sql, detection!, DEPS);

        expect(result.bound).toBe(1);
        expect(result.skipped).toBeGreaterThanOrEqual(1);

        // S2E1 (→103) was skipped: no tmdb id, ghost S1E3 untouched and still
        // holds 103.
        const s2e1ExtIds = await sql`
            SELECT 1 FROM external_ids WHERE media_id = ${S2E1_ID} AND provider = 'tmdb'
        `;
        expect(s2e1ExtIds).toHaveLength(0);

        const ghost3 = await sql<{ external_id: string; metadata_locked: boolean }[]>`
            SELECT ei.external_id, mi.metadata_locked
            FROM media_items mi
            JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'tmdb'
            WHERE mi.id = ${S1E3_ID}
        `;
        expect(ghost3[0]?.external_id).toBe('103');
        expect(ghost3[0]?.metadata_locked).toBe(true);

        // S2E2 (→104) still bound normally.
        const s2e2 = await sql<{ external_id: string; title: string }[]>`
            SELECT ei.external_id, mi.title
            FROM media_items mi
            JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'tmdb'
            WHERE mi.id = ${S2E2_ID}
        `;
        expect(s2e2[0]?.external_id).toBe('104');
        expect(s2e2[0]?.title).toBe('Real Title E4');

        const ghost4 = await sql`SELECT id FROM media_items WHERE id = ${S1E4_ID}`;
        expect(ghost4).toHaveLength(0);
    });

    it('migrates user state from a ghost to its successor on merge', async () => {
        await seedMainFixture(sql);
        await ensureTestUser(sql, TEST_USER_ID);
        // User state accumulated on the ghost (S1E3, holding tmdb 103) before
        // the fix runs — must migrate onto the file-backed successor (S2E1),
        // not be lost when the ghost is merged away.
        await sql`
            INSERT INTO user_ratings (user_id, media_id, rating)
            VALUES (${TEST_USER_ID}, ${S1E3_ID}, 8)
        `;
        await sql`
            INSERT INTO user_media_state (user_id, media_id, is_watched, watch_count, first_watched_at, last_watched_at)
            VALUES (${TEST_USER_ID}, ${S1E3_ID}, true, 1, NOW(), NOW())
        `;

        groupsToReturn = [GROUP_SPLIT_SUMMARY];
        const detection = await detectSeasonStructureFix(sql, SERIES_ID, DEPS);
        expect(detection).not.toBeNull();

        const result = await applySeasonStructureFix(sql, detection!, DEPS);
        expect(result.bound).toBe(2);
        expect(result.ghostsDeleted).toBe(2);

        const ghost = await sql`SELECT id FROM media_items WHERE id = ${S1E3_ID}`;
        expect(ghost).toHaveLength(0);

        const rating = await sql<{ media_id: string; rating: number }[]>`
            SELECT media_id, rating FROM user_ratings WHERE user_id = ${TEST_USER_ID}
        `;
        expect(rating).toHaveLength(1);
        expect(rating[0]?.media_id).toBe(S2E1_ID);
        expect(rating[0]?.rating).toBe(8);

        const watchState = await sql<
            { media_id: string; is_watched: boolean; watch_count: number }[]
        >`
            SELECT media_id, is_watched, watch_count FROM user_media_state WHERE user_id = ${TEST_USER_ID}
        `;
        expect(watchState).toHaveLength(1);
        expect(watchState[0]?.media_id).toBe(S2E1_ID);
        expect(watchState[0]?.is_watched).toBe(true);
        expect(watchState[0]?.watch_count).toBe(1);
    });

    it('a binding whose ghost merge fails writes nothing; the other binding still applies', async () => {
        await seedMainFixture(sql);
        await ensureTestUser(sql, TEST_USER_ID);
        await sql`
            INSERT INTO user_ratings (user_id, media_id, rating)
            VALUES (${TEST_USER_ID}, ${S1E3_ID}, 8)
        `;
        // Fails the last step of the first binding (the ghost's deletion inside
        // the merge), after its id was released and bound.
        await sql`
            CREATE FUNCTION test_block_ghost_delete() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
                IF OLD.id = '00000000-0000-4000-a000-000000001006' THEN
                    RAISE EXCEPTION 'test: ghost delete blocked';
                END IF;
                RETURN OLD;
            END $$
        `;
        await sql`
            CREATE TRIGGER test_block_ghost_delete
                BEFORE DELETE ON media_items
                FOR EACH ROW EXECUTE FUNCTION test_block_ghost_delete()
        `;
        groupsToReturn = [GROUP_SPLIT_SUMMARY];
        const detection = await detectSeasonStructureFix(sql, SERIES_ID, DEPS);

        const result = await applySeasonStructureFix(sql, detection!, DEPS);

        expect(result.bound).toBe(1);
        expect(result.skipped).toBe(1);
        expect(result.ghostsDeleted).toBe(1);

        // S2E1 (ghost S1E3): untouched, ghost keeps id and user state.
        const s2e1Ids = await sql`
            SELECT 1 FROM external_ids WHERE media_id = ${S2E1_ID} AND provider = 'tmdb'
        `;
        expect(s2e1Ids).toHaveLength(0);
        const [s2e1] = await sql<{ title: string; title_binding: string | null }[]>`
            SELECT title, title_binding FROM media_items WHERE id = ${S2E1_ID}
        `;
        expect(s2e1.title).toBe('Show.S02E01');
        expect(s2e1.title_binding).not.toBe('identity');
        const ghostId = await sql<{ external_id: string }[]>`
            SELECT external_id FROM external_ids WHERE media_id = ${S1E3_ID} AND provider = 'tmdb'
        `;
        expect(ghostId.map((r) => r.external_id)).toEqual(['103']);
        const rating = await sql<{ media_id: string }[]>`
            SELECT media_id FROM user_ratings WHERE user_id = ${TEST_USER_ID}
        `;
        expect(rating.map((r) => r.media_id)).toEqual([S1E3_ID]);

        // S2E2 (ghost S1E4) applied and has its undo record.
        const moves = await sql<{ episode_id: string; service: string }[]>`
            SELECT episode_id, service FROM episode_reconciliation_moves WHERE series_id = ${SERIES_ID}
        `;
        expect(moves).toEqual([{ episode_id: S2E2_ID, service: 'season-structure' }]);
    });

    it('records an undo row per binding, and undo restores the episode and blocks the pair', async () => {
        await seedMainFixture(sql);
        groupsToReturn = [GROUP_SPLIT_SUMMARY];
        const detection = await detectSeasonStructureFix(sql, SERIES_ID, DEPS);
        await applySeasonStructureFix(sql, detection!, DEPS);
        const [move] = await sql<
            { id: string; from_season: number; to_season: number; prev_title: string }[]
        >`
            SELECT id, from_season, to_season, prev_title FROM episode_reconciliation_moves
            WHERE episode_id = ${S2E1_ID}
        `;
        // File-backed episodes keep their local numbering: bound in place.
        expect(move).toMatchObject({ from_season: 2, to_season: 2, prev_title: 'Show.S02E01' });

        await undoReconciliationMove(sql, move.id, 'tester');

        const [ep] = await sql<{ title: string; season_number: number }[]>`
            SELECT title, season_number FROM media_items WHERE id = ${S2E1_ID}
        `;
        expect(ep).toEqual({ title: 'Show.S02E01', season_number: 2 });
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ${S2E1_ID} AND provider = 'tmdb'`,
        ).toHaveLength(0);

        // The next sync recreates the ghost; the same pair must not be bound again.
        await sql`DELETE FROM series_episode_ordering WHERE media_id = ${SERIES_ID}`;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
            VALUES (${S1E3_ID}, 'Ghost Ep3', 'episode', 'active', false, ${SEASON1_ID}, 1, 3)
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
            VALUES (${S1E3_ID}, 'tmdb', '103', 'episode', true, 'test-fixture')
        `;
        const second = await applySeasonStructureFix(sql, detection!, DEPS);

        // S2E2 is still bound from the first pass, S2E1 is blocked by the undo.
        expect(second.bound).toBe(0);
        expect(second.skipped).toBe(2);
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ${S2E1_ID} AND provider = 'tmdb'`,
        ).toHaveLength(0);
        expect(await sql`SELECT id FROM media_items WHERE id = ${S1E3_ID}`).toHaveLength(1);
    });

    it('re-reads the ghost inside the binding: one that gained a file after the holders were read is not merged away', async () => {
        await seedMainFixture(sql);
        groupsToReturn = [GROUP_SPLIT_SUMMARY];
        const detection = await detectSeasonStructureFix(sql, SERIES_ID, DEPS);
        // After the holder lookup, before the first binding: a scan links a file.
        blockedLookup.fn.mockImplementationOnce(async (...args: unknown[]) => {
            const blocked = await blockedLookup.real(...args);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${S1E3_ID}`;
            return blocked;
        });

        const result = await applySeasonStructureFix(sql, detection!, DEPS);

        expect(result).toMatchObject({ bound: 1, skipped: 1 });
        const [ghost] = await sql<{ has_files: boolean; tmdb: string | null }[]>`
            SELECT mi.has_files,
                   (SELECT external_id FROM external_ids
                    WHERE media_id = mi.id AND provider = 'tmdb') AS tmdb
            FROM media_items mi WHERE mi.id = ${S1E3_ID}
        `;
        expect(ghost).toEqual({ has_files: true, tmdb: '103' });
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ${S2E1_ID} AND provider = 'tmdb'`,
        ).toHaveLength(0);
        expect(
            await sql`SELECT 1 FROM episode_reconciliation_moves WHERE episode_id = ${S2E1_ID}`,
        ).toHaveLength(0);
    });

    it('works on a reserved connection: the failing second binding rolls back to its savepoint, the first commits with its move row', async () => {
        await seedMainFixture(sql);
        groupsToReturn = [GROUP_SPLIT_SUMMARY];
        const detection = await detectSeasonStructureFix(sql, SERIES_ID, DEPS);
        // The first binding (S2E1, ghost S1E3) is processed before the second
        // (S2E2, ghost S1E4); fail the second at its ghost's deletion.
        await sql`
            CREATE FUNCTION test_block_ghost_delete() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
                IF OLD.id = '00000000-0000-4000-a000-000000001007' THEN
                    RAISE EXCEPTION 'test: ghost delete blocked';
                END IF;
                RETURN OLD;
            END $$
        `;
        await sql`
            CREATE TRIGGER test_block_ghost_delete
                BEFORE DELETE ON media_items
                FOR EACH ROW EXECUTE FUNCTION test_block_ghost_delete()
        `;

        const reserved = await sql.reserve();
        let result;
        try {
            result = await applySeasonStructureFix(reserved, detection!, DEPS);
        } finally {
            reserved.release();
        }

        expect(result).toMatchObject({ bound: 1, skipped: 1 });
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ${S2E1_ID} AND provider = 'tmdb'`,
        ).toHaveLength(1);
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ${S2E2_ID} AND provider = 'tmdb'`,
        ).toHaveLength(0);
        const moves = await sql<{ episode_id: string }[]>`
            SELECT episode_id FROM episode_reconciliation_moves WHERE series_id = ${SERIES_ID}
        `;
        expect(moves.map((m) => m.episode_id)).toEqual([S2E1_ID]);
        // The failed binding's ghost kept its id and its row.
        const ghostId = await sql<{ external_id: string }[]>`
            SELECT external_id FROM external_ids WHERE media_id = ${S1E4_ID} AND provider = 'tmdb'
        `;
        expect(ghostId.map((r) => r.external_id)).toEqual(['104']);
    });

    describe('undo and the automatic ordering', () => {
        async function applyAndMoves(): Promise<{ s2e1: string; s2e2: string }> {
            await seedMainFixture(sql);
            groupsToReturn = [GROUP_SPLIT_SUMMARY];
            const detection = await detectSeasonStructureFix(sql, SERIES_ID, DEPS);
            const result = await applySeasonStructureFix(sql, detection!, DEPS);
            expect(result.orderingApplied).toBe(true);
            const rows = await sql<{ id: string; episode_id: string }[]>`
                SELECT id, episode_id FROM episode_reconciliation_moves WHERE series_id = ${SERIES_ID}
            `;
            const idOf = (episode: string): string =>
                rows.find((r) => r.episode_id === episode)!.id;
            return { s2e1: idOf(S2E1_ID), s2e2: idOf(S2E2_ID) };
        }

        const orderingRows = (): Promise<{ ordering_source: string }[]> =>
            sql<{ ordering_source: string }[]>`
                SELECT ordering_source FROM series_episode_ordering WHERE media_id = ${SERIES_ID}
            `;

        it('keeps the ordering while another move of the series stands, drops it with the last one', async () => {
            const { s2e1, s2e2 } = await applyAndMoves();

            await undoReconciliationMove(sql, s2e1, 'tester');
            expect(await orderingRows()).toHaveLength(1);

            await undoReconciliationMove(sql, s2e2, 'tester');
            expect(await orderingRows()).toHaveLength(0);
            const linked = await sql`
                SELECT 1 FROM episode_orderings
                WHERE series_media_id = ${SERIES_ID} AND episode_media_id IS NOT NULL
            `;
            expect(linked).toHaveLength(0);
        });

        it('drops the ordering with the last move even when another moved episode was deleted', async () => {
            const { s2e1 } = await applyAndMoves();
            // The other moved episode is gone: its audit row stays (episode_id
            // cleared) but can never be undone, so it must not keep the ordering.
            await sql`DELETE FROM media_items WHERE id = ${S2E2_ID}`;

            await undoReconciliationMove(sql, s2e1, 'tester');

            expect(await orderingRows()).toHaveLength(0);
        });

        it('leaves a manual ordering alone', async () => {
            const { s2e1, s2e2 } = await applyAndMoves();
            await sql`
                UPDATE series_episode_ordering SET ordering_source = 'manual' WHERE media_id = ${SERIES_ID}
            `;

            await undoReconciliationMove(sql, s2e1, 'tester');
            await undoReconciliationMove(sql, s2e2, 'tester');

            expect(await orderingRows()).toEqual([{ ordering_source: 'manual' }]);
        });
    });

    it('skips ordering activation when orderingConsistent is false (specials bucket filtered)', async () => {
        await seedMainFixture(sql);
        groupsToReturn = [GROUP_SPECIALS_SUMMARY];
        const detection = await detectSeasonStructureFix(sql, SERIES_ID, DEPS);
        expect(detection).not.toBeNull();
        expect(detection?.orderingConsistent).toBe(false);

        const result = await applySeasonStructureFix(sql, detection!, DEPS);

        expect(result.bound).toBe(2);
        expect(result.orderingApplied).toBe(false);

        const ordering =
            await sql`SELECT id FROM series_episode_ordering WHERE media_id = ${SERIES_ID}`;
        expect(ordering).toHaveLength(0);
    });

    it('relocates a leftover ghost to the season/episode its group position implies', async () => {
        await seedTailFixture(sql);
        groupsToReturn = [GROUP_TAIL_SUMMARY];
        const detection = await detectSeasonStructureFix(sql, SERIES_ID, DEPS);
        expect(detection).not.toBeNull();
        // Leading specials bucket is filtered, so the group may never be
        // activated as the display ordering — relocation is the only thing
        // that can put the stranded ghost in the right place.
        expect(detection?.orderingConsistent).toBe(false);

        const result = await applySeasonStructureFix(sql, detection!, DEPS);

        expect(result.bound).toBe(2);
        expect(result.orderingApplied).toBe(false);
        expect(result.ghostsRelocated).toBe(1);

        const [ghost] = await sql<
            {
                season_number: number;
                episode_number: number;
                parent_id: string;
                has_files: boolean;
            }[]
        >`
            SELECT season_number, episode_number, parent_id, has_files
            FROM media_items WHERE id = ${S1E5_ID}
        `;
        expect(ghost).toBeDefined();
        expect(ghost.season_number).toBe(2);
        expect(ghost.episode_number).toBe(3);
        expect(ghost.parent_id).toBe(SEASON2_ID);
        // Still genuinely missing from disk — relocation must not fake availability.
        expect(ghost.has_files).toBe(false);
    });

    it('leaves a leftover ghost alone when the target position is already taken', async () => {
        await seedTailFixture(sql);
        // A row already occupies season 2 episode 3 — moving the ghost there
        // would violate uq_media_items_episode. It is metadata_locked so it
        // stays out of the bindings and cannot absorb tmdb id 105 itself.
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number, metadata_locked)
            VALUES (${S2E3_LOCKED_ID}, 'Show.S02E03', 'episode', 'active', true, ${SEASON2_ID}, 2, 3, true)
        `;
        groupsToReturn = [GROUP_TAIL_SUMMARY];
        const detection = await detectSeasonStructureFix(sql, SERIES_ID, DEPS);
        expect(detection).not.toBeNull();

        const result = await applySeasonStructureFix(sql, detection!, DEPS);

        expect(result.ghostsRelocated).toBe(0);
        const [ghost] = await sql<{ season_number: number; episode_number: number }[]>`
            SELECT season_number, episode_number FROM media_items WHERE id = ${S1E5_ID}
        `;
        expect(ghost.season_number).toBe(1);
        expect(ghost.episode_number).toBe(5);
    });
});

describe('maybeAutoFixSeasonStructure', () => {
    it('is idempotent: a second pass finds nothing left to fix', async () => {
        await seedMainFixture(sql);
        groupsToReturn = [GROUP_SPLIT_SUMMARY];
        const detection = await detectSeasonStructureFix(sql, SERIES_ID, DEPS);
        expect(detection).not.toBeNull();
        await applySeasonStructureFix(sql, detection!, DEPS);

        const second = await maybeAutoFixSeasonStructure(sql, SERIES_ID, DEPS);

        expect(second).toBeNull();
    });
});

describe('linkEpisodeMediaIds — Tier 3 (order-position) matching', () => {
    it('links unmatched ordering rows by ORDER season/episode number', async () => {
        await seedTier3Fixture(sql);
        // No external_ids for this provider and no local episode at the
        // ORIGINAL season/episode position (9:1 / 9:2) — only the ORDER
        // position (2:1 / 2:2) matches the local file-backed episodes.
        await sql`
            INSERT INTO episode_orderings
                (series_media_id, provider, provider_episode_id, ordering_type, ordering_group_id,
                 original_season_number, original_episode_number, order_season_number, order_episode_number)
            VALUES
                (${T3_SERIES_ID}, 'test-tier3-provider', '900', 'dvd', 'g-tier3', 9, 1, 2, 1),
                (${T3_SERIES_ID}, 'test-tier3-provider', '901', 'dvd', 'g-tier3', 9, 2, 2, 2)
        `;

        const result = await linkEpisodeMediaIds(
            sql,
            T3_SERIES_ID,
            'dvd',
            'test-tier3-provider',
            'g-tier3',
        );

        expect(result).toEqual({ linked: 2, unlinked: 0, combined: 0 });

        const rows = await sql<{ provider_episode_id: string; episode_media_id: string }[]>`
            SELECT provider_episode_id, episode_media_id
            FROM episode_orderings
            WHERE series_media_id = ${T3_SERIES_ID}
            ORDER BY provider_episode_id
        `;
        expect(rows).toHaveLength(2);
        expect(rows[0]?.provider_episode_id).toBe('900');
        expect(rows[0]?.episode_media_id).toBe(T3_EP1_ID);
        expect(rows[1]?.provider_episode_id).toBe('901');
        expect(rows[1]?.episode_media_id).toBe(T3_EP2_ID);
    });
});
