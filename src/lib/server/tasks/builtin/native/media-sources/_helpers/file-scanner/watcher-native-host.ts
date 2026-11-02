// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { Logger } from '../../../../../../utils/logger.js';
import {
    NATIVE_WATCHER_ALIVE_MS,
    NATIVE_WATCHER_LIVENESS_FACTOR,
    NATIVE_WATCHER_MAX_LINE_BYTES,
    NATIVE_WATCHER_PROTOCOL_VERSION,
    nativeWatcherVersionOutputCompatible,
    parseNativeWatcherMessage,
    type NativeWatcherErrorCode,
    type NativeWatcherInit,
    type NativeWatcherMessage,
    type NativeWatcherPolicyV2,
    type NativeWatcherStatus,
} from './watcher-native-protocol.js';

type ErrnoError = Error & { code?: string };
const logger = Logger.for('NativeWatcherHost');
const execFileAsync = promisify(execFile);

const STDERR_TAIL_BYTES = 8192;
const STDERR_MAX_LINE_CHARS = 4096;
const STDERR_WINDOW_MS = 10_000;
const STDERR_MAX_LINES_PER_WINDOW = 20;

const DEFAULT_RESTART_INITIAL_MS = 1000;
const DEFAULT_RESTART_MAX_MS = 5 * 60_000;
const DEFAULT_STABLE_RESET_MS = 10 * 60_000;
const QUARANTINE_POLL_MS = 5000;
const WATCH_LIMIT_EXIT_WINDOW_MS = 10_000;
const DEFAULT_RESCAN_MIN_INTERVAL_MS = 60_000;

// A SIGKILL cannot finish a process blocked in an uninterruptible filesystem syscall.
// Quarantined handles are kept so repeated leadership retries cannot accumulate such children;
// no launch happens while any of them is still alive.
const quarantinedChildren = new Set<ChildProcessWithoutNullStreams>();
const quarantineListeners = new Set<() => void>();
const closedChildren = new WeakSet<ChildProcessWithoutNullStreams>();

/**
 * A quarantined child counts as alive until its handle closes or Node saw it exit. ESRCH means
 * the pid is gone; EPERM means the pid now belongs to someone else (reuse), so the answer comes
 * from the handle's own exit state instead of treating it as alive forever.
 */
function quarantinedChildAlive(child: ChildProcessWithoutNullStreams): boolean {
    if (closedChildren.has(child) || child.exitCode !== null || child.signalCode !== null)
        return false;
    if (child.pid === undefined) return true;
    try {
        process.kill(child.pid, 0);
        return true;
    } catch (error) {
        const code = (error as ErrnoError).code;
        return code === 'EPERM' ? child.exitCode === null && child.signalCode === null : false;
    }
}

function pruneQuarantine(): void {
    if (quarantinedChildren.size === 0) return;
    for (const child of [...quarantinedChildren])
        if (!quarantinedChildAlive(child)) quarantinedChildren.delete(child);
    if (quarantinedChildren.size === 0) for (const listener of [...quarantineListeners]) listener();
}

/** True while any previous child is verifiably still alive after SIGKILL. */
export function nativeWatcherQuarantined(): boolean {
    pruneQuarantine();
    return quarantinedChildren.size > 0;
}

/** Resolves once no quarantined child remains (its handle closed or its pid vanished). */
export function waitForNativeWatcherQuarantineRelease(pollMs = QUARANTINE_POLL_MS): Promise<void> {
    if (!nativeWatcherQuarantined()) return Promise.resolve();
    return new Promise<void>((resolveRelease) => {
        const timer = setInterval(() => {
            pruneQuarantine();
        }, pollMs);
        timer.unref();
        const listener = (): void => {
            clearInterval(timer);
            quarantineListeners.delete(listener);
            resolveRelease();
        };
        quarantineListeners.add(listener);
    });
}

export interface NativeWatcherErrorInfo {
    message: string;
    fatal: boolean;
    code?: NativeWatcherErrorCode;
}

export interface NativeWatcherOptions {
    paths: string[];
    /** Subset of `paths` on network filesystems; sent in init. */
    networkPaths?: string[];
    /** 0 disables; otherwise 60..86400. Default 900. */
    networkReconcileSecs?: number;
    /** Built by the caller (`buildNativeWatcherPolicy`) so the scanner and child share one source. */
    policy: NativeWatcherPolicyV2;
    onEvent(event: 'add' | 'change' | 'unlink', path: string): void;
    onError(info: NativeWatcherErrorInfo): void;
    onReady(): void;
    onRescan(reason: string): void;
    onStatus?(status: NativeWatcherStatus): void;
    /** Called when a restart has been scheduled after a child failure. */
    onRestart?(): void;
    binaryPath?: string;
    /** Inject a real subprocess in lifecycle tests; production always executes the native binary. */
    spawn?: (binary: string) => ChildProcessWithoutNullStreams;
    /** First restart delay; doubles per consecutive failure up to `restartMaxDelayMs`. */
    restartInitialDelayMs?: number;
    restartMaxDelayMs?: number;
    /** Give up (fatal) after this many consecutive restarts. Default: never. */
    maxRestarts?: number;
    /** Backoff and rescan debounce reset after the child has been ready this long. */
    stableResetMs?: number;
    startupTimeoutMs?: number;
    shutdownGraceMs?: number;
    shutdownKillMs?: number;
    /** Deadline for completing a started stdout frame; idle watchers need no heartbeat. */
    outputFrameTimeoutMs?: number;
    /** Child `alive` period sent in init. No frame for 3x this after ready means wedged. */
    aliveMs?: number;
    /** Test seam: silence tolerated after ready. Default 3 x aliveMs. */
    livenessTimeoutMs?: number;
    /** Minimum spacing of outage-recovery rescans (trailing edge). Default 60 s. */
    rescanMinIntervalMs?: number;
}

const SPAWN_ERRORS: Readonly<Record<string, string>> = {
    ENOENT: 'the binary does not exist',
    EACCES: 'the binary is not executable by this user',
    ENOEXEC: 'the binary has the wrong format or architecture',
    ENOSPC: 'the system is out of space or process resources',
};

function resolveBinary(explicit?: string): string {
    return (
        explicit ??
        process.env.LUMASTRA_WATCHER_BINARY ??
        join(process.cwd(), 'build/lumastra-watcher')
    );
}

function spawnFailureMessage(code: string, binary: string, original: string): string {
    return `Native watcher binary cannot be started (${code}: ${SPAWN_ERRORS[code]}): ${binary}. Run npm run build:watcher or set LUMASTRA_WATCHER_BINARY to a protocol ${String(NATIVE_WATCHER_PROTOCOL_VERSION)} build. (${original})`;
}

const verifiedBinaries = new Set<string>();

/**
 * Runs `<binary> --version` once per binary and requires "protocol 2". A failure is a fatal
 * operator error: the leader must not report a healthy watcher for a binary that cannot speak
 * the bridge protocol.
 */
export async function verifyNativeWatcherBinary(binaryPath?: string): Promise<void> {
    const binary = resolveBinary(binaryPath);
    if (verifiedBinaries.has(binary)) return;
    let stdout: string;
    try {
        ({ stdout } = await execFileAsync(binary, ['--version'], {
            timeout: 10_000,
            maxBuffer: 64 * 1024,
            env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
        }));
    } catch (error) {
        const code = (error as ErrnoError).code;
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
            typeof code === 'string' && code in SPAWN_ERRORS
                ? spawnFailureMessage(code, binary, detail)
                : `Native watcher binary failed its --version preflight: ${binary} (${detail})`,
            { cause: error },
        );
    }
    if (!nativeWatcherVersionOutputCompatible(stdout)) {
        throw new Error(
            `Native watcher binary ${binary} does not speak protocol ${String(NATIVE_WATCHER_PROTOCOL_VERSION)} (--version said: ${stdout.trim().slice(0, 200)}). Rebuild it from native/watcher.`,
        );
    }
    verifiedBinaries.add(binary);
}

/** Streams child stderr to the logger line by line with a rate limit; keeps the last 8 KiB. */
class StderrRelay {
    private tail: Buffer = Buffer.alloc(0);
    private partial = '';
    private readonly decoder = new StringDecoder('utf8');
    private windowStart = 0;
    private emitted = 0;
    private suppressed = 0;

    push(chunk: Buffer): void {
        this.tail = Buffer.concat([this.tail, chunk]).subarray(-STDERR_TAIL_BYTES);
        this.partial += this.decoder.write(chunk);
        let newline: number;
        while ((newline = this.partial.indexOf('\n')) !== -1) {
            this.line(this.partial.slice(0, newline));
            this.partial = this.partial.slice(newline + 1);
        }
        if (this.partial.length > STDERR_MAX_LINE_CHARS) {
            this.line(this.partial.slice(0, STDERR_MAX_LINE_CHARS));
            this.partial = '';
        }
    }

    flush(): void {
        this.partial += this.decoder.end();
        if (this.partial) this.line(this.partial);
        this.partial = '';
        this.reportSuppressed();
    }

    tailText(): string {
        return this.tail.toString('utf8');
    }

    private reportSuppressed(): void {
        if (this.suppressed > 0) {
            logger.warn(`Native watcher stderr: suppressed ${String(this.suppressed)} lines`);
            this.suppressed = 0;
        }
    }

    private line(raw: string): void {
        const text = raw.replace(/\r$/, '');
        if (text.trim() === '') return;
        const now = Date.now();
        if (now - this.windowStart >= STDERR_WINDOW_MS) {
            this.reportSuppressed();
            this.windowStart = now;
            this.emitted = 0;
        }
        if (this.emitted < STDERR_MAX_LINES_PER_WINDOW) {
            this.emitted++;
            logger.warn('Native watcher stderr', { line: text });
        } else this.suppressed++;
    }
}

/** Native filesystem-only child. Leadership and ingestion remain in WatcherLeader. */
export class NativeWatcherProcess {
    private child: ChildProcessWithoutNullStreams | null = null;
    private restartTimer: ReturnType<typeof setTimeout> | null = null;
    private startupTimer: ReturnType<typeof setTimeout> | null = null;
    private frameTimer: ReturnType<typeof setTimeout> | null = null;
    private exitTimer: ReturnType<typeof setTimeout> | null = null;
    private livenessTimer: ReturnType<typeof setTimeout> | null = null;
    private termination: { child: ChildProcessWithoutNullStreams; promise: Promise<void> } | null =
        null;
    private stableTimer: ReturnType<typeof setTimeout> | null = null;
    private started = false;
    private closed = false;
    private attempts = 0;
    private totalRestarts = 0;
    private fatal = false;
    // An outage (child lost after observing) needs one rescan once observation is back.
    private outagePending = false;
    private lastOutageRescanAt = -Infinity;
    private rescanTimer: ReturnType<typeof setTimeout> | null = null;
    private closing: Promise<void> | null = null;
    private readonly roots: string[];
    private readonly networkRoots: string[];

    constructor(private readonly opts: NativeWatcherOptions) {
        this.roots = opts.paths.map((path) => resolve(path));
        const network = new Set((opts.networkPaths ?? []).map((path) => resolve(path)));
        this.networkRoots = this.roots.filter((root) => network.has(root));
    }

    /** PID of the running native child, for per-child memory accounting. */
    get pid(): number | undefined {
        return this.child?.pid;
    }

    /** Restarts scheduled over this instance's lifetime (never reset by the stability window). */
    get restartCount(): number {
        return this.totalRestarts;
    }

    start(): void {
        if (this.started || this.closed) return;
        this.started = true;
        this.launch();
    }

    /** Handler exceptions are application bugs, not protocol corruption: log and continue. */
    private notify(label: string, fn: () => void): void {
        try {
            fn();
        } catch (error) {
            logger.warn(
                `Native watcher ${label} handler threw; continuing`,
                {},
                error instanceof Error ? error : new Error(String(error)),
            );
        }
    }

    private launch(): void {
        if (this.closed || this.fatal) return;
        if (nativeWatcherQuarantined()) {
            this.fail(
                'Previous native watcher is still stuck after SIGKILL; refusing an overlapping child',
                true,
            );
            return;
        }
        const binary = resolveBinary(this.opts.binaryPath);
        let child: ChildProcessWithoutNullStreams;
        try {
            child =
                this.opts.spawn?.(binary) ??
                spawn(binary, [], {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    // Environment minimization only: the child still shares the container user
                    // and filesystem permissions. This is not a security sandbox.
                    env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
                });
        } catch (error) {
            const code = (error as ErrnoError).code;
            const original = error instanceof Error ? error.message : String(error);
            if (typeof code === 'string' && code in SPAWN_ERRORS)
                this.fail(spawnFailureMessage(code, binary, original), true);
            else this.fail(original, true);
            return;
        }
        this.child = child;
        const aliveMs = this.opts.aliveMs ?? NATIVE_WATCHER_ALIVE_MS;
        const livenessMs = this.opts.livenessTimeoutMs ?? aliveMs * NATIVE_WATCHER_LIVENESS_FACTOR;
        let buffer: Buffer = Buffer.alloc(0);
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const stderr = new StderrRelay();
        let ready = false;
        let watchLimit = false;
        let watchLimitAt = 0;
        let reported = false;
        let fault: string | null = null;
        let nonRetryable = false;
        let spawnFailed = false;
        // The first report per child wins: close, termination failure and deadlines race.
        const reportFail = (message: string, terminal: boolean, unobserved = false): void => {
            if (reported) return;
            reported = true;
            this.fail(message, terminal, unobserved);
        };
        const corrupt = (message: string, terminal = false): void => {
            // After close() there is nothing left to terminate; close() owns the child.
            if (fault !== null || this.closed || closedChildren.has(child)) return;
            fault = message;
            nonRetryable = terminal;
            this.clearObservationTimers();
            void this.terminateChild(child, false).catch((error: unknown) => {
                reportFail(error instanceof Error ? error.message : String(error), true);
            });
        };
        const armLiveness = (): void => {
            if (this.livenessTimer) clearTimeout(this.livenessTimer);
            this.livenessTimer = setTimeout(() => {
                this.livenessTimer = null;
                corrupt(
                    `Native watcher sent no frame for ${String(livenessMs)} ms ${ready ? 'after' : 'before'} ready; treating it as wedged`,
                );
            }, livenessMs);
            this.livenessTimer.unref();
        };
        // Generous overall deadline for the initial walk; retryable with backoff. Progress is
        // judged by frames: the child sends `alive` during the walk, so silence before ready
        // is caught by the same 3 x aliveMs liveness rule as after ready.
        this.startupTimer = setTimeout(
            () => {
                this.startupTimer = null;
                corrupt('Native watcher readiness deadline exceeded');
            },
            this.opts.startupTimeoutMs ?? 10 * 60_000,
        );
        this.startupTimer.unref();
        armLiveness();
        child.stdout.on('data', (chunk: Buffer) => {
            if (this.closed || fault !== null) return;
            // Only the incomplete frame is retained, bounded independently of pipe chunk size.
            let offset = 0;
            while (offset < chunk.length && !this.closed && fault === null) {
                const newline = chunk.indexOf(10, offset);
                const end = newline === -1 ? chunk.length : newline;
                if (buffer.length + end - offset + 1 > NATIVE_WATCHER_MAX_LINE_BYTES) {
                    corrupt('Native watcher output frame exceeded 1 MiB');
                    return;
                }
                buffer = Buffer.concat([buffer, chunk.subarray(offset, end)]);
                if (newline === -1) {
                    if (!this.frameTimer) {
                        this.frameTimer = setTimeout(() => {
                            this.frameTimer = null;
                            corrupt('Native watcher output frame deadline exceeded', true);
                        }, this.opts.outputFrameTimeoutMs ?? 30_000);
                        this.frameTimer.unref();
                    }
                    break;
                }
                if (this.frameTimer) clearTimeout(this.frameTimer);
                this.frameTimer = null;
                let message: NativeWatcherMessage;
                try {
                    message = parseNativeWatcherMessage(decoder.decode(buffer));
                    buffer = Buffer.alloc(0);
                    if (message.type === 'ready' && ready)
                        throw new Error('Native watcher sent duplicate ready');
                    const eventPath = message.type === 'event' ? message.path : '';
                    if (
                        message.type === 'event' &&
                        (!ready ||
                            !isAbsolute(eventPath) ||
                            !this.roots.some((root) => {
                                const rel = relative(root, eventPath);
                                return (
                                    rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
                                );
                            }))
                    )
                        throw new Error(
                            'Native watcher event outside initialized roots or before ready',
                        );
                } catch (error) {
                    corrupt(error instanceof Error ? error.message : String(error), true);
                    return;
                }
                armLiveness();
                if (message.type === 'ready') {
                    ready = true;
                    if (this.startupTimer) clearTimeout(this.startupTimer);
                    this.startupTimer = null;
                    if (this.outagePending) {
                        this.outagePending = false;
                        this.requestOutageRescan();
                    }
                    this.stableTimer = setTimeout(() => {
                        this.attempts = 0;
                    }, this.opts.stableResetMs ?? DEFAULT_STABLE_RESET_MS);
                    this.stableTimer.unref();
                    this.notify('ready', () => {
                        this.opts.onReady();
                    });
                } else if (message.type === 'event') {
                    const { event, path } = message;
                    this.notify('event', () => {
                        this.opts.onEvent(event, path);
                    });
                } else if (message.type === 'rescan') {
                    const { reason } = message;
                    this.notify('rescan', () => {
                        this.opts.onRescan(reason);
                    });
                } else if (message.type === 'status') {
                    const status: NativeWatcherStatus = {
                        coverage: message.coverage,
                        watchedDirs: message.watchedDirs,
                        failedDirs: message.failedDirs,
                        failedSample: message.failedSample,
                        watchLimit: message.watchLimit,
                        nonUtf8Skipped: message.nonUtf8Skipped,
                        refusedSymlinks: message.refusedSymlinks,
                        networkRoots: message.networkRoots,
                        stalledProbes: message.stalledProbes,
                        unwatchedDirs: message.unwatchedDirs,
                        stalledRoots: message.stalledRoots,
                    };
                    // Follows the child's own report in both directions: a later `false`
                    // means the limit condition cleared.
                    watchLimit = status.watchLimit;
                    if (watchLimit) watchLimitAt = Date.now();
                    this.notify('status', () => {
                        this.opts.onStatus?.(status);
                    });
                } else if (message.type === 'error') {
                    if (message.code === 'watch_limit') {
                        // Partial coverage, not a crash: keep the child, never restart-loop on it.
                        watchLimit = true;
                        watchLimitAt = Date.now();
                        this.notify('error', () => {
                            this.opts.onError({
                                message: message.message,
                                fatal: false,
                                code: 'watch_limit',
                            });
                        });
                    } else if (message.fatal) {
                        corrupt(message.message, true);
                        return;
                    } else {
                        const info: NativeWatcherErrorInfo = {
                            message: message.message,
                            fatal: false,
                            ...(message.code ? { code: message.code } : {}),
                        };
                        this.notify('error', () => {
                            this.opts.onError(info);
                        });
                    }
                }
                // `alive` carries no payload beyond resetting the liveness deadline above.
                offset = end + 1;
            }
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr.push(chunk);
        });
        child.stdout.once('end', () => {
            if (this.closed || fault !== null || this.frameTimer) return;
            // EOF without process exit is also observation loss. Normal exit clears this.
            this.frameTimer = setTimeout(() => {
                this.frameTimer = null;
                corrupt('Native watcher stdout ended without process exit', true);
            }, this.opts.outputFrameTimeoutMs ?? 30_000);
            this.frameTimer.unref();
        });
        child.stdout.on('error', (error: Error) => corrupt(error.message, true));
        child.stderr.on('error', (error: Error) => corrupt(error.message, true));
        child.once('exit', () => {
            // A descendant can inherit the pipes after the watched child is reaped.
            // Do not wait forever for its stdio before reporting loss/restarting.
            this.exitTimer = setTimeout(() => {
                this.exitTimer = null;
                fault ??= 'Native watcher output pipes remained open after exit';
                nonRetryable = true;
                child.stdin.destroy();
                child.stdout.destroy();
                child.stderr.destroy();
            }, this.opts.shutdownKillMs ?? 2000);
            this.exitTimer.unref();
        });
        child.on('error', (error: Error & { code?: string }) => {
            const code = error.code;
            if (typeof code === 'string' && code in SPAWN_ERRORS) {
                fault = spawnFailureMessage(code, binary, error.message);
                nonRetryable = true;
                spawnFailed = true;
            } else fault = error.message;
        });
        child.stdin.on('error', (error: Error) => {
            corrupt(error.message);
        });
        child.once('close', (code, signal) => {
            closedChildren.add(child);
            if (quarantinedChildren.has(child)) pruneQuarantine();
            if (this.child === child) this.child = null;
            this.clearObservationTimers();
            if (this.stableTimer) clearTimeout(this.stableTimer);
            this.stableTimer = null;
            stderr.flush();
            if (this.closed) return;
            const tail = stderr.tailText();
            const message =
                fault ??
                (buffer.length
                    ? 'Native watcher ended with an unterminated output frame'
                    : `Native watcher exited (code ${String(code)}, signal ${String(signal)})${tail.length ? `: ${tail}` : ''}`);
            // Only a child that exited by itself right after reporting the watch limit cannot do
            // better by restarting. Liveness kills, OOM kills (signal) and later crashes keep
            // the normal backoff.
            const limitExit =
                watchLimit &&
                fault === null &&
                signal === null &&
                code !== null &&
                Date.now() - watchLimitAt < WATCH_LIMIT_EXIT_WINDOW_MS;
            reportFail(
                limitExit
                    ? `${message} (inotify watch limit reached; raise fs.inotify.max_user_watches)`
                    : message,
                nonRetryable || limitExit,
                // A child that never started observed nothing; an earlier child's loss
                // already requested its own reconciliation.
                spawnFailed,
            );
        });
        const init: NativeWatcherInit = {
            type: 'init',
            version: 2,
            paths: this.roots,
            networkPaths: this.networkRoots,
            networkReconcileSecs: this.opts.networkReconcileSecs ?? 900,
            policy: this.opts.policy,
            stabilityMs: 500,
            pollMs: 100,
            aliveMs,
        };
        const frame = JSON.stringify(init) + '\n';
        if (Buffer.byteLength(frame) > NATIVE_WATCHER_MAX_LINE_BYTES) {
            corrupt('Native watcher initialization exceeded 1 MiB', true);
        } else child.stdin.write(frame);
    }

    private fail(message: string, nonRetryable: boolean, unobserved = false): void {
        if (this.closed || this.fatal) return;
        // Terminal faults also lose observation. Repeated restarts in one backoff episode
        // request a single rescan; the scan coalescer owns the rest of the deduplication.
        const terminal = nonRetryable || this.attempts >= (this.opts.maxRestarts ?? Infinity);
        if (!unobserved) {
            if (terminal) {
                // No ready will follow, so the lost observation is reported now.
                this.notify('rescan', () => {
                    this.opts.onRescan('native watcher observation interrupted');
                });
            } else this.outagePending = true;
        }
        if (terminal) {
            this.fatal = true;
            this.notify('error', () => {
                this.opts.onError({ message, fatal: true });
            });
            return;
        }
        this.notify('error', () => {
            this.opts.onError({ message, fatal: false });
        });
        const delay = Math.min(
            (this.opts.restartInitialDelayMs ?? DEFAULT_RESTART_INITIAL_MS) * 2 ** this.attempts,
            this.opts.restartMaxDelayMs ?? DEFAULT_RESTART_MAX_MS,
        );
        this.attempts++;
        this.totalRestarts++;
        this.notify('restart', () => {
            this.opts.onRestart?.();
        });
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            this.launch();
        }, delay);
        this.restartTimer.unref();
    }

    /** Rescan after an outage, at most one per interval; a burst collapses to a trailing one. */
    private requestOutageRescan(): void {
        const wait =
            this.lastOutageRescanAt +
            (this.opts.rescanMinIntervalMs ?? DEFAULT_RESCAN_MIN_INTERVAL_MS) -
            Date.now();
        const fire = (): void => {
            this.rescanTimer = null;
            if (this.closed) return;
            this.lastOutageRescanAt = Date.now();
            this.notify('rescan', () => {
                this.opts.onRescan('native watcher restarted');
            });
        };
        if (wait <= 0) fire();
        else if (!this.rescanTimer) {
            this.rescanTimer = setTimeout(fire, wait);
            this.rescanTimer.unref();
        }
    }

    private clearObservationTimers(): void {
        if (this.startupTimer) clearTimeout(this.startupTimer);
        if (this.frameTimer) clearTimeout(this.frameTimer);
        if (this.exitTimer) clearTimeout(this.exitTimer);
        if (this.livenessTimer) clearTimeout(this.livenessTimer);
        this.startupTimer = null;
        this.frameTimer = null;
        this.exitTimer = null;
        this.livenessTimer = null;
    }

    /** Resolve only after stdio closes and the child has been reaped. */
    private terminateChild(
        child: ChildProcessWithoutNullStreams,
        graceful: boolean,
    ): Promise<void> {
        // Already reaped and closed: a close listener registered now would never fire.
        if (closedChildren.has(child)) return Promise.resolve();
        if (this.termination?.child === child) return this.termination.promise;
        const promise = new Promise<void>((resolveClose, rejectClose) => {
            const timers: ReturnType<typeof setTimeout>[] = [];
            let finished = false;
            const finish = (): void => {
                if (finished) return;
                finished = true;
                for (const timer of timers) clearTimeout(timer);
                resolveClose();
            };
            child.once('close', finish);
            const deadline = (): void => {
                if (finished) return;
                finished = true;
                for (const timer of timers) clearTimeout(timer);
                child.removeListener('close', finish);
                // exitCode/signalCode prove reaping, not merely a successful kill() call.
                const unreaped = child.exitCode === null && child.signalCode === null;
                if (unreaped) quarantinedChildren.add(child);
                child.stdin.destroy();
                child.stdout.destroy();
                child.stderr.destroy();
                child.unref();
                const message = unreaped
                    ? 'Native watcher did not exit after SIGKILL; quarantining stuck process handle'
                    : 'Native watcher stdio did not close after process exit';
                rejectClose(new Error(message));
            };
            const kill = (): void => {
                child.kill('SIGKILL');
                timers.push(setTimeout(deadline, this.opts.shutdownKillMs ?? 2000));
            };
            if (graceful) {
                // EOF also requests shutdown if the child rejects the explicit close frame.
                child.stdin.end('{"type":"close"}\n');
                timers.push(
                    setTimeout(() => {
                        child.kill('SIGTERM');
                        timers.push(setTimeout(kill, this.opts.shutdownKillMs ?? 2000));
                    }, this.opts.shutdownGraceMs ?? 2000),
                );
            } else kill();
        });
        this.termination = { child, promise };
        return promise;
    }

    close(): Promise<void> {
        if (this.closing) return this.closing;
        this.closed = true;
        this.clearObservationTimers();
        if (this.restartTimer) clearTimeout(this.restartTimer);
        if (this.stableTimer) clearTimeout(this.stableTimer);
        if (this.rescanTimer) clearTimeout(this.rescanTimer);
        this.rescanTimer = null;
        this.restartTimer = null;
        this.stableTimer = null;
        const child = this.child;
        if (!child) return (this.closing = Promise.resolve());
        this.closing = this.terminateChild(child, true).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            this.notify('error', () => {
                this.opts.onError({ message, fatal: true });
            });
            throw error;
        });
        return this.closing;
    }
}
