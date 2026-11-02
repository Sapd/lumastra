// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * This deployment is env-locked (stack env beats settings.json), so the env-var
 * path is the LIVE one. PREVIEW_MAX_PER_USER=0 would make
 * `userPreviews.length >= 0` always true and pickEvictionVictim([]) throw on
 * every preview create for every user (see preview-eviction.ts). The
 * ConfigService validates env numbers against the schema (min:1/max:32) and
 * ignores an out-of-range one — falling back to the default, exactly like an
 * invalid settings.json value — and the getter still clamps as a backstop for
 * the pre-ConfigService env fallback.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Load a fresh config module with PREVIEW_MAX_PER_USER set in process.env.
 * `$env/dynamic/private`-equivalent reads process.env at import time (config.ts
 * snapshots `{ ...process.env }`), so setting it before the import is what the
 * getter sees.
 */
async function loadConfig(
    value: string | undefined,
): Promise<{ config: { PREVIEW_MAX_PER_USER: number } }> {
    delete process.env.PREVIEW_MAX_PER_USER;
    if (value !== undefined) process.env.PREVIEW_MAX_PER_USER = value;
    vi.resetModules();
    return (await import('./config.js')) as unknown as {
        config: { PREVIEW_MAX_PER_USER: number };
    };
}

beforeEach(() => {
    vi.resetModules();
});

describe('config.PREVIEW_MAX_PER_USER', () => {
    it('defaults to 6 when unset', async () => {
        const { config } = await loadConfig(undefined);
        expect(config.PREVIEW_MAX_PER_USER).toBe(6);
    });

    it('ignores an env value of 0 — the regression that 500s every preview create', async () => {
        const { config } = await loadConfig('0');
        expect(config.PREVIEW_MAX_PER_USER).toBe(6);
    });

    it('ignores a negative env value', async () => {
        const { config } = await loadConfig('-5');
        expect(config.PREVIEW_MAX_PER_USER).toBe(6);
    });

    it('ignores an env value above the schema max (32)', async () => {
        const { config } = await loadConfig('999');
        expect(config.PREVIEW_MAX_PER_USER).toBe(6);
    });

    it('passes through an in-range env value unchanged', async () => {
        const { config } = await loadConfig('4');
        expect(config.PREVIEW_MAX_PER_USER).toBe(4);
    });
});
