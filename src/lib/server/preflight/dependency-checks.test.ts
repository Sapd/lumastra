// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for runDependencyChecks — the optional-dependency reachability probes
 * used by the first-run wizard. config, getConfigStorageStatus, getConfigPath and
 * fetchWithTimeout are mocked, so no network/filesystem is touched; we drive the
 * per-URL fetch outcome directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DependencyFinding } from './dependency-checks.js';

const { mockConfig, mockStorage, mockFetch, mockGetPaths, mockAccess } = vi.hoisted(() => ({
    mockConfig: {} as Record<string, unknown>,
    mockStorage: vi.fn(),
    mockFetch: vi.fn(),
    mockGetPaths: vi.fn(),
    mockAccess: vi.fn(),
}));

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return { ...actual, config: mockConfig };
});
vi.mock('$lib/server/config/config.service.js', () => ({
    getConfigStorageStatus: (...a: unknown[]) => mockStorage(...a),
}));
vi.mock('$lib/server/config/index.js', () => ({
    getConfigPath: () => '/config/settings.json',
    // config.ts (imported for real above) registers a change listener at load.
    onConfigChange: () => () => {},
}));
vi.mock('$lib/server/utils/fetch-timeout.js', () => ({
    fetchWithTimeout: (...a: unknown[]) => mockFetch(...a),
}));
vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getEnabledLibraryPaths: (...a: unknown[]) => mockGetPaths(...a),
}));
vi.mock('node:fs/promises', () => ({ access: (...a: unknown[]) => mockAccess(...a) }));

const OFF = {
    FEATURE_MUSIC_SONIC: false,
    SONIC_EMBEDDER_URL: '',
    FEATURE_LIVETV: false,
    LIVETV_SOURCE: 'disabled',
    STREAM_PROXY_URL: '',
    STREAM_PROXY_SECRET: '',
    SONARRURL: '',
    SONARRAPIKEY: '',
    RADARRURL: '',
    RADARRAPIKEY: '',
    SEERRURL: '',
    SEERRAPIKEY: '',
    FEATURE_AUDIOBOOKS: false,
    AUDIOURL: '',
    AUDIOAPIKEY: '',
};

const byId = (arr: DependencyFinding[], id: string) => arr.find((f) => f.id === id);

describe('runDependencyChecks', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        Object.assign(mockConfig, OFF);
        mockStorage.mockResolvedValue({ willPersist: true });
        mockFetch.mockResolvedValue({ ok: true });
        mockGetPaths.mockResolvedValue([]);
        mockAccess.mockResolvedValue(undefined); // readable by default
    });

    it('with nothing configured, returns only the config-dir check', async () => {
        const { runDependencyChecks } = await import('./dependency-checks.js');
        const r = await runDependencyChecks();

        expect(r).toHaveLength(1);
        expect(r[0].id).toBe('config-dir');
        expect(r[0].status).toBe('pass');
        expect(r[0].url).toBe('/config');
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('keeps the ABS prefix and sends the configured Authorization header on reachability probes', async () => {
        mockConfig.FEATURE_AUDIOBOOKS = true;
        mockConfig.AUDIOURL = 'http://proxy/audiobookshelf/';
        mockConfig.AUDIOAPIKEY = 'operator-key';
        const { runDependencyChecks } = await import('./dependency-checks.js');
        await runDependencyChecks();
        expect(mockFetch).toHaveBeenCalledWith(
            'http://proxy/audiobookshelf/ping',
            { headers: { Authorization: 'Bearer operator-key' } },
            expect.any(Number),
        );
    });

    it('warns when the config dir will not persist', async () => {
        mockStorage.mockResolvedValue({ willPersist: false });
        const { runDependencyChecks } = await import('./dependency-checks.js');
        const r = await runDependencyChecks();

        expect(byId(r, 'config-dir')?.status).toBe('warn');
    });

    it('probes the sonic embedder /health only when feature+url are set', async () => {
        mockConfig.FEATURE_MUSIC_SONIC = true;
        mockConfig.SONIC_EMBEDDER_URL = 'http://embedder:8000/';
        mockFetch.mockResolvedValue({ ok: true });
        const { runDependencyChecks } = await import('./dependency-checks.js');
        const r = await runDependencyChecks();

        const sonic = byId(r, 'sonic-embedder');
        expect(sonic?.status).toBe('pass');
        expect(sonic?.url).toBe('http://embedder:8000'); // trailing slash trimmed
        expect(mockFetch).toHaveBeenCalledWith(
            'http://embedder:8000/health',
            undefined,
            expect.any(Number),
        );
    });

    it('omits the sonic embedder when the feature is off', async () => {
        mockConfig.FEATURE_MUSIC_SONIC = false;
        mockConfig.SONIC_EMBEDDER_URL = 'http://embedder:8000';
        const { runDependencyChecks } = await import('./dependency-checks.js');
        const r = await runDependencyChecks();

        expect(byId(r, 'sonic-embedder')).toBeUndefined();
    });

    it('warns when a configured service is unreachable (fetch throws)', async () => {
        mockConfig.FEATURE_MUSIC_SONIC = true;
        mockConfig.SONIC_EMBEDDER_URL = 'http://embedder:8000';
        mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
        const { runDependencyChecks } = await import('./dependency-checks.js');
        const r = await runDependencyChecks();

        expect(byId(r, 'sonic-embedder')?.status).toBe('warn');
    });

    it('warns when a service answers non-2xx (e.g. bad api key → 401)', async () => {
        mockConfig.SONARRURL = 'http://sonarr:8989';
        mockConfig.SONARRAPIKEY = 'k';
        mockFetch.mockResolvedValue({ ok: false });
        const { runDependencyChecks } = await import('./dependency-checks.js');
        const r = await runDependencyChecks();

        expect(byId(r, 'sonarr')?.status).toBe('warn');
        expect(mockFetch).toHaveBeenCalledWith(
            'http://sonarr:8989/api/v3/system/status',
            { headers: { 'X-Api-Key': 'k' } },
            expect.any(Number),
        );
    });

    it('gates the Live TV proxy on standalone source + url and sends the secret header', async () => {
        mockConfig.FEATURE_LIVETV = true;
        mockConfig.LIVETV_SOURCE = 'standalone';
        mockConfig.STREAM_PROXY_URL = 'http://proxy:3000';
        mockConfig.STREAM_PROXY_SECRET = 's3cret';
        const { runDependencyChecks } = await import('./dependency-checks.js');
        const r = await runDependencyChecks();

        expect(byId(r, 'stream-proxy')?.status).toBe('pass');
        expect(mockFetch).toHaveBeenCalledWith(
            'http://proxy:3000/status',
            { headers: { 'X-Proxy-Secret': 's3cret' } },
            expect.any(Number),
        );
    });

    it('skips media-path checks entirely when no sql handle is passed', async () => {
        mockGetPaths.mockResolvedValue([{ path: '/data/movies' }]);
        const { runDependencyChecks } = await import('./dependency-checks.js');
        await runDependencyChecks(); // no sql

        expect(mockGetPaths).not.toHaveBeenCalled();
    });

    it('emits one aggregate pass when all library paths are readable', async () => {
        mockGetPaths.mockResolvedValue([{ path: '/data/movies' }, { path: '/data/tv' }]);
        mockAccess.mockResolvedValue(undefined);
        const { runDependencyChecks } = await import('./dependency-checks.js');
        const r = await runDependencyChecks({} as never);

        const ok = byId(r, 'media-paths-ok');
        expect(ok?.status).toBe('pass');
        expect(ok?.count).toBe(2);
        // No per-path warnings when everything is readable.
        expect(r.some((f) => f.id.startsWith('media-path:'))).toBe(false);
    });

    it('warns per unreadable library path and omits the aggregate pass', async () => {
        mockGetPaths.mockResolvedValue([{ path: '/data/movies' }, { path: '/data/missing' }]);
        mockAccess.mockImplementation((p: string) =>
            p === '/data/missing'
                ? Promise.reject(new Error('ENOENT'))
                : Promise.resolve(undefined),
        );
        const { runDependencyChecks } = await import('./dependency-checks.js');
        const r = await runDependencyChecks({} as never);

        expect(byId(r, 'media-paths-ok')).toBeUndefined();
        const bad = byId(r, 'media-path:/data/missing');
        expect(bad?.status).toBe('warn');
        expect(bad?.url).toBe('/data/missing');
    });

    it('tolerates a null/empty library path without dropping the others', async () => {
        mockGetPaths.mockResolvedValue([{ path: '/data/movies' }, { path: null }, { path: '' }]);
        mockAccess.mockResolvedValue(undefined);
        const { runDependencyChecks } = await import('./dependency-checks.js');
        const r = await runDependencyChecks({} as never);

        // The null/empty rows are filtered; the good path still yields the aggregate.
        expect(mockAccess).toHaveBeenCalledTimes(1);
        expect(byId(r, 'media-paths-ok')?.count).toBe(1);
    });

    it('dedupes repeated library paths before probing', async () => {
        mockGetPaths.mockResolvedValue([
            { path: '/data/movies' },
            { path: '/data/movies' },
            { path: '' },
        ]);
        const { runDependencyChecks } = await import('./dependency-checks.js');
        await runDependencyChecks({} as never);

        // '/data/movies' probed once; the empty path is filtered out entirely.
        expect(mockAccess).toHaveBeenCalledTimes(1);
        expect(mockAccess).toHaveBeenCalledWith('/data/movies', expect.anything());
    });
});
