// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for ingest-map.queries.ts
 *
 * Requires a running PostgreSQL test database (`lumastra_tests`) with the
 * media_item_stage_state table present (migration 16.2.0+).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    loadIngestMap,
    loadIngestMapSummaryBuckets,
    loadStageProgressByIds,
    loadIngestPipelineSummary,
    loadStuckItems,
    countReidentifyItems,
    loadReidentifyQueue,
    loadErrorGroups,
} from './ingest-map.queries.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertMediaItem(
    sql: postgres.Sql,
    overrides: { title: string; media_type: string; created_at?: Date },
): Promise<string> {
    const id = crypto.randomUUID();
    const createdAt = overrides.created_at ?? new Date();
    await sql`
        INSERT INTO media_items (id, title, media_type, status, created_at, updated_at)
        VALUES (
            ${id}::uuid,
            ${overrides.title},
            ${overrides.media_type},
            'active',
            ${createdAt},
            ${createdAt}
        )
    `;
    return id;
}

async function insertStageRow(
    sql: postgres.Sql,
    mediaItemId: string,
    stageId: string,
    status: string,
): Promise<void> {
    await sql`
        INSERT INTO media_item_stage_state
            (media_item_id, stage_id, processing_version, status, attempt, updated_at)
        VALUES
            (${mediaItemId}::uuid, ${stageId}, 1, ${status}, 0, now())
        ON CONFLICT (media_item_id, stage_id) DO NOTHING
    `;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadIngestMap (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM scheduler_state WHERE task_id LIKE 'ingest-map-test-stuck-%' OR task_id = 'lumastra-intro-analyzer'`;
        await sql`DELETE FROM media_items WHERE title LIKE 'ingest-map-test-%'`;
    });

    it('returns items created within the window', async () => {
        const recentId = await insertMediaItem(sql, {
            title: 'ingest-map-test-recent',
            media_type: 'movie',
        });

        const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000);
        const _oldId = await insertMediaItem(sql, {
            title: 'ingest-map-test-old',
            media_type: 'movie',
            created_at: oldDate,
        });

        const results = await loadIngestMap(sql, {
            windowSinceMs: 24 * 60 * 60 * 1000,
        });
        const ids = results.map((r) => r.media_item_id);
        expect(ids).toContain(recentId);
        expect(ids).not.toContain(_oldId);
    });

    it('includes old items that have in-flight stage rows', async () => {
        const oldDate = new Date(Date.now() - 72 * 60 * 60 * 1000);
        const oldId = await insertMediaItem(sql, {
            title: 'ingest-map-test-inflight',
            media_type: 'movie',
            created_at: oldDate,
        });
        await insertStageRow(sql, oldId, 'tmdb-metadata-sync', 'running');

        const results = await loadIngestMap(sql, {
            windowSinceMs: 24 * 60 * 60 * 1000,
        });
        const ids = results.map((r) => r.media_item_id);
        expect(ids).toContain(oldId);
    });

    it('joins stage rows onto each item', async () => {
        const id = await insertMediaItem(sql, {
            title: 'ingest-map-test-stages',
            media_type: 'movie',
        });
        await insertStageRow(sql, id, 'media-probe', 'completed');
        await insertStageRow(sql, id, 'tmdb-metadata-sync', 'pending');

        const results = await loadIngestMap(sql, {
            windowSinceMs: 24 * 60 * 60 * 1000,
        });
        const item = results.find((r) => r.media_item_id === id);
        expect(item).toBeDefined();
        expect(item!.stages).toHaveLength(2);
        const stageIds = item!.stages.map((s) => s.stage_id);
        expect(stageIds).toContain('media-probe');
        expect(stageIds).toContain('tmdb-metadata-sync');
    });

    it('filters by mediaType', async () => {
        const movieId = await insertMediaItem(sql, {
            title: 'ingest-map-test-movie-type',
            media_type: 'movie',
        });
        const tvId = await insertMediaItem(sql, {
            title: 'ingest-map-test-tv-type',
            media_type: 'tv',
        });

        const results = await loadIngestMap(sql, {
            windowSinceMs: 24 * 60 * 60 * 1000,
            mediaTypes: ['movie'],
        });
        const ids = results.map((r) => r.media_item_id);
        expect(ids).toContain(movieId);
        expect(ids).not.toContain(tvId);
    });

    it('respects the limit cap', async () => {
        for (let i = 0; i < 5; i++) {
            await insertMediaItem(sql, {
                title: `ingest-map-test-limit-${i}`,
                media_type: 'movie',
            });
        }

        const results = await loadIngestMap(sql, {
            windowSinceMs: 24 * 60 * 60 * 1000,
            limit: 2,
        });
        expect(results.length).toBeLessThanOrEqual(2);
    });

    it('returns empty stages array for items with no stage rows', async () => {
        const id = await insertMediaItem(sql, {
            title: 'ingest-map-test-nostage',
            media_type: 'movie',
        });

        const results = await loadIngestMap(sql, {
            windowSinceMs: 24 * 60 * 60 * 1000,
        });
        const item = results.find((r) => r.media_item_id === id);
        expect(item).toBeDefined();
        expect(item!.stages).toEqual([]);
    });

    it('resolves series_title + season/episode numbers for episodes', async () => {
        // Build series → season → episode hierarchy. The query walks
        // parent_id twice to get from episode back to the series row.
        const seriesId = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, created_at, updated_at)
            VALUES (
                ${seriesId}::uuid,
                'ingest-map-test-series-Haus des Geldes',
                'tv', 'active', now(), now()
            )
        `;
        const seasonId = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (
                id, title, media_type, status,
                parent_id, season_number, created_at, updated_at
            )
            VALUES (
                ${seasonId}::uuid,
                'ingest-map-test-season-1',
                'season', 'active',
                ${seriesId}::uuid, 1, now(), now()
            )
        `;
        const episodeId = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (
                id, title, media_type, status,
                parent_id, season_number, episode_number, created_at, updated_at
            )
            VALUES (
                ${episodeId}::uuid,
                'ingest-map-test-episode-Folge 22',
                'episode', 'active',
                ${seasonId}::uuid, 1, 22, now(), now()
            )
        `;

        const results = await loadIngestMap(sql, {
            windowSinceMs: 24 * 60 * 60 * 1000,
        });
        const episode = results.find((r) => r.media_item_id === episodeId);
        expect(episode).toBeDefined();
        expect(episode!.series_title).toBe('ingest-map-test-series-Haus des Geldes');
        expect(episode!.season_number).toBe(1);
        expect(episode!.episode_number).toBe(22);

        // Cleanup the extra rows we manually inserted (the beforeEach only
        // wipes rows whose title starts with `ingest-map-test-`, which our
        // series + season titles do — but season's own row has a different
        // prefix `ingest-map-test-season-`, also covered. Just for safety:
        await sql`DELETE FROM media_items WHERE id = ANY(${[
            seriesId,
            seasonId,
            episodeId,
        ]}::uuid[])`;
    });

    it('resolves series_title for a season row (one-hop parent walk)', async () => {
        // A season's own row is one parent_id hop from the series (season →
        // series), unlike an episode's two hops (episode → season →
        // series). Before the fix, the query's season/series JOIN pair only
        // fired `AND ci.media_type = 'episode'`, so a season row itself
        // never resolved series_title — it rendered as a bare "Season 1"
        // with no way to tell which show it belonged to.
        const seriesId = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, created_at, updated_at)
            VALUES (
                ${seriesId}::uuid,
                'ingest-map-test-series-Haus des Geldes',
                'tv', 'active', now(), now()
            )
        `;
        const seasonId = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (
                id, title, media_type, status,
                parent_id, season_number, created_at, updated_at
            )
            VALUES (
                ${seasonId}::uuid,
                'ingest-map-test-season-1',
                'season', 'active',
                ${seriesId}::uuid, 1, now(), now()
            )
        `;

        const results = await loadIngestMap(sql, {
            windowSinceMs: 24 * 60 * 60 * 1000,
        });
        const season = results.find((r) => r.media_item_id === seasonId);
        expect(season).toBeDefined();
        expect(season!.series_title).toBe('ingest-map-test-series-Haus des Geldes');
        expect(season!.season_number).toBe(1);

        await sql`DELETE FROM media_items WHERE id = ANY(${[seriesId, seasonId]}::uuid[])`;
    });

    it('excludes is_dismissed items from the map', async () => {
        // Dismissed items have no active pipeline — `afterDismissed` deletes
        // their stage rows — and would otherwise render as zero-stage trains
        // parked at the first station, polluting the live view.
        const activeId = await insertMediaItem(sql, {
            title: 'ingest-map-test-active-track',
            media_type: 'track',
        });
        const dismissedId = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, is_dismissed, created_at, updated_at)
            VALUES (
                ${dismissedId}::uuid,
                'ingest-map-test-dismissed-track',
                'track', 'active', true, now(), now()
            )
        `;

        const results = await loadIngestMap(sql, {
            windowSinceMs: 24 * 60 * 60 * 1000,
        });
        const ids = results.map((r) => r.media_item_id);
        expect(ids).toContain(activeId);
        expect(ids).not.toContain(dismissedId);

        await sql`DELETE FROM media_items WHERE id = ${dismissedId}::uuid`;
    });

    it('returns null series_title for non-episodes', async () => {
        const movieId = await insertMediaItem(sql, {
            title: 'ingest-map-test-movie-no-parent',
            media_type: 'movie',
        });

        const results = await loadIngestMap(sql, {
            windowSinceMs: 24 * 60 * 60 * 1000,
        });
        const movie = results.find((r) => r.media_item_id === movieId);
        expect(movie).toBeDefined();
        expect(movie!.series_title).toBeNull();
        expect(movie!.season_number).toBeNull();
        expect(movie!.episode_number).toBeNull();
    });
});

describe('loadStuckItems (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM scheduler_state WHERE task_id LIKE 'ingest-map-test-stuck-%' OR task_id = 'lumastra-intro-analyzer'`;
        await sql`DELETE FROM media_items WHERE title LIKE 'ingest-map-test-%'`;
    });

    it('resolves the parent series title for a stuck season', async () => {
        const seriesId = crypto.randomUUID();
        const seasonId = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, created_at, updated_at)
            VALUES (${seriesId}::uuid, 'ingest-map-test-series-stuck', 'tv', 'active', now(), now())
        `;
        await sql`
            INSERT INTO media_items (
                id, title, media_type, status, parent_id, season_number, created_at, updated_at
            )
            VALUES (
                ${seasonId}::uuid, 'ingest-map-test-season-stuck', 'season', 'active',
                ${seriesId}::uuid, 1, now(), now()
            )
        `;
        await sql`
            INSERT INTO media_item_stage_state
                (media_item_id, stage_id, processing_version, status, attempt, updated_at)
            VALUES (${seasonId}::uuid, 'tmdb-metadata-sync', 1, 'pending', 3, now() - interval '3 hours')
        `;

        const rows = await loadStuckItems(sql, 100);
        const season = rows.find((row) => row.media_item_id === seasonId);

        expect(season?.series_title).toBe('ingest-map-test-series-stuck');
        expect(season?.reason).toBe('attempt_threshold');
    });

    it('reports the dormant-pending branch only after 30 minutes and excludes recent completion and future unpaused schedules', async () => {
        const candidates = [
            ['31m', '31m'],
            ['29m', '29m'],
            ['scheduled', 'scheduled'],
            ['recent-completion', 'recent'],
        ] as const;
        const ids = new Map<string, string>();
        for (const [label] of candidates) {
            const id = crypto.randomUUID();
            ids.set(label, id);
            await sql`
                INSERT INTO media_items (id, title, media_type, status, created_at, updated_at)
                VALUES (${id}::uuid, ${'ingest-map-test-stuck-' + label}, 'movie', 'active', now(), now())
            `;
        }
        const [overThresholdId, underThresholdId, scheduledId, recentCompletionId] = candidates.map(
            ([label]) => ids.get(label)!,
        );
        const introVisualId = crypto.randomUUID();
        const introAcousticId = crypto.randomUUID();
        for (const [id, label] of [
            [introVisualId, 'intro-visual'],
            [introAcousticId, 'intro-acoustic'],
        ] as const) {
            await sql`
                INSERT INTO media_items (id, title, media_type, status, created_at, updated_at)
                VALUES (${id}::uuid, ${'ingest-map-test-stuck-' + label}, 'movie', 'active', now(), now())
            `;
        }
        const scheduledStage = `ingest-map-test-stuck-${crypto.randomUUID()}`;
        const recentStage = `ingest-map-test-stuck-${crypto.randomUUID()}`;
        await sql`
            INSERT INTO media_item_stage_state
                (media_item_id, stage_id, processing_version, status, attempt, updated_at)
            VALUES
                (${overThresholdId}::uuid, 'ingest-map-test-stage-31m', 1, 'pending', 0, now() - interval '31 minutes'),
                (${underThresholdId}::uuid, 'ingest-map-test-stage-29m', 1, 'pending', 0, now() - interval '29 minutes'),
                (${scheduledId}::uuid, ${scheduledStage}, 1, 'pending', 0, now() - interval '31 minutes'),
                (${recentCompletionId}::uuid, ${recentStage}, 1, 'pending', 0, now() - interval '31 minutes'),
                (${introVisualId}::uuid, 'lumastra-intro-analyzer:visual', 1, 'pending', 0, now() - interval '31 minutes'),
                (${introAcousticId}::uuid, 'lumastra-intro-analyzer:acoustic', 1, 'pending', 0, now() - interval '31 minutes')
        `;
        await sql`
            INSERT INTO scheduler_state (task_id, last_fired_at, next_fire_at, paused, paused_by, paused_at)
            VALUES (${scheduledStage}, NULL, now() + interval '1 hour', false, NULL, NULL)
        `;
        await sql`
            INSERT INTO scheduler_state (task_id, last_fired_at, next_fire_at, paused, paused_by, paused_at)
            VALUES ('lumastra-intro-analyzer', NULL, now() + interval '1 hour', false, NULL, NULL)
        `;
        const completionId = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, created_at, updated_at)
            VALUES (${completionId}::uuid, 'ingest-map-test-stuck-completed', 'movie', 'active', now(), now())
        `;
        await sql`
            INSERT INTO media_item_stage_state
                (media_item_id, stage_id, processing_version, status, attempt, updated_at, completed_at)
            VALUES (${completionId}::uuid, ${recentStage}, 1, 'completed', 0, now(), now() - interval '1 minute')
        `;

        const rows = await loadStuckItems(sql, 1000);
        const byId = new Map(rows.map((row) => [row.media_item_id, row]));

        expect(byId.get(overThresholdId)?.reason).toBe('pending_dormant');
        expect(byId.has(underThresholdId)).toBe(false);
        expect(byId.has(scheduledId)).toBe(false);
        expect(byId.has(recentCompletionId)).toBe(false);
        expect(byId.has(introVisualId)).toBe(false);
        expect(byId.has(introAcousticId)).toBe(false);

        // Registered intro-analyzer schedules cover both split stage IDs. A
        // paused future schedule must not suppress either dormant stage.
        await sql`
            UPDATE scheduler_state
            SET paused = true
            WHERE task_id = 'lumastra-intro-analyzer'
        `;
        const pausedRows = await loadStuckItems(sql, 1000);
        const pausedById = new Map(pausedRows.map((row) => [row.media_item_id, row]));
        expect(pausedById.get(introVisualId)?.reason).toBe('pending_dormant');
        expect(pausedById.get(introAcousticId)?.reason).toBe('pending_dormant');

        // An unpaused schedule whose next fire time has passed also leaves
        // the split stages eligible for the dormant-pending diagnostic.
        await sql`
            UPDATE scheduler_state
            SET paused = false, next_fire_at = now() - interval '1 minute'
            WHERE task_id = 'lumastra-intro-analyzer'
        `;
        const pastScheduleRows = await loadStuckItems(sql, 1000);
        const pastScheduleById = new Map(pastScheduleRows.map((row) => [row.media_item_id, row]));
        expect(pastScheduleById.get(introVisualId)?.reason).toBe('pending_dormant');
        expect(pastScheduleById.get(introAcousticId)?.reason).toBe('pending_dormant');
    });

    it('keeps the original branch priority when one running row also reaches the attempt threshold', async () => {
        const itemId = await insertMediaItem(sql, {
            title: 'ingest-map-test-stuck-priority',
            media_type: 'movie',
        });
        await sql`
            INSERT INTO media_item_stage_state
                (media_item_id, stage_id, processing_version, status, attempt, updated_at)
            VALUES (${itemId}::uuid, 'ingest-map-test-stage-priority', 1, 'running', 3, now() - interval '20 minutes')
        `;

        const row = (await loadStuckItems(sql, 1000)).find((item) => item.media_item_id === itemId);
        expect(row?.reason).toBe('running_stale');
    });
});

// Keyset cursor pagination (opt-in, additive). `media_items.created_at` is
// `NOT NULL`, so there is no null-group carry case to cover here (Gate D2b
// n/a — sort key is non-nullable).
describe('loadIngestMap keyset cursor (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM media_items WHERE title LIKE 'ingest-map-test-cursor-%'`;
    });

    const WINDOW = 24 * 60 * 60 * 1000;

    it('cursor page continues where the previous page left off (cursor==offset parity)', async () => {
        // 5 items, strictly decreasing created_at so ordering is deterministic.
        // Dated a few minutes into the future so these 5 rows are guaranteed
        // the newest in the (shared, cross-test) media_items table — a plain
        // `limit: 2` fetch can then only ever return OUR rows, regardless of
        // what other tests/suites have left behind.
        const base = Date.now() + 10 * 60 * 1000;
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
            const id = await insertMediaItem(sql, {
                title: `ingest-map-test-cursor-${i}`,
                media_type: 'movie',
                created_at: new Date(base - i * 1000),
            });
            ids.push(id);
        }

        // Canonical full ordering via a single large-limit (no-cursor) fetch.
        const full = await loadIngestMap(sql, { windowSinceMs: WINDOW, limit: 10 });
        const fullOurs = full.filter((r) => ids.includes(r.media_item_id));
        expect(fullOurs.map((r) => r.media_item_id)).toEqual(ids);

        // Walk the same set two pages at a time via the keyset cursor and
        // confirm it reproduces the exact same order with no skip/duplicate.
        const page1 = await loadIngestMap(sql, { windowSinceMs: WINDOW, limit: 2 });
        const page1Ours = page1.filter((r) => ids.includes(r.media_item_id));
        expect(page1Ours.map((r) => r.media_item_id)).toEqual(ids.slice(0, 2));

        const last1 = page1Ours[page1Ours.length - 1];
        expect(last1.created_at_cursor).toBeDefined();
        const page2 = await loadIngestMap(sql, {
            windowSinceMs: WINDOW,
            limit: 2,
            cursor: { createdAt: last1.created_at_cursor!, id: last1.media_item_id },
        });
        const page2Ours = page2.filter((r) => ids.includes(r.media_item_id));
        expect(page2Ours.map((r) => r.media_item_id)).toEqual(ids.slice(2, 4));

        const last2 = page2Ours[page2Ours.length - 1];
        const page3 = await loadIngestMap(sql, {
            windowSinceMs: WINDOW,
            limit: 2,
            cursor: { createdAt: last2.created_at_cursor!, id: last2.media_item_id },
        });
        const page3Ours = page3.filter((r) => ids.includes(r.media_item_id));
        expect(page3Ours.map((r) => r.media_item_id)).toEqual(ids.slice(4, 5));

        // No overlap across pages.
        const seen = [...page1Ours, ...page2Ours, ...page3Ours].map((r) => r.media_item_id);
        expect(new Set(seen).size).toBe(seen.length);
    });

    it('the id tiebreak resolves ties on an identical created_at without skip or duplicate', async () => {
        // Two rows sharing the exact same created_at (e.g. a bulk scanner
        // insert within one transaction, where now() is fixed per-tx). Dated
        // into the future so these are guaranteed the two newest rows overall
        // (see parity test above for why).
        const tiedAt = new Date(Date.now() + 10 * 60 * 1000);
        const idA = await insertMediaItem(sql, {
            title: 'ingest-map-test-cursor-tie-a',
            media_type: 'movie',
            created_at: tiedAt,
        });
        const idB = await insertMediaItem(sql, {
            title: 'ingest-map-test-cursor-tie-b',
            media_type: 'movie',
            created_at: tiedAt,
        });

        const page1 = await loadIngestMap(sql, { windowSinceMs: WINDOW, limit: 1 });
        const first = page1[0];
        expect([idA, idB]).toContain(first.media_item_id);
        expect(first.created_at_cursor).toBeDefined();

        const page2 = await loadIngestMap(sql, {
            windowSinceMs: WINDOW,
            limit: 1,
            cursor: { createdAt: first.created_at_cursor!, id: first.media_item_id },
        });
        const second = page2[0];
        // The other tied row must surface next — never re-served, never skipped.
        const other = first.media_item_id === idA ? idB : idA;
        expect(second.media_item_id).toBe(other);
    });
});

describe('loadIngestMapSummaryBuckets (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM media_items WHERE title LIKE 'summary-bucket-test-%'`;
    });

    it('counts tvchannel items into the livetv bucket', async () => {
        await insertMediaItem(sql, {
            title: 'summary-bucket-test-channel-1',
            media_type: 'tvchannel',
        });
        await insertMediaItem(sql, {
            title: 'summary-bucket-test-channel-2',
            media_type: 'tvchannel',
        });

        const results = await loadIngestMapSummaryBuckets(sql, {
            windowSinceMs: 24 * 60 * 60 * 1000,
        });
        const livetv = results.find((r) => r.bucket_id === 'livetv');
        expect(livetv).toBeDefined();
        expect(livetv!.total).toBeGreaterThanOrEqual(2);
        expect(livetv!.recent).toBeGreaterThanOrEqual(2);
    });

    it('counts non-pipeline non-livetv items into the other bucket', async () => {
        await insertMediaItem(sql, {
            title: 'summary-bucket-test-extra',
            media_type: 'extra',
        });
        await insertMediaItem(sql, {
            title: 'summary-bucket-test-home',
            media_type: 'home_video',
        });
        // Old row — counts toward total but not recent.
        await insertMediaItem(sql, {
            title: 'summary-bucket-test-old-training',
            media_type: 'training',
            created_at: new Date(Date.now() - 48 * 60 * 60 * 1000),
        });

        const results = await loadIngestMapSummaryBuckets(sql, {
            windowSinceMs: 24 * 60 * 60 * 1000,
        });
        const other = results.find((r) => r.bucket_id === 'other');
        expect(other).toBeDefined();
        expect(other!.total).toBeGreaterThanOrEqual(3);
        expect(other!.recent).toBeGreaterThanOrEqual(2);
        // The 48h-old training row counts toward total but not recent.
        expect(other!.total).toBeGreaterThan(other!.recent);
    });

    it('does NOT count pipeline media types (movie/tv/episode/track) into any bucket', async () => {
        await insertMediaItem(sql, {
            title: 'summary-bucket-test-movie',
            media_type: 'movie',
        });
        await insertMediaItem(sql, {
            title: 'summary-bucket-test-tv',
            media_type: 'tv',
        });

        const beforeResults = await loadIngestMapSummaryBuckets(sql, {
            windowSinceMs: 24 * 60 * 60 * 1000,
        });
        const livetvBefore = beforeResults.find((r) => r.bucket_id === 'livetv')!.total;
        const otherBefore = beforeResults.find((r) => r.bucket_id === 'other')!.total;

        // Re-query; movie+tv inserts above must not have moved either count.
        const afterResults = await loadIngestMapSummaryBuckets(sql, {
            windowSinceMs: 24 * 60 * 60 * 1000,
        });
        expect(afterResults.find((r) => r.bucket_id === 'livetv')!.total).toBe(livetvBefore);
        expect(afterResults.find((r) => r.bucket_id === 'other')!.total).toBe(otherBefore);
    });

    it('returns one entry per defined bucket', async () => {
        const results = await loadIngestMapSummaryBuckets(sql, {
            windowSinceMs: 24 * 60 * 60 * 1000,
        });
        const ids = results.map((r) => r.bucket_id).sort();
        expect(ids).toEqual(['livetv', 'other']);
    });
});

describe('loadStageProgressByIds (integration)', () => {
    let sql: postgres.Sql;
    const STAGE = 'ingest-map-test-progress-stage';

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM media_items WHERE title LIKE 'ingest-map-test-%'`;
    });

    it('denominates in eligible items — skipped_permanent is not_applicable, not remaining', async () => {
        // 3 completed, 2 in-flight (pending/running), 1 skipped_transient (retries),
        // 5 skipped_permanent (not applicable — e.g. no video track).
        const mk = async (status: string) => {
            const id = await insertMediaItem(sql, {
                title: `ingest-map-test-${crypto.randomUUID()}`,
                media_type: 'movie',
            });
            await insertStageRow(sql, id, STAGE, status);
        };
        for (const s of [
            'completed',
            'completed',
            'completed',
            'pending',
            'running',
            'skipped_transient',
            'skipped_permanent',
            'skipped_permanent',
            'skipped_permanent',
            'skipped_permanent',
            'skipped_permanent',
        ]) {
            await mk(s);
        }

        const [row] = await loadStageProgressByIds(sql, [STAGE]);
        expect(row).toBeDefined();
        expect(row.completed).toBe(3);
        // pending + running + skipped_transient all count as remaining
        expect(row.remaining).toBe(3);
        expect(row.not_applicable).toBe(5);
        expect(row.total).toBe(11);
        // The load-bearing assertion: eligible denominator = completed + remaining
        // (= 6), NOT total (11). 3/6 = 50% "done", not 3/11 = 27% "done forever".
        expect(row.completed + row.remaining).toBe(6);
    });

    it('counts failed_transient and failed_permanent correctly — transient inside remaining, permanent excluded from denominator', async () => {
        // 2 completed, 1 pending, 2 failed_transient, 3 failed_permanent, 1 skipped_permanent
        // failed_transient counts inside remaining (will retry)
        // failed_permanent is excluded from both completed and remaining (excluded from denominator)
        // skipped_permanent is not_applicable
        const mk = async (status: string) => {
            const id = await insertMediaItem(sql, {
                title: `ingest-map-test-${crypto.randomUUID()}`,
                media_type: 'movie',
            });
            await insertStageRow(sql, id, STAGE, status);
        };
        for (const s of [
            'completed',
            'completed',
            'pending',
            'failed_transient',
            'failed_transient',
            'failed_permanent',
            'failed_permanent',
            'failed_permanent',
            'skipped_permanent',
        ]) {
            await mk(s);
        }

        const [row] = await loadStageProgressByIds(sql, [STAGE]);
        expect(row).toBeDefined();
        expect(row.failed_transient).toBe(2);
        expect(row.failed_permanent).toBe(3);
        // failed_transient is counted inside remaining (pending + failed_transient = 3)
        expect(row.remaining).toBe(3);
        // failed_permanent is not counted in completed
        expect(row.completed).toBe(2);
        // failed_permanent is not counted in not_applicable (skipped_permanent only)
        expect(row.not_applicable).toBe(1);
        // total = all 9 rows
        expect(row.total).toBe(9);
        // eligible denominator = completed + remaining = 5 (failed_permanent excluded)
        expect(row.completed + row.remaining).toBe(5);
        // sanity: completed + remaining + not_applicable + failed_permanent = total
        expect(row.completed + row.remaining + row.not_applicable + row.failed_permanent).toBe(
            row.total,
        );
    });

    it('returns no row for a stage with no state rows', async () => {
        const rows = await loadStageProgressByIds(sql, ['ingest-map-test-nonexistent-stage']);
        expect(rows).toEqual([]);
    });

    it('returns [] for an empty stageIds list (no query)', async () => {
        expect(await loadStageProgressByIds(sql, [])).toEqual([]);
    });
});

// admin-ia redesign, step:pipeline — `reidentifyItems` must be a STRICT
// SUBSET of `deadLetterItems` counting only the non-retryable failures (the
// exact predicate `countReidentifyItems` uses, so the pipeline page's
// HealthStrip chip can never disagree with Library → Fix matches / the
// attention system's count for the same population — spec §5 "one source
// of truth").
describe('loadIngestPipelineSummary (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM media_items WHERE title LIKE 'pipeline-summary-test-%'`;
    });

    async function insertStageRowWithError(
        mediaItemId: string,
        stageId: string,
        status: string,
        retryable: boolean,
    ): Promise<void> {
        await sql`
            INSERT INTO media_item_stage_state
                (media_item_id, stage_id, processing_version, status, attempt, last_error, updated_at)
            VALUES
                (${mediaItemId}::uuid, ${stageId}, 1, ${status}, 3,
                 ${sql.json({ message: 'boom', retryable, ...(retryable === false ? { remediation: 'identity' } : {}) })}, now())
            ON CONFLICT (media_item_id, stage_id) DO NOTHING
        `;
    }

    /** A re-identify row is a BROKEN match: the item (or its series) was matched once. */
    async function markMatched(mediaItemId: string, mediaType = 'movie'): Promise<void> {
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
            VALUES (${mediaItemId}::uuid, 'tmdb',
                    ${String(90_000_000 + Math.floor(Math.random() * 9_000_000))},
                    ${mediaType}, true)
        `;
    }

    it('reidentifyItems counts only non-retryable failed_permanent rows, not the broader deadLetterItems population', async () => {
        // Non-retryable permanent failure (e.g. a dead TMDB id) — counts
        // toward BOTH deadLetterItems and reidentifyItems.
        const reidentifyId = await insertMediaItem(sql, {
            title: 'pipeline-summary-test-reidentify',
            media_type: 'movie',
        });
        await markMatched(reidentifyId);
        await insertStageRowWithError(
            reidentifyId,
            'tmdb-metadata-sync',
            'failed_permanent',
            false,
        );

        // Retryable failure that merely exhausted its retry budget (e.g. a
        // corrupt trickplay source file) — counts toward deadLetterItems
        // ONLY, never toward reidentifyItems.
        const exhaustedId = await insertMediaItem(sql, {
            title: 'pipeline-summary-test-exhausted',
            media_type: 'movie',
        });
        await insertStageRowWithError(
            exhaustedId,
            'trickplay-generation',
            'failed_permanent',
            true,
        );

        const summary = await loadIngestPipelineSummary(sql);
        expect(summary.deadLetterItems).toBeGreaterThanOrEqual(2);
        expect(summary.reidentifyItems).toBeGreaterThanOrEqual(1);
        // The exhausted-but-retryable item must not have inflated reidentifyItems
        // by more than the one genuinely-non-retryable item.
        expect(summary.reidentifyItems).toBeLessThan(summary.deadLetterItems);
    });

    it('excludes dismissed items from reidentifyItems', async () => {
        const dismissedId = await insertMediaItem(sql, {
            title: 'pipeline-summary-test-dismissed',
            media_type: 'movie',
        });
        await markMatched(dismissedId);
        await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${dismissedId}::uuid`;
        await insertStageRowWithError(dismissedId, 'tmdb-metadata-sync', 'failed_permanent', false);

        const before = await loadIngestPipelineSummary(sql);

        const undismissedId = await insertMediaItem(sql, {
            title: 'pipeline-summary-test-undismissed',
            media_type: 'movie',
        });
        await markMatched(undismissedId);
        await insertStageRowWithError(
            undismissedId,
            'tmdb-metadata-sync',
            'failed_permanent',
            false,
        );

        const after = await loadIngestPipelineSummary(sql);
        // Only the undismissed row should have moved the needle.
        expect(after.reidentifyItems).toBe(before.reidentifyItems + 1);
    });

    it('a dismissed item moves none of the header counts (they match the lists)', async () => {
        const before = await loadIngestPipelineSummary(sql);
        const dismissedId = await insertMediaItem(sql, {
            title: 'pipeline-summary-test-dismissed-dead',
            media_type: 'movie',
        });
        await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${dismissedId}::uuid`;
        await insertStageRowWithError(dismissedId, 'tmdb-metadata-sync', 'failed_permanent', false);

        const after = await loadIngestPipelineSummary(sql);
        expect(after.deadLetterItems).toBe(before.deadLetterItems);
        expect(after.inFlight).toBe(before.inFlight);
        expect(after.failedLastHour).toBe(before.failedLastHour);
    });

    // Fix matches: an item that was NEVER matched belongs to the "Never matched"
    // view only. Listing it under "Broken match" too put the same title in both
    // views with no way to tell which one to act in.
    it('leaves never-matched items (no external id on the item or its series) out of the queue', async () => {
        const before = await countReidentifyItems(sql);
        const neverId = await insertMediaItem(sql, {
            title: 'pipeline-summary-test-never-matched',
            media_type: 'movie',
        });
        await insertStageRowWithError(neverId, 'tmdb-metadata-sync', 'failed_permanent', false);

        expect(await countReidentifyItems(sql)).toBe(before);
        expect((await loadIngestPipelineSummary(sql)).reidentifyItems).toBe(
            await countReidentifyItems(sql),
        );
        const queue = await loadReidentifyQueue(sql, { limit: 500, offset: 0 });
        expect(queue.some((r) => r.media_item_id === neverId)).toBe(false);
    });

    it('resolves a failed season to its matched series and filters by title and type', async () => {
        const seriesId = await insertMediaItem(sql, {
            title: 'pipeline-summary-test-series-auris',
            media_type: 'tv',
        });
        await markMatched(seriesId, 'tv');
        const seasonId = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, parent_id, season_number)
            VALUES (${seasonId}::uuid, 'pipeline-summary-test-season-1', 'season', 'active',
                    ${seriesId}::uuid, 1)
        `;
        await insertStageRowWithError(seasonId, 'season-poster', 'failed_permanent', false);
        const movieId = await insertMediaItem(sql, {
            title: 'pipeline-summary-test-movie-gladiator',
            media_type: 'movie',
        });
        await markMatched(movieId);
        await insertStageRowWithError(movieId, 'tmdb-metadata-sync', 'failed_permanent', false);

        const bySeriesTitle = await loadReidentifyQueue(sql, {
            limit: 50,
            offset: 0,
            search: 'series-auris',
        });
        expect(bySeriesTitle.map((r) => r.media_item_id)).toEqual([seasonId]);
        expect(bySeriesTitle[0].series_id).toBe(seriesId);
        expect(bySeriesTitle[0].series_title).toBe('pipeline-summary-test-series-auris');

        const seriesOnly = await loadReidentifyQueue(sql, {
            limit: 500,
            offset: 0,
            search: 'pipeline-summary-test',
            mediaType: 'series',
        });
        expect(seriesOnly.map((r) => r.media_item_id)).toEqual([seasonId]);
        expect(
            await countReidentifyItems(sql, {
                search: 'pipeline-summary-test',
                mediaType: 'movie',
            }),
        ).toBe(1);
    });
});

describe('loadErrorGroups (integration)', () => {
    let sql: postgres.Sql;
    const STAGE = 'error-groups-test-stage';

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await sql`DELETE FROM media_items WHERE title LIKE 'error-groups-test-%'`;
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM media_items WHERE title LIKE 'error-groups-test-%'`;
    });

    it('messages that differ only in a long number share one group', async () => {
        for (const [i, message] of [
            'TMDB returned 404 for id 12345',
            'TMDB returned 404 for id 678901',
        ].entries()) {
            const id = await insertMediaItem(sql, {
                title: `error-groups-test-${i}`,
                media_type: 'movie',
            });
            await sql`
                INSERT INTO media_item_stage_state
                    (media_item_id, stage_id, processing_version, status, attempt, last_error, updated_at)
                VALUES (${id}::uuid, ${STAGE}, 1, 'failed_permanent', 3, ${sql.json({ message })}, now())
            `;
        }

        const groups = (await loadErrorGroups(sql, 1000)).filter((g) => g.stage_id === STAGE);

        expect(groups).toHaveLength(1);
        expect(groups[0].count).toBe(2);
        expect(groups[0].fingerprint).toBe('TMDB returned 404 for id <n>');
    });
});
