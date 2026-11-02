// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the HTTP sidecar client in music-analysis-sidecar.service.ts.
 *
 * Modeled on sonic-embedding.service.sidecar.test.ts (hoisted mock fetch +
 * mock config). The /analyze client mirrors the /embed client: one JSONL line
 * per input path, in input order, discriminated by `analysis` (success) vs
 * `error` (failure).
 *
 * Covers analyzeBatch / analyzeOne — HTTP branch (SONIC_ANALYZE_URL set):
 *   - Successful NDJSON parse (one analysis line per path)
 *   - Partial per-path failure (one `error` line)
 *   - Missing output line (implicit failure)
 *   - Sidecar returns HTTP 503 → THROWS SidecarUnreachableError (transport)
 *   - Network error (fetch throws) → THROWS SidecarUnreachableError (transport)
 *   - Per-path error line in a 200 response → returns per-path error (durable)
 *   - Correct POST /analyze body (paths + optional threads)
 *
 * And the URL-unset path:
 *   - SONIC_ANALYZE_URL empty → fetch NOT called, every path marked error
 *     (the caller, analyzeTrack, treats this as "fall back to the binary").
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SidecarAnalysis } from './music-analysis-sidecar.service.js';

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

// Config is mutable so individual tests can flip SONIC_ANALYZE_URL on/off.
const mockConfig = vi.hoisted(() => ({
    SONIC_ANALYZE_URL: 'http://sonic-embedder:8000',
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('$lib/server/config.js', () => ({ config: mockConfig }));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

// Stub globalThis.fetch so the service module's fetch() calls hit our mock.
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal but complete SidecarAnalysis object. */
function fakeAnalysis(overrides: Partial<SidecarAnalysis> = {}): SidecarAnalysis {
    return {
        schema_version: 1,
        bpm: 128,
        key: 'A',
        scale: 'minor',
        average_loudness: 0.74,
        loudness_lufs: -8.3,
        danceability: 1.42,
        beats_position: [0.46, 0.93, 1.4],
        frame_rms: [0.01, 0.02],
        frame_energy: [12.3, 11.0],
        duration: 214.7,
        mood_tags: ['electronic', 'party'],
        extras: {
            zcr_mean: 0.061,
            spectral_centroid_mean: 2310.0,
            spectral_entropy_mean: null,
            dynamic_complexity: null,
            silence_rate_60: 0.0,
            spectral_complexity_var: 0.0,
            band_ratio_mean: [],
            band_ratio_var: [],
        },
        ...overrides,
    };
}

/** Build a JSONL string for an array of path+analysis|error rows. */
function buildNdjson(
    rows: Array<{ path: string; analysis?: SidecarAnalysis; error?: string }>,
): string {
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.SONIC_ANALYZE_URL = 'http://sonic-embedder:8000';
});

// ===========================================================================
// analyzeBatch — HTTP sidecar path
// ===========================================================================

describe('analyzeBatch — HTTP sidecar path', () => {
    test('returns success results from NDJSON response', async () => {
        const paths = ['/music/a.flac', '/music/b.mp3'];
        const ndjson = buildNdjson(paths.map((path) => ({ path, analysis: fakeAnalysis() })));
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));

        vi.resetModules();
        const { analyzeBatch, isAnalyzeSuccess } =
            await import('./music-analysis-sidecar.service.js');
        const results = await analyzeBatch(paths);

        expect(results).toHaveLength(2);
        expect(isAnalyzeSuccess(results[0])).toBe(true);
        expect(isAnalyzeSuccess(results[1])).toBe(true);
        expect(mockFetch).toHaveBeenCalledOnce();
    });

    test('preserves input order in returned results', async () => {
        const paths = ['/music/a.flac', '/music/b.flac', '/music/c.flac'];
        // Emit response lines out of order — the client must reorder by input.
        const ndjson = buildNdjson([
            { path: paths[2], analysis: fakeAnalysis({ bpm: 3 }) },
            { path: paths[0], analysis: fakeAnalysis({ bpm: 1 }) },
            { path: paths[1], analysis: fakeAnalysis({ bpm: 2 }) },
        ]);
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));

        vi.resetModules();
        const { analyzeBatch, isAnalyzeSuccess } =
            await import('./music-analysis-sidecar.service.js');
        const results = await analyzeBatch(paths);

        expect(results.map((r) => r.path)).toEqual(paths);
        expect(results.every((r) => isAnalyzeSuccess(r))).toBe(true);
    });

    test('sends POST /analyze with correct JSON body', async () => {
        const paths = ['/music/track.flac'];
        const ndjson = buildNdjson([{ path: paths[0], analysis: fakeAnalysis() }]);
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));

        vi.resetModules();
        const { analyzeBatch } = await import('./music-analysis-sidecar.service.js');
        await analyzeBatch(paths);

        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://sonic-embedder:8000/analyze');
        expect(init.method).toBe('POST');
        expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
        const body = JSON.parse(init.body as string) as { paths: string[] };
        expect(body.paths).toEqual(paths);
    });

    test('includes threads in POST /analyze body when threads > 0', async () => {
        const paths = ['/music/track.flac'];
        const ndjson = buildNdjson([{ path: paths[0], analysis: fakeAnalysis() }]);
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));

        vi.resetModules();
        const { analyzeBatch } = await import('./music-analysis-sidecar.service.js');
        await analyzeBatch(paths, 4);

        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(init.body as string) as { paths: string[]; threads?: number };
        expect(body.threads).toBe(4);
    });

    test('omits threads from POST /analyze body when threads is undefined', async () => {
        const paths = ['/music/track.flac'];
        const ndjson = buildNdjson([{ path: paths[0], analysis: fakeAnalysis() }]);
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));

        vi.resetModules();
        const { analyzeBatch } = await import('./music-analysis-sidecar.service.js');
        await analyzeBatch(paths, undefined);

        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(init.body as string) as { paths: string[]; threads?: number };
        expect(body.threads).toBeUndefined();
    });

    test('omits threads from POST /analyze body when threads = 0', async () => {
        const paths = ['/music/track.flac'];
        const ndjson = buildNdjson([{ path: paths[0], analysis: fakeAnalysis() }]);
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));

        vi.resetModules();
        const { analyzeBatch } = await import('./music-analysis-sidecar.service.js');
        await analyzeBatch(paths, 0);

        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(init.body as string) as { paths: string[]; threads?: number };
        expect(body.threads).toBeUndefined();
    });

    test('marks path as error when sidecar emits an error line', async () => {
        const goodPath = '/music/good.flac';
        const badPath = '/music/bad.mp3';
        const ndjson = buildNdjson([
            { path: goodPath, analysis: fakeAnalysis() },
            { path: badPath, error: 'ValueError: empty audio' },
        ]);
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));

        vi.resetModules();
        const { analyzeBatch, isAnalyzeSuccess } =
            await import('./music-analysis-sidecar.service.js');
        const results = await analyzeBatch([goodPath, badPath]);

        expect(results).toHaveLength(2);
        const good = results.find((r) => r.path === goodPath)!;
        const bad = results.find((r) => r.path === badPath)!;
        expect(isAnalyzeSuccess(good)).toBe(true);
        expect(isAnalyzeSuccess(bad)).toBe(false);
        expect((bad as { error: string }).error).toContain('empty audio');
    });

    test('returns implicit failure when path produces no NDJSON line', async () => {
        const path1 = '/music/first.flac';
        const path2 = '/music/second.flac';
        // Only path1 appears in the response.
        const ndjson = buildNdjson([{ path: path1, analysis: fakeAnalysis() }]);
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));

        vi.resetModules();
        const { analyzeBatch, isAnalyzeSuccess } =
            await import('./music-analysis-sidecar.service.js');
        const results = await analyzeBatch([path1, path2]);

        expect(results).toHaveLength(2);
        const missing = results.find((r) => r.path === path2)!;
        expect(isAnalyzeSuccess(missing)).toBe(false);
        expect((missing as { error: string }).error).toContain('no output');
    });

    test('throws SidecarUnreachableError when sidecar returns HTTP 503', async () => {
        const paths = ['/music/a.flac', '/music/b.flac'];
        mockFetch.mockResolvedValueOnce(mockResponse('{"detail":"model loading"}', 503));

        vi.resetModules();
        const { analyzeBatch, SidecarUnreachableError: SidecarUnreachable } =
            await import('./music-analysis-sidecar.service.js');

        let thrown: unknown;
        try {
            await analyzeBatch(paths);
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(SidecarUnreachable);
        expect((thrown as Error).message).toMatch(/503/);
    });

    test('throws SidecarUnreachableError when fetch throws (network error)', async () => {
        const paths = ['/music/a.flac'];
        mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

        vi.resetModules();
        const { analyzeBatch, SidecarUnreachableError: SidecarUnreachable } =
            await import('./music-analysis-sidecar.service.js');

        let thrown: unknown;
        try {
            await analyzeBatch(paths);
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(SidecarUnreachable);
        expect((thrown as Error).message).toMatch(/ECONNREFUSED/);
    });

    test('returns per-path error result (not SidecarUnreachableError) for a 200 response with an error line', async () => {
        const goodPath = '/music/ok.flac';
        const badPath = '/music/err.flac';
        const ndjson = buildNdjson([
            { path: goodPath, analysis: fakeAnalysis() },
            { path: badPath, error: 'librosa: file unreadable' },
        ]);
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson, 200));

        vi.resetModules();
        const { analyzeBatch, isAnalyzeSuccess } =
            await import('./music-analysis-sidecar.service.js');
        const results = await analyzeBatch([goodPath, badPath]);

        expect(results).toHaveLength(2);
        expect(isAnalyzeSuccess(results.find((r) => r.path === goodPath)!)).toBe(true);
        const errResult = results.find((r) => r.path === badPath)!;
        expect(isAnalyzeSuccess(errResult)).toBe(false);
        expect((errResult as { error: string }).error).toContain('unreadable');
    });

    test('returns empty array without fetching when paths is empty', async () => {
        vi.resetModules();
        const { analyzeBatch } = await import('./music-analysis-sidecar.service.js');
        const results = await analyzeBatch([]);

        expect(results).toEqual([]);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// analyzeBatch — URL unset (binary/subprocess fallback signal)
// ===========================================================================

describe('analyzeBatch — SONIC_ANALYZE_URL empty', () => {
    test('does NOT call fetch and marks every path as error when URL is empty', async () => {
        mockConfig.SONIC_ANALYZE_URL = '';
        const paths = ['/music/a.flac', '/music/b.flac'];

        vi.resetModules();
        const { analyzeBatch, isAnalyzeSuccess } =
            await import('./music-analysis-sidecar.service.js');
        const results = await analyzeBatch(paths);

        expect(mockFetch).not.toHaveBeenCalled();
        expect(results).toHaveLength(2);
        for (const r of results) {
            expect(isAnalyzeSuccess(r)).toBe(false);
            expect((r as { error: string }).error).toContain('SONIC_ANALYZE_URL not set');
        }
    });
});

// ===========================================================================
// analyzeBatch — FIX 4: malformed analysis objects treated as per-path errors
// ===========================================================================

describe('analyzeBatch — malformed analysis object validation (FIX 4)', () => {
    test('treats analysis:[] (array instead of object) as per-path error', async () => {
        const path = '/music/bad.flac';
        const ndjson = JSON.stringify({ path, analysis: [] }) + '\n';
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));

        vi.resetModules();
        const { analyzeBatch, isAnalyzeSuccess } =
            await import('./music-analysis-sidecar.service.js');
        const results = await analyzeBatch([path]);

        expect(results).toHaveLength(1);
        expect(isAnalyzeSuccess(results[0])).toBe(false);
        expect((results[0] as { error: string }).error).toMatch(/malformed/i);
    });

    test('treats analysis object missing beats_position as per-path error', async () => {
        const path = '/music/bad2.flac';
        // Missing beats_position (required array field)
        const badAnalysis = {
            schema_version: 1,
            bpm: 128,
            key: 'A',
            scale: 'minor',
            average_loudness: 0.7,
            loudness_lufs: -10,
            danceability: 1.0,
            // beats_position intentionally absent
            frame_rms: [0.1, 0.2],
            duration: 200,
            mood_tags: [],
            extras: { zcr_mean: 0.05, spectral_centroid_mean: 1200 },
        };
        const ndjson = JSON.stringify({ path, analysis: badAnalysis }) + '\n';
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));

        vi.resetModules();
        const { analyzeBatch, isAnalyzeSuccess } =
            await import('./music-analysis-sidecar.service.js');
        const results = await analyzeBatch([path]);

        expect(results).toHaveLength(1);
        expect(isAnalyzeSuccess(results[0])).toBe(false);
    });

    test('treats analysis object with non-finite duration as per-path error', async () => {
        const path = '/music/bad3.flac';
        const badAnalysis = {
            schema_version: 1,
            bpm: 128,
            key: 'A',
            scale: 'minor',
            average_loudness: 0.7,
            loudness_lufs: -10,
            danceability: 1.0,
            beats_position: [0.5, 1.0],
            frame_rms: [0.1],
            duration: null, // null is not a finite number
            mood_tags: [],
            extras: {},
        };
        const ndjson = JSON.stringify({ path, analysis: badAnalysis }) + '\n';
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));

        vi.resetModules();
        const { analyzeBatch, isAnalyzeSuccess } =
            await import('./music-analysis-sidecar.service.js');
        const results = await analyzeBatch([path]);

        expect(results).toHaveLength(1);
        expect(isAnalyzeSuccess(results[0])).toBe(false);
    });

    test('accepts a well-formed analysis object', async () => {
        const path = '/music/good.flac';
        const ndjson = buildNdjson([{ path, analysis: fakeAnalysis() }]);
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));

        vi.resetModules();
        const { analyzeBatch, isAnalyzeSuccess } =
            await import('./music-analysis-sidecar.service.js');
        const results = await analyzeBatch([path]);

        expect(results).toHaveLength(1);
        expect(isAnalyzeSuccess(results[0])).toBe(true);
    });
});

// ===========================================================================
// analyzeOne — single-path entry point
// ===========================================================================

describe('analyzeOne — single-path entry point', () => {
    test('returns the raw SidecarAnalysis on success', async () => {
        const path = '/music/track.flac';
        const analysis = fakeAnalysis({ bpm: 174, key: 'C', scale: 'major' });
        mockFetch.mockResolvedValueOnce(mockResponse(buildNdjson([{ path, analysis }])));

        vi.resetModules();
        const { analyzeOne } = await import('./music-analysis-sidecar.service.js');
        const result = await analyzeOne(path);

        expect(result).not.toBeNull();
        expect(result?.bpm).toBe(174);
        expect(result?.key).toBe('C');
        expect(result?.scale).toBe('major');
    });

    test('returns null when the sidecar emits an error line', async () => {
        const path = '/music/track.flac';
        mockFetch.mockResolvedValueOnce(
            mockResponse(buildNdjson([{ path, error: 'ValueError: empty audio' }])),
        );

        vi.resetModules();
        const { analyzeOne } = await import('./music-analysis-sidecar.service.js');
        const result = await analyzeOne(path);

        expect(result).toBeNull();
    });

    test('throws SidecarUnreachableError when fetch throws (network error)', async () => {
        mockFetch.mockRejectedValueOnce(new Error('ETIMEDOUT'));

        vi.resetModules();
        const { analyzeOne, SidecarUnreachableError: SidecarUnreachable } =
            await import('./music-analysis-sidecar.service.js');

        await expect(analyzeOne('/music/track.flac')).rejects.toThrow(SidecarUnreachable);
    });

    test('returns null and does NOT fetch when SONIC_ANALYZE_URL is empty', async () => {
        mockConfig.SONIC_ANALYZE_URL = '';

        vi.resetModules();
        const { analyzeOne } = await import('./music-analysis-sidecar.service.js');
        const result = await analyzeOne('/music/track.flac');

        expect(result).toBeNull();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    test('forwards threads to the sidecar', async () => {
        const path = '/music/track.flac';
        mockFetch.mockResolvedValueOnce(
            mockResponse(buildNdjson([{ path, analysis: fakeAnalysis() }])),
        );

        vi.resetModules();
        const { analyzeOne } = await import('./music-analysis-sidecar.service.js');
        await analyzeOne(path, 2);

        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(init.body as string) as { threads?: number };
        expect(body.threads).toBe(2);
    });
});

// ===========================================================================
// Busy sidecar (HTTP 429 from the memory gate) and over-budget files
// ===========================================================================

function busyResponse(retryAfterSeconds = 10): Response {
    return {
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': String(retryAfterSeconds) }),
        text: () => Promise.resolve('{"detail":{"code":"busy"}}'),
    } as unknown as Response;
}

describe('analyzeBatch — busy sidecar (429)', () => {
    beforeEach(() => {
        mockFetch.mockReset();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    test('sends accept_busy, waits Retry-After and resends', async () => {
        const path = '/music/track.flac';
        mockFetch
            .mockResolvedValueOnce(busyResponse(10))
            .mockResolvedValueOnce(mockResponse(buildNdjson([{ path, analysis: fakeAnalysis() }])));
        vi.resetModules();
        const { analyzeBatch } = await import('./music-analysis-sidecar.service.js');
        const pending = analyzeBatch([path]);
        await vi.advanceTimersByTimeAsync(10_000);
        const [result] = await pending;
        expect(result && 'analysis' in result).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(JSON.parse(init.body as string)).toMatchObject({ accept_busy: true });
    });

    test('stays busy: SidecarBusyError, transient and never read as a mid-request crash', async () => {
        mockFetch.mockImplementation(() => Promise.resolve(busyResponse(120)));
        vi.resetModules();
        const { analyzeBatch, SidecarBusyError, SidecarUnreachableError } =
            await import('./music-analysis-sidecar.service.js');
        const settled = analyzeBatch(['/music/track.flac']).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(16 * 60_000);
        const err = await settled;
        expect(err).toBeInstanceOf(SidecarBusyError);
        expect(err).toBeInstanceOf(SidecarUnreachableError); // the task leaves the track pending
        // music-analysis.ts counts a crash strike only for these shapes.
        expect((err as Error).message).not.toMatch(
            /ECONNRESET|EPIPE|UND_ERR_SOCKET|other side closed|socket hang up|terminated/i,
        );
    });
});

describe('analyzeBatch — abort while the sidecar is busy', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    test('an abort ends the wait at once, without another request', async () => {
        mockFetch.mockReset();
        vi.useFakeTimers();
        mockFetch.mockImplementation(() => Promise.resolve(busyResponse(120)));
        vi.resetModules();
        const { analyzeBatch, SidecarBusyError } =
            await import('./music-analysis-sidecar.service.js');
        const controller = new AbortController();
        const settled = analyzeBatch(['/music/track.flac'], undefined, controller.signal).catch(
            (e: unknown) => e,
        );
        await vi.advanceTimersByTimeAsync(1_000);
        controller.abort();
        await vi.advanceTimersByTimeAsync(0);
        const err = await settled;
        expect(err).toBeInstanceOf(SidecarBusyError);
        expect((err as Error).message).toMatch(/run was stopped/);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});

describe('analyzeOne — file over the sidecar memory', () => {
    test('throws SidecarMemoryBudgetError (a durable failure with the reason)', async () => {
        const path = '/music/mix.flac';
        mockFetch.mockResolvedValueOnce(
            mockResponse(
                JSON.stringify({
                    path,
                    error: 'needs about 12000 MB, more than this sidecar can ever give a job',
                    code: 'exceeds_memory_budget',
                }) + '\n',
            ),
        );
        vi.resetModules();
        const { analyzeOne, SidecarMemoryBudgetError, SidecarUnreachableError } =
            await import('./music-analysis-sidecar.service.js');
        const err = await analyzeOne(path).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SidecarMemoryBudgetError);
        expect(err).not.toBeInstanceOf(SidecarUnreachableError);
        expect((err as Error).message).toMatch(/memory too small.*12000 MB/);
    });
});
