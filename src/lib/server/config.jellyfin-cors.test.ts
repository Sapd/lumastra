// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ origins: undefined as unknown }));
vi.mock('./config/index.js', () => ({
    initConfigServiceSync: vi.fn(),
    get: (key: string) => (key === 'JELLYFIN_COMPAT_CORS_ORIGINS' ? state.origins : undefined),
    onConfigChange: vi.fn(),
}));
import { config } from './config';
import { configSchema, validateSettingValue } from '$lib/config/schema';

const key = 'JELLYFIN_COMPAT_CORS_ORIGINS';
describe('Jellyfin CORS administrator setting', () => {
    beforeEach(() => {
        state.origins = undefined;
    });
    it('reads saved changes live and rejects malformed stored origins', () => {
        state.origins = ['https://web.example'];
        expect(config.JELLYFIN_COMPAT_CORS_ORIGINS).toEqual(['https://web.example']);
        state.origins = ['https://web2.example', 'https://*.example', 'null'];
        expect(config.JELLYFIN_COMPAT_CORS_ORIGINS).toEqual(['https://web2.example']);
        state.origins = '*';
        expect(config.JELLYFIN_COMPAT_CORS_ORIGINS).toEqual(['*']);
        state.origins = '';
        expect(config.JELLYFIN_COMPAT_CORS_ORIGINS).toEqual([]);
    });
    it('is disabled by default, live-editable, and separate from native API CORS', () => {
        const setting = configSchema.find((s) => s.key === key);
        expect(setting).toMatchObject({
            type: 'array',
            defaultValue: '',
            section: 'conn-jellyfin',
            dependsOn: 'FEATURE_JELLYFIN_COMPAT',
        });
        expect(Object.getOwnPropertyDescriptor(config, key)?.get).toBeTypeOf('function');
        expect(Reflect.get(config, key)).toEqual([]);
    });
    for (const value of ['', '*', 'https://web.example,https://web2.example:8443']) {
        it(`accepts the explicit policy ${JSON.stringify(value)}`, () => {
            expect(configSchema.find((s) => s.key === key)).toBeDefined();
            expect(
                validateSettingValue(
                    configSchema.find((s) => s.key === key)!,
                    value,
                ).valid,
            ).toBe(true);
        });
    }
    for (const value of [
        'null',
        'https://web.example/path',
        'https://user:pass@web.example',
        'https://*.example',
        'javascript:alert(1)',
        'https://web.example?query=1',
    ]) {
        it(`rejects non-origin value ${value}`, () => {
            expect(configSchema.find((s) => s.key === key)).toBeDefined();
            expect(
                validateSettingValue(
                    configSchema.find((s) => s.key === key)!,
                    value,
                ).valid,
            ).toBe(false);
        });
    }
});
