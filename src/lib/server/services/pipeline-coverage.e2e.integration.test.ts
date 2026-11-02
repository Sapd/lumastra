// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { MediaLifecycleService } from '$lib/server/services/media-lifecycle.service.js';
import { findRowsByItem } from '$lib/server/database/queries/stage-state.queries.js';
import { registry, setTestRegistry } from '$lib/server/tasks/registry.js';
import { loadBuiltins, _resetLoadedForTests } from '$lib/server/tasks/builtin/index.js';

// Prevent the real TaskOrchestrator/BullMQ workers from booting when
// MediaLifecycleService.afterCreated() calls getOrchestratorStartRun().
// This test only verifies stage-state seeding (media_item_stage_state rows),
// not actual job enqueueing — so startRun must be a no-op.
// The vi.mock factory is hoisted by Vitest before any imports are resolved.
const startRunMock = vi.fn().mockResolvedValue({ runId: 'mock-run-id', deduped: false });
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: {
        startRun: (...args: unknown[]) => startRunMock(...args),
        getQueueDepths: vi.fn().mockResolvedValue({}),
        stop: vi.fn().mockResolvedValue(undefined),
    },
}));

describe('pipeline-coverage end-to-end smoke', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
        _resetLoadedForTests();
        await loadBuiltins();
        setTestRegistry(registry);
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`TRUNCATE media_item_stage_state CASCADE`;
        await sql`DELETE FROM media_file_items WHERE media_item_id IN (SELECT id FROM media_items WHERE title LIKE 'e2e-smoke-%')`;
        await sql`DELETE FROM media_files WHERE file_path LIKE '/e2e-smoke/%'`;
        await sql`DELETE FROM media_items WHERE title LIKE 'e2e-smoke-%'`;
    });

    it('a freshly created movie gets pending rows for every applicable stage', async () => {
        const id = await insertMovie(sql);
        await MediaLifecycleService.afterCreated(id, 'e2e-smoke');

        const rows = await findRowsByItem(sql, id);
        const stageIds = new Set(rows.map((r) => r.stage_id));
        const byStage = Object.fromEntries(rows.map((r) => [r.stage_id, r.status]));

        expect(stageIds.has('media-probe-a')).toBe(true);
        expect(stageIds.has('media-probe-b')).toBe(true);
        expect(stageIds.has('trickplay-params-sync')).toBe(true);
        expect(stageIds.has('tmdb-metadata-sync')).toBe(true);
        expect(stageIds.has('metadata-update')).toBe(true);
        expect(stageIds.has('library-embeddings')).toBe(true);
        expect(stageIds.has('discovery-embeddings')).toBe(true);
        expect(stageIds.has('image-sync')).toBe(true);
        expect(stageIds.has('mdblist-sync')).toBe(true);
        expect(stageIds.has('integrity-file-present')).toBe(true);

        expect(stageIds.has('music-analysis')).toBe(false);
        expect(stageIds.has('lumastra-intro-analyzer:visual')).toBe(true);
        expect(stageIds.has('series-sync')).toBe(false);
        // chapter-sync now appliesTo ['series','movie'] (no eligibilityPredicate) → seeded pending for movies
        expect(stageIds.has('chapter-sync')).toBe(true);
        expect(stageIds.has('music-embedding-generation')).toBe(false);
        expect(stageIds.has('music-popularity')).toBe(false);

        // Unified eligibility contract: probe-gated stages (eligibility.sql, no
        // appliesTo) seed PENDING — seed never writes skipped_permanent for a
        // probe-derived reason. The first sweep dispose pass demotes the still-
        // ineligible ones (no video stream yet) to skipped_permanent/'ineligible';
        // this seed-only smoke test does not run a sweep, so they are pending here.
        expect(byStage['media-probe-b']).toBe('pending');
        expect(byStage['trickplay-params-sync']).toBe('pending');
        expect(byStage['lumastra-intro-analyzer:visual']).toBe('pending');
        expect(byStage['chapter-sync']).toBe('pending');
        expect(byStage['media-probe-a']).toBe('pending');
        expect(byStage['library-embeddings']).toBe('pending');
        expect(byStage['discovery-embeddings']).toBe('pending');
        expect(byStage['tmdb-metadata-sync']).toBe('pending');
        expect(byStage['metadata-update']).toBe('pending');
        expect(byStage['image-sync']).toBe('pending');
        expect(byStage['mdblist-sync']).toBe('pending');
        expect(byStage['integrity-file-present']).toBe('pending');
    });

    it('a freshly created audio-only track classifies stages correctly', async () => {
        const id = await insertTrack(sql);
        await MediaLifecycleService.afterCreated(id, 'e2e-smoke');

        const rows = await findRowsByItem(sql, id);
        const stageIds = new Set(rows.map((r) => r.stage_id));
        const byStage = Object.fromEntries(rows.map((r) => [r.stage_id, r.status]));

        expect(stageIds.has('media-probe-a')).toBe(true);
        expect(stageIds.has('music-analysis')).toBe(true);
        expect(stageIds.has('music-embedding-generation')).toBe(true);
        // music-popularity is artist-only now (commit fe48c10e6) — not seeded for tracks
        expect(stageIds.has('music-popularity')).toBe(false);
        expect(stageIds.has('integrity-file-present')).toBe(true);

        expect(stageIds.has('media-probe-b')).toBe(false);
        expect(stageIds.has('trickplay-params-sync')).toBe(false);
        expect(stageIds.has('lumastra-intro-analyzer:visual')).toBe(false);
        expect(stageIds.has('tmdb-metadata-sync')).toBe(false);
        expect(stageIds.has('library-embeddings')).toBe(false);
        expect(stageIds.has('discovery-embeddings')).toBe(false);

        // Probe-gated music stages seed PENDING under the unified contract (no
        // audio stream yet → the sweep dispose pass demotes them later; not run here).
        expect(byStage['media-probe-a']).toBe('pending');
        expect(byStage['music-analysis']).toBe('pending');
        expect(byStage['music-embedding-generation']).toBe('pending');
        expect(byStage['integrity-file-present']).toBe('pending');
    });

    it('a freshly created episode has video and intro-analyzer stages', async () => {
        const id = await insertEpisode(sql);
        await MediaLifecycleService.afterCreated(id, 'e2e-smoke');

        const rows = await findRowsByItem(sql, id);
        const stageIds = new Set(rows.map((r) => r.stage_id));
        const byStage = Object.fromEntries(rows.map((r) => [r.stage_id, r.status]));

        expect(stageIds.has('media-probe-a')).toBe(true);
        expect(stageIds.has('media-probe-b')).toBe(true);
        expect(stageIds.has('trickplay-params-sync')).toBe(true);
        // Only the VISUAL half is seeded per episode; the acoustic half is
        // season-scoped and derives eligibility from row absence.
        expect(stageIds.has('lumastra-intro-analyzer:visual')).toBe(true);
        expect(stageIds.has('lumastra-intro-analyzer:acoustic')).toBe(false);
        // tmdb-metadata-sync + metadata-update are movie/series-only — not seeded for episodes
        expect(stageIds.has('tmdb-metadata-sync')).toBe(false);
        expect(stageIds.has('metadata-update')).toBe(false);
        // library-embeddings is movie/series-level, not seeded per-episode
        expect(stageIds.has('library-embeddings')).toBe(false);
        expect(stageIds.has('image-sync')).toBe(true);
        expect(stageIds.has('integrity-file-present')).toBe(true);

        expect(stageIds.has('discovery-embeddings')).toBe(false);
        expect(stageIds.has('mdblist-sync')).toBe(false);
        expect(stageIds.has('series-sync')).toBe(false);
        expect(stageIds.has('music-analysis')).toBe(false);
        expect(stageIds.has('music-popularity')).toBe(false);

        // Probe-gated stages seed PENDING under the unified contract (no video
        // stream yet → the sweep dispose pass demotes them later; not run here).
        expect(byStage['media-probe-b']).toBe('pending');
        expect(byStage['trickplay-params-sync']).toBe('pending');
        expect(byStage['lumastra-intro-analyzer:visual']).toBe('pending');
        expect(byStage['media-probe-a']).toBe('pending');
        expect(byStage['image-sync']).toBe('pending');
        expect(byStage['integrity-file-present']).toBe('pending');
    });
});

// Give the item a default file LINK but no media_streams: has_file=true (so
// media-probe-a / file-link-gated stages are eligible -> pending). Under the
// unified eligibility contract, probe-b / trickplay / music-analysis (eligibility.sql,
// no appliesTo) ALSO seed pending — seed never tombstones for a probe-derived reason;
// the first sweep dispose pass demotes the still-ineligible ones to
// skipped_permanent/'ineligible'. This seed-only smoke test asserts the seed state
// (all pending), not the post-sweep state.
async function linkBareFile(sql: postgres.Sql, mediaItemId: string): Promise<void> {
    const fileId = crypto.randomUUID();
    await sql`INSERT INTO media_files (id, file_path) VALUES (${fileId}::uuid, ${'/e2e-smoke/' + fileId.slice(0, 8) + '.mkv'})`;
    await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order) VALUES (${fileId}::uuid, ${mediaItemId}::uuid, true, 0)`;
}

async function insertMovie(sql: postgres.Sql): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, media_type, title)
        VALUES (${id}::uuid, 'movie', ${'e2e-smoke-' + id.slice(0, 6)})
    `;
    await linkBareFile(sql, id);
    return id;
}

async function insertTrack(sql: postgres.Sql): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, media_type, title)
        VALUES (${id}::uuid, 'track', ${'e2e-smoke-' + id.slice(0, 6)})
    `;
    await linkBareFile(sql, id);
    return id;
}

async function insertEpisode(sql: postgres.Sql): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, media_type, title)
        VALUES (${id}::uuid, 'episode', ${'e2e-smoke-' + id.slice(0, 6)})
    `;
    await linkBareFile(sql, id);
    return id;
}
