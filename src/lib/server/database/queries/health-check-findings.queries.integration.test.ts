// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Health Check Findings Query Module
 *
 * Tests upsertFinding and listFindings against the health_check_findings table.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';

import { upsertFinding, listFindings } from './health-check-findings.queries.js';
import type {
    Invariant,
    InvariantDetailLink,
} from '$lib/server/services/health-invariants/invariants.js';

describe('Health Check Findings Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['health_check_findings']);
    });

    function makeInvariant(overrides: Partial<Invariant> = {}): Invariant {
        return {
            id: overrides.id ?? 'test-invariant-001',
            label: overrides.label ?? 'Test Invariant',
            description: overrides.description ?? 'A test invariant for testing',
            remediation: overrides.remediation ?? 'Fix the test',
            thresholdAmber: overrides.thresholdAmber ?? 10,
            thresholdRed: overrides.thresholdRed ?? 100,
            query: overrides.query ?? (async () => 0),
        };
    }

    // ========================================================================
    // upsertFinding
    // ========================================================================

    describe('upsertFinding', () => {
        it('inserts a new finding row', async () => {
            const invariant = makeInvariant();
            await upsertFinding(sql, invariant, 5, 'green');

            const rows = await listFindings(sql);
            expect(rows).toHaveLength(1);
            expect(rows[0].invariant_id).toBe('test-invariant-001');
            expect(rows[0].status).toBe('green');
            expect(rows[0].value).toBe(5);
            expect(rows[0].label).toBe('Test Invariant');
        });

        it('updates status on conflict', async () => {
            const invariant = makeInvariant();
            await upsertFinding(sql, invariant, 5, 'green');
            await upsertFinding(sql, invariant, 50, 'amber');

            const rows = await listFindings(sql);
            expect(rows).toHaveLength(1);
            expect(rows[0].status).toBe('amber');
            expect(rows[0].value).toBe(50);
        });

        it('updates last_change_at only when status transitions', async () => {
            const invariant = makeInvariant();
            await upsertFinding(sql, invariant, 5, 'green');

            const firstRows = await listFindings(sql);
            const firstChangeAt = firstRows[0].last_change_at;

            // Small delay to ensure timestamp could differ
            await new Promise((r) => setTimeout(r, 50));

            // Same status — last_change_at should NOT update
            await upsertFinding(sql, invariant, 10, 'green');

            const secondRows = await listFindings(sql);
            expect(secondRows[0].last_change_at).toEqual(firstChangeAt);
            expect(secondRows[0].value).toBe(10);
            expect(secondRows[0].last_run_at).not.toEqual(firstRows[0].last_run_at);
        });

        it('updates last_change_at when status changes', async () => {
            const invariant = makeInvariant();
            await upsertFinding(sql, invariant, 5, 'green');

            const firstRows = await listFindings(sql);
            const firstChangeAt = firstRows[0].last_change_at;

            // Small delay
            await new Promise((r) => setTimeout(r, 50));

            await upsertFinding(sql, invariant, 50, 'amber');

            const secondRows = await listFindings(sql);
            expect(secondRows[0].last_change_at).not.toEqual(firstChangeAt);
        });

        it('stores error message truncated to 500 chars', async () => {
            const invariant = makeInvariant();
            const longError = 'x'.repeat(600);
            await upsertFinding(sql, invariant, 5, 'red', longError);

            const rows = await listFindings(sql);
            expect(rows[0].error).toHaveLength(500);
            expect(rows[0].error).toBe('x'.repeat(500));
        });

        it('stores null value when value is null', async () => {
            const invariant = makeInvariant();
            await upsertFinding(sql, invariant, null, 'unknown');

            const rows = await listFindings(sql);
            expect(rows[0].value).toBeNull();
        });

        it('inserts multiple findings with different invariant_ids', async () => {
            await upsertFinding(sql, makeInvariant({ id: 'inv-1' }), 1, 'green');
            await upsertFinding(sql, makeInvariant({ id: 'inv-2' }), 2, 'amber');

            const rows = await listFindings(sql);
            expect(rows).toHaveLength(2);
        });

        it('round-trips the details column (per-target deep links)', async () => {
            const invariant = makeInvariant();
            const details: InvariantDetailLink[] = [
                {
                    label: 'Media Probe',
                    sublabel: 'file.probed',
                    count: 1234,
                    href: '/admin/tasks/media-probe?tab=failures',
                },
                { label: 'unregistered-stage-id', count: 5 },
            ];
            await upsertFinding(sql, invariant, 1239, 'red', undefined, details);

            const rows = await listFindings(sql);
            expect(rows[0].details).toEqual(details);
        });

        it('stores null details when omitted', async () => {
            const invariant = makeInvariant();
            await upsertFinding(sql, invariant, 5, 'green');

            const rows = await listFindings(sql);
            expect(rows[0].details).toBeNull();
        });

        it('stores null details when an empty array is passed', async () => {
            const invariant = makeInvariant();
            await upsertFinding(sql, invariant, 5, 'green', undefined, []);

            const rows = await listFindings(sql);
            expect(rows[0].details).toBeNull();
        });

        it('overwrites details on conflict', async () => {
            const invariant = makeInvariant();
            await upsertFinding(sql, invariant, 5, 'amber', undefined, [{ label: 'First' }]);
            await upsertFinding(sql, invariant, 10, 'amber', undefined, [
                { label: 'Second', count: 2 },
            ]);

            const rows = await listFindings(sql);
            expect(rows[0].details).toEqual([{ label: 'Second', count: 2 }]);
        });
    });

    // ========================================================================
    // listFindings
    // ========================================================================

    describe('listFindings', () => {
        it('orders by severity: red first, then amber, unknown, green', async () => {
            await upsertFinding(sql, makeInvariant({ id: 'green-1' }), 1, 'green');
            await upsertFinding(sql, makeInvariant({ id: 'amber-1' }), 2, 'amber');
            await upsertFinding(sql, makeInvariant({ id: 'red-1' }), 3, 'red');
            await upsertFinding(sql, makeInvariant({ id: 'unknown-1' }), 4, 'unknown');

            const rows = await listFindings(sql);
            const statuses = rows.map((r) => r.status);

            expect(statuses).toEqual(['red', 'amber', 'unknown', 'green']);
        });

        it('sorts alphabetically by label within same status', async () => {
            await upsertFinding(sql, makeInvariant({ id: 'a1', label: 'Zebra' }), 1, 'green');
            await upsertFinding(sql, makeInvariant({ id: 'a2', label: 'Alpha' }), 2, 'green');
            await upsertFinding(sql, makeInvariant({ id: 'a3', label: 'Beta' }), 3, 'green');

            const rows = await listFindings(sql);
            const labels = rows.map((r) => r.label);

            expect(labels).toEqual(['Alpha', 'Beta', 'Zebra']);
        });

        it('returns empty array when no findings exist', async () => {
            const rows = await listFindings(sql);
            expect(rows).toEqual([]);
        });

        it('includes all expected columns', async () => {
            const invariant = makeInvariant();
            await upsertFinding(sql, invariant, 42, 'amber');

            const rows = await listFindings(sql);
            const row = rows[0];

            expect(row).toHaveProperty('invariant_id');
            expect(row).toHaveProperty('status');
            expect(row).toHaveProperty('value');
            expect(row).toHaveProperty('label');
            expect(row).toHaveProperty('description');
            expect(row).toHaveProperty('remediation');
            expect(row).toHaveProperty('threshold_amber');
            expect(row).toHaveProperty('threshold_red');
            expect(row).toHaveProperty('last_run_at');
            expect(row).toHaveProperty('last_change_at');
            expect(row).toHaveProperty('last_value_at');
            expect(row).toHaveProperty('error');
            expect(row).toHaveProperty('details');
        });
    });
});
