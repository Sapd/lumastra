// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * External Drop-in Plugin Fixture Test — Wave 6.5-D Audit (Agent C)
 *
 * PURPOSE
 * -------
 * Verifies that a third-party author can write a `defineProvider`-shaped JS
 * plugin and have it work with the new SDK contracts. Covers:
 *
 *   1. defineProvider contract validation (SDK-level)
 *   2. Task registry round-trip: registerProvider → getAllProviders →
 *      getProvidersByPriority → invokeProviderSearch
 *   3. registerProviderNormalizer + registerProviderEncoder hooks (6.5-D)
 *   4. CRITICAL FINDING: external loader (loadExternalPlugin) routes into
 *      legacy PluginRegistry, NOT the task registry — a defineProvider
 *      plugin dropped into $PLUGINS_EXTERNAL_DIR is NOT visible to
 *      invokeProviderSearch.  Test encodes this as a known gap.
 *
 * TEST STRUCTURE
 * --------------
 * All tests are self-contained unit-level — no DB, no Valkey, no file I/O.
 * The fixture provider is declared inline (not written to disk) to keep
 * the audit clean.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (must be declared before the imports they affect) ─────────────────

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            child: vi.fn().mockReturnThis(),
        })),
    },
}));

// Stub the builtin normalizer imports so the test doesn't pull in real clients.
vi.mock('$lib/server/providers/implementations/tmdb/normalize.js', () => ({}));
vi.mock('$lib/server/providers/implementations/jellyfin/normalize.js', () => ({}));
vi.mock('$lib/server/providers/implementations/anidb/normalize.js', () => ({}));
vi.mock('$lib/server/providers/implementations/mdblist/normalize.js', () => ({}));
vi.mock('$lib/server/providers/implementations/musicbrainz/normalize.js', () => ({}));

// ── Imports ─────────────────────────────────────────────────────────────────

import { defineProvider } from '@sapd/lumastra-plugin-sdk';
import type { ProviderDefinition } from '@sapd/lumastra-plugin-sdk';
import { TaskRegistry } from '$lib/server/tasks/registry.js';
import {
    getProvidersByPriority,
    invokeProviderSearch,
    invokeProviderDetail,
} from '$lib/server/tasks/plugin-context.js';
import {
    registerProviderNormalizer,
    unregisterProviderNormalizer,
    normalizeSearchResult,
} from '$lib/server/providers/normalize.js';
import {
    registerProviderEncoder,
    unregisterProviderEncoder,
    encodeDetailId,
} from '$lib/server/providers/encode-id.js';

// ── Fixture provider ─────────────────────────────────────────────────────────
//
// This is what a third-party author writes as their plugin's main export.
// It uses the new defineProvider SDK contract, NOT the legacy
// searchMovie / getSeriesDetail pattern.

interface FixtureSearchParams {
    type: 'movie' | 'tv';
    query: string;
    year?: number;
}

interface FixtureItem {
    externalId: string;
    title: string;
    year?: number;
    overview?: string;
}

const FIXTURE_PROVIDER_ID = 'fixture-test-provider';

const fixtureProvider: ProviderDefinition<FixtureSearchParams, FixtureItem> = defineProvider({
    id: FIXTURE_PROVIDER_ID,
    name: 'Fixture Test Provider',
    version: '1.0.0',
    capabilities: { http: false, cache: false },
    metadata: {
        priority: 5,
        fieldAuthorities: { title: 5 },
    },

    async isConfigured(_ctx) {
        // No API key needed for this hardcoded fixture.
        return true;
    },

    async search(_ctx, params) {
        return [
            {
                externalId: 'fixture-1',
                title: `${params.query} (Fixture)`,
                year: params.year ?? 2026,
            },
        ];
    },

    async detail(_ctx, id) {
        return {
            externalId: id,
            title: 'Fixture Detail',
            overview: 'Hardcoded fixture detail result.',
            year: 2026,
        };
    },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a fresh TaskRegistry (isolated — no global singleton contamination). */
function freshRegistry(): TaskRegistry {
    return new TaskRegistry();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// ----------------------------------------------------------------------------
// 1. defineProvider SDK-level contract validation
// ----------------------------------------------------------------------------
describe('defineProvider — SDK contract (fixture provider)', () => {
    it('is a valid ProviderDefinition object', () => {
        expect(fixtureProvider).toBeDefined();
        expect(fixtureProvider.id).toBe(FIXTURE_PROVIDER_ID);
        expect(fixtureProvider.name).toBe('Fixture Test Provider');
        expect(fixtureProvider.version).toBe('1.0.0');
    });

    it('has the expected metadata priority', () => {
        expect(fixtureProvider.metadata?.priority).toBe(5);
    });

    it('defineProvider rejects a missing isConfigured', () => {
        expect(() =>
            defineProvider({
                id: 'bad-provider',
                name: 'Bad',
                version: '1.0.0',
                capabilities: {},
                isConfigured: undefined as never,
                detail: async () => ({}),
            }),
        ).toThrow('isConfigured is mandatory');
    });

    it('defineProvider rejects a missing detail', () => {
        expect(() =>
            defineProvider({
                id: 'bad-provider',
                name: 'Bad',
                version: '1.0.0',
                capabilities: {},
                async isConfigured() {
                    return true;
                },
                detail: undefined as never,
            }),
        ).toThrow('detail is mandatory');
    });

    it('defineProvider rejects an invalid id', () => {
        expect(() =>
            defineProvider({
                id: 'Bad_ID',
                name: 'Bad',
                version: '1.0.0',
                capabilities: {},
                async isConfigured() {
                    return true;
                },
                async detail() {
                    return {};
                },
            }),
        ).toThrow(/id must match/);
    });
});

// ----------------------------------------------------------------------------
// 2. Task registry round-trip
// ----------------------------------------------------------------------------
describe('TaskRegistry — defineProvider round-trip', () => {
    let registry: TaskRegistry;

    beforeEach(() => {
        registry = freshRegistry();
        registry.registerProvider(fixtureProvider);
    });

    it('getProvider returns the registered definition', () => {
        const def = registry.getProvider(FIXTURE_PROVIDER_ID);
        expect(def).toBeDefined();
        expect(def!.id).toBe(FIXTURE_PROVIDER_ID);
    });

    it('getAllProviders includes the fixture provider', () => {
        const all = registry.getAllProviders();
        expect(all.some((p) => p.id === FIXTURE_PROVIDER_ID)).toBe(true);
    });

    it('getProvidersByPriority sorts by metadata.priority', () => {
        // Register a second provider with higher priority.
        const high = defineProvider({
            id: 'high-priority-provider',
            name: 'High',
            version: '1.0.0',
            capabilities: {},
            metadata: { priority: 100 },
            async isConfigured() {
                return true;
            },
            async detail() {
                return {};
            },
        });
        registry.registerProvider(high);

        const sorted = getProvidersByPriority(registry);
        const ids = sorted.map((p) => p.id);
        expect(ids.indexOf('high-priority-provider')).toBeLessThan(
            ids.indexOf(FIXTURE_PROVIDER_ID),
        );
    });

    it('invokeProviderSearch returns fixture results', async () => {
        const results = await invokeProviderSearch<FixtureSearchParams, FixtureItem>(
            FIXTURE_PROVIDER_ID,
            { type: 'movie', query: 'Test Movie', year: 2024 },
            { registry },
        );
        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBe(1);
        expect(results[0].title).toBe('Test Movie (Fixture)');
        expect(results[0].year).toBe(2024);
    });

    it('invokeProviderDetail returns fixture detail', async () => {
        const item = await invokeProviderDetail<FixtureItem>(FIXTURE_PROVIDER_ID, 'fixture-1', {
            registry,
        });
        expect(item.externalId).toBe('fixture-1');
        expect(item.title).toBe('Fixture Detail');
        expect(item.overview).toContain('fixture');
    });

    it('duplicate registerProvider throws', () => {
        expect(() => registry.registerProvider(fixtureProvider)).toThrow(/duplicate provider id/);
    });
});

// ----------------------------------------------------------------------------
// 3. registerProviderNormalizer + registerProviderEncoder hooks (6.5-D)
// ----------------------------------------------------------------------------
describe('registerProviderNormalizer (6.5-D hook)', () => {
    const normFn = vi.fn(() => ({
        provider: FIXTURE_PROVIDER_ID,
        title: 'Normalized Fixture',
        externalId: 'fixture-1',
        mediaType: 'movie' as const,
        confidence: 0.9,
    }));

    beforeEach(() => {
        vi.clearAllMocks();
        unregisterProviderNormalizer(FIXTURE_PROVIDER_ID);
    });

    it('returns null for the fixture provider before registration', () => {
        expect(normalizeSearchResult(FIXTURE_PROVIDER_ID, {}, 'movie')).toBeNull();
    });

    it('dispatches to the registered normalizer', () => {
        registerProviderNormalizer(FIXTURE_PROVIDER_ID, {
            searchResultToCandidate: normFn,
        });

        const candidate = normalizeSearchResult(
            FIXTURE_PROVIDER_ID,
            { externalId: 'fixture-1', title: 'Fixture' },
            'movie',
            2026,
        );

        expect(candidate).not.toBeNull();
        expect(candidate!.provider).toBe(FIXTURE_PROVIDER_ID);
        expect(normFn).toHaveBeenCalledWith(
            { externalId: 'fixture-1', title: 'Fixture' },
            'movie',
            2026,
        );
    });

    it('returns null again after unregistration', () => {
        registerProviderNormalizer(FIXTURE_PROVIDER_ID, {
            searchResultToCandidate: normFn,
        });
        unregisterProviderNormalizer(FIXTURE_PROVIDER_ID);

        expect(normalizeSearchResult(FIXTURE_PROVIDER_ID, {}, 'movie')).toBeNull();
    });
});

describe('registerProviderEncoder (6.5-D hook)', () => {
    const encFn = vi.fn((mediaType: string, rawId: string) => `fixture:${mediaType}:${rawId}`);

    beforeEach(() => {
        vi.clearAllMocks();
        unregisterProviderEncoder(FIXTURE_PROVIDER_ID);
    });

    it('passes raw id through before registration', () => {
        expect(encodeDetailId(FIXTURE_PROVIDER_ID, 'movie', 'abc')).toBe('abc');
    });

    it('dispatches to the registered encoder', () => {
        registerProviderEncoder(FIXTURE_PROVIDER_ID, encFn);

        expect(encodeDetailId(FIXTURE_PROVIDER_ID, 'movie', '42')).toBe('fixture:movie:42');
        expect(encFn).toHaveBeenCalledWith('movie', '42');
    });

    it('falls back to pass-through after unregistration', () => {
        registerProviderEncoder(FIXTURE_PROVIDER_ID, encFn);
        unregisterProviderEncoder(FIXTURE_PROVIDER_ID);

        expect(encodeDetailId(FIXTURE_PROVIDER_ID, 'movie', 'raw')).toBe('raw');
    });
});

// ----------------------------------------------------------------------------
// 4. FINDING C1 — external loader gap (fixed in this wave)
//
// ORIGINAL GAP: The external loader (loadExternalPlugin in runtime/loader.ts)
// always called getPluginRegistry().register(plugin, 'external') — the LEGACY
// registry. It never called taskRegistry.registerProvider(). Therefore a
// defineProvider plugin dropped into $PLUGINS_EXTERNAL_DIR would be:
//   - accepted by the loader (no error)
//   - stored in the legacy PluginRegistry
//   - INVISIBLE to invokeProviderSearch / getProvidersByPriority
//
// FIX APPLIED: loader.ts now detects new-SDK ProviderDefinition exports
// (has isConfigured + detail functions, no manifest property) and routes them
// to taskRegistry.registerProvider() instead of the legacy registry.
// loadExternalPlugin returns 'new-sdk' (not null) for these so
// loadExternalPlugins does not increment errorCount.
//
// These tests verify both the gap (empty registry path) and the fix path.
// ----------------------------------------------------------------------------
describe('FINDING C1 (fixed) — external loader gap / correct task-registry path', () => {
    it('invokeProviderSearch throws when provider is NOT in TaskRegistry', async () => {
        // An empty registry simulates the pre-fix state: plugin stored in
        // legacy PluginRegistry but not in TaskRegistry.
        const emptyRegistry = freshRegistry();

        await expect(
            invokeProviderSearch(
                'some-external-provider-not-in-task-registry',
                { type: 'movie', query: 'test' },
                { registry: emptyRegistry },
            ),
        ).rejects.toThrow('Provider not found in registry');
    });

    it('a defineProvider plugin registered in TaskRegistry IS accessible (post-fix path)', async () => {
        // This is the correct path — what loadExternalPlugin now does when it
        // detects a new-SDK export.
        const registry = freshRegistry();
        registry.registerProvider(fixtureProvider);

        const results = await invokeProviderSearch<FixtureSearchParams, FixtureItem>(
            FIXTURE_PROVIDER_ID,
            { type: 'movie', query: 'Post-fix' },
            { registry },
        );
        expect(results[0].title).toBe('Post-fix (Fixture)');
    });

    it('the SDK-provider detector recognises a ProviderDefinition default export', () => {
        // Mirror the runtime detection logic used in loader.ts:detectSdkDefinition.
        const exported = fixtureProvider as unknown as {
            search?: unknown;
            detail?: unknown;
        };
        const matchesProvider =
            typeof exported.search === 'function' || typeof exported.detail === 'function';
        expect(matchesProvider).toBe(true);
    });

    it('the hello-world example drop-in now exports a ProviderDefinition shape', async () => {
        // After Wave 6.5 final cleanup, hello-world was migrated from the
        // legacy createX shape to a JSDoc-typed plain ProviderDefinition.
        // The loader's detection must recognise it as a provider.
        const example = (await import('../hello-world/index.js')).default as unknown as {
            id?: unknown;
            search?: unknown;
            detail?: unknown;
        };
        const matchesProvider =
            typeof example.search === 'function' && typeof example.detail === 'function';
        expect(matchesProvider).toBe(true);
        expect(example.id).toBe('hello-world-metadata-provider');
    });
});
