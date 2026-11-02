// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runs one `RegExp.exec()` off the main thread under a hard time budget.
 *
 * Security review 2026-09-12, C7: the radio "now playing" regex is configured
 * by an admin but executed against text an *upstream* (possibly hijacked,
 * expired or MITM'd over plain http) controls. Even a perfectly ordinary
 * pattern like `(?<artist>.+) - (?<title>.+)` is quadratic against a long line
 * that never contains the separator, so a hostile body froze the whole Node
 * process — every user, every stream handler — for seconds, once per poll tick.
 * Static pattern analysis cannot see that class of blow-up (there is no nested
 * quantifier to find), so the match itself has to be interruptible.
 *
 * A `node:worker_threads` Worker is the only interruption mechanism that works
 * here: V8's isolate termination unwinds a running irregexp match, so
 * `terminate()` reclaims the thread immediately even mid-backtrack (verified
 * against `(?<title>(a|aa)+)$`, which otherwise runs for minutes).
 *
 * The worker body is a frozen, self-contained CommonJS string executed with
 * `eval: true`. It is NOT user input and nothing is interpolated into it — the
 * pattern, flags and subject travel as structured-cloned `workerData`. The
 * string form is deliberate: the task-isolation worker (`tasks/isolation/`) needs a pre-built bundle emitted by `scripts/build-*.ts`
 * plus a dev/test fallback, because Vite does not carry a `.ts` worker entry
 * into `build/`. An inline source has no build step and therefore behaves
 * identically in dev, vitest and `node build`, which is what a security control
 * needs — a fallback that silently runs the match in-process would reintroduce
 * the exact freeze this exists to prevent. CommonJS (not ESM) because
 * `engines.node` allows 22.0, which predates unflagged module-syntax detection
 * for `eval`'d worker sources.
 *
 * One worker is spawned per match and always terminated. Spawn costs ~12 ms,
 * against a 30 s poll cadence per station; a pool would have to be rebuilt
 * after every termination anyway, and a fresh isolate cannot inherit state from
 * a previous station's match.
 */

import { Worker } from 'node:worker_threads';

/** Wall-clock budget for the match itself, measured from the worker's ready signal. */
export const REGEX_MATCH_BUDGET_MS = 250;

/** Budget for the worker to boot. Generous: only a wedged host should hit it. */
const WORKER_START_BUDGET_MS = 5_000;

export class RegexBudgetExceededError extends Error {
    constructor(budgetMs: number) {
        super(`Regex match exceeded its ${budgetMs}ms budget and was aborted`);
        this.name = 'RegexBudgetExceededError';
    }
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
parentPort.postMessage({ type: 'ready' });
let re = null;
try {
    re = new RegExp(workerData.pattern, workerData.flags);
} catch (err) {
    parentPort.postMessage({
        type: 'error',
        message: err && err.message ? String(err.message) : String(err),
    });
}
if (re) {
    const match = re.exec(workerData.text);
    parentPort.postMessage({
        type: 'result',
        matched: match !== null,
        groups: match && match.groups ? Object.assign({}, match.groups) : null,
    });
}
`;

type WorkerMessage =
    | { type: 'ready' }
    | { type: 'error'; message: string }
    | { type: 'result'; matched: boolean; groups: Record<string, string | undefined> | null };

/**
 * Execute `pattern` against `text` in a disposable worker thread.
 *
 * @returns the named-group object when the pattern matched, `null` when it did
 *          not. Rejects with {@link RegexBudgetExceededError} if the match
 *          outlived its budget, or a plain `Error` if the pattern failed to
 *          compile inside the worker.
 */
export function execRegexWithBudget(
    pattern: string,
    flags: string,
    text: string,
    budgetMs: number = REGEX_MATCH_BUDGET_MS,
): Promise<Record<string, string | undefined> | null> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(WORKER_SOURCE, {
            eval: true,
            workerData: { pattern, flags, text },
        });

        let settled = false;
        let startTimer: ReturnType<typeof setTimeout> | undefined;
        let budgetTimer: ReturnType<typeof setTimeout> | undefined;

        const finish = (emit: () => void): void => {
            if (settled) return;
            settled = true;
            if (startTimer) clearTimeout(startTimer);
            if (budgetTimer) clearTimeout(budgetTimer);
            void worker.terminate();
            emit();
        };

        startTimer = setTimeout(() => {
            finish(() => reject(new RegexBudgetExceededError(budgetMs)));
        }, WORKER_START_BUDGET_MS);

        worker.on('message', (raw: WorkerMessage) => {
            if (raw.type === 'ready') {
                // The worker is alive; start the real clock now so a slow thread
                // spawn under load cannot spuriously abort a legitimate match.
                if (startTimer) clearTimeout(startTimer);
                startTimer = undefined;
                budgetTimer = setTimeout(() => {
                    finish(() => reject(new RegexBudgetExceededError(budgetMs)));
                }, budgetMs);
                return;
            }
            if (raw.type === 'error') {
                finish(() => reject(new Error(raw.message)));
                return;
            }
            finish(() => resolve(raw.matched ? (raw.groups ?? {}) : null));
        });

        worker.on('error', (err: Error) => {
            finish(() => reject(err));
        });

        worker.on('exit', (code: number) => {
            finish(() => reject(new Error(`Regex worker exited before matching (code ${code})`)));
        });
    });
}
