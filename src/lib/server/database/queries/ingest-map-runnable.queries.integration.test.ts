// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `countRunnableStageItems` feeds the `/admin/fix/stuck` verdict. A dead letter
 * is terminal and must not count, or an idle instance never reads `idle`.
 * Measured as a delta, so rows other tests left behind do not matter.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { countRunnableStageItems } from './ingest-map.queries.js';

const PREFIX = 'runnable-count-test-';

async function itemWithStages(sql: postgres.Sql, statuses: string[]): Promise<void> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status, created_at, updated_at)
        VALUES (${id}::uuid, ${PREFIX + id}, 'movie', 'active', now(), now())
    `;
    for (const [i, status] of statuses.entries()) {
        await sql`
            INSERT INTO media_item_stage_state
                (media_item_id, stage_id, processing_version, status, attempt, updated_at)
            VALUES (${id}::uuid, ${`${PREFIX}stage-${i}`}, 1, ${status}, 0, now())
        `;
    }
}

describe('countRunnableStageItems (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterEach(async () => {
        await sql`DELETE FROM media_items WHERE title LIKE ${PREFIX + '%'}`;
    });

    afterAll(async () => {
        await closeTestDb();
    });

    it('leaves out items whose only open row is a dead letter', async () => {
        const before = await countRunnableStageItems(sql);
        await itemWithStages(sql, ['failed_permanent', 'completed']);
        expect(await countRunnableStageItems(sql)).toBe(before);
    });

    it('counts each item once across every runnable status', async () => {
        const before = await countRunnableStageItems(sql);
        for (const status of [
            'running',
            'pending',
            'failed_transient',
            'skipped_transient',
            'obsolete',
        ]) {
            await itemWithStages(sql, [status]);
        }
        await itemWithStages(sql, ['pending', 'failed_transient', 'failed_permanent']);
        expect(await countRunnableStageItems(sql)).toBe(before + 6);
    });
});
