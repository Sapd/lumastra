// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real worker-thread fixture for `worker-host.test.ts`. Plain `.mjs` so a real
 * `node:worker_threads` Worker can load it under vitest without a TS loader.
 *
 * Behaviour is selected via `workerData.behavior`:
 *   - 'busy'             — synchronous infinite loop; ignores the abort message
 *                          entirely. The ONLY way it ends is a hard terminate().
 *   - 'cooperative-abort'— stays alive on a timer; on the host's `abort` message
 *                          it exits cleanly (process.exit 0) — no hard kill.
 *   - 'echo-done'        — posts a `done` message echoing workerData.echo.
 *   - 'post-then-exit'   — posts a `done` message then calls `process.exit(0)`
 *                          in the SAME synchronous tick (no await in between).
 *                          Mirrors sandbox-entry.ts's theoretical worst case
 *                          for the deferred-postMessage-vs-exit-event race
 *                          worker-host.ts's `exit` handler now defends
 *                          against.
 */
import { parentPort, workerData } from 'node:worker_threads';

const behavior = workerData?.behavior;

if (behavior === 'echo-done') {
    parentPort?.postMessage({
        t: 'done',
        result: workerData.echo ?? { success: true },
    });
} else if (behavior === 'post-then-exit') {
    parentPort?.postMessage({
        t: 'done',
        result: workerData.echo ?? { success: true },
    });
    process.exit(0);
} else if (behavior === 'cooperative-abort') {
    // Keep the thread alive; exit promptly when the host relays an abort.
    const keepAlive = setInterval(() => {}, 1000);
    parentPort?.on('message', (msg) => {
        if (msg && msg.t === 'abort') {
            clearInterval(keepAlive);
            process.exit(0);
        }
    });
} else {
    // 'busy' (default): wedge the thread synchronously. No message can be
    // processed; only terminate() stops it.

    while (true) {
        // spin
    }
}
