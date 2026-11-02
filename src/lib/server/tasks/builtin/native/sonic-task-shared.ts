// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared helpers for the three CPU-bound sonic background tasks
 * (sonic-map-projection, sonic-clustering, sonic-embedding-backfill).
 *
 * Extracted to eliminate identical subprocess-launch scaffolding, the
 * cpuThreads settings field definition, and the NDJSON split/parse loop
 * that were previously copied across all three task files.
 *
 * @module tasks/builtin/native/sonic-task-shared
 */

import { execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import type { LoggerInstance } from '$lib/server/utils/logger.js';

const execFileAsync = promisify(execFile);

// ============================================================================
// #9 — cpuThreads settings field + parse helper
// ============================================================================

/**
 * The task settings key used by all three sonic tasks to let operators cap the
 * PyTorch intra-op thread count forwarded to the sidecar or subprocess.
 *
 * Import this constant instead of repeating the string literal.
 */
export const SONIC_CPU_THREADS_FIELD = 'cpuThreads' as const;

/**
 * Shared settings field descriptor for the cpuThreads operator knob.
 *
 * All three sonic tasks declare an identical `fields` entry.  Import and
 * spread this object into the `settings.fields` array instead of copying it.
 *
 * The description text uses a placeholder `<action>` token — callers should
 * replace it with a task-specific verb like "projection", "clustering", or
 * "embedding".
 */
export const SONIC_CPU_THREADS_FIELD_DEF = {
    key: SONIC_CPU_THREADS_FIELD,
    type: 'number' as const,
    label: 'CPU threads',
    description:
        'PyTorch intra-op thread cap sent to the sonic-embedder sidecar (or subprocess). ' +
        'Blank / 0 = ~half the cores (sidecar default). ' +
        'Lower values reduce CPU pressure on the host app.',
    default: 0,
    validation: { min: 0, max: 128 },
} as const;

/**
 * Parse and validate the `cpuThreads` value from a task settings record.
 *
 * Returns a positive integer when the value is a positive integer, or
 * `undefined` when the value is absent, zero, or non-integer (all of which
 * signal "let the sidecar choose its default").
 *
 * Behavior is identical to the inline expression previously duplicated across
 * sonic-map-projection, sonic-clustering, and sonic-embedding-backfill:
 *
 * ```ts
 * typeof cpuThreadsRaw === 'number' && Number.isInteger(cpuThreadsRaw) && cpuThreadsRaw > 0
 *     ? cpuThreadsRaw
 *     : undefined
 * ```
 *
 * @param raw - Raw value from `await ctx.settings()` (unknown at runtime).
 * @returns Validated positive integer, or `undefined`.
 */
export function parseCpuThreadsSetting(raw: unknown): number | undefined {
    if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
        return raw;
    }
    return undefined;
}

// ============================================================================
// #7 — subprocess launch helper
// ============================================================================

/** Options for {@link runSonicSubprocess}. */
export interface SonicSubprocessOptions {
    /** Absolute path to the Python interpreter (e.g. `config.SONIC_EMBEDDER_PYTHON`). */
    pythonBin: string;
    /** Absolute or relative path to the Python script to execute. */
    scriptPath: string;
    /**
     * Extra environment variables merged on top of `process.env`.
     * Pass `DATABASE_URL`, `MODEL_ID`, and any script-specific vars here.
     */
    extraEnv: Record<string, string | undefined>;
    /**
     * Optional intra-op thread cap.  When a positive integer is provided,
     * `SONIC_EMBEDDER_THREADS` and `OMP_NUM_THREADS` are injected into the
     * subprocess environment.  Absent / zero → env keys are not overridden.
     */
    threads?: number;
    /**
     * Hard timeout in milliseconds for the subprocess.
     * Defaults to `30 * 60_000` (30 minutes).
     */
    timeoutMs?: number;
    /**
     * Maximum stdout buffer in bytes.
     * Defaults to `128 * 1024 * 1024` (128 MB).
     */
    maxBufferBytes?: number;
    /**
     * Label used in log messages (e.g. `"UMAP projection"` or `"KMeans clustering"`).
     */
    logLabel: string;
    /**
     * Logger instance to write debug/error messages to.
     * Pass the module-level `Logger.for(...)` instance.
     */
    logger: Pick<LoggerInstance, 'debug' | 'error'>;
    /**
     * Optional abort signal for admin-cancel propagation. `execFile` supports
     * `{ signal }` natively (Node 15+): when the signal fires, the child
     * process is killed and the returned promise rejects with an AbortError.
     * Without this, ctx.signal is never wired to the subprocess and Cancel
     * is a no-op until the subprocess's own `timeoutMs` elapses.
     */
    signal?: AbortSignal;
}

/**
 * Spawn a Python subprocess and return its stdout as a string.
 *
 * Encapsulates the `execFile` + env-merge + thread-cap + stdout-coerce
 * pattern that was previously duplicated in sonic-map-projection and
 * sonic-clustering (and will be used by call-site agents to replace the
 * inline subprocess blocks in those files).
 *
 * @param opts - Subprocess options (see {@link SonicSubprocessOptions}).
 * @returns Resolved stdout string on success.
 * @throws Error with a human-readable message on non-zero exit / timeout.
 */
export async function runSonicSubprocess(opts: SonicSubprocessOptions): Promise<string> {
    const {
        pythonBin,
        scriptPath,
        extraEnv,
        threads,
        timeoutMs = 30 * 60_000,
        maxBufferBytes = 128 * 1024 * 1024,
        logLabel,
        logger,
        signal,
    } = opts;

    // Build subprocess environment: start from process.env, overlay extra
    // vars, then conditionally inject thread caps.
    const subprocessEnv: Record<string, string | undefined> = {
        ...process.env,
        ...extraEnv,
    };

    if (typeof threads === 'number' && threads > 0) {
        const threadStr = String(threads);
        subprocessEnv.SONIC_EMBEDDER_THREADS = threadStr;
        subprocessEnv.OMP_NUM_THREADS = threadStr;
    }

    logger.debug(`Spawning ${logLabel} script`, {
        python: pythonBin,
        script: scriptPath,
    });

    const execOpts: ExecFileOptions = {
        timeout: timeoutMs,
        maxBuffer: maxBufferBytes,
        env: subprocessEnv,
        ...(signal ? { signal } : {}),
    };

    let stdout: string;
    try {
        const result = await execFileAsync(pythonBin, [scriptPath], execOpts);
        stdout =
            typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf-8');
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`${logLabel} process failed`, err instanceof Error ? err : undefined, {
            hint: errMsg,
        });
        throw new Error(`${logLabel} failed: ${errMsg}`, { cause: err });
    }

    return stdout;
}

// ============================================================================
// #11 — NDJSON parse helper
// ============================================================================

/**
 * Split an NDJSON string into non-empty lines, parse each as JSON, and pass
 * each parsed value to `parseRecord`.  When `parseRecord` returns `null` the
 * line is counted as a parse error and skipped.
 *
 * This replaces the identical split/filter/try-catch/push loop that was
 * previously copied into:
 *   - `parseProjectionNdjson` (sonic-map-projection)
 *   - `parseClusteringNdjson` (sonic-clustering)
 *   - `parseEmbedNdjson`      (sonic-embedding.service)
 *
 * @param ndjson       Raw NDJSON string (newline-separated JSON objects).
 * @param parseRecord  Domain-specific parser — returns a typed record or null.
 * @returns An object with `records` (the parsed values) and `parseErrors`
 *          (count of lines that were skipped due to parse failures).
 */
export function parseNdjsonLines<T>(
    ndjson: string,
    parseRecord: (raw: Record<string, unknown>) => T | null,
): { records: T[]; parseErrors: number } {
    const lines = ndjson.split('\n').filter((l) => l.trim().length > 0);
    const records: T[] = [];
    let parseErrors = 0;

    for (const line of lines) {
        try {
            const raw = JSON.parse(line) as unknown;
            if (!raw || typeof raw !== 'object') {
                parseErrors++;
                continue;
            }
            const record = parseRecord(raw as Record<string, unknown>);
            if (record === null) {
                parseErrors++;
            } else {
                records.push(record);
            }
        } catch {
            parseErrors++;
        }
    }

    return { records, parseErrors };
}

// ============================================================================
// Sidecar busy (HTTP 429 from the memory gate)
// ============================================================================

/**
 * The sidecar admits heavy jobs against its memory budget
 * (workers/sonic-embedder/admission.py). A request that sends `accept_busy: true` and
 * waits longer than the sidecar's queue timeout gets HTTP 429 with Retry-After instead
 * of an answer: the sidecar is busy, not broken, and the files in the request are not
 * to blame. Callers wait and resend, up to this long in total, then report the sidecar
 * busy without charging any track.
 */
export const SIDECAR_BUSY_MAX_WAIT_MS = 15 * 60_000;

const BUSY_RETRY_MIN_MS = 5_000;
const BUSY_RETRY_MAX_MS = 120_000;

/** The wait a 429 asks for (Retry-After seconds), clamped to 5 s .. 2 min. */
export function busyRetryAfterMs(retryAfterHeader: string | null): number {
    const secs = Number(retryAfterHeader);
    const ms = Number.isFinite(secs) && secs > 0 ? secs * 1000 : 30_000;
    return Math.min(BUSY_RETRY_MAX_MS, Math.max(BUSY_RETRY_MIN_MS, ms));
}

/** Sleep `ms`; resolves early (false) when `signal` aborts. */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve(true);
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            resolve(false);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** Per-file code the sidecar sets when a file cannot fit its memory even alone. */
export const SIDECAR_EXCEEDS_MEMORY_BUDGET = 'exceeds_memory_budget';
