// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `fribb-anime-sync` must not leave rows pending while `DISABLE_FRIBB_ANIME_SYNC`
 * is set.
 *
 * Preprod 2026-10-07: 70 rows (69 movies, 1 series) sat `pending`, attempt 0,
 * never run, the oldest since 2026-08-21. A use-case preset had switched the
 * task off, so every run returned success without writing a row; stage-sweep
 * found the same 70 candidates every minute, enqueued nothing, and backed off
 * ("global enqueue backed off (no progress)"). The admin UI showed a backlog
 * that could never drain.
 *
 * Pinned against a real database through the calls stage-sweep makes each tick
 * (heal, gate re-label, dispose), as in sonic-embedding-disabled-stage.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import type { StageGuardContext } from '$lib/types/pipeline.js';
import { config } from '$lib/server/config.js';

import {
    runStageDisposition,
    reEnrollReopenedGates,
    ELIGIBILITY_SKIP_REASON,
} from './stage-disposition-runner.js';
import { reEnrollMisSkippedStage } from '$lib/server/database/queries/stage-sweep.queries.js';
import { fribbAnimeSyncTask, FRIBB_DISABLED_REASON } from './builtin/native/fribb-anime-sync.js';

const STAGE = 'fribb-anime-sync';
const flag = { disabled: true };

const TEST_TABLES = ['media_item_stage_state', 'external_ids', 'media_items'] as const;

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
    const s = fribbAnimeSyncTask.coversStages?.find((c) => c.id === STAGE);
    if (!s) throw new Error(`No coversStages entry with id='${STAGE}'`);
    return s as never;
}

async function insertMovie(
    sql: postgres.Sql,
    title: string,
    opts: { tmdb: boolean },
): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files)
        VALUES (${id}::uuid, ${title}, 'movie', 'active', true)
    `;
    if (opts.tmdb) {
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
            VALUES (${id}::uuid, 'tmdb', ${String(1 + Math.floor(Math.random() * 9e7))}, 'movie', true)
        `;
    }
    await sql`
        INSERT INTO media_item_stage_state
            (media_item_id, stage_id, processing_version, status, updated_at)
        VALUES (${id}::uuid, ${STAGE}, 1, 'pending', now())
    `;
    return id;
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

/** One stage-sweep tick for this stage: heal, gate re-label, dispose. */
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
    await runStageDisposition(sql, s, { sql, logger: noopLogger });
    return reEnrolled;
}

describe('fribb-anime-sync stage while DISABLE_FRIBB_ANIME_SYNC is set (integration)', () => {
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
        flag.disabled = true;
        vi.spyOn(config, 'DISABLE_FRIBB_ANIME_SYNC', 'get').mockImplementation(() => flag.disabled);
        await truncateTables(sql, [...TEST_TABLES]);
    });

    it('disposes the pending rows as skipped_permanent under the disabled reason', async () => {
        const a = await insertMovie(sql, 'fribb-off-a', { tmdb: true });
        const b = await insertMovie(sql, 'fribb-off-b', { tmdb: false });

        expect(await sweepTick(sql)).toBe(0);

        for (const id of [a, b]) {
            expect(await row(sql, id)).toEqual({
                status: 'skipped_permanent',
                skipped_reason: FRIBB_DISABLED_REASON,
            });
        }
    });

    it('stays skipped across later ticks while the flag is set', async () => {
        const id = await insertMovie(sql, 'fribb-off-stays', { tmdb: true });
        await sweepTick(sql);
        expect(await sweepTick(sql)).toBe(0);
        expect((await row(sql, id)).status).toBe('skipped_permanent');
    });

    it('clearing the flag re-enrols eligible rows and relabels the rest ineligible', async () => {
        const withTmdb = await insertMovie(sql, 'fribb-reenable-tmdb', { tmdb: true });
        const noTmdb = await insertMovie(sql, 'fribb-reenable-no-tmdb', { tmdb: false });
        await sweepTick(sql);

        flag.disabled = false;
        await sweepTick(sql);

        expect(await row(sql, withTmdb)).toEqual({ status: 'pending', skipped_reason: null });
        // "Disabled" is no longer true for this one; what keeps it out now is the
        // missing TMDB id, and the label has to say so.
        expect(await row(sql, noTmdb)).toEqual({
            status: 'skipped_permanent',
            skipped_reason: ELIGIBILITY_SKIP_REASON,
        });

        // Stable from here.
        expect(await sweepTick(sql)).toBe(0);
        expect((await row(sql, withTmdb)).status).toBe('pending');
    });

    it('leaves pending rows alone while the task is enabled', async () => {
        flag.disabled = false;
        const id = await insertMovie(sql, 'fribb-on-pending', { tmdb: true });
        await sweepTick(sql);
        expect(await row(sql, id)).toEqual({ status: 'pending', skipped_reason: null });
    });
});
