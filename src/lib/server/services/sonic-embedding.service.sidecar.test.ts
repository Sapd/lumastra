// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the HTTP sidecar path in sonic-embedding.service.ts.
 *
 * Covers:
 *   embedBatch — HTTP branch (sidecar URL set):
 *     - Successful NDJSON parse
 *     - Partial failure (embed error line)
 *     - Missing output line (implicit failure)
 *     - Wrong dimension → error result
 *     - Sidecar returns HTTP 503 → all-error results
 *     - Network error (fetch throws) → all-error results
 *     - URL unset → subprocess fallback (execFile is called, fetch is NOT)
 *
 *   embedTextQuery — HTTP branch (sidecar URL set):
 *     - Cache hit (fetch is NOT called)
 *     - Cache miss + sidecar success → result cached
 *     - Sidecar returns null (network error) → null returned, nothing cached
 *     - Sidecar returns HTTP error → null returned
 *     - Wrong dimension response → null returned
 *     - Empty text → null (no fetch)
 *     - URL unset → subprocess fallback (execFile is called, fetch is NOT)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const mockExecFileAsync = vi.fn();
const mockFetch = vi.fn();
const mockCacheGet = vi.fn<(key: string) => Promise<string | null>>().mockResolvedValue(null);
const mockCacheSet = vi
    .fn<(key: string, value: string, ttl: number) => Promise<boolean>>()
    .mockResolvedValue(true);

// Config is mutable so individual tests can flip SONIC_EMBEDDER_URL on/off.
const mockConfig = vi.hoisted(() => ({
    SONIC_EMBEDDER_URL: 'http://sonic-embedder:8000',
    SONIC_EMBEDDER_PYTHON: 'python3',
    SONIC_EMBEDDER_SCRIPT: 'workers/sonic-embedder/embed.py',
    SONIC_EMBEDDER_TEXT_SCRIPT: 'workers/sonic-embedder/embed_text.py',
    SONIC_EMBEDDER_BATCH_SIZE: 16,
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: () => mockExecFileAsync }));

vi.mock('$lib/server/config.js', () => ({ config: mockConfig }));

vi.mock('$lib/server/cache/valkey.js', () => ({
    cacheGet: (key: string) => mockCacheGet(key),
    cacheSet: (key: string, value: string, ttl: number) => mockCacheSet(key, value, ttl),
}));

// Shared logger spies so the redirect-policy tests can assert WHAT was logged
// (host only, never the full redirect URL). Both the service module and the
// fetch-utils helper it routes through resolve to this same mocked module.
const mockLogWarn = vi.fn();
const mockLogError = vi.fn();
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: mockLogWarn,
            error: mockLogError,
        }),
    },
}));

// Stub globalThis.fetch so the service module's fetch() calls hit our mock.
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a 1024-element float array. */
function fakeEmbedding(seed = 0.1): number[] {
    return Array.from({ length: 1024 }, (_, i) => (i % 100) * seed * 0.01);
}

/** Build a JSONL string for an array of path+embedding pairs. */
function buildNdjson(rows: Array<{ path: string; embedding?: number[]; error?: string }>): string {
    return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/** Build a mock Response object. */
function mockResponse(body: string, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(body),
    } as unknown as Response;
}

// Cache key formula matches the service implementation.
function textCacheKey(text: string): string {
    return `v1:text-embed:${createHash('sha256').update(text.trim()).digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps persistent implementations and unconsumed *Once
    // values; reset fetch fully so one test's queue can't leak into the next.
    mockFetch.mockReset();
    mockConfig.SONIC_EMBEDDER_URL = 'http://sonic-embedder:8000';
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(true);
});

// ===========================================================================
// embedBatch — HTTP sidecar path
// ===========================================================================

describe('embedBatch — HTTP sidecar path', () => {
    test('returns success results from NDJSON response', async () => {
        const paths = ['/music/a.flac', '/music/b.mp3'];
        const embeddings = paths.map((_, i) => fakeEmbedding(i + 1));
        const ndjson = buildNdjson(paths.map((path, i) => ({ path, embedding: embeddings[i] })));
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));

        vi.resetModules();
        const { embedBatch } = await import('./sonic-embedding.service.js');
        const results = await embedBatch(paths);

        expect(results).toHaveLength(2);
        expect('embedding' in results[0]).toBe(true);
        expect('embedding' in results[1]).toBe(true);
        // Verify fetch was called (not execFile)
        expect(mockFetch).toHaveBeenCalledOnce();
        expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    test('sends POST /embed with correct JSON body', async () => {
        const paths = ['/music/track.flac'];
        const ndjson = buildNdjson([{ path: paths[0], embedding: fakeEmbedding() }]);
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));

        vi.resetModules();
        const { embedBatch } = await import('./sonic-embedding.service.js');
        await embedBatch(paths);

        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://sonic-embedder:8000/embed');
        expect(init.method).toBe('POST');
        const body = JSON.parse(init.body as string) as { paths: string[] };
        expect(body.paths).toEqual(paths);
    });

    test('includes threads in POST /embed body when threads > 0', async () => {
        const paths = ['/music/track.flac'];
        const ndjson = buildNdjson([{ path: paths[0], embedding: fakeEmbedding() }]);
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));

        vi.resetModules();
        const { embedBatch } = await import('./sonic-embedding.service.js');
        await embedBatch(paths, 4);

        expect(mockFetch).toHaveBeenCalledOnce();
        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(init.body as string) as { paths: string[]; threads?: number };
        expect(body.threads).toBe(4);
    });

    test('omits threads from POST /embed body when threads is undefined', async () => {
        const paths = ['/music/track.flac'];
        const ndjson = buildNdjson([{ path: paths[0], embedding: fakeEmbedding() }]);
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));

        vi.resetModules();
        const { embedBatch } = await import('./sonic-embedding.service.js');
        await embedBatch(paths, undefined);

        expect(mockFetch).toHaveBeenCalledOnce();
        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(init.body as string) as { paths: string[]; threads?: number };
        expect(body.threads).toBeUndefined();
    });

    test('omits threads from POST /embed body when threads = 0', async () => {
        const paths = ['/music/track.flac'];
        const ndjson = buildNdjson([{ path: paths[0], embedding: fakeEmbedding() }]);
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));

        vi.resetModules();
        const { embedBatch } = await import('./sonic-embedding.service.js');
        await embedBatch(paths, 0);

        expect(mockFetch).toHaveBeenCalledOnce();
        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(init.body as string) as { paths: string[]; threads?: number };
        expect(body.threads).toBeUndefined();
    });

    test('marks path as error when sidecar emits an error line', async () => {
        const goodPath = '/music/good.flac';
        const badPath = '/music/bad.mp3';
        const ndjson = buildNdjson([
            { path: goodPath, embedding: fakeEmbedding() },
            { path: badPath, error: 'unsupported format' },
        ]);
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));

        vi.resetModules();
        const { embedBatch, isEmbedSuccess } = await import('./sonic-embedding.service.js');
        const results = await embedBatch([goodPath, badPath]);

        expect(results).toHaveLength(2);
        const good = results.find((r) => r.path === goodPath)!;
        const bad = results.find((r) => r.path === badPath)!;
        expect(isEmbedSuccess(good)).toBe(true);
        expect(isEmbedSuccess(bad)).toBe(false);
        expect((bad as { error: string }).error).toContain('unsupported format');
    });

    test('returns implicit failure when path produces no NDJSON line', async () => {
        const path1 = '/music/first.flac';
        const path2 = '/music/second.flac';
        // Only path1 appears in the response
        const ndjson = buildNdjson([{ path: path1, embedding: fakeEmbedding() }]);
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));

        vi.resetModules();
        const { embedBatch, isEmbedSuccess } = await import('./sonic-embedding.service.js');
        const results = await embedBatch([path1, path2]);

        expect(results).toHaveLength(2);
        const missing = results.find((r) => r.path === path2)!;
        expect(isEmbedSuccess(missing)).toBe(false);
        expect((missing as { error: string }).error).toContain('no output');
    });

    test('returns error result for wrong embedding dimension', async () => {
        const path = '/music/weird.flac';
        const badEmbedding = Array.from({ length: 512 }, () => 0.1);
        const ndjson = buildNdjson([{ path, embedding: badEmbedding }]);
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));

        vi.resetModules();
        const { embedBatch, isEmbedSuccess } = await import('./sonic-embedding.service.js');
        const results = await embedBatch([path]);

        expect(results).toHaveLength(1);
        expect(isEmbedSuccess(results[0])).toBe(false);
        expect((results[0] as { error: string }).error).toContain('512');
    });

    // An outage says nothing about the tracks, so it must not come back as one
    // failure per path: those count toward the per-track write-off, and an
    // outage spanning a few scheduled runs used to write a whole library off.
    test('throws SonicEngineError when sidecar returns HTTP 503', async () => {
        const paths = ['/music/a.flac', '/music/b.flac'];
        mockFetch.mockResolvedValueOnce(mockResponse('{"detail":"model loading"}', 503));

        vi.resetModules();
        const { embedBatch, SonicEngineError } = await import('./sonic-embedding.service.js');
        const failure = embedBatch(paths);

        await expect(failure).rejects.toBeInstanceOf(SonicEngineError);
        await expect(failure).rejects.toThrow(/503/);
    });

    test('throws SonicEngineError when fetch throws (network error)', async () => {
        const paths = ['/music/a.flac'];
        mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

        vi.resetModules();
        const { embedBatch, SonicEngineError } = await import('./sonic-embedding.service.js');
        const failure = embedBatch(paths);

        await expect(failure).rejects.toBeInstanceOf(SonicEngineError);
        await expect(failure).rejects.toThrow(/ECONNREFUSED/);
    });

    test('throws SonicEngineError when the sidecar cannot load the model for any path', async () => {
        const paths = ['/music/a.flac', '/music/b.flac'];
        mockFetch.mockResolvedValueOnce(
            mockResponse(
                buildNdjson(paths.map((path) => ({ path, error: 'model load failed: OOM' }))),
            ),
        );

        vi.resetModules();
        const { embedBatch, SonicEngineError } = await import('./sonic-embedding.service.js');
        await expect(embedBatch(paths)).rejects.toBeInstanceOf(SonicEngineError);
    });

    test('returns empty array without fetching when paths is empty', async () => {
        vi.resetModules();
        const { embedBatch } = await import('./sonic-embedding.service.js');
        const results = await embedBatch([]);

        expect(results).toEqual([]);
        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockExecFileAsync).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// embedBatch — subprocess fallback (URL unset)
// ===========================================================================

describe('embedBatch — subprocess fallback (SONIC_EMBEDDER_URL empty)', () => {
    test('calls execFile and NOT fetch when URL is empty', async () => {
        mockConfig.SONIC_EMBEDDER_URL = '';
        const paths = ['/music/a.flac'];
        const ndjson = buildNdjson([{ path: paths[0], embedding: fakeEmbedding() }]);
        mockExecFileAsync.mockResolvedValueOnce({ stdout: ndjson, stderr: '' });

        vi.resetModules();
        const { embedBatch, isEmbedSuccess } = await import('./sonic-embedding.service.js');
        const results = await embedBatch(paths);

        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockExecFileAsync).toHaveBeenCalledOnce();
        expect(results).toHaveLength(1);
        expect(isEmbedSuccess(results[0])).toBe(true);
    });

    test('sets SONIC_EMBEDDER_THREADS and OMP_NUM_THREADS in subprocess env when threads = 4', async () => {
        mockConfig.SONIC_EMBEDDER_URL = '';
        const paths = ['/music/a.flac'];
        const ndjson = buildNdjson([{ path: paths[0], embedding: fakeEmbedding() }]);
        mockExecFileAsync.mockResolvedValueOnce({ stdout: ndjson, stderr: '' });

        vi.resetModules();
        const { embedBatch } = await import('./sonic-embedding.service.js');
        await embedBatch(paths, 4);

        expect(mockExecFileAsync).toHaveBeenCalledOnce();
        const [, , opts] = mockExecFileAsync.mock.calls[0] as [
            string,
            string[],
            { env: Record<string, string> },
        ];
        expect(opts.env.SONIC_EMBEDDER_THREADS).toBe('4');
        expect(opts.env.OMP_NUM_THREADS).toBe('4');
    });

    test('does NOT set SONIC_EMBEDDER_THREADS in subprocess env when threads is undefined', async () => {
        mockConfig.SONIC_EMBEDDER_URL = '';
        const paths = ['/music/a.flac'];
        const ndjson = buildNdjson([{ path: paths[0], embedding: fakeEmbedding() }]);
        mockExecFileAsync.mockResolvedValueOnce({ stdout: ndjson, stderr: '' });

        vi.resetModules();
        const { embedBatch } = await import('./sonic-embedding.service.js');
        await embedBatch(paths, undefined);

        expect(mockExecFileAsync).toHaveBeenCalledOnce();
        const [, , opts] = mockExecFileAsync.mock.calls[0] as [
            string,
            string[],
            { env: Record<string, string> },
        ];
        // Task should not have added SONIC_EMBEDDER_THREADS beyond what process.env already has
        const envVal = opts.env.SONIC_EMBEDDER_THREADS;
        const processEnvVal = process.env.SONIC_EMBEDDER_THREADS;
        if (processEnvVal === undefined) {
            expect(envVal).toBeUndefined();
        } else {
            expect(envVal).toBe(processEnvVal);
        }
    });
});

// ===========================================================================
// embedTextQuery — HTTP sidecar path
// ===========================================================================

describe('embedTextQuery — HTTP sidecar path', () => {
    test('returns embedding from sidecar on cache miss', async () => {
        const text = 'calm piano';
        const embedding = fakeEmbedding(0.3);
        mockCacheGet.mockResolvedValueOnce(null); // cache miss
        mockFetch.mockResolvedValueOnce(mockResponse(JSON.stringify(embedding)));

        vi.resetModules();
        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        const result = await embedTextQuery(text);

        expect(result).toHaveLength(1024);
        expect(mockFetch).toHaveBeenCalledOnce();
        // Should have stored result in cache
        expect(mockCacheSet).toHaveBeenCalledOnce();
        const [cacheKey, value, ttl] = mockCacheSet.mock.calls[0] as unknown as [
            string,
            string,
            number,
        ];
        expect(cacheKey).toBe(textCacheKey(text));
        expect(JSON.parse(value)).toEqual(embedding);
        expect(ttl).toBe(3600);
    });

    test('returns embedding from Valkey cache without calling fetch', async () => {
        const text = 'jazz fusion';
        const embedding = fakeEmbedding(0.7);
        mockCacheGet.mockResolvedValueOnce(JSON.stringify(embedding));

        vi.resetModules();
        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        const result = await embedTextQuery(text);

        expect(result).toHaveLength(1024);
        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockCacheSet).not.toHaveBeenCalled();
    });

    test('cache key is v1:text-embed:<sha256(text)>', async () => {
        const text = 'upbeat rock';
        const embedding = fakeEmbedding(0.2);
        mockCacheGet.mockResolvedValueOnce(null);
        mockFetch.mockResolvedValueOnce(mockResponse(JSON.stringify(embedding)));

        vi.resetModules();
        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        await embedTextQuery(text);

        expect(mockCacheGet).toHaveBeenCalledOnce();
        const [key] = mockCacheGet.mock.calls[0] as unknown as [string];
        expect(key).toBe(textCacheKey(text));
    });

    test('returns null and does not cache when sidecar throws (network error)', async () => {
        const text = 'ambient electronic';
        mockCacheGet.mockResolvedValueOnce(null);
        mockFetch.mockRejectedValueOnce(new Error('ETIMEDOUT'));

        vi.resetModules();
        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        const result = await embedTextQuery(text);

        expect(result).toBeNull();
        expect(mockCacheSet).not.toHaveBeenCalled();
    });

    test('returns null and does not cache when sidecar returns HTTP 503', async () => {
        const text = 'deep house';
        mockCacheGet.mockResolvedValueOnce(null);
        mockFetch.mockResolvedValueOnce(mockResponse('{"detail":"loading"}', 503));

        vi.resetModules();
        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        const result = await embedTextQuery(text);

        expect(result).toBeNull();
        expect(mockCacheSet).not.toHaveBeenCalled();
    });

    test('returns null when sidecar response has wrong dimension', async () => {
        const text = 'folk acoustic';
        const shortEmbedding = Array.from({ length: 512 }, () => 0.1);
        mockCacheGet.mockResolvedValueOnce(null);
        mockFetch.mockResolvedValueOnce(mockResponse(JSON.stringify(shortEmbedding)));

        vi.resetModules();
        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        const result = await embedTextQuery(text);

        expect(result).toBeNull();
        expect(mockCacheSet).not.toHaveBeenCalled();
    });

    test('returns null when a sidecar response has the right length but a non-finite entry (C21)', async () => {
        const text = 'glitchy synth';
        // JSON has no Infinity/NaN literal — a hand-rolled or buggy sidecar
        // response is realistically represented as a `null` slot, which
        // `JSON.parse` preserves and `Number.isFinite(null)` also rejects.
        const badEmbedding: (number | null)[] = fakeEmbedding(0.1);
        badEmbedding[500] = null;
        mockCacheGet.mockResolvedValueOnce(null);
        mockFetch.mockResolvedValueOnce(mockResponse(JSON.stringify(badEmbedding)));

        vi.resetModules();
        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        const result = await embedTextQuery(text);

        expect(result).toBeNull();
        expect(mockCacheSet).not.toHaveBeenCalled();
    });

    test('returns null for empty text without calling fetch or cache', async () => {
        vi.resetModules();
        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        const result = await embedTextQuery('   ');

        expect(result).toBeNull();
        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockCacheGet).not.toHaveBeenCalled();
    });

    test('sends POST /embed-text with correct body', async () => {
        const text = 'metal drums';
        const embedding = fakeEmbedding(0.5);
        mockCacheGet.mockResolvedValueOnce(null);
        mockFetch.mockResolvedValueOnce(mockResponse(JSON.stringify(embedding)));

        vi.resetModules();
        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        await embedTextQuery(text);

        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://sonic-embedder:8000/embed-text');
        expect(init.method).toBe('POST');
        const body = JSON.parse(init.body as string) as { text: string };
        expect(body.text).toBe(text);
    });

    test('uses trimmed text for both the request and the cache key', async () => {
        const text = '  chill beats  ';
        const trimmed = 'chill beats';
        const embedding = fakeEmbedding(0.4);
        mockCacheGet.mockResolvedValueOnce(null);
        mockFetch.mockResolvedValueOnce(mockResponse(JSON.stringify(embedding)));

        vi.resetModules();
        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        await embedTextQuery(text);

        // Cache key uses trimmed text
        const [cacheKey] = mockCacheGet.mock.calls[0] as [string];
        expect(cacheKey).toBe(textCacheKey(trimmed));

        // Request body uses trimmed text
        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(init.body as string) as { text: string };
        expect(body.text).toBe(trimmed);
    });
});

// ===========================================================================
// embedTextQuery — subprocess fallback (URL unset)
// ===========================================================================

describe('embedTextQuery — subprocess fallback (SONIC_EMBEDDER_URL empty)', () => {
    test('calls execFile and NOT fetch when URL is empty', async () => {
        mockConfig.SONIC_EMBEDDER_URL = '';
        const text = 'classical strings';
        const embedding = fakeEmbedding(0.6);
        mockExecFileAsync.mockResolvedValueOnce({
            stdout: JSON.stringify(embedding) + '\n',
            stderr: '',
        });

        vi.resetModules();
        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        const result = await embedTextQuery(text);

        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockCacheGet).not.toHaveBeenCalled();
        expect(mockExecFileAsync).toHaveBeenCalledOnce();
        expect(result).toHaveLength(1024);
    });

    test('returns null when subprocess fails', async () => {
        mockConfig.SONIC_EMBEDDER_URL = '';
        mockExecFileAsync.mockRejectedValueOnce(new Error('python3 not found'));

        vi.resetModules();
        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        const result = await embedTextQuery('sad ballad');

        expect(result).toBeNull();
    });

    test('passes the correct stdin payload to subprocess', async () => {
        mockConfig.SONIC_EMBEDDER_URL = '';
        const text = 'energetic workout';
        const embedding = fakeEmbedding(0.9);
        mockExecFileAsync.mockResolvedValueOnce({
            stdout: JSON.stringify(embedding) + '\n',
            stderr: '',
        });

        vi.resetModules();
        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        await embedTextQuery(text);

        const [_bin, _args, opts] = mockExecFileAsync.mock.calls[0] as [
            string,
            string[],
            { input: string },
        ];
        const payload = JSON.parse(opts.input) as { text: string };
        expect(payload.text).toBe(text);
    });
});

// ===========================================================================
// Redirect policy (C29 class) — both sidecar call sites
// ===========================================================================
//
// `SONIC_EMBEDDER_URL` is admin-configured. A compromised or misconfigured
// sidecar answering a 3xx must not be able to steer the request to an
// arbitrary host the app can reach (blind SSRF). Same-origin hops are still
// followed (reverse proxy in front of the SAME base URL); a Location that
// leaves the configured origin is refused, logged by host only, and the hop
// count is capped.

/** Build a mock 3xx Response carrying a Location header. */
function redirectResponse(location: string): Response {
    return new Response(null, { status: 302, headers: { location } });
}

describe('embedBatch — sidecar redirect policy (C29)', () => {
    const paths = ['/music/a.flac'];

    test('issues POST /embed with redirect:"manual"', async () => {
        mockFetch.mockResolvedValueOnce(
            mockResponse(buildNdjson([{ path: paths[0], embedding: fakeEmbedding() }])),
        );

        vi.resetModules();
        const { embedBatch } = await import('./sonic-embedding.service.js');
        await embedBatch(paths);

        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(init.redirect).toBe('manual');
    });

    test('follows a same-origin redirect and parses the final body', async () => {
        mockFetch
            .mockResolvedValueOnce(redirectResponse('http://sonic-embedder:8000/embed-v2'))
            .mockResolvedValueOnce(
                mockResponse(buildNdjson([{ path: paths[0], embedding: fakeEmbedding() }])),
            );

        vi.resetModules();
        const { embedBatch, isEmbedSuccess } = await import('./sonic-embedding.service.js');
        const results = await embedBatch(paths);

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect((mockFetch.mock.calls[1] as [string])[0]).toBe(
            'http://sonic-embedder:8000/embed-v2',
        );
        expect(isEmbedSuccess(results[0])).toBe(true);
    });

    test('refuses a cross-origin redirect: engine error, target never contacted', async () => {
        mockFetch.mockResolvedValueOnce(redirectResponse('http://127.0.0.1:9999/secret-admin'));

        vi.resetModules();
        const { embedBatch, SonicEngineError } = await import('./sonic-embedding.service.js');
        const failure = embedBatch(paths);

        await expect(failure).rejects.toBeInstanceOf(SonicEngineError);
        await expect(failure).rejects.toThrow(/cross-origin redirect/);
        // The only other request is the sidecar's own /health check.
        const urls = mockFetch.mock.calls.map((c) => String((c as [string])[0]));
        expect(urls.some((u) => u.includes('127.0.0.1'))).toBe(false);
        expect(urls.filter((u) => u.endsWith('/embed'))).toHaveLength(1);
    });

    // Port is deliberately NOT compared — see the standing policy on
    // isAllowedRedirectTarget() in $lib/server/utils/fetch-utils: "an
    // admin-configured host fronted by a reverse proxy on a different port is
    // exactly the same-host case this policy exists for". Only a cross-HOST
    // hop or an https->http downgrade is refused. This test asserted the older
    // C29 port-sensitive rule and outlived it.
    test('follows a same-host redirect to a different port (reverse-proxy case)', async () => {
        mockFetch
            .mockResolvedValueOnce(redirectResponse('http://sonic-embedder:8001/embed'))
            .mockResolvedValueOnce(
                mockResponse(buildNdjson([{ path: paths[0], embedding: fakeEmbedding() }])),
            );

        vi.resetModules();
        const { embedBatch, isEmbedSuccess } = await import('./sonic-embedding.service.js');
        const results = await embedBatch(paths);

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect((mockFetch.mock.calls[1] as [string])[0]).toBe('http://sonic-embedder:8001/embed');
        expect(isEmbedSuccess(results[0])).toBe(true);
    });

    test('logs a refused redirect by host only, never the full URL', async () => {
        mockFetch.mockResolvedValueOnce(redirectResponse('http://127.0.0.1:9999/secret-admin'));

        vi.resetModules();
        const { embedBatch } = await import('./sonic-embedding.service.js');
        await embedBatch(paths).catch(() => undefined);

        expect(mockLogWarn).toHaveBeenCalledWith(
            expect.stringMatching(/refusing cross-host or scheme-downgrade redirect/i),
            expect.objectContaining({ host: '127.0.0.1:9999' }),
        );
        const everythingLogged = JSON.stringify([
            ...mockLogWarn.mock.calls,
            ...mockLogError.mock.calls,
        ]);
        expect(everythingLogged).not.toContain('secret-admin');
    });

    test('caps the same-origin redirect hop count instead of looping forever', async () => {
        mockFetch.mockImplementation(() =>
            Promise.resolve(redirectResponse('http://sonic-embedder:8000/embed')),
        );

        vi.resetModules();
        const { embedBatch, SonicEngineError } = await import('./sonic-embedding.service.js');
        const failure = embedBatch(paths);

        await expect(failure).rejects.toBeInstanceOf(SonicEngineError);
        await expect(failure).rejects.toThrow(/redirect/i);
        // Hop cap per request: the /embed call and the /health check each stop.
        expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(12);
    });
});

describe('embedTextQuery — sidecar redirect policy (C29)', () => {
    const text = 'melancholic piano';
    const good = JSON.stringify(fakeEmbedding());

    test('issues POST /embed-text with redirect:"manual"', async () => {
        mockFetch.mockResolvedValueOnce(mockResponse(good));

        vi.resetModules();
        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        await embedTextQuery(text);

        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(init.redirect).toBe('manual');
    });

    test('follows a same-origin redirect and returns the embedding', async () => {
        mockFetch
            .mockResolvedValueOnce(redirectResponse('/embed-text-v2'))
            .mockResolvedValueOnce(mockResponse(good));

        vi.resetModules();
        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        const result = await embedTextQuery(text);

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect((mockFetch.mock.calls[1] as [string])[0]).toBe(
            'http://sonic-embedder:8000/embed-text-v2',
        );
        expect(result).toHaveLength(1024);
    });

    test('refuses a cross-origin redirect: returns null, caches nothing, target never contacted', async () => {
        mockFetch.mockResolvedValueOnce(redirectResponse('http://10.0.0.5/embed-text'));

        vi.resetModules();
        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        const result = await embedTextQuery(text);

        expect(result).toBeNull();
        expect(mockFetch).toHaveBeenCalledOnce();
        expect(mockCacheSet).not.toHaveBeenCalled();
    });

    test('logs a refused redirect by host only, never the full URL', async () => {
        mockFetch.mockResolvedValueOnce(redirectResponse('http://10.0.0.5/internal-path'));

        vi.resetModules();
        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        await embedTextQuery(text);

        expect(mockLogWarn).toHaveBeenCalledWith(
            expect.stringMatching(/refusing cross-host or scheme-downgrade redirect/i),
            expect.objectContaining({ host: '10.0.0.5' }),
        );
        const everythingLogged = JSON.stringify([
            ...mockLogWarn.mock.calls,
            ...mockLogError.mock.calls,
        ]);
        expect(everythingLogged).not.toContain('internal-path');
    });

    test('caps the same-origin redirect hop count and returns null', async () => {
        mockFetch.mockImplementation(() => Promise.resolve(redirectResponse('/embed-text')));

        vi.resetModules();
        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        const result = await embedTextQuery(text);

        expect(result).toBeNull();
        expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(6);
    });
});

// ===========================================================================
// embedBatch — busy sidecar (HTTP 429 from the memory gate)
// ===========================================================================

/** A 429 the way the sidecar's memory gate sends it. */
function busyResponse(retryAfterSeconds = 10): Response {
    return {
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': String(retryAfterSeconds) }),
        text: () => Promise.resolve('{"detail":{"code":"busy"}}'),
    } as unknown as Response;
}

describe('embedBatch — busy sidecar (429)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    test('asks for a 429 instead of an unbounded queue (accept_busy)', async () => {
        mockFetch.mockResolvedValueOnce(
            mockResponse(buildNdjson([{ path: '/m/a.flac', embedding: fakeEmbedding() }])),
        );
        vi.resetModules();
        const { embedBatch } = await import('./sonic-embedding.service.js');
        await embedBatch(['/m/a.flac']);
        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(JSON.parse(init.body as string)).toMatchObject({ accept_busy: true });
    });

    test('waits Retry-After and resends the same batch; nothing is charged', async () => {
        const paths = ['/m/a.flac', '/m/b.flac'];
        mockFetch
            .mockResolvedValueOnce(busyResponse(10))
            .mockResolvedValueOnce(
                mockResponse(
                    buildNdjson(paths.map((path) => ({ path, embedding: fakeEmbedding() }))),
                ),
            );
        vi.resetModules();
        const { embedBatch } = await import('./sonic-embedding.service.js');
        const pending = embedBatch(paths);
        await vi.advanceTimersByTimeAsync(9_000);
        expect(mockFetch).toHaveBeenCalledTimes(1); // still waiting
        await vi.advanceTimersByTimeAsync(1_000);
        const results = await pending;
        expect(results.every((r) => 'embedding' in r)).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        const bodies = mockFetch.mock.calls.map(
            ([, init]) => JSON.parse((init as RequestInit).body as string) as { paths: string[] },
        );
        expect(bodies[1].paths).toEqual(paths);
    });

    test('stays busy past the wait budget: SonicBusyError, no per-path retry, nothing in flight', async () => {
        mockFetch.mockImplementation(() => Promise.resolve(busyResponse(120)));
        vi.resetModules();
        const { embedBatch, SonicBusyError, SonicEngineError } =
            await import('./sonic-embedding.service.js');
        const pending = embedBatch(['/m/a.flac', '/m/b.flac']);
        const settled = pending.catch((err: unknown) => err);
        await vi.advanceTimersByTimeAsync(16 * 60_000);
        const err = await settled;
        expect(err).toBeInstanceOf(SonicBusyError);
        // Callers that handle outages keep working: it is a SonicEngineError…
        expect(err).toBeInstanceOf(SonicEngineError);
        // …with no track in flight, so none becomes a crash suspect.
        expect((err as InstanceType<typeof SonicEngineError>).inFlight).toEqual([]);
        // Never fell back to path-by-path (which charges each path) or /health.
        const urls = mockFetch.mock.calls.map(([url]) => url as string);
        expect(urls.every((u) => u.endsWith('/embed'))).toBe(true);
        expect(
            mockFetch.mock.calls.every(
                ([, init]) =>
                    (JSON.parse((init as RequestInit).body as string) as { paths: string[] }).paths
                        .length === 2,
            ),
        ).toBe(true);
    });

    test('an abort ends the wait at once', async () => {
        mockFetch.mockImplementation(() => Promise.resolve(busyResponse(120)));
        vi.resetModules();
        const { embedPaths, SonicBusyError } = await import('./sonic-embedding.service.js');
        const controller = new AbortController();
        const settled = embedPaths(['/m/a.flac'], undefined, controller.signal).catch(
            (err: unknown) => err,
        );
        await vi.advanceTimersByTimeAsync(1_000);
        controller.abort();
        await vi.advanceTimersByTimeAsync(0);
        expect(await settled).toBeInstanceOf(SonicBusyError);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test('a file that cannot fit the sidecar even alone is an engine error, not a track failure', async () => {
        const paths = ['/m/ok.flac', '/m/huge.flac'];
        mockFetch.mockResolvedValueOnce(
            mockResponse(
                [
                    JSON.stringify({ path: paths[0], embedding: fakeEmbedding() }),
                    JSON.stringify({
                        path: paths[1],
                        error: 'needs about 900 MB, more than this sidecar can ever give a job',
                        code: 'exceeds_memory_budget',
                    }),
                ].join('\n') + '\n',
            ),
        );
        vi.resetModules();
        const { embedBatch, SonicBusyError, SonicEngineError } =
            await import('./sonic-embedding.service.js');
        const err = await embedBatch(paths).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SonicEngineError);
        expect(err).not.toBeInstanceOf(SonicBusyError);
        expect((err as Error).message).toMatch(/memory too small/);
        // What did embed is kept for the caller to store.
        const partial = (err as InstanceType<typeof SonicEngineError>).partial;
        expect(partial.map((r) => r.path)).toEqual([paths[0]]);
    });
});
