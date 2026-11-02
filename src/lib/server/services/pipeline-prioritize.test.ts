// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `canPrioritizeStage` — the single predicate behind the "Do this one first"
 * button AND the endpoint that serves it.
 *
 * These cases are the two ways the action could quietly lie to an operator:
 * a global-identity task would drain the whole backlog instead of this item,
 * and a multi-stage task would do the work while leaving THIS row at `pending`
 * (the runner only wraps single-stage tasks in the coverage bookkeeping). Both
 * look, from the row, exactly like a button that did nothing.
 */

import { describe, it, expect } from 'vitest';
import { canPrioritizeStage } from './pipeline-timeline.service.js';

const ITEM = '11111111-2222-3333-4444-555555555555';

function task(opts: { stages: string[]; identity: (input: { mediaItemId: string }) => string }) {
    return {
        coversStages: opts.stages.map((id) => ({ id })),
        identityFor: opts.identity as unknown as (i: never) => string,
    };
}

describe('canPrioritizeStage', () => {
    it('allows a per-item task that covers exactly this stage', () => {
        const t = task({
            stages: ['image-sync'],
            identity: (i) => `item-${i.mediaItemId}`,
        });
        expect(canPrioritizeStage(t, 'image-sync', ITEM)).toBe(true);
    });

    it('refuses a global-identity task — a scoped run would drain the whole backlog', () => {
        const t = task({ stages: ['media-probe-a'], identity: () => 'global-quick' });
        expect(canPrioritizeStage(t, 'media-probe-a', ITEM)).toBe(false);
    });

    it('refuses a multi-stage task — the express run would leave this row pending', () => {
        const t = task({
            stages: ['image-sync', 'chapter-sync'],
            identity: (i) => `item-${i.mediaItemId}`,
        });
        expect(canPrioritizeStage(t, 'image-sync', ITEM)).toBe(false);
    });

    it('refuses when the task covers a DIFFERENT single stage', () => {
        const t = task({ stages: ['chapter-sync'], identity: (i) => `item-${i.mediaItemId}` });
        expect(canPrioritizeStage(t, 'image-sync', ITEM)).toBe(false);
    });

    it('refuses an orphaned stage with no owning task', () => {
        expect(canPrioritizeStage(undefined, 'image-sync', ITEM)).toBe(false);
    });

    it('refuses rather than throwing when identityFor rejects the input shape', () => {
        const t = task({
            stages: ['image-sync'],
            identity: () => {
                throw new Error('bad input');
            },
        });
        expect(canPrioritizeStage(t, 'image-sync', ITEM)).toBe(false);
    });
});
