// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for `features.jellyfinCompat` — the predicate that decides whether
 * the /j Jellyfin-compat surface is *usable*, as opposed to merely *reachable*.
 *
 * The /j layer serves Lumastra's OWN catalog: `routes/(proprietary)/j/` gates on
 * the raw FEATURE_JELLYFIN_COMPAT flag and makes no outbound call to a Jellyfin
 * server. But `features.jellyfinCompat` additionally demanded JELLYFINURL and
 * JELLYFINAPIKEY, so on a Jellyfin-less install the two disagreed: /j kept
 * serving requests while everything a user needs to *reach* it disappeared —
 * the Settings → Connections section, the /j password issue/reveal/reset APIs,
 * the per-user /j session list and the compat Quick Connect authorise endpoint
 * (all of which are Valkey/Postgres-native and never talk to Jellyfin).
 *
 * The invariant pinned here is that the two gates agree. `features.quickConnect`
 * is pinned alongside as the deliberate contrast: that one drives
 * `jellyfinAuthService.quickConnect()` against a real Jellyfin server, so it
 * MUST keep requiring credentials.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const JF_ENV_KEYS = [
    'FEATURE_JELLYFIN_COMPAT',
    'FEATURE_QUICK_CONNECT',
    'JELLYFINURL',
    'JELLYFINAPIKEY',
] as const;

interface ConfigModule {
    config: { FEATURE_JELLYFIN_COMPAT: boolean };
    features: { jellyfinCompat: boolean; quickConnect: boolean; jellyfin: boolean };
}

/**
 * Load a fresh config module with the given env in place. `$env/dynamic/private`
 * reads process.env at access time, so setting it before the import is what the
 * getters see.
 */
async function loadConfig(
    envVars: Partial<Record<(typeof JF_ENV_KEYS)[number], string>>,
): Promise<ConfigModule> {
    for (const key of JF_ENV_KEYS) delete process.env[key];
    Object.assign(process.env, envVars);
    vi.resetModules();
    return (await import('./config.js')) as unknown as ConfigModule;
}

const WITH_JELLYFIN = {
    FEATURE_JELLYFIN_COMPAT: 'true',
    JELLYFINURL: 'http://jellyfin.internal:8096',
    JELLYFINAPIKEY: 'a'.repeat(32),
};

const NO_JELLYFIN = { FEATURE_JELLYFIN_COMPAT: 'true' };

beforeEach(() => {
    vi.resetModules();
});

describe('features.jellyfinCompat', () => {
    it('is true on a Jellyfin-less install — /j serves Lumastra’s own catalog', async () => {
        const { features } = await loadConfig(NO_JELLYFIN);
        expect(features.jellyfinCompat).toBe(true);
    });

    it('is true when a Jellyfin server happens to also be configured', async () => {
        const { features } = await loadConfig(WITH_JELLYFIN);
        expect(features.jellyfinCompat).toBe(true);
    });

    it('is false when the feature flag is off, even with Jellyfin configured', async () => {
        const { features } = await loadConfig({
            ...WITH_JELLYFIN,
            FEATURE_JELLYFIN_COMPAT: 'false',
        });
        expect(features.jellyfinCompat).toBe(false);
    });

    it('is false when only the API key is present without the flag', async () => {
        const { features } = await loadConfig({
            FEATURE_JELLYFIN_COMPAT: 'false',
            JELLYFINAPIKEY: 'a'.repeat(32),
        });
        expect(features.jellyfinCompat).toBe(false);
    });

    /**
     * The seam: `routes/(proprietary)/j/+layout.server.ts` and resolveAuth() gate
     * /j reachability on `config.FEATURE_JELLYFIN_COMPAT`. Any consumer asking
     * `features.jellyfinCompat` must get the same answer, or the UI and the
     * surface it configures drift apart.
     */
    it('agrees with the raw flag that actually gates /j reachability', async () => {
        for (const env of [NO_JELLYFIN, WITH_JELLYFIN, { FEATURE_JELLYFIN_COMPAT: 'false' }]) {
            const { config, features } = await loadConfig(env);
            expect(features.jellyfinCompat).toBe(config.FEATURE_JELLYFIN_COMPAT);
        }
    });
});

describe('features.quickConnect (deliberate contrast)', () => {
    it('still requires Jellyfin credentials — it calls a real Jellyfin server', async () => {
        const { features } = await loadConfig({ FEATURE_QUICK_CONNECT: 'true' });
        expect(features.quickConnect).toBe(false);
    });

    it('is true once Jellyfin is configured', async () => {
        const { features } = await loadConfig({
            ...WITH_JELLYFIN,
            FEATURE_QUICK_CONNECT: 'true',
        });
        expect(features.quickConnect).toBe(true);
    });
});
