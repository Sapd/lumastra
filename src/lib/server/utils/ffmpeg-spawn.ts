// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Safe FFmpeg Spawn Wrapper
 *
 * Provides a crash-proof FFmpeg spawning utility with comprehensive error handling.
 * Prevents all common FFmpeg process crash patterns:
 *
 * 1. Synchronous spawn errors (ENOENT, EACCES) caught with try-catch
 * 2. Error event after promise resolution prevented with errorHandled flag
 * 3. Duplicate error objects avoided with single error instance
 * 4. Timeout races prevented with proper cleanup
 * 5. OOM prevented with stdout/stderr size limits
 *
 * WHEN TO USE THIS WRAPPER:
 * - Short-lived FFmpeg operations (< 1 minute)
 * - Fixed timeout is acceptable
 * - Simple success/failure handling
 * - No external process control needed
 * Examples: subtitle extraction, hardware probing, I-frame generation
 *
 * WHEN TO USE MANUAL SPAWN:
 * - Long-running operations (hours)
 * - Complex state machine with seek/restart logic
 * - External process control (job.process tracking)
 * - Custom lifecycle management
 * Example: transcode service (see ffmpeg-transcode.service.ts)
 */

import { backgroundCpuCheckpoint, inBackgroundCpuTask } from '../tasks/background-cpu-scope.js';
import { setPriority } from 'node:os';
import { existsSync, createWriteStream } from 'node:fs';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { Logger } from './logger.js';
import { config, LUMASTRA_FFMPEG_THREADS } from '$lib/server/config.js';
import { guardLibraryInput } from './library-input-guard.js';
import { prepareMediaFormatWhitelist } from './media-format-whitelist.js';

/**
 * Inject a `-threads N` flag into the ffmpeg argv so every spawned ffmpeg
 * honors the global cap. Without this, ffmpeg defaults to using all
 * available CPU cores per process — which on a multi-core host means a
 * single trickplay-generation can consume 8-10 cores while the task
 * runner's cpu-class concurrency cap thinks only "one slot" is in use.
 *
 * Skips the injection when:
 *   - the cap is 0 (admin opted out; restores ffmpeg auto-thread behavior)
 *   - the caller already passed an explicit `-threads` flag (their intent
 *     wins; allows per-call overrides for known-heavy or known-light paths)
 *
 * Placed at the front of the argv as a global option so ffmpeg applies it
 * to both the decoder and encoder thread pools.
 */
function injectThreadsFlag(args: ReadonlyArray<string>): string[] {
    if (LUMASTRA_FFMPEG_THREADS <= 0) return [...args];
    if (args.includes('-threads')) return [...args];
    return ['-threads', String(LUMASTRA_FFMPEG_THREADS), ...args];
}

const logger = Logger.for('FFmpegSpawn');
const getErrorCode = (value: unknown): string | undefined =>
    typeof (value as { code?: unknown }).code === 'string'
        ? (value as { code: string }).code
        : undefined;

/** Default timeout for FFmpeg operations (milliseconds) */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Maximum stdout buffer size (10MB) */
const MAX_STDOUT_SIZE = 10 * 1024 * 1024;

/** Maximum stderr buffer size (100KB) */
const MAX_STDERR_SIZE = 100_000;

/** Signal type for kill operations */
type KillSignal = 'SIGKILL' | 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'SIGQUIT' | 'SIGABRT';

export interface FFmpegSpawnOptions {
    /** FFmpeg command-line arguments */
    args: string[];
    /** Binary outputs use pipe:3, pipe:4, ...; backpressure and byte caps apply before disk writes. */
    binaryOutputs?: Array<{ path: string; maxBytes: number }>;
    /** Working directory for FFmpeg process */
    cwd?: string;
    /** Timeout in milliseconds (default: 30000) */
    timeout?: number;
    /** Maximum stdout size in bytes (default: 10MB) */
    maxStdoutSize?: number;
    /** Maximum stderr size in bytes (default: 100KB) */
    maxStderrSize?: number;
    /** Input data to write to stdin (optional) */
    stdin?: Buffer | string;
    /** Kill signal to use on timeout (default: SIGKILL) */
    killSignal?: KillSignal;
    /**
     * Optional abort signal. When fired, the running FFmpeg child is killed
     * with `killSignal` and the promise rejects with FFmpegError(stderr,…).
     * Pre-aborted signals reject before spawn. Wired by long-running CPU
     * tasks (trickplay) so admin Cancel terminates orphan ffmpeg processes.
     */
    abortSignal?: AbortSignal;
    /** Additional context for logging */
    context?: Record<string, unknown>;
    /**
     * Log a non-zero exit at DEBUG instead of ERROR.
     *
     * For callers whose whole purpose is to find out whether a pipeline works
     * — the trickplay hardware-decode probe, which deliberately tries a GPU
     * filter graph and falls back when it fails. A handled probe failure is a
     * measurement, not an incident, and logging it at ERROR buries real ones:
     * on prod it produced 76 `libwebp: Could not open encoder` errors in half
     * an hour (VAAPI cannot decode MPEG-4 Part 2, so ffmpeg fell back to the
     * native decoder and `scale_vaapi` then rejected the software frames) —
     * every one of them immediately and correctly recovered.
     *
     * The rejection is unchanged; only the log level moves.
     */
    expectFailure?: boolean;
    /**
     * Path of the library file this ffmpeg opens with `-i`. Set it for any
     * spawn whose input is a library file (not a fixed `lavfi` source, stdin
     * or the app's own output): the spawn then gets `-format_whitelist` for
     * that input. See `library-input-guard.ts`.
     */
    libraryInput?: string;
}

export interface FFmpegResult {
    /** Stdout content */
    stdout: string;
    /** Stderr content */
    stderr: string;
    /** Exit code (0 = success) */
    exitCode: number;
    /** Whether the process was killed by timeout */
    timedOut: boolean;
    /** Whether the process was killed by size limit */
    sizeExceeded: boolean;
}

export class FFmpegError extends Error {
    constructor(
        message: string,
        public exitCode: number | null,
        public stderr: string,
        public timedOut = false,
        public sizeExceeded = false,
        public signal?: string,
    ) {
        super(message);
        this.name = 'FFmpegError';
    }
}

export class FFmpegTimeoutError extends FFmpegError {
    constructor(timeoutMs: number, stderr: string) {
        super(`FFmpeg operation timed out after ${timeoutMs}ms`, null, stderr, true, false);
        this.name = 'FFmpegTimeoutError';
    }
}

export class FFmpegSizeError extends FFmpegError {
    constructor(type: 'stdout' | 'stderr' | 'binary output', maxSize: number, stderr: string) {
        super(
            `FFmpeg ${type} exceeded maximum size of ${maxSize} bytes`,
            null,
            stderr,
            false,
            true,
        );
        this.name = 'FFmpegSizeError';
    }
}

/**
 * Spawn FFmpeg with comprehensive error handling and resource limits.
 *
 * This function is crash-proof and handles all edge cases:
 * - Missing FFmpeg binary (ENOENT)
 * - Permission denied (EACCES)
 * - Timeout scenarios
 * - Large output accumulation (OOM prevention)
 * - Error event races
 * - Duplicate error objects
 *
 * Use this for simple, bounded FFmpeg operations (subtitle extraction, probing, etc.).
 * For long-running operations with complex state management (transcode service),
 * use manual spawn with documented safety patterns.
 *
 * @param options - Spawn options
 * @returns Promise resolving to FFmpegResult or rejecting with FFmpegError
 */
export function spawnFFmpegSafely(options: FFmpegSpawnOptions): Promise<FFmpegResult> {
    if (inBackgroundCpuTask()) {
        return backgroundCpuCheckpoint().then(() => spawnFFmpegPrepared(options));
    }
    return spawnFFmpegPrepared(options);
}

function spawnFFmpegPrepared(options: FFmpegSpawnOptions): Promise<FFmpegResult> {
    if (!options.libraryInput) return spawnFFmpegNow(options);
    // Warm the demuxer enumeration off the event loop, so the argv guard below
    // reads a cache instead of spawning synchronously.
    const warm = prepareMediaFormatWhitelist();
    const launch = (): Promise<FFmpegResult> =>
        spawnFFmpegNow({
            ...options,
            args: guardLibraryInput(options.args, options.libraryInput as string),
        });
    if (!warm) return launch();
    if (!options.abortSignal) return warm.then(launch);
    const signal = options.abortSignal;
    // Whitelist discovery is shared and cannot be cancelled by one caller.
    // Stop waiting on it at the caller's deadline, and never launch that input
    // later when discovery finishes. The shared discovery promise still settles.
    return new Promise<FFmpegResult>((resolve, reject) => {
        const abort = (): void => {
            signal.removeEventListener('abort', abort);
            reject(new FFmpegError('FFmpeg aborted during input preparation', null, ''));
        };
        if (signal.aborted) {
            abort();
            return;
        }
        signal.addEventListener('abort', abort, { once: true });
        void warm
            .then(() => {
                signal.removeEventListener('abort', abort);
                if (signal.aborted) return;
                return launch().then(resolve, reject);
            })
            .catch((error: unknown) => {
                signal.removeEventListener('abort', abort);
                reject(error);
            });
    });
}

function spawnFFmpegNow(options: FFmpegSpawnOptions): Promise<FFmpegResult> {
    const {
        args,
        cwd,
        timeout = DEFAULT_TIMEOUT_MS,
        maxStdoutSize = MAX_STDOUT_SIZE,
        maxStderrSize = MAX_STDERR_SIZE,
        stdin,
        killSignal = 'SIGKILL',
        abortSignal,
        context = {},
        binaryOutputs = [],
    } = options;

    // Pre-aborted signal: skip spawn entirely.
    if (abortSignal?.aborted) {
        return Promise.reject(
            new FFmpegError('FFmpeg aborted before spawn', null, '', false, false),
        );
    }

    return new Promise<FFmpegResult>((resolve, reject) => {
        let ffmpeg: ChildProcess;
        let errorHandled = false;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        // Detacher for the abort listener, populated after spawn so we can
        // remove it on settle (close/error/timeout) without leaking on
        // long-lived signals shared across many ffmpeg invocations.
        let abortListener: (() => void) | null = null;

        // Try to spawn FFmpeg - catch synchronous errors
        try {
            const background = inBackgroundCpuTask();
            // nice/ionice arbitrate within one cgroup only. Across pods, Kubernetes
            // CPU requests protect playback; worker niceness cannot reserve web CPU.
            const linuxPriority =
                background && process.platform === 'linux' && existsSync('/usr/bin/ionice');
            // Both wrappers exec their child, preserving the FFmpeg PID for cancellation.
            ffmpeg = linuxPriority
                ? spawn(
                      '/usr/bin/ionice',
                      [
                          // Keep nice 19 even if a custom seccomp policy denies ioprio_set.
                          '-t',
                          '-c',
                          '3',
                          '/usr/bin/nice',
                          '-n',
                          '19',
                          config.FFMPEG_PATH,
                          ...injectThreadsFlag(args),
                      ],
                      {
                          cwd,
                          stdio: [
                              'pipe',
                              'pipe',
                              'pipe',
                              ...binaryOutputs.map(() => 'pipe' as const),
                          ],
                      },
                  )
                : spawn(config.FFMPEG_PATH, injectThreadsFlag(args), {
                      cwd,
                      stdio: ['pipe', 'pipe', 'pipe', ...binaryOutputs.map(() => 'pipe' as const)],
                  });
            if (background && !linuxPriority && ffmpeg.pid) {
                try {
                    // Raising niceness is allowed for USER node without CAP_SYS_NICE.
                    // Linux derives best-effort I/O priority from this niceness too.
                    setPriority(ffmpeg.pid, 19);
                } catch (err) {
                    logger.warn('Could not lower background FFmpeg priority', {
                        error: String(err),
                    });
                }
            }
        } catch (error) {
            // Synchronous spawn error (e.g., ENOENT, EACCES)
            const err = error instanceof Error ? error : new Error(String(error));
            logger.error('Failed to spawn FFmpeg', err, { args, ...context });

            // Mark FFmpeg as unavailable if not found
            if (getErrorCode(error) === 'ENOENT') {
                logger.warn('FFmpeg binary not found', {
                    ffmpegPath: config.FFMPEG_PATH,
                    ...context,
                });
            }

            reject(err);
            return;
        }

        let stdout = '';
        let stderr = '';
        let killed = false;
        let timedOut = false;
        let sizeExceeded = false;
        let closed = false;
        let pendingFailure: Error | null = null;
        const outputWrites: Promise<void>[] = [];

        // Helper to detach the abort listener — called from both settle paths
        // so we never leak listeners on long-lived signals.
        const detachAbortListener = (): void => {
            if (abortListener && abortSignal) {
                abortSignal.removeEventListener('abort', abortListener);
                abortListener = null;
            }
        };

        // Helper to reject with proper cleanup
        const rejectWithError = (error: Error) => {
            if (errorHandled) return;
            // Binary writers and the child must be closed before callers can
            // unlink output files or release their process concurrency permit.
            if (binaryOutputs.length > 0 && !closed) {
                pendingFailure ??= error;
                return;
            }
            errorHandled = true;
            if (timeoutId) clearTimeout(timeoutId);
            detachAbortListener();
            reject(error);
        };

        // Helper to resolve with proper cleanup
        const resolveWithResult = (exitCode: number) => {
            if (errorHandled) return;
            errorHandled = true;
            if (timeoutId) clearTimeout(timeoutId);
            detachAbortListener();
            resolve({
                stdout,
                stderr,
                exitCode,
                timedOut,
                sizeExceeded,
            });
        };

        for (const [index, output] of binaryOutputs.entries()) {
            let bytes = 0;
            const limiter = new Transform({
                transform(chunk: Buffer, _encoding, callback): void {
                    if (chunk.length > output.maxBytes - bytes) {
                        callback(new FFmpegSizeError('binary output', output.maxBytes, stderr));
                        return;
                    }
                    bytes += chunk.length;
                    callback(null, chunk);
                },
            });
            const input = ffmpeg.stdio[index + 3] as Readable;
            outputWrites.push(
                pipeline(
                    input,
                    limiter,
                    createWriteStream(output.path, { flags: 'wx', mode: 0o600 }),
                ).catch((error: unknown) => {
                    const failure = error instanceof Error ? error : new Error(String(error));
                    if (failure instanceof FFmpegSizeError) sizeExceeded = true;
                    pendingFailure ??= failure;
                    killed = true;
                    ffmpeg.kill('SIGKILL');
                }),
            );
        }

        // Abort listener — kills the ffmpeg child and rejects with a
        // distinguishable FFmpegError. Attached AFTER spawn so we know
        // `ffmpeg` is defined; pre-aborted signals are handled outside the
        // Promise constructor above.
        if (abortSignal) {
            abortListener = (): void => {
                if (errorHandled) return;
                killed = true;
                try {
                    ffmpeg.kill(killSignal);
                } catch (err) {
                    logger.debug('Failed to kill FFmpeg on abort', {
                        error: err instanceof Error ? err.message : String(err),
                        ...context,
                    });
                }
                const error = new FFmpegError('FFmpeg aborted', null, stderr, false, false);
                rejectWithError(error);
            };
            abortSignal.addEventListener('abort', abortListener);
        }

        // Timeout handler
        timeoutId = setTimeout(() => {
            if (errorHandled) return;
            timedOut = true;
            killed = true;
            ffmpeg.kill(killSignal);

            const error = new FFmpegTimeoutError(timeout, stderr);
            // Same expectFailure consultation as the non-zero-exit branch below:
            // a probe with a hardware ceiling (e.g. trickplay's 45s VAAPI probe)
            // is expected to time out on a contended GPU, and the software
            // control rescues it immediately after. Logging that at ERROR
            // reproduces the alert-noise problem the option exists to fix.
            if (options.expectFailure === true) {
                logger.debug('FFmpeg operation timed out (expected by caller)', {
                    timeoutMs: timeout,
                    stderrPreview: stderr.slice(-200),
                    ...context,
                });
            } else {
                logger.error('FFmpeg operation timed out', error, {
                    timeoutMs: timeout,
                    stderrPreview: stderr.slice(-200),
                    ...context,
                });
            }
            rejectWithError(error);
        }, timeout);

        // Stdout handler with size limit
        ffmpeg.stdout?.on('data', (chunk: Buffer) => {
            if (errorHandled || killed) return;

            const chunkStr = chunk.toString();
            stdout += chunkStr;

            // Check size limit to prevent OOM
            if (stdout.length > maxStdoutSize) {
                sizeExceeded = true;
                killed = true;
                ffmpeg.kill(killSignal);

                const error = new FFmpegSizeError('stdout', maxStdoutSize, stderr);
                logger.error('FFmpeg stdout exceeded size limit', error, {
                    stdoutSize: stdout.length,
                    maxSize: maxStdoutSize,
                    ...context,
                });
                rejectWithError(error);
            }
        });

        // Stderr handler with size limit
        ffmpeg.stderr?.on('data', (chunk: Buffer) => {
            if (errorHandled || killed) return;

            const chunkStr = chunk.toString();
            stderr += chunkStr;

            // Keep only last N bytes to prevent unlimited growth
            if (stderr.length > maxStderrSize) {
                // Keep last half of the buffer
                stderr = stderr.slice(-maxStderrSize / 2);
            }
        });

        // Exit/close handler
        const handleClose = (code: number | null, signal: string | null): void => {
            if (pendingFailure) {
                rejectWithError(pendingFailure);
                return;
            }
            if (errorHandled) {
                // Already handled by timeout, size limit, or error event
                return;
            }

            if (killed) {
                // Killed by timeout or size limit - error already handled
                return;
            }

            if (code === 0) {
                // Success
                logger.debug('FFmpeg process completed successfully', {
                    stdoutSize: stdout.length,
                    stderrSize: stderr.length,
                    ...context,
                });
                resolveWithResult(0);
            } else if (signal) {
                // Killed by signal (code will be null)
                const error = new FFmpegError(
                    stderr.trim() || `FFmpeg killed by signal ${signal}`,
                    null,
                    stderr,
                    false,
                    false,
                    signal,
                );

                // Same expectFailure consultation as the timeout handler above
                // and the non-zero-exit branch below: a probe killed by SIGKILL
                // on abort/timeout is a handled outcome for a caller that
                // opted in, not an incident.
                if (options.expectFailure === true) {
                    logger.debug('FFmpeg process killed by signal (expected by caller)', {
                        signal,
                        stderrPreview: stderr.slice(-500),
                        ...context,
                    });
                } else {
                    logger.error('FFmpeg process killed by signal', error, {
                        signal,
                        stderrPreview: stderr.slice(-500),
                        ...context,
                    });
                }
                rejectWithError(error);
            } else {
                // Non-zero exit code
                const error = new FFmpegError(
                    stderr.trim() || `FFmpeg exited with code ${code}`,
                    code,
                    stderr,
                );

                if (options.expectFailure === true) {
                    logger.debug('FFmpeg process failed (expected by caller)', {
                        exitCode: code,
                        stderrPreview: stderr.slice(-500),
                        ...context,
                    });
                } else {
                    logger.error('FFmpeg process failed', error, {
                        exitCode: code,
                        stderrPreview: stderr.slice(-500),
                        ...context,
                    });
                }
                rejectWithError(error);
            }
        };
        ffmpeg.on('close', (code, signal) => {
            closed = true;
            // pipeline catches retain failures, so this cannot reject unhandled.
            void Promise.all(outputWrites).then(() => handleClose(code, signal));
        });

        // Error handler - critical to keep this attached!
        // Even after promise resolves/rejects, this prevents unhandled rejection crashes
        ffmpeg.on('error', (error) => {
            if (errorHandled) {
                // Error event fired after promise already resolved/rejected
                // Log it but don't crash the process
                logger.debug('FFmpeg error event after handling', {
                    error: error.message,
                    code: getErrorCode(error),
                    ...context,
                });
                return;
            }

            // Mark FFmpeg as unavailable if not found
            if (getErrorCode(error) === 'ENOENT') {
                logger.warn('FFmpeg binary not found', {
                    ffmpegPath: config.FFMPEG_PATH,
                    ...context,
                });
            }

            logger.error('FFmpeg process error', error, { ...context });
            rejectWithError(error);
        });

        // Write stdin if provided
        if (stdin) {
            try {
                if (typeof stdin === 'string') {
                    ffmpeg.stdin?.write(stdin, 'utf8');
                } else {
                    ffmpeg.stdin?.write(stdin);
                }
                ffmpeg.stdin?.end();
            } catch (error) {
                // Stdin write error
                const err = error instanceof Error ? error : new Error(String(error));
                logger.error('Failed to write to FFmpeg stdin', err, {
                    ...context,
                });
                rejectWithError(err);
            }
        } else {
            // No stdin data - close stdin to prevent hanging
            ffmpeg.stdin?.end();
        }
    });
}

/**
 * Check if FFmpeg is available on the system.
 * Result is cached to avoid repeated checks.
 *
 * @param forceRecheck - Force a new check even if cached
 * @returns Promise resolving to true if FFmpeg is available
 */
let ffmpegAvailable: boolean | null = null;

export async function checkFFmpegAvailability(forceRecheck = false): Promise<boolean> {
    if (!forceRecheck && ffmpegAvailable !== null) {
        return ffmpegAvailable;
    }

    try {
        const result = await spawnFFmpegSafely({
            args: ['-version'],
            timeout: 5000,
            context: { operation: 'availability-check' },
        });

        ffmpegAvailable = result.exitCode === 0;
        if (ffmpegAvailable) {
            logger.info('FFmpeg availability confirmed', {
                ffmpegPath: config.FFMPEG_PATH,
            });
        }
        return ffmpegAvailable;
    } catch (error) {
        ffmpegAvailable = false;
        logger.warn('FFmpeg not available', {
            error: error instanceof Error ? error.message : String(error),
            ffmpegPath: config.FFMPEG_PATH,
        });
        return false;
    }
}

/**
 * Reset FFmpeg availability cache.
 * Call this after configuration changes or FFmpeg installation.
 */
export function resetFFmpegAvailability(): void {
    ffmpegAvailable = null;
}
