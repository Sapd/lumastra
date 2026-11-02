// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FEATURE_DEVICE_AUTH (Public API) defaults ON since v0.1 — pins the config.ts
 * getter FALLBACK to the schema default. config.schema-consistency.test.ts
 * cannot see a fallback-only drift: it compares values after ConfigService
 * resolved them, when the schema default always wins. Same forced-standalone
 * technique as config.resource-class-defaults.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configSchema } from '$lib/config/schema.js';

describe('FEATURE_DEVICE_AUTH default: schema ↔ config.ts fallback', () => {
    let saved: string | undefined;

    beforeEach(() => {
        saved = process.env.FEATURE_DEVICE_AUTH;
        delete process.env.FEATURE_DEVICE_AUTH;
        vi.resetModules();
    });

    afterEach(() => {
        if (saved === undefined) delete process.env.FEATURE_DEVICE_AUTH;
        else process.env.FEATURE_DEVICE_AUTH = saved;
        vi.doUnmock('./config/index.js');
        vi.resetModules();
    });

    function forceStandalone(): void {
        vi.doMock('./config/index.js', async (importOriginal) => ({
            ...(await importOriginal<typeof import('./config/index.js')>()),
            initConfigServiceSync: () => {
                throw new Error('forced: standalone-script path');
            },
        }));
    }

    it('schema default is ON and the getter fallback agrees', async () => {
        forceStandalone();
        const { config } = await import('./config.js');
        expect(configSchema.find((s) => s.key === 'FEATURE_DEVICE_AUTH')?.defaultValue).toBe(true);
        expect(config.FEATURE_DEVICE_AUTH).toBe(true);
    });

    it('an explicit FEATURE_DEVICE_AUTH=false env var still wins over the default', async () => {
        process.env.FEATURE_DEVICE_AUTH = 'false';
        forceStandalone();
        const { config } = await import('./config.js');
        expect(config.FEATURE_DEVICE_AUTH).toBe(false);
    });
});
