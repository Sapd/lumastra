// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FFmpeg Process Runner — Hybrid EventEmitter + Per-Process Callbacks
 *
 * Lifecycle events (exit, error, masterPlaylistCheck) are delivered via
 * per-process callbacks passed to spawnFFmpeg(). This ensures each process's
 * events are scoped to its own handlers, preventing cross-job contamination
 * and stale-exit races during seek restarts.
 *
 * Broadcast events (progress, stderr) still use the EventEmitter for
 * internal progress tracking and debug logging.
 *
 * Usage:
 *   const runner = new FFmpegProcessRunnerEvents();
 *
 *   await runner.spawnFFmpeg(job, args, {
 *     onExit: (code, signal, stderr) => { ... },
 *     onError: (error) => { ... },
 *     onMasterPlaylistCheck: () => { ... },
 *   });
 */

import { isGopModeJob } from '../hls/gop-mode.js';
import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import { updateLiveRates } from './live-rates.js';
import { observeSpeed } from './slow-transcode.js';
import { Logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import type { TranscodeJob } from './types.js';

const logger = Logger.for('FFmpegProcessRunnerEvents');

/**
 * Broadcast events still emitted via EventEmitter (progress tracking, debug).
 * Lifecycle events (exit, error, masterPlaylistCheck) use per-process callbacks.
 */
export interface FFmpegProcessEvents {
    /**
     * Emitted when FFmpeg outputs progress information.
     * @param segmentsReady Number of segments transcoded so far
     */
    progress: (segmentsReady: number) => void;

    /**
     * Emitted when FFmpeg outputs stderr data (for debugging/logging).
     * @param data Raw stderr data
     */
    stderr: (data: string) => void;
}

/**
 * Per-process lifecycle callbacks for spawnFFmpeg.
 *
 * These are called only from the specific ChildProcess's event handlers,
 * eliminating the shared EventEmitter race condition where old process exit
 * could clobber new job status after an FFmpeg restart.
 */
export interface ProcessLifecycleCallbacks {
    /**
     * Invoked once on process exit.
     *
     * @param code FFmpeg exit code, or null if killed by a signal.
     * @param signal Node-level signal name (e.g. 'SIGKILL'), or null.
     * @param stderrBuffer Bounded stderr capture: the first
     *   {@link STDERR_HEAD_CHARS} plus the last {@link STDERR_TAIL_CHARS}, with an
     *   explicit `[... N chars trimmed ...]` marker between them when anything was
     *   dropped. Both halves matter — the GPU decode-fallback learner keys on the
     *   "Impossible to convert between the formats" line emitted at filter-graph
     *   init (head), while the terminal error cascade lands at exit (tail).
     * @param receivedSigterm True iff the retained capture contained "signal 15".
     *   Reliable indicator that FFmpeg caught SIGTERM and exited cleanly, even when
     *   verbose codec shutdown stats push the marker out of the tail.
     * @returns `true` when the callback has scheduled a replacement process
     *   for this job (a recovery respawn), or the replacement's spawn promise
     *   when it started one at once. An exit inside the startup wait then does
     *   not fail the spawn: the replacement owns the job, and marking it
     *   'error' here would kill a recovery that is under way. A promise is
     *   awaited, so the caller continues only once the replacement exists.
     */
    onExit: (
        code: number | null,
        signal: string | null,
        stderrBuffer: string,
        receivedSigterm: boolean,
    ) => boolean | void | Promise<unknown>;
    onError: (error: Error) => void;
    onMasterPlaylistCheck: () => void;
}

/**
 * Retained head/tail budget for the stderr diagnostic capture.
 *
 * FFmpeg announces WHY a run is doomed at the very start (input dump, hwaccel
 * init, filter-graph negotiation) but only dies at the end. `-stats` streams a
 * progress line every few hundred ms in between, so a plain "keep the last N
 * chars" buffer discards exactly the half that explains the failure once a
 * transcode has run for more than a few seconds.
 *
 * That is not cosmetic: `classifyTranscodeFailure()` and, more importantly,
 * `isLearnableGpuDecodeFailure()` both read this buffer, and the latter gates
 * deny-map learning on /impossible to convert between the formats/i — a line
 * printed at filter-graph init. Trimmed away, a genuine hardware-decode gap is
 * classified 'unknown', never learned, and the recovery ladder silently drops to
 * its weaker per-session rescue.
 */
export const STDERR_HEAD_CHARS = 4_000;
export const STDERR_TAIL_CHARS = 8_000;

/** Accumulator that retains the first {@link STDERR_HEAD_CHARS} and last {@link STDERR_TAIL_CHARS}. */
export interface StderrCapture {
    head: string;
    tail: string;
    trimmedChars: number;
}

export function createStderrCapture(): StderrCapture {
    return { head: '', tail: '', trimmedChars: 0 };
}

/** Append a stderr chunk, filling the head first and keeping a rolling tail. */
export function appendStderr(capture: StderrCapture, chunk: string): void {
    let rest = chunk;

    if (capture.head.length < STDERR_HEAD_CHARS) {
        const room = STDERR_HEAD_CHARS - capture.head.length;
        capture.head += rest.slice(0, room);
        rest = rest.slice(room);
    }
    if (rest.length === 0) return;

    capture.tail += rest;
    if (capture.tail.length > STDERR_TAIL_CHARS) {
        capture.trimmedChars += capture.tail.length - STDERR_TAIL_CHARS;
        capture.tail = capture.tail.slice(-STDERR_TAIL_CHARS);
    }
}

/**
 * Render the capture. When nothing was dropped this is byte-identical to the raw
 * stderr; otherwise the gap is made explicit so nobody reads the two halves as
 * contiguous output.
 */
export function renderStderr(capture: StderrCapture): string {
    if (capture.trimmedChars === 0) return capture.head + capture.tail;
    return `${capture.head}\n[... ${capture.trimmedChars} chars trimmed ...]\n${capture.tail}`;
}

/**
 * FFmpeg Process Runner — hybrid EventEmitter for broadcast + per-process callbacks.
 *
 * Broadcast events (progress, stderr) use the EventEmitter for internal tracking.
 * Lifecycle events (exit, error, masterPlaylistCheck) use per-process callbacks
 * passed to spawnFFmpeg() to prevent cross-job and stale-exit races.
 */
export class FFmpegProcessRunnerEvents extends EventEmitter {
    // Override EventEmitter methods with type-safe versions
    on<K extends keyof FFmpegProcessEvents>(event: K, listener: FFmpegProcessEvents[K]): this {
        const safeListener = listener as (...args: Parameters<FFmpegProcessEvents[K]>) => void;
        return super.on(event, safeListener);
    }

    once<K extends keyof FFmpegProcessEvents>(event: K, listener: FFmpegProcessEvents[K]): this {
        const safeListener = listener as (...args: Parameters<FFmpegProcessEvents[K]>) => void;
        return super.once(event, safeListener);
    }

    emit<K extends keyof FFmpegProcessEvents>(
        event: K,
        ...args: Parameters<FFmpegProcessEvents[K]>
    ): boolean {
        return super.emit(event, ...args);
    }

    /**
     * Spawn an FFmpeg process and invoke per-process lifecycle callbacks.
     *
     * @param job The transcode job (will be modified: job.process, job.segmentsReady)
     * @param args FFmpeg command-line arguments
     * @param callbacks Per-process lifecycle callbacks (exit, error, masterPlaylistCheck)
     * @throws Error if FFmpeg fails to start or errors immediately
     */
    async spawnFFmpeg(
        job: TranscodeJob,
        args: string[],
        callbacks: ProcessLifecycleCallbacks,
    ): Promise<void> {
        const startTime = Date.now();

        // Log job info
        const sourceCodec = job.config.videoInfo?.codec?.toLowerCase() || 'unknown';
        const outputCodec = job.config.videoInfo?.outputCodec?.toLowerCase() || sourceCodec;

        logger.info('Starting FFmpeg audio demux', {
            jobId: job.id,
            playSessionId: job.config.playSessionId,
            itemId: job.config.itemId,
            audioTracks: job.config.audioTracks.length,
            sourceCodec,
            outputCodec,
            resolution: job.config.videoInfo
                ? `${job.config.videoInfo.width}x${job.config.videoInfo.height}`
                : 'unknown',
        });

        try {
            // Spawn FFmpeg process
            const ffmpeg = spawn(config.FFMPEG_PATH, args, {
                cwd: job.outputDir,
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            job.process = ffmpeg;
            job.status = 'running';

            // Stderr capture for error diagnosis — head + tail, see createStderrCapture().
            const stderrCapture = createStderrCapture();
            let errorHandled = false;
            // Captures a genuine async spawn failure (ENOENT/EACCES/EMFILE) delivered
            // via the 'error' event so the post-spawn check can rethrow it. Such a
            // failure sets neither exitCode nor killed, so without this the promise
            // would resolve and the caller would treat a never-started process as a
            // successful spawn.
            let spawnError: Error | null = null;
            // The exit callback already replaced this process (see onExit's
            // return value); an early exit is then no failed start.
            let exitRecovered = false;
            let replacement: Promise<unknown> | undefined;

            // Monitor stderr for progress and errors
            ffmpeg.stderr?.on('data', (data: Buffer) => {
                const output = data.toString();
                appendStderr(stderrCapture, output);

                // Emit raw stderr for logging/debugging
                this.emit('stderr', output);

                // Parse progress: "time=00:01:30.00" means 90 seconds transcoded
                const fpsMatch = output.match(/fps=\s*([0-9.]+)/);

                // Last match, not first: one chunk can carry several progress
                // lines, and the newest is the one that counts. FFmpeg prints
                // speed with %4.3g, so >=1000x arrives as `1.2e+03x`.
                const speedMatches = [...output.matchAll(/speed=\s*([0-9.]+(?:e[+-]?\d+)?)x/g)];
                const lastSpeed = speedMatches.at(-1);

                // FFmpeg's fps=/speed= average over the whole run, pauses
                // included; past the first few seconds the rates come from
                // time=/frame= deltas instead (see live-rates.ts).
                const lastTime = [...output.matchAll(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/g)].at(
                    -1,
                );
                const lastFrame = [...output.matchAll(/frame=\s*(\d+)/g)].at(-1);
                const fallback = {
                    fps: fpsMatch ? parseFloat(fpsMatch[1]) : undefined,
                    speed: lastSpeed ? parseFloat(lastSpeed[1]) : undefined,
                };
                if (lastTime) {
                    updateLiveRates(
                        job,
                        {
                            mediaSeconds:
                                parseInt(lastTime[1], 10) * 3600 +
                                parseInt(lastTime[2], 10) * 60 +
                                parseFloat(lastTime[3]),
                            frames: lastFrame ? parseInt(lastFrame[1], 10) : undefined,
                        },
                        Date.now(),
                        fallback,
                    );
                } else if (!job.rateSample?.measured) {
                    if (fallback.fps !== undefined) job.transcodeFps = fallback.fps;
                    if (fallback.speed !== undefined) job.transcodeSpeed = fallback.speed;
                }
                if (job.slowTranscode && job.transcodeSpeed !== undefined && lastTime) {
                    const flip = observeSpeed(job.slowTranscode, job.transcodeSpeed, Date.now());
                    if (flip) {
                        const decision = job.transcodeDecisionResult;
                        logger.info(
                            flip === 'slow'
                                ? 'Transcode slower than real time — the player says the encoder is busy or too slow'
                                : 'Transcode keeps up with real time again',
                            {
                                jobId: job.id,
                                playSessionId: job.config.playSessionId,
                                speed: Math.round(job.transcodeSpeed * 100) / 100,
                                encoder: decision?.useGpu ? decision.gpuEncoder : 'software',
                                softwareFallbackFrom: job.config.softwareEncodeFallback,
                            },
                        );
                    }
                }

                const timeMatch = output.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
                if (timeMatch) {
                    const hours = parseInt(timeMatch[1], 10);
                    const minutes = parseInt(timeMatch[2], 10);
                    const seconds = parseFloat(timeMatch[3]);
                    const totalSeconds = hours * 3600 + minutes * 60 + seconds;

                    // Calculate segments ready using the job's segment duration
                    const segmentDuration = job.segmentDurationSeconds || 6;
                    const segmentsReady = Math.floor(totalSeconds / segmentDuration);

                    if (isGopModeJob(job)) {
                        // GOP mode: segmentsReady counts ASSEMBLED grid entries and
                        // is owned by the assembler. FFmpeg's clock still proves the
                        // process is alive, for the stall watchdog.
                        if (totalSeconds > (job.gopLastFfmpegSeconds ?? -1)) {
                            job.gopLastFfmpegSeconds = totalSeconds;
                            job.lastProgressAt = new Date();
                        }
                    } else if (segmentsReady > job.segmentsReady) {
                        job.segmentsReady = segmentsReady;
                        job.lastProgressAt = new Date();

                        // Emit progress event
                        this.emit('progress', segmentsReady);

                        // Log progress every 10 seconds
                        const elapsed = Date.now() - startTime;
                        if (elapsed > 10000 && segmentsReady % 10 === 0) {
                            logger.debug('FFmpeg progress', {
                                jobId: job.id,
                                segmentsReady,
                                elapsedMs: elapsed,
                            });
                        }
                    }
                }

                // Check for master playlist creation
                if (!job.masterPlaylistReady && !errorHandled) {
                    callbacks.onMasterPlaylistCheck();
                }

                // Detect common errors in stderr
                if (output.includes('Invalid data found') || output.includes('No such file')) {
                    logger.warn('FFmpeg stderr indicates potential error', {
                        jobId: job.id,
                        snippet: output.slice(0, 200),
                    });
                }
            });

            // Handle process exit
            ffmpeg.on('exit', (code: number | null, signal: string | null) => {
                if (errorHandled) return;

                errorHandled = true; // Prevent error event from firing after exit

                // Detect caught-SIGTERM from the whole retained capture, not just a
                // short tail — verbose 4K codec shutdown stats routinely push
                // "signal 15" out of a small tail, which would misclassify a clean
                // shutdown as a crash.
                const stderrBuffer = renderStderr(stderrCapture);
                const receivedSigterm = stderrBuffer.includes('signal 15');

                logger.info('FFmpeg process exited', {
                    jobId: job.id,
                    code,
                    signal,
                    receivedSigterm,
                    segmentsReady: job.segmentsReady,
                });

                // Invoke per-process exit callback with the retained head + tail for
                // error diagnosis. The HEAD is what keeps the decode-fallback
                // signature line intact for the GPU learn-on-failure classifier.
                const recovery = callbacks.onExit(code, signal, stderrBuffer, receivedSigterm);
                if (recovery instanceof Promise) replacement = recovery;
                exitRecovered = recovery === true || replacement !== undefined;

                // Only null out process if this is still the current process
                // (handles case where seek replaces the process)
                if (job.process === ffmpeg) {
                    job.process = null;
                }
            });

            // Handle process errors (ENOENT, etc.)
            ffmpeg.on('error', (error: Error) => {
                if (errorHandled) return;

                logger.error('FFmpeg process error', error, {
                    jobId: job.id,
                });

                job.status = 'error';
                job.error = `Failed to spawn FFmpeg: ${error.message}`;
                spawnError = error;

                errorHandled = true;
                callbacks.onError(error);
            });

            // Wait briefly to ensure process started successfully
            await new Promise((resolve) => setTimeout(resolve, 500));

            // A genuine async spawn failure surfaced via the 'error' event above:
            // rethrow so callers (startJob / seekToSegment) don't mistake a process
            // that never started for a running one.
            if (spawnError) {
                throw spawnError;
            }
            if (exitRecovered) {
                // The replacement handles its own failure (the respawn's catch).
                await replacement?.catch(() => undefined);
                return;
            }

            // If process died immediately with a non-zero code (or was killed), that's
            // a genuine failed start (bad args, missing input, etc) — throw. A clean
            // exit 0 by this point is NOT a failure: a short remux/copy job (e.g. one
            // media_files.duration_seconds shorter than the job's expected runtime, or
            // just a small fast-to-copy file) can legitimately finish before this
            // 500ms check runs. The 'exit' handler above already ran callbacks.onExit
            // and recorded the completion; treating that as "died immediately" here
            // discarded a successful job and reported it as a startup failure.
            if (ffmpeg.killed || (ffmpeg.exitCode !== null && ffmpeg.exitCode !== 0)) {
                throw new Error(
                    `FFmpeg process died immediately with exit code ${ffmpeg.exitCode}`,
                );
            }
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            // Don't clobber an in-flight intentional teardown.  stopJob() or
            // retireJobGeneration() may have set status='stopping' BEFORE we
            // reached this catch (narrow race during the 500ms spawn wait);
            // treating that as 'error' would publish a spurious overlay for
            // a session the user has already asked to end.
            if (job.status !== 'stopping') {
                job.status = 'error';
                job.error = `Failed to spawn FFmpeg: ${error.message}`;
            }
            throw error;
        }
    }

    /**
     * Gracefully kill an FFmpeg process.
     *
     * Sends SIGTERM first, waits for graceful exit, then sends SIGKILL if needed.
     * FFmpeg handles SIGTERM by finishing the current segment cleanly.
     *
     * @param processOrJob Either the FFmpeg child process directly, or a
     *   TranscodeJob whose `.process` will be killed. Passing the job lets
     *   us record `killEscalated=true` when SIGTERM is promoted to SIGKILL,
     *   so the handleExit signal branch can distinguish our fallback from
     *   kernel OOM / external SIGKILL.
     * @param forceKillTimeout Milliseconds to wait before force kill (default: 5000)
     * @param waitForExit If true, waits briefly before force killing (for immediate stop)
     */
    async killFFmpeg(
        processOrJob: ChildProcess | TranscodeJob | null,
        forceKillTimeout: number = 5000,
        waitForExit: boolean = false,
    ): Promise<void> {
        let job: TranscodeJob | null = null;
        let process: ChildProcess | null;
        if (processOrJob && 'config' in processOrJob) {
            job = processOrJob;
            process = processOrJob.process;
        } else {
            process = processOrJob;
        }

        if (!process) {
            return;
        }

        // `process.killed` only means a signal was SENT, not that the child has
        // terminated. Actual death is exitCode/signalCode being set. This matters
        // for two reasons: (1) our own SIGTERM below sets `killed=true`, so keying
        // the graceful-wait off `killed` would make it return instantly and skip
        // the SIGKILL escalation entirely; (2) a concurrent teardown may have
        // already signaled this process — we must still WAIT for real exit before
        // returning, or the caller will delete the output directory out from under
        // a live process mid-flush.
        const hasExited = (p: ChildProcess): boolean =>
            p.exitCode !== null || p.signalCode !== null;

        if (hasExited(process)) {
            return;
        }

        logger.debug('Killing FFmpeg process', {
            pid: process.pid,
            forceKillTimeout,
            waitForExit,
            alreadySignaled: process.killed,
        });

        const waitForProcessExit = async (timeoutMs: number): Promise<boolean> => {
            if (hasExited(process)) return true;
            return await new Promise<boolean>((resolve) => {
                const timeout = setTimeout(() => {
                    cleanup();
                    resolve(false);
                }, timeoutMs);
                const onExit = () => {
                    cleanup();
                    resolve(true);
                };
                const cleanup = () => {
                    clearTimeout(timeout);
                    process.off('exit', onExit);
                };
                process.once('exit', onExit);
            });
        };

        const escalateToSigkill = (reason: string): void => {
            logger.warn(reason, {
                pid: process.pid,
                timeoutMs: forceKillTimeout,
            });
            if (job) job.killEscalated = true;
            try {
                process.kill('SIGKILL');
            } catch {
                /* process may have exited between the wait and here — harmless */
            }
        };

        // Send SIGTERM for graceful shutdown (idempotent if already signaled by a
        // concurrent teardown). Guarded: kill() on an already-dead pid can throw.
        //
        // Stamp the job BEFORE signalling. FFmpeg answers SIGTERM by flushing the
        // current segment and exiting 255 *with no signal* — handleExit would
        // otherwise see a plain non-zero exit and record a playback failure for a
        // stop we ourselves requested. Set before, not after, because the exit can
        // land inside kill() (see waitForProcessExit below).
        if (job) job.killRequested = true;
        // A process the transcode throttle stopped (SIGSTOP) only acts on SIGTERM
        // once it is continued; without this every stop of a throttled job would
        // wait out the grace period and end in SIGKILL.
        if (job?.throttledAt) {
            job.throttledAt = undefined;
            try {
                process.kill('SIGCONT');
            } catch {
                /* already gone */
            }
        }
        try {
            process.kill('SIGTERM');
        } catch {
            /* already gone */
        }

        const gracePeriod = waitForExit ? 500 : forceKillTimeout;
        const exitedGracefully = await waitForProcessExit(gracePeriod);
        if (!exitedGracefully && !hasExited(process)) {
            escalateToSigkill(
                waitForExit
                    ? 'Force killing FFmpeg process (SIGKILL)'
                    : 'FFmpeg did not exit gracefully, force killing (SIGKILL)',
            );
            const confirmedDead = await waitForProcessExit(1000);
            if (!confirmedDead && !hasExited(process)) {
                // SIGKILL can be delayed indefinitely when the process is blocked in
                // uninterruptible I/O (e.g. an NFS read of the source file). Surface
                // it — a caller that then deletes the output dir would race a still-
                // live process.
                logger.error('FFmpeg process still alive after SIGKILL wait', undefined, {
                    pid: process.pid,
                });
            }
        }
    }
}
