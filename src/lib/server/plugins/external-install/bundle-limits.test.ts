// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, afterEach } from 'vitest';
import { bundleLimitsFromConfig } from './bundle-limits.js';

const keys = [
    'PLUGIN_INSTALL_MAX_EXTRACTED_BYTES',
    'PLUGIN_INSTALL_MAX_ENTRIES',
    'PLUGIN_INSTALL_MAX_FILE_BYTES',
];
afterEach(() => keys.forEach((k) => delete process.env[k]));

describe('bundleLimitsFromConfig', () => {
    it('uses documented defaults', () => {
        const l = bundleLimitsFromConfig();
        expect(l.maxTotalBytes).toBe(32 * 1024 * 1024);
        expect(l.maxEntries).toBe(2048);
        expect(l.maxFileBytes).toBe(8 * 1024 * 1024);
    });
    it('honours env overrides', () => {
        process.env.PLUGIN_INSTALL_MAX_ENTRIES = '10';
        expect(bundleLimitsFromConfig().maxEntries).toBe(10);
    });
});
