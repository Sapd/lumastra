// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Analysis Sidecar Client
 *
 * HTTP client for the Python sonic-embedder sidecar's POST /analyze endpoint
 * (workers/sonic-embedder/{server.py,analyze.py}). Mirrors the /embed client in
 * sonic-embedding.service.ts: one JSONL line per input path, in input order,
 * discriminated by `analysis` (success) vs `error` (failure).
 *
 * Integration Shape A — the sidecar emits RAW librosa/pyloudnorm features; ALL
 * derivation (smart boundaries, fade/DJ-intro detection, energy curve, key join,
 * beat cap, downbeat decimation, voice/instrumental heuristic) stays on the TS
 * side in essentia-analysis.service.ts (deriveAnalysis / adaptSidecarAnalysis).
 *
 * I/O contract with POST /analyze:
 *   request:  { "paths": ["/abs/a.flac", ...], "threads"?: 4 }
 *   response: JSONL, one line per path:
 *     success → { "path": "...", "analysis": { schema_version, bpm, key, scale, ... } }
 *     failure → { "path": "...", "error": "message" }
 *
 * Configuration (config.ts):
 *   SONIC_ANALYZE_URL — sidecar base URL; defaults to SONIC_EMBEDDER_URL so one
 *                       sidecar serves both /embed and /analyze. Empty → no sidecar.
 */

import { Logger } from '../utils/logger.js';
import { fetchWithTimeout } from '../utils/fetch-utils.js';
import { config } from '../config.js';
import {
    busyRetryAfterMs,
    parseNdjsonLines,
    SIDECAR_BUSY_MAX_WAIT_MS,
    SIDECAR_EXCEEDS_MEMORY_BUDGET,
    sleepUnlessAborted,
} from '../tasks/builtin/native/sonic-task-shared.js';

const logger = Logger.for('MusicAnalysisSidecar');

// ============================================================================
// Transport error class
// ============================================================================

/**
 * Thrown when the sidecar /analyze call fails at the transport level:
 *   - The `fetch()` itself throws (ECONNREFUSED, ECONNRESET, AbortError, timeout)
 *   - The sidecar returns a non-2xx HTTP status (e.g. 503 model loading)
 *
 * Distinct from a per-path analysis error (a 200 response that contains an
 * `"error"` field for a specific path). The task treats this as a TRANSIENT
 * failure — the track is left pending and retried next drain rather than being
 * permanently tombstoned.
 */
export class SidecarUnreachableError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'SidecarUnreachableError';
    }
}

/**
 * The sidecar's memory gate answered 429 for longer than {@link analyzeBatch} waits.
 * A {@link SidecarUnreachableError}, so the task leaves the track pending; its message
 * never looks like a mid-request death, so the track gets no crash strike either.
 */
export class SidecarBusyError extends SidecarUnreachableError {
    constructor(message: string) {
        super(message);
        this.name = 'SidecarBusyError';
    }
}

/**
 * The file needs more memory than the sidecar can give one job even alone
 * (per-file code `exceeds_memory_budget`). A durable failure with a clear message:
 * the task records it like any analysis error, and the Failures tab shows the
 * operator that the sidecar needs more memory (a retry re-runs it after that).
 */
export class SidecarMemoryBudgetError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SidecarMemoryBudgetError';
    }
}

/** Internal: one 429 from the sidecar's memory gate. */
class SidecarBusySignal extends Error {
    constructor(readonly retryAfterMs: number) {
        super('Sonic sidecar /analyze is busy (HTTP 429)');
        this.name = 'SidecarBusySignal';
    }
}

/** AbortSignal timeout for /analyze HTTP requests (30 minutes — matches the
 *  /embed batch ceiling and the music-analysis task hard timeout). */
const ANALYZE_HTTP_TIMEOUT_MS = 30 * 60_000;

// ============================================================================
// Types — the RAW /analyze contract (Shape A). Mirror of analyze.py's output.
// ============================================================================

/** Engine-specific heuristic inputs the three TS detectors consume. The sidecar
 *  supplies librosa values plus neutral nulls/zeros/empties for the Essentia-only
 *  signals it cannot reproduce. */
export interface SidecarAnalysisExtras {
    zcr_mean: number | null;
    spectral_centroid_mean: number | null;
    spectral_entropy_mean: number | null;
    dynamic_complexity: number | null;
    silence_rate_60: number;
    spectral_complexity_var: number;
    band_ratio_mean: number[];
    band_ratio_var: number[];
    /** Vocal-band harmonic energy ratio per ~100ms bin (0..1) — raw signal for
     *  the TS vocal-boundary derivation. Optional: older sidecars omit it. */
    vocal_band_ratio?: number[] | null;
    /** Bin size of vocal_band_ratio in ms. Optional: older sidecars omit it. */
    vocal_ratio_hop_ms?: number | null;
}

/** RAW feature object the sidecar emits for one track (the TS adapter consumes
 *  it and runs all derivation). See workers/sonic-embedder/analyze.py. */
export interface SidecarAnalysis {
    schema_version: number;
    bpm: number;
    /** Bare pitch class "C".."B" with "#" — NO 'm' suffix (TS joins key+scale → "Am"). */
    key: string;
    scale: 'major' | 'minor';
    /** 0..1 normalised RMS (Essentia "average_loudness" analogue). */
    average_loudness: number;
    /** Real EBU R128 integrated loudness (negative dB); null if unmeasurable. */
    loudness_lufs: number | null;
    /** Essentia-compatible ~0..3 scale (NOT Spotify 0..1). */
    danceability: number;
    /** FULL uncapped beat onset times in seconds, ascending. */
    beats_position: number[];
    /** Per-frame RMS (TS fade detection). */
    frame_rms: number[];
    /** Per-frame spectral energy (TS energy curve). */
    frame_energy: number[];
    duration: number;
    /** Lowercase, deduped, sorted. */
    mood_tags: string[];
    extras: SidecarAnalysisExtras;
}

export type AnalyzeResult =
    { path: string; analysis: SidecarAnalysis } | { path: string; error: string; code?: string };

export function isAnalyzeSuccess(
    r: AnalyzeResult,
): r is { path: string; analysis: SidecarAnalysis } {
    return 'analysis' in r;
}

// ============================================================================
// HTTP sidecar call
// ============================================================================

/**
 * POST {SONIC_ANALYZE_URL}/analyze with the given paths.
 *
 * Returns the JSONL body text on success, or null when SONIC_ANALYZE_URL is not
 * configured (caller should fall back to the binary). Throws on HTTP non-OK or
 * network failure so the caller can mark every path as failed.
 *
 * @param paths   Absolute paths to audio files.
 * @param threads Optional intra-op thread cap forwarded to the sidecar. Omit
 *                (or pass undefined/0) to let the sidecar use its env default.
 */
async function callSidecarAnalyze(paths: string[], threads?: number): Promise<string | null> {
    const url = config.SONIC_ANALYZE_URL;
    if (!url) return null;

    logger.debug('Calling sonic-embedder sidecar /analyze', { url, pathCount: paths.length });

    // accept_busy: the sidecar's memory gate may answer 429 instead of queueing this
    // request indefinitely; analyzeBatch waits and resends, blaming no track.
    const requestBody: Record<string, unknown> = { paths, accept_busy: true };
    if (typeof threads === 'number' && threads > 0) {
        requestBody.threads = threads;
    }

    // Routed through the same-origin-only redirect guard (C22 fix-plan
    // finding) — SONIC_ANALYZE_URL is an admin-configured host, same class
    // as ABS/Kavita/the arr apps.
    const response = await fetchWithTimeout(
        `${url}/analyze`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        },
        ANALYZE_HTTP_TIMEOUT_MS,
    );

    if (response.status === 429) {
        await response.text().catch(() => '');
        throw new SidecarBusySignal(busyRetryAfterMs(response.headers.get('retry-after')));
    }
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new SidecarUnreachableError(
            `Sonic sidecar /analyze returned ${response.status}: ${body.slice(0, 200)}`,
        );
    }

    return response.text();
}

/**
 * Type guard: validates that an analysis object has the required fields with
 * correct types before the adapter trusts it. Prevents a malformed sidecar
 * response from being silently accepted as a success and stored as neutral junk.
 * Missing or wrong-typed required fields → the path is treated as a per-path
 * error so the track stays eligible for retry.
 */
function isValidAnalysis(a: unknown): a is SidecarAnalysis {
    if (typeof a !== 'object' || a === null) return false;
    const obj = a as Record<string, unknown>;
    return (
        typeof obj.bpm === 'number' &&
        Number.isFinite(obj.bpm) &&
        typeof obj.key === 'string' &&
        typeof obj.scale === 'string' &&
        Array.isArray(obj.beats_position) &&
        Array.isArray(obj.frame_rms) &&
        typeof obj.duration === 'number' &&
        Number.isFinite(obj.duration)
    );
}

/**
 * Parse the /analyze JSONL body into a map of path → AnalyzeResult via the shared
 * parseNdjsonLines helper (same convention as parseEmbedNdjson).
 */
function parseAnalyzeNdjson(ndjson: string): Map<string, AnalyzeResult> {
    const resultMap = new Map<string, AnalyzeResult>();

    const { parseErrors } = parseNdjsonLines<AnalyzeResult>(ndjson, (record) => {
        const path = typeof record.path === 'string' ? record.path : null;
        if (!path) return null;

        if (record.analysis !== undefined) {
            if (!isValidAnalysis(record.analysis)) {
                // Malformed analysis object — surface as a per-path error so the
                // track retries rather than being marked with neutral junk data.
                const result: AnalyzeResult = {
                    path,
                    error: 'malformed analysis object (missing required fields)',
                };
                resultMap.set(path, result);
                return result;
            }
            const result: AnalyzeResult = {
                path,
                analysis: record.analysis,
            };
            resultMap.set(path, result);
            return result;
        }
        if (typeof record.error === 'string') {
            const result: AnalyzeResult =
                typeof record.code === 'string'
                    ? { path, error: record.error, code: record.code }
                    : { path, error: record.error };
            resultMap.set(path, result);
            return result;
        }

        return null;
    });

    if (parseErrors > 0) {
        logger.warn('Malformed JSONL lines from sonic /analyze', { count: parseErrors });
    }

    return resultMap;
}

// ============================================================================
// Batch + single-path entry points
// ============================================================================

/**
 * Analyze a batch of audio paths via the sidecar. Returns one AnalyzeResult per
 * input path, in input order.
 *
 * Transport failures (fetch throws or HTTP non-2xx) re-throw as
 * {@link SidecarUnreachableError} so the caller can distinguish transient
 * infrastructure outages from durable per-path analysis errors. The task treats
 * SidecarUnreachableError as transient — the track stays pending and is retried
 * on the next drain rather than being permanently tombstoned.
 *
 * HTTP 429 (the sidecar's memory gate is full) is waited out and resent for up to
 * SIDECAR_BUSY_MAX_WAIT_MS, then thrown as {@link SidecarBusyError}: transient, and
 * never a crash strike against the track.
 *
 * Per-path failures in an otherwise-200 response (a JSONL line containing an
 * `"error"` field, or a malformed analysis object) are returned as error results
 * without throwing — these are durable and the track is handled per its normal
 * failure path.
 *
 * @param paths   Absolute paths to audio files.
 * @param threads Optional CPU thread cap forwarded to the sidecar.
 * @param signal  Optional abort signal: stops waiting for a busy sidecar.
 */
export async function analyzeBatch(
    paths: string[],
    threads?: number,
    signal?: AbortSignal,
): Promise<AnalyzeResult[]> {
    if (paths.length === 0) return [];

    let ndjson: string;
    try {
        const body = await callSidecarAnalyzeWhenFree(paths, threads, signal);
        if (body === null) {
            // SONIC_ANALYZE_URL unset — surface as a per-path failure so the
            // caller can fall back to the binary path.
            return paths.map((path) => ({ path, error: 'SONIC_ANALYZE_URL not set' }));
        }
        ndjson = body;
    } catch (err) {
        // SidecarUnreachableError (transport failure) re-throws so the task can
        // treat this as transient. Any other error from callSidecarAnalyze is
        // unexpected; re-wrap it as SidecarUnreachableError so callers have one
        // class to check.
        if (err instanceof SidecarBusyError) throw err;
        if (err instanceof SidecarUnreachableError) {
            logger.warn(
                'Sonic sidecar /analyze transport failure — re-throwing as SidecarUnreachableError',
                { pathCount: paths.length, message: err.message },
            );
            throw err;
        }
        // fetch itself threw (ECONNREFUSED, AbortError, timeout, etc.)
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('Sonic sidecar /analyze fetch error — re-throwing as SidecarUnreachableError', {
            pathCount: paths.length,
            message,
        });
        throw new SidecarUnreachableError(
            `Sonic sidecar /analyze fetch error: ${message}`,
            err instanceof Error ? { cause: err } : undefined,
        );
    }

    const resultMap = parseAnalyzeNdjson(ndjson);
    return paths.map((path) => resultMap.get(path) ?? { path, error: 'no output from analyzer' });
}

/**
 * {@link callSidecarAnalyze}, waiting out 429s for up to SIDECAR_BUSY_MAX_WAIT_MS.
 * Throws {@link SidecarBusyError} when the sidecar stays busy (or `signal` aborts).
 */
async function callSidecarAnalyzeWhenFree(
    paths: string[],
    threads: number | undefined,
    signal: AbortSignal | undefined,
): Promise<string | null> {
    const deadline = Date.now() + SIDECAR_BUSY_MAX_WAIT_MS;
    for (;;) {
        try {
            return await callSidecarAnalyze(paths, threads);
        } catch (err) {
            if (!(err instanceof SidecarBusySignal)) throw err;
            logger.debug('Sonic sidecar busy; waiting before resending /analyze', {
                pathCount: paths.length,
                retryAfterMs: err.retryAfterMs,
            });
            if (
                Date.now() + err.retryAfterMs > deadline ||
                !(await sleepUnlessAborted(err.retryAfterMs, signal))
            ) {
                throw new SidecarBusyError(
                    signal?.aborted
                        ? 'Stopped waiting for the busy sonic sidecar: the run was stopped'
                        : 'Sonic sidecar /analyze stayed busy (memory budget fully used); the track waits for the next run',
                );
            }
        }
    }
}

/**
 * Analyze a single audio path via the sidecar. Returns the raw {@link SidecarAnalysis}
 * on success, or null when the sidecar produced a durable per-path failure (error
 * line, malformed analysis, URL unset, or no output).
 *
 * {@link SidecarUnreachableError} (transport failure from {@link analyzeBatch})
 * propagates — do NOT catch it here. The task treats it as transient.
 * {@link SidecarMemoryBudgetError} (the file cannot fit the sidecar's memory) is
 * thrown as a durable failure with a message naming the cause.
 *
 * @param filePath Absolute path to one audio file.
 * @param threads  Optional CPU thread cap forwarded to the sidecar.
 */
export async function analyzeOne(
    filePath: string,
    threads?: number,
    signal?: AbortSignal,
): Promise<SidecarAnalysis | null> {
    // SidecarUnreachableError propagates — analyzeBatch re-throws it.
    const [result] = await analyzeBatch([filePath], threads, signal);
    if (result && isAnalyzeSuccess(result)) return result.analysis;
    if (result && 'code' in result && result.code === SIDECAR_EXCEEDS_MEMORY_BUDGET) {
        throw new SidecarMemoryBudgetError(`Sonic sidecar memory too small: ${result.error}`);
    }

    logger.warn('Sidecar /analyze returned no usable result', {
        filePath,
        error: result && !isAnalyzeSuccess(result) ? result.error : 'no line',
    });
    return null;
}
