// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the install-identity query against a real PostgreSQL
 * test database. Verifies the singleton install UUID is stable across calls and
 * that the table genuinely permits only one row.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    getInstallUuid,
    observeInstallClock,
    CLOCK_MAX_ADVANCE_MS,
} from './license-install.queries.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';

describe('license install identity', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    it('returns a valid UUID', async () => {
        const uuid = await getInstallUuid(sql);
        expect(uuid).toMatch(UUID_RE);
    });

    it('returns the SAME UUID across calls (stable per deployment)', async () => {
        const a = await getInstallUuid(sql);
        const b = await getInstallUuid(sql);
        expect(b).toBe(a);
    });

    it('holds exactly one row', async () => {
        await getInstallUuid(sql);
        const [{ count }] = await sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count FROM license_install
        `;
        expect(count).toBe('1');
    });

    // Shadow the singleton with its real schema, leaving deployment identity untouched.
    async function withClock(test: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> {
        await sql.begin(async (tx) => {
            await tx`CREATE TEMP TABLE license_install
                (LIKE public.license_install INCLUDING ALL) ON COMMIT DROP`;
            await getInstallUuid(tx);
            await test(tx);
        });
    }

    it('initialises a NULL clock to the supplied current time', async () => {
        await withClock(async (tx) => {
            const nowIso = '2026-10-09T12:34:56.789Z';
            const clock = await observeInstallClock(tx, nowIso);
            expect(clock.effectiveNowMs).toBe(Date.parse(nowIso));
            const [row] = await tx<{ time_reference: Date }[]>`
                SELECT time_reference FROM license_install WHERE singleton = true
            `;
            expect(row.time_reference.getTime()).toBe(Date.parse(nowIso));
        });
    });

    it('initialises the NULL clock after reseeding a missing row', async () => {
        await withClock(async (tx) => {
            await tx`DELETE FROM license_install`;
            const nowIso = '2026-10-09T12:34:56.789Z';
            const clock = await observeInstallClock(tx, nowIso);
            expect(clock.installUuid).toMatch(UUID_RE);
            expect(clock.effectiveNowMs).toBe(Date.parse(nowIso));
            const [row] = await tx<{ install_uuid: string; time_reference: Date }[]>`
                SELECT install_uuid, time_reference FROM license_install WHERE singleton = true
            `;
            expect(row.install_uuid).toBe(clock.installUuid);
            expect(row.time_reference.getTime()).toBe(Date.parse(nowIso));
        });
    });

    it('observeInstallClock never moves an initialised time mark backwards', async () => {
        await withClock(async (tx) => {
            const ahead = '2026-10-09T12:00:00Z';
            await tx`UPDATE license_install SET time_reference = ${ahead}::timestamptz`;
            const clock = await observeInstallClock(tx, '2026-10-09T11:00:00Z');
            expect(clock.effectiveNowMs).toBe(Date.parse(ahead));
        });
    });

    it.each([0, 60 * 60 * 1000, CLOCK_MAX_ADVANCE_MS])(
        'preserves an ordinary initialised-clock advance of %s ms',
        async (advanceMs) => {
            await withClock(async (tx) => {
                const baseMs = Date.parse('2026-10-09T12:00:00Z');
                await tx`UPDATE license_install SET time_reference = ${new Date(baseMs).toISOString()}::timestamptz`;
                const clock = await observeInstallClock(
                    tx,
                    new Date(baseMs + advanceMs).toISOString(),
                );
                expect(clock.effectiveNowMs).toBe(baseMs + advanceMs);
            });
        },
    );

    it('caps large forward jumps at six hours once initialised', async () => {
        await withClock(async (tx) => {
            const baseMs = Date.parse('2026-10-09T12:00:00Z');
            await tx`UPDATE license_install SET time_reference = ${new Date(baseMs).toISOString()}::timestamptz`;
            const capped = await observeInstallClock(
                tx,
                new Date(baseMs + 8 * 60 * 60 * 1000).toISOString(),
            );
            expect(capped.effectiveNowMs).toBe(baseMs + CLOCK_MAX_ADVANCE_MS);
            const afterNormal = await observeInstallClock(tx, new Date(baseMs).toISOString());
            expect(afterNormal.effectiveNowMs).toBe(capped.effectiveNowMs);
            const caughtUp = await observeInstallClock(
                tx,
                new Date(baseMs + 8 * 60 * 60 * 1000).toISOString(),
            );
            expect(caughtUp.effectiveNowMs).toBe(baseMs + 8 * 60 * 60 * 1000);
        });
    });

    it('refuses a second row (singleton CHECK + PK)', async () => {
        await getInstallUuid(sql);
        // A second seed attempt must be a no-op (conflict on the singleton PK),
        // never a second row.
        await sql`INSERT INTO license_install (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING`;
        const [{ count }] = await sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count FROM license_install
        `;
        expect(count).toBe('1');
    });
});
