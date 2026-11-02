// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    getObservedVersion,
    setObservedVersion,
    allObservedVersions,
} from './stage-version-state.queries.js';

describe('stage-version-state queries', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`TRUNCATE stage_version_state CASCADE`;
    });

    it('getObservedVersion returns null for unknown stage', async () => {
        const result = await getObservedVersion(sql, 'unknown-stage');
        expect(result).toBeNull();
    });

    it('setObservedVersion + getObservedVersion round-trip', async () => {
        await setObservedVersion(sql, 'stage-1', 5);
        const result = await getObservedVersion(sql, 'stage-1');
        expect(result).toBe(5);
    });

    it('setObservedVersion UPSERT updates the version', async () => {
        await setObservedVersion(sql, 'stage-2', 3);
        let result = await getObservedVersion(sql, 'stage-2');
        expect(result).toBe(3);

        // Update the version
        await setObservedVersion(sql, 'stage-2', 7);
        result = await getObservedVersion(sql, 'stage-2');
        expect(result).toBe(7);
    });

    it('allObservedVersions lists all rows', async () => {
        await setObservedVersion(sql, 'stage-1', 2);
        await setObservedVersion(sql, 'stage-2', 4);
        await setObservedVersion(sql, 'stage-3', 6);

        const results = await allObservedVersions(sql);
        expect(results).toHaveLength(3);
        expect(results).toContainEqual({
            stage_id: 'stage-1',
            observed_version: 2,
        });
        expect(results).toContainEqual({
            stage_id: 'stage-2',
            observed_version: 4,
        });
        expect(results).toContainEqual({
            stage_id: 'stage-3',
            observed_version: 6,
        });
    });
});
