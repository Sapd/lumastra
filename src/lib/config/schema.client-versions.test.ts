// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { configSchema, validateSettingValue } from './schema';
describe('minimum client versions', () => {
    it.each(['IOS', 'TVOS', 'WEB', 'OTHER'])(
        'validates %s minimums and defaults to none',
        (platform) => {
            const setting = configSchema.find((s) => s.key === `MIN_CLIENT_VERSION_${platform}`);
            expect(setting).toBeDefined();
            expect(setting!.defaultValue).toBe('');
            for (const value of ['', '1.2.3', '2.0.0-rc.1', '1.0.0+build.3']) {
                expect(validateSettingValue(setting!, value).valid, value).toBe(true);
            }
            for (const value of ['v1.2.3', '1.2', '01.2.3', 'latest', '1.0.0-01']) {
                expect(validateSettingValue(setting!, value).valid, value).toBe(false);
            }
        },
    );
});

describe('device verification base URL scheme validation', () => {
    it.each(['lumastra.example.com', '/lumastra', 'ftp://example.com', 'javascript:alert(1)'])(
        'rejects %s',
        (value) => {
            const setting = configSchema.find((s) => s.key === 'DEVICE_VERIFICATION_BASE_URL')!;
            expect(validateSettingValue(setting, value).valid).toBe(false);
        },
    );
    it.each(['', 'http://localhost:3000', 'https://example.com/lumastra'])('allows %s', (value) => {
        const setting = configSchema.find((s) => s.key === 'DEVICE_VERIFICATION_BASE_URL')!;
        expect(validateSettingValue(setting, value).valid).toBe(true);
    });
});
