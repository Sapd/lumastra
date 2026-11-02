// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The progress-only lane's drain rule.
 *
 * Locks the invariant that was missing: an event is marked pushed only once the
 * provider accepted it (or terminally refused it). Before this, the lane drained
 * the whole page unconditionally — connectors swallow per-item errors, so a
 * transient provider failure was indistinguishable from success and the position
 * was marked pushed and never retried. For an audiobook, whose resume point
 * lives only upstream, that destroys it.
 */

import { describe, it, expect } from 'vitest';
import type { WatchSyncPushResult } from '@sapd/lumastra-plugin-sdk';
import { selectDrainableProgressItems } from './watch-sync-engine.service.js';

const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001';
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002';

const items = [
    { user_id: ALICE, media_id: 'ok' },
    { user_id: ALICE, media_id: 'transient' },
    { user_id: ALICE, media_id: 'gone' },
    { user_id: BOB, media_id: 'unresolvable' },
];

/** Everything except `unresolvable` was handed to the plugin. */
const attempted = new Set([`${ALICE}:ok`, `${ALICE}:transient`, `${ALICE}:gone`]);

function result(over: Partial<WatchSyncPushResult> = {}): WatchSyncPushResult {
    return {
        succeeded: 0,
        failed: 0,
        skipped: 0,
        staleIds: [],
        errors: [],
        successful: [],
        drainedAsSkipped: [],
        ...over,
    };
}

describe('selectDrainableProgressItems', () => {
    it('drains the accepted and the terminally-refused, and holds the transient failure', () => {
        const drained = selectDrainableProgressItems({
            progressOnly: items,
            positionResult: result({
                successful: [{ username: ALICE, mediaId: 'ok' }],
                drainedAsSkipped: [{ username: ALICE, mediaId: 'gone' }],
            }),
            positionThrew: false,
            attemptedKeys: attempted,
        });

        expect(drained.map((d) => d.media_id).sort()).toEqual(['gone', 'ok']);
        // The whole point: this one comes back next cycle instead of being lost.
        expect(drained.map((d) => d.media_id)).not.toContain('transient');
    });

    it('keys on (user, media), not media alone', () => {
        // A shared library can have two users dirty on the same media row, and
        // the plugin can succeed for one while failing for the other.
        const shared = [
            { user_id: ALICE, media_id: 'book' },
            { user_id: BOB, media_id: 'book' },
        ];
        const drained = selectDrainableProgressItems({
            progressOnly: shared,
            positionResult: result({ successful: [{ username: ALICE, mediaId: 'book' }] }),
            positionThrew: false,
            attemptedKeys: new Set([`${ALICE}:book`, `${BOB}:book`]),
        });

        expect(drained).toEqual([{ user_id: ALICE, media_id: 'book' }]);
    });

    it('retains every item when the plugin returns no acknowledgement', () => {
        // No per-item outcomes prove delivery; never silently consume them.
        const drained = selectDrainableProgressItems({
            progressOnly: items,
            positionResult: null,
            positionThrew: false,
            attemptedKeys: attempted,
        });

        expect(drained).toEqual([]);
    });

    it('holds every attempted item when the whole batch threw', () => {
        // Nothing was delivered, so nothing attempted may be marked pushed.
        const drained = selectDrainableProgressItems({
            progressOnly: items,
            positionResult: null,
            positionThrew: true,
            attemptedKeys: attempted,
        });

        expect(drained).toEqual([]);
    });

    it('retains an item the engine never attempted', () => {
        // A later scan or pairing may resolve this item. Paging skips it only
        // for the current run; it is still queued on the next run.
        for (const threw of [true, false]) {
            const drained = selectDrainableProgressItems({
                progressOnly: [{ user_id: BOB, media_id: 'unresolvable' }],
                positionResult: threw ? null : result(),
                positionThrew: threw,
                attemptedKeys: new Set<string>(),
            });
            expect(drained).toEqual([]);
        }
    });

    it('holds everything when the plugin reports no outcome for anything it was given', () => {
        const drained = selectDrainableProgressItems({
            progressOnly: [{ user_id: ALICE, media_id: 'ok' }],
            positionResult: result({ failed: 1, errors: ['ABS 500'] }),
            positionThrew: false,
            attemptedKeys: new Set([`${ALICE}:ok`]),
        });

        expect(drained).toEqual([]);
    });
});
