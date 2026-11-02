// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * getLatestScanMetadataProblem — the setup wizard's "matching failed" signal
 * (Windows e2e 2026-09-27, S5).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { closeTestDb, getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { getLatestScanMetadataProblem } from './onboarding.queries.js';

describe('getLatestScanMetadataProblem', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM task_history WHERE task_id = 'file-library-scan'`;
    });

    async function insertScan(
        id: string,
        libraryPathId: string,
        minutesAgo: number,
        result: Record<string, unknown>,
    ): Promise<void> {
        await sql`
            INSERT INTO task_history (id, task_id, label, state, input, trigger, actor,
                processing_version, started_at, completed_at, result)
            VALUES (${id}, 'file-library-scan', 'file-library-scan', 'completed',
                ${sql.json({ libraryPathId })}, ${sql.json({ kind: 'manual' })},
                ${sql.json({ type: 'system' })}, '1',
                NOW() - make_interval(mins => ${minutesAgo}),
                NOW() - make_interval(mins => ${minutesAgo}),
                ${sql.json({ success: true, itemsProcessed: 0, result } as postgres.JSONValue)})
        `;
    }

    it('reports nothing when no scan ran', async () => {
        expect(await getLatestScanMetadataProblem(sql)).toEqual({
            metadataUnavailable: 0,
            metadataProviderError: null,
            metadataProviderId: null,
        });
    });

    it('sums the latest scan per library and prefers a rejected key', async () => {
        await insertScan('scan-a', 'lib-a', 5, {
            added: 10,
            metadataUnavailable: 10,
            metadataProviderError: 'auth',
            metadataProviderId: 'tmdb-metadata-provider',
        });
        await insertScan('scan-b', 'lib-b', 4, {
            added: 3,
            metadataUnavailable: 3,
            metadataProviderError: 'unavailable',
        });

        expect(await getLatestScanMetadataProblem(sql)).toEqual({
            metadataUnavailable: 13,
            metadataProviderError: 'auth',
            metadataProviderId: 'tmdb-metadata-provider',
        });
    });

    it('a newer clean scan of the same library clears it (key fixed, re-scanned)', async () => {
        await insertScan('scan-old', 'lib-a', 30, {
            added: 10,
            metadataUnavailable: 10,
            metadataProviderError: 'auth',
            metadataProviderId: 'tmdb-metadata-provider',
        });
        await insertScan('scan-new', 'lib-a', 1, { added: 0, updated: 10 });

        expect((await getLatestScanMetadataProblem(sql)).metadataProviderError).toBeNull();
    });
});
