// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * file-delta-ingest-queue.ts — Valkey side-channel payload queue for the
 * file-delta-ingest task.
 *
 * WHY THIS EXISTS (see file-delta-ingest.ts for the full writeup):
 * file-delta-ingest dedups concurrent runs per library path via
 * `identityFor: (input) => \`path-${libraryPathId}\`` + a global
 * `exclusiveWith` SETNX mutex. That dedup used to key on the WHOLE task
 * input, so a second startRun for the same path with a *different*
 * upsert/remove list came back `{ deduped: true }` and its payload was
 * silently dropped — never queued, never merged. Fix: move the payload out
 * of the task input into this Valkey LIST. Callers push the payload here
 * FIRST, then call startRun with a payload-free input (just
 * `{ libraryPathId }`). A deduped startRun is now harmless — the payload is
 * already durably queued for whichever run (new or already-active) drains
 * it. `execute()` in file-delta-ingest.ts drains this list until it's empty,
 * coalescing every payload pushed for that path into the one active run.
 *
 * Deliberately a separate, dependency-light module (imports only
 * valkey-types.js) so route/service callers that just need to push a payload
 * don't pull in file-delta-ingest.ts's full execute()-time dependency graph
 * (file-scanner, ingestSingleFile, safe-fs, database queries, ...) into
 * their module graph (and their tests).
 *
 * Durability: both keys live on the COORDINATION Valkey client
 * (`requireClient()` → `getCoordinationClient()`) — prod runs that instance
 * `noeviction`, and both keys are deliberately TTL-less, same rationale as
 * `pending-write-drain.ts`'s LIST_KEY/PROCESSING_KEY: this is durability
 * state, not a cache entry.
 *
 * Crash-safety pattern (mirrors pending-write-drain.ts): a claim is
 * `LMOVE pendingKey processingKey RIGHT LEFT` (atomic, non-destructive); the
 * claiming run only issues `LREM processingKey 1 <raw>` once the payload has
 * been durably processed. If the run's process is killed between the claim
 * and the ack, the entry survives on the processing key instead of
 * vanishing — `recoverProcessing()` sweeps any such leftovers back onto the
 * pending list at the start of every run for that path.
 *
 * Bonus: because the payload no longer travels through the task's
 * serialized `input`, delta batches are no longer subject to `startRun`'s
 * 256 KB `LUMASTRA_MAX_TASK_INPUT_BYTES` cap (see tasks/CLAUDE.md
 * "Job input size cap").
 */

import { requireClient, type ValkeyLike } from '../../valkey-types.js';

/** Payload pushed by a caller for a single upsert/remove batch. */
export interface DeltaPayload {
    upsert: string[];
    remove: string[];
    eventId?: string;
    /** ms epoch, set by `enqueueDeltaPayload` — used only for stale-entry logging. */
    enqueuedAt: number;
}

/** Valkey LIST holding not-yet-drained payloads for one library path. */
export function pendingListKey(libraryPathId: string): string {
    return `task:delta-ingest:pending:${libraryPathId}`;
}

/**
 * Crash-safe "claimed, not yet acked" holding list — see module doc above.
 * Scoped per library path, same as `pendingListKey`, so a leftover from a
 * crashed run for path A can never be confused with path B's queue.
 */
export function processingListKey(libraryPathId: string): string {
    return `task:delta-ingest:pending:${libraryPathId}:processing`;
}

/**
 * Push a delta payload onto the queue for `libraryPathId`. No-op for an
 * empty payload (nothing to process, and an empty push would otherwise wake
 * a drain loop for nothing). Safe to call regardless of whether a run for
 * this path is currently active — dedup on the `startRun` side means the
 * payload just waits for whichever run (new or already-active) drains it.
 *
 * Residual window (documented, not fully closed — see file-delta-ingest.ts
 * execute() for the matching comment on the drain side): if this LPUSH lands
 * strictly after the active run's final "queue is empty" check but strictly
 * before the runner releases that run's `exclusiveWith` identity key, the
 * payload sits on the list until the next event/scan triggers a fresh run
 * for this path. That window is the time between execute() returning and
 * `runner.ts`'s `releaseExclusivityKey` call — sub-millisecond in practice,
 * not the whole-payload drop the old design had.
 */
export async function enqueueDeltaPayload(
    libraryPathId: string,
    payload: { upsert: string[]; remove: string[]; eventId?: string },
): Promise<void> {
    if (payload.upsert.length === 0 && payload.remove.length === 0) return;
    const client: ValkeyLike = requireClient();
    const encoded: DeltaPayload = { ...payload, enqueuedAt: Date.now() };
    await client.customCommand(['LPUSH', pendingListKey(libraryPathId), JSON.stringify(encoded)]);
}

/**
 * Defensive bound on the crash-recovery sweep below — PROCESSING_KEY can't
 * realistically hold more than a handful of entries (at most one drain
 * claim is ever in flight per path, thanks to `exclusiveWith`), but this
 * guards against an unbounded loop if that invariant is ever violated.
 */
const RECOVERY_SWEEP_CAP = 10_000;

/**
 * Crash-recovery sweep. Moves every entry still sitting on the processing
 * key for this path back onto the pending key
 * (`LMOVE processingKey pendingKey LEFT RIGHT`, repeated until empty), so a
 * claim that was never acked — because the process was killed between the
 * LMOVE claim and the replay/ack — gets redrained instead of vanishing.
 *
 * Safe to call unconditionally at the start of every run for this path:
 * `exclusiveWith` guarantees at most one run per library path is ever
 * active, so entries can only accumulate on the processing key across a
 * crash of a *previous* run, never a concurrent one.
 */
export async function recoverProcessing(
    client: ValkeyLike,
    libraryPathId: string,
): Promise<number> {
    const processingKey = processingListKey(libraryPathId);
    const pendingKey = pendingListKey(libraryPathId);
    let recovered = 0;
    for (let i = 0; i < RECOVERY_SWEEP_CAP; i++) {
        const moved = await client.customCommand([
            'LMOVE',
            processingKey,
            pendingKey,
            'LEFT',
            'RIGHT',
        ]);
        if (moved === null || moved === undefined) break;
        recovered++;
    }
    return recovered;
}
