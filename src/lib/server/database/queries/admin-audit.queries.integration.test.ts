// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Prefix action filters (`foo_bar.*`) are LIKE patterns: an unescaped `_` or `%`
 * in the prefix matched far more than the operator asked for, in the feed and
 * in the CSV export.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { listAdminAuditFeed, streamAdminAuditExport } from './admin-audit.queries.js';

const INSTANCE = 'itest-admin-audit-like';

describe('admin audit prefix filters escape LIKE metacharacters', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await sql`DELETE FROM audit_log WHERE instance_id = ${INSTANCE}`;
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM audit_log WHERE instance_id = ${INSTANCE}`;
        for (const action of ['itest_diag.clear', 'itestXdiag.clear', 'itest_diagnostic.view']) {
            await sql`
                INSERT INTO audit_log (instance_id, source, action, actor, target)
                VALUES (${INSTANCE}, 'admin', ${action}, 'itest-admin', 'x')
            `;
        }
    });

    it('`_` in the prefix matches only a literal underscore', async () => {
        const { events } = await listAdminAuditFeed(sql, {
            actions: ['itest_diag.*'],
            actors: ['itest-admin'],
            limit: 50,
        });
        expect(events.map((e) => e.action)).toEqual(['itest_diag.clear']);

        const exported = await streamAdminAuditExport(sql, {
            actions: ['itest_diag.*'],
            actors: ['itest-admin'],
            limit: 50,
        });
        expect(exported.map((e) => e.action)).toEqual(['itest_diag.clear']);
    });

    it('a trailing * still works as the wildcard', async () => {
        const { events } = await listAdminAuditFeed(sql, {
            actions: ['itest_diag*'],
            actors: ['itest-admin'],
            limit: 50,
        });
        expect(events.map((e) => e.action).sort()).toEqual([
            'itest_diag.clear',
            'itest_diagnostic.view',
        ]);
    });
});
