// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `sonic-embedding-backfill` must not leave rows pending when this install
 * cannot embed: the feature is off, or it is on with no embedder configured.
 *
 * Fresh install 2026-10-06 (2 movies, 6 tracks, no sonic sidecar): the admin
 * drawer said "your library is being processed" forever, because the six track
 * rows of this stage stayed `pending`. The task is global-identity and its
 * `execute()` early-returns while a gate is closed, so nothing ever wrote them.
 * That is every arm64 install (the sidecar image is amd64-only) and most amd64
 * ones.
 *
 * Pinned here against a real database, through the same two framework calls the
 * stage sweep makes every tick:
 *   - `runStageDisposition` with a gate closed → `skipped_permanent` under that
 *     gate's own reason, but only for tracks that would otherwise be embedded
 *     (an embedded or file-less track gets the eligibility dispose's
 *     'ineligible', so no stale gate label survives the gate opening);
 *   - `reEnrollMisSkippedStage` with the stage's own eligibility fragment and
 *     reasons after the gate opens → back to `pending`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import type { StageGuardContext } from '$lib/types/pipeline.js';
import { config, features } from '$lib/server/config.js';

import {
    runStageDisposition,
    reEnrollReopenedGates,
    ELIGIBILITY_SKIP_REASON,
} from './stage-disposition-runner.js';
import { reEnrollMisSkippedStage } from '$lib/server/database/queries/stage-sweep.queries.js';
import {
    fetchPendingTracks,
    sonicEmbeddingBackfillTask,
    SONIC_DISABLED_REASON,
    SONIC_NO_ENGINE_REASON,
} from './builtin/native/sonic-embedding-backfill.js';
import {
    SONIC_MODEL_ID,
    resetSonicEngineProbeForTests,
} from '$lib/server/services/sonic-embedding.service.js';

/** `engine` = a sidecar URL is configured. The subprocess script never exists here. */
const sonic = { enabled: false, engine: true };

const STAGE = 'sonic-embedding-backfill';

const TEST_TABLES = [
    'media_item_stage_state',
    'media_audio_embedding_state',
    'media_file_items',
    'media_files',
    'media_items',
] as const;

const noopLogger: StageGuardContext['logger'] = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() {
        return noopLogger;
    },
};

type DispositionStage = Parameters<typeof runStageDisposition>[1];

function stage(): DispositionStage & {
    eligibility: { sql: (sql: postgres.Sql) => never; recoverWhenAdditionalReasons?: string[] };
    healLimit?: number;
} {
    const s = sonicEmbeddingBackfillTask.coversStages?.find((c) => c.id === STAGE);
    if (!s) throw new Error(`No coversStages entry with id='${STAGE}' — declaration removed?`);
    return s as never;
}

async function insertTrack(sql: postgres.Sql, title: string): Promise<string> {
    const id = crypto.randomUUID();
    const fileId = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files)
        VALUES (${id}::uuid, ${title}, 'track', 'active', true)
    `;
    await sql`
        INSERT INTO media_files (id, file_path, created_at, updated_at)
        VALUES (${fileId}::uuid, ${`/test/music/${id}.flac`}, now(), now())
    `;
    await sql`
        INSERT INTO media_file_items (file_id, media_item_id, is_default)
        VALUES (${fileId}::uuid, ${id}::uuid, true)
    `;
    await sql`
        INSERT INTO media_item_stage_state
            (media_item_id, stage_id, processing_version, status, updated_at)
        VALUES (${id}::uuid, ${STAGE}, 1, 'pending', now())
    `;
    return id;
}

async function markEmbedded(sql: postgres.Sql, id: string): Promise<void> {
    await sql`
        INSERT INTO media_audio_embedding_state (media_id, model_id, status, updated_at)
        VALUES (${id}::uuid, ${SONIC_MODEL_ID}, 'done', now())
    `;
}

async function row(
    sql: postgres.Sql,
    id: string,
): Promise<{ status: string; skipped_reason: string | null }> {
    const [r] = await sql<{ status: string; skipped_reason: string | null }[]>`
        SELECT status, skipped_reason FROM media_item_stage_state
         WHERE media_item_id = ${id}::uuid AND stage_id = ${STAGE}
    `;
    return r;
}

/**
 * What one stage-sweep tick does for this stage, in the sweep's order: the heal
 * (eligibility heal, then the gate re-label passes), then the dispose. Returns
 * the rows the heal flipped back to `pending`.
 */
async function sweepTick(sql: postgres.Sql): Promise<number> {
    const s = stage();
    const limit = s.healLimit ?? 50;
    let reEnrolled = await reEnrollMisSkippedStage(sql, {
        stageId: STAGE,
        eligibleWhere: s.eligibility.sql(sql),
        reasons: [ELIGIBILITY_SKIP_REASON, ...(s.eligibility.recoverWhenAdditionalReasons ?? [])],
        limit,
    });
    reEnrolled += await reEnrollReopenedGates(sql, s, limit, { sql, logger: noopLogger });
    await runStageDisposition(sql, s, { logger: noopLogger } as never);
    return reEnrolled;
}

describe('sonic-embedding-backfill stage with an install gate closed (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    beforeEach(async () => {
        sonic.enabled = false;
        sonic.engine = true;
        // Spy the real getters: the stage's builders read them on every call, and
        // the engine gate goes through the real isSonicEngineConfigured().
        vi.spyOn(features, 'sonicEmbeddings', 'get').mockImplementation(() => sonic.enabled);
        vi.spyOn(config, 'SONIC_EMBEDDER_URL', 'get').mockImplementation(() =>
            sonic.engine ? 'http://sonic:8000' : '',
        );
        vi.spyOn(config, 'SONIC_EMBEDDER_SCRIPT', 'get').mockReturnValue(
            '/nonexistent/sonic-embedder/embed.py',
        );
        resetSonicEngineProbeForTests();
        await truncateTables(sql, [...TEST_TABLES]);
    });

    it('disposes pending track rows as skipped_permanent under its own reason', async () => {
        const a = await insertTrack(sql, 'sonic-off-a');
        const b = await insertTrack(sql, 'sonic-off-b');

        expect(await sweepTick(sql)).toBe(0);

        for (const id of [a, b]) {
            // Not 'ineligible': on this stage that also means "already embedded",
            // and the Ingest Map has to tell the two apart.
            expect(await row(sql, id)).toEqual({
                status: 'skipped_permanent',
                skipped_reason: SONIC_DISABLED_REASON,
            });
        }
    });

    it('stays skipped across later ticks while the feature is off', async () => {
        const id = await insertTrack(sql, 'sonic-off-stays');
        await sweepTick(sql);
        expect(await sweepTick(sql)).toBe(0);
        expect((await row(sql, id)).status).toBe('skipped_permanent');
    });

    it('re-enrols the skipped rows once the feature is turned on', async () => {
        const fresh = await insertTrack(sql, 'sonic-reenrol-fresh');
        await sweepTick(sql);
        expect((await row(sql, fresh)).skipped_reason).toBe(SONIC_DISABLED_REASON);

        sonic.enabled = true;
        const reEnrolled = await sweepTick(sql);

        expect(reEnrolled).toBe(1);
        expect(await row(sql, fresh)).toEqual({ status: 'pending', skipped_reason: null });
    });

    it('labels an already-embedded track ineligible, not disabled, and keeps it so', async () => {
        // Pending because an invalidation re-seeded it; it needs no embedding.
        const embedded = await insertTrack(sql, 'sonic-off-embedded');
        await markEmbedded(sql, embedded);

        await sweepTick(sql);
        const expected = { status: 'skipped_permanent', skipped_reason: ELIGIBILITY_SKIP_REASON };
        expect(await row(sql, embedded)).toEqual(expected);

        // Turning the feature on must not leave a stale "disabled" label behind:
        // the heal never reclaims this row, so its reason has to be right already.
        sonic.enabled = true;
        expect(await sweepTick(sql)).toBe(0);
        expect(await row(sql, embedded)).toEqual(expected);
    });

    it('labels a track whose file is missing ineligible, not disabled', async () => {
        const id = await insertTrack(sql, 'sonic-off-missing-file');
        await sql`
            UPDATE media_files SET is_missing = true
             WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${id}::uuid)
        `;
        await sweepTick(sql);
        expect((await row(sql, id)).skipped_reason).toBe(ELIGIBILITY_SKIP_REASON);
    });

    it('leaves pending rows alone while the feature is on', async () => {
        sonic.enabled = true;
        const id = await insertTrack(sql, 'sonic-on-pending');
        await sweepTick(sql);
        expect(await row(sql, id)).toEqual({ status: 'pending', skipped_reason: null });
    });

    describe('feature on but no embedder (no sidecar URL, no subprocess fallback)', () => {
        beforeEach(() => {
            sonic.enabled = true;
            sonic.engine = false;
        });

        it('disposes under the no-embedder reason', async () => {
            const id = await insertTrack(sql, 'sonic-no-engine');
            expect(await sweepTick(sql)).toBe(0);
            expect(await row(sql, id)).toEqual({
                status: 'skipped_permanent',
                skipped_reason: SONIC_NO_ENGINE_REASON,
            });
        });

        it('the feature switch wins when both gates are closed', async () => {
            sonic.enabled = false;
            const id = await insertTrack(sql, 'sonic-no-engine-off');
            await sweepTick(sql);
            expect((await row(sql, id)).skipped_reason).toBe(SONIC_DISABLED_REASON);
        });

        it('feature turned on, still no embedder: the reason moves to no-embedder', async () => {
            sonic.enabled = false;
            const id = await insertTrack(sql, 'sonic-relabel-on');
            await sweepTick(sql);
            expect((await row(sql, id)).skipped_reason).toBe(SONIC_DISABLED_REASON);

            sonic.enabled = true;
            await sweepTick(sql);
            // "Disabled" is no longer true; what the operator has to fix now is
            // the missing embedder.
            expect(await row(sql, id)).toEqual({
                status: 'skipped_permanent',
                skipped_reason: SONIC_NO_ENGINE_REASON,
            });
            // Stable from here: no flip-flopping on later ticks.
            expect(await sweepTick(sql)).toBe(0);
            expect((await row(sql, id)).skipped_reason).toBe(SONIC_NO_ENGINE_REASON);
        });

        it('embedder added, feature then turned off: the reason moves to disabled', async () => {
            const id = await insertTrack(sql, 'sonic-relabel-off');
            await sweepTick(sql);
            expect((await row(sql, id)).skipped_reason).toBe(SONIC_NO_ENGINE_REASON);

            sonic.engine = true;
            sonic.enabled = false;
            await sweepTick(sql);
            expect(await row(sql, id)).toEqual({
                status: 'skipped_permanent',
                skipped_reason: SONIC_DISABLED_REASON,
            });
        });

        it('re-enrols once a sidecar URL is configured', async () => {
            const id = await insertTrack(sql, 'sonic-no-engine-then-sidecar');
            await sweepTick(sql);
            expect((await row(sql, id)).skipped_reason).toBe(SONIC_NO_ENGINE_REASON);

            sonic.engine = true;
            expect(await sweepTick(sql)).toBe(1);
            expect(await row(sql, id)).toEqual({ status: 'pending', skipped_reason: null });
        });
    });
});

describe('fetchPendingTracks — crash suspects set aside for the run (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES]);
    });

    it('returns every pending track with no exclusions, and skips the excluded ones', async () => {
        const a = await insertTrack(sql, 'fetch-a');
        const b = await insertTrack(sql, 'fetch-b');
        const c = await insertTrack(sql, 'fetch-c');

        const all = await fetchPendingTracks(sql, 10);
        expect(all.map((t) => t.media_item_id).sort()).toEqual([a, b, c].sort());

        const rest = await fetchPendingTracks(sql, 10, [b]);
        expect(rest.map((t) => t.media_item_id).sort()).toEqual([a, c].sort());
    });
});

/**
 * The generic gate re-label on a synthetic stage: the cases sonic does not
 * reach. Two gates stamping ONE reason must both be open before a row is
 * released (otherwise it flips between them every tick), and a gate fragment
 * that evaluates to NULL counts as open, never as "unknown, keep stuck".
 */
describe('reEnrollReopenedGates (integration)', () => {
    let sql: postgres.Sql;
    const SYNTH = 'test-gate-relabel-stage';
    const gates = { a: true, b: true };

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        gates.a = true;
        gates.b = true;
        await truncateTables(sql, [...TEST_TABLES]);
    });

    function synthStage(): Parameters<typeof reEnrollReopenedGates>[1] {
        return {
            id: SYNTH,
            eligibility: {
                // Nothing is ever eligible: a released row must be re-stamped
                // 'ineligible' by the dispose, never left pending.
                sql: (q: postgres.Sql) => q`false`,
                recoverWhenAdditionalReasons: ['shared-gate', 'null-gate'],
            },
            terminalDisposition: [
                {
                    kind: 'predicate',
                    ruleId: 'gate-a',
                    disposeAs: 'skipped_permanent',
                    reason: 'shared-gate',
                    excludes: (q: postgres.Sql) => (gates.a ? q`true` : q`false`),
                },
                {
                    kind: 'predicate',
                    ruleId: 'gate-b',
                    disposeAs: 'skipped_permanent',
                    reason: 'shared-gate',
                    excludes: (q: postgres.Sql) => (gates.b ? q`true` : q`false`),
                },
                {
                    kind: 'predicate',
                    ruleId: 'gate-null',
                    disposeAs: 'skipped_permanent',
                    reason: 'null-gate',
                    excludes: (q: postgres.Sql) => q`NULL::boolean`,
                },
            ],
        } as never;
    }

    async function seedSkipped(reason: string): Promise<string> {
        const id = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status)
            VALUES (${id}::uuid, ${`gate-relabel-${reason}`}, 'movie', 'active')
        `;
        await sql`
            INSERT INTO media_item_stage_state
                (media_item_id, stage_id, processing_version, status, skipped_reason, updated_at)
            VALUES (${id}::uuid, ${SYNTH}, 1, 'skipped_permanent', ${reason}, now())
        `;
        return id;
    }

    async function synthRow(
        id: string,
    ): Promise<{ status: string; skipped_reason: string | null }> {
        const [r] = await sql<{ status: string; skipped_reason: string | null }[]>`
            SELECT status, skipped_reason FROM media_item_stage_state
             WHERE media_item_id = ${id}::uuid AND stage_id = ${SYNTH}
        `;
        return r;
    }

    const ctx = (): { sql: postgres.Sql; logger: typeof noopLogger } => ({
        sql,
        logger: noopLogger,
    });

    it('a reason two gates share is held while either gate is still closed', async () => {
        const id = await seedSkipped('shared-gate');
        gates.a = false; // A opened, B still closed
        expect(await reEnrollReopenedGates(sql, synthStage(), 50, ctx())).toBe(0);
        expect(await synthRow(id)).toEqual({
            status: 'skipped_permanent',
            skipped_reason: 'shared-gate',
        });
    });

    it('released once every gate for the reason is open, and re-stamped in the same call', async () => {
        const id = await seedSkipped('shared-gate');
        gates.a = false;
        gates.b = false;
        expect(await reEnrollReopenedGates(sql, synthStage(), 50, ctx())).toBe(1);
        // Not left pending: nothing is eligible, so the dispose ran in the same call.
        expect(await synthRow(id)).toEqual({
            status: 'skipped_permanent',
            skipped_reason: ELIGIBILITY_SKIP_REASON,
        });
    });

    it('a gate fragment that is NULL for the row counts as open', async () => {
        const id = await seedSkipped('null-gate');
        expect(await reEnrollReopenedGates(sql, synthStage(), 50, ctx())).toBe(1);
        expect((await synthRow(id)).skipped_reason).not.toBe('null-gate');
    });
});
