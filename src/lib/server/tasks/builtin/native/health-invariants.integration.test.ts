// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for the `admin_attention_alerts` retention pass wired into
 * `health-invariants` (Problems-as-Architecture design, §5.5 / Slice 0). This
 * exercises the real task against the `lumastra_tests` database — including
 * every registered health invariant — and asserts only the retention-specific
 * behaviour: eligible resolved rows are pruned, active/acked rows are left
 * alone, and the deleted count is reported back on the task result.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { runTask } from '@sapd/lumastra-plugin-sdk-testing';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { healthInvariantsTask } from './health-invariants.js';
import {
    upsertAlerts,
    resolveAlerts,
    ackAlert,
} from '$lib/server/database/queries/attention.queries.js';
import type { UpsertAlert } from '$lib/server/services/attention/types.js';

const NOW = '2026-06-05T12:00:00.000Z';

function up(over: Partial<UpsertAlert> = {}): UpsertAlert {
    return {
        id: 'test:hi-retention:x',
        fingerprint: 'open:5',
        type: 'circuit-open',
        severity: 'critical',
        title: 'x circuit open',
        detail: null,
        source_ref: null,
        status: 'active',
        first_seen: NOW,
        last_seen: NOW,
        acked_at: null,
        acked_by: null,
        acked_fingerprint: null,
        count: null,
        acked_count: null,
        snoozed_until: null,
        ...over,
    };
}

describe('health-invariants — admin_attention_alerts retention pass', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM admin_attention_alerts WHERE id LIKE 'test:hi-retention:%'`;
    });

    it('prunes only aged-out resolved rows and reports the count, leaving active/acked rows untouched', async () => {
        await upsertAlerts(sql, [
            up({ id: 'test:hi-retention:old' }),
            up({ id: 'test:hi-retention:acked' }),
        ]);
        await resolveAlerts(sql, ['test:hi-retention:old']);
        await ackAlert(sql, 'test:hi-retention:acked', 'open:5', 'denis');
        await sql`
            UPDATE admin_attention_alerts
               SET resolved_at = now() - INTERVAL '45 days'
             WHERE id = 'test:hi-retention:old'
        `;

        const result = await runTask(healthInvariantsTask, {}, { sql });

        expect(result.success).toBe(true);
        expect(result.result?.alertsDeleted).toBeGreaterThanOrEqual(1);

        const remaining = await sql<{ id: string }[]>`
            SELECT id FROM admin_attention_alerts WHERE id LIKE 'test:hi-retention:%'
        `;
        expect(remaining.map((r) => r.id)).toEqual(['test:hi-retention:acked']);
    });
});
