// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Integrity Violations Query Module
 *
 * Tests recordViolation, clearViolation, resolveViolationById,
 * listOpenViolations, countOpenViolationsByRule, and reconcileViolationsForRule.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';

import {
    recordViolation,
    clearViolation,
    resolveViolationById,
    listOpenViolations,
    countOpenViolationsByRule,
    summarizeOpenViolationsByRule,
    reconcileViolationsForRule,
} from './integrity-violations.queries.js';

describe('Integrity Violations Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['integrity_violations']);
    });

    it('summarizes counts and highest open severity, ignoring resolved violations', async () => {
        await recordViolation(sql, { rule: 'backlog', severity: 'low' });
        await recordViolation(sql, {
            rule: 'mixed',
            severity: 'low',
            mediaId: crypto.randomUUID(),
        });
        await recordViolation(sql, {
            rule: 'mixed',
            severity: 'high',
            mediaId: crypto.randomUUID(),
        });
        const resolved = await recordViolation(sql, {
            rule: 'backlog',
            severity: 'critical',
            mediaId: crypto.randomUUID(),
        });
        await resolveViolationById(sql, resolved, 'test');
        expect(await summarizeOpenViolationsByRule(sql)).toEqual({
            counts: { backlog: 1, mixed: 2 },
            severities: { backlog: 'low', mixed: 'high' },
        });
    });

    // ========================================================================
    // recordViolation
    // ========================================================================

    describe('recordViolation', () => {
        it('inserts a new violation and returns its id', async () => {
            const id = await recordViolation(sql, {
                rule: 'duplicate-artist',
                severity: 'medium',
                mediaId: null,
                details: { artistName: 'Test Artist' },
            });

            expect(id).toBeTruthy();
            const rows = await sql`SELECT * FROM integrity_violations`;
            expect(rows).toHaveLength(1);
            expect(rows[0].rule).toBe('duplicate-artist');
            expect(rows[0].severity).toBe('medium');
        });

        it('upserts existing open violation instead of inserting duplicate', async () => {
            const firstId = await recordViolation(sql, {
                rule: 'test-rule',
                severity: 'low',
                mediaId: '00000000-0000-0000-0000-000000000001',
                details: { info: 'first' },
            });

            const secondId = await recordViolation(sql, {
                rule: 'test-rule',
                severity: 'high',
                mediaId: '00000000-0000-0000-0000-000000000001',
                details: { info: 'second' },
            });

            expect(secondId).toBe(firstId);

            const rows = await sql`SELECT * FROM integrity_violations`;
            expect(rows).toHaveLength(1);
            expect(rows[0].severity).toBe('high');
            expect(rows[0].details).toEqual({ info: 'second' });
        });

        it('inserts new row when resolved row exists for same rule+mediaId', async () => {
            const mediaId = '00000000-0000-0000-0000-000000000002';

            const firstId = await recordViolation(sql, {
                rule: 'reoccurring-rule',
                severity: 'low',
                mediaId,
            });

            // Resolve it
            await clearViolation(sql, { rule: 'reoccurring-rule', mediaId });

            // Now record again — should be a NEW row
            const secondId = await recordViolation(sql, {
                rule: 'reoccurring-rule',
                severity: 'high',
                mediaId,
            });

            expect(secondId).not.toBe(firstId);

            const rows = await sql`SELECT * FROM integrity_violations ORDER BY detected_at`;
            expect(rows).toHaveLength(2);
        });

        it('handles global rule (null mediaId)', async () => {
            const id = await recordViolation(sql, {
                rule: 'global-backlog',
                severity: 'critical',
            });

            expect(id).toBeTruthy();
            const rows = await sql`SELECT * FROM integrity_violations`;
            expect(rows[0].media_id).toBeNull();
        });
    });

    // ========================================================================
    // clearViolation
    // ========================================================================

    describe('clearViolation', () => {
        it('resolves an open violation and returns 1', async () => {
            await recordViolation(sql, {
                rule: 'clear-test',
                severity: 'medium',
                mediaId: '00000000-0000-0000-0000-000000000003',
            });

            const resolved = await clearViolation(sql, {
                rule: 'clear-test',
                mediaId: '00000000-0000-0000-0000-000000000003',
            });

            expect(resolved).toBe(1);

            const rows = await sql`SELECT * FROM integrity_violations`;
            expect(rows[0].resolved_at).not.toBeNull();
        });

        it('returns 0 when no matching open violation exists', async () => {
            const resolved = await clearViolation(sql, {
                rule: 'no-such-rule',
                mediaId: '00000000-0000-0000-0000-000000000999',
            });
            expect(resolved).toBe(0);
        });

        it('uses default resolution text', async () => {
            await recordViolation(sql, {
                rule: 'default-res-test',
                severity: 'low',
            });

            await clearViolation(sql, { rule: 'default-res-test' });

            const rows = await sql`SELECT * FROM integrity_violations`;
            expect(rows[0].resolution).toBe('auto-resolved by scanner');
        });

        it('accepts custom resolution text', async () => {
            await recordViolation(sql, {
                rule: 'custom-res-test',
                severity: 'low',
            });

            await clearViolation(sql, {
                rule: 'custom-res-test',
                resolution: 'admin resolved',
            });

            const rows = await sql`SELECT * FROM integrity_violations`;
            expect(rows[0].resolution).toBe('admin resolved');
        });
    });

    // ========================================================================
    // resolveViolationById
    // ========================================================================

    describe('resolveViolationById', () => {
        it('resolves violation by UUID', async () => {
            const id = await recordViolation(sql, {
                rule: 'by-id-test',
                severity: 'high',
            });

            await resolveViolationById(sql, id, 'manually resolved');

            const rows = await sql`SELECT * FROM integrity_violations`;
            expect(rows[0].resolved_at).not.toBeNull();
            expect(rows[0].resolution).toBe('manually resolved');
        });

        it('throws when row does not exist', async () => {
            await expect(
                resolveViolationById(sql, '00000000-0000-0000-0000-000000000000', 'test'),
            ).rejects.toThrow('Integrity violation already resolved or not found');
        });

        it('throws when row is already resolved', async () => {
            const id = await recordViolation(sql, {
                rule: 'already-resolved',
                severity: 'low',
            });
            await resolveViolationById(sql, id, 'first');

            await expect(resolveViolationById(sql, id, 'second')).rejects.toThrow(
                'Integrity violation already resolved or not found',
            );
        });
    });

    // ========================================================================
    // listOpenViolations
    // ========================================================================

    describe('listOpenViolations', () => {
        it('lists only unresolved violations', async () => {
            await recordViolation(sql, { rule: 'open-1', severity: 'low' });
            await recordViolation(sql, { rule: 'open-2', severity: 'medium' });
            await recordViolation(sql, { rule: 'closed', severity: 'high' });
            await clearViolation(sql, { rule: 'closed' });

            const rows = await listOpenViolations(sql);
            const rules = rows.map((r) => r.rule);

            expect(rules).toContain('open-1');
            expect(rules).toContain('open-2');
            expect(rules).not.toContain('closed');
        });

        it('filters by rule', async () => {
            await recordViolation(sql, { rule: 'rule-a', severity: 'low' });
            await recordViolation(sql, { rule: 'rule-b', severity: 'medium' });

            const rows = await listOpenViolations(sql, { rule: 'rule-a' });
            expect(rows).toHaveLength(1);
            expect(rows[0].rule).toBe('rule-a');
        });

        it('filters by severity', async () => {
            await recordViolation(sql, { rule: 'sev-low', severity: 'low' });
            await recordViolation(sql, { rule: 'sev-high', severity: 'high' });

            const rows = await listOpenViolations(sql, { severity: 'high' });
            expect(rows).toHaveLength(1);
            expect(rows[0].rule).toBe('sev-high');
        });

        it('applies limit and clamps to [1, 1000]', async () => {
            for (let i = 0; i < 5; i++) {
                await recordViolation(sql, {
                    rule: `limit-${i}`,
                    severity: 'low',
                });
            }

            const rows = await listOpenViolations(sql, { limit: 2 });
            expect(rows).toHaveLength(2);
        });

        it('sorts newest first', async () => {
            await recordViolation(sql, { rule: 'older', severity: 'low' });
            await new Promise((r) => setTimeout(r, 50));
            await recordViolation(sql, { rule: 'newer', severity: 'low' });

            const rows = await listOpenViolations(sql);
            expect(rows[0].rule).toBe('newer');
            expect(rows[1].rule).toBe('older');
        });
    });

    // ========================================================================
    // countOpenViolationsByRule
    // ========================================================================

    describe('countOpenViolationsByRule', () => {
        it('counts open violations grouped by rule', async () => {
            await recordViolation(sql, {
                rule: 'dup-rule',
                severity: 'low',
                mediaId: '00000000-0000-0000-0000-000000000010',
            });
            await recordViolation(sql, {
                rule: 'dup-rule',
                severity: 'medium',
                mediaId: '00000000-0000-0000-0000-000000000011',
            });
            await recordViolation(sql, {
                rule: 'other-rule',
                severity: 'high',
            });

            const counts = await countOpenViolationsByRule(sql);

            expect(counts['dup-rule']).toBe(2);
            expect(counts['other-rule']).toBe(1);
        });

        it('returns empty object when no violations', async () => {
            const counts = await countOpenViolationsByRule(sql);
            expect(counts).toEqual({});
        });

        it('does not count resolved violations', async () => {
            await recordViolation(sql, {
                rule: 'resolved-count',
                severity: 'low',
            });
            await clearViolation(sql, { rule: 'resolved-count' });

            const counts = await countOpenViolationsByRule(sql);
            expect(counts['resolved-count']).toBeUndefined();
        });
    });

    // ========================================================================
    // reconcileViolationsForRule
    // ========================================================================

    describe('reconcileViolationsForRule', () => {
        it('resolves open violations not in keepMediaIds', async () => {
            await recordViolation(sql, {
                rule: 'reconcile-test',
                severity: 'low',
                mediaId: '00000000-0000-0000-0000-000000000020',
            });
            await recordViolation(sql, {
                rule: 'reconcile-test',
                severity: 'low',
                mediaId: '00000000-0000-0000-0000-000000000021',
            });

            const resolved = await reconcileViolationsForRule(
                sql,
                'reconcile-test',
                ['00000000-0000-0000-0000-000000000020'],
                false,
            );

            expect(resolved).toBe(1);

            const open = await listOpenViolations(sql, {
                rule: 'reconcile-test',
            });
            expect(open).toHaveLength(1);
        });

        it('resolves all when keepMediaIds is empty and keepGlobal is false', async () => {
            await recordViolation(sql, {
                rule: 'reconcile-all',
                severity: 'low',
                mediaId: '00000000-0000-0000-0000-000000000030',
            });
            await recordViolation(sql, {
                rule: 'reconcile-all',
                severity: 'low',
                mediaId: '00000000-0000-0000-0000-000000000031',
            });

            const resolved = await reconcileViolationsForRule(sql, 'reconcile-all', [], false);

            expect(resolved).toBe(2);

            const open = await listOpenViolations(sql, {
                rule: 'reconcile-all',
            });
            expect(open).toHaveLength(0);
        });

        it('keeps global rule when keepGlobal is true', async () => {
            await recordViolation(sql, {
                rule: 'reconcile-global',
                severity: 'low',
            });

            const resolved = await reconcileViolationsForRule(sql, 'reconcile-global', [], true);

            expect(resolved).toBe(0);

            const open = await listOpenViolations(sql, {
                rule: 'reconcile-global',
            });
            expect(open).toHaveLength(1);
        });

        it('resolves global rule when keepGlobal is false', async () => {
            await recordViolation(sql, {
                rule: 'reconcile-global-off',
                severity: 'low',
            });

            const resolved = await reconcileViolationsForRule(
                sql,
                'reconcile-global-off',
                [],
                false,
            );

            expect(resolved).toBe(1);
        });
    });
});
