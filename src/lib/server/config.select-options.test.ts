// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every option a `select` setting offers in the admin UI must survive its
 * config.ts getter. Most select getters use `getEnum`, which silently replaces
 * a value outside its own allowed list with the default — so an option listed
 * in schema.ts but missing from the getter saves fine and then does nothing.
 * PREVIEW_VIDEO_CODEC offered `av1` that way until 2026-10-06.
 *
 * The ConfigService is replaced by a plain map so each option can be fed
 * through the real getter without re-importing config.ts per value.
 */

import { describe, it, expect, vi } from 'vitest';

const stored = vi.hoisted(() => new Map<string, unknown>());

vi.mock('./config/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./config/index.js')>();
    return {
        ...actual,
        initConfigServiceSync: () => undefined,
        get: (key: string) => stored.get(key),
    };
});

const { configSchema } = await import('$lib/config/schema.js');
const { config } = await import('./config.js');

/**
 * Getters that deliberately map an option to a different runtime value.
 * Every entry needs a reason.
 */
const KNOWN_MAPPED_SELECTS: Record<string, string> = {};

const cases = configSchema
    .filter((s) => s.type === 'select' && Object.prototype.hasOwnProperty.call(config, s.key))
    .filter((s) => !(s.key in KNOWN_MAPPED_SELECTS))
    .flatMap((s) =>
        (s.validation?.options ?? []).map((o) => [s.key, o.value] as [string, unknown]),
    );

describe('select options reach their getter unchanged', () => {
    it('found select settings to check (guards against a vacuous pass)', () => {
        expect(cases.length).toBeGreaterThan(50);
    });

    it.each(cases)('%s = %j', (key, value) => {
        stored.clear();
        stored.set(key, value);
        try {
            expect((config as Record<string, unknown>)[key]).toEqual(value);
        } finally {
            stored.clear();
        }
    });
});
