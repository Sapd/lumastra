// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sonic Embedding Service
 *
 * Wraps the Python MSCLAP CLI (workers/sonic-embedder/embed.py) to produce
 * 1024-dimensional audio embeddings from raw audio files.
 *
 * I/O contract with the Python CLI:
 *   stdin:  one JSON line → { "paths": ["/abs/path1", "/abs/path2", ...] }
 *   stdout: one JSONL line per input path:
 *             success → { "path": "...", "embedding": [1024 floats] }
 *             failure → { "path": "...", "error": "message" }
 *
 * HTTP sidecar mode (when config.SONIC_EMBEDDER_URL is set):
 *   POST /embed      → same JSONL contract, warm model, no cold-start
 *   POST /embed-text → JSON array[1024], short 15s timeout, Valkey cache
 *
 * Model: CLAP(version='2023') — always 'msclap-2023', no config key.
 *
 * Configuration (all optional, read from config.ts):
 *   SONIC_EMBEDDER_URL        — HTTP sidecar base URL (default '' = subprocess)
 *   SONIC_EMBEDDER_PYTHON     — Python interpreter path (default 'python3')
 *   SONIC_EMBEDDER_SCRIPT     — Path to embed.py (default 'workers/sonic-embedder/embed.py')
 *   SONIC_EMBEDDER_BATCH_SIZE — Paths per spawn (default 16)
 */

import { createHash } from 'node:crypto';
import { execFile, execFileSync, type ExecFileOptions } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { Logger } from '../utils/logger.js';
import { fetchWithTimeout } from '../utils/fetch-utils.js';
import { config } from '../config.js';
import { cacheDel, cacheGet, cacheSet } from '../cache/valkey.js';
import { MSCLAP_MODEL_ID } from '../database/queries/sonic-constants.js';
import {
    busyRetryAfterMs,
    parseNdjsonLines,
    SIDECAR_BUSY_MAX_WAIT_MS,
    SIDECAR_EXCEEDS_MEMORY_BUDGET,
    sleepUnlessAborted,
} from '../tasks/builtin/native/sonic-task-shared.js';

const execFileAsync = promisify(execFile);

/** ExecFile options extended with stdin `input` (supported at runtime but
 *  not typed in `ExecFileOptions` — only in `ExecFileSyncOptions`). */
type ExecFileWithInputOptions = ExecFileOptions & { input?: string };
const logger = Logger.for('SonicEmbedding');

// ============================================================================
// Constants
// ============================================================================

/** The only model ID this pipeline supports. Hard-coded — no config key. */
export const SONIC_MODEL_ID = MSCLAP_MODEL_ID;

/** Expected dimensionality of every embedding vector. */
const EMBEDDING_DIM = 1024;

/** Valkey TTL for text-embedding cache entries (1 hour). */
const TEXT_EMBED_CACHE_TTL_SECONDS = 3600;

/**
 * fetchWithTimeout deadline for /embed-text HTTP requests (45s). The CLAP text encoder is fast
 * when uncontended, but the sidecar is shared with the audio-embedding backfill, so a text
 * query can queue behind an /embed batch. 15s was too tight during a drain ("operation
 * aborted due to timeout" → "Failed to generate text embedding"). The result is cached
 * (v1:text-embed:<sha>), so this longer ceiling is a one-time per-unique-query cost.
 */
const TEXT_EMBED_HTTP_TIMEOUT_MS = 45_000;

/** fetchWithTimeout deadline for /embed HTTP requests (30 minutes — matches task hard timeout). */
const BATCH_EMBED_HTTP_TIMEOUT_MS = 30 * 60_000;

// ============================================================================
// Types
// ============================================================================

export interface EmbedSuccess {
    path: string;
    embedding: number[];
}

export interface EmbedFailure {
    path: string;
    error: string;
    /**
     * Set by embed.py / the sidecar when the failure is about the embedder, not
     * the file (`'engine'`: the model could not be loaded). Never counts as a
     * track failure.
     */
    fatal?: 'engine';
    /**
     * Machine-readable reason from the sidecar. `exceeds_memory_budget`: the file
     * cannot fit the sidecar's memory even alone, which is about the sidecar's size,
     * not the file (see embedBatch).
     */
    code?: string;
}

export type EmbedResult = EmbedSuccess | EmbedFailure;

export function isEmbedSuccess(r: EmbedResult): r is EmbedSuccess {
    return 'embedding' in r;
}

// ============================================================================
// NDJSON parse helper (shared by HTTP and subprocess paths)
// ============================================================================

/**
 * Parse NDJSON output for embed results.
 * Returns a map of path → EmbedResult for all parseable lines.
 */
function parseEmbedNdjson(ndjson: string): Map<string, EmbedResult> {
    const resultMap = new Map<string, EmbedResult>();

    const { parseErrors } = parseNdjsonLines<EmbedResult>(ndjson, (record) => {
        const path = typeof record.path === 'string' ? record.path : null;
        if (!path) return null;

        if (Array.isArray(record.embedding)) {
            const embedding = record.embedding as number[];
            if (embedding.length !== EMBEDDING_DIM) {
                logger.warn('Unexpected embedding dimension', {
                    path,
                    got: embedding.length,
                    expected: EMBEDDING_DIM,
                });
                const result: EmbedResult = {
                    path,
                    error: `unexpected embedding dim: ${embedding.length} (expected ${EMBEDDING_DIM})`,
                };
                resultMap.set(path, result);
                return result;
            }
            const result: EmbedResult = { path, embedding };
            resultMap.set(path, result);
            return result;
        } else if (typeof record.error === 'string') {
            const result: EmbedFailure =
                record.fatal === 'engine'
                    ? { path, error: record.error, fatal: 'engine' }
                    : { path, error: record.error };
            if (typeof record.code === 'string') result.code = record.code;
            resultMap.set(path, result);
            return result;
        }

        return null;
    });

    if (parseErrors > 0) {
        logger.warn('Malformed JSONL lines from sonic embedder', { count: parseErrors });
    }

    return resultMap;
}

// ============================================================================
// HTTP sidecar helper
// ============================================================================
//
// Both sidecar calls go through `fetchWithTimeout` rather than bare `fetch`.
// SONIC_EMBEDDER_URL is admin-configured, and the default fetch behaviour
// (redirect:'follow') would let a compromised or misconfigured sidecar 3xx
// the request to any host the app can reach — including a private address
// the caller cannot reach directly (blind SSRF; same class as the C29/C21
// fix-plan findings). The helper follows redirects manually, only while the
// Location stays on the configured origin, refuses and logs a cross-origin
// hop by host only, and caps the hop count.
//
// The per-call deadline is passed as the helper's `timeout` argument instead
// of an `AbortSignal.timeout(...)` in the request init: the helper already
// runs its own timer and composes any caller signal via AbortSignal.any, so
// supplying both would run two timers for the same deadline, and a
// `TimeoutError` from AbortSignal.timeout would bypass the helper's
// FetchTimeoutError mapping. A timeout now surfaces as FetchTimeoutError,
// which both callers below already treat as a failed request.

/**
 * Call the sonic-embedder HTTP sidecar's /embed endpoint.
 *
 * Returns the NDJSON body text on success, or null if SONIC_EMBEDDER_URL is
 * not configured (caller should fall back to execFile). Throws on HTTP error
 * or network failure so the task can retry.
 *
 * @param paths   Absolute paths to audio files.
 * @param threads Optional intra-op thread cap forwarded to the sidecar.
 *                Omit (or pass undefined/0) to let the sidecar use its env default.
 */
async function callSidecarEmbed(paths: string[], threads?: number): Promise<string | null> {
    const url = config.SONIC_EMBEDDER_URL;
    if (!url) return null;

    logger.debug('Calling sonic-embedder sidecar /embed', { url, pathCount: paths.length });

    // accept_busy: let the sidecar's memory gate answer 429 instead of queueing this
    // request indefinitely; embedBatch waits and resends without blaming the files.
    const requestBody: Record<string, unknown> = { paths, accept_busy: true };
    if (typeof threads === 'number' && threads > 0) {
        requestBody.threads = threads;
    }

    const response = await fetchWithTimeout(
        `${url}/embed`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        },
        BATCH_EMBED_HTTP_TIMEOUT_MS,
    );

    if (response.status === 429) {
        await response.text().catch(() => '');
        throw new SidecarBusySignal(busyRetryAfterMs(response.headers.get('retry-after')));
    }
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Sonic sidecar /embed returned ${response.status}: ${body.slice(0, 200)}`);
    }

    return response.text();
}

/** Internal: one 429 from the sidecar's memory gate. */
class SidecarBusySignal extends Error {
    constructor(readonly retryAfterMs: number) {
        super('Sonic sidecar is busy (HTTP 429)');
        this.name = 'SidecarBusySignal';
    }
}

/**
 * {@link callSidecarEmbed}, waiting out 429s for up to SIDECAR_BUSY_MAX_WAIT_MS.
 * Throws {@link SonicBusyError} when the sidecar stays busy (or `signal` aborts the wait).
 */
async function callSidecarEmbedWhenFree(
    paths: string[],
    threads: number | undefined,
    signal: AbortSignal | undefined,
): Promise<string | null> {
    const deadline = Date.now() + SIDECAR_BUSY_MAX_WAIT_MS;
    for (;;) {
        try {
            return await callSidecarEmbed(paths, threads);
        } catch (err) {
            if (!(err instanceof SidecarBusySignal)) throw err;
            logger.info('Sonic sidecar busy; waiting before resending /embed', {
                pathCount: paths.length,
                retryAfterMs: err.retryAfterMs,
            });
            if (
                Date.now() + err.retryAfterMs > deadline ||
                !(await sleepUnlessAborted(err.retryAfterMs, signal))
            ) {
                throw new SonicBusyError(
                    signal?.aborted
                        ? 'Stopped waiting for the busy sonic sidecar: the run was stopped'
                        : 'Sonic sidecar stayed busy (memory budget fully used); the tracks wait for the next run',
                );
            }
        }
    }
}

/**
 * Call the sonic-embedder HTTP sidecar's /embed-text endpoint.
 *
 * Returns the raw response body (JSON array string) on success, null when the
 * URL is not configured (caller falls back to execFile), or null on sidecar
 * failure (so text-search can degrade gracefully rather than throw).
 */
async function callSidecarEmbedText(text: string): Promise<string | null> {
    const url = config.SONIC_EMBEDDER_URL;
    if (!url) return null;

    logger.debug('Calling sonic-embedder sidecar /embed-text', { url, textLength: text.length });

    let response: Response;
    try {
        response = await fetchWithTimeout(
            `${url}/embed-text`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text }),
            },
            TEXT_EMBED_HTTP_TIMEOUT_MS,
        );
    } catch (err) {
        // Network failure, timeout, or refused cross-origin redirect — fail
        // fast so text-search degrades gracefully instead of throwing.
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(
            'Sonic sidecar /embed-text request failed',
            err instanceof Error ? err : undefined,
            {
                textLength: text.length,
                error: errMsg,
            },
        );
        return null;
    }

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        logger.error('Sonic sidecar /embed-text returned error', undefined, {
            status: response.status,
            body: body.slice(0, 200),
        });
        return null;
    }

    return response.text();
}

// ============================================================================
// Engine availability
// ============================================================================

/**
 * How long a file-presence answer is reused. The stage sweep asks every tick, so
 * the filesystem is not hit each time, but an interpreter or script installed
 * (or removed) under a running process is noticed within this window.
 */
const SUBPROCESS_FILES_TTL_MS = 60_000;

/** Waits before re-checking packages that were missing: 10 min, 1 h, then every 6 h. */
const MODULES_RETRY_BACKOFF_MS = [10 * 60_000, 60 * 60_000, 6 * 60 * 60_000] as const;

/**
 * How long a subprocess embedder that cannot be started, or cannot load the
 * model, is treated as absent. A broken Python environment does not repair
 * itself; a changed setting re-probes at once (new key) and a later successful
 * embed lifts the hold early. Shared through Valkey, because the stage sweep
 * that reads the gate may run in another process than the backfill that hit it.
 */
const BROKEN_ENGINE_HOLD_MS = 6 * 60 * 60_000;

/** Interpreter-side check: are the packages installed? Does not import them. */
const MODULES_CHECK_SNIPPET =
    "import importlib.util as u, sys; sys.exit(0 if all(u.find_spec(m) for m in ('torch', 'msclap')) else 3)";

/** Upper bound on the module check. find_spec does not import torch; this is for slow shims. */
const MODULES_CHECK_TIMEOUT_MS = 10_000;

/** Spawn errors that mean "this interpreter cannot run at all", not "try again". */
const UNSTARTABLE_SPAWN_CODES = new Set(['ENOENT', 'EACCES', 'ENOEXEC', 'EISDIR', 'ENOTDIR']);

/** Host-level spawn errors: nothing is wrong with the embedder or the files. */
const TRANSIENT_SPAWN_CODES = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'EBUSY']);

interface SubprocessProbe {
    filesOk: boolean;
    filesAt: number;
    modulesOk?: boolean;
    modulesAt?: number;
    modulesFailures: number;
    /** Local copy of the shared hold; refreshed from Valkey with the files check. */
    brokenUntil?: number;
}

/** Keyed on `python\0script\0PATH`, so a changed setting is re-probed. */
const subprocessProbe = new Map<string, SubprocessProbe>();

function subprocessKey(): string {
    return `${config.SONIC_EMBEDDER_PYTHON}\0${config.SONIC_EMBEDDER_SCRIPT}\0${process.env.PATH ?? ''}`;
}

function brokenHoldCacheKey(key: string): string {
    return `v1:sonic:engine-broken:${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

/** What `execFile` falls back to when the environment has no PATH at all. */
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

function isExecutableFile(path: string): boolean {
    try {
        if (!statSync(path).isFile()) return false;
        // Windows has no exec bit; a present file is the best signal there.
        if (process.platform !== 'win32') accessSync(path, fsConstants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** `which`: a bare name is looked up on PATH, anything with a separator is a path. */
function resolvesToExecutable(bin: string): boolean {
    if (process.platform === 'win32') {
        // PATHEXT / registry lookups are not worth re-implementing here; the
        // module check below spawns the interpreter and rules a missing one out.
        return true;
    }
    if (bin.includes('/')) return isExecutableFile(bin);
    // An empty entry means the current directory, as it does for execvp.
    return (process.env.PATH ?? DEFAULT_PATH)
        .split(delimiter)
        .some((dir) => isExecutableFile(join(dir || '.', bin)));
}

/** Resolved against cwd, exactly as the spawned interpreter will resolve it. */
function isReadableFile(path: string): boolean {
    const resolved = isAbsolute(path) ? path : join(process.cwd(), path);
    try {
        if (!statSync(resolved).isFile()) return false;
        accessSync(resolved, fsConstants.R_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Ask the interpreter whether torch + msclap are installed. Synchronous on
 * purpose: an answer that is "unknown" for a while would have to be guessed, and
 * a wrong guess flips the whole library between pending and skipped. It runs
 * once per setting (then with backoff while failing), only on hosts that have
 * both the interpreter and embed.py — never on a Docker install without the
 * sidecar, which has neither.
 */
function modulesImportable(python: string): boolean {
    try {
        execFileSync(python, ['-c', MODULES_CHECK_SNIPPET], {
            timeout: MODULES_CHECK_TIMEOUT_MS,
            stdio: 'ignore',
        });
        return true;
    } catch {
        return false;
    }
}

/** Pull the shared broken-engine hold into the local probe (fire-and-forget). */
function refreshSharedHold(key: string, probe: SubprocessProbe): void {
    void (async () => {
        try {
            const held = await cacheGet(brokenHoldCacheKey(key));
            if (held) {
                const until = Number(held);
                if (Number.isFinite(until) && until > Date.now()) probe.brokenUntil = until;
            } else if (probe.brokenUntil !== undefined && probe.brokenUntil > Date.now()) {
                // Lifted elsewhere (a later successful embed, see noteSubprocessEngineWorking).
                probe.brokenUntil = undefined;
            }
        } catch {
            // Valkey down: keep the local view.
        }
    })();
}

/**
 * {@link isSonicEngineConfigured} for a page load: the same answer, but never
 * runs the interpreter's module check (a synchronous spawn of up to 10 s that
 * would stall the event loop). `null` when that check has not run in this
 * process yet. File checks only, so it is cheap.
 */
export function peekSonicEngineConfigured(): boolean | null {
    if (config.SONIC_EMBEDDER_URL) return true;
    const python = config.SONIC_EMBEDDER_PYTHON;
    const script = config.SONIC_EMBEDDER_SCRIPT;
    if (!python || !script || !resolvesToExecutable(python) || !isReadableFile(script)) {
        return false;
    }
    const probe = subprocessProbe.get(subprocessKey());
    if (probe?.brokenUntil !== undefined && Date.now() < probe.brokenUntil) return false;
    return probe?.modulesOk ?? null;
}

/**
 * Whether this install has a usable way to embed audio — a durable fact about
 * the deployment, not a health check. Drives the stage's install gate, so a
 * `false` marks the library "not applicable here" instead of leaving it pending,
 * and the admin preset uses it to decide whether to offer sonic features.
 *
 * - `SONIC_EMBEDDER_URL` set → true. A sidecar that is down or still loading
 *   its model is TRANSIENT: runs fail with {@link SonicEngineError} and retry,
 *   and the tracks stay eligible across it.
 * - Unset → the subprocess fallback, which needs:
 *   1. the interpreter and `embed.py` (reused for {@link SUBPROCESS_FILES_TTL_MS}).
 *      The app image ships neither, so every Docker install without the sidecar
 *      answers false here;
 *   2. torch and msclap installed for that interpreter (a `find_spec` check,
 *      once per setting, then {@link MODULES_RETRY_BACKOFF_MS} while failing);
 *   3. no recent run in which it could not start or load the model
 *      ({@link BROKEN_ENGINE_HOLD_MS}) — what (2) cannot see, such as corrupt
 *      weights or a torch that imports but crashes.
 */
export function isSonicEngineConfigured(): boolean {
    if (config.SONIC_EMBEDDER_URL) return true;
    const python = config.SONIC_EMBEDDER_PYTHON;
    const script = config.SONIC_EMBEDDER_SCRIPT;
    const key = subprocessKey();
    const now = Date.now();
    let probe = subprocessProbe.get(key);
    if (!probe) {
        probe = { filesOk: false, filesAt: 0, modulesFailures: 0 };
        subprocessProbe.set(key, probe);
    }
    if (now - probe.filesAt >= SUBPROCESS_FILES_TTL_MS) {
        // In place, never a new object: the shared-hold refresh holds a reference.
        const filesOk =
            Boolean(python) &&
            Boolean(script) &&
            resolvesToExecutable(python) &&
            isReadableFile(script);
        if (!filesOk && (probe.filesAt === 0 || probe.filesOk)) {
            logger.info(
                'No sonic embedder: SONIC_EMBEDDER_URL is unset and the subprocess fallback is not installed',
                { python: python || '(empty)', script: script || '(empty)' },
            );
        }
        probe.filesOk = filesOk;
        probe.filesAt = now;
        if (filesOk) refreshSharedHold(key, probe);
    }
    if (!probe.filesOk) return false;
    if (probe.brokenUntil !== undefined && now < probe.brokenUntil) return false;

    const retryAfter =
        MODULES_RETRY_BACKOFF_MS[
            Math.min(probe.modulesFailures, MODULES_RETRY_BACKOFF_MS.length) - 1
        ] ?? 0;
    if (
        probe.modulesOk === undefined ||
        (!probe.modulesOk && now - (probe.modulesAt ?? 0) >= retryAfter)
    ) {
        const ok = modulesImportable(python);
        if (!ok && probe.modulesOk !== false) {
            logger.warn(
                'Sonic embedder subprocess fallback unusable: torch/msclap are not installed for the configured interpreter',
                { python },
            );
        }
        probe.modulesOk = ok;
        probe.modulesAt = now;
        probe.modulesFailures = ok ? 0 : probe.modulesFailures + 1;
    }
    return probe.modulesOk;
}

/**
 * Hold the subprocess gate closed: it could not be started or could not load
 * the model for any path. The stage then marks the library "no embedder" rather
 * than re-running a broken environment every sweep.
 */
function noteSubprocessEngineBroken(reason: string): void {
    const key = subprocessKey();
    const until = Date.now() + BROKEN_ENGINE_HOLD_MS;
    // Create the entry if this process never asked yet (filesAt 0: the files are
    // still checked on the next read, the hold is kept).
    const probe = subprocessProbe.get(key) ?? { filesOk: false, filesAt: 0, modulesFailures: 0 };
    probe.brokenUntil = until;
    subprocessProbe.set(key, probe);
    logger.warn('Sonic embedder subprocess cannot run; treating it as absent', {
        reason: reason.slice(0, 300),
        retryInHours: BROKEN_ENGINE_HOLD_MS / 3_600_000,
    });
    void Promise.resolve()
        .then(() => cacheSet(brokenHoldCacheKey(key), String(until), BROKEN_ENGINE_HOLD_MS / 1000))
        .catch(() => undefined);
}

/** A subprocess embed just worked: lift any hold, here and for other processes. */
function noteSubprocessEngineWorking(): void {
    const key = subprocessKey();
    const probe = subprocessProbe.get(key);
    if (probe?.brokenUntil === undefined) return;
    probe.brokenUntil = undefined;
    void Promise.resolve()
        .then(() => cacheDel(brokenHoldCacheKey(key)))
        .catch(() => undefined);
}

/** Test seam: forget memoised subprocess probes. */
export function resetSonicEngineProbeForTests(): void {
    subprocessProbe.clear();
}

/**
 * The embedder itself failed — it was unreachable, not ready, could not be
 * started, or could not load the model — so the failure says NOTHING about the
 * individual tracks. Thrown instead of returning one failure per path, because
 * per-path failures count toward the backfill's per-track write-off: an outage
 * spanning a few scheduled runs used to write a whole library off as
 * undecodable, and it stayed written off after the embedder came back.
 *
 * `partial` carries the results of the batches that DID complete before the
 * failure (from {@link embedPaths}), so the caller can still store them.
 */
export class SonicEngineError extends Error {
    readonly partial: EmbedResult[];
    /**
     * The paths that were in the request when the embedder failed — the only
     * ones that can have caused it. Batches {@link embedPaths} had not sent yet
     * are in neither list.
     */
    readonly inFlight: string[];
    constructor(
        message: string,
        options?: { cause?: unknown; partial?: EmbedResult[]; inFlight?: string[] },
    ) {
        super(message, options);
        this.name = 'SonicEngineError';
        this.partial = options?.partial ?? [];
        this.inFlight = options?.inFlight ?? [];
    }
}

/**
 * The sidecar answered 429 (its memory gate was full) for longer than callers wait.
 * A {@link SonicEngineError} — nothing about the tracks, no attempt is charged — with
 * nothing in flight, so no track becomes a crash suspect; the backfill ends its run
 * quietly instead of failing it.
 */
export class SonicBusyError extends SonicEngineError {
    constructor(message: string, options?: { partial?: EmbedResult[] }) {
        super(message, { partial: options?.partial, inFlight: [] });
        this.name = 'SonicBusyError';
    }
}

/** embed.py / the sidecar mark a model-load failure with `fatal: 'engine'`; older ones only by prefix. */
const MODEL_LOAD_FAILED_PREFIX = 'model load failed';

function isEngineFailure(r: EmbedResult): boolean {
    return (
        !isEmbedSuccess(r) && (r.fatal === 'engine' || r.error.startsWith(MODEL_LOAD_FAILED_PREFIX))
    );
}

/** Every path failed because the model could not be loaded. */
function isModelLoadFailure(results: readonly EmbedResult[]): boolean {
    return results.length > 0 && results.every(isEngineFailure);
}

/** GET /health: true once the sidecar has its model loaded (it answers 503 until then). */
async function sidecarReady(url: string): Promise<boolean> {
    try {
        const response = await fetchWithTimeout(`${url}/health`, { method: 'GET' }, 5_000);
        await response.text().catch(() => '');
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Whether the embedder can take work right now: the sidecar answers its
 * `/health` as ready, or the subprocess fallback is usable. The backfill asks
 * this before embedding a crash suspect alone, so that a failure DURING that
 * call can be charged to the file (see sonic-crash-suspects.ts).
 */
export async function isSonicEmbedderReady(): Promise<boolean> {
    const url = config.SONIC_EMBEDDER_URL;
    if (!url) return isSonicEngineConfigured();
    // A busy sidecar can answer /health slowly; a few tries before calling it down.
    for (let attempt = 0; attempt < 3; attempt++) {
        if (await sidecarReady(url)) return true;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    return false;
}

/**
 * A batch failed as a whole, but the embedder is up: the failure is about the
 * request's content (one file the sidecar or the decoder chokes on). Retry the
 * paths one by one so only the file at fault is charged a failure; a single
 * path that still fails comes back as that path's own failure.
 */
async function embedOneByOne(
    paths: string[],
    threads: number | undefined,
    errMsg: string,
    signal?: AbortSignal,
): Promise<EmbedResult[]> {
    if (paths.length === 1) return [{ path: paths[0], error: errMsg }];
    logger.info('Sonic embed batch failed with the embedder up; retrying path by path', {
        pathCount: paths.length,
    });
    const results: EmbedResult[] = [];
    for (const path of paths) {
        try {
            results.push(...(await embedBatch([path], threads, signal)));
        } catch (err) {
            if (err instanceof SonicBusyError) {
                throw new SonicBusyError(err.message, { partial: [...results, ...err.partial] });
            }
            if (err instanceof SonicEngineError) {
                throw new SonicEngineError(err.message, {
                    cause: err,
                    partial: [...results, ...err.partial],
                    inFlight: err.inFlight.length > 0 ? err.inFlight : [path],
                });
            }
            throw err;
        }
    }
    return results;
}

// ============================================================================
// Core embedding function
// ============================================================================

/**
 * Embed one batch of audio file paths.
 *
 * When config.SONIC_EMBEDDER_URL is set, calls the HTTP sidecar (warm model,
 * no cold-start). Otherwise spawns the Python CLI (existing behaviour).
 *
 * @param paths   Absolute paths to audio files.
 * @param threads Optional CPU thread cap forwarded to the sidecar (HTTP path) or
 *                set as SONIC_EMBEDDER_THREADS / OMP_NUM_THREADS in the subprocess
 *                env (subprocess path). Omit to use sidecar/env defaults.
 * @returns       One result per input path (success or failure). A whole-batch
 *                failure with the embedder up is retried path by path, so a
 *                failure here is always about that path.
 * @throws SonicEngineError when the embedder itself is unavailable or cannot
 *                load the model — never a per-path failure.
 */
export async function embedBatch(
    paths: string[],
    threads?: number,
    signal?: AbortSignal,
): Promise<EmbedResult[]> {
    if (paths.length === 0) return [];

    // --- HTTP sidecar path ---
    const sidecarUrl = config.SONIC_EMBEDDER_URL;
    if (sidecarUrl) {
        let results: EmbedResult[] | undefined;
        let errMsg = '';
        let cause: unknown;
        try {
            const body = await callSidecarEmbedWhenFree(paths, threads, signal);
            // callSidecarEmbed only returns null when URL is unset, which we've
            // already checked — this branch can't produce null here.
            const resultMap = parseEmbedNdjson(body ?? '');
            if (resultMap.size > 0) {
                results = paths.map(
                    (path) => resultMap.get(path) ?? { path, error: 'no output from embedder' },
                );
            } else {
                // A 200 with nothing parseable (a proxy error page, a stream cut
                // short): a whole-batch failure, judged like a thrown call below.
                errMsg = 'Sonic sidecar returned no parseable result lines';
            }
        } catch (err) {
            // Busy is not a failure of this batch or of the sidecar's health.
            if (err instanceof SonicBusyError) throw err;
            errMsg = err instanceof Error ? err.message : String(err);
            cause = err;
            logger.error(
                'Sonic sidecar /embed call failed',
                err instanceof Error ? err : undefined,
                {
                    pathCount: paths.length,
                },
            );
        }

        if (results) {
            if (isModelLoadFailure(results)) {
                throw new SonicEngineError(
                    `Sonic sidecar cannot load the model: ${(results[0] as EmbedFailure).error}`,
                );
            }
            const overBudget = results.find(
                (r): r is EmbedFailure =>
                    !isEmbedSuccess(r) && r.code === SIDECAR_EXCEEDS_MEMORY_BUDGET,
            );
            if (overBudget) {
                // The sidecar is too small for any embedding: an install problem, not
                // a track problem. Keep what did embed, charge nothing.
                throw new SonicEngineError(`Sonic sidecar memory too small: ${overBudget.error}`, {
                    partial: results.filter(isEmbedSuccess),
                });
            }
            return results;
        }
        // Whole batch failed. Down / not ready / redirect refused → outage, which
        // says nothing about the tracks. Up and ready → the request's content is
        // to blame (one file the sidecar chokes on): find it path by path.
        if (!(await sidecarReady(sidecarUrl))) {
            throw new SonicEngineError(`Sonic sidecar unavailable: ${errMsg}`, {
                cause,
                inFlight: paths,
            });
        }
        return embedOneByOne(paths, threads, errMsg, signal);
    }

    // --- Subprocess fallback ---
    const pythonBin = config.SONIC_EMBEDDER_PYTHON;
    const scriptPath = config.SONIC_EMBEDDER_SCRIPT;
    const stdinPayload = JSON.stringify({ paths });

    logger.debug('Spawning sonic embedder', {
        python: pythonBin,
        script: scriptPath,
        pathCount: paths.length,
    });

    // Thread cap: when cpuThreads is set, propagate it into the subprocess env
    // so the spawned Python process also respects the operator's budget.
    const subprocessEnv: Record<string, string | undefined> = { ...process.env };
    if (typeof threads === 'number' && threads > 0) {
        const threadStr = String(threads);
        subprocessEnv.SONIC_EMBEDDER_THREADS = threadStr;
        subprocessEnv.OMP_NUM_THREADS = threadStr;
    }

    let stdout: string;
    try {
        // Pass the batch JSON via stdin so the command line stays short
        // even for large batches (avoids ARG_MAX limits).
        // timeout: 5 min per batch — GPU embedding should finish well within this.
        const execOpts: ExecFileWithInputOptions = {
            input: stdinPayload,
            timeout: 300_000, // 5 minutes
            maxBuffer: 64 * 1024 * 1024, // 64 MB stdout buffer for large batches
            env: subprocessEnv,
        };
        const result = await execFileAsync(pythonBin, [scriptPath], execOpts);
        // stdout is `string | Buffer` depending on the encoding option; we rely on
        // the default utf-8 string encoding, so coerce defensively.
        stdout =
            typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf-8');
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error('Sonic embedder process failed', err instanceof Error ? err : undefined, {
            pathCount: paths.length,
        });
        const failure = err as { code?: unknown; stdout?: unknown };
        const code = typeof failure.code === 'string' ? failure.code : undefined;
        // The interpreter cannot run at all (missing, not executable).
        if (code !== undefined && UNSTARTABLE_SPAWN_CODES.has(code)) {
            noteSubprocessEngineBroken(errMsg);
            throw new SonicEngineError(`Sonic embedder could not be started: ${errMsg}`, {
                cause: err,
            });
        }
        // The host could not spawn right now (fd/memory/process limits).
        if (code !== undefined && TRANSIENT_SPAWN_CODES.has(code)) {
            throw new SonicEngineError(`Sonic embedder could not be spawned: ${errMsg}`, {
                cause: err,
            });
        }
        // embed.py exits 1 after one model-load failure line per path — that
        // includes torch/msclap missing, since load_model() imports them.
        const partial = parseEmbedNdjson(typeof failure.stdout === 'string' ? failure.stdout : '');
        const reported = paths.map((path) => partial.get(path) ?? { path, error: errMsg });
        if (isModelLoadFailure(reported)) {
            const reason = (reported[0] as EmbedFailure).error;
            noteSubprocessEngineBroken(reason);
            throw new SonicEngineError(`Sonic embedder cannot load the model: ${reason}`, {
                cause: err,
            });
        }
        // Anything else (a crash or timeout part-way, an oversized output) may be
        // one bad file: retry path by path so only that file is charged.
        return embedOneByOne(paths, threads, errMsg, signal);
    }

    // Parse JSONL — one line per input path.
    const resultMap = parseEmbedNdjson(stdout);

    // Any input path that produced no JSONL line is an implicit failure
    const results = paths.map(
        (path) => resultMap.get(path) ?? { path, error: 'no output from embedder' },
    );
    if (isModelLoadFailure(results)) {
        const reason = (results[0] as EmbedFailure).error;
        noteSubprocessEngineBroken(reason);
        throw new SonicEngineError(`Sonic embedder cannot load the model: ${reason}`);
    }
    if (results.some(isEmbedSuccess)) noteSubprocessEngineWorking();
    return results;
}

// ============================================================================
// Text embedding for text-to-sound search
// ============================================================================

/** Parse and validate a text-embedding JSON array from any source (HTTP or subprocess). */
function parseTextEmbeddingJson(raw: string): number[] | null {
    const trimmedOut = raw.trim();
    if (!trimmedOut) {
        logger.warn('Text embedder produced no output');
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmedOut);
    } catch {
        logger.warn('Text embedder output is not valid JSON', { out: trimmedOut.slice(0, 200) });
        return null;
    }

    if (!Array.isArray(parsed)) {
        logger.warn('Text embedder output is not a JSON array');
        return null;
    }

    const embedding = parsed as unknown[];
    if (embedding.length !== EMBEDDING_DIM) {
        logger.warn('Text embedding has unexpected dimension', {
            got: embedding.length,
            expected: EMBEDDING_DIM,
        });
        return null;
    }

    // A hand-rolled or buggy embedding provider can return `null`/`NaN`/
    // `Infinity` slots (JSON has no Infinity/NaN literal, so these surface
    // as `null`) that would otherwise be written straight into a pgvector
    // column via `searchByLyricsEmbedding`/`textSoundSearch` (C21 fix-plan
    // finding) — reject the whole vector rather than store a poisoned one.
    if (!embedding.every((v): v is number => typeof v === 'number' && Number.isFinite(v))) {
        logger.warn('Text embedding contains a non-finite value');
        return null;
    }

    return embedding;
}

/**
 * Embed a natural-language text query into the CLAP 1024-dim vector space.
 *
 * When config.SONIC_EMBEDDER_URL is set:
 *   1. Check Valkey cache (key: v1:text-embed:<sha256(text)>, TTL 1h).
 *   2. On miss: POST to the sidecar's /embed-text endpoint (15s timeout).
 *   3. Store successful result in Valkey.
 *
 * When config.SONIC_EMBEDDER_URL is unset: spawns embed_text.py (existing
 * behaviour, unchanged).
 *
 * The resulting vector lives in the same cosine space as audio embeddings in
 * `media_audio_embeddings`, so a direct kNN comparison via `<=>` is valid.
 *
 * @param text  Natural-language query string (e.g. "calm piano").
 * @returns     1024-dimensional float array, or null on failure.
 */
export async function embedTextQuery(text: string): Promise<number[] | null> {
    const trimmed = text.trim();
    if (!trimmed) return null;

    // --- HTTP sidecar path (with Valkey cache) ---
    const sidecarUrl = config.SONIC_EMBEDDER_URL;
    if (sidecarUrl) {
        const cacheKey = `v1:text-embed:${createHash('sha256').update(trimmed).digest('hex')}`;

        // Check cache first — deterministic embeddings, 1h TTL
        const cached = await cacheGet(cacheKey);
        if (cached !== null) {
            logger.debug('Text embedding cache hit', { cacheKey });
            const embedding = parseTextEmbeddingJson(cached);
            if (embedding !== null) return embedding;
            // Cached value is corrupt — fall through to fetch
        }

        const rawBody = await callSidecarEmbedText(trimmed);
        if (rawBody === null) return null; // sidecar down/error — fail fast

        const embedding = parseTextEmbeddingJson(rawBody);
        if (embedding !== null) {
            // Cache the raw JSON array string so we can re-parse cheaply on hit
            await cacheSet(cacheKey, rawBody, TEXT_EMBED_CACHE_TTL_SECONDS);
        }
        return embedding;
    }

    // --- Subprocess fallback (existing behaviour, byte-for-byte unchanged) ---
    const pythonBin = config.SONIC_EMBEDDER_PYTHON;
    const scriptPath = config.SONIC_EMBEDDER_TEXT_SCRIPT;
    const stdinPayload = JSON.stringify({ text: trimmed });

    logger.debug('Spawning text embedder', {
        python: pythonBin,
        script: scriptPath,
        textLength: trimmed.length,
    });

    let stdout: string;
    try {
        const execOpts: ExecFileWithInputOptions = {
            input: stdinPayload,
            timeout: 120_000, // 2 minutes — text embedding is fast
            maxBuffer: 4 * 1024 * 1024, // 4 MB stdout buffer (1024 floats is tiny)
        };
        const result = await execFileAsync(pythonBin, [scriptPath], execOpts);
        stdout =
            typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf-8');
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error('Text embedder process failed', err instanceof Error ? err : undefined, {
            textLength: trimmed.length,
            error: errMsg,
        });
        return null;
    }

    return parseTextEmbeddingJson(stdout);
}

// ============================================================================
// Batched embedding for the backfill task
// ============================================================================

/**
 * Embed an arbitrary-length list of paths in configurable batch sizes.
 *
 * Processes sequentially (one Python process per batch) to avoid
 * OOM on the GPU worker. Returns one EmbedResult per input path
 * in the same order as the input.
 *
 * @param paths   Absolute paths to audio files.
 * @param threads Optional CPU thread cap forwarded to every {@link embedBatch} call.
 * @param signal  Optional abort signal: stops waiting for a busy sidecar (429).
 */
export async function embedPaths(
    paths: string[],
    threads?: number,
    signal?: AbortSignal,
): Promise<EmbedResult[]> {
    const batchSize = Math.max(1, config.SONIC_EMBEDDER_BATCH_SIZE);
    const results: EmbedResult[] = [];

    for (let i = 0; i < paths.length; i += batchSize) {
        const batch = paths.slice(i, i + batchSize);
        try {
            results.push(...(await embedBatch(batch, threads, signal)));
        } catch (err) {
            // Keep what the earlier batches already computed: the caller stores
            // it before stopping, instead of redoing that work next run.
            if (err instanceof SonicBusyError) {
                throw new SonicBusyError(err.message, { partial: [...results, ...err.partial] });
            }
            if (err instanceof SonicEngineError) {
                throw new SonicEngineError(err.message, {
                    cause: err.cause ?? err,
                    partial: [...results, ...err.partial],
                    inFlight: err.inFlight.length > 0 ? err.inFlight : batch,
                });
            }
            throw err;
        }
    }

    return results;
}
