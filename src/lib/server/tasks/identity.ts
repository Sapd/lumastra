// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { TaskDefinition } from '@sapd/lumastra-plugin-sdk';

/**
 * Compute the BullMQ jobId for a task invocation.
 * Format: `<taskId>~~<identityFor(input)>`.
 * The result is used as `opts.jobId`; BullMQ rejects duplicate jobIds atomically.
 *
 * `~~` is used as the separator (not `::`) because BullMQ 5.71+ rejects any
 * jobId whose colon-split yields a part count other than 3. Formulas containing
 * colons (e.g. `tgt:library`, `item:${uuid}`) would push the count to 4+ and
 * throw at enqueue time. `~~` is unambiguous, URL-safe, and never appears in
 * ULIDs, UUIDs, or task IDs.
 *
 * @throws If identityFor(input) returns an empty string
 * @throws If the identity formula contains control characters
 * @throws If the identity formula exceeds 256 characters
 * @throws If the identity formula contains `:` (BullMQ colon-split constraint)
 */
export function computeIdentity<I>(task: TaskDefinition<I, unknown>, input: I): string {
    // F6.2: validate `task.id` against the same reserved sequences the encoded
    // jobId (`<taskId>~~<formula>#<runId>`) and identity key reserve. A reserved
    // char in the taskId would otherwise surface as a cryptic BullMQ "Custom Id
    // cannot contain :" at enqueue, or silently corrupt the runId/taskId split
    // in the runner's decoder. Fail fast here with a readable message naming the
    // offending id and char.
    for (const reserved of ['~~', '#', ':'] as const) {
        if (task.id.includes(reserved)) {
            throw new Error(
                `task id "${task.id}" contains reserved sequence "${reserved}" — task ids cannot contain "~~", "#", or ":" (they delimit the encoded jobId <taskId>~~<formula>#<runId>)`,
            );
        }
    }
    const tail = task.identityFor(input);
    sanitizeIdentity(tail); // Validates and may throw
    return `${task.id}~~${tail}`;
}

/**
 * Compute the Valkey key for cross-time identity dedup
 * (longer-lived than BullMQ jobId which expires when job leaves the queue).
 *
 * Format: `task:identity:<taskId>:<formula>`
 * Used with SETNX for dedup across time (TTL 24h).
 *
 * @param taskId Task identifier (e.g. 'file-system-scan')
 * @param formula Identity formula output (result of identityFor(input))
 * @returns Valkey key string
 */
export function identityKey(taskId: string, formula: string): string {
    return `task:identity:${taskId}:${formula}`;
}

/**
 * Sanitize an identityFor() output to ensure it's safe for use in:
 * - BullMQ jobId (used in Redis ZSET members and hash keys)
 * - Valkey key components
 * - The encoded job name `<taskId>~~<formula>#<runId>` which the runner
 *   decodes by splitting on the final `#`. If a plugin's identityFor result
 *   contains `#run_…`, the decoder picks the wrong suffix and the SSE/
 *   terminal-event path drops the transition. Reject `#` outright.
 *
 * Validation rules:
 * - Cannot be empty
 * - Cannot exceed 256 characters
 * - Cannot contain control characters (0x00-0x1f, 0x7f)
 * - Cannot contain `#` (reserved as the runId delimiter in encoded job names)
 * - Cannot contain `:` (BullMQ 5.71+ rejects jobIds whose colon-split yields
 *   a part count other than 3; a colon in the formula pushes the count to 4+
 *   and throws at enqueue time — use `-` or `_` as separators instead)
 *
 * @param raw Raw identity formula output from identityFor(input)
 * @returns The input unchanged if validation passes
 * @throws If validation fails
 */
export function sanitizeIdentity(raw: string): string {
    if (raw.length === 0) {
        throw new Error('identity formula cannot be empty');
    }

    if (raw.length > 256) {
        throw new Error(`identity formula exceeds 256 characters (got ${raw.length})`);
    }

    // Check for control characters (0x00-0x1f = C0 controls, 0x7f = DEL)
    // eslint-disable-next-line no-control-regex
    const hasControlChars = /[\x00-\x1f\x7f]/.test(raw);
    if (hasControlChars) {
        throw new Error('identity formula contains control characters');
    }

    // `#` is reserved — the runner encodes job names as
    // `<taskId>~~<formula>#<runId>` and decodes on the *last* `#`. Allowing
    // `#` in `formula` means a plugin returning `…#run_OPS_NOTE` would
    // collide with the runId delimiter and the decoder would extract a
    // bogus runId, silently dropping terminal SSE events for that run.
    if (raw.includes('#')) {
        throw new Error('identity formula cannot contain "#" (reserved for runId delimiter)');
    }

    // `:` is reserved — BullMQ 5.71+ rejects any jobId whose colon-split
    // yields a part count other than 3. The jobId format is
    // `<taskId>~~<formula>#<runId>`, so a colon inside `formula` pushes the
    // total colon count past 2 and BullMQ throws "Custom Id cannot contain :".
    // Plugin authors must use `-` or `_` as separators in identityFor formulas.
    if (raw.includes(':')) {
        throw new Error(
            'identity formula cannot contain ":" (BullMQ rejects jobIds with colon-split count ≠ 3; use "-" or "_" as separators)',
        );
    }

    // `~~` is reserved — it's the taskId/formula separator in encoded jobIds
    // (`<taskId>~~<formula>#<runId>`). Allowing `~~` inside the formula would
    // not break the current decoder (which splits only on `#`), but any future
    // diagnostic code that splits a stored jobId on `~~` to extract the taskId
    // would silently return the wrong prefix.
    if (raw.includes('~~')) {
        throw new Error(
            'identity formula cannot contain "~~" (reserved as the taskId separator in encoded jobIds)',
        );
    }

    return raw;
}
