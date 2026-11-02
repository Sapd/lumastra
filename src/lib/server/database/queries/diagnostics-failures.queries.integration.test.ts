// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the three bounded "recent failures" listings that feed
 * the instance diagnostics bundle — one per subsystem, each living in its own
 * existing query module.
 *
 * These run real SQL: the columns they select (`plugin_failure_events.resolved_at`,
 * `task_history.error->>'kind'`, `transcode_failure_events.outcome`) have all been
 * renamed or reshaped by past migrations, so "it typechecks" proves nothing here.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { listRecentFailures } from './transcode-failure-events.queries.js';
import { listRecentPluginFailures } from './plugin-failure-events.queries.js';
import { listRecentRunFailures } from './failure-patterns.queries.js';

const PLUGIN_ID = 'diagtest-plugin';
const TASK_ID = 'diagtest-task';
const SESSION = 'diagtest-session';

describe('diagnostics recent-failure listings', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM transcode_failure_events WHERE play_session_id = ${SESSION}`;
        await sql`DELETE FROM plugin_failure_events WHERE plugin_id = ${PLUGIN_ID}`;
        await sql`DELETE FROM task_history WHERE task_id = ${TASK_ID}`;
    });

    it('listRecentFailures returns terminal transcode failures newest-first and skips recovered ones', async () => {
        await sql`
            INSERT INTO transcode_failure_events
                (job_id, play_session_id, attempt, occurred_at, outcome, category, summary, encoder, argv)
            VALUES
                ('j1', ${SESSION}, 1, NOW() - INTERVAL '2 hours', 'retried', 'qsv_init', 'recovered one', 'h264_qsv', '{}'),
                ('j2', ${SESSION}, 2, NOW() - INTERVAL '1 hour',  'failed',  'qsv_init', 'older failure', 'h264_qsv', '{}'),
                ('j3', ${SESSION}, 3, NOW(),                      'spawn_failed', 'spawn', 'newest failure', NULL,    '{}')
        `;

        const rows = await listRecentFailures(sql, 10);
        const mine = rows.filter((r) => r.summary?.endsWith('failure'));

        expect(mine.map((r) => r.summary)).toEqual(['newest failure', 'older failure']);
        // `spawn_failed` must be included — it is a real terminal failure.
        expect(mine[0].category).toBe('spawn');
        expect(mine[0].encoder).toBeNull();
        expect(mine[0].occurred_at).toBeInstanceOf(Date);
        expect(rows.some((r) => r.summary === 'recovered one')).toBe(false);
    });

    it('listRecentPluginFailures returns unresolved rows across plugins, newest-first', async () => {
        await sql`
            INSERT INTO plugin_failure_events (plugin_id, item_id, reason, occurred_at, resolved_at)
            VALUES
                (${PLUGIN_ID}, 'item-a', 'older reason',   NOW() - INTERVAL '1 hour', NULL),
                (${PLUGIN_ID}, 'item-b', 'newest reason',  NOW(),                     NULL),
                (${PLUGIN_ID}, 'item-c', 'already fixed',  NOW(),                     NOW())
        `;

        const rows = await listRecentPluginFailures(sql, 100);
        const mine = rows.filter((r) => r.plugin_id === PLUGIN_ID);

        expect(mine.map((r) => r.reason)).toEqual(['newest reason', 'older reason']);
        expect(mine[0].occurred_at).toBeInstanceOf(Date);
    });

    it('listRecentRunFailures returns failed/cancelled runs with message + kind, newest-first', async () => {
        await sql`
            INSERT INTO task_history
                (id, task_id, label, state, input, trigger, actor, processing_version,
                 started_at, completed_at, error)
            VALUES
                ('diagtest-run-1', ${TASK_ID}, 'l', 'failed',    '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '1',
                 NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours', '{"message":"older boom","kind":"io"}'::jsonb),
                ('diagtest-run-2', ${TASK_ID}, 'l', 'cancelled', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '1',
                 NOW() - INTERVAL '1 hour',  NOW() - INTERVAL '1 hour',  '{"message":"newest boom"}'::jsonb),
                ('diagtest-run-3', ${TASK_ID}, 'l', 'completed', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '1',
                 NOW(),                      NOW(),                      NULL)
        `;

        const rows = await listRecentRunFailures(sql, 100);
        const mine = rows.filter((r) => r.taskId === TASK_ID);

        expect(mine.map((r) => r.message)).toEqual(['newest boom', 'older boom']);
        expect(mine[0].kind).toBeNull();
        expect(mine[1].kind).toBe('io');
        expect(mine[0].completedAt).toBeInstanceOf(Date);
    });

    it('honours the row cap', async () => {
        await sql`
            INSERT INTO plugin_failure_events (plugin_id, item_id, reason, occurred_at)
            SELECT ${PLUGIN_ID}, 'item-' || g, 'reason ' || g, NOW() - (g || ' minutes')::interval
              FROM generate_series(1, 5) g
        `;
        const rows = await listRecentPluginFailures(sql, 2);
        expect(rows).toHaveLength(2);
    });
});
