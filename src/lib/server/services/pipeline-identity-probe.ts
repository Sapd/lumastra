// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// pipeline-identity-probe.ts — derive the cross-time identity Valkey key the
// orchestrator would write for a task running against an item (Slice 2).
//
// Pure + synchronous + dependency-light (only the identity helpers) so the key
// derivation is unit-testable without Valkey, the registry, or the orchestrator.

import type { TaskDefinition } from '@sapd/lumastra-plugin-sdk';
import { computeIdentity, identityKey } from '$lib/server/tasks/identity.js';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Build the cross-time identity Valkey key the orchestrator WOULD write for
 * `task` running against `mediaItemId`, or `null` if the task takes no per-item
 * identity lock. A shared/global lock is not evidence about this item's run.
 *
 * Mirrors the orchestrator exactly (orchestrator.ts `enqueueWithIdentity`):
 *   - Only `exclusiveWith` tasks claim a SETNX identity key
 *     (`exclusivityKey = identityKey(taskId, computeIdentity(task, input))`).
 *     Every other task dedups purely via BullMQ jobId, with no cross-time key —
 *     so there is nothing to probe and we return `null`. (The earlier code
 *     probed `identityKey(taskId, mediaItemId)` for ALL tasks, which never
 *     matched the real key and silently false-negated `identity-locked`.)
 *   - An identity that does not vary with the supported per-item input is
 *     shared or unknown from this view. Do not probe its global key: this item's
 *     last_run_id cannot establish the holder's identity or health.
 */
export function buildIdentityProbeKey(
    task: TaskDefinition | undefined,
    mediaItemId: string,
): string | null {
    if (!task?.exclusiveWith) return null;
    try {
        const idA = task.identityFor({ mediaItemId });
        const idB = task.identityFor({ mediaItemId: ZERO_UUID });
        if (idA === idB) return null;
        const jobId = computeIdentity(task, { mediaItemId });
        return identityKey(task.id, jobId);
    } catch {
        // identityFor / computeIdentity threw (unexpected input shape, reserved
        // chars in the formula) — treat as "no probe" rather than guess a wrong
        // key. A wrong key reads absent and would false-negate the diagnosis.
        return null;
    }
}
