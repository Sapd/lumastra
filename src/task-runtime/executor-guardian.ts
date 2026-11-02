// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Deliberately independent of application/plugin code. A blocked executor must
// never prevent controller-loss detection or process-group termination.
import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface StopResult {
    stopped: boolean;
    escalated: boolean;
}
interface Initialization {
    type: 'initialize_guardian';
    entry: string;
    env: Record<string, string>;
    /** The supervisor's tmpdir(): the guardian runs with an empty env, so its own
     * tmpdir() may differ (TMPDIR). */
    tmpBase: string;
    initialization: Record<string, unknown>;
    stopTimeoutMs: number;
    killTimeoutMs: number;
}
const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const validDeadline = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 300_000;
const STDERR_TAIL_BYTES = 8 * 1024;

/** The guardian removes only the private directory its supervisor created
 * (`mkdtemp(tmpdir()/lx-*)`, 0700, owned by this uid). A supplied path is never
 * trusted: anything else is refused, not deleted. */
export async function ownedExecutorDirectoryRefusal(
    directory: string,
    tmpBase: string,
): Promise<string | undefined> {
    if (!path.isAbsolute(tmpBase) || !path.isAbsolute(directory)) return 'path not absolute';
    const resolved = path.resolve(directory);
    try {
        // Compare real locations so a symlinked tmp root (macOS /var) still matches.
        if ((await realpath(path.dirname(resolved))) !== (await realpath(tmpBase)))
            return 'not directly under the expected temp directory';
    } catch {
        return 'temp directory not inspectable';
    }
    if (!path.basename(resolved).startsWith('lx-')) return 'unexpected directory name';
    let info;
    try {
        info = await lstat(resolved);
    } catch (error) {
        return error instanceof Error && 'code' in error && error.code === 'ENOENT'
            ? undefined
            : 'directory not inspectable';
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return 'not a real directory';
    if (info.uid !== process.getuid?.()) return 'not owned by current user';
    if ((info.mode & 0o777) !== 0o700) return 'not mode 0700';
    return undefined;
}
const delay = async (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

function validInitialization(value: unknown): value is Initialization {
    return (
        record(value) &&
        value.type === 'initialize_guardian' &&
        typeof value.entry === 'string' &&
        record(value.env) &&
        typeof value.tmpBase === 'string' &&
        value.tmpBase.length <= 4096 &&
        path.isAbsolute(value.tmpBase) &&
        Object.values(value.env).every((entry) => typeof entry === 'string') &&
        record(value.initialization) &&
        typeof value.initialization.directory === 'string' &&
        validDeadline(value.stopTimeoutMs) &&
        validDeadline(value.killTimeoutMs) &&
        Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024
    );
}

export interface GuardianSystem {
    sendSignal?: (pid: number, signal: 'SIGTERM' | 'SIGKILL' | 0) => boolean;
}

export function runExecutorGuardian(system: GuardianSystem = {}): void {
    const sendSignal =
        system.sendSignal ??
        ((target: number, name: 'SIGTERM' | 'SIGKILL' | 0): boolean => process.kill(target, name));
    if (process.argv.includes('--check-imports')) return;
    if (!process.send || !process.connected || process.platform === 'win32') process.exit(1);
    let child: ChildProcess | undefined;
    let pid: number | undefined;
    let childExited = false;
    let spawnConfirmed = false;
    let hardRequested = false;
    let hardSignaled = false;
    let hardAttempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let lastResult: StopResult | undefined;
    let groupAbsent = false;
    let options: Initialization | undefined;
    let stopping: Promise<StopResult> | undefined;
    let initialized = false;
    let controllerGone = false;
    let closed = false;
    // Preserve an uncertain guardian even after its controller has gone. It may
    // observe disappearance later, but never claim quiescence from an EPERM.
    const keeper = setInterval(() => {
        if (lastResult && !lastResult.stopped && childExited && !groupAlive()) {
            lastResult = { stopped: true, escalated: hardRequested };
            void reportStopped(lastResult).then(finish);
        }
    }, 1000);
    const initializationTimer = setTimeout(() => {
        void stop(true);
    }, 10_000);
    const send = (message: Record<string, unknown>): void => {
        if (!process.connected || controllerGone) return;
        process.send?.(message, () => {
            /* Lost acknowledgement never proves teardown. */
        });
    };
    const groupAlive = (): boolean => {
        if (groupAbsent) return false;
        if (child && !spawnConfirmed) return !childExited;
        if (!pid) return child !== undefined && !childExited;
        try {
            sendSignal(-pid, 0);
            return true;
        } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
                groupAbsent = true; // Never signal this numeric group after disappearance.
                return false;
            }
            return true;
        }
    };
    const signal = (name: 'SIGTERM' | 'SIGKILL'): boolean => {
        if (groupAbsent) return true;
        if (!pid || !spawnConfirmed) return false;
        try {
            return sendSignal(-pid, name);
        } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
                groupAbsent = true;
                return true;
            }
            // An error is not evidence of teardown or a successful signal.
            return false;
        }
    };
    const killHard = (): void => {
        hardRequested = true;
        if (!spawnConfirmed || hardSignaled || groupAbsent || retryTimer || hardAttempts >= 8)
            return;
        hardAttempts++;
        if (signal('SIGKILL')) {
            hardSignaled = true;
            return;
        }
        // Bounded retry permits recovery from an interrupted/failed kill. Once
        // exhausted, retain unknown status and observe only; never spin.
        if (hardAttempts < 8) {
            retryTimer = setTimeout(
                () => {
                    retryTimer = undefined;
                    if (!groupAlive()) return;
                    killHard();
                },
                Math.min(1000, 25 * 2 ** (hardAttempts - 1)),
            );
        }
    };
    const wait = async (timeout: number): Promise<boolean> => {
        const until = performance.now() + timeout;
        do {
            if ((!child || childExited) && !groupAlive()) return true;
            await delay(20);
        } while (performance.now() < until);
        return (!child || childExited) && !groupAlive();
    };
    const finish = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        clearInterval(keeper);
        if (retryTimer) clearTimeout(retryTimer);
        clearTimeout(initializationTimer);
        if (options) {
            const directory = options.initialization.directory as string;
            const refusal = await ownedExecutorDirectoryRefusal(directory, options.tmpBase);
            if (refusal) {
                process.stderr.write(`executor guardian refused to remove directory: ${refusal}\n`);
                send({ type: 'cleanup_refused', reason: refusal });
            } else await rm(path.resolve(directory), { recursive: true, force: true });
        }
        if (process.connected) process.disconnect?.();
    };
    const reportStopped = async (result: StopResult): Promise<void> => {
        if (!process.connected || controllerGone) return;
        await new Promise<void>((resolve) =>
            process.send?.({ type: 'stopped', ...result }, () => resolve()),
        );
    };
    const stop = (hard: boolean): Promise<StopResult> => {
        // A controller loss during a graceful drain must escalate immediately,
        // independently of the already-running graceful-stop promise.
        if (hard) killHard();
        stopping ??= (async () => {
            clearTimeout(initializationTimer);
            if (!hard) signal('SIGTERM');
            let stopped = await wait(
                hard ? (options?.killTimeoutMs ?? 5000) : (options?.stopTimeoutMs ?? 1000),
            );
            const escalated = hardRequested || !stopped;
            if (!stopped && !hard) {
                killHard();
                stopped = await wait(options?.killTimeoutMs ?? 5000);
            }
            const result = { stopped, escalated };
            lastResult = result;
            await reportStopped(result);
            if (stopped) {
                await finish();
            }
            return result;
        })();
        return stopping;
    };
    process.once('disconnect', () => {
        controllerGone = true;
        void stop(true);
    });
    process.once('SIGTERM', () => {
        controllerGone = true;
        void stop(true);
    });
    process.once('SIGINT', () => {
        controllerGone = true;
        void stop(true);
    });
    process.on('message', (message: unknown) => {
        if (record(message) && message.type === 'stop') {
            void stop(false);
            return;
        }
        if (initialized || stopping || !validInitialization(message)) {
            void stop(true);
            return;
        }
        initialized = true;
        clearTimeout(initializationTimer);
        options = message;
        child = spawn(process.execPath, [message.entry], {
            env: { ...message.env, WORKER_MODE: 'disabled', DEDICATED_WORKER: 'false' },
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        pid = child.pid;
        child.stdout?.resume();
        // Bounded tail only: the child's stderr is never buffered unboundedly.
        let stderrTail = Buffer.alloc(0);
        child.stderr?.on('data', (chunk: Buffer) => {
            stderrTail = Buffer.concat([stderrTail, chunk]);
            if (stderrTail.length > STDERR_TAIL_BYTES)
                stderrTail = stderrTail.subarray(stderrTail.length - STDERR_TAIL_BYTES);
        });
        let exitReported = false;
        const reportExit = (
            type: 'executor_failed' | 'executor_exited',
            code: number | null,
            exitSignal: string | null,
        ): void => {
            if (exitReported) return;
            exitReported = true;
            send({ type, code, signal: exitSignal, stderrTail: stderrTail.toString('utf8') });
        };
        child.once('error', () => {
            childExited = true;
            reportExit('executor_failed', null, null);
            if (!stopping) void stop(true);
        });
        child.once('exit', (code, exitSignal) => {
            childExited = true;
            // Give the stderr pipe a moment to drain so the tail is complete.
            const timer = setTimeout(() => reportExit('executor_exited', code, exitSignal), 100);
            child?.once('close', () => {
                clearTimeout(timer);
                reportExit('executor_exited', code, exitSignal);
            });
            if (!stopping) void stop(true);
        });
        child.on('message', (value: unknown) => {
            if (!record(value) || stopping) return;
            if (
                value.type === 'ready' &&
                value.controlSocketPath !== undefined &&
                (typeof value.controlSocketPath !== 'string' ||
                    value.controlSocketPath.length > 4096)
            ) {
                send({ type: 'executor_failed' });
                void stop(true);
                return;
            }
            if (
                value.type === 'ready' &&
                typeof value.socketPath === 'string' &&
                value.socketPath.length <= 4096
            )
                send({
                    type: 'ready',
                    pid,
                    socketPath: value.socketPath,
                    controlSocketPath:
                        typeof value.controlSocketPath === 'string' &&
                        value.controlSocketPath.length <= 4096
                            ? value.controlSocketPath
                            : undefined,
                    catalogRevision:
                        typeof value.catalogRevision === 'string' &&
                        /^[a-f0-9]{64}$/.test(value.catalogRevision)
                            ? value.catalogRevision
                            : undefined,
                });
            else if (value.type === 'startup_rejected' && value.code === 'activation_blocked')
                send({ type: 'startup_rejected', code: 'activation_blocked' });
        });
        child.once('spawn', () => {
            spawnConfirmed = true;
            if (hardRequested || controllerGone) {
                killHard();
                return;
            }
            if (stopping) {
                signal('SIGTERM');
                return;
            }
            child?.send(message.initialization, (error) => {
                if (error) {
                    send({ type: 'executor_failed' });
                    void stop(true);
                }
            });
        });
    });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    runExecutorGuardian();
