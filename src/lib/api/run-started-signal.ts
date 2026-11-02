// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "A request just started a background run." The typed API client fires this
 * after any mutating response whose body carries a `jobId` / `runId`, so the
 * app-wide manual-run tracker picks the run up at once instead of on its next
 * idle poll — no action has to remember to notify it. A module of its own so
 * the client does not import the tracker (and its stores).
 */

type Listener = () => void;
const listeners = new Set<Listener>();

export function onRunStarted(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function signalRunStartedIfPresent(body: unknown): void {
    if (!body || typeof body !== 'object') return;
    const { jobId, runId } = body as { jobId?: unknown; runId?: unknown };
    if (typeof jobId !== 'string' && typeof runId !== 'string') return;
    for (const listener of listeners) listener();
}
