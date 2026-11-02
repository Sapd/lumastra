// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Task Settings Query Module
 *
 * Tests getTaskSettings and upsertTaskSettings.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';

import {
    addToTaskSettingList,
    getTaskSettings,
    removeFromTaskSettingList,
    upsertTaskSettings,
} from './task-settings.queries.js';

describe('Task Settings Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['plugin_settings']);
    });

    // ========================================================================
    // getTaskSettings
    // ========================================================================

    describe('getTaskSettings', () => {
        it('returns empty object when no settings exist', async () => {
            const settings = await getTaskSettings(sql, 'nonexistent-plugin');

            expect(settings).toEqual({});
        });

        it('returns settings as key-value object', async () => {
            const taskId = 'test-plugin';
            await sql`
                INSERT INTO plugin_settings (plugin_id, key, value)
                VALUES
                    (${taskId}, 'interval', ${sql.json('3600')}),
                    (${taskId}, 'enabled', ${sql.json(true)}),
                    (${taskId}, 'threshold', ${sql.json({ min: 0, max: 100 })})
            `;

            const settings = await getTaskSettings(sql, taskId);

            expect(settings['interval']).toBe('3600');
            expect(settings['enabled']).toBe(true);
            expect(settings['threshold']).toEqual({ min: 0, max: 100 });
        });

        it('ignores unsafe keys (__proto__, constructor, prototype)', async () => {
            const taskId = 'unsafe-plugin';
            await sql`
                INSERT INTO plugin_settings (plugin_id, key, value)
                VALUES
                    (${taskId}, '__proto__', ${sql.json('polluted')}),
                    (${taskId}, 'constructor', ${sql.json('polluted')}),
                    (${taskId}, 'prototype', ${sql.json('polluted')}),
                    (${taskId}, 'safeKey', ${sql.json('safeValue')})
            `;

            const settings = await getTaskSettings(sql, taskId);

            expect(settings['__proto__']).toBeUndefined();
            expect(settings['constructor']).toBeUndefined();
            expect(settings['prototype']).toBeUndefined();
            expect(settings['safeKey']).toBe('safeValue');
        });

        it('isolates settings per plugin', async () => {
            await sql`
                INSERT INTO plugin_settings (plugin_id, key, value)
                VALUES
                    ('plugin-a', 'key1', ${sql.json('value-a')}),
                    ('plugin-b', 'key1', ${sql.json('value-b')})
            `;

            const settingsA = await getTaskSettings(sql, 'plugin-a');
            const settingsB = await getTaskSettings(sql, 'plugin-b');

            expect(settingsA['key1']).toBe('value-a');
            expect(settingsB['key1']).toBe('value-b');
        });
    });

    // ========================================================================
    // upsertTaskSettings
    // ========================================================================

    describe('upsertTaskSettings', () => {
        it('inserts new settings', async () => {
            await upsertTaskSettings(sql, 'new-plugin', {
                batchSize: 100,
                enabled: true,
            });

            const settings = await getTaskSettings(sql, 'new-plugin');

            expect(settings['batchSize']).toBe(100);
            expect(settings['enabled']).toBe(true);
        });

        it('updates existing settings', async () => {
            await upsertTaskSettings(sql, 'update-plugin', {
                batchSize: 50,
                enabled: false,
            });

            await upsertTaskSettings(sql, 'update-plugin', {
                batchSize: 200,
            });

            const settings = await getTaskSettings(sql, 'update-plugin');

            expect(settings['batchSize']).toBe(200);
            expect(settings['enabled']).toBe(false);
        });

        it('does not delete keys absent from the update', async () => {
            await upsertTaskSettings(sql, 'partial-plugin', {
                keyA: 'valueA',
                keyB: 'valueB',
            });

            await upsertTaskSettings(sql, 'partial-plugin', {
                keyA: 'updatedA',
            });

            const settings = await getTaskSettings(sql, 'partial-plugin');

            expect(settings['keyA']).toBe('updatedA');
            expect(settings['keyB']).toBe('valueB');
        });

        it('skips undefined values', async () => {
            await upsertTaskSettings(sql, 'undefined-plugin', {
                defined: 'yes',
                undefined: undefined,
            });

            const settings = await getTaskSettings(sql, 'undefined-plugin');

            expect(settings['defined']).toBe('yes');
            expect(settings['undefined']).toBeUndefined();
        });

        it('skips unsafe keys', async () => {
            await upsertTaskSettings(sql, 'safe-plugin', {
                __proto__: 'bad',
                constructor: 'bad',
                prototype: 'bad',
                valid: 'good',
            });

            const settings = await getTaskSettings(sql, 'safe-plugin');

            expect(settings['valid']).toBe('good');
            expect(Object.keys(settings).length).toBe(1);
        });

        it('handles empty settings object', async () => {
            await expect(upsertTaskSettings(sql, 'empty-plugin', {})).resolves.toBeUndefined();

            const settings = await getTaskSettings(sql, 'empty-plugin');
            expect(settings).toEqual({});
        });
    });

    describe('addToTaskSettingList / removeFromTaskSettingList', () => {
        it('appends once, concurrently without losing entries, and removes', async () => {
            await Promise.all(
                ['0.1.1', '0.1.2', '0.1.3', '0.1.1'].map((v) =>
                    addToTaskSettingList(sql, 'list-plugin', 'reviewed', v),
                ),
            );
            const list = (await getTaskSettings(sql, 'list-plugin'))['reviewed'] as string[];
            expect([...list].sort()).toEqual(['0.1.1', '0.1.2', '0.1.3']);

            await removeFromTaskSettingList(sql, 'list-plugin', 'reviewed', '0.1.2');
            const after = (await getTaskSettings(sql, 'list-plugin'))['reviewed'] as string[];
            expect([...after].sort()).toEqual(['0.1.1', '0.1.3']);
        });

        it('replaces a non-array value instead of failing', async () => {
            await upsertTaskSettings(sql, 'list-plugin', { reviewed: 'garbage' });
            await addToTaskSettingList(sql, 'list-plugin', 'reviewed', '0.1.1');
            expect((await getTaskSettings(sql, 'list-plugin'))['reviewed']).toEqual(['0.1.1']);
        });
    });
});
