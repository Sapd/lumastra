// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for coverage-grid.queries.ts
 *
 * Requires a running PostgreSQL test database (`lumastra_tests`) with the
 * media_item_stage_state table present (migration 16.2.0+).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { loadCoverageGridItems, loadCoverageGridSummary } from './coverage-grid.queries.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertMediaItem(
    sql: postgres.Sql,
    overrides: { title: string; media_type: string; created_at?: Date },
): Promise<string> {
    const id = crypto.randomUUID();
    if (overrides.created_at) {
        await sql`
            INSERT INTO media_items (id, title, media_type, status, created_at, updated_at)
            VALUES (
                ${id}::uuid, ${overrides.title}, ${overrides.media_type}, 'active',
                ${overrides.created_at}, ${overrides.created_at}
            )
        `;
    } else {
        await sql`
            INSERT INTO media_items (id, title, media_type, status)
            VALUES (${id}::uuid, ${overrides.title}, ${overrides.media_type}, 'active')
        `;
    }
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

describe('loadCoverageGridItems (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM media_items WHERE title LIKE 'coverage-grid-test-%'`;
    });

    it('returns items with their stage completion maps', async () => {
        const id = await insertMediaItem(sql, {
            title: 'coverage-grid-test-stages',
            media_type: 'movie',
        });
        await insertStageRow(sql, id, 'media-probe', 'completed');
        await insertStageRow(sql, id, 'tmdb-metadata-sync', 'pending');

        const items = await loadCoverageGridItems(sql, { limit: 100 });
        const item = items.find((i) => i.id === id);
        expect(item).toBeDefined();
        expect(item!.stage_completion['media-probe']).toBe('completed');
        expect(item!.stage_completion['tmdb-metadata-sync']).toBe('pending');
    });

    it('filters by mediaType', async () => {
        const movieId = await insertMediaItem(sql, {
            title: 'coverage-grid-test-movie',
            media_type: 'movie',
        });
        const tvId = await insertMediaItem(sql, {
            title: 'coverage-grid-test-tv',
            media_type: 'tv',
        });

        const items = await loadCoverageGridItems(sql, {
            mediaTypes: ['movie'],
            limit: 100,
        });
        const ids = items.map((i) => i.id);
        expect(ids).toContain(movieId);
        expect(ids).not.toContain(tvId);
    });

    it('incompleteOnly excludes fully-covered items', async () => {
        const completeId = await insertMediaItem(sql, {
            title: 'coverage-grid-test-complete',
            media_type: 'movie',
        });
        await insertStageRow(sql, completeId, 'media-probe', 'completed');

        const incompleteId = await insertMediaItem(sql, {
            title: 'coverage-grid-test-incomplete',
            media_type: 'movie',
        });
        await insertStageRow(sql, incompleteId, 'media-probe', 'pending');

        const items = await loadCoverageGridItems(sql, {
            incompleteOnly: true,
            limit: 100,
        });
        const ids = items.map((i) => i.id);
        expect(ids).toContain(incompleteId);
        expect(ids).not.toContain(completeId);
    });

    it('missingStage filters to items lacking a specific stage completion', async () => {
        const missingId = await insertMediaItem(sql, {
            title: 'coverage-grid-test-missing-stage',
            media_type: 'movie',
        });
        await insertStageRow(sql, missingId, 'image-sync', 'failed_permanent');

        const hasStageId = await insertMediaItem(sql, {
            title: 'coverage-grid-test-has-stage',
            media_type: 'movie',
        });
        await insertStageRow(sql, hasStageId, 'image-sync', 'completed');

        const items = await loadCoverageGridItems(sql, {
            missingStage: 'image-sync',
            limit: 100,
        });
        const ids = items.map((i) => i.id);
        expect(ids).toContain(missingId);
        expect(ids).not.toContain(hasStageId);
    });

    it('respects limit and offset pagination', async () => {
        for (let i = 0; i < 5; i++) {
            await insertMediaItem(sql, {
                title: `coverage-grid-test-page-${i}`,
                media_type: 'movie',
            });
        }

        const page1 = await loadCoverageGridItems(sql, { limit: 2, offset: 0 });
        const page2 = await loadCoverageGridItems(sql, { limit: 2, offset: 2 });

        expect(page1.length).toBeLessThanOrEqual(2);
        expect(page2.length).toBeLessThanOrEqual(2);

        const page1Ids = page1.map((i) => i.id);
        const page2Ids = page2.map((i) => i.id);
        const overlap = page1Ids.filter((id) => page2Ids.includes(id));
        expect(overlap).toHaveLength(0);
    });

    it('returns empty stage_completion for items with no stage rows', async () => {
        const id = await insertMediaItem(sql, {
            title: 'coverage-grid-test-nostage',
            media_type: 'movie',
        });

        const items = await loadCoverageGridItems(sql, { limit: 100 });
        const item = items.find((i) => i.id === id);
        expect(item).toBeDefined();
        expect(item!.stage_completion).toEqual({});
    });
});

// Keyset cursor pagination (opt-in, additive). `media_items.created_at` is
// `NOT NULL`, so there is no null-group carry case to cover here (Gate D2b
// n/a — sort key is non-nullable).
describe('loadCoverageGridItems keyset cursor (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM media_items WHERE title LIKE 'coverage-grid-cursor-test-%'`;
    });

    it('cursor page continues where the previous page left off (cursor==offset parity)', async () => {
        // 5 items, strictly decreasing added_at (created_at). Dated a few
        // minutes into the future so these rows are guaranteed the newest in
        // the (shared, cross-test) media_items table — a plain `limit: 2`
        // fetch can then only ever return OUR rows, regardless of what other
        // tests/suites have left behind.
        const base = Date.now() + 10 * 60 * 1000;
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
            const id = await insertMediaItem(sql, {
                title: `coverage-grid-cursor-test-${i}`,
                media_type: 'movie',
                created_at: new Date(base - i * 1000),
            });
            ids.push(id);
        }

        // Canonical full ordering via a single large-limit (no-cursor) fetch.
        const full = await loadCoverageGridItems(sql, { limit: 10 });
        const fullOurs = full.filter((r) => ids.includes(r.id));
        expect(fullOurs.map((r) => r.id)).toEqual(ids);

        const page1 = await loadCoverageGridItems(sql, { limit: 2 });
        const page1Ours = page1.filter((r) => ids.includes(r.id));
        expect(page1Ours.map((r) => r.id)).toEqual(ids.slice(0, 2));

        const last1 = page1Ours[page1Ours.length - 1];
        expect(last1.added_at_cursor).toBeDefined();
        const page2 = await loadCoverageGridItems(sql, {
            limit: 2,
            cursor: { addedAt: last1.added_at_cursor!, id: last1.id },
        });
        const page2Ours = page2.filter((r) => ids.includes(r.id));
        expect(page2Ours.map((r) => r.id)).toEqual(ids.slice(2, 4));

        const last2 = page2Ours[page2Ours.length - 1];
        const page3 = await loadCoverageGridItems(sql, {
            limit: 2,
            cursor: { addedAt: last2.added_at_cursor!, id: last2.id },
        });
        const page3Ours = page3.filter((r) => ids.includes(r.id));
        expect(page3Ours.map((r) => r.id)).toEqual(ids.slice(4, 5));

        // No overlap across pages.
        const seen = [...page1Ours, ...page2Ours, ...page3Ours].map((r) => r.id);
        expect(new Set(seen).size).toBe(seen.length);
    });

    it('ignores offset when a cursor is present', async () => {
        const base = Date.now() + 20 * 60 * 1000;
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
            const id = await insertMediaItem(sql, {
                title: `coverage-grid-cursor-test-ofs-${i}`,
                media_type: 'movie',
                created_at: new Date(base - i * 1000),
            });
            ids.push(id);
        }

        const page1 = await loadCoverageGridItems(sql, { limit: 1 });
        const first = page1.find((r) => ids.includes(r.id))!;
        expect(first.id).toBe(ids[0]);

        // A non-zero offset alongside a cursor must be ignored — the cursor
        // predicate alone determines the position.
        const page2 = await loadCoverageGridItems(sql, {
            limit: 1,
            offset: 50,
            cursor: { addedAt: first.added_at_cursor!, id: first.id },
        });
        const second = page2.find((r) => ids.includes(r.id))!;
        expect(second.id).toBe(ids[1]);
    });

    it('the id tiebreak resolves ties on an identical added_at without skip or duplicate', async () => {
        // Two rows sharing the exact same created_at (e.g. a bulk scanner
        // insert within one transaction, where now() is fixed per-tx). Dated
        // into the future so these are guaranteed the two newest rows overall
        // (see parity test above for why).
        const tiedAt = new Date(Date.now() + 10 * 60 * 1000);
        const idA = await insertMediaItem(sql, {
            title: 'coverage-grid-cursor-test-tie-a',
            media_type: 'movie',
            created_at: tiedAt,
        });
        const idB = await insertMediaItem(sql, {
            title: 'coverage-grid-cursor-test-tie-b',
            media_type: 'movie',
            created_at: tiedAt,
        });

        const page1 = await loadCoverageGridItems(sql, { limit: 1 });
        const first = page1[0];
        expect([idA, idB]).toContain(first.id);
        expect(first.added_at_cursor).toBeDefined();

        const page2 = await loadCoverageGridItems(sql, {
            limit: 1,
            cursor: { addedAt: first.added_at_cursor!, id: first.id },
        });
        const second = page2[0];
        // The other tied row must surface next — never re-served, never skipped.
        const other = first.id === idA ? idB : idA;
        expect(second.id).toBe(other);
    });
});

describe('loadCoverageGridSummary (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM media_items WHERE title LIKE 'cov-summary-test-%'`;
    });

    it('counts stage rows by status bucket', async () => {
        const id = await insertMediaItem(sql, {
            title: 'cov-summary-test-item',
            media_type: 'movie',
        });
        await insertStageRow(sql, id, 'stage-a', 'completed');
        await insertStageRow(sql, id, 'stage-b', 'pending');
        await insertStageRow(sql, id, 'stage-c', 'running');
        await insertStageRow(sql, id, 'stage-d', 'failed_permanent');
        await insertStageRow(sql, id, 'stage-e', 'skipped_permanent');
        await insertStageRow(sql, id, 'stage-f', 'obsolete');

        const summary = await loadCoverageGridSummary(sql, {});
        expect(summary.total).toBeGreaterThanOrEqual(1);
        expect(summary.completed).toBeGreaterThanOrEqual(1);
        expect(summary.pending).toBeGreaterThanOrEqual(1);
        expect(summary.in_progress).toBeGreaterThanOrEqual(1);
        expect(summary.failed).toBeGreaterThanOrEqual(1);
        expect(summary.skipped).toBeGreaterThanOrEqual(1);
        expect(summary.obsolete).toBeGreaterThanOrEqual(1);
    });

    it('filters summary by mediaType', async () => {
        const movieId = await insertMediaItem(sql, {
            title: 'cov-summary-test-movie',
            media_type: 'movie',
        });
        await insertStageRow(sql, movieId, 'stage-x', 'completed');

        const tvId = await insertMediaItem(sql, {
            title: 'cov-summary-test-tv',
            media_type: 'tv',
        });
        await insertStageRow(sql, tvId, 'stage-x', 'pending');

        const movieSummary = await loadCoverageGridSummary(sql, {
            mediaTypes: ['movie'],
        });
        const tvSummary = await loadCoverageGridSummary(sql, {
            mediaTypes: ['tv'],
        });

        expect(movieSummary.pending).toBeLessThan(tvSummary.pending + 1);
    });

    // Fresh install 2026-10-06: every processing stage done, yet the admin drawer
    // said "Library processing · 61 of 75" because integrity-file-present rows
    // wait `pending` for the integrity scanner's next 6-hourly run. A scheduled
    // check's unchecked rows are not work; its verdicts still count.
    describe('scheduled-check stages', () => {
        const CHECK = 'integrity-file-present';

        async function fullyProcessedItem(title: string): Promise<string> {
            const id = await insertMediaItem(sql, { title, media_type: 'movie' });
            await insertStageRow(sql, id, 'media-probe-a', 'completed');
            await insertStageRow(sql, id, 'trickplay-generation', 'skipped_permanent');
            return id;
        }

        it('leaves unchecked integrity rows out of every count, total included', async () => {
            const id = await fullyProcessedItem('cov-summary-test-check-pending');
            await insertStageRow(sql, id, CHECK, 'pending');

            const summary = await loadCoverageGridSummary(sql, {
                search: 'cov-summary-test-check-pending',
            });
            expect(summary).toEqual({
                total: 2,
                completed: 1,
                in_progress: 0,
                failed: 0,
                pending: 0,
                skipped: 1,
                obsolete: 0,
            });
        });

        it('the unfiltered (drawer) query leaves them out too', async () => {
            const before = await loadCoverageGridSummary(sql, {});
            const id = await fullyProcessedItem('cov-summary-test-check-unfiltered');
            await insertStageRow(sql, id, CHECK, 'pending');
            const after = await loadCoverageGridSummary(sql, {});

            expect(after.total - before.total).toBe(2);
            expect(after.completed - before.completed).toBe(1);
            expect(after.skipped - before.skipped).toBe(1);
            expect(after.pending - before.pending).toBe(0);
            expect(after.in_progress - before.in_progress).toBe(0);
        });

        it('leaves a check row out while a scan has it running', async () => {
            const id = await fullyProcessedItem('cov-summary-test-check-running');
            await insertStageRow(sql, id, CHECK, 'running');

            const summary = await loadCoverageGridSummary(sql, {
                search: 'cov-summary-test-check-running',
            });
            expect(summary.total).toBe(2);
            expect(summary.in_progress).toBe(0);
        });

        it('still counts the check verdicts: completed and a missing file', async () => {
            const ok = await fullyProcessedItem('cov-summary-test-check-verdict-ok');
            await insertStageRow(sql, ok, CHECK, 'completed');
            const missing = await fullyProcessedItem('cov-summary-test-check-verdict-missing');
            await insertStageRow(sql, missing, CHECK, 'failed_permanent');

            const summary = await loadCoverageGridSummary(sql, {
                search: 'cov-summary-test-check-verdict',
            });
            expect(summary.total).toBe(6);
            expect(summary.completed).toBe(3);
            expect(summary.failed).toBe(1);
            expect(summary.pending).toBe(0);
        });

        describe('grid filters agree with the summary', () => {
            let checkOnly: string;
            let realWork: string;

            beforeEach(async () => {
                // All processing done; only the integrity scan has not reached it.
                checkOnly = await fullyProcessedItem('cov-summary-test-filter-check-only');
                await insertStageRow(sql, checkOnly, CHECK, 'pending');
                // Real work left, plus the same unchecked integrity row.
                realWork = await insertMediaItem(sql, {
                    title: 'cov-summary-test-filter-real-work',
                    media_type: 'movie',
                });
                await insertStageRow(sql, realWork, 'media-probe-a', 'pending');
                await insertStageRow(sql, realWork, CHECK, 'pending');
            });

            it('incompleteOnly: an unchecked integrity row alone is not incomplete', async () => {
                const filter = { incompleteOnly: true, search: 'cov-summary-test-filter-' };
                const items = await loadCoverageGridItems(sql, filter);
                expect(items.map((i) => i.id)).toEqual([realWork]);

                // Only realWork's rows, and of those only the real pending one.
                const summary = await loadCoverageGridSummary(sql, filter);
                expect(summary.total).toBe(1);
                expect(summary.pending).toBe(1);
            });

            it('missingStage = the check stage: its unchecked rows ARE what was asked for', async () => {
                const filter = { missingStage: CHECK, search: 'cov-summary-test-filter-' };
                const items = await loadCoverageGridItems(sql, filter);
                expect(items.map((i) => i.id).sort()).toEqual([checkOnly, realWork].sort());

                const summary = await loadCoverageGridSummary(sql, filter);
                // checkOnly: completed + skipped + pending check; realWork: 2 pending.
                expect(summary.total).toBe(5);
                expect(summary.pending).toBe(3);
            });

            it('missingStage = the check stage with incompleteOnly: both items count', async () => {
                const filter = {
                    missingStage: CHECK,
                    incompleteOnly: true,
                    search: 'cov-summary-test-filter-',
                };
                const items = await loadCoverageGridItems(sql, filter);
                expect(items).toHaveLength(2);

                // The summary covers the same two items as the grid.
                const summary = await loadCoverageGridSummary(sql, filter);
                expect(summary.total).toBe(5);
                expect(summary.pending).toBe(3);
            });

            it('missingStage = a processing stage with incompleteOnly: the check row is still not work', async () => {
                const filter = {
                    missingStage: 'media-probe-a',
                    incompleteOnly: true,
                    search: 'cov-summary-test-filter-',
                };
                const items = await loadCoverageGridItems(sql, filter);
                expect(items.map((i) => i.id)).toEqual([realWork]);

                const summary = await loadCoverageGridSummary(sql, filter);
                expect(summary.total).toBe(1);
                expect(summary.pending).toBe(1);
            });
        });

        it('still counts pending rows of real processing stages', async () => {
            const id = await insertMediaItem(sql, {
                title: 'cov-summary-test-check-real-pending',
                media_type: 'movie',
            });
            await insertStageRow(sql, id, 'media-probe-a', 'pending');
            await insertStageRow(sql, id, CHECK, 'pending');

            const summary = await loadCoverageGridSummary(sql, {
                search: 'cov-summary-test-check-real-pending',
            });
            expect(summary.total).toBe(1);
            expect(summary.pending).toBe(1);
        });
    });
});
