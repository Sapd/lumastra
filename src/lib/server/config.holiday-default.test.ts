// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Holiday recommendations are OFF unless the admin turns them on (v0.1
 * decision). One setting, DISABLE_HOLIDAY_RECOMMENDATIONS, default true; every
 * path reads it through `features.holidays`. An explicit value in ENV (or
 * settings.json) still wins, so existing installs that set it keep working.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

async function load(): Promise<typeof import('./config.js')> {
    vi.resetModules();
    return import('./config.js');
}

describe('DISABLE_HOLIDAY_RECOMMENDATIONS', () => {
    it('schema default is true (disabled)', async () => {
        const { configSchema } = await import('$lib/config/schema.js');
        const setting = configSchema.find((s) => s.key === 'DISABLE_HOLIDAY_RECOMMENDATIONS');
        expect(setting?.defaultValue).toBe(true);
    });

    it('unset → disabled, features.holidays false', async () => {
        vi.stubEnv('DISABLE_HOLIDAY_RECOMMENDATIONS', '');
        const { config, features } = await load();
        expect(config.DISABLE_HOLIDAY_RECOMMENDATIONS).toBe(true);
        expect(features.holidays).toBe(false);
    });

    it('explicit false → enabled', async () => {
        vi.stubEnv('DISABLE_HOLIDAY_RECOMMENDATIONS', 'false');
        const { config, features } = await load();
        expect(config.DISABLE_HOLIDAY_RECOMMENDATIONS).toBe(false);
        expect(features.holidays).toBe(true);
    });

    it('explicit true → disabled', async () => {
        vi.stubEnv('DISABLE_HOLIDAY_RECOMMENDATIONS', 'true');
        const { features } = await load();
        expect(features.holidays).toBe(false);
    });
});
