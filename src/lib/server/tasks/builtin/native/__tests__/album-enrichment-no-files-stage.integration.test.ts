// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `album-enrichment` must not run for an album whose files are gone.
 *
 * Prod 2026-10-16: 19 albums with no linked track file (`has_files = false`)
 * ended `failed_permanent` after five attempts each, with
 * `resolve_path_failed: METADATA_STORAGE_LOCATION is "alongside" but no media
 * file path is available` — there is no track folder to put the cover next to.
 * The stage's eligibility now requires `has_files`: the dispose pass skips such
 * albums as 'ineligible', and the heal re-opens them once a file is linked.
 *
 * Pinned against a real database through the calls stage-sweep makes each tick
 * (heal, dispose), as in fribb-disabled-stage.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../../../tests/integration/helpers/cleanup.js';
import type { StageGuardContext } from '$lib/types/pipeline.js';
import { runStageDisposition, ELIGIBILITY_SKIP_REASON } from '../../../stage-disposition-runner.js';
import { reEnrollMisSkippedStage } from '$lib/server/database/queries/stage-sweep.queries.js';
import { albumEnrichmentTask } from '../album-enrichment.js';

const STAGE = 'album-enrichment';

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
} {
    const s = albumEnrichmentTask.coversStages?.find((c) => c.id === STAGE);
    if (!s) throw new Error(`No coversStages entry with id='${STAGE}'`);
    return s as never;
}

async function insertAlbum(sql: postgres.Sql, title: string, hasFiles: boolean): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files)
        VALUES (${id}::uuid, ${title}, 'album', 'active', ${hasFiles})
    `;
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

async function sweepTick(sql: postgres.Sql): Promise<void> {
    const s = stage();
    await reEnrollMisSkippedStage(sql, {
        stageId: STAGE,
        eligibleWhere: s.eligibility.sql(sql),
        reasons: [ELIGIBILITY_SKIP_REASON, ...(s.eligibility.recoverWhenAdditionalReasons ?? [])],
        limit: 50,
    });
    await runStageDisposition(sql, s, { sql, logger: noopLogger });
}

describe('album-enrichment stage for albums without files (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES);
    });

    it('skips a fileless album as ineligible and leaves an album with files pending', async () => {
        const gone = await insertAlbum(sql, 'Files Gone', false);
        const present = await insertAlbum(sql, 'Files Present', true);

        await sweepTick(sql);

        expect(await row(sql, gone)).toEqual({
            status: 'skipped_permanent',
            skipped_reason: ELIGIBILITY_SKIP_REASON,
        });
        expect((await row(sql, present)).status).toBe('pending');
    });

    it('re-opens the album once a file is linked again', async () => {
        const id = await insertAlbum(sql, 'Comes Back', false);
        await sweepTick(sql);
        expect((await row(sql, id)).status).toBe('skipped_permanent');

        await sql`UPDATE media_items SET has_files = true WHERE id = ${id}::uuid`;
        await sweepTick(sql);

        expect((await row(sql, id)).status).toBe('pending');
    });
});
