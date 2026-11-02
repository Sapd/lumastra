// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for buildComponentHealth() parity (Slice 0 §9).
 *
 * Guards against the Theme-F drift this consolidation is meant to prevent: the
 * extracted helper must keep returning the same SHAPE the old
 * /api/health/components route produced (timestamp + per-component blocks).
 *
 * Requires TEST_DATABASE_URL (lumastra_tests). The helper reads from getDb(),
 * which derives its pool from DATABASE_URL — so we point DATABASE_URL at the
 * test DB for the duration of this suite. Valkey is optional: when CACHE_URL is
 * set the valkey/pendingWriteDrain blocks are exercised too, otherwise they
 * report `not configured`, which is still a valid shape.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
    getTestDb,
    getTestDatabaseUrl,
} from '../../../../tests/integration/setup/test-database.js';
import { OUTBOX_RETIRED_ERROR_PREFIX } from '../tasks/webhook-outbox.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? getTestDatabaseUrl();
const RUN = Boolean(TEST_DATABASE_URL);

describe.runIf(RUN)('buildComponentHealth() parity', () => {
    let originalDbUrl: string | undefined;

    beforeAll(() => {
        // getDb() reads DATABASE_URL at call time via process.env — point it at
        // the test database so the helper's `SELECT 1` and webhook-outbox
        // queries run against lumastra_tests, not production.
        originalDbUrl = process.env.DATABASE_URL;
        process.env.DATABASE_URL = TEST_DATABASE_URL;
    });

    afterAll(() => {
        if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = originalDbUrl;
    });

    it('returns the timestamp + per-component shape (status vocab)', async () => {
        // Import after DATABASE_URL is set so the connection module picks it up.
        const { buildComponentHealth } = await import('./component-health.js');
        const report = await buildComponentHealth();

        // Same top-level contract as the original route.
        expect(typeof report.timestamp).toBe('string');

        // database component is present, uses status vocab, and passes against test DB.
        const db = report.database as { status?: string } | undefined;
        expect(db).toBeDefined();
        expect(db?.status).toBe('pass');

        // webhookOutbox is queried against task_history-adjacent tables — the
        // shape (status + counts) must be present even when empty.
        const outbox = report.webhookOutbox as
            { status?: string; pending?: number; dead?: number } | undefined;
        expect(outbox).toBeDefined();
        expect(['pass', 'warn', 'fail']).toContain(outbox?.status);
        expect(typeof outbox?.pending).toBe('number');
        expect(typeof outbox?.dead).toBe('number');

        // orchestrator block always reports a status (or a reason on error).
        const orch = report.orchestrator as { status?: string; reason?: string } | undefined;
        expect(orch).toBeDefined();
        expect(typeof orch?.status === 'string' || typeof orch?.reason === 'string').toBe(true);
    });

    // `dead = true` is written both by a real delivery failure and by the
    // outbox's administrative retirements (feature flag off, owner account
    // disabled). Only the first is a fault. Counting both meant disabling one
    // user parked a "Webhook delivery degraded" warning in the admin attention
    // panel until the row aged out of the 30-day retention window.
    describe('webhookOutbox dead vs retired', () => {
        // Deterministic `created_by` marker rather than a per-run UUID: cleanup
        // has to be able to find rows a PREVIOUS run left behind when it failed
        // before its afterAll. Keyed on a fresh uuid each run, those rows were
        // unreachable and silently inflated every later run's baseline.
        const CREATED_BY = 'component-health-retired-split-test';
        const hookId = randomUUID();

        async function seed(rows: { dead: boolean; lastError: string | null }[]): Promise<void> {
            const sql = getTestDb();
            await sql`
                INSERT INTO task_webhook_hooks (id, url, secret_encrypted, event_filter, created_by)
                VALUES (${hookId}::uuid, 'https://example.invalid/h', '\\x00'::bytea,
                        '[]'::jsonb, ${CREATED_BY})
                ON CONFLICT (id) DO NOTHING
            `;
            for (const r of rows) {
                await sql`
                    INSERT INTO task_webhook_outbox
                        (hook_id, event_id, payload, next_attempt_at, dead, last_error)
                    VALUES (${hookId}::uuid, ${`evt-${randomUUID()}`}, '{}'::jsonb, NOW(),
                            ${r.dead}, ${r.lastError})
                `;
            }
        }

        async function cleanup(): Promise<void> {
            const sql = getTestDb();
            await sql`
                DELETE FROM task_webhook_outbox
                WHERE hook_id IN (SELECT id FROM task_webhook_hooks WHERE created_by = ${CREATED_BY})
            `;
            await sql`DELETE FROM task_webhook_hooks WHERE created_by = ${CREATED_BY}`;
        }

        interface OutboxBlock {
            status: string;
            dead: number;
            retired: number;
        }

        // `buildComponentHealth()` memoises its result for
        // COMPONENT_HEALTH_TTL_MS (1500ms) to collapse the several near-
        // simultaneous calls one attention-derive cycle makes. Two probes
        // inside that window return the SAME object, so a naive
        // seed-then-reprobe compares a reading against itself and every delta
        // is 0 — which looks exactly like "the split doesn't work". Wait the
        // window out so each probe is a real read.
        const HEALTH_CACHE_TTL_MS = 1500;
        async function probe(): Promise<OutboxBlock> {
            await new Promise((r) => setTimeout(r, HEALTH_CACHE_TTL_MS + 250));
            const { buildComponentHealth } = await import('./component-health.js');
            return (await buildComponentHealth()).webhookOutbox as unknown as OutboxBlock;
        }

        // `lumastra_tests` is shared and these counts are table-wide, so every
        // assertion below is a DELTA against a baseline read in the same test.
        // Asserting absolute counts would depend on whichever suites ran first.
        beforeEach(cleanup);
        afterAll(cleanup);

        it('counts retired rows separately and does not let them fail the component', async () => {
            const base = await probe();

            await seed([
                { dead: true, lastError: `${OUTBOX_RETIRED_ERROR_PREFIX}owner disabled` },
                { dead: true, lastError: `${OUTBOX_RETIRED_ERROR_PREFIX}feature off` },
            ]);
            const after = await probe();

            expect(after.retired).toBe(base.retired + 2);
            // The whole point: two retirements added ZERO to the fault count,
            // so a component that was passing is still passing.
            expect(after.dead).toBe(base.dead);
            if (base.status === 'pass') expect(after.status).toBe('pass');
        });

        it('still fails the component for a genuine delivery failure', async () => {
            // Positive control. Without it, the test above would pass just as
            // happily if the probe had stopped counting dead rows at all.
            const base = await probe();

            await seed([{ dead: true, lastError: 'connect ECONNREFUSED 10.0.0.1:443' }]);
            const after = await probe();

            expect(after.dead).toBe(base.dead + 1);
            expect(after.retired).toBe(base.retired);
            expect(after.status).toBe('fail');
        });

        it('counts a dead row with no last_error as a failure, not a retirement', async () => {
            // NULL last_error must land on the fault side: the marker is what
            // makes a row a retirement, and its ABSENCE must never be read as
            // one, or an unexplained dead row would silently stop alerting.
            const base = await probe();

            await seed([{ dead: true, lastError: null }]);
            const after = await probe();

            expect(after.dead).toBe(base.dead + 1);
            expect(after.retired).toBe(base.retired);
        });
    });
});
