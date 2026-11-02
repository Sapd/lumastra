// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * tmdb.ts `resolveExternalId()` outage-visibility regression.
 *
 * Before this fix, `resolveExternalId()` had a bare `catch { return null; }`
 * — every failure (network error, TMDB 5xx, a cancelled run) silently
 * collapsed into the same `null` a genuine "no crossref" answer returns,
 * with no log trail to distinguish them.
 *
 * These tests lock in the fixed contract:
 *   - a cancelled call (AbortError) rethrows instead of being swallowed;
 *   - any other failure still resolves to `null` (callers rely on that as
 *     the "no crossref, fall through to Phase 2" signal) but is now logged
 *     via `ctx.logger.warn` with the externalId/source/mediaType context.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PluginContext } from '@sapd/lumastra-plugin-sdk';
import { mockLogger, mockContext } from '@sapd/lumastra-plugin-sdk-testing';

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { registerProvider: vi.fn() },
}));

const configMock = vi.hoisted(() => ({
    config: { TMDB_API_KEY: 'k' as string | undefined, TMDB_LANGUAGE: 'en-US' },
}));
vi.mock('$lib/server/config.js', () => configMock);

vi.mock('$lib/server/database/queries/metadata-aggregation.queries.js', () => ({
    keywordNamesToSlugs: () => [],
    tmdbGenreIdsToSlugs: () => [],
}));

const tmdbApiMock = vi.hoisted(() => ({
    tmdbApi: {
        isAvailable: vi.fn(() => true),
        findByExternalId: vi.fn(),
    },
}));
vi.mock('$lib/server/providers/implementations/tmdb/index.js', () => tmdbApiMock);

import { tmdbProvider } from './tmdb.js';

function makeCtx(): PluginContext {
    return mockContext({ input: {}, logger: mockLogger() });
}

describe('tmdbProvider.resolveExternalId — outage-visibility regression', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        tmdbApiMock.tmdbApi.isAvailable.mockReturnValue(true);
    });

    it('rethrows an AbortError instead of swallowing it into null', async () => {
        tmdbApiMock.tmdbApi.findByExternalId.mockRejectedValue(
            new DOMException('The user aborted', 'AbortError'),
        );
        const ctx = makeCtx();

        await expect(
            tmdbProvider.resolveExternalId!(ctx, 'tt1234567', 'imdb', 'movie'),
        ).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('returns null and logs a warning on a non-abort failure (network/5xx)', async () => {
        tmdbApiMock.tmdbApi.findByExternalId.mockRejectedValue(new Error('TMDB 503'));
        const ctx = makeCtx();
        const logger = ctx.logger as ReturnType<typeof mockLogger>;

        const result = await tmdbProvider.resolveExternalId!(ctx, 'tt1234567', 'imdb', 'movie');

        expect(result).toBeNull();
        const warnEntry = logger.entries.find(
            (e) => e.level === 'warn' && /resolveExternalId failed/i.test(e.msg),
        );
        expect(warnEntry).toBeDefined();
        expect(warnEntry?.meta).toMatchObject({ externalId: 'tt1234567', source: 'imdb' });
    });

    it('returns the resolved match on success (no throw, no warn)', async () => {
        tmdbApiMock.tmdbApi.findByExternalId.mockResolvedValue({
            movie_results: [{ id: 550, title: 'Quiet Orbit', original_title: 'Quiet Orbit' }],
            tv_results: [],
        });
        const ctx = makeCtx();
        const logger = ctx.logger as ReturnType<typeof mockLogger>;

        const result = await tmdbProvider.resolveExternalId!(ctx, 'tt0137523', 'imdb', 'movie');

        expect(result).toMatchObject({ externalId: '550', title: 'Quiet Orbit' });
        expect(logger.entries.some((e) => e.level === 'warn')).toBe(false);
    });
});

/**
 * Primary-language source of truth (prod incident 2026-09-26: ~7k primary
 * `tmdb` rows held German text). The per-item sync (`metadata-sync-single`)
 * and the translation overlay (`metadata-language-resolve`) both treat
 * `config.TMDB_LANGUAGE` as the primary language — which resolves the admin
 * setting BEFORE the env var. This provider used to fall back to
 * `process.env.TMDB_LANGUAGE` instead, so an admin-set language never reached
 * the discovery/scan writers and the two writer families stored the primary
 * row in DIFFERENT languages.
 */
describe('tmdbProvider.detail — primary language follows config.TMDB_LANGUAGE', () => {
    function makeHttpCtx(settings: Record<string, unknown> = {}) {
        const get = vi.fn(async (_url: string, _init?: unknown) => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ id: 550, title: 'x', overview: 'y' }),
        }));
        const ctx = {
            ...mockContext({ input: {}, logger: mockLogger() }),
            http: { get },
            settings: async () => settings,
            secrets: { get: async () => 'k', getOptional: async () => 'k' },
        } as unknown as PluginContext;
        const languageOf = (call: number) =>
            new URL(String(get.mock.calls[call]?.[0])).searchParams.get('language');
        return { ctx, languageOf };
    }

    const savedEnv = process.env['TMDB_LANGUAGE'];
    beforeEach(() => {
        delete process.env['TMDB_LANGUAGE'];
        configMock.config.TMDB_LANGUAGE = 'en-US';
    });
    afterEach(() => {
        if (savedEnv === undefined) delete process.env['TMDB_LANGUAGE'];
        else process.env['TMDB_LANGUAGE'] = savedEnv;
    });

    it('uses the admin-configured TMDB_LANGUAGE when no per-call override is set', async () => {
        configMock.config.TMDB_LANGUAGE = 'fr-FR';
        const { ctx, languageOf } = makeHttpCtx();

        await tmdbProvider.detail!(ctx, 'movie:550');

        expect(languageOf(0)).toBe('fr-FR');
    });

    it('config beats a divergent process env (env is only config’s own fallback)', async () => {
        configMock.config.TMDB_LANGUAGE = 'en-US';
        process.env['TMDB_LANGUAGE'] = 'de-DE';
        const { ctx, languageOf } = makeHttpCtx();

        await tmdbProvider.detail!(ctx, 'movie:550');

        expect(languageOf(0)).toBe('en-US');
    });

    it('ignores a plugin-level TMDB_LANGUAGE — the host setting is the one source', async () => {
        configMock.config.TMDB_LANGUAGE = 'en-US';
        const { ctx, languageOf } = makeHttpCtx({ TMDB_LANGUAGE: 'ja-JP' });

        await tmdbProvider.detail!(ctx, 'movie:550');

        expect(languageOf(0)).toBe('en-US');
    });
});

describe('tmdbProvider.search — rejected key (Windows e2e S5)', () => {
    it('throws ProviderAuthError on 401 and does not ask TMDB again for the same key', async () => {
        const { resetProviderAuthStateForTests, isProviderAuthError } =
            await import('$lib/server/providers/provider-auth-state.js');
        resetProviderAuthStateForTests();
        configMock.config.TMDB_API_KEY = 'placeholder-key';
        const get = vi.fn(async () => ({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            json: async () => ({}),
        }));
        const ctx = {
            ...mockContext({ input: {}, logger: mockLogger() }),
            http: { get },
        } as unknown as PluginContext;

        const first = await tmdbProvider.search!(ctx, { type: 'movie', query: 'A' }).catch(
            (e: unknown) => e,
        );
        const second = await tmdbProvider.search!(ctx, { type: 'movie', query: 'B' }).catch(
            (e: unknown) => e,
        );

        expect(isProviderAuthError(first)).toBe(true);
        expect(isProviderAuthError(second)).toBe(true);
        expect(get).toHaveBeenCalledTimes(1);
        configMock.config.TMDB_API_KEY = 'k';
    });
});

describe('tmdbProvider request auth (v3 key vs v4 token)', () => {
    const V3_KEY = '0123456789abcdef0123456789abcdef';
    const V4_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJ0ZXN0In0.sig';

    async function searchWith(key: string) {
        const { resetProviderAuthStateForTests } =
            await import('$lib/server/providers/provider-auth-state.js');
        resetProviderAuthStateForTests();
        configMock.config.TMDB_API_KEY = key;
        const get = vi.fn(async (_url: string, _init?: { headers?: Record<string, string> }) => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ results: [] }),
        }));
        const ctx = {
            ...mockContext({ input: {}, logger: mockLogger() }),
            http: { get },
        } as unknown as PluginContext;
        await tmdbProvider.search!(ctx, { type: 'movie', query: 'Alien' });
        configMock.config.TMDB_API_KEY = 'k';
        const [url, init] = get.mock.calls[0];
        return { url: new URL(url), headers: init?.headers ?? {} };
    }

    it('sends a v3 key as ?api_key= without a Bearer header', async () => {
        const { url, headers } = await searchWith(V3_KEY);
        expect(url.searchParams.get('api_key')).toBe(V3_KEY);
        expect(url.searchParams.get('query')).toBe('Alien');
        expect(headers.Authorization).toBeUndefined();
    });

    it('sends a v4 token as Bearer and keeps it out of the URL', async () => {
        const { url, headers } = await searchWith(V4_TOKEN);
        expect(url.searchParams.has('api_key')).toBe(false);
        expect(headers.Authorization).toBe(`Bearer ${V4_TOKEN}`);
    });
});
