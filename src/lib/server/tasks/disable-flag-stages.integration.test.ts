// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The other `DISABLE_*`-gated stages next to fribb-anime-sync (see
 * fribb-disabled-stage.integration.test.ts): media-probe, trickplay-params-sync
 * and mal-anime-id-enrichment. Each task early-returns while its flag is set
 * and writes no stage rows, so before the fix their rows stayed `pending`
 * forever. Pinned against a real database through the calls stage-sweep makes
 * each tick (heal, gate re-label, dispose).
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
import { mediaProbeTask, MEDIA_PROBE_DISABLED_REASON } from './builtin/native/media-probe.js';
import {
    trickplayParamsSyncTask,
    TRICKPLAY_PARAMS_DISABLED_REASON,
} from './builtin/native/trickplay-params-sync.js';
import {
    malAnimeIdEnrichmentTask,
    MAL_ENRICHMENT_DISABLED_REASON,
} from './builtin/native/mal-anime-id-enrichment.js';

const TEST_TABLES = [
    'media_item_stage_state',
    'provider_metadata',
    'external_ids',
    'media_streams',
    'media_file_items',
    'media_files',
    'plugin_user_credentials',
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
type SweepStage = DispositionStage & {
    eligibility: { sql: (sql: postgres.Sql) => never; recoverWhenAdditionalReasons?: string[] };
    healLimit?: number;
};

function stageOf(task: { coversStages?: readonly unknown[] }, stageId: string): SweepStage {
    const s = (task.coversStages as Array<{ id: string }> | undefined)?.find(
        (c) => c.id === stageId,
    );
    if (!s) throw new Error(`No coversStages entry with id='${stageId}'`);
    return s as never;
}

/** One stage-sweep tick for one stage: heal, gate re-label, dispose. */
async function sweepTick(sql: postgres.Sql, s: SweepStage): Promise<number> {
    const limit = s.healLimit ?? 50;
    let reEnrolled = await reEnrollMisSkippedStage(sql, {
        stageId: s.id,
        eligibleWhere: s.eligibility.sql(sql),
        reasons: [ELIGIBILITY_SKIP_REASON, ...(s.eligibility.recoverWhenAdditionalReasons ?? [])],
        limit,
    });
    reEnrolled += await reEnrollReopenedGates(sql, s, limit, { sql, logger: noopLogger });
    await runStageDisposition(sql, s, { sql, logger: noopLogger });
    return reEnrolled;
}

async function row(
    sql: postgres.Sql,
    id: string,
    stageId: string,
): Promise<{ status: string; skipped_reason: string | null }> {
    const [r] = await sql<{ status: string; skipped_reason: string | null }[]>`
        SELECT status, skipped_reason FROM media_item_stage_state
         WHERE media_item_id = ${id}::uuid AND stage_id = ${stageId}
    `;
    return r;
}

async function insertItem(
    sql: postgres.Sql,
    mediaType: string,
    stageId: string,
    opts: { file: boolean; video?: boolean },
): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files)
        VALUES (${id}::uuid, ${`disabled-${stageId}-${id.slice(0, 8)}`}, ${mediaType}, 'active', ${opts.file})
    `;
    if (opts.file) {
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, file_size_bytes)
            VALUES (${`/test/disabled/${id}.mkv`}, 1)
            RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${file.id}::uuid, ${id}::uuid, true)
        `;
        if (opts.video) {
            await sql`
                INSERT INTO media_streams (file_id, stream_type, stream_index, codec, height)
                VALUES (${file.id}::uuid, 'video', 0, 'hevc', 1080)
            `;
        }
    }
    await sql`
        INSERT INTO media_item_stage_state
            (media_item_id, stage_id, processing_version, status, updated_at)
        VALUES (${id}::uuid, ${stageId}, 1, 'pending', now())
    `;
    return id;
}

describe('disable-flag stages (integration)', () => {
    let sql: postgres.Sql;
    const flags: Record<string, boolean> = {};

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
        for (const key of [
            'DISABLE_MEDIA_PROBE',
            'DISABLE_TRICKPLAY_PARAMS',
            'DISABLE_MAL_ANIME_ENRICHMENT',
        ] as const) {
            flags[key] = true;
            vi.spyOn(config, key, 'get').mockImplementation(() => flags[key]);
        }
        await truncateTables(sql, [...TEST_TABLES]);
    });

    describe.each([
        {
            stageId: 'media-probe-a',
            task: mediaProbeTask,
            flag: 'DISABLE_MEDIA_PROBE',
            reason: MEDIA_PROBE_DISABLED_REASON,
        },
        {
            stageId: 'media-probe-b',
            task: mediaProbeTask,
            flag: 'DISABLE_MEDIA_PROBE',
            reason: MEDIA_PROBE_DISABLED_REASON,
        },
        {
            stageId: 'trickplay-params-sync',
            task: trickplayParamsSyncTask,
            flag: 'DISABLE_TRICKPLAY_PARAMS',
            reason: TRICKPLAY_PARAMS_DISABLED_REASON,
        },
    ])('$stageId', ({ stageId, task, flag, reason }) => {
        const s = (): SweepStage => stageOf(task, stageId);

        it('parks pending rows under the disabled reason while the flag is set', async () => {
            const id = await insertItem(sql, 'movie', stageId, { file: true, video: true });
            expect(await sweepTick(sql, s())).toBe(0);
            expect(await row(sql, id, stageId)).toEqual({
                status: 'skipped_permanent',
                skipped_reason: reason,
            });
            // Stable across later ticks.
            expect(await sweepTick(sql, s())).toBe(0);
            expect((await row(sql, id, stageId)).skipped_reason).toBe(reason);
        });

        it('clearing the flag re-enrols eligible rows and relabels the rest ineligible', async () => {
            const eligible = await insertItem(sql, 'movie', stageId, { file: true, video: true });
            const fileless = await insertItem(sql, 'movie', stageId, { file: false });
            await sweepTick(sql, s());
            expect((await row(sql, fileless, stageId)).skipped_reason).toBe(reason);

            flags[flag] = false;
            await sweepTick(sql, s());

            expect(await row(sql, eligible, stageId)).toEqual({
                status: 'pending',
                skipped_reason: null,
            });
            expect(await row(sql, fileless, stageId)).toEqual({
                status: 'skipped_permanent',
                skipped_reason: ELIGIBILITY_SKIP_REASON,
            });
        });

        it('leaves pending rows alone while the flag is clear', async () => {
            flags[flag] = false;
            const id = await insertItem(sql, 'movie', stageId, { file: true, video: true });
            await sweepTick(sql, s());
            expect(await row(sql, id, stageId)).toEqual({
                status: 'pending',
                skipped_reason: null,
            });
        });
    });

    describe('mal-anime-id-enrichment (no MAL account linked)', () => {
        const STAGE = 'mal-anime-id-enrichment';
        const s = (): SweepStage => stageOf(malAnimeIdEnrichmentTask, STAGE);
        let nextMalId = 1000;

        async function insertSeries(animeGenres: unknown): Promise<string> {
            const id = await insertItem(sql, 'tv', STAGE, { file: true });
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${id}::uuid, 'mal', ${String(nextMalId++)}, 'tv', true)
            `;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
                VALUES (${id}::uuid, 'mdblist', ${sql.json({ anime_genres: animeGenres } as never)}, now(), now())
            `;
            return id;
        }

        it('parks an anime series as disabled, ahead of the auth guard', async () => {
            const id = await insertSeries(['Action']);
            await sweepTick(sql, s());
            // Not skipped_transient: the auth guard would re-drain it every 24h
            // and the stage could never settle while switched off.
            expect(await row(sql, id, STAGE)).toEqual({
                status: 'skipped_permanent',
                skipped_reason: MAL_ENRICHMENT_DISABLED_REASON,
            });
        });

        it('never labels a non-anime series disabled', async () => {
            // skipAutoDispose means nothing would re-label it after re-enable.
            const id = await insertSeries(null);
            await sweepTick(sql, s());
            expect((await row(sql, id, STAGE)).skipped_reason).not.toBe(
                MAL_ENRICHMENT_DISABLED_REASON,
            );
        });

        it('clearing the flag hands the series back to the auth guard', async () => {
            const id = await insertSeries(['Action']);
            await sweepTick(sql, s());

            flags.DISABLE_MAL_ANIME_ENRICHMENT = false;
            expect(await sweepTick(sql, s())).toBe(1);

            // Reclaimed, then drained by the guard because no MAL account is
            // linked: what the operator has to fix now is the missing link.
            expect(await row(sql, id, STAGE)).toEqual({
                status: 'skipped_transient',
                skipped_reason: 'precondition-not-met:mal-user-link-required',
            });
        });
    });
});
