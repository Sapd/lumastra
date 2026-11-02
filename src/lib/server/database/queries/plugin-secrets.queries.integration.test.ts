// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Plugin Secrets Query Module
 *
 * Tests listing secret keys without exposing values.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';

import { listPluginSecretKeys } from './plugin-secrets.queries.js';

describe('Plugin Secrets Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        // beforeEach only clears BEFORE a test, so the last test's rows would
        // outlive the file. They are not row-bound (`enc:v2:`) envelopes, and
        // inventory-checks.integration counts every such row in the whole
        // table: a leftover here turned that file red whenever it ran later
        // against the same database.
        await sql`DELETE FROM plugin_secrets WHERE plugin_id LIKE 'test_secret_plugin_%'`;
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM plugin_secrets WHERE plugin_id LIKE 'test_secret_plugin_%'`;
    });

    // ========================================================================
    // listPluginSecretKeys
    // ========================================================================

    describe('listPluginSecretKeys', () => {
        it('returns metadata rows ordered by plugin_id and key', async () => {
            const { listPluginSecretKeys } = await import('./plugin-secrets.queries.js');

            // Insert test secrets
            await sql`
                INSERT INTO plugin_secrets (plugin_id, key, value_encrypted, encryption_version)
                VALUES
                    ('test_secret_plugin_a', 'api_key', decode('00', 'hex'), 1),
                    ('test_secret_plugin_a', 'api_secret', decode('00', 'hex'), 1),
                    ('test_secret_plugin_b', 'token', decode('00', 'hex'), 2)
            `;

            const keys = await listPluginSecretKeys(sql);
            const ours = keys.filter((k) => k.pluginId.startsWith('test_secret_plugin_'));
            expect(ours.length).toBe(3);
            expect(ours[0].pluginId).toBe('test_secret_plugin_a');
            expect(ours[0].key).toBe('api_key');
            expect(ours[2].encryptionVersion).toBe(2);
        });

        it('returns empty array when no secrets exist', async () => {
            const keys = await listPluginSecretKeys(sql);
            const ours = keys.filter((k) => k.pluginId.startsWith('test_secret_plugin_'));
            expect(ours).toEqual([]);
        });

        it('excludes value columns from result', async () => {
            const { listPluginSecretKeys } = await import('./plugin-secrets.queries.js');
            await sql`
                INSERT INTO plugin_secrets (plugin_id, key, value_encrypted, encryption_version)
                VALUES ('test_secret_plugin_c', 'password', decode('deadbeef', 'hex'), 1)
            `;

            const keys = await listPluginSecretKeys(sql);
            const row = keys.find((k) => k.pluginId === 'test_secret_plugin_c');
            expect(row).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((row as any).value_encrypted).toBeUndefined();
        });
    });
});
