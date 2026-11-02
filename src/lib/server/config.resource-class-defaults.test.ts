// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pins schema default == config.ts fallback for every resource-class
 * concurrency knob (`LUMASTRA_CONCURRENCY_<CLASS>`).
 *
 * config.schema-consistency.test.ts cannot see this drift: it only walks keys
 * on the `config` object (these are module-level `export const`s), and it
 * compares values AFTER ConfigService resolved them, when the schema default
 * always wins. The fallback literal only applies when ConfigService did not
 * initialise, so this test forces that path. LUMASTRA_CONCURRENCY_BULK drifted
 * that way: 6ac5d27f8 raised the fallback 1→3 but the schema (the value the
 * running app used) stayed at 1 for four months.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESOURCE_CLASSES } from '@sapd/lumastra-plugin-sdk';
import { z } from 'zod';
import { configSchema } from '$lib/config/schema.js';
import { getCpuBudgetCores } from './utils/cpu-budget.js';

const PREFIX = 'LUMASTRA_CONCURRENCY_';
const concurrencySettings = configSchema.filter((s) => s.key.startsWith(PREFIX));

function schemaDefault(key: string): unknown {
    const setting = concurrencySettings.find((s) => s.key === key)!;
    return setting.dynamicDefault
        ? setting.dynamicDefault({ cpuCores: getCpuBudgetCores() })
        : setting.defaultValue;
}

describe('resource-class concurrency defaults: schema ↔ config.ts fallback', () => {
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        // An operator/CI env override would mask the fallback literal.
        for (const s of concurrencySettings) {
            savedEnv[s.key] = process.env[s.key];
            delete process.env[s.key];
        }
        vi.resetModules();
    });

    afterEach(() => {
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        vi.doUnmock('./config/index.js');
        vi.resetModules();
    });

    it('the schema registers one concurrency knob per resource class', () => {
        expect(concurrencySettings.map((s) => s.key).sort()).toEqual(
            RESOURCE_CLASSES.map((cls) => `${PREFIX}${cls.toUpperCase()}`).sort(),
        );
    });

    it('with ConfigService unavailable, every fallback equals the schema default', async () => {
        vi.doMock('./config/index.js', async (importOriginal) => ({
            ...(await importOriginal<typeof import('./config/index.js')>()),
            initConfigServiceSync: () => {
                throw new Error('forced: standalone-script path');
            },
        }));
        const configModule = (await import('./config.js')) as unknown as Record<string, unknown>;

        const mismatches = concurrencySettings
            .filter((s) => configModule[s.key] !== schemaDefault(s.key))
            .map(
                (s) =>
                    `${s.key}: config.ts fallback=${String(configModule[s.key])} schema=${String(schemaDefault(s.key))}`,
            );
        expect(mismatches, mismatches.join('\n')).toEqual([]);
    });

    it('the legacy-class shim caps a bulk task at the configured bulk concurrency', async () => {
        process.env.LUMASTRA_CONCURRENCY_BULK = '7';
        const { TaskRegistry } = await import('./tasks/registry.js');
        const { defineTask } = await import('@sapd/lumastra-plugin-sdk');
        const reg = new TaskRegistry({ perTaskQueues: true });
        reg.registerTask(
            defineTask({
                id: 'bulk-shim-probe',
                name: 'bulk-shim-probe',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'bulk',
                inputSchema: z.object({}),
                identityFor: () => 'global',
                async execute() {
                    return { success: true };
                },
            }) as never,
        );
        const t = reg.getTask('bulk-shim-probe')!;
        expect(t.resourceClass).toBe('io');
        expect(t.quotas?.maxConcurrent).toBe(7);
    });
});
