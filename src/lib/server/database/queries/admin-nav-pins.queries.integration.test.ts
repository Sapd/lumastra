// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Admin Nav Pins Query Module
 *
 * Tests getNavPins, addNavPin, and removeNavPin against a real PostgreSQL test database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';

// Import query functions to test
import { getNavPins, addNavPin, removeNavPin } from './admin-nav-pins.queries.js';

describe('Admin Nav Pins Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM admin_nav_pins WHERE href LIKE 'test-%'`;
    });

    // ========================================================================
    // getNavPins
    // ========================================================================

    describe('getNavPins', () => {
        it('returns empty array when no pins exist', async () => {
            const rows = await getNavPins.all(sql, {});
            // Filter totest-only rows to avoid interference
            const testRows = rows.filter((r) => r.href.startsWith('test-'));
            expect(testRows).toHaveLength(0);
        });

        it('returns pins ordered by sort_order', async () => {
            await addNavPin.execute(sql, { href: 'test-b', label: 'Beta' });
            await addNavPin.execute(sql, { href: 'test-a', label: 'Alpha' });

            const rows = await getNavPins.all(sql, {});
            const testRows = rows.filter((r) => r.href.startsWith('test-'));

            expect(testRows).toHaveLength(2);
            expect(testRows[0].href).toBe('test-b');
            expect(testRows[1].href).toBe('test-a');
        });
    });

    // ========================================================================
    // addNavPin
    // ========================================================================

    describe('addNavPin', () => {
        it('inserts a new pin with auto-increment sort_order', async () => {
            const result = await addNavPin.execute(sql, {
                href: 'test-link',
                label: 'Test Link',
            });

            expect(result.length).toBe(1);
            expect(result[0].href).toBe('test-link');
            expect(result[0].label).toBe('Test Link');
            expect(typeof result[0].sort_order).toBe('number');
        });

        it('updates label on conflict (same href)', async () => {
            await addNavPin.execute(sql, {
                href: 'test-dup',
                label: 'Original',
            });

            const result = await addNavPin.execute(sql, {
                href: 'test-dup',
                label: 'Updated',
            });

            expect(result.length).toBe(1);
            expect(result[0].label).toBe('Updated');
        });

        it('appends subsequent pins with higher sort_order', async () => {
            const first = await addNavPin.execute(sql, {
                href: 'test-first',
                label: 'First',
            });
            const second = await addNavPin.execute(sql, {
                href: 'test-second',
                label: 'Second',
            });

            expect(second[0].sort_order).toBeGreaterThan(first[0].sort_order);
        });
    });

    // ========================================================================
    // removeNavPin
    // ========================================================================

    describe('removeNavPin', () => {
        it('removes an existing pin and returns its href', async () => {
            await addNavPin.execute(sql, {
                href: 'test-rm',
                label: 'To Remove',
            });

            const result = await removeNavPin.execute(sql, {
                href: 'test-rm',
            });

            expect(result.length).toBe(1);
            expect(result[0].href).toBe('test-rm');

            const all = await getNavPins.all(sql, {});
            expect(all.some((r) => r.href === 'test-rm')).toBe(false);
        });

        it('returns empty array for non-existent href', async () => {
            const result = await removeNavPin.execute(sql, {
                href: 'test-no-exist-999',
            });
            expect(result).toHaveLength(0);
        });
    });
});
