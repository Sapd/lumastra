// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

interface TaskProcessLifecycleOptions {
    drain: () => void;
    cleanup: () => Promise<void>;
    exit: (code: number) => void;
    failed: (error: unknown) => void;
    deadlineMs?: number;
}

/** Signals cancel future startup stages, but never race cleanup against a live stage. */
export function createTaskProcessLifecycle(options: TaskProcessLifecycleOptions): {
    signal: AbortSignal;
    startupFinished: () => void;
    shutdown: (code: number) => Promise<void>;
} {
    const controller = new AbortController();
    let finishStartup: () => void = () => {};
    const startup = new Promise<void>((resolve) => {
        finishStartup = resolve;
    });
    let shutdown: Promise<void> | undefined;
    let exitCode = 0;
    return {
        signal: controller.signal,
        startupFinished: finishStartup,
        shutdown: (code): Promise<void> => {
            // A startup failure discovered after TERM must upgrade the final status.
            exitCode = Math.max(exitCode, code);
            if (shutdown) return shutdown;
            controller.abort(new Error('Task runtime is stopping'));
            options.drain();
            const deadline = setTimeout(() => {
                options.failed(
                    new Error('Task runtime shutdown deadline exceeded; cleanup outcome UNKNOWN'),
                );
                options.exit(1);
            }, options.deadlineMs ?? 60_000);
            // Keep the deadline referenced: even a startup promise with no handles
            // must exit nonzero if it cannot settle and be cleaned up.
            shutdown = (async (): Promise<void> => {
                try {
                    await startup;
                    await options.cleanup();
                } catch (error) {
                    exitCode = 1;
                    options.failed(error);
                } finally {
                    clearTimeout(deadline);
                    options.exit(exitCode);
                }
            })();
            return shutdown;
        },
    };
}

/** Attempt every independent release, while retaining failure as a non-clean outcome. */
export async function cleanupTaskProcess(steps: Array<() => Promise<unknown>>): Promise<void> {
    const failures: unknown[] = [];
    for (const step of steps) {
        try {
            await step();
        } catch (error) {
            failures.push(error);
        }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Task runtime cleanup incomplete');
}
