// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Derived-floor helper for the exclusiveWith identity-key TTL (Consolidation #2).
 *
 * The floor is not a fixed constant — it is derived per-task at claim time:
 *
 *   floor = max(timeout.hard_ms, schedule.every_ms) + IDENTITY_CLAIM_MARGIN_MS
 *
 * where IDENTITY_CLAIM_MARGIN_MS (10 s) covers the SETNX→INSERT→queue.add
 * critical section. Taking the max of hard timeout and schedule interval means:
 *
 *   - A task whose run can last up to `timeout.hard` will never have its dedup
 *     key expire mid-run, regardless of how frequent the schedule is.
 *   - A task whose schedule fires more often than its hard timeout (rare but
 *     possible) still gets a floor large enough to prevent a second run from
 *     being spawned before the first one can finish.
 *
 * The author's configured `exclusiveWith.ttl` still wins if it is LONGER than
 * the derived floor — the clamp is a floor, not a cap.
 *
 * Safety note: RunLivenessAuthority.releaseIdentityKey() (Consolidation #1)
 * releases the identity key when an orphaned run is reclaimed on markFailed,
 * so a crash-leaked key is freed within ~15 min regardless of its TTL. The
 * long derived floor is safe BECAUSE of this release path, not despite it.
 */

import { parseDurationMs } from './duration.js';
import type { TaskDefinition } from '@sapd/lumastra-plugin-sdk';

/** Time (ms) reserved for the SETNX → INSERT → queue.add critical section. */
export const IDENTITY_CLAIM_MARGIN_MS = 10_000;

/**
 * Compute the minimum identity-key TTL for `task`.
 *
 * Returns `max(timeout.hard_ms, schedule.every_ms) + IDENTITY_CLAIM_MARGIN_MS`.
 * Falls back to `IDENTITY_CLAIM_MARGIN_MS` alone when neither is declared
 * (e.g. a manual-only task with no schedule and no timeout) — the margin is
 * still needed to guard the critical section.
 */
export function deriveIdentityTtlFloor(task: TaskDefinition): number {
    const hardMs = parseDurationMs(task.timeout?.hard) ?? 0;
    const everyMs = parseDurationMs(task.schedule?.every) ?? 0;
    return Math.max(hardMs, everyMs) + IDENTITY_CLAIM_MARGIN_MS;
}
