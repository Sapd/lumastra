// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The three operator knobs that bound the provider-artwork backfill drain,
 * plus the schema.ts registration the config lint requires.
 */

// The schema array is exported as `configSchema` (schema.ts:615) — there is no
// `SETTINGS_SCHEMA` export.
import { describe, it, expect } from 'vitest';
import { config } from './config.js';
import { configSchema } from '../config/schema.js';

const KEYS = [
    'PROVIDER_ARTWORK_BACKFILL_ENABLED',
    'PROVIDER_ARTWORK_MIN_FREE_GB',
    'PROVIDER_ARTWORK_MAX_ITEMS_PER_HOUR',
] as const;

describe('provider-artwork backfill config', () => {
    it('defaults to enabled', () => {
        expect(config.PROVIDER_ARTWORK_BACKFILL_ENABLED).toBe(true);
    });

    it('defaults the per-volume free-space margin to 5 GB', () => {
        expect(config.PROVIDER_ARTWORK_MIN_FREE_GB).toBe(5);
    });

    it('defaults the hourly item cap to 2000', () => {
        expect(config.PROVIDER_ARTWORK_MAX_ITEMS_PER_HOUR).toBe(2000);
    });

    it('registers every key in configSchema (config-schema-registered lint)', () => {
        const registered = new Set(configSchema.map((s) => s.key));
        for (const key of KEYS) {
            expect(registered.has(key)).toBe(true);
        }
    });
});
