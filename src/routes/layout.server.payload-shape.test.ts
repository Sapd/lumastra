// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Payload-shape ratchet for the ROOT layout data.
 *
 * This load's output is merged into every page's `__data.json`, and SvelteKit
 * hardcodes `private, no-store` on those responses — so a key added here is
 * re-serialized on every navigation, on every route, forever.
 *
 * The 2026-09-22 audit found four config blocks here with no client reader at
 * all: `watchTogether` (WatchParties.svelte hardcoded its own 15000ms interval
 * rather than reading `partiesRefreshMs`), `aiDashboard`, `toast`, and `image`
 * (whose only accessor, `getImageConfig()`, was never called from anywhere).
 *
 * They were cheap to add and invisible once added, which is exactly why they
 * need a test: assert on the object the real `load` returns, so re-adding one
 * is a failing test rather than a silent regression.
 *
 * ## The follow-up, same day
 *
 * Removing the blocks left nine schema entries pointing at nothing, so the
 * admin UI still rendered live-looking controls for knobs that had never done
 * anything. Four described real, browser-enacted behaviour and were wired up
 * through `$lib/stores/client-tuning`; five described behaviour that no longer
 * exists (the watch-together poll intervals and `ADMIN_TASKS_REFRESH_MS`, all
 * superseded by SSE) or could never be a knob (`IMAGE_THUMB_MAX_WIDTH` is a
 * rung in a fixed size ladder) and were retired from the schema.
 *
 * So the ratchet is not "this payload never grows" — it is **every key here
 * has a reader**. `clientTuning` is asserted positively below: it must ship,
 * and it must ship exactly the fields something consumes. Adding one more
 * without a consumer fails the same way re-adding `aiDashboard` does.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/config', () => ({
    config: new Proxy({} as Record<string, unknown>, {
        // localsIsAdminOrArrManager reads the ARR manager groups.
        get: (_t, key) =>
            key === 'ARR_MANAGER_GROUPS'
                ? []
                : key === 'TMDB_LANGUAGE'
                  ? 'de-AT'
                  : key === 'METADATA_ADDITIONAL_LANGUAGES'
                    ? ['fr', 'en']
                    : undefined,
    }),
    features: {},
    BACKEND_ONLY_FEATURES: new Set<string>(),
}));
vi.mock('$lib/server/config/domains/ai.js', () => ({
    getAiConfig: () => ({
        assistantName: 'A',
        assistantAvatar: '',
        assistantPersona: '',
        assistantDailyLimitUser: 1,
        assistantDailyLimitAdmin: 1,
    }),
}));
vi.mock('$lib/server/config/config.service.js', () => ({ get: () => undefined }));
vi.mock('$lib/server/operation-mode.js', () => ({
    operationMode: { getClientState: () => ({}), getState: () => ({}) },
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => null }));
vi.mock('$lib/server/database/queries/library-types.queries.js', () => ({
    getActiveNonEntertainmentLibraries: vi.fn(async () => []),
    getActiveLibraryTypes: vi.fn(async () => []),
}));
vi.mock('$lib/server/database/queries/builders/media-access-boundary.js', () => ({
    boundaryCacheKey: () => 'k',
    denyAllAccess: () => ({}),
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn(async () => ({})),
    searchAccessBoundary: () => ({}),
}));
vi.mock('$lib/server/auth.js', () => ({ isAdminOrArrManager: () => false }));
vi.mock('$lib/server/database/queries/user-preferences.queries.js', () => ({
    loadFeedPrefsForUser: vi.fn(async () => ({})),
}));
vi.mock('$lib/server/services/music/radio-configured.service.js', () => ({
    isRadioConfigured: vi.fn(async () => false),
}));
vi.mock('$lib/server/theme/enabled-themes.js', () => ({
    getEnabledThemes: vi.fn(() => []),
    resolveActiveThemeId: () => 'default',
}));
vi.mock('$lib/server/plugins/runtime/widget-metadata.js', () => ({
    listPluginWidgets: vi.fn(async () => []),
    // Real listPluginNavEntries is SYNCHRONOUS (returns PluginNavEntry[]
    // directly, not a Promise) — an `async` mock here used to be harmless
    // because the load never awaited or iterated it, but +layout.server.ts
    // now `.map()`s over `pluginNavEntries` to collect icon names for
    // `navIcons` (see resolve-nav-icons.ts), which throws on a Promise.
    listPluginNavEntries: vi.fn(() => []),
}));

const { load } = await import('./+layout.server.js');

async function runLoad(): Promise<Record<string, unknown>> {
    return (await load({
        locals: { user: { userId: 'u1', username: 'alice', userGroups: [] } },
        cookies: { get: () => undefined },
    } as never)) as Record<string, unknown>;
}

describe('root layout payload shape', () => {
    it('ships server language priority in configured order', async () => {
        expect((await runLoad()).mediaLanguagePriority).toEqual(['de-AT', 'fr', 'en']);
    });
    it('returns a payload at all (guards the assertions below from passing vacuously)', async () => {
        const data = await runLoad();
        expect(data).toBeTypeOf('object');
        expect(Object.keys(data).length).toBeGreaterThan(5);
    });

    it.each([
        // key             why it was removed
        ['watchTogether', 'superseded by `clientTuning`, which ships only what is read'],
        ['aiDashboard', 'no client reader for any of its five fields'],
        ['toast', 'superseded by `clientTuning.toastDefaultTimeoutMs`'],
        ['image', 'getImageConfig() — its only accessor — was never called'],
    ])('does not ship the dead `%s` block (%s)', async (key) => {
        const data = await runLoad();
        expect(data).not.toHaveProperty(key);
    });

    it('ships `clientTuning` — the knobs that DO have a browser reader', async () => {
        const data = await runLoad();
        // The config mock returns undefined for every key, so this asserts the
        // SHAPE the load builds, not the values. Sorted so the assertion is
        // order-independent.
        expect(Object.keys(data.clientTuning as object).sort()).toEqual([
            'abrBandwidthSamples',
            'abrDownCooldownMs',
            'abrMinAdaptiveBitrate',
            'abrMinSamplesBeforeSwitch',
            'abrStabilityMs',
            'abrUpCooldownMs',
            'partiesRefreshMs',
            'playerSkipSeconds',
            'playlistChatPollMs',
            'requestAvailableExpireHours',
            'toastDefaultTimeoutMs',
            'watchTogetherMaxReconnectMs',
        ]);
    });

    it.each([
        'skipSeconds',
        'qualityStabilityMs',
        'qualityDownCooldownMs',
        'qualityUpCooldownMs',
        'bandwidthSamples',
        'minSamplesBeforeSwitch',
        'minAdaptiveBitrate',
    ])(
        'does not also ship `player.%s` (moved to clientTuning, which has the reader)',
        async (key) => {
            const data = await runLoad();
            expect(data.player).toBeTypeOf('object');
            expect(data.player).not.toHaveProperty(key);
        },
    );

    it.each([
        // key in the old `watchTogether` / `aiDashboard` / `image` blocks that
        // is NOT in clientTuning, and the reason it stayed retired
        ['syncIntervalMs', 'watch-together sync is event-driven over SSE'],
        ['driftCheckMs', 'drift is computed per-event server-side, not on a timer'],
        ['catchupCheckMs', 'no catch-up polling loop exists'],
        ['adminTasksRefreshMs', 'the admin tasks page is driven by runSSEBus'],
        ['thumbMaxWidth', 'thumb width is a fixed rung in the image size ladder'],
    ])('does not smuggle the retired `%s` back in via clientTuning (%s)', async (key) => {
        const data = await runLoad();
        // Assert presence first: without this, dropping the whole block makes
        // these five fail with a TypeError from toHaveProperty rather than the
        // one legible failure the test above already gives.
        expect(data.clientTuning, 'clientTuning block is missing entirely').toBeTypeOf('object');
        expect(data.clientTuning).not.toHaveProperty(key);
    });
});
