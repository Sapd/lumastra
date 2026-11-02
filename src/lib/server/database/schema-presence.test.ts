// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test — boot-time schema presence check (Test 5).
 *
 * TODO: A boot-time schema guard does not currently exist in connection.ts or
 * migrate-schema.ts. This test is written as .skip so the file is valid on
 * commit. Once the guard is added — a function like `assertRequiredTables(sql)`
 * that queries `information_schema.tables` for the critical tables and throws a
 * clear error when any are absent — remove the .skip and uncomment the import.
 *
 * The guard should:
 *   - Query `information_schema.tables` (or `pg_class`) for each critical table.
 *   - Throw `Error("missing required table: <name>")` for the first absent table.
 *   - Be called early in `hooks.server.ts` before any other DB access.
 *
 * Critical tables (minimum set):
 *   plugin_settings, task_history, task_runs (if it exists), plugin_secrets,
 *   plugin_user_credentials
 */

import { describe, it, expect, vi } from 'vitest';
import type { Sql } from 'postgres';

// ── Placeholder import (uncomment when the function exists) ───────────────────
// import { assertRequiredTables } from './connection.js';

describe('assertRequiredTables — boot-time schema guard', () => {
    it.skip('throws with "missing required table: plugin_settings" when plugin_settings is absent', async () => {
        // Arrange: mock postgres.Sql to return empty rows for plugin_settings.
        const _mockSql = vi
            .fn()
            .mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
                // Detect when querying for plugin_settings in pg_class or information_schema.
                const query = strings.join('?');
                if (query.includes('plugin_settings') || values.includes('plugin_settings')) {
                    return Promise.resolve([]); // table not found
                }
                return Promise.resolve([{ table_name: 'task_history' }]);
            }) as unknown as Sql;

        // Act + Assert
        // await expect(assertRequiredTables(mockSql)).rejects.toThrow(
        //     'missing required table: plugin_settings'
        // );
        expect.fail('Remove .skip and uncomment the import + assertion when the guard exists');
    });

    it.skip('does not throw when all critical tables are present', async () => {
        const CRITICAL = [
            'plugin_settings',
            'task_history',
            'plugin_secrets',
            'plugin_user_credentials',
        ];

        const _mockSql = vi
            .fn()
            .mockImplementation((_strings: TemplateStringsArray, ...values: unknown[]) => {
                // Return a row for every queried table name.
                const tableName = values.find((v) => typeof v === 'string');
                if (tableName && CRITICAL.includes(tableName as string)) {
                    return Promise.resolve([{ table_name: tableName }]);
                }
                return Promise.resolve([]);
            }) as unknown as Sql;

        // await expect(assertRequiredTables(mockSql)).resolves.toBeUndefined();
        expect.fail('Remove .skip and uncomment when the guard exists');
    });
});
