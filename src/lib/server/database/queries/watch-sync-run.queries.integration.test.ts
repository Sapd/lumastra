// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the user-scoped `watch-sync-manual` run lookups.
 *
 * Verifies `getLatestManualRunId` resolves the newest run for a
 * (userId, provider) pair from `task_history.scope`/`input` JSONB, and that
 * `assertRunOwnedBy` only affirms ownership for the actual owning user.
 *
 * Run with: npm run test:integration src/lib/server/database/queries/watch-sync-run.queries.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { getLatestManualRunId, assertRunOwnedBy } from './watch-sync-run.queries.js';

interface SeedRunOptions {
    id: string;
    userId: string;
    provider: string;
    direction?: 'push' | 'pull';
    startedAt: Date;
    state?: string;
}

async function seedManualRun(sql: postgres.Sql, opts: SeedRunOptions): Promise<void> {
    await sql`
        INSERT INTO task_history (
            id, task_id, label, state, input, scope, trigger, actor, started_at, processing_version
        ) VALUES (
            ${opts.id},
            'watch-sync-manual',
            'Manual watch sync',
            ${opts.state ?? 'completed'},
            ${sql.json({ userId: opts.userId, provider: opts.provider, direction: opts.direction ?? 'pull' })},
            ${sql.json({ userId: opts.userId })},
            ${sql.json({ kind: 'user-request', sourceRoute: 'test-seed' })},
            ${sql.json({ kind: 'user', userId: opts.userId })},
            ${opts.startedAt},
            '1'
        )
    `;
}

describe('watch-sync-run queries', () => {
    let sql: postgres.Sql;
    const userA = `user-a-${Date.now()}`;
    const userB = `user-b-${Date.now()}`;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['task_history']);
    });

    describe('getLatestManualRunId', () => {
        it('returns the newest run for the (userId, provider) pair', async () => {
            const older = `run-older-${Date.now()}`;
            const newer = `run-newer-${Date.now()}`;
            await seedManualRun(sql, {
                id: older,
                userId: userA,
                provider: 'mal',
                startedAt: new Date('2026-01-01T00:00:00Z'),
            });
            await seedManualRun(sql, {
                id: newer,
                userId: userA,
                provider: 'mal',
                startedAt: new Date('2026-06-01T00:00:00Z'),
            });

            const result = await getLatestManualRunId(sql, userA, 'mal');
            expect(result).toBe(newer);
        });

        it('scopes strictly by userId — does not return another user’s run', async () => {
            const runB = `run-b-${Date.now()}`;
            await seedManualRun(sql, {
                id: runB,
                userId: userB,
                provider: 'mal',
                startedAt: new Date('2026-06-01T00:00:00Z'),
            });

            expect(await getLatestManualRunId(sql, userA, 'mal')).toBeNull();
        });

        it('scopes strictly by provider — a run for a different provider is not matched', async () => {
            await seedManualRun(sql, {
                id: `run-trakt-${Date.now()}`,
                userId: userA,
                provider: 'trakt',
                startedAt: new Date('2026-06-01T00:00:00Z'),
            });

            expect(await getLatestManualRunId(sql, userA, 'mal')).toBeNull();
        });

        it('returns null when the user has no runs at all', async () => {
            expect(await getLatestManualRunId(sql, userA, 'mal')).toBeNull();
        });
    });

    describe('assertRunOwnedBy', () => {
        it('is true for the owning user and false for a different user', async () => {
            const runA = `run-owned-${Date.now()}`;
            await seedManualRun(sql, {
                id: runA,
                userId: userA,
                provider: 'mal',
                startedAt: new Date('2026-06-01T00:00:00Z'),
            });

            expect(await assertRunOwnedBy(sql, runA, userA)).toBe(true);
            expect(await assertRunOwnedBy(sql, runA, userB)).toBe(false);
        });

        it('is false for a run id that does not exist', async () => {
            expect(await assertRunOwnedBy(sql, 'no-such-run-id', userA)).toBe(false);
        });

        it('is false for a run owned by the user but of a different task type', async () => {
            // A user owns many kinds of task runs (e.g. a library scan). Passing
            // one such run's id to the watch-sync cancel/status gate must NOT
            // pass — the gate is scoped to watch-sync-manual runs only.
            const scanRun = `scan-run-${Date.now()}`;
            await sql`
                INSERT INTO task_history (
                    id, task_id, label, state, input, scope, trigger, actor,
                    started_at, processing_version
                ) VALUES (
                    ${scanRun},
                    'file-library-scan',
                    'Library scan',
                    'completed',
                    ${sql.json({ userId: userA })},
                    ${sql.json({ userId: userA })},
                    ${sql.json({ kind: 'user-request', sourceRoute: 'test-seed' })},
                    ${sql.json({ kind: 'user', userId: userA })},
                    ${new Date('2026-06-01T00:00:00Z')},
                    '1'
                )
            `;

            expect(await assertRunOwnedBy(sql, scanRun, userA)).toBe(false);
        });
    });
});
