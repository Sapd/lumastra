// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for stage-sweep.queries.ts
 *
 * Requires a running PostgreSQL test database (`lumastra_tests`) with the
 * media_item_stage_state table present (migration 16.2.0+).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
    getTestDatabaseUrl,
} from '../../../../../tests/integration/setup/test-database.js';
import {
    findSweepCandidates,
    findItemsMissingCoverage,
    findItemsMissingStageRow,
    countSweepBacklog,
    reEnrollMisSkippedStage,
    findSkippedPermanentByReasons,
} from './stage-sweep.queries.js';

// The two per-stage heals were replaced by the generic `reEnrollMisSkippedStage`
// rail + declarative `sqlEligibilityMirror`/`reEnrollReasons` on each stage.
// These shims preserve the original test API; the inline mirrors mirror the
// stage declarations (library-embeddings-task.ts / lumastra-intro-analyzer.ts).
// Both heal describes run once per plan shape: default, hash-join and
// late-filter (the eligibility fragment as a join filter). A plan hint must
// never change which rows are re-enrolled.
const HEAL_PLANS: ReadonlyArray<[string, { hashJoin: boolean; lateFilter: boolean }]> = [
    ['default', { hashJoin: false, lateFilter: false }],
    ['hashJoin', { hashJoin: true, lateFilter: false }],
    ['lateFilter', { hashJoin: false, lateFilter: true }],
];
let healPlan = { hashJoin: false, lateFilter: false };
function reEnrollMisSkippedLibraryEmbeddings(sql: postgres.Sql, limit: number): Promise<number> {
    return reEnrollMisSkippedStage(sql, {
        stageId: 'library-embeddings',
        eligibleWhere: sql`
            mi.media_type IN ('movie', 'tv')
            AND mi.has_files
            AND NOT EXISTS (
                SELECT 1 FROM media_embeddings emb
                 WHERE emb.media_id = mi.id AND emb.source = 'library'
            )
        `,
        reasons: [
            'ineligible-by-legacy-filter',
            'no-file-linked',
            'predicate-false',
            'predicate-false-on-invalidation',
        ],
        limit,
        ...healPlan,
    });
}
function reEnrollMisSkippedIntroAnalyzer(sql: postgres.Sql, limit: number): Promise<number> {
    return reEnrollMisSkippedStage(sql, {
        stageId: 'lumastra-intro-analyzer',
        eligibleWhere: sql`
            mi.media_type = 'episode'
            AND EXISTS (
                SELECT 1 FROM media_file_items mfi
                  JOIN media_files mf ON mf.id = mfi.file_id
                 WHERE mfi.media_item_id = mi.id AND mf.file_path IS NOT NULL
            )
            AND EXISTS (
                SELECT 1 FROM media_file_items mfi
                  JOIN media_streams ms ON ms.file_id = mfi.file_id
                 WHERE mfi.media_item_id = mi.id AND ms.stream_type = 'video'
            )
            AND COALESCE(mi.runtime_seconds, 0) > 60
        `,
        reasons: [
            'predicate-false',
            'predicate-false-on-invalidation',
            'season-has-no-analyzable-episodes',
        ],
        limit,
        ...healPlan,
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertMediaItem(
    sql: postgres.Sql,
    overrides: { title: string; media_type?: string; is_dismissed?: boolean },
): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status, is_dismissed)
        VALUES (
            ${id}::uuid,
            ${overrides.title},
            ${overrides.media_type ?? 'movie'},
            'active',
            ${overrides.is_dismissed ?? false}
        )
    `;
    return id;
}

interface StageRowInput {
    status: string;
    attempt?: number;
    nextEligibleAt?: Date | null;
    updatedAt?: Date;
}

async function insertStageRow(
    sql: postgres.Sql,
    mediaItemId: string,
    stageId: string,
    input: StageRowInput,
): Promise<void> {
    await sql`
        INSERT INTO media_item_stage_state
            (media_item_id, stage_id, processing_version, status, attempt,
             next_eligible_at, updated_at)
        VALUES (
            ${mediaItemId}::uuid,
            ${stageId},
            1,
            ${input.status},
            ${input.attempt ?? 0},
            ${input.nextEligibleAt ?? null},
            ${input.updatedAt ?? new Date()}
        )
        ON CONFLICT (media_item_id, stage_id) DO UPDATE
           SET status = EXCLUDED.status,
               attempt = EXCLUDED.attempt,
               next_eligible_at = EXCLUDED.next_eligible_at,
               updated_at = EXCLUDED.updated_at
    `;
}

/**
 * Coverage queries intentionally scan the whole catalog before applying LIMIT.
 * A unique stage id does not isolate them: every unrelated item also lacks that
 * stage. Use the migrated columns, defaults and indexes on one
 * private connection so fixtures from other files cannot crowd out our rows.
 * Temporary tables shadow the public tables, including inside sql.begin().
 */
async function createCoverageTestDb(healIndexOnly = false): Promise<postgres.Sql> {
    const sql = postgres(getTestDatabaseUrl(), { max: 1, onnotice: () => {} });
    try {
        await sql`CREATE TEMP TABLE media_items (LIKE public.media_items INCLUDING ALL)`;
        await sql`CREATE TEMP TABLE media_item_stage_state
            (LIKE public.media_item_stage_state INCLUDING ALL
                ${healIndexOnly ? sql`EXCLUDING INDEXES` : sql``})`;
        if (healIndexOnly) {
            // Disabling seqscan alone does not force a particular index. Keep
            // only the real heal index so primary-key/other-index costs cannot
            // change which plan this test exercises as shared DB stats change.
            const [index] = await sql<{ ddl: string }[]>`
                SELECT pg_get_indexdef('public.idx_stage_state_skipped_heal'::regclass) AS ddl
            `;
            await sql.unsafe(
                index.ddl.replace(
                    ' ON public.media_item_stage_state ',
                    ' ON pg_temp.media_item_stage_state ',
                ),
            );
        }
        return sql;
    } catch (error) {
        await sql.end();
        throw error;
    }
}

// Unique stage id per test run so concurrent test sessions don't collide.
const STAGE_ID = `sweep-test-${Math.random().toString(36).slice(2, 10)}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findSweepCandidates (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM media_items WHERE title LIKE 'sweep-test-%'`;
    });

    it('returns only rows in the four sweepable statuses', async () => {
        const itemPending = await insertMediaItem(sql, {
            title: 'sweep-test-pending',
        });
        const itemFailedTransient = await insertMediaItem(sql, {
            title: 'sweep-test-failed-t',
        });
        const itemSkippedTransient = await insertMediaItem(sql, {
            title: 'sweep-test-skipped-t',
        });
        const itemObsolete = await insertMediaItem(sql, {
            title: 'sweep-test-obsolete',
        });
        const itemRunning = await insertMediaItem(sql, {
            title: 'sweep-test-running',
        });
        const itemCompleted = await insertMediaItem(sql, {
            title: 'sweep-test-completed',
        });
        const itemFailedPerm = await insertMediaItem(sql, {
            title: 'sweep-test-failed-p',
        });
        const itemSkippedPerm = await insertMediaItem(sql, {
            title: 'sweep-test-skipped-p',
        });

        await insertStageRow(sql, itemPending, STAGE_ID, { status: 'pending' });
        await insertStageRow(sql, itemFailedTransient, STAGE_ID, {
            status: 'failed_transient',
        });
        await insertStageRow(sql, itemSkippedTransient, STAGE_ID, {
            status: 'skipped_transient',
        });
        await insertStageRow(sql, itemObsolete, STAGE_ID, {
            status: 'obsolete',
        });
        await insertStageRow(sql, itemRunning, STAGE_ID, { status: 'running' });
        await insertStageRow(sql, itemCompleted, STAGE_ID, {
            status: 'completed',
        });
        await insertStageRow(sql, itemFailedPerm, STAGE_ID, {
            status: 'failed_permanent',
        });
        await insertStageRow(sql, itemSkippedPerm, STAGE_ID, {
            status: 'skipped_permanent',
        });

        const rows = await findSweepCandidates(sql, STAGE_ID, 100);
        const ids = rows.map((r) => r.media_item_id);
        expect(ids).toEqual(
            expect.arrayContaining([
                itemPending,
                itemFailedTransient,
                itemSkippedTransient,
                itemObsolete,
            ]),
        );
        expect(ids).not.toContain(itemRunning);
        expect(ids).not.toContain(itemCompleted);
        expect(ids).not.toContain(itemFailedPerm);
        expect(ids).not.toContain(itemSkippedPerm);
    });

    it('filters out rows whose next_eligible_at is in the future', async () => {
        const itemReady = await insertMediaItem(sql, {
            title: 'sweep-test-ready',
        });
        const itemWaiting = await insertMediaItem(sql, {
            title: 'sweep-test-waiting',
        });
        const itemPast = await insertMediaItem(sql, {
            title: 'sweep-test-past',
        });

        const future = new Date(Date.now() + 60 * 60_000); // +1h
        const past = new Date(Date.now() - 60 * 60_000); // -1h

        await insertStageRow(sql, itemReady, STAGE_ID, {
            status: 'failed_transient',
            nextEligibleAt: null,
        });
        await insertStageRow(sql, itemWaiting, STAGE_ID, {
            status: 'failed_transient',
            nextEligibleAt: future,
        });
        await insertStageRow(sql, itemPast, STAGE_ID, {
            status: 'failed_transient',
            nextEligibleAt: past,
        });

        const ids = (await findSweepCandidates(sql, STAGE_ID, 100)).map((r) => r.media_item_id);
        expect(ids).toEqual(expect.arrayContaining([itemReady, itemPast]));
        expect(ids).not.toContain(itemWaiting);
    });

    it('excludes rows for soft-dismissed media items', async () => {
        const alive = await insertMediaItem(sql, { title: 'sweep-test-alive' });
        const dismissed = await insertMediaItem(sql, {
            title: 'sweep-test-dismissed',
            is_dismissed: true,
        });

        await insertStageRow(sql, alive, STAGE_ID, { status: 'pending' });
        await insertStageRow(sql, dismissed, STAGE_ID, { status: 'pending' });

        const ids = (await findSweepCandidates(sql, STAGE_ID, 100)).map((r) => r.media_item_id);
        expect(ids).toContain(alive);
        expect(ids).not.toContain(dismissed);
    });

    it('orders FIFO respecting backoff: next_eligible_at ASC NULLS FIRST, then updated_at ASC', async () => {
        // Three items. Two have NULL next_eligible_at (ready immediately) — the
        // one with the older updated_at should win. The third has an earlier
        // next_eligible_at in the past — that still ranks AFTER both NULL rows
        // because NULLS FIRST.
        const olderNull = await insertMediaItem(sql, {
            title: 'sweep-test-older-null',
        });
        const newerNull = await insertMediaItem(sql, {
            title: 'sweep-test-newer-null',
        });
        const oldPast = await insertMediaItem(sql, {
            title: 'sweep-test-old-past',
        });

        const tEarly = new Date(Date.now() - 120 * 60_000); // -2h
        const tLate = new Date(Date.now() - 60 * 60_000); // -1h

        await insertStageRow(sql, olderNull, STAGE_ID, {
            status: 'pending',
            nextEligibleAt: null,
            updatedAt: tEarly,
        });
        await insertStageRow(sql, newerNull, STAGE_ID, {
            status: 'pending',
            nextEligibleAt: null,
            updatedAt: tLate,
        });
        await insertStageRow(sql, oldPast, STAGE_ID, {
            status: 'pending',
            nextEligibleAt: new Date(Date.now() - 30 * 60_000), // -30m
            updatedAt: tEarly,
        });

        const rows = await findSweepCandidates(sql, STAGE_ID, 100);
        const ids = rows.map((r) => r.media_item_id);
        // NULLS FIRST puts the two NULL rows ahead of the timestamped one.
        // Within the NULL group, ORDER BY updated_at ASC puts olderNull first.
        const firstThree = ids.slice(0, 3);
        expect(firstThree).toEqual([olderNull, newerNull, oldPast]);
    });

    it('respects the LIMIT parameter', async () => {
        for (let i = 0; i < 5; i++) {
            const id = await insertMediaItem(sql, {
                title: `sweep-test-limit-${i}`,
            });
            await insertStageRow(sql, id, STAGE_ID, { status: 'pending' });
        }
        const rows = await findSweepCandidates(sql, STAGE_ID, 3);
        expect(rows.length).toBe(3);
    });

    it('returns empty array for unknown stage id', async () => {
        const rows = await findSweepCandidates(sql, 'no-such-stage-' + Date.now(), 100);
        expect(rows).toEqual([]);
    });
});

describe('countSweepBacklog (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM media_items WHERE title LIKE 'sweep-test-count-%'`;
    });

    it('counts sweepable rows matching findSweepCandidates predicate', async () => {
        const stage = `${STAGE_ID}-count`;
        const a = await insertMediaItem(sql, { title: 'sweep-test-count-a' });
        const b = await insertMediaItem(sql, { title: 'sweep-test-count-b' });
        const c = await insertMediaItem(sql, { title: 'sweep-test-count-c' });
        const completedItem = await insertMediaItem(sql, {
            title: 'sweep-test-count-done',
        });

        await insertStageRow(sql, a, stage, { status: 'pending' });
        await insertStageRow(sql, b, stage, { status: 'failed_transient' });
        await insertStageRow(sql, c, stage, { status: 'obsolete' });
        await insertStageRow(sql, completedItem, stage, {
            status: 'completed',
        });

        const n = await countSweepBacklog(sql, stage);
        expect(n).toBe(3);
    });

    it('returns 0 when no rows match', async () => {
        const n = await countSweepBacklog(sql, 'no-such-stage-count-' + Date.now());
        expect(n).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// findItemsMissingCoverage (Bug C — self-heal seeds)
// ---------------------------------------------------------------------------

describe('findItemsMissingCoverage (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = await createCoverageTestDb();
    });

    afterAll(async () => {
        if (sql) await sql.end({ timeout: 5 });
    });

    beforeEach(async () => {
        await sql`TRUNCATE pg_temp.media_item_stage_state, pg_temp.media_items`;
    });

    it('returns only items with ZERO stage_state rows for the covered media_types', async () => {
        // Three items:
        //   missing    → movie, no stage rows  → INCLUDED
        //   covered    → movie, has stage row  → EXCLUDED
        //   wrongType  → episode, no stage row → EXCLUDED (caller asked for ['movie'])
        const missing = await insertMediaItem(sql, {
            title: 'sweep-missing-test-missing',
        });
        const covered = await insertMediaItem(sql, {
            title: 'sweep-missing-test-covered',
        });
        const wrongType = await insertMediaItem(sql, {
            title: 'sweep-missing-test-wrong-type',
            media_type: 'episode',
        });

        await insertStageRow(sql, covered, 'media-probe-a', {
            status: 'pending',
        });

        const rows = await findItemsMissingCoverage(sql, ['movie'], 50);
        const ids = rows.map((r) => r.id);
        expect(ids).toContain(missing);
        expect(ids).not.toContain(covered);
        expect(ids).not.toContain(wrongType);
    });

    it('excludes dismissed items', async () => {
        const alive = await insertMediaItem(sql, {
            title: 'sweep-missing-test-alive-orphan',
        });
        const dismissed = await insertMediaItem(sql, {
            title: 'sweep-missing-test-dismissed-orphan',
            is_dismissed: true,
        });

        const rows = await findItemsMissingCoverage(sql, ['movie'], 50);
        const ids = rows.map((r) => r.id);
        expect(ids).toContain(alive);
        expect(ids).not.toContain(dismissed);
    });

    it('excludes media_types not in the covered set', async () => {
        await insertMediaItem(sql, {
            title: 'sweep-missing-test-uncovered',
            media_type: 'track',
        });

        const rows = await findItemsMissingCoverage(sql, ['movie'], 50);
        const ids = rows.map((r) => r.id);
        const matches = await sql<{ id: string }[]>`
            SELECT id::text FROM media_items
             WHERE title = 'sweep-missing-test-uncovered'
        `;
        expect(ids).not.toContain(matches[0].id);
    });

    it('returns [] when coveredMediaTypes is empty (early exit)', async () => {
        await insertMediaItem(sql, { title: 'sweep-missing-test-early-exit' });
        const rows = await findItemsMissingCoverage(sql, [], 50);
        expect(rows).toEqual([]);
    });

    it('respects the LIMIT parameter and orders by created_at ASC', async () => {
        // Insert newest first, then require the three oldest in query order.
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
            const id = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, is_dismissed, created_at)
                VALUES (
                    ${id}::uuid,
                    ${`sweep-missing-test-order-${i}`},
                    'movie',
                    'active',
                    false,
                    ${new Date(Date.UTC(2020, 0, 5 - i))}
                )
            `;
            ids.push(id);
        }

        const rows = await findItemsMissingCoverage(sql, ['movie'], 3);
        expect(rows.map((r) => r.id)).toEqual(ids.slice(-3).reverse());
    });
});

describe.each(HEAL_PLANS)(
    'reEnrollMisSkippedLibraryEmbeddings (integration, plan=%s)',
    (_name, plan) => {
        beforeEach(() => {
            healPlan = plan;
        });

        let sql: postgres.Sql;
        const PREFIX = `reenroll-test-${Math.random().toString(36).slice(2, 8)}`;
        const STAGE = 'library-embeddings';

        async function makeItem(opts: { hasFiles: boolean }): Promise<string> {
            const id = crypto.randomUUID();
            await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files)
            VALUES (${id}::uuid, ${`${PREFIX}-${id}`}, 'movie', 'active', ${opts.hasFiles})
        `;
            return id;
        }
        async function setStage(id: string, status: string): Promise<void> {
            await sql`
            INSERT INTO media_item_stage_state
                (media_item_id, stage_id, processing_version, status, attempt, skipped_reason, next_eligible_at)
            VALUES (${id}::uuid, ${STAGE}, 1, ${status}, 3, 'ineligible-by-legacy-filter', NULL)
            ON CONFLICT (media_item_id, stage_id) DO UPDATE SET status = EXCLUDED.status
        `;
        }
        async function addLibraryEmbedding(id: string): Promise<void> {
            await sql`INSERT INTO media_embeddings (media_id, source) VALUES (${id}::uuid, 'library')`;
        }
        async function statusOf(id: string): Promise<string | null> {
            const r = await sql<{ status: string }[]>`
            SELECT status FROM media_item_stage_state
             WHERE media_item_id = ${id}::uuid AND stage_id = ${STAGE}
        `;
            return r[0]?.status ?? null;
        }

        beforeAll(() => {
            sql = getTestDb();
        });
        afterAll(async () => {
            await closeTestDb();
        });
        beforeEach(async () => {
            await sql`DELETE FROM media_items WHERE title LIKE ${`${PREFIX}-%`}`;
        });

        // A dismissed item must NOT be re-enrolled. findSweepCandidates excludes dismissed
        // items, so flipping one to 'pending' here strands it permanently — nothing can
        // ever pick it up again. Prod carried 2466 seasons wrongly dismissed by migration
        // 13.0.0, all of which satisfied their stage's eligibility fragment.
        it('never re-enrolls a DISMISSED item (would strand it in unreachable pending)', async () => {
            const id = await makeItem({ hasFiles: true });
            await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${id}::uuid`;
            await setStage(id, 'skipped_permanent');

            const n = await reEnrollMisSkippedLibraryEmbeddings(sql, 100);

            expect(n).toBe(0);
            expect(await statusOf(id)).toBe('skipped_permanent');
        });

        it('re-enrolls a file-backed item wrongly skipped_permanent with no embedding', async () => {
            const id = await makeItem({ hasFiles: true });
            await setStage(id, 'skipped_permanent');

            const n = await reEnrollMisSkippedLibraryEmbeddings(sql, 100);
            expect(n).toBeGreaterThanOrEqual(1);
            expect(await statusOf(id)).toBe('pending');

            const row = await sql<
                {
                    attempt: number;
                    skipped_reason: string | null;
                    next_eligible_at: Date | null;
                }[]
            >`
            SELECT attempt, skipped_reason, next_eligible_at FROM media_item_stage_state
             WHERE media_item_id = ${id}::uuid AND stage_id = ${STAGE}
        `;
            expect(row[0].attempt).toBe(0);
            expect(row[0].skipped_reason).toBeNull();
            expect(row[0].next_eligible_at).not.toBeNull();
        });

        it('does NOT re-enroll an item that already has a library embedding', async () => {
            const id = await makeItem({ hasFiles: true });
            await setStage(id, 'skipped_permanent');
            await addLibraryEmbedding(id);

            await reEnrollMisSkippedLibraryEmbeddings(sql, 100);
            expect(await statusOf(id)).toBe('skipped_permanent');
        });

        it('does NOT re-enroll an item with no library file', async () => {
            const id = await makeItem({ hasFiles: false });
            await setStage(id, 'skipped_permanent');

            await reEnrollMisSkippedLibraryEmbeddings(sql, 100);
            expect(await statusOf(id)).toBe('skipped_permanent');
        });

        it('only touches skipped_permanent rows (leaves completed/pending alone)', async () => {
            const completed = await makeItem({ hasFiles: true });
            await setStage(completed, 'completed');

            await reEnrollMisSkippedLibraryEmbeddings(sql, 100);
            expect(await statusOf(completed)).toBe('completed');
        });

        it('is a no-op when there is nothing to heal', async () => {
            const n = await reEnrollMisSkippedLibraryEmbeddings(sql, 100);
            expect(typeof n).toBe('number');
        });
    },
);

describe.each(HEAL_PLANS)(
    'reEnrollMisSkippedIntroAnalyzer (integration, plan=%s)',
    (_name, plan) => {
        beforeEach(() => {
            healPlan = plan;
        });

        let sql: postgres.Sql;
        const PREFIX = `introheal-${Math.random().toString(36).slice(2, 8)}`;
        const STAGE = 'lumastra-intro-analyzer';

        // Build an episode with controllable eligibility inputs: a linked file
        // (has_file), optionally a video stream (has_video), and a runtime.
        async function makeEpisode(opts: {
            hasFile: boolean;
            hasVideo: boolean;
            runtimeSeconds: number | null;
        }): Promise<string> {
            const id = crypto.randomUUID();
            await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, runtime_seconds)
            VALUES (${id}::uuid, ${`${PREFIX}-${id}`}, 'episode', 'active', ${opts.hasFile}, ${opts.runtimeSeconds})
        `;
            if (opts.hasFile) {
                const fileId = crypto.randomUUID();
                await sql`
                INSERT INTO media_files (id, file_path)
                VALUES (${fileId}::uuid, ${`/${PREFIX}/${id}.mkv`})
            `;
                await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
                VALUES (${fileId}::uuid, ${id}::uuid, true, 0)
            `;
                if (opts.hasVideo) {
                    await sql`
                    INSERT INTO media_streams (file_id, stream_index, stream_type, codec)
                    VALUES (${fileId}::uuid, 0, 'video', 'h264')
                `;
                }
            }
            return id;
        }
        async function setSkippedPermanent(id: string, reason: string): Promise<void> {
            await sql`
            INSERT INTO media_item_stage_state
                (media_item_id, stage_id, processing_version, status, attempt, skipped_reason, next_eligible_at)
            VALUES (${id}::uuid, ${STAGE}, 1, 'skipped_permanent', 3, ${reason}, NULL)
            ON CONFLICT (media_item_id, stage_id) DO UPDATE SET status = EXCLUDED.status, skipped_reason = EXCLUDED.skipped_reason
        `;
        }
        async function statusOf(id: string): Promise<string | null> {
            const r = await sql<{ status: string }[]>`
            SELECT status FROM media_item_stage_state
             WHERE media_item_id = ${id}::uuid AND stage_id = ${STAGE}
        `;
            return r[0]?.status ?? null;
        }

        beforeAll(() => {
            sql = getTestDb();
        });
        afterAll(async () => {
            await closeTestDb();
        });
        beforeEach(async () => {
            await sql`DELETE FROM media_items WHERE title LIKE ${`${PREFIX}-%`}`;
        });

        it('re-enrolls an episode now eligible (has_file && has_video && runtime>60)', async () => {
            const id = await makeEpisode({ hasFile: true, hasVideo: true, runtimeSeconds: 1200 });
            await setSkippedPermanent(id, 'predicate-false');

            const n = await reEnrollMisSkippedIntroAnalyzer(sql, 100);
            expect(n).toBeGreaterThanOrEqual(1);
            expect(await statusOf(id)).toBe('pending');

            const row = await sql<{ attempt: number; skipped_reason: string | null }[]>`
            SELECT attempt, skipped_reason FROM media_item_stage_state
             WHERE media_item_id = ${id}::uuid AND stage_id = ${STAGE}
        `;
            expect(row[0].attempt).toBe(0);
            expect(row[0].skipped_reason).toBeNull();
        });

        it('also heals the predicate-false-on-invalidation reason', async () => {
            const id = await makeEpisode({ hasFile: true, hasVideo: true, runtimeSeconds: 1200 });
            await setSkippedPermanent(id, 'predicate-false-on-invalidation');
            await reEnrollMisSkippedIntroAnalyzer(sql, 100);
            expect(await statusOf(id)).toBe('pending');
        });

        it('does NOT re-enroll an episode still without a video stream (probe not yet done)', async () => {
            const id = await makeEpisode({ hasFile: true, hasVideo: false, runtimeSeconds: 1200 });
            await setSkippedPermanent(id, 'predicate-false');
            await reEnrollMisSkippedIntroAnalyzer(sql, 100);
            expect(await statusOf(id)).toBe('skipped_permanent');
        });

        it('does NOT re-enroll a genuinely sub-60s episode (permanently ineligible — no churn)', async () => {
            const id = await makeEpisode({ hasFile: true, hasVideo: true, runtimeSeconds: 30 });
            await setSkippedPermanent(id, 'predicate-false');
            await reEnrollMisSkippedIntroAnalyzer(sql, 100);
            expect(await statusOf(id)).toBe('skipped_permanent');
        });

        it('does NOT re-enroll an episode with no linked file', async () => {
            const id = await makeEpisode({ hasFile: false, hasVideo: false, runtimeSeconds: 1200 });
            await setSkippedPermanent(id, 'predicate-false');
            await reEnrollMisSkippedIntroAnalyzer(sql, 100);
            expect(await statusOf(id)).toBe('skipped_permanent');
        });

        it('does NOT touch rows skipped for an immutable reason (e.g. specials)', async () => {
            const id = await makeEpisode({ hasFile: true, hasVideo: true, runtimeSeconds: 1200 });
            await setSkippedPermanent(id, 'specials-season-not-analyzed');
            await reEnrollMisSkippedIntroAnalyzer(sql, 100);
            expect(await statusOf(id)).toBe('skipped_permanent');
        });

        it('is a no-op when there is nothing to heal', async () => {
            const n = await reEnrollMisSkippedIntroAnalyzer(sql, 100);
            expect(typeof n).toBe('number');
        });
    },
);

describe('findItemsMissingStageRow — the per-stage coverage gap', () => {
    let sql: postgres.Sql;
    const STAGE = 'sweep-test-gap-stage';
    const OTHER = 'sweep-test-gap-other';

    beforeAll(async () => {
        sql = await createCoverageTestDb();
    });
    afterAll(async () => {
        if (sql) await sql.end({ timeout: 5 });
    });
    beforeEach(async () => {
        await sql`TRUNCATE pg_temp.media_item_stage_state, pg_temp.media_items`;
    });

    it('finds an item that has OTHER stage rows but not this one', async () => {
        // 🔴 The whole point, and precisely what findItemsMissingCoverage
        // cannot see: its NOT EXISTS is satisfied by any row at all. On prod
        // this shape accounted for 11,186 items with no trickplay coverage
        // while the sweep reported a clean backlog, because an item with no
        // row is not "pending" — it is invisible.
        const item = await insertMediaItem(sql, { title: 'sweep-test-gap-partial' });
        await insertStageRow(sql, item, OTHER, { status: 'completed' });

        const found = await findItemsMissingStageRow(sql, STAGE, ['movie'], 10);
        expect(found.map((f) => f.id)).toContain(item);

        // The existing whole-item heal is blind to it.
        const wholeItem = await findItemsMissingCoverage(sql, ['movie'], 50);
        expect(wholeItem.map((f) => f.id)).not.toContain(item);
    });

    it('does not return an item that already has the stage row', async () => {
        const item = await insertMediaItem(sql, { title: 'sweep-test-gap-covered' });
        await insertStageRow(sql, item, STAGE, { status: 'completed' });

        const found = await findItemsMissingStageRow(sql, STAGE, ['movie'], 10);
        expect(found.map((f) => f.id)).not.toContain(item);
    });

    it('respects the stage appliesTo media types', async () => {
        const movie = await insertMediaItem(sql, { title: 'sweep-test-gap-movie' });
        const episode = await insertMediaItem(sql, {
            title: 'sweep-test-gap-episode',
            media_type: 'episode',
        });

        const onlyEpisodes = await findItemsMissingStageRow(sql, STAGE, ['episode'], 10);
        expect(onlyEpisodes.map((f) => f.id)).toEqual([episode]);
        const onlyMovies = await findItemsMissingStageRow(sql, STAGE, ['movie'], 10);
        expect(onlyMovies.map((f) => f.id)).toEqual([movie]);
        const both = await findItemsMissingStageRow(sql, STAGE, ['movie', 'episode'], 10);
        expect(both.map((f) => f.id).sort()).toEqual([movie, episode].sort());
    });

    it('skips dismissed and non-active items', async () => {
        const dismissed = await insertMediaItem(sql, {
            title: 'sweep-test-gap-dismissed',
            is_dismissed: true,
        });
        const inactive = await insertMediaItem(sql, { title: 'sweep-test-gap-inactive' });
        await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${inactive}::uuid`;

        const found = (await findItemsMissingStageRow(sql, STAGE, ['movie'], 50)).map((f) => f.id);
        expect(found).not.toContain(dismissed);
        expect(found).not.toContain(inactive);
    });

    it('honours the limit so the backfill stays paced', async () => {
        // ~38k rows are outstanding on a real install; seeding them in one tick
        // would queue that many runs at once.
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
            const id = await insertMediaItem(sql, { title: `sweep-test-gap-many-${i}` });
            await sql`UPDATE media_items SET created_at = ${new Date(Date.UTC(2020, 0, 5 - i))}
                WHERE id = ${id}::uuid`;
            ids.push(id);
        }

        const found = await findItemsMissingStageRow(sql, STAGE, ['movie'], 3);
        expect(found.map((f) => f.id)).toEqual(ids.slice(-3).reverse());
    });

    it('returns an empty array when the stage covers no media types', async () => {
        await insertMediaItem(sql, { title: 'sweep-test-gap-notypes' });
        expect(await findItemsMissingStageRow(sql, STAGE, [], 10)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// reEnrollMisSkippedStage — plan independence (idx_stage_state_skipped_heal)
// ---------------------------------------------------------------------------

describe('reEnrollMisSkippedStage — index scan and seq scan flip the same rows', () => {
    let sql: postgres.Sql;
    const PREFIX = `reenroll-plan-${Math.random().toString(36).slice(2, 8)}`;
    const STAGE_A = `${PREFIX}-a`;
    const STAGE_B = `${PREFIX}-b`;
    const T = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));
    // Per-run random 8-hex namespace shared by all ids; only the trailing digits
    // vary, so the media_item_id tiebreak stays hand-computable (order == n).
    const NS = Math.floor(Math.random() * 0x1_0000_0000)
        .toString(16)
        .padStart(8, '0');
    const id = (n: number) => `${NS}-0000-4000-8000-${String(n).padStart(12, '0')}`;

    const INDEX = 'idx_stage_state_skipped_heal';

    class Rollback extends Error {}

    async function makeItem(
        n: number,
        opts: { status?: string; dismissed?: boolean } = {},
    ): Promise<void> {
        await sql`
            INSERT INTO media_items (id, title, media_type, status, is_dismissed)
            VALUES (${id(n)}::uuid, ${`${PREFIX}-${n}`}, 'movie',
                    ${opts.status ?? 'active'}, ${opts.dismissed ?? false})
        `;
    }
    async function setRow(
        n: number,
        stage: string,
        status: string,
        reason: string | null,
        updatedAt: Date,
    ): Promise<void> {
        await sql`
            INSERT INTO media_item_stage_state
                (media_item_id, stage_id, processing_version, status, attempt,
                 skipped_reason, next_eligible_at, updated_at)
            VALUES (${id(n)}::uuid, ${stage}, 1, ${status}, 3, ${reason}, NULL, ${updatedAt})
        `;
    }

    // Plans: force the new partial index, or force a sequential scan.
    const PLANS = {
        index: ['SET LOCAL enable_seqscan = off', 'SET LOCAL enable_bitmapscan = off'],
        seq: [
            'SET LOCAL enable_indexscan = off',
            'SET LOCAL enable_bitmapscan = off',
            'SET LOCAL enable_indexonlyscan = off',
        ],
    } as const;

    /**
     * EXPLAIN of the heal's inner SELECT (same shape as reEnrollMisSkippedStage,
     * including the JOIN and the dismissal gate) under the current tx settings.
     */
    async function explainInner(
        tx: postgres.TransactionSql,
        stage: string,
        reasons: string[],
        limit: number,
    ): Promise<string> {
        const rows = await tx<{ 'QUERY PLAN': string }[]>`
            EXPLAIN
            SELECT s2.media_item_id
              FROM media_item_stage_state s2
              JOIN media_items mi ON mi.id = s2.media_item_id
             WHERE s2.stage_id = ${stage}
               AND s2.status = 'skipped_permanent'
               AND s2.skipped_reason = ANY(${reasons}::text[])
               AND mi.status = 'active'
               AND COALESCE(mi.is_dismissed, false) = false
               AND (mi.media_type = 'movie')
             ORDER BY s2.updated_at ASC, s2.media_item_id ASC
             LIMIT ${limit}
        `;
        return rows.map((r) => r['QUERY PLAN']).join('\n');
    }

    /**
     * `hashJoin` mirrors production's hashJoin mode (enable_nestloop = off). It is
     * applied here as a SET LOCAL instead of through the option because the
     * option opens its own transaction, which would escape this rolled-back one.
     */
    async function heal(
        plan: keyof typeof PLANS,
        stage: string,
        reasons: string[],
        limit: number,
        hashJoin = false,
    ): Promise<{ count: number; flipped: string[]; otherStageFlipped: number }> {
        let out!: { count: number; flipped: string[]; otherStageFlipped: number };
        try {
            await sql.begin(async (tx) => {
                for (const stmt of PLANS[plan]) await tx.unsafe(stmt);
                if (hashJoin) await tx.unsafe('SET LOCAL enable_nestloop = off');
                const explained = await explainInner(tx, stage, reasons, limit);
                if (plan === 'index') expect(explained).toContain(INDEX);
                else expect(explained).not.toContain(INDEX);
                const count = await reEnrollMisSkippedStage(tx as unknown as postgres.Sql, {
                    stageId: stage,
                    eligibleWhere: tx`mi.media_type = 'movie'`,
                    reasons,
                    limit,
                });
                const flipped = await tx<{ media_item_id: string }[]>`
                    SELECT media_item_id FROM media_item_stage_state
                     WHERE stage_id = ${stage} AND status = 'pending'
                       AND skipped_reason IS NULL AND attempt = 0
                     ORDER BY media_item_id
                `;
                const other = await tx<{ n: number }[]>`
                    SELECT count(*)::int AS n FROM media_item_stage_state
                     WHERE stage_id = ${stage === STAGE_A ? STAGE_B : STAGE_A}
                       AND status = 'pending' AND attempt = 0 AND skipped_reason IS NULL
                `;
                out = {
                    count,
                    flipped: flipped.map((r) => r.media_item_id),
                    otherStageFlipped: other[0].n,
                };
                throw new Rollback();
            });
        } catch (e) {
            if (!(e instanceof Rollback)) throw e;
        }
        return out;
    }

    beforeAll(async () => {
        sql = await createCoverageTestDb(true);
        for (const n of [1, 2, 3, 4, 5, 8, 9, 10, 11]) await makeItem(n);
        await makeItem(6, { dismissed: true });
        await makeItem(7, { status: 'deleted' });
        // Stage A. Equal updated_at on 1 and 2 exercises the id tiebreak.
        await setRow(1, STAGE_A, 'skipped_permanent', 'r-a', T(10));
        await setRow(2, STAGE_A, 'skipped_permanent', 'r-b', T(10));
        await setRow(3, STAGE_A, 'skipped_permanent', 'r-a', T(5));
        await setRow(4, STAGE_A, 'skipped_permanent', 'r-c', T(1)); // other reason
        await setRow(5, STAGE_A, 'skipped_permanent', 'r-b', T(20));
        await setRow(6, STAGE_A, 'skipped_permanent', 'r-a', T(2)); // dismissed
        await setRow(7, STAGE_A, 'skipped_permanent', 'r-a', T(2)); // not active (deleted)
        await setRow(8, STAGE_A, 'completed', null, T(1));
        await setRow(9, STAGE_A, 'pending', 'r-a', T(1));
        await setRow(10, STAGE_A, 'skipped_transient', 'r-a', T(1));
        await setRow(11, STAGE_A, 'skipped_permanent', 'r-a', T(30));
        // Stage B: same reasons and older timestamps; must never be touched by A's heal.
        await setRow(1, STAGE_B, 'skipped_permanent', 'r-a', T(0));
        await setRow(3, STAGE_B, 'skipped_permanent', 'r-b', T(0));
    });
    afterAll(async () => {
        if (sql) await sql.end({ timeout: 5 });
    });

    it.each([
        // [reasons, limit, expected item numbers]
        [['r-a'], 2, [3, 1]],
        [['r-a'], 10, [3, 1, 11]],
        [['r-a', 'r-b'], 3, [3, 1, 2]],
        [['r-a', 'r-b'], 10, [3, 1, 2, 5, 11]],
        [['r-b'], 1, [2]],
        [['no-such-reason'], 10, []],
    ] as [string[], number, number[]][])(
        'reasons=%j limit=%i flips the same oldest-first rows under both plans',
        async (reasons, limit, expectedNums) => {
            const expected = expectedNums.map(id).sort();
            for (const hashJoin of [false, true]) {
                for (const plan of ['index', 'seq'] as const) {
                    const label = `plan=${plan} hashJoin=${hashJoin}`;
                    const r = await heal(plan, STAGE_A, reasons, limit, hashJoin);
                    expect(r.flipped, label).toEqual(expected);
                    expect(r.count, label).toBe(expected.length);
                    expect(r.otherStageFlipped, label).toBe(0);
                }
            }
        },
    );

    it.each([
        // [reasons, limit, expected item numbers] (oldest first, id tiebreak)
        [['r-a'], 2, [3, 1]],
        [['r-a'], 10, [3, 1, 11]],
        [['r-a', 'r-b'], 4, [3, 1, 2, 5]],
        [['no-such-reason'], 10, []],
    ] as [string[], number, number[]][])(
        'findSkippedPermanentByReasons reasons=%j limit=%i returns oldest-first active rows under both plans',
        async (reasons, limit, expectedNums) => {
            for (const plan of ['index', 'seq'] as const) {
                let got: string[] = [];
                try {
                    await sql.begin(async (tx) => {
                        for (const stmt of PLANS[plan]) await tx.unsafe(stmt);
                        const rows = await findSkippedPermanentByReasons(
                            tx as unknown as postgres.Sql,
                            STAGE_A,
                            reasons,
                            limit,
                        );
                        got = rows.map((r) => r.media_item_id);
                        const plans = await tx<{ 'QUERY PLAN': string }[]>`
                            EXPLAIN
                            SELECT s.media_item_id
                              FROM media_item_stage_state s
                              JOIN media_items mi ON mi.id = s.media_item_id
                             WHERE s.stage_id = ${STAGE_A}
                               AND s.status = 'skipped_permanent'
                               AND s.skipped_reason = ANY(${reasons}::text[])
                               AND mi.status = 'active'
                               AND COALESCE(mi.is_dismissed, false) = false
                             ORDER BY s.updated_at ASC, s.media_item_id ASC
                             LIMIT ${limit}
                        `;
                        const text = plans.map((r) => r['QUERY PLAN']).join('\n');
                        if (plan === 'index') expect(text).toContain(INDEX);
                        else expect(text).not.toContain(INDEX);
                        throw new Rollback();
                    });
                } catch (e) {
                    if (!(e instanceof Rollback)) throw e;
                }
                // Excludes dismissed (6), deleted (7), non-skipped_permanent (8-10) and stage B.
                expect(got, `plan=${plan}`).toEqual(expectedNums.map(id));
            }
        },
    );
});

// A fragment that evaluates to NULL for some rows (here: runtime_seconds IS NULL)
// must behave identically under every plan shape: a NULL never re-enrolls a row,
// and `(<fragment>) IS NOT TRUE` (the gate re-label form) re-enrolls it.
describe.each(HEAL_PLANS)('reEnrollMisSkippedStage NULL semantics (plan=%s)', (_name, plan) => {
    let sql: postgres.Sql;
    const PREFIX = `nullsem-${Math.random().toString(36).slice(2, 8)}`;
    const STAGE = `${PREFIX}-stage`;

    async function makeSkipped(runtime: number | null): Promise<string> {
        const id = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, runtime_seconds)
            VALUES (${id}::uuid, ${`${PREFIX}-${id}`}, 'episode', 'active', ${runtime})
        `;
        await sql`
            INSERT INTO media_item_stage_state
                (media_item_id, stage_id, processing_version, status, skipped_reason)
            VALUES (${id}::uuid, ${STAGE}, 1, 'skipped_permanent', 'ineligible')
        `;
        return id;
    }
    async function statusOf(id: string): Promise<string> {
        const [r] = await sql<{ status: string }[]>`
            SELECT status FROM media_item_stage_state
             WHERE media_item_id = ${id}::uuid AND stage_id = ${STAGE}
        `;
        return r.status;
    }

    beforeAll(() => {
        sql = getTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM media_items WHERE title LIKE ${`${PREFIX}-%`}`;
    });
    afterAll(async () => {
        await sql`DELETE FROM media_items WHERE title LIKE ${`${PREFIX}-%`}`;
        await closeTestDb();
    });

    it('re-enrolls only rows where the fragment is TRUE (NULL and FALSE stay skipped)', async () => {
        const yes = await makeSkipped(120);
        const no = await makeSkipped(30);
        const unknown = await makeSkipped(null);
        const n = await reEnrollMisSkippedStage(sql, {
            stageId: STAGE,
            eligibleWhere: sql`mi.runtime_seconds > 60`,
            reasons: ['ineligible'],
            limit: 100,
            ...plan,
        });
        expect(n).toBe(1);
        expect(await statusOf(yes)).toBe('pending');
        expect(await statusOf(no)).toBe('skipped_permanent');
        expect(await statusOf(unknown)).toBe('skipped_permanent');
    });

    it('IS NOT TRUE re-enrolls FALSE and NULL rows, not TRUE rows', async () => {
        const yes = await makeSkipped(120);
        const no = await makeSkipped(30);
        const unknown = await makeSkipped(null);
        const n = await reEnrollMisSkippedStage(sql, {
            stageId: STAGE,
            eligibleWhere: sql`(mi.runtime_seconds > 60) IS NOT TRUE`,
            reasons: ['ineligible'],
            limit: 100,
            ...plan,
        });
        expect(n).toBe(2);
        expect(await statusOf(yes)).toBe('skipped_permanent');
        expect(await statusOf(no)).toBe('pending');
        expect(await statusOf(unknown)).toBe('pending');
    });
});
