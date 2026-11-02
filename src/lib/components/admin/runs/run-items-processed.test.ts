// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { runItemsProcessed } from './run-items-processed.js';
import type { Run } from '$lib/schemas/run.schema.js';

function stub(
    over: Partial<Pick<Run, 'result' | 'stages' | 'taskId' | 'countSummary'>>,
): Pick<Run, 'result' | 'stages' | 'taskId' | 'countSummary'> {
    return {
        result: undefined,
        stages: [],
        taskId: 'example-task',
        countSummary: undefined,
        ...over,
    };
}

describe('runItemsProcessed', () => {
    it('prefers result.itemsProcessed when present', () => {
        expect(runItemsProcessed(stub({ result: { itemsProcessed: 42 } }))).toEqual({
            count: 42,
            unit: 'items',
        });
    });

    it('falls back to summing stage.processed when no result yet', () => {
        const stages = [
            { id: 'a', label: 'A', state: 'completed' as const, processed: 10 },
            { id: 'b', label: 'B', state: 'active' as const, processed: 3 },
        ];
        expect(runItemsProcessed(stub({ stages }))).toEqual({ count: 13, unit: 'items' });
    });

    it('returns null (never 0) when neither source reports anything', () => {
        expect(runItemsProcessed(stub({}))).toBeNull();
        expect(
            runItemsProcessed(
                stub({ stages: [{ id: 'a', label: 'A', state: 'waiting' as const }] }),
            ),
        ).toBeNull();
    });

    it('ignores a non-numeric result.itemsProcessed', () => {
        expect(runItemsProcessed(stub({ result: { itemsProcessed: 'lots' } }))).toBeNull();
    });

    it('uses the shared validated frame summary and continuation', () => {
        expect(
            runItemsProcessed(
                stub({
                    taskId: 'trickplay-generation',
                    countSummary: {
                        count: 663,
                        unit: 'frames',
                        continuation: { kind: 'source-check', remainingSources: 1 },
                    },
                }),
            ),
        ).toEqual({
            count: 663,
            unit: 'frames',
            continuation: { kind: 'source-check', remainingSources: 1 },
        });
    });

    it('does not relabel malformed preview results or source progress as items', () => {
        expect(
            runItemsProcessed(
                stub({
                    taskId: 'trickplay-generation',
                    result: { itemsProcessed: Number.POSITIVE_INFINITY },
                    stages: [
                        {
                            id: 'generation',
                            label: 'Generation',
                            state: 'active' as const,
                            processed: 4,
                        },
                    ],
                }),
            ),
        ).toBeNull();
    });
});
