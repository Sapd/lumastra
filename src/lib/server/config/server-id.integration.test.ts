// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, afterAll } from 'vitest';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { getServerId, _resetServerIdCache } from './server-id.js';

describe('persistent installation identity', () => {
    afterAll(closeTestDb);
    it('concurrent replicas and subsequent reads share one stored UUID', async () => {
        _resetServerIdCache();
        const sql = getTestDb();
        const ids = await Promise.all(Array.from({ length: 12 }, () => getServerId(sql)));
        expect(new Set(ids).size).toBe(1);
        expect(await getServerId(sql)).toBe(ids[0]);
        const rows = await sql<{ value: string }[]>`SELECT value FROM plugin_settings WHERE plugin_id = 'core.server' AND key = 'SERVER_ID'`;
        expect(rows).toEqual([{ value: ids[0] }]);
    });
});
