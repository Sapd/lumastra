// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tracks the task runs acting on one subject (a media item), derived from
 * server state rather than from the run id a click happened to return.
 *
 * Three properties that the previous per-button pollers did not have:
 *  - it survives a reload, because the SSR seed and a subject-scoped fetch
 *    reconstruct in-flight runs from `scope.subjectId`;
 *  - it sees runs started elsewhere (another tab, another admin);
 *  - it reports real terminal states, never inferring success from a run
 *    disappearing out of a listing window.
 */

import { runSSEBus } from './run-sse-bus.js';
import { apiGet } from '$lib/api/client.js';
import { RunListResponseSchema, RunSchema as RunSchemaForSingle } from '$lib/schemas/run.schema.js';
import type { Run } from '@sapd/lumastra-plugin-sdk';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const FALLBACK_POLL_MS = 5_000;
const CONNECTED_RECONCILE_MS = 30_000;
const RECONCILE_TIMEOUT_MS = 30_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface SubjectRunsTracker {
    runsFor(taskId: string): Run[];
    isActive(taskId: string): boolean;
    progressFor(taskId: string): { processed: number; total: number } | undefined;
    onSettled(cb: (run: Run) => void): () => void;
    /** Adopt an accepted run even if it finished before the active-run listing or SSE saw it. */
    observeRun?(runId: string): void;
    destroy(): void;
}

/** resultTasks opt in to one further notification when a missing completed result becomes readable. */
export function createSubjectRunsTracker(
    subjectId: string,
    seed: Run[],
    resultTasks: readonly string[] = [],
): SubjectRunsTracker {
    // Adopted run ids. Transitions are applied BY ID rather than by re-filtering
    // on scope, so the tracker does not depend on every event path carrying a
    // complete scope object.
    const adopted = new Set<string>();
    const settledCallbacks = new Set<(run: Run) => void>();
    // Runs already terminal when first seen are recorded here WITHOUT firing
    // onSettled — otherwise every page load would toast for old history.
    const alreadySettled = new Set<string>();
    const pendingResults = new Set<string>();
    let destroyed = false;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;
    let reconciliationInFlight = false;
    let lastReconciliationAt = 0;
    let reconciliationGeneration = 0;
    const controller = new AbortController();

    for (const run of seed) {
        adopted.add(run.id);
        if (TERMINAL.has(run.state)) alreadySettled.add(run.id);
        // Push through the bus so there is exactly ONE map: progress events
        // merge only into runs already present, so a separately-held seed would
        // sit at 0% forever.
        runSSEBus.upsertRun(run);
    }

    runSSEBus.connect();

    function currentRuns(): Run[] {
        const out: Run[] = [];
        for (const run of runSSEBus.runs.values()) {
            if (run.scope?.subjectId === subjectId || adopted.has(run.id)) {
                adopted.add(run.id);
                out.push(run);
            }
        }
        return out;
    }

    function reconcile(): void {
        if (destroyed) return;
        for (const run of currentRuns()) {
            if (TERMINAL.has(run.state) && !alreadySettled.has(run.id)) {
                alreadySettled.add(run.id);
                if (
                    run.state === 'completed' &&
                    run.result == null &&
                    resultTasks.includes(run.taskId)
                )
                    pendingResults.add(run.id);
                for (const cb of settledCallbacks) cb(run);
            } else if (pendingResults.has(run.id) && run.result != null) {
                pendingResults.delete(run.id);
                for (const cb of settledCallbacks) cb(run);
            }
        }
        if (pendingResults.size && Date.now() - lastReconciliationAt >= CONNECTED_RECONCILE_MS)
            void reconcileFromServer();
    }

    const unsubscribe = runSSEBus.onAnyChange(reconcile);

    /** Returns the ids the server confirmed as still live. */
    async function fetchSubjectRuns(
        signal: AbortSignal,
        owns: () => boolean,
    ): Promise<Set<string>> {
        if (!owns()) return new Set();
        const since = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();
        const { data } = await apiGet(
            `/api/runs?subjectId=${encodeURIComponent(subjectId)}&state=pending,active,cancelling&since=${encodeURIComponent(since)}`,
            RunListResponseSchema,
            { signal },
        );
        if (!data || !owns()) return new Set();
        for (const run of data.items) {
            adopted.add(run.id);
            runSSEBus.upsertRun(run);
        }
        return new Set(data.items.map((r) => r.id));
    }

    async function reconcileAdoptedTerminals(
        active: Set<string>,
        signal: AbortSignal,
        owns: () => boolean,
    ): Promise<void> {
        // A run that vanished from the active listing may have completed OR
        // failed. Never infer the outcome from its absence — that is exactly
        // the false-success bug this replaces. Re-read it.
        for (const id of adopted) {
            if (!owns()) return;
            if (active.has(id) || (alreadySettled.has(id) && !pendingResults.has(id))) continue;
            const { data } = await apiGet(
                `/api/runs/${encodeURIComponent(id)}`,
                RunSchemaForSingle,
                { signal },
            );
            if (!owns()) return;
            if (data) runSSEBus.upsertRun(data);
        }
    }

    async function reconcileFromServer(): Promise<void> {
        // Startup, disconnected fallback and connected safety checks share one
        // owner. Slow requests cannot overlap or write after this tracker dies.
        if (destroyed || reconciliationInFlight) return;
        reconciliationInFlight = true;
        lastReconciliationAt = Date.now();
        const generation = ++reconciliationGeneration;
        const pass = new AbortController();
        const owns = (): boolean =>
            !destroyed && !pass.signal.aborted && generation === reconciliationGeneration;
        const abortPass = (): void => pass.abort();
        controller.signal.addEventListener('abort', abortPass, { once: true });
        const timeout = setTimeout(abortPass, RECONCILE_TIMEOUT_MS);
        let rejectAborted: () => void = () => {};
        const interrupted = new Promise<never>((_resolve, reject) => {
            rejectAborted = () => reject(new Error('Subject reconciliation interrupted'));
            pass.signal.addEventListener('abort', rejectAborted, { once: true });
        });
        try {
            // Bound the entire pass, including body parsing after response
            // headers. A stalled body must not hold the coalescing owner forever.
            await Promise.race([
                interrupted,
                (async () => {
                    const confirmed = await fetchSubjectRuns(pass.signal, owns);
                    if (!owns()) return;
                    await reconcileAdoptedTerminals(confirmed, pass.signal, owns);
                    if (owns()) reconcile();
                })(),
            ]);
        } catch {
            // Retain the last observed state on transport uncertainty. Absence
            // from a listing is never terminal evidence; retry on a later tick.
        } finally {
            clearTimeout(timeout);
            controller.signal.removeEventListener('abort', abortPass);
            pass.signal.removeEventListener('abort', rejectAborted);
            if (generation === reconciliationGeneration) reconciliationInFlight = false;
        }
    }

    function startFallbackPolling(): void {
        if (fallbackTimer) return;
        fallbackTimer = setInterval(() => {
            if (
                destroyed ||
                (typeof document !== 'undefined' && document.visibilityState === 'hidden')
            )
                return;
            if (runSSEBus.connected) {
                // SSE is the fast path, but an open connection cannot prove a
                // particular lifecycle event arrived. Reconcile only subjects
                // still appearing busy, at most once per 30s while visible.
                const hasActiveRuns =
                    pendingResults.size > 0 ||
                    currentRuns().some((run) => !TERMINAL.has(run.state)) ||
                    [...adopted].some((id) => !alreadySettled.has(id) && !runSSEBus.runs.has(id));
                if (!hasActiveRuns || Date.now() - lastReconciliationAt < CONNECTED_RECONCILE_MS)
                    return;
            }
            void reconcileFromServer();
        }, FALLBACK_POLL_MS);
    }

    // Close the SSR-to-first-SSE gap immediately. Later safety checks also
    // repair missed terminal events after startup, without relying on a stream
    // disconnect or interpreting disappearance as successful completion.
    void reconcileFromServer();
    startFallbackPolling();

    function runsFor(taskId: string): Run[] {
        return currentRuns().filter((r) => r.taskId === taskId);
    }

    function isActive(taskId: string): boolean {
        return runsFor(taskId).some((r) => !TERMINAL.has(r.state));
    }

    function progressFor(taskId: string): { processed: number; total: number } | undefined {
        const runs = runsFor(taskId).filter((r) => !TERMINAL.has(r.state));
        if (runs.length === 0) return undefined;
        let processed = 0;
        let total = 0;
        for (const run of runs) {
            for (const stage of run.stages) {
                processed += stage.processed ?? 0;
                total += stage.total ?? 0;
            }
        }
        // Tolerate a missing/zero total. A stage can report `processed` before
        // it knows its denominator, and `task_history.stages` is only written
        // on terminal transitions — so gating on `total > 0` hid a real,
        // advancing count behind a bare "Running". Report the open-ended count
        // instead and let the caller omit the denominator.
        if (total > 0) return { processed, total };
        return processed > 0 ? { processed, total: 0 } : undefined;
    }

    return {
        observeRun(id) {
            if (destroyed || !id) return;
            adopted.add(id);
            void reconcileFromServer();
        },
        runsFor,
        isActive,
        progressFor,
        onSettled(cb) {
            settledCallbacks.add(cb);
            return () => {
                settledCallbacks.delete(cb);
            };
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            controller.abort();
            if (fallbackTimer) clearInterval(fallbackTimer);
            fallbackTimer = null;
            unsubscribe();
            settledCallbacks.clear();
            runSSEBus.disconnect();
        },
    };
}
