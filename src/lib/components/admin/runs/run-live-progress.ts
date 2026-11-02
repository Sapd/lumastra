// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { Run } from '$lib/schemas/run.schema.js';

/**
 * Progress events do not advance a run heartbeat. Merge their per-stage
 * high-watermark fields separately from the enclosing Run snapshot so a newer
 * REST response cannot erase live progress received over SSE.
 */
function newestProgressValue(
    previous: number | undefined,
    incoming: number | undefined,
): number | undefined {
    if (previous === undefined) return incoming;
    if (incoming === undefined) return previous;
    return Math.max(previous, incoming);
}

function isTerminalStage(state: Run['stages'][number]['state']): boolean {
    return state === 'completed' || state === 'failed' || state === 'skipped';
}

export function mergeActiveStageProgress(
    current: Run['stages'],
    incoming: Run['stages'],
): Run['stages'] {
    const merged = [...current];

    for (const next of incoming) {
        const index = merged.findIndex((stage) => stage.id === next.id);
        if (index === -1) {
            merged.push(next);
            continue;
        }

        const previous = merged[index];
        const incomingIsAtLeastAsFar =
            next.processed === undefined ||
            previous.processed === undefined ||
            next.processed >= previous.processed;
        const keepTerminalState = isTerminalStage(previous.state) && !isTerminalStage(next.state);

        merged[index] = {
            ...previous,
            ...next,
            state: keepTerminalState ? previous.state : next.state,
            processed: newestProgressValue(previous.processed, next.processed),
            total: newestProgressValue(previous.total, next.total),
            // Do not replace the currently displayed item with one from an
            // older progress event.
            currentItem: incomingIsAtLeastAsFar
                ? (next.currentItem ?? previous.currentItem)
                : previous.currentItem,
        };
    }

    return merged;
}
