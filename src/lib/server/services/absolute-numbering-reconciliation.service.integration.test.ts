// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Integration tests for absolute-numbering-reconciliation.service
 *
 * Covers the Sky Harbor shape: release files carry ABSOLUTE episode numbers
 * under a season the provider doesn't use, while the provider's own canonical
 * rows (also absolutely numbered) sit as file-less ghosts in the real seasons.
 *
 * Run locally:
 *   npm run test:integration src/lib/server/services/absolute-numbering-reconciliation.service.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    detectAbsoluteNumberingFix,
    applyAbsoluteNumberingFix,
    maybeAutoFixAbsoluteNumbering,
    applyAbsoluteNumberingProposal,
    dismissAbsoluteNumberingProposal,
    ProposalActionError,
    MAX_APPLIED_PAIRS_PER_SYNC,
} from './absolute-numbering-reconciliation.service.js';
import type { TmdbCatalogEpisode } from './episode-reconciliation.service.js';
import { ensureTestUser } from '../../../../tests/integration/fixtures/index.js';
import {
    resolveQuarantine,
    listUnresolvedQuarantineByReason,
} from '../database/queries/sync-quarantine.queries.js';
import { undoReconciliationMove } from './episode-reconciliation-undo.service.js';
import { MediaDeletionService } from './media-deletion.service.js';
import { MediaLifecycleService } from './media-lifecycle.service.js';
import { config } from '../config.js';
import { LoggerInstance } from '../utils/logger.js';
import { reconciliationPairKey } from '../database/queries/episode-reconciliation-moves.queries.js';

// The default catalog loader, observable: the verdict of a detection without a
// caller-supplied loader must not depend on who calls.
const loaderHolder = vi.hoisted(() => ({
    fn: undefined as unknown as ReturnType<typeof vi.fn>,
    real: undefined as unknown as (...args: unknown[]) => Promise<unknown>,
}));
vi.mock('./episode-reconciliation.service.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./episode-reconciliation.service.js')>();
    loaderHolder.real = actual.loadTmdbCatalog as unknown as typeof loaderHolder.real;
    loaderHolder.fn = vi.fn(actual.loadTmdbCatalog);
    return { ...actual, loadTmdbCatalog: loaderHolder.fn };
});
const catalogLoader = loaderHolder.fn;

// ---------------------------------------------------------------------------
// Fixed UUIDs
// ---------------------------------------------------------------------------

const SERIES_ID = '00000000-0000-4000-a000-000000004001';
const SEASON1_ID = '00000000-0000-4000-a000-000000004002';
const SEASON13_ID = '00000000-0000-4000-a000-000000004003';

// Season 1: E1 is correctly bound; E422/E423 are the absolute-numbered orphans.
const S1E1_ID = '00000000-0000-4000-a000-000000004004';
const ORPHAN_422_ID = '00000000-0000-4000-a000-000000004005';
const ORPHAN_423_ID = '00000000-0000-4000-a000-000000004006';

// Season 13: the canonical file-less ghosts holding the real metadata.
const GHOST_422_ID = '00000000-0000-4000-a000-000000004007';
const GHOST_423_ID = '00000000-0000-4000-a000-000000004008';

// Extra rows used by the ambiguity tests.
const DUPE_GHOST_422_ID = '00000000-0000-4000-a000-000000004009';
const DUPE_ORPHAN_422_ID = '00000000-0000-4000-a000-00000000400a';
const SEASON14_ID = '00000000-0000-4000-a000-00000000400b';
const SEASON15_ID = '00000000-0000-4000-a000-00000000400c';
const ORPHAN_2_ID = '00000000-0000-4000-a000-00000000400d';
const GHOST_2_ID = '00000000-0000-4000-a000-00000000400e';
const BOUND_2_ID = '00000000-0000-4000-a000-00000000400f';

const TEST_USER_ID = '7c1d4b93-0000-4000-b000-000000000002';

const EPISODE_IDS = [
    S1E1_ID,
    ORPHAN_422_ID,
    ORPHAN_423_ID,
    GHOST_422_ID,
    GHOST_423_ID,
    DUPE_GHOST_422_ID,
    DUPE_ORPHAN_422_ID,
    ORPHAN_2_ID,
    GHOST_2_ID,
    BOUND_2_ID,
];

const CONTAINER_IDS = [SERIES_ID, SEASON1_ID, SEASON13_ID, SEASON14_ID, SEASON15_ID];

const CATALOG: TmdbCatalogEpisode[] = [
    {
        tmdbEpisodeId: '9422',
        name: 'A Deadly Infiltration!',
        altNames: [],
        overview: 'Impel Down arc begins.',
        seasonNumber: 13,
        episodeNumber: 422,
        stillPath: '/still422.jpg',
    },
    {
        tmdbEpisodeId: '9423',
        name: 'The Underwater Prison',
        altNames: [],
        overview: 'Luffy descends.',
        seasonNumber: 13,
        episodeNumber: 423,
        stillPath: null,
    },
];

const DEPS = { catalog: CATALOG };
/** Direct applies of number-match detections: the shipped default would skip them. */
const APPLY = { ...DEPS, autoApplyNumberMatches: true };

// ---------------------------------------------------------------------------
// Fixture seeding
// ---------------------------------------------------------------------------

async function seedBaseFixture(sql: postgres.Sql): Promise<void> {
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files)
        VALUES (${SERIES_ID}, 'Sky Harbor (Test)', 'tv', 'active', true)
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number)
        VALUES (${SEASON1_ID}, 'Season 1', 'season', 'active', true, ${SERIES_ID}, 1)
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number)
        VALUES (${SEASON13_ID}, 'Season 13', 'season', 'active', false, ${SERIES_ID}, 13)
    `;

    // Correctly bound season-1 episode — must be left completely alone.
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
        VALUES (${S1E1_ID}, 'Real S1E1', 'episode', 'active', true, ${SEASON1_ID}, 1, 1)
    `;
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
        VALUES (${S1E1_ID}, 'tmdb', '9001', 'episode', true, 'test-fixture')
    `;

    // The orphans: absolute numbers, stranded in season 1, no tmdb identity.
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number, title_binding)
        VALUES (${ORPHAN_422_ID}, 'S01E0422 - SKY HARBOR', 'episode', 'active', true, ${SEASON1_ID}, 1, 422, 'position')
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number, title_binding)
        VALUES (${ORPHAN_423_ID}, 'S01E0423 - SKY HARBOR', 'episode', 'active', true, ${SEASON1_ID}, 1, 423, 'position')
    `;

    // The canonical ghosts holding the real identity + metadata.
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
        VALUES (${GHOST_422_ID}, 'A Deadly Infiltration!', 'episode', 'active', false, ${SEASON13_ID}, 13, 422)
    `;
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
        VALUES (${GHOST_422_ID}, 'tmdb', '9422', 'episode', true, 'test-fixture')
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
        VALUES (${GHOST_423_ID}, 'The Underwater Prison', 'episode', 'active', false, ${SEASON13_ID}, 13, 423)
    `;
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
        VALUES (${GHOST_423_ID}, 'tmdb', '9423', 'episode', true, 'test-fixture')
    `;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let sql: postgres.Sql;

beforeAll(async () => {
    sql = getTestDb() as unknown as postgres.Sql;
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    vi.restoreAllMocks();
    catalogLoader.mockReset();
    catalogLoader.mockImplementation(loaderHolder.real);
    await sql`DROP TRIGGER IF EXISTS test_block_reconcile_move ON media_items`;
    await sql`DROP TRIGGER IF EXISTS test_fail_reconcile_commit ON episode_reconciliation_moves`;
    await sql`DROP FUNCTION IF EXISTS test_fail_reconcile_commit()`;
    await sql`DROP FUNCTION IF EXISTS test_block_reconcile_move()`;
    await sql`DELETE FROM sync_quarantine WHERE provider IN ('lumastra-reconcile-absolute', 'lumastra-reconcile-season-structure')`;
    await sql`DELETE FROM episode_reconciliation_moves WHERE series_id = ${SERIES_ID}`;
    await sql`DELETE FROM media_items WHERE id = ANY(${EPISODE_IDS})`;
    await sql`DELETE FROM media_items WHERE id = ANY(${CONTAINER_IDS})`;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectAbsoluteNumberingFix', () => {
    it('matches each orphan to the unique ghost sharing its absolute number', async () => {
        await seedBaseFixture(sql);

        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);

        expect(detection).not.toBeNull();
        expect(detection?.matches).toHaveLength(2);
        const m422 = detection?.matches.find((m) => m.episodeId === ORPHAN_422_ID);
        expect(m422).toMatchObject({
            ghostId: GHOST_422_ID,
            tmdbEpisodeId: '9422',
            targetSeasonNumber: 13,
            targetEpisodeNumber: 422,
            // Numbers alone: the only evidence this detection has today.
            evidence: 'number-match',
        });
    });

    it('declines an episode number carried by more than one ghost', async () => {
        await seedBaseFixture(sql);
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number)
            VALUES (${SEASON14_ID}, 'Season 14', 'season', 'active', false, ${SERIES_ID}, 14)
        `;
        // A second ghost at absolute 422 — the number no longer identifies one
        // episode, so binding either way would be a guess.
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
            VALUES (${DUPE_GHOST_422_ID}, 'Other 422', 'episode', 'active', false, ${SEASON14_ID}, 14, 422)
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
            VALUES (${DUPE_GHOST_422_ID}, 'tmdb', '9522', 'episode', true, 'test-fixture')
        `;

        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);

        // 423 still resolves; 422 is dropped as ambiguous.
        expect(detection?.matches.map((m) => m.episodeId)).toEqual([ORPHAN_423_ID]);
    });

    it('declines when two orphans claim the same absolute number', async () => {
        await seedBaseFixture(sql);
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number)
            VALUES (${SEASON14_ID}, 'Season 14', 'season', 'active', true, ${SERIES_ID}, 14)
        `;
        // Duplicate rip of the same episode under a different season.
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
            VALUES (${DUPE_ORPHAN_422_ID}, 'dupe 422', 'episode', 'active', true, ${SEASON14_ID}, 14, 422)
        `;

        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);

        expect(detection?.matches.map((m) => m.episodeId)).toEqual([ORPHAN_423_ID]);
    });

    it('declines a number another episode of the series already carries (normal numbering)', async () => {
        await seedBaseFixture(sql);
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number)
            VALUES (${SEASON14_ID}, 'Season 14', 'season', 'active', false, ${SERIES_ID}, 14),
                   (${SEASON15_ID}, 'Season 15', 'season', 'active', true, ${SERIES_ID}, 15)
        `;
        // A sitcom shape: S1E2 lost its identity (the provider merged a
        // two-parter), a new unaired S14E2 is the only E2 ghost, and S15E2 is a
        // bound episode showing E2 repeats per season. S1E2 must stay put.
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
            VALUES (${ORPHAN_2_ID}, 'Two-parter, part 2', 'episode', 'active', true, ${SEASON1_ID}, 1, 2),
                   (${GHOST_2_ID}, 'Future E2', 'episode', 'active', false, ${SEASON14_ID}, 14, 2),
                   (${BOUND_2_ID}, 'Bound S15E2', 'episode', 'active', true, ${SEASON15_ID}, 15, 2)
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
            VALUES (${GHOST_2_ID}, 'tmdb', '9142', 'episode', true, 'test-fixture'),
                   (${BOUND_2_ID}, 'tmdb', '9152', 'episode', true, 'test-fixture')
        `;

        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);

        expect(detection?.matches.map((m) => m.episodeId).sort()).toEqual(
            [ORPHAN_422_ID, ORPHAN_423_ID].sort(),
        );
    });

    it('a Season 0 special with the same number does not block the match', async () => {
        await seedBaseFixture(sql);
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number)
            VALUES (${SEASON14_ID}, 'Specials', 'season', 'active', true, ${SERIES_ID}, 0)
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
            VALUES (${BOUND_2_ID}, 'Special 422', 'episode', 'active', true, ${SEASON14_ID}, 0, 422)
        `;

        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);

        expect(detection?.matches).toHaveLength(2);
    });

    it('declines a ghost whose season is numbered from E1 (per-season numbering)', async () => {
        await seedBaseFixture(sql);
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number)
            VALUES (${SEASON14_ID}, 'Season 14', 'season', 'active', true, ${SERIES_ID}, 14)
        `;
        // Season 14 starts at E1, so its ghost at E423 is S14's own 423rd slot,
        // not absolute episode 423. (Fixture reuse: the dupe-ghost id stands in
        // for S14E1.)
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
            VALUES (${DUPE_GHOST_422_ID}, 'S14E1', 'episode', 'active', true, ${SEASON14_ID}, 14, 1)
        `;
        await sql`UPDATE media_items SET parent_id = ${SEASON14_ID}, season_number = 14 WHERE id = ${GHOST_423_ID}`;

        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);

        expect(detection?.matches.map((m) => m.episodeId)).toEqual([ORPHAN_422_ID]);
    });

    it('declines when the E1 of the ghost season is a file-less canonical ghost (first season holds the absolute run)', async () => {
        await seedBaseFixture(sql);
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number)
            VALUES (${SEASON14_ID}, 'Season 14', 'season', 'active', false, ${SERIES_ID}, 14)
        `;
        // Prod shape: the provider's season numbers absolutely from E1 and the
        // user owns none of it, so its E1 is a ghost with only a tmdb identity.
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
            VALUES (${GHOST_2_ID}, 'S14E1 ghost', 'episode', 'active', false, ${SEASON14_ID}, 14, 1)
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
            VALUES (${GHOST_2_ID}, 'tmdb', '9141', 'episode', true, 'test-fixture')
        `;
        await sql`UPDATE media_items SET parent_id = ${SEASON14_ID}, season_number = 14 WHERE id = ${GHOST_423_ID}`;

        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);

        expect(detection?.matches.map((m) => m.episodeId)).toEqual([ORPHAN_422_ID]);
    });

    it('ignores metadata_locked orphans', async () => {
        await seedBaseFixture(sql);
        await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${ORPHAN_422_ID}`;

        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);

        expect(detection?.matches.map((m) => m.episodeId)).toEqual([ORPHAN_423_ID]);
    });

    it('returns null for a series with no orphans', async () => {
        await seedBaseFixture(sql);
        await sql`DELETE FROM media_items WHERE id = ANY(${[ORPHAN_422_ID, ORPHAN_423_ID]})`;

        expect(await detectAbsoluteNumberingFix(sql, SERIES_ID)).toBeNull();
    });
});

describe('applyAbsoluteNumberingFix', () => {
    it('binds identity, adopts the canonical position, and removes the ghost', async () => {
        await seedBaseFixture(sql);
        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);

        const result = await applyAbsoluteNumberingFix(sql, detection!, APPLY);

        expect(result.bound).toBe(2);
        expect(result.ghostsDeleted).toBe(2);

        const [orphan] = await sql<
            {
                season_number: number;
                episode_number: number;
                parent_id: string;
                title: string;
                overview: string | null;
                title_binding: string | null;
            }[]
        >`
            SELECT season_number, episode_number, parent_id, title, overview, title_binding
            FROM media_items WHERE id = ${ORPHAN_422_ID}
        `;
        expect(orphan.season_number).toBe(13);
        expect(orphan.episode_number).toBe(422);
        expect(orphan.parent_id).toBe(SEASON13_ID);
        expect(orphan.title).toBe('A Deadly Infiltration!');
        expect(orphan.overview).toBe('Impel Down arc begins.');
        expect(orphan.title_binding).toBe('identity');

        const [ext] = await sql<{ external_id: string }[]>`
            SELECT external_id FROM external_ids
            WHERE media_id = ${ORPHAN_422_ID} AND provider = 'tmdb' AND media_type = 'episode'
        `;
        expect(ext.external_id).toBe('9422');

        // Ghost is gone, so the canonical slot is no longer duplicated.
        const ghosts = await sql`SELECT id FROM media_items WHERE id = ${GHOST_422_ID}`;
        expect(ghosts).toHaveLength(0);
    });

    // C3 (2026-09-24 security review): the still_path provider_metadata write
    // previously had NO lock guard at all, unlike the sibling media_items
    // title/overview UPDATE right above it. detectAbsoluteNumberingFix
    // already excludes locked orphans (see "ignores metadata_locked orphans"
    // above), so the only way `applyAbsoluteNumberingFix` sees a locked
    // destination is the TOCTOU race the ghost re-check already guards
    // against: lock the row AFTER detection, then apply the stale result —
    // exactly the same shape as this file's other staleness tests.
    it('does NOT write still_path when the destination is locked after detection (TOCTOU)', async () => {
        await seedBaseFixture(sql);
        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);
        await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${ORPHAN_422_ID}`;

        const result = await applyAbsoluteNumberingFix(sql, detection!, APPLY);

        // The re-detection under the lock drops the row locked meanwhile, as
        // detection itself would: no identity, no display metadata.
        expect(result.bound).toBe(1);
        expect(result.skipped).toBe(1);
        const [pm] = await sql<{ metadata: Record<string, unknown> }[]>`
            SELECT metadata FROM provider_metadata
            WHERE media_id = ${ORPHAN_422_ID} AND provider = 'tmdb'
        `;
        expect(pm).toBeUndefined();
    });

    it('control: DOES write still_path when the destination episode is unlocked', async () => {
        await seedBaseFixture(sql);
        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);

        await applyAbsoluteNumberingFix(sql, detection!, APPLY);

        const [pm] = await sql<{ metadata: Record<string, unknown> }[]>`
            SELECT metadata FROM provider_metadata
            WHERE media_id = ${ORPHAN_422_ID} AND provider = 'tmdb'
        `;
        expect(pm.metadata.still_path).toBe('/still422.jpg');
    });

    // C3 fix-round-2 (2026-09-25 security review, Minor 1): round 1 threaded
    // a series-level `force` down into this child-row still_path write, but
    // `force` is documented (metadata-sync-single.service.ts SyncOptions) to
    // cover the series row only — children follow `forceChildren`, which is
    // not wired here. That produced a split outcome (still_path forced
    // through while the sibling media_items title/overview UPDATE stayed
    // lock-respecting). `force` no longer reaches this layer at all: both
    // writes now consistently SKIP a locked destination episode.
    it('a locked destination episode is skipped for BOTH the still_path AND the title/overview write (no series-level force override)', async () => {
        await seedBaseFixture(sql);
        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);
        await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${ORPHAN_422_ID}`;

        await applyAbsoluteNumberingFix(sql, detection!, APPLY);

        const [pm] = await sql<{ metadata: Record<string, unknown> }[]>`
            SELECT metadata FROM provider_metadata
            WHERE media_id = ${ORPHAN_422_ID} AND provider = 'tmdb'
        `;
        expect(pm).toBeUndefined();

        const [orphan] = await sql<{ title: string; title_binding: string | null }[]>`
            SELECT title, title_binding FROM media_items WHERE id = ${ORPHAN_422_ID}
        `;
        expect(orphan.title).toBe('S01E0422 - SKY HARBOR');
        expect(orphan.title_binding).not.toBe('identity');
    });

    it('leaves the correctly bound season-1 episode untouched', async () => {
        await seedBaseFixture(sql);
        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);
        await applyAbsoluteNumberingFix(sql, detection!, APPLY);

        const [kept] = await sql<
            { season_number: number; episode_number: number; title: string }[]
        >`
            SELECT season_number, episode_number, title FROM media_items WHERE id = ${S1E1_ID}
        `;
        expect(kept.season_number).toBe(1);
        expect(kept.episode_number).toBe(1);
        expect(kept.title).toBe('Real S1E1');
    });

    it('migrates user state from the ghost to the file-backed episode', async () => {
        await seedBaseFixture(sql);
        await ensureTestUser(sql, TEST_USER_ID);
        await sql`
            INSERT INTO user_media_state (user_id, media_id, is_watched, watch_count)
            VALUES (${TEST_USER_ID}, ${GHOST_422_ID}, true, 1)
        `;

        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);
        await applyAbsoluteNumberingFix(sql, detection!, APPLY);

        const state = await sql<{ media_id: string; is_watched: boolean }[]>`
            SELECT media_id, is_watched FROM user_media_state WHERE user_id = ${TEST_USER_ID}
        `;
        expect(state).toHaveLength(1);
        expect(state[0]?.media_id).toBe(ORPHAN_422_ID);
        expect(state[0]?.is_watched).toBe(true);
    });

    it('skips a pair a sync invalidated between detection and apply (E1 appeared in the target season)', async () => {
        await seedBaseFixture(sql);
        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);
        expect(detection?.matches).toHaveLength(2);

        // Metadata sync adds S13E1: season 13 is numbered per season after all.
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
            VALUES (${GHOST_2_ID}, 'S13E1', 'episode', 'active', false, ${SEASON13_ID}, 13, 1)
        `;

        const result = await applyAbsoluteNumberingFix(sql, detection!, APPLY);

        expect(result).toMatchObject({ bound: 0, skipped: 2, moved: 0, ghostsDeleted: 0 });
        const rows = await sql<{ id: string; season_number: number }[]>`
            SELECT id, season_number FROM media_items WHERE id = ANY(${[ORPHAN_422_ID, GHOST_422_ID]})
        `;
        expect(Object.fromEntries(rows.map((r) => [r.id, r.season_number]))).toEqual({
            [ORPHAN_422_ID]: 1,
            [GHOST_422_ID]: 13,
        });
    });

    it('auto-fix leaves a merged two-parter stub where it is (sitcom shape end to end)', async () => {
        await seedBaseFixture(sql);
        // Only the sitcom shape: drop the absolute-numbered orphans.
        await sql`DELETE FROM media_items WHERE id = ANY(${[ORPHAN_422_ID, ORPHAN_423_ID]})`;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number)
            VALUES (${SEASON14_ID}, 'Season 14', 'season', 'active', false, ${SERIES_ID}, 14),
                   (${SEASON15_ID}, 'Season 15', 'season', 'active', true, ${SERIES_ID}, 15)
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
            VALUES (${ORPHAN_2_ID}, 'Two-parter, part 2', 'episode', 'active', true, ${SEASON1_ID}, 1, 2),
                   (${GHOST_2_ID}, 'Future E2', 'episode', 'active', false, ${SEASON14_ID}, 14, 2),
                   (${BOUND_2_ID}, 'Bound S15E2', 'episode', 'active', true, ${SEASON15_ID}, 15, 2)
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
            VALUES (${GHOST_2_ID}, 'tmdb', '9142', 'episode', true, 'test-fixture'),
                   (${BOUND_2_ID}, 'tmdb', '9152', 'episode', true, 'test-fixture')
        `;

        expect(await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, DEPS)).toBeNull();

        const [stub] = await sql<{ season_number: number; parent_id: string }[]>`
            SELECT season_number, parent_id FROM media_items WHERE id = ${ORPHAN_2_ID}
        `;
        expect(stub).toEqual({ season_number: 1, parent_id: SEASON1_ID });
        const ext = await sql`
            SELECT 1 FROM external_ids WHERE media_id = ${ORPHAN_2_ID} AND provider = 'tmdb'
        `;
        expect(ext).toHaveLength(0);
        expect(await sql`SELECT id FROM media_items WHERE id = ${GHOST_2_ID}`).toHaveLength(1);
    });

    it('is idempotent: a second pass finds nothing left to fix', async () => {
        await seedBaseFixture(sql);
        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);
        await applyAbsoluteNumberingFix(sql, detection!, APPLY);

        expect(await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, DEPS)).toBeNull();
    });
});

describe('detection: rejected and undone pairs', () => {
    it('does not match a pair whose proposal an admin rejected, but still matches the other', async () => {
        await seedBaseFixture(sql);
        await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, {
            ...DEPS,
            autoApplyNumberMatches: false,
        });
        const [row] = await sql<{ id: string }[]>`
            SELECT id FROM sync_quarantine
            WHERE provider = 'lumastra-reconcile-absolute' AND external_id LIKE ${`${ORPHAN_422_ID}:%`}
        `;
        await resolveQuarantine(sql, row.id, { resolvedBy: 'tester', resolution: 'dismissed' });

        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);

        expect(detection?.matches.map((m) => m.episodeId)).toEqual([ORPHAN_423_ID]);
    });

    it('still honours a dismissal written before the key held the target (keyed by the episode alone)', async () => {
        await seedBaseFixture(sql);
        await sql`
            INSERT INTO sync_quarantine
                (provider, external_id, media_type, payload, reason, source,
                 resolved_at, resolved_by, resolution)
            VALUES ('lumastra-reconcile-absolute', ${ORPHAN_422_ID}, 'episode',
                    ${sql.json({ tmdbEpisodeId: '9422' })}, 'absolute-numbering:proposed', 'test',
                    NOW(), 'tester', 'dismissed')
        `;

        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);

        expect(detection?.matches.map((m) => m.episodeId)).toEqual([ORPHAN_423_ID]);
    });

    it('a pair undone by the season-structure pass is not matched here either', async () => {
        await seedBaseFixture(sql);
        await sql`
            INSERT INTO sync_quarantine
                (provider, external_id, media_type, payload, reason, source,
                 resolved_at, resolved_by, resolution)
            VALUES ('lumastra-reconcile-season-structure', ${`${ORPHAN_422_ID}:9422`}, 'episode',
                    ${sql.json({ tmdbEpisodeId: '9422' })}, 'season-structure:undone', 'test',
                    NOW(), 'tester', 'dismissed')
        `;

        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);

        expect(detection?.matches.map((m) => m.episodeId)).toEqual([ORPHAN_423_ID]);
    });

    it('a dismissal for another TMDB episode does not block the pair', async () => {
        await seedBaseFixture(sql);
        await sql`
            INSERT INTO sync_quarantine
                (provider, external_id, media_type, payload, reason, source,
                 resolved_at, resolved_by, resolution)
            VALUES ('lumastra-reconcile-absolute', ${ORPHAN_422_ID}, 'episode',
                    ${sql.json({ tmdbEpisodeId: '1234' })}, 'absolute-numbering:undone', 'test',
                    NOW(), 'tester', 'dismissed')
        `;

        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);

        expect(detection?.matches).toHaveLength(2);
    });
});

describe('maybeAutoFixAbsoluteNumbering: number matches propose by default', () => {
    it('writes a proposal per match and changes nothing when the setting is off', async () => {
        await seedBaseFixture(sql);

        const result = await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, {
            ...DEPS,
            autoApplyNumberMatches: false,
        });

        expect(result).toMatchObject({ bound: 0, proposed: 2 });
        const rows = await sql<
            {
                external_id: string;
                reason: string;
                expected_series_id: string;
                resolved_at: Date | null;
                payload: Record<string, unknown>;
            }[]
        >`
            SELECT external_id, reason, expected_series_id, resolved_at, payload
            FROM sync_quarantine
            WHERE provider = 'lumastra-reconcile-absolute'
            ORDER BY external_id
        `;
        expect(rows.map((r) => r.external_id)).toEqual([
            `${ORPHAN_422_ID}:9422`,
            `${ORPHAN_423_ID}:9423`,
        ]);
        expect(rows[0]).toMatchObject({
            reason: 'absolute-numbering:proposed',
            expected_series_id: SERIES_ID,
            resolved_at: null,
        });
        expect(rows[0].payload).toMatchObject({
            episodeId: ORPHAN_422_ID,
            ghostId: GHOST_422_ID,
            tmdbEpisodeId: '9422',
            fromSeason: 1,
            fromEpisode: 422,
            toSeason: 13,
            toEpisode: 422,
            evidence: 'number-match',
            proposedTitle: 'A Deadly Infiltration!',
        });

        // Nothing was bound, moved or merged.
        const ext = await sql`
            SELECT 1 FROM external_ids WHERE media_id = ANY(${[ORPHAN_422_ID, ORPHAN_423_ID]})
        `;
        expect(ext).toHaveLength(0);
        const eps = await sql<{ id: string; season_number: number }[]>`
            SELECT id, season_number FROM media_items
            WHERE id = ANY(${[ORPHAN_422_ID, GHOST_422_ID]})
        `;
        expect(Object.fromEntries(eps.map((r) => [r.id, r.season_number]))).toEqual({
            [ORPHAN_422_ID]: 1,
            [GHOST_422_ID]: 13,
        });
        expect(
            await sql`SELECT 1 FROM episode_reconciliation_moves WHERE series_id = ${SERIES_ID}`,
        ).toHaveLength(0);
    });

    it('does not rewrite a proposal that is already open on the next sync', async () => {
        await seedBaseFixture(sql);
        const deps = { ...DEPS, autoApplyNumberMatches: false };
        await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, deps);
        const before = await sql<{ id: string; created_at: Date }[]>`
            SELECT id, created_at FROM sync_quarantine
            WHERE provider = 'lumastra-reconcile-absolute' ORDER BY id
        `;

        const second = await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, deps);

        expect(second).toBeNull();
        const after = await sql<{ id: string; created_at: Date }[]>`
            SELECT id, created_at FROM sync_quarantine
            WHERE provider = 'lumastra-reconcile-absolute' ORDER BY id
        `;
        expect(after).toEqual(before);
    });

    it('does not propose a pair again once its proposal was dismissed', async () => {
        await seedBaseFixture(sql);
        const deps = { ...DEPS, autoApplyNumberMatches: false };
        await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, deps);
        await sql`
            UPDATE sync_quarantine
            SET resolved_at = NOW(), resolved_by = 'tester', resolution = 'dismissed'
            WHERE provider = 'lumastra-reconcile-absolute'
        `;

        const again = await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, deps);

        expect(again).toBeNull();
        const open = await sql`
            SELECT 1 FROM sync_quarantine
            WHERE provider = 'lumastra-reconcile-absolute' AND resolved_at IS NULL
        `;
        expect(open).toHaveLength(0);
    });

    it('the shipped default is off: without an override the match is only proposed', async () => {
        await seedBaseFixture(sql);

        const result = await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, DEPS);

        expect(result).toMatchObject({ bound: 0, proposed: 2 });
        const ext = await sql`
            SELECT 1 FROM external_ids WHERE media_id = ${ORPHAN_422_ID}
        `;
        expect(ext).toHaveLength(0);
    });

    it('applies the matches and records a move per pair when the setting is on', async () => {
        await seedBaseFixture(sql);

        const result = await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, {
            ...DEPS,
            autoApplyNumberMatches: true,
        });

        expect(result).toMatchObject({ bound: 2, proposed: 0 });
        expect(
            await sql`SELECT 1 FROM sync_quarantine WHERE provider = 'lumastra-reconcile-absolute'`,
        ).toHaveLength(0);
        const moves = await sql<
            {
                episode_id: string;
                service: string;
                evidence: string;
                ghost_id: string;
                tmdb_episode_id: string;
                from_parent_id: string;
                from_season: number;
                from_episode: number;
                to_parent_id: string;
                to_season: number;
                to_episode: number;
                prev_title_binding: string;
                prev_title: string;
                undone_at: Date | null;
            }[]
        >`
            SELECT * FROM episode_reconciliation_moves WHERE series_id = ${SERIES_ID}
            ORDER BY to_episode
        `;
        expect(moves).toHaveLength(2);
        expect(moves[0]).toMatchObject({
            episode_id: ORPHAN_422_ID,
            service: 'absolute-numbering',
            evidence: 'number-match',
            ghost_id: GHOST_422_ID,
            tmdb_episode_id: '9422',
            from_parent_id: SEASON1_ID,
            from_season: 1,
            from_episode: 422,
            to_parent_id: SEASON13_ID,
            to_season: 13,
            to_episode: 422,
            prev_title_binding: 'position',
            prev_title: 'S01E0422 - SKY HARBOR',
            undone_at: null,
        });
    });
});

describe('applyAbsoluteNumberingFix: one pair is one unit of work', () => {
    async function blockMoveOfOrphan422(): Promise<void> {
        // Fails exactly the last step of the pair (the move into the ghost's
        // slot), after the id was bound and the ghost merged away.
        await sql`
            CREATE FUNCTION test_block_reconcile_move() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.id = '00000000-0000-4000-a000-000000004005'
                   AND NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
                    RAISE EXCEPTION 'test: move blocked';
                END IF;
                RETURN NEW;
            END $$
        `;
        await sql`
            CREATE TRIGGER test_block_reconcile_move
                BEFORE UPDATE ON media_items
                FOR EACH ROW EXECUTE FUNCTION test_block_reconcile_move()
        `;
    }

    it('a pair whose move fails writes nothing: no id, ghost and its user state intact, no undo record', async () => {
        await seedBaseFixture(sql);
        await ensureTestUser(sql, TEST_USER_ID);
        await sql`
            INSERT INTO user_media_state (user_id, media_id, is_watched, watch_count)
            VALUES (${TEST_USER_ID}, ${GHOST_422_ID}, true, 1)
        `;
        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);
        await blockMoveOfOrphan422();

        const result = await applyAbsoluteNumberingFix(sql, detection!, APPLY);

        // 423 is untouched by the failure and applies; 422 is skipped whole.
        expect(result).toMatchObject({ bound: 1, skipped: 1, moved: 1 });

        const ext = await sql`
            SELECT 1 FROM external_ids WHERE media_id = ${ORPHAN_422_ID} AND provider = 'tmdb'
        `;
        expect(ext).toHaveLength(0);
        const [orphan] = await sql<
            {
                parent_id: string;
                season_number: number;
                episode_number: number;
                title: string;
                title_binding: string;
            }[]
        >`
            SELECT parent_id, season_number, episode_number, title, title_binding
            FROM media_items WHERE id = ${ORPHAN_422_ID}
        `;
        expect(orphan).toEqual({
            parent_id: SEASON1_ID,
            season_number: 1,
            episode_number: 422,
            title: 'S01E0422 - SKY HARBOR',
            title_binding: 'position',
        });
        const [ghostId] = await sql<{ external_id: string }[]>`
            SELECT external_id FROM external_ids
            WHERE media_id = ${GHOST_422_ID} AND provider = 'tmdb'
        `;
        expect(ghostId?.external_id).toBe('9422');
        const state = await sql<{ media_id: string }[]>`
            SELECT media_id FROM user_media_state WHERE user_id = ${TEST_USER_ID}
        `;
        expect(state.map((r) => r.media_id)).toEqual([GHOST_422_ID]);
        const moves = await sql<{ episode_id: string }[]>`
            SELECT episode_id FROM episode_reconciliation_moves WHERE series_id = ${SERIES_ID}
        `;
        expect(moves.map((r) => r.episode_id)).toEqual([ORPHAN_423_ID]);
    });

    it('skips a pair whose ghost left its slot since detection, writing nothing', async () => {
        await seedBaseFixture(sql);
        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);
        // The ghost is relocated and another row now holds the slot the file
        // row would adopt.
        await sql`UPDATE media_items SET episode_number = 999 WHERE id = ${GHOST_422_ID}`;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
            VALUES (${DUPE_GHOST_422_ID}, 'Squatter', 'episode', 'active', false, ${SEASON13_ID}, 13, 422)
        `;

        const result = await applyAbsoluteNumberingFix(sql, detection!, APPLY);

        expect(result).toMatchObject({ bound: 1, skipped: 1 });
        const ext = await sql`
            SELECT 1 FROM external_ids WHERE media_id = ${ORPHAN_422_ID} AND provider = 'tmdb'
        `;
        expect(ext).toHaveLength(0);
        const [ghost] = await sql<{ id: string }[]>`
            SELECT mi.id FROM media_items mi
            JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'tmdb'
            WHERE mi.id = ${GHOST_422_ID}
        `;
        expect(ghost?.id).toBe(GHOST_422_ID);
    });

    it('works on a reserved connection too (the handle the metadata sync passes in)', async () => {
        await seedBaseFixture(sql);
        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);
        await blockMoveOfOrphan422();

        const reserved = await sql.reserve();
        let result;
        try {
            result = await applyAbsoluteNumberingFix(reserved, detection!, APPLY);
        } finally {
            reserved.release();
        }

        // Same outcome as on the pool: the failed pair rolled back on its own,
        // the other pair committed.
        expect(result).toMatchObject({ bound: 1, skipped: 1 });
        const ext422 = await sql`SELECT 1 FROM external_ids WHERE media_id = ${ORPHAN_422_ID}`;
        const ext423 = await sql`SELECT 1 FROM external_ids WHERE media_id = ${ORPHAN_423_ID}`;
        expect(ext422).toHaveLength(0);
        expect(ext423).toHaveLength(1);
        const [ghost] = await sql`SELECT id FROM media_items WHERE id = ${GHOST_422_ID}`;
        expect(ghost).toBeDefined();
    });
});

describe('undo of an applied move', () => {
    async function applyAll(): Promise<void> {
        await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, {
            ...DEPS,
            autoApplyNumberMatches: true,
        });
    }

    async function moveIdFor(episodeId: string): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            SELECT id FROM episode_reconciliation_moves WHERE episode_id = ${episodeId}
        `;
        return row.id;
    }

    /** What the next metadata sync does after an undo: it recreates the ghost. */
    async function recreateGhost422(): Promise<void> {
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
            VALUES (${GHOST_422_ID}, 'A Deadly Infiltration!', 'episode', 'active', false, ${SEASON13_ID}, 13, 422)
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
            VALUES (${GHOST_422_ID}, 'tmdb', '9422', 'episode', true, 'test-fixture')
        `;
    }

    it('restores position, title and identity, and marks the move undone', async () => {
        await seedBaseFixture(sql);
        await applyAll();

        const result = await undoReconciliationMove(sql, await moveIdFor(ORPHAN_422_ID), 'tester');

        expect(result).toMatchObject({
            episodeId: ORPHAN_422_ID,
            seasonNumber: 1,
            episodeNumber: 422,
        });
        const [orphan] = await sql<
            {
                parent_id: string;
                season_number: number;
                episode_number: number;
                title: string;
                title_binding: string;
                overview: string | null;
            }[]
        >`
            SELECT parent_id, season_number, episode_number, title, title_binding, overview
            FROM media_items WHERE id = ${ORPHAN_422_ID}
        `;
        expect(orphan).toEqual({
            parent_id: SEASON1_ID,
            season_number: 1,
            episode_number: 422,
            title: 'S01E0422 - SKY HARBOR',
            title_binding: 'position',
            overview: null,
        });
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ${ORPHAN_422_ID} AND provider = 'tmdb'`,
        ).toHaveLength(0);
        const [move] = await sql<{ undone_at: Date | null; undone_by: string | null }[]>`
            SELECT undone_at, undone_by FROM episode_reconciliation_moves
            WHERE episode_id = ${ORPHAN_422_ID}
        `;
        expect(move.undone_at).not.toBeNull();
        expect(move.undone_by).toBe('tester');
        // The other pair is untouched.
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ${ORPHAN_423_ID} AND provider = 'tmdb'`,
        ).toHaveLength(1);
    });

    it('blocks the same pair from being applied again, even with the setting on', async () => {
        await seedBaseFixture(sql);
        await applyAll();
        await undoReconciliationMove(sql, await moveIdFor(ORPHAN_422_ID), 'tester');
        await recreateGhost422();

        const result = await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, {
            ...DEPS,
            autoApplyNumberMatches: true,
        });

        expect(result).toBeNull();
        const [orphan] = await sql<{ season_number: number }[]>`
            SELECT season_number FROM media_items WHERE id = ${ORPHAN_422_ID}
        `;
        expect(orphan.season_number).toBe(1);
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ${ORPHAN_422_ID} AND provider = 'tmdb'`,
        ).toHaveLength(0);

        // Control: without the undo marker the same state matches again, so the
        // block is what stopped it.
        await sql`DELETE FROM sync_quarantine WHERE provider = 'lumastra-reconcile-absolute'`;
        // The fixture has no file rows, so the has_files recompute inside the
        // apply and the undo cleared the flag the fixture set by hand.
        await sql`UPDATE media_items SET has_files = true WHERE id = ${ORPHAN_422_ID}`;
        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);
        expect(detection?.matches.map((m) => m.episodeId)).toEqual([ORPHAN_422_ID]);
    });

    it('does not propose the undone pair either', async () => {
        await seedBaseFixture(sql);
        await applyAll();
        await undoReconciliationMove(sql, await moveIdFor(ORPHAN_422_ID), 'tester');
        await recreateGhost422();

        const result = await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, {
            ...DEPS,
            autoApplyNumberMatches: false,
        });

        expect(result).toBeNull();
        expect(
            await sql`SELECT 1 FROM sync_quarantine WHERE provider = 'lumastra-reconcile-absolute' AND resolved_at IS NULL`,
        ).toHaveLength(0);
    });

    it('refuses a second undo of the same move', async () => {
        await seedBaseFixture(sql);
        await applyAll();
        const id = await moveIdFor(ORPHAN_422_ID);
        await undoReconciliationMove(sql, id, 'tester');

        await expect(undoReconciliationMove(sql, id, 'tester')).rejects.toMatchObject({
            code: 'already-undone',
        });
    });

    it('answers slot-taken when another episode took the original position, and writes nothing', async () => {
        await seedBaseFixture(sql);
        await applyAll();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
            VALUES (${DUPE_ORPHAN_422_ID}, 'New file', 'episode', 'active', true, ${SEASON1_ID}, 1, 422)
        `;

        await expect(
            undoReconciliationMove(sql, await moveIdFor(ORPHAN_422_ID), 'tester'),
        ).rejects.toMatchObject({ code: 'slot-taken' });

        // Still bound and still in season 13.
        const [orphan] = await sql<{ season_number: number }[]>`
            SELECT season_number FROM media_items WHERE id = ${ORPHAN_422_ID}
        `;
        expect(orphan.season_number).toBe(13);
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ${ORPHAN_422_ID} AND provider = 'tmdb'`,
        ).toHaveLength(1);
        const [move] = await sql<{ undone_at: Date | null }[]>`
            SELECT undone_at FROM episode_reconciliation_moves WHERE episode_id = ${ORPHAN_422_ID}
        `;
        expect(move.undone_at).toBeNull();
    });

    it('answers identity-changed when the episode carries a different TMDB id now', async () => {
        await seedBaseFixture(sql);
        await applyAll();
        await sql`DELETE FROM external_ids WHERE media_id = ${ORPHAN_422_ID} AND provider = 'tmdb'`;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
            VALUES (${ORPHAN_422_ID}, 'tmdb', '777', 'episode', true, 'manual')
        `;

        await expect(
            undoReconciliationMove(sql, await moveIdFor(ORPHAN_422_ID), 'tester'),
        ).rejects.toMatchObject({ code: 'identity-changed' });
    });

    it('answers not-found for an unknown move', async () => {
        await expect(
            undoReconciliationMove(sql, '00000000-0000-4000-a000-0000000050ff', 'tester'),
        ).rejects.toMatchObject({ code: 'not-found' });
    });
});

// ---------------------------------------------------------------------------
// Absolute number in the file name (evidence 'filename-absolute')
// ---------------------------------------------------------------------------

describe('absolute episode number from the file name', () => {
    const created: string[] = [];
    let tmdbSeq = 910000;
    const fileRoot = `/itest-abs-${Math.random().toString(16).slice(2, 10)}`;

    async function newSeries(title: string): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, has_files)
            VALUES (${title}, 'tv', 'active', true) RETURNING id
        `;
        created.push(row.id);
        return row.id;
    }

    async function newSeason(seriesId: string, n: number): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, has_files, parent_id, season_number)
            VALUES (${`Season ${n}`}, 'season', 'active', true, ${seriesId}, ${n}) RETURNING id
        `;
        return row.id;
    }

    /** TMDB episodes `from..to` of a season. `files` marks them bound to a file. */
    async function catalogEpisodes(
        seasonId: string,
        season: number,
        from: number,
        to: number,
        opts: { files?: boolean; skip?: number[] } = {},
    ): Promise<Map<number, string>> {
        const ids = new Map<number, string>();
        for (let e = from; e <= to; e++) {
            if (opts.skip?.includes(e)) continue;
            const [row] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status, has_files, parent_id, season_number, episode_number, title_binding)
                VALUES (${`TMDB S${season}E${e}`}, 'episode', 'active', ${opts.files ?? false}, ${seasonId}, ${season}, ${e}, 'identity')
                RETURNING id
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
                VALUES (${row.id}, 'tmdb', ${String(tmdbSeq++)}, 'episode', true, 'test-fixture')
            `;
            ids.set(e, row.id);
        }
        return ids;
    }

    /** A file-backed episode with no identity; `absolute` is what its file name carries. */
    async function orphan(
        seasonId: string,
        season: number,
        episode: number,
        absolute: number | null,
        title: string | null = FILE_TITLE,
    ): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, has_files, parent_id, season_number, episode_number, title_binding)
            VALUES (${`S${season}E${episode} file`}, 'episode', 'active', true, ${seasonId}, ${season}, ${episode}, 'position')
            RETURNING id
        `;
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, absolute_episode)
            VALUES (${`${fileRoot}/${row.id}/Show - S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')} - ${String(absolute ?? 0).padStart(3, '0')} - ${title ?? 'TBA'} [WEBDL-720p].mkv`}, ${absolute}) RETURNING id
        `;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default) VALUES (${row.id}, ${file.id}, true)`;
        return row.id;
    }

    /** The TMDB name of a ghost, as the metadata sync stored it. */
    async function nameGhost(id: string | undefined, title: string): Promise<void> {
        await sql`UPDATE media_items SET title = ${title} WHERE id = ${id!}`;
    }

    async function positionOf(
        id: string,
    ): Promise<{ season_number: number; episode_number: number; tmdb: string | null }> {
        const [row] = await sql<
            { season_number: number; episode_number: number; tmdb: string | null }[]
        >`
            SELECT mi.season_number, mi.episode_number,
                   (SELECT external_id FROM external_ids
                    WHERE media_id = mi.id AND provider = 'tmdb' AND media_type = 'episode') AS tmdb
            FROM media_items mi WHERE mi.id = ${id}
        `;
        return row;
    }

    beforeEach(async () => {
        await cleanup();
    });

    afterAll(async () => {
        await cleanup();
    });

    async function cleanup(): Promise<void> {
        if (created.length > 0) {
            await sql`DELETE FROM sync_quarantine WHERE provider = 'lumastra-reconcile-absolute'`;
            await sql`DELETE FROM episode_reconciliation_moves WHERE series_id = ANY(${created})`;
            await sql`
                DELETE FROM media_items WHERE parent_id IN (
                    SELECT id FROM media_items WHERE parent_id = ANY(${created})
                )
            `;
            await sql`DELETE FROM media_items WHERE parent_id = ANY(${created})`;
            await sql`DELETE FROM media_items WHERE id = ANY(${created})`;
            created.length = 0;
        }
        await sql`DELETE FROM media_files WHERE file_path LIKE ${`${fileRoot}/%`}`;
    }

    const OFF = { autoApplyNumberMatches: false, catalog: [] };
    const FILE_TITLE = 'Duel! Amagai vs. Ichigo';
    const TMDB_TITLE = 'Duel, Amagai vs. Ichigo!';

    it('Bleach: S09E21 named 188 binds to S1E188 (not S1E21) and applies with the setting off', async () => {
        const series = await newSeries('Bleach (Test)');
        const s1 = await newSeason(series, 1);
        const s9 = await newSeason(series, 9);
        // TMDB season 1 holds all 366 episodes; a few are bound to files already.
        const s1Eps = await catalogEpisodes(s1, 1, 1, 366);
        await sql`UPDATE media_items SET has_files = true WHERE id = ANY(${[s1Eps.get(1)!, s1Eps.get(2)!]})`;
        await nameGhost(s1Eps.get(188), TMDB_TITLE);
        const file = await orphan(s9, 9, 21, 188);

        const detection = await detectAbsoluteNumberingFix(sql, series);
        expect(detection?.matches).toHaveLength(1);
        expect(detection?.matches[0]).toMatchObject({
            episodeId: file,
            ghostId: s1Eps.get(188),
            targetSeasonNumber: 1,
            targetEpisodeNumber: 188,
            evidence: 'filename-absolute',
        });

        const result = await maybeAutoFixAbsoluteNumbering(sql, series, OFF);
        expect(result).toMatchObject({ bound: 1, proposed: 0 });

        const moved = await positionOf(file);
        expect(moved).toMatchObject({ season_number: 1, episode_number: 188 });
        expect(moved.tmdb).not.toBeNull();
        // S1E21 stays the file-less ghost it was.
        expect(await positionOf(s1Eps.get(21)!)).toMatchObject({
            season_number: 1,
            episode_number: 21,
        });
        const [move] = await sql<{ evidence: string }[]>`
            SELECT evidence FROM episode_reconciliation_moves WHERE episode_id = ${file}
        `;
        expect(move.evidence).toBe('filename-absolute');
    });

    it('Polar Opposites: S02E13 named 025 binds to S1E25 of a 25-episode TMDB season 1', async () => {
        const series = await newSeries('Polar Opposites (Test)');
        const s1 = await newSeason(series, 1);
        const s2 = await newSeason(series, 2);
        // TMDB S1 = 25 episodes: 13-24 already bound to local files, 25 not yet; S2 = 12 bound.
        const first = await catalogEpisodes(s1, 1, 1, 12);
        const middle = await catalogEpisodes(s1, 1, 13, 24, { files: true });
        const last = await catalogEpisodes(s1, 1, 25, 25);
        await catalogEpisodes(s2, 2, 1, 12, { files: true });
        await nameGhost(last.get(25), FILE_TITLE);
        const file = await orphan(s2, 2, 13, 25);

        const result = await maybeAutoFixAbsoluteNumbering(sql, series, OFF);

        expect(result).toMatchObject({ bound: 1 });
        expect(await positionOf(file)).toMatchObject({ season_number: 1, episode_number: 25 });
        expect(first.size + middle.size + last.size).toBe(25);
        const ghost = await sql`SELECT 1 FROM media_items WHERE id = ${last.get(25)!}`;
        expect(ghost).toHaveLength(0);
    });

    it('One Piece: S01E0422 (absolute 422) binds to S13E422 when (a) and (b) agree', async () => {
        const series = await newSeries('One Piece (Test)');
        const s1 = await newSeason(series, 1);
        // Seasons 1-11 hold 35 episodes, season 12 holds 36: 421 before season 13.
        for (let n = 1; n <= 12; n++) {
            const id = n === 1 ? s1 : await newSeason(series, n);
            await catalogEpisodes(id, n, 1, n === 12 ? 36 : 35, { files: true });
        }
        const s13 = await newSeason(series, 13);
        const eps = await catalogEpisodes(s13, 13, 422, 522);
        await nameGhost(eps.get(422), TMDB_TITLE);
        const file = await orphan(s1, 1, 422, 422);

        const detection = await detectAbsoluteNumberingFix(sql, series);
        expect(detection?.matches).toEqual([
            expect.objectContaining({
                episodeId: file,
                ghostId: eps.get(422),
                targetSeasonNumber: 13,
                targetEpisodeNumber: 422,
                evidence: 'filename-absolute',
            }),
        ]);

        await maybeAutoFixAbsoluteNumbering(sql, series, OFF);
        expect(await positionOf(file)).toMatchObject({ season_number: 13, episode_number: 422 });
    });

    it('One Piece with a hole in the earlier seasons: only the absolutely numbered season (b) decides', async () => {
        const series = await newSeries('One Piece Holes (Test)');
        const s1 = await newSeason(series, 1);
        await catalogEpisodes(s1, 1, 1, 35, { files: true, skip: [10] });
        const s13 = await newSeason(series, 13);
        const eps = await catalogEpisodes(s13, 13, 422, 522);
        await nameGhost(eps.get(422), TMDB_TITLE);
        const file = await orphan(s1, 1, 422, 422);

        const detection = await detectAbsoluteNumberingFix(sql, series);
        expect(detection?.matches).toEqual([
            expect.objectContaining({ episodeId: file, ghostId: eps.get(422) }),
        ]);
    });

    it('declines when the catalog has a hole and no season is numbered absolutely', async () => {
        const series = await newSeries('Holes (Test)');
        const s1 = await newSeason(series, 1);
        const s9 = await newSeason(series, 9);
        await catalogEpisodes(s1, 1, 1, 366, { skip: [100] });
        await orphan(s9, 9, 21, 188);

        expect(await detectAbsoluteNumberingFix(sql, series)).toBeNull();
    });

    it('declines when (a) and (b) name different episodes', async () => {
        const series = await newSeries('Disagree (Test)');
        const s1 = await newSeason(series, 1);
        const s2 = await newSeason(series, 2);
        const s3 = await newSeason(series, 3);
        const s9 = await newSeason(series, 9);
        await catalogEpisodes(s1, 1, 1, 10);
        await catalogEpisodes(s2, 2, 1, 5);
        // Season 3 is numbered absolutely but does not continue the run: E12 is
        // the 12th position by (b) and the 12th position by (a) is S2E2.
        await catalogEpisodes(s3, 3, 8, 20);
        await orphan(s9, 9, 1, 12);

        expect(await detectAbsoluteNumberingFix(sql, series)).toBeNull();
    });

    it('declines when the target already has a file', async () => {
        const series = await newSeries('Taken (Test)');
        const s1 = await newSeason(series, 1);
        const s9 = await newSeason(series, 9);
        const eps = await catalogEpisodes(s1, 1, 1, 366);
        await sql`UPDATE media_items SET has_files = true WHERE id = ${eps.get(188)!}`;
        const file = await orphan(s9, 9, 21, 188);

        expect(await detectAbsoluteNumberingFix(sql, series)).toBeNull();
        expect(await positionOf(file)).toMatchObject({ season_number: 9, episode_number: 21 });
    });

    it('declines a locked target ghost', async () => {
        const series = await newSeries('Locked (Test)');
        const s1 = await newSeason(series, 1);
        const s9 = await newSeason(series, 9);
        const eps = await catalogEpisodes(s1, 1, 1, 366);
        await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${eps.get(188)!}`;
        await orphan(s9, 9, 21, 188);

        expect(await detectAbsoluteNumberingFix(sql, series)).toBeNull();
    });

    it('declines both orphans that claim the same target', async () => {
        const series = await newSeries('Twins (Test)');
        const s1 = await newSeason(series, 1);
        const s9 = await newSeason(series, 9);
        await catalogEpisodes(s1, 1, 1, 366);
        await orphan(s9, 9, 21, 188);
        await orphan(s9, 9, 22, 188);

        expect(await detectAbsoluteNumberingFix(sql, series)).toBeNull();
    });

    it('an orphan with an absolute number never falls back to the number-match path', async () => {
        await seedBaseFixture(sql);
        // The Sky Harbor orphan 422 would number-match ghost 9422, but its file says 7,
        // which no catalog position or absolute season carries.
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, absolute_episode)
            VALUES (${`${fileRoot}/sky-422.mkv`}, 7) RETURNING id
        `;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default) VALUES (${ORPHAN_422_ID}, ${file.id}, true)`;

        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);

        expect(detection?.matches.map((m) => m.episodeId)).toEqual([ORPHAN_423_ID]);
        expect(detection?.matches[0].evidence).toBe('number-match');
    });

    it('an orphan without an absolute number keeps the number-match path (proposed with the setting off)', async () => {
        await seedBaseFixture(sql);

        const result = await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, DEPS);

        expect(result).toMatchObject({ bound: 0, proposed: 2 });
    });

    it('does not apply a pair that was undone, even with filename evidence', async () => {
        const series = await newSeries('Undone (Test)');
        const s1 = await newSeason(series, 1);
        const s9 = await newSeason(series, 9);
        const eps = await catalogEpisodes(s1, 1, 1, 366);
        const file = await orphan(s9, 9, 21, 188);
        const [ext] = await sql<{ external_id: string }[]>`
            SELECT external_id FROM external_ids WHERE media_id = ${eps.get(188)!}
        `;
        await sql`
            INSERT INTO sync_quarantine
                (provider, external_id, media_type, expected_series_id, payload, reason, source, resolved_at, resolution)
            VALUES ('lumastra-reconcile-absolute', ${file}, 'episode', ${series},
                    ${sql.json({ tmdbEpisodeId: ext.external_id })}, 'absolute-numbering:proposed',
                    'test', now(), 'dismissed')
        `;

        expect(await detectAbsoluteNumberingFix(sql, series)).toBeNull();
    });

    describe('the file title decides whether the position is trusted', () => {
        async function bleachShape(): Promise<{
            series: string;
            s9: string;
            eps: Map<number, string>;
        }> {
            const series = await newSeries('Title Check (Test)');
            const s1 = await newSeason(series, 1);
            const s9 = await newSeason(series, 9);
            return { series, s9, eps: await catalogEpisodes(s1, 1, 1, 366) };
        }

        it('Case Closed shape: the position lands on an episode with another title, declined and nothing written', async () => {
            const { series, s9, eps } = await bleachShape();
            await nameGhost(eps.get(41), 'Left in Tatters');
            const file = await orphan(s9, 9, 13, 41, 'The Victory Flag Vandalism Case');

            expect(await detectAbsoluteNumberingFix(sql, series)).toBeNull();
            const result = await maybeAutoFixAbsoluteNumbering(sql, series, {
                autoApplyNumberMatches: true,
                catalog: [],
            });
            expect(result).toBeNull();

            expect(await positionOf(file)).toMatchObject({
                season_number: 9,
                episode_number: 13,
                tmdb: null,
            });
            const proposals = await sql`
                SELECT 1 FROM sync_quarantine
                WHERE provider = 'lumastra-reconcile-absolute' AND external_id = ${file}
            `;
            expect(proposals).toHaveLength(0);
            const moves = await sql`
                SELECT 1 FROM episode_reconciliation_moves WHERE episode_id = ${file}
            `;
            expect(moves).toHaveLength(0);
        });

        it('remembers a declined pair: the second detection does not load the catalog', async () => {
            const { series, s9, eps } = await bleachShape();
            await nameGhost(eps.get(41), 'Left in Tatters');
            await orphan(s9, 9, 13, 41, 'The Victory Flag Vandalism Case');
            const getCatalog = vi.fn(async () => [] as TmdbCatalogEpisode[]);

            expect(await detectAbsoluteNumberingFix(sql, series, { getCatalog })).toBeNull();
            expect(getCatalog).toHaveBeenCalledTimes(1);

            expect(await detectAbsoluteNumberingFix(sql, series, { getCatalog })).toBeNull();
            expect(getCatalog).toHaveBeenCalledTimes(1);
        });

        it('a remembered decline does not block the pair once the stored title agrees', async () => {
            const { series, s9, eps } = await bleachShape();
            await nameGhost(eps.get(41), 'Left in Tatters');
            const file = await orphan(s9, 9, 13, 41, 'The Victory Flag Vandalism Case');
            const getCatalog = vi.fn(async () => [] as TmdbCatalogEpisode[]);
            expect(await detectAbsoluteNumberingFix(sql, series, { getCatalog })).toBeNull();

            await nameGhost(eps.get(41), 'The Victory Flag Vandalism Case');
            const detection = await detectAbsoluteNumberingFix(sql, series, { getCatalog });

            expect(detection?.matches.map((m) => m.episodeId)).toEqual([file]);
        });

        it('without a catalog loader the default loader supplies the alt names (the verdict never depends on the caller)', async () => {
            const { series, s9, eps } = await bleachShape();
            await nameGhost(eps.get(41), 'Left in Tatters');
            const file = await orphan(s9, 9, 13, 41, 'The Victory Flag Vandalism Case');
            const [ext] = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids WHERE media_id = ${eps.get(41)!}
            `;
            catalogLoader.mockResolvedValueOnce([
                {
                    tmdbEpisodeId: ext.external_id,
                    name: 'Left in Tatters',
                    altNames: ['The Victory Flag Vandalism Case'],
                    overview: null,
                    seasonNumber: 1,
                    episodeNumber: 41,
                    stillPath: null,
                },
            ]);

            const detection = await detectAbsoluteNumberingFix(sql, series);

            expect(catalogLoader).toHaveBeenCalledTimes(1);
            expect(detection?.matches.map((m) => m.episodeId)).toEqual([file]);
            expect(detection?.matches[0].evidence).toBe('filename-absolute');
        });

        it('without a loader a decline is remembered like with one: the second pass loads nothing', async () => {
            const { series, s9, eps } = await bleachShape();
            await nameGhost(eps.get(41), 'Left in Tatters');
            await orphan(s9, 9, 13, 41, 'The Victory Flag Vandalism Case');
            catalogLoader.mockResolvedValue([]);

            expect(await detectAbsoluteNumberingFix(sql, series)).toBeNull();
            expect(await detectAbsoluteNumberingFix(sql, series)).toBeNull();

            expect(catalogLoader).toHaveBeenCalledTimes(1);
        });

        it('Bleach: a title that differs only in punctuation and case applies with the setting off', async () => {
            const { series, s9, eps } = await bleachShape();
            await nameGhost(eps.get(250), 'That Man, for the Sake of the Kuchiki');
            const file = await orphan(s9, 9, 21, 250, 'That Man For the Sake of the Kuchiki');

            const result = await maybeAutoFixAbsoluteNumbering(sql, series, OFF);

            expect(result).toMatchObject({ bound: 1, proposed: 0 });
            expect(await positionOf(file)).toMatchObject({ season_number: 1, episode_number: 250 });
        });

        it('a file named TBA is only proposed, even with the setting on', async () => {
            const { series, s9, eps } = await bleachShape();
            await nameGhost(eps.get(85), 'Some Real Title');
            const file = await orphan(s9, 9, 21, 85, null);

            const detection = await detectAbsoluteNumberingFix(sql, series);
            expect(detection?.matches).toEqual([
                expect.objectContaining({
                    episodeId: file,
                    evidence: 'filename-absolute-untitled',
                }),
            ]);

            const result = await maybeAutoFixAbsoluteNumbering(sql, series, {
                autoApplyNumberMatches: true,
                catalog: [],
            });

            expect(result).toMatchObject({ bound: 0, proposed: 1 });
            expect(await positionOf(file)).toMatchObject({
                season_number: 9,
                episode_number: 21,
                tmdb: null,
            });
            const [row] = await sql<{ payload: { evidence: string } }[]>`
                SELECT payload FROM sync_quarantine
                WHERE provider = 'lumastra-reconcile-absolute' AND payload->>'episodeId' = ${file}
            `;
            expect(row.payload.evidence).toBe('filename-absolute-untitled');
        });

        it('a generic title ("Episode 12") is only proposed', async () => {
            const { series, s9, eps } = await bleachShape();
            await nameGhost(eps.get(12), 'Some Real Title');
            const file = await orphan(s9, 9, 21, 12, 'Episode 12');

            const result = await maybeAutoFixAbsoluteNumbering(sql, series, OFF);

            expect(result).toMatchObject({ bound: 0, proposed: 1 });
            expect(await positionOf(file)).toMatchObject({ season_number: 9, episode_number: 21 });
        });

        it('a target without a title is only proposed', async () => {
            const { series, s9, eps } = await bleachShape();
            await sql`UPDATE media_items SET title = '' WHERE id = ${eps.get(188)!}`;
            await orphan(s9, 9, 21, 188);

            const result = await maybeAutoFixAbsoluteNumbering(sql, series, OFF);

            expect(result).toMatchObject({ bound: 0, proposed: 1 });
        });

        it('an alt name of the target agrees with the file title', async () => {
            const { series, s9, eps } = await bleachShape();
            await nameGhost(eps.get(188), 'Ein Duell');
            const [ext] = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids WHERE media_id = ${eps.get(188)!}
            `;
            const file = await orphan(s9, 9, 21, 188);
            const catalog: TmdbCatalogEpisode[] = [
                {
                    tmdbEpisodeId: ext.external_id,
                    name: 'Ein Duell',
                    altNames: [TMDB_TITLE],
                    overview: null,
                    seasonNumber: 1,
                    episodeNumber: 188,
                    stillPath: null,
                },
            ];

            const result = await maybeAutoFixAbsoluteNumbering(sql, series, {
                autoApplyNumberMatches: false,
                catalog,
            });

            expect(result).toMatchObject({ bound: 1, proposed: 0 });
            expect(await positionOf(file)).toMatchObject({ season_number: 1, episode_number: 188 });
        });

        it('each segment of a multi-part file title must match', async () => {
            const { series, s9, eps } = await bleachShape();
            await nameGhost(eps.get(188), 'The First Part');
            await orphan(s9, 9, 21, 188, 'The First Part - Something Else Entirely');

            expect(await detectAbsoluteNumberingFix(sql, series)).toBeNull();
        });
    });

    describe('hardening of the file-name path', () => {
        const FN_ON = {
            autoApplyNumberMatches: false,
            autoApplyFilenameMatches: true,
            catalog: [],
        };

        /** A file-backed episode whose file has exactly this name. */
        async function orphanNamed(
            seasonId: string,
            season: number,
            episode: number,
            absolute: number,
            fileName: string,
        ): Promise<string> {
            const [row] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status, has_files, parent_id, season_number, episode_number, title_binding)
                VALUES (${`S${season}E${episode} file`}, 'episode', 'active', true, ${seasonId}, ${season}, ${episode}, 'position')
                RETURNING id
            `;
            const [file] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, absolute_episode)
                VALUES (${`${fileRoot}/${row.id}/${fileName}`}, ${absolute}) RETURNING id
            `;
            await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default) VALUES (${row.id}, ${file.id}, true)`;
            return row.id;
        }

        /** Seasons 1-12 bound to files, season 13 an absolutely numbered ghost run from 422. */
        async function onePieceShape(
            title: string,
        ): Promise<{ series: string; s1: string; eps: Map<number, string> }> {
            const series = await newSeries(title);
            const s1 = await newSeason(series, 1);
            for (let n = 1; n <= 12; n++) {
                const id = n === 1 ? s1 : await newSeason(series, n);
                await catalogEpisodes(id, n, 1, n === 12 ? 36 : 35, { files: true });
            }
            const s13 = await newSeason(series, 13);
            return { series, s1, eps: await catalogEpisodes(s13, 13, 422, 522) };
        }

        it('S01E0422 - ONE PIECE [GER-JAP]: the series name is not a title, so (a) and (b) agreeing applies it as corroborated', async () => {
            const { series, s1, eps } = await onePieceShape('One Piece');
            await nameGhost(eps.get(422), TMDB_TITLE);
            const file = await orphanNamed(s1, 1, 422, 422, 'S01E0422 - ONE PIECE [GER-JAP].mp4');

            const detection = await detectAbsoluteNumberingFix(sql, series);
            expect(detection?.matches).toEqual([
                expect.objectContaining({
                    episodeId: file,
                    ghostId: eps.get(422),
                    evidence: 'filename-absolute-corroborated',
                }),
            ]);

            const result = await maybeAutoFixAbsoluteNumbering(sql, series, FN_ON);

            expect(result).toMatchObject({ bound: 1, proposed: 0 });
            expect(await positionOf(file)).toMatchObject({
                season_number: 13,
                episode_number: 422,
            });
            const [move] = await sql<{ evidence: string }[]>`
                SELECT evidence FROM episode_reconciliation_moves WHERE episode_id = ${file}
            `;
            expect(move.evidence).toBe('filename-absolute-corroborated');
        });

        it('the same untitled name with only one derivation of the number stays a proposal', async () => {
            const series = await newSeries('One Piece');
            const s1 = await newSeason(series, 1);
            await catalogEpisodes(s1, 1, 1, 35, { files: true, skip: [10] });
            const s13 = await newSeason(series, 13);
            const eps = await catalogEpisodes(s13, 13, 422, 522);
            const file = await orphanNamed(s1, 1, 422, 422, 'S01E0422 - ONE PIECE [GER-JAP].mp4');

            const detection = await detectAbsoluteNumberingFix(sql, series);
            expect(detection?.matches).toEqual([
                expect.objectContaining({
                    ghostId: eps.get(422),
                    evidence: 'filename-absolute-untitled',
                }),
            ]);
            const result = await maybeAutoFixAbsoluteNumbering(sql, series, FN_ON);

            expect(result).toMatchObject({ bound: 0, proposed: 1 });
            expect(await positionOf(file)).toMatchObject({ season_number: 1, episode_number: 422 });
        });

        it('InuYasha.S01E120.German.AC3.DL...: language and release words are no title; the match is untitled, not declined', async () => {
            const series = await newSeries('InuYasha');
            const s1 = await newSeason(series, 1);
            const s2 = await newSeason(series, 2);
            const eps = await catalogEpisodes(s1, 1, 1, 167);
            await nameGhost(eps.get(120), 'A Real Episode Title');
            await orphanNamed(
                s2,
                2,
                120,
                120,
                'InuYasha.S01E120.German.AC3.DL.720p.BluRay.x264-Fuuko.mkv',
            );

            const detection = await detectAbsoluteNumberingFix(sql, series);

            expect(detection?.matches).toEqual([
                expect.objectContaining({
                    ghostId: eps.get(120),
                    evidence: 'filename-absolute-untitled',
                }),
            ]);
        });

        it('a detection made on an agreeing title is not applied once the file title stopped agreeing (the evidence is part of the key)', async () => {
            const { series, s9, eps } = await bleachLike();
            await nameGhost(eps.get(188), TMDB_TITLE);
            const file = await orphan(s9, 9, 21, 188);
            const detection = await detectAbsoluteNumberingFix(sql, series);
            expect(detection?.matches[0].evidence).toBe('filename-absolute');
            await sql`
                UPDATE media_files SET file_path = ${`${fileRoot}/renamed/Show - S09E21 - 188 - TBA [WEBDL-720p].mkv`}
                WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${file})
            `;

            const result = await applyAbsoluteNumberingFix(sql, detection!, FN_ON);

            expect(result).toMatchObject({ bound: 0, skipped: 1 });
            expect(await positionOf(file)).toMatchObject({
                season_number: 9,
                episode_number: 21,
                tmdb: null,
            });
        });

        it('the apply re-filters with the setting: a file-name detection is skipped once the kill switch is off', async () => {
            const { series, s9, eps } = await bleachLike();
            await nameGhost(eps.get(188), TMDB_TITLE);
            const file = await orphan(s9, 9, 21, 188);
            const detection = await detectAbsoluteNumberingFix(sql, series);

            const result = await applyAbsoluteNumberingFix(sql, detection!, {
                ...FN_ON,
                autoApplyFilenameMatches: false,
            });

            expect(result).toMatchObject({ bound: 0, skipped: 1 });
            expect(await positionOf(file)).toMatchObject({ season_number: 9, episode_number: 21 });
        });

        async function bleachLike(): Promise<{
            series: string;
            s9: string;
            eps: Map<number, string>;
        }> {
            const series = await newSeries('Hardening (Test)');
            const s1 = await newSeason(series, 1);
            const s9 = await newSeason(series, 9);
            return { series, s9, eps: await catalogEpisodes(s1, 1, 1, 366) };
        }

        it('kill switch off: a file-name match becomes a proposal and nothing is changed', async () => {
            const { series, s9, eps } = await bleachLike();
            await nameGhost(eps.get(188), TMDB_TITLE);
            const file = await orphan(s9, 9, 21, 188);

            const result = await maybeAutoFixAbsoluteNumbering(sql, series, {
                ...FN_ON,
                autoApplyFilenameMatches: false,
            });

            expect(result).toMatchObject({ bound: 0, proposed: 1 });
            expect(await positionOf(file)).toMatchObject({
                season_number: 9,
                episode_number: 21,
                tmdb: null,
            });
            const [row] = await sql<{ payload: { evidence: string } }[]>`
                SELECT payload FROM sync_quarantine
                WHERE provider = 'lumastra-reconcile-absolute' AND payload->>'episodeId' = ${file}
            `;
            expect(row.payload.evidence).toBe('filename-absolute');
        });

        it('the real config keys decide without a deps override (file-name key)', async () => {
            const { series, s9, eps } = await bleachLike();
            await nameGhost(eps.get(188), TMDB_TITLE);
            const file = await orphan(s9, 9, 21, 188);
            const key = vi.spyOn(config, 'RECONCILE_AUTO_APPLY_FILENAME_MATCHES', 'get');

            key.mockReturnValue(false);
            const off = await maybeAutoFixAbsoluteNumbering(sql, series, { catalog: [] });
            expect(off).toMatchObject({ bound: 0, proposed: 1 });
            expect(await positionOf(file)).toMatchObject({ season_number: 9, tmdb: null });

            key.mockReturnValue(true);
            const on = await maybeAutoFixAbsoluteNumbering(sql, series, { catalog: [] });
            expect(on).toMatchObject({ bound: 1 });
            expect(await positionOf(file)).toMatchObject({ season_number: 1, episode_number: 188 });
        });

        it('the shipped default of the file-name key is on', () => {
            expect(config.RECONCILE_AUTO_APPLY_FILENAME_MATCHES).toBe(true);
        });

        it('applies at most maxPairsPerSync pairs, defers the rest with a warning, and finishes on the next sync', async () => {
            const { series, s9, eps } = await bleachLike();
            await nameGhost(eps.get(188), TMDB_TITLE);
            await nameGhost(eps.get(250), 'Second Title');
            await orphan(s9, 9, 21, 188);
            await orphan(s9, 9, 22, 250, 'Second Title');
            const warn = vi
                .spyOn(LoggerInstance.prototype, 'warn')
                .mockImplementation(() => undefined);

            const first = await maybeAutoFixAbsoluteNumbering(sql, series, {
                ...FN_ON,
                maxPairsPerSync: 1,
            });

            expect(first).toMatchObject({ bound: 1, deferred: 1 });
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('deferred'),
                expect.objectContaining({ deferred: 1, cap: 1 }),
            );
            const second = await maybeAutoFixAbsoluteNumbering(sql, series, {
                ...FN_ON,
                maxPairsPerSync: 1,
            });
            expect(second).toMatchObject({ bound: 1, deferred: 0 });
            expect(await detectAbsoluteNumberingFix(sql, series)).toBeNull();
        });

        it('the cap defaults to 50 pairs per sync', () => {
            expect(MAX_APPLIED_PAIRS_PER_SYNC).toBe(50);
        });

        it('a number-match and a file-name candidate for the same ghost: the file-name evidence wins', async () => {
            const { series, s1, eps } = await onePieceShape('Dedupe (Test)');
            const s20 = await newSeason(series, 20);
            await nameGhost(eps.get(422), TMDB_TITLE);
            // Number-match candidate: no absolute number, sits at E422 of season 1.
            await sql`
                INSERT INTO media_items (title, media_type, status, has_files, parent_id, season_number, episode_number, title_binding)
                VALUES ('number orphan', 'episode', 'active', true, ${s1}, 1, 422, 'position')
            `;
            // File-name candidate: names 422, sits elsewhere.
            const fileOrphan = await orphan(s20, 20, 5, 422);

            const detection = await detectAbsoluteNumberingFix(sql, series);

            expect(detection?.matches.map((m) => [m.episodeId, m.evidence])).toEqual([
                [fileOrphan, 'filename-absolute'],
            ]);
        });

        it('a hole in the season numbers (season 1, then season 3) ends the gap-free catalog', async () => {
            const series = await newSeries('Season Gap (Test)');
            const s1 = await newSeason(series, 1);
            const s3 = await newSeason(series, 3);
            const s9 = await newSeason(series, 9);
            await catalogEpisodes(s1, 1, 1, 5);
            await catalogEpisodes(s3, 3, 1, 5);
            await orphan(s9, 9, 1, 7);

            expect(await detectAbsoluteNumberingFix(sql, series)).toBeNull();
        });

        it('control: with the missing season present the 7th position is found', async () => {
            const series = await newSeries('Season No Gap (Test)');
            const s1 = await newSeason(series, 1);
            const s2 = await newSeason(series, 2);
            const s3 = await newSeason(series, 3);
            const s9 = await newSeason(series, 9);
            await catalogEpisodes(s1, 1, 1, 5);
            const s2Eps = await catalogEpisodes(s2, 2, 1, 5);
            await catalogEpisodes(s3, 3, 1, 5);
            await nameGhost(s2Eps.get(2), FILE_TITLE);
            await orphan(s9, 9, 1, 7);

            const detection = await detectAbsoluteNumberingFix(sql, series);

            expect(detection?.matches).toEqual([
                expect.objectContaining({ ghostId: s2Eps.get(2) }),
            ]);
        });

        it('a multi-part title is tried whole first: "Part 1 - The Heist" matches the TMDB name "Part 1 - The Heist"', async () => {
            const { series, s9, eps } = await bleachLike();
            await nameGhost(eps.get(188), 'Part 1 - The Heist');
            await orphan(s9, 9, 21, 188, 'Part 1 - The Heist');

            const detection = await detectAbsoluteNumberingFix(sql, series);

            expect(detection?.matches[0]).toMatchObject({ evidence: 'filename-absolute' });
        });

        it('stale proposals: one whose pair is no longer detected is resolved, one still detected stays open', async () => {
            const { series, s9, eps } = await bleachLike();
            await nameGhost(eps.get(188), TMDB_TITLE);
            await nameGhost(eps.get(250), 'Second Title');
            const keep = await orphan(s9, 9, 21, 188, null); // untitled: proposal only
            const stale = await orphan(s9, 9, 22, 250, null);
            await maybeAutoFixAbsoluteNumbering(sql, series, FN_ON);
            expect(
                await sql`SELECT 1 FROM sync_quarantine WHERE provider = 'lumastra-reconcile-absolute' AND resolved_at IS NULL`,
            ).toHaveLength(2);
            // The second file no longer carries a number.
            await sql`
                UPDATE media_files SET absolute_episode = NULL
                WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${stale})
            `;

            await maybeAutoFixAbsoluteNumbering(sql, series, FN_ON);

            const rows = await sql<
                { episode: string; resolution: string | null; by: string | null }[]
            >`
                SELECT payload->>'episodeId' AS episode, resolution, resolved_by AS by
                FROM sync_quarantine WHERE provider = 'lumastra-reconcile-absolute'
            `;
            const byEpisode = Object.fromEntries(rows.map((r) => [r.episode, r]));
            expect(byEpisode[keep].resolution).toBeNull();
            expect(byEpisode[stale]).toMatchObject({
                resolution: 'recreated',
                by: 'system:reconciliation',
            });
        });

        it('stale proposals: one whose episode got its identity another way is resolved as reattached', async () => {
            const { series, s9, eps } = await bleachLike();
            await nameGhost(eps.get(188), TMDB_TITLE);
            const file = await orphan(s9, 9, 21, 188, null);
            await maybeAutoFixAbsoluteNumbering(sql, series, FN_ON);
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
                VALUES (${file}, 'tmdb', '4242424', 'episode', true, 'manual')
            `;

            await maybeAutoFixAbsoluteNumbering(sql, series, FN_ON);

            const [row] = await sql<{ resolution: string; resolved_at: Date | null }[]>`
                SELECT resolution, resolved_at FROM sync_quarantine
                WHERE provider = 'lumastra-reconcile-absolute' AND payload->>'episodeId' = ${file}
            `;
            expect(row.resolution).toBe('reattached');
            expect(row.resolved_at).not.toBeNull();
        });

        it('a proposal the sync resolved as obsolete is proposed again when the same pair is detected again', async () => {
            const { series, s9, eps } = await bleachLike();
            await nameGhost(eps.get(188), TMDB_TITLE);
            const file = await orphan(s9, 9, 21, 188, null);
            await maybeAutoFixAbsoluteNumbering(sql, series, FN_ON);
            await sql`UPDATE media_files SET absolute_episode = NULL WHERE file_path LIKE ${`${fileRoot}/${file}/%`}`;
            await maybeAutoFixAbsoluteNumbering(sql, series, FN_ON);
            await sql`UPDATE media_files SET absolute_episode = 188 WHERE file_path LIKE ${`${fileRoot}/${file}/%`}`;

            const result = await maybeAutoFixAbsoluteNumbering(sql, series, FN_ON);

            expect(result).toMatchObject({ proposed: 1 });
            expect(
                await sql`SELECT 1 FROM sync_quarantine WHERE provider = 'lumastra-reconcile-absolute' AND resolved_at IS NULL`,
            ).toHaveLength(1);
        });
    });
});

// ---------------------------------------------------------------------------
// Per-row apply / dismiss of a proposal
// ---------------------------------------------------------------------------

describe('applying or dismissing one proposal', () => {
    async function propose(): Promise<{ id422: string; id423: string }> {
        await seedBaseFixture(sql);
        await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, {
            ...DEPS,
            autoApplyNumberMatches: false,
        });
        const rows = await sql<{ id: string; external_id: string }[]>`
            SELECT id, external_id FROM sync_quarantine
            WHERE provider = 'lumastra-reconcile-absolute' AND resolved_at IS NULL
        `;
        const byEpisode = Object.fromEntries(rows.map((r) => [r.external_id.split(':')[0], r.id]));
        return { id422: byEpisode[ORPHAN_422_ID], id423: byEpisode[ORPHAN_423_ID] };
    }

    async function positionOf(
        id: string,
    ): Promise<{ season_number: number; episode_number: number; tmdb: string | null }> {
        const [row] = await sql<
            { season_number: number; episode_number: number; tmdb: string | null }[]
        >`
            SELECT mi.season_number, mi.episode_number,
                   (SELECT external_id FROM external_ids
                    WHERE media_id = mi.id AND provider = 'tmdb' AND media_type = 'episode') AS tmdb
            FROM media_items mi WHERE mi.id = ${id}
        `;
        return row;
    }

    async function writtenFor(episodeId: string): Promise<number> {
        const moves = await sql`
            SELECT 1 FROM episode_reconciliation_moves WHERE episode_id = ${episodeId}
        `;
        return moves.length;
    }

    it('lists the open proposals with series title and both titles', async () => {
        await propose();

        const rows = await listUnresolvedQuarantineByReason(sql, {
            provider: 'lumastra-reconcile-absolute',
            reason: 'absolute-numbering:proposed',
            seriesId: SERIES_ID,
            limit: 10,
        });

        expect(rows.map((r) => r.externalId)).toEqual([
            `${ORPHAN_422_ID}:9422`,
            `${ORPHAN_423_ID}:9423`,
        ]);
        expect(rows[0]).toMatchObject({
            seriesTitle: 'Sky Harbor (Test)',
            payload: {
                currentTitle: 'S01E0422 - SKY HARBOR',
                proposedTitle: 'A Deadly Infiltration!',
            },
        });
    });

    it('applies the pair, records an undo row and resolves the proposal', async () => {
        const { id422, id423 } = await propose();

        const result = await applyAbsoluteNumberingProposal(sql, id422, 'tester', DEPS);

        expect(result).toMatchObject({
            quarantineId: id422,
            episodeId: ORPHAN_422_ID,
            seasonNumber: 13,
            episodeNumber: 422,
        });
        expect(await positionOf(ORPHAN_422_ID)).toEqual({
            season_number: 13,
            episode_number: 422,
            tmdb: '9422',
        });
        expect(await sql`SELECT 1 FROM media_items WHERE id = ${GHOST_422_ID}`).toHaveLength(0);
        const [move] = await sql<{ id: string; evidence: string; undone_at: Date | null }[]>`
            SELECT id, evidence, undone_at FROM episode_reconciliation_moves
            WHERE episode_id = ${ORPHAN_422_ID}
        `;
        expect(move).toMatchObject({
            id: result.moveId,
            evidence: 'number-match',
            undone_at: null,
        });
        const [q] = await sql<
            { resolved_at: Date | null; resolved_by: string | null; resolution: string | null }[]
        >`
            SELECT resolved_at, resolved_by, resolution FROM sync_quarantine WHERE id = ${id422}
        `;
        expect(q.resolved_at).not.toBeNull();
        expect(q).toMatchObject({ resolved_by: 'tester', resolution: 'reattached' });
        // The other proposal is untouched.
        expect(await positionOf(ORPHAN_423_ID)).toMatchObject({ season_number: 1, tmdb: null });
        const [other] = await sql<{ resolved_at: Date | null }[]>`
            SELECT resolved_at FROM sync_quarantine WHERE id = ${id423}
        `;
        expect(other.resolved_at).toBeNull();
    });

    it('can be undone after the apply', async () => {
        const { id422 } = await propose();
        const applied = await applyAbsoluteNumberingProposal(sql, id422, 'tester', DEPS);

        const undone = await undoReconciliationMove(sql, applied.moveId, 'tester');

        expect(undone).toMatchObject({
            episodeId: ORPHAN_422_ID,
            seasonNumber: 1,
            episodeNumber: 422,
        });
        expect(await positionOf(ORPHAN_422_ID)).toEqual({
            season_number: 1,
            episode_number: 422,
            tmdb: null,
        });
        const [move] = await sql<{ undone_at: Date | null }[]>`
            SELECT undone_at FROM episode_reconciliation_moves WHERE id = ${applied.moveId}
        `;
        expect(move.undone_at).not.toBeNull();
    });

    it('answers stale with a reason and writes nothing when the ghost has a file now', async () => {
        const { id422 } = await propose();
        await sql`UPDATE media_items SET has_files = true WHERE id = ${GHOST_422_ID}`;

        const err = await applyAbsoluteNumberingProposal(sql, id422, 'tester', DEPS).catch(
            (e: unknown) => e,
        );

        expect(err).toBeInstanceOf(ProposalActionError);
        expect(err).toMatchObject({
            code: 'stale',
            message: expect.stringContaining('has a file'),
        });
        expect(await positionOf(ORPHAN_422_ID)).toEqual({
            season_number: 1,
            episode_number: 422,
            tmdb: null,
        });
        expect(await sql`SELECT 1 FROM media_items WHERE id = ${GHOST_422_ID}`).toHaveLength(1);
        expect(await writtenFor(ORPHAN_422_ID)).toBe(0);
        const [q] = await sql<{ resolved_at: Date | null }[]>`
            SELECT resolved_at FROM sync_quarantine WHERE id = ${id422}
        `;
        expect(q.resolved_at).toBeNull();
    });

    it.each([
        [
            'the ghost moved to another position',
            async () => {
                await sql`UPDATE media_items SET episode_number = 999 WHERE id = ${GHOST_422_ID}`;
            },
            'moved to',
        ],
        [
            'the episode was bound to another TMDB episode',
            async () => {
                await sql`
                    INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
                    VALUES (${ORPHAN_422_ID}, 'tmdb', '777', 'episode', true, 'manual')
                `;
            },
            'bound',
        ],
        [
            'the episode was locked',
            async () => {
                await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${ORPHAN_422_ID}`;
            },
            'locked',
        ],
        [
            'the target season gained an E1',
            async () => {
                await sql`
                    INSERT INTO media_items (title, media_type, status, has_files, parent_id, season_number, episode_number)
                    VALUES ('New E1', 'episode', 'active', false, ${SEASON13_ID}, 13, 1)
                `;
            },
            'does not hold',
        ],
    ])('answers stale when %s', async (_name, mutate, reason) => {
        const { id422 } = await propose();
        await mutate();

        await expect(
            applyAbsoluteNumberingProposal(sql, id422, 'tester', DEPS),
        ).rejects.toMatchObject({ code: 'stale', message: expect.stringContaining(reason) });

        expect(await writtenFor(ORPHAN_422_ID)).toBe(0);
        const [q] = await sql<{ resolved_at: Date | null }[]>`
            SELECT resolved_at FROM sync_quarantine WHERE id = ${id422}
        `;
        expect(q.resolved_at).toBeNull();
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ${GHOST_422_ID} AND external_id = '9422'`,
        ).toHaveLength(1);
    });

    it('refuses a resolved or unknown proposal', async () => {
        const { id422 } = await propose();
        await applyAbsoluteNumberingProposal(sql, id422, 'tester', DEPS);

        await expect(
            applyAbsoluteNumberingProposal(sql, id422, 'tester', DEPS),
        ).rejects.toMatchObject({ code: 'already-resolved' });
        await expect(dismissAbsoluteNumberingProposal(sql, id422, 'tester')).rejects.toMatchObject({
            code: 'already-resolved',
        });
        await expect(
            applyAbsoluteNumberingProposal(
                sql,
                '00000000-0000-4000-a000-0000000050fe',
                'tester',
                DEPS,
            ),
        ).rejects.toMatchObject({ code: 'not-found' });
    });

    it("does not treat another provider's quarantine row as a proposal", async () => {
        const { id422 } = await propose();
        await sql`UPDATE sync_quarantine SET provider = 'lumastra-reconcile' WHERE id = ${id422}`;

        await expect(
            applyAbsoluteNumberingProposal(sql, id422, 'tester', DEPS),
        ).rejects.toMatchObject({ code: 'not-found' });
        await expect(dismissAbsoluteNumberingProposal(sql, id422, 'tester')).rejects.toMatchObject({
            code: 'not-found',
        });
        await sql`DELETE FROM sync_quarantine WHERE id = ${id422}`;
    });

    it('dismiss blocks the pair: not proposed again, not applied again', async () => {
        const { id422 } = await propose();

        await dismissAbsoluteNumberingProposal(sql, id422, 'tester');

        const [q] = await sql<{ resolution: string; resolved_by: string }[]>`
            SELECT resolution, resolved_by FROM sync_quarantine WHERE id = ${id422}
        `;
        expect(q).toEqual({ resolution: 'dismissed', resolved_by: 'tester' });
        // Nothing was changed by the dismissal itself.
        expect(await positionOf(ORPHAN_422_ID)).toMatchObject({ season_number: 1, tmdb: null });

        // The next sync proposes only the other pair, and applies neither with the setting on.
        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);
        expect(detection?.matches.map((m) => m.episodeId)).toEqual([ORPHAN_423_ID]);
        const again = await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, {
            ...DEPS,
            autoApplyNumberMatches: true,
        });
        expect(again).toMatchObject({ bound: 1 });
        expect(await positionOf(ORPHAN_422_ID)).toMatchObject({ season_number: 1, tmdb: null });
        // And an apply of the dismissed proposal is refused.
        await expect(
            applyAbsoluteNumberingProposal(sql, id422, 'tester', DEPS),
        ).rejects.toMatchObject({ code: 'already-resolved' });
    });
});

// ---------------------------------------------------------------------------
// Review hardening on the Sky Harbor fixture
// ---------------------------------------------------------------------------

const ORPHAN_422 = ORPHAN_422_ID;
const ORPHAN_423 = ORPHAN_423_ID;

/**
 * Fails the move (the pair's last step) of the given orphans. DDL takes no bind
 * parameters, so each choice spells its ids out: 422 is ...4005, 423 is ...4006.
 */
async function blockMoveOf(...episodeIds: string[]): Promise<void> {
    const both = episodeIds.includes(ORPHAN_422) && episodeIds.includes(ORPHAN_423);
    if (both) {
        await sql`
            CREATE FUNCTION test_block_reconcile_move() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.id IN ('00000000-0000-4000-a000-000000004005',
                              '00000000-0000-4000-a000-000000004006')
                   AND NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
                    RAISE EXCEPTION 'test: move blocked';
                END IF;
                RETURN NEW;
            END $$
        `;
    } else if (episodeIds[0] === ORPHAN_423) {
        await sql`
            CREATE FUNCTION test_block_reconcile_move() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.id = '00000000-0000-4000-a000-000000004006'
                   AND NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
                    RAISE EXCEPTION 'test: move blocked';
                END IF;
                RETURN NEW;
            END $$
        `;
    } else {
        throw new Error('blockMoveOf: unsupported choice');
    }
    await sql`
        CREATE TRIGGER test_block_reconcile_move
            BEFORE UPDATE ON media_items
            FOR EACH ROW EXECUTE FUNCTION test_block_reconcile_move()
    `;
}

/** The provider hands the ghost another TMDB id (a primary id cannot be rewritten in place). */
async function giveGhost422TmdbId(tmdbId: string): Promise<void> {
    await sql`DELETE FROM external_ids WHERE media_id = ${GHOST_422_ID} AND provider = 'tmdb'`;
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
        VALUES (${GHOST_422_ID}, 'tmdb', ${tmdbId}, 'episode', true, 'test-fixture')
    `;
}

describe('one-row-per-pair memory of dismissals and proposals', () => {
    async function proposalFor(episodeId: string, tmdb: string): Promise<{ id: string }> {
        const [row] = await sql<{ id: string }[]>`
            SELECT id FROM sync_quarantine
            WHERE provider = 'lumastra-reconcile-absolute'
              AND external_id = ${reconciliationPairKey(episodeId, tmdb)}
        `;
        return row;
    }

    const OFF = { ...DEPS, autoApplyNumberMatches: false };

    it('dismiss A, then a proposal B for the same episode, then A must stay blocked', async () => {
        await seedBaseFixture(sql);
        await sql`DELETE FROM media_items WHERE id = ${ORPHAN_423_ID}`;
        await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, OFF);
        const a = await proposalFor(ORPHAN_422, '9422');
        await dismissAbsoluteNumberingProposal(sql, a.id, 'tester');

        // The provider hands the episode a different identity: pair B.
        await giveGhost422TmdbId('9999');
        const proposedB = await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, OFF);
        expect(proposedB).toMatchObject({ proposed: 1 });
        expect(await proposalFor(ORPHAN_422, '9999')).toBeDefined();

        // ... and back: pair A is still blocked, B's proposal did not overwrite it.
        await giveGhost422TmdbId('9422');
        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);
        expect(detection).toBeNull();
        const [dismissed] = await sql<{ resolution: string | null }[]>`
            SELECT resolution FROM sync_quarantine WHERE id = ${a.id}
        `;
        expect(dismissed.resolution).toBe('dismissed');
    });

    it('an undo for another target of the same episode does not clear an earlier dismissal', async () => {
        await seedBaseFixture(sql);
        await sql`DELETE FROM media_items WHERE id = ${ORPHAN_423_ID}`;
        await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, OFF);
        const a = await proposalFor(ORPHAN_422, '9422');
        await dismissAbsoluteNumberingProposal(sql, a.id, 'tester');
        // Apply pair B (the ghost carries another id), then undo it.
        await giveGhost422TmdbId('9999');
        await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, {
            ...DEPS,
            autoApplyNumberMatches: true,
        });
        const [move] = await sql<{ id: string }[]>`
            SELECT id FROM episode_reconciliation_moves WHERE episode_id = ${ORPHAN_422}
        `;

        await undoReconciliationMove(sql, move.id, 'tester');

        const rows = await sql<{ external_id: string; resolution: string | null }[]>`
            SELECT external_id, resolution FROM sync_quarantine
            WHERE provider = 'lumastra-reconcile-absolute' AND external_id LIKE ${`${ORPHAN_422}:%`}
            ORDER BY external_id
        `;
        expect(rows).toEqual([
            { external_id: `${ORPHAN_422}:9422`, resolution: 'dismissed' },
            { external_id: `${ORPHAN_422}:9999`, resolution: 'dismissed' },
        ]);
    });

    it('never resurrects a resolved row: a reattached proposal stays resolved on the next sync', async () => {
        await seedBaseFixture(sql);
        await sql`DELETE FROM media_items WHERE id = ${ORPHAN_423_ID}`;
        await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, OFF);
        const a = await proposalFor(ORPHAN_422, '9422');
        await sql`
            UPDATE sync_quarantine SET resolved_at = NOW(), resolved_by = 'tester', resolution = 'reattached'
            WHERE id = ${a.id}
        `;

        const result = await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, OFF);

        expect(result).toBeNull();
        const [row] = await sql<{ resolution: string | null; resolved_at: Date | null }[]>`
            SELECT resolution, resolved_at FROM sync_quarantine WHERE id = ${a.id}
        `;
        expect(row.resolution).toBe('reattached');
        expect(row.resolved_at).not.toBeNull();
    });
});

describe('applyAbsoluteNumberingFix: settings are read under the lock', () => {
    it('a number-match detection is not applied once the setting is off', async () => {
        await seedBaseFixture(sql);
        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);

        const result = await applyAbsoluteNumberingFix(sql, detection!, {
            ...DEPS,
            autoApplyNumberMatches: false,
        });

        expect(result).toMatchObject({ bound: 0, skipped: 2 });
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ANY(${[ORPHAN_422, ORPHAN_423]})`,
        ).toHaveLength(0);
    });

    it('the real number key decides without a deps override', async () => {
        await seedBaseFixture(sql);
        const key = vi.spyOn(config, 'RECONCILE_AUTO_APPLY_NUMBER_MATCHES', 'get');

        key.mockReturnValue(false);
        const off = await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, DEPS);
        expect(off).toMatchObject({ bound: 0, proposed: 2 });

        key.mockReturnValue(true);
        const on = await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, DEPS);
        expect(on).toMatchObject({ bound: 2 });
    });

    it('reports what actually happened: ghosts merged away and rows moved, per applied pair', async () => {
        await seedBaseFixture(sql);
        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);
        await blockMoveOf(ORPHAN_423);

        const result = await applyAbsoluteNumberingFix(sql, detection!, APPLY);

        expect(result).toMatchObject({ bound: 1, skipped: 1, ghostsDeleted: 1, moved: 1 });
    });
});

describe('lifecycle hooks run once per applied pair and only after the commit', () => {
    it('run once per applied pair, when its data is already committed', async () => {
        await seedBaseFixture(sql);
        const seen: { keep: string; merge: string; committed: boolean }[] = [];
        vi.spyOn(MediaDeletionService, 'runMergeHooks').mockImplementation(
            async (_sql, keep, merge) => {
                const bound = await sql`
                    SELECT 1 FROM external_ids WHERE media_id = ${keep} AND provider = 'tmdb'
                `;
                seen.push({ keep, merge, committed: bound.length === 1 });
            },
        );
        const metadata = vi
            .spyOn(MediaLifecycleService, 'afterMetadataChanged')
            .mockResolvedValue(undefined);
        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);

        await applyAbsoluteNumberingFix(sql, detection!, APPLY);

        expect(seen).toEqual([
            { keep: ORPHAN_422, merge: GHOST_422_ID, committed: true },
            { keep: ORPHAN_423, merge: GHOST_423_ID, committed: true },
        ]);
        expect(metadata.mock.calls.map((c) => c[0])).toEqual([ORPHAN_422, ORPHAN_423]);
    });

    it('are not called when every pair aborts', async () => {
        await seedBaseFixture(sql);
        const merge = vi.spyOn(MediaDeletionService, 'runMergeHooks').mockResolvedValue(undefined);
        const metadata = vi
            .spyOn(MediaLifecycleService, 'afterMetadataChanged')
            .mockResolvedValue(undefined);
        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);
        await blockMoveOf(ORPHAN_422, ORPHAN_423);

        const result = await applyAbsoluteNumberingFix(sql, detection!, APPLY);

        expect(result).toMatchObject({ bound: 0, skipped: 2 });
        expect(merge).not.toHaveBeenCalled();
        expect(metadata).not.toHaveBeenCalled();
    });

    it('are not called when the outer transaction rolls back at commit', async () => {
        await seedBaseFixture(sql);
        const merge = vi.spyOn(MediaDeletionService, 'runMergeHooks').mockResolvedValue(undefined);
        const metadata = vi
            .spyOn(MediaLifecycleService, 'afterMetadataChanged')
            .mockResolvedValue(undefined);
        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);
        await sql`
            CREATE FUNCTION test_fail_reconcile_commit() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
                RAISE EXCEPTION 'test: commit refused';
            END $$
        `;
        await sql`
            CREATE CONSTRAINT TRIGGER test_fail_reconcile_commit
                AFTER INSERT ON episode_reconciliation_moves
                DEFERRABLE INITIALLY DEFERRED
                FOR EACH ROW EXECUTE FUNCTION test_fail_reconcile_commit()
        `;

        await expect(applyAbsoluteNumberingFix(sql, detection!, APPLY)).rejects.toThrow(
            /commit refused/,
        );

        expect(merge).not.toHaveBeenCalled();
        expect(metadata).not.toHaveBeenCalled();
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ANY(${[ORPHAN_422, ORPHAN_423]})`,
        ).toHaveLength(0);
        expect(
            await sql`SELECT 1 FROM episode_reconciliation_moves WHERE series_id = ${SERIES_ID}`,
        ).toHaveLength(0);
    });
});

describe('reserved connection: the SECOND processed pair fails', () => {
    it('rolls back to its savepoint only; the first pair stays committed', async () => {
        await seedBaseFixture(sql);
        const detection = await detectAbsoluteNumberingFix(sql, SERIES_ID);
        // 422 is processed first, 423 second (detection orders by episode number).
        expect(detection?.matches.map((m) => m.episodeId)).toEqual([ORPHAN_422, ORPHAN_423]);
        await blockMoveOf(ORPHAN_423);

        const reserved = await sql.reserve();
        let result;
        try {
            result = await applyAbsoluteNumberingFix(reserved, detection!, APPLY);
        } finally {
            reserved.release();
        }

        // With the old nested BEGIN, the failed second pair's ROLLBACK discarded
        // the first pair too.
        expect(result).toMatchObject({ bound: 1, skipped: 1 });
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ${ORPHAN_422} AND provider = 'tmdb'`,
        ).toHaveLength(1);
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ${ORPHAN_423} AND provider = 'tmdb'`,
        ).toHaveLength(0);
        const moves = await sql<{ episode_id: string }[]>`
            SELECT episode_id FROM episode_reconciliation_moves WHERE series_id = ${SERIES_ID}
        `;
        expect(moves.map((m) => m.episode_id)).toEqual([ORPHAN_422]);
        const [ghost] = await sql`SELECT id FROM media_items WHERE id = ${GHOST_423_ID}`;
        expect(ghost).toBeDefined();
    });
});

describe('undo hardening', () => {
    async function applyAndMove(episodeId: string): Promise<string> {
        await maybeAutoFixAbsoluteNumbering(sql, SERIES_ID, {
            ...DEPS,
            autoApplyNumberMatches: true,
        });
        const [row] = await sql<{ id: string }[]>`
            SELECT id FROM episode_reconciliation_moves WHERE episode_id = ${episodeId}
        `;
        return row.id;
    }

    it('refuses a locked episode', async () => {
        await seedBaseFixture(sql);
        const id = await applyAndMove(ORPHAN_422);
        await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${ORPHAN_422}`;

        await expect(undoReconciliationMove(sql, id, 'tester')).rejects.toMatchObject({
            code: 'locked',
        });

        const [move] = await sql<{ undone_at: Date | null }[]>`
            SELECT undone_at FROM episode_reconciliation_moves WHERE id = ${id}
        `;
        expect(move.undone_at).toBeNull();
    });

    it('answers busy when the series lock cannot be taken within the timeout, and writes nothing', async () => {
        await seedBaseFixture(sql);
        const id = await applyAndMove(ORPHAN_422);
        const holder = await sql.reserve();
        try {
            await holder`SELECT pg_advisory_lock(hashtext(${SERIES_ID})::bigint)`;

            await expect(
                undoReconciliationMove(sql, id, 'tester', { lockTimeout: '300ms' }),
            ).rejects.toMatchObject({ code: 'busy' });
        } finally {
            await holder`SELECT pg_advisory_unlock(hashtext(${SERIES_ID})::bigint)`;
            holder.release();
        }

        const [move] = await sql<{ undone_at: Date | null }[]>`
            SELECT undone_at FROM episode_reconciliation_moves WHERE id = ${id}
        `;
        expect(move.undone_at).toBeNull();
        // The move can be undone once the lock is free.
        await expect(undoReconciliationMove(sql, id, 'tester')).resolves.toMatchObject({
            episodeId: ORPHAN_422,
        });
    });

    it('restores the still_path the episode had before the apply', async () => {
        await seedBaseFixture(sql);
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
            VALUES (${ORPHAN_422}, 'tmdb', ${sql.json({ still_path: '/old-still.jpg', other: 1 })}, NOW())
        `;
        const id = await applyAndMove(ORPHAN_422);
        const [applied] = await sql<{ metadata: { still_path: string } }[]>`
            SELECT metadata FROM provider_metadata WHERE media_id = ${ORPHAN_422} AND provider = 'tmdb'
        `;
        expect(applied.metadata.still_path).toBe('/still422.jpg');

        await undoReconciliationMove(sql, id, 'tester');

        const [restored] = await sql<{ metadata: Record<string, unknown> }[]>`
            SELECT metadata FROM provider_metadata WHERE media_id = ${ORPHAN_422} AND provider = 'tmdb'
        `;
        expect(restored.metadata).toEqual({ still_path: '/old-still.jpg', other: 1 });
    });

    it('clears the still_path the apply added when there was none before', async () => {
        await seedBaseFixture(sql);
        const id = await applyAndMove(ORPHAN_422);

        await undoReconciliationMove(sql, id, 'tester');

        const rows = await sql<{ metadata: Record<string, unknown> }[]>`
            SELECT metadata FROM provider_metadata WHERE media_id = ${ORPHAN_422} AND provider = 'tmdb'
        `;
        expect(rows.every((r) => !('still_path' in r.metadata))).toBe(true);
    });

    it('re-derives the title from the file name when the title before the move was empty', async () => {
        await seedBaseFixture(sql);
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path)
            VALUES (${'/itest-undo/Sky Harbor - S01E422 - The Real File Title [WEBDL-720p].mkv'})
            RETURNING id
        `;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default) VALUES (${ORPHAN_422}, ${file.id}, true)`;
        const id = await applyAndMove(ORPHAN_422);
        await sql`UPDATE episode_reconciliation_moves SET prev_title = NULL WHERE id = ${id}`;

        try {
            await undoReconciliationMove(sql, id, 'tester');

            const [ep] = await sql<{ title: string }[]>`
                SELECT title FROM media_items WHERE id = ${ORPHAN_422}
            `;
            expect(ep.title).toBe('The Real File Title');
        } finally {
            await sql`DELETE FROM media_files WHERE id = ${file.id}`;
        }
    });

    it('answers episode-gone for a move whose episode was deleted; the audit row survives', async () => {
        await seedBaseFixture(sql);
        const id = await applyAndMove(ORPHAN_422);
        await sql`DELETE FROM media_items WHERE id = ${ORPHAN_422}`;

        await expect(undoReconciliationMove(sql, id, 'tester')).rejects.toMatchObject({
            code: 'episode-gone',
        });

        const [move] = await sql<{ episode_id: string | null }[]>`
            SELECT episode_id FROM episode_reconciliation_moves WHERE id = ${id}
        `;
        expect(move.episode_id).toBeNull();
    });
});
