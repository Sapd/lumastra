// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach } from 'vitest';
import {
    isAudiobookSweepBlocked,
    isAudiobookSweepRunning,
    withAudiobookSweepLock,
    _resetAudiobookSweepLocksForTests,
    SWEEP_ALL_KEY,
} from './sweep-lock.js';

/** A promise plus the handle that settles it, so a run can be held open. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

beforeEach(() => {
    _resetAudiobookSweepLocksForTests();
});

describe('withAudiobookSweepLock', () => {
    it('runs the operation and reports the result when nothing is in flight', async () => {
        const result = await withAudiobookSweepLock(
            SWEEP_ALL_KEY,
            () => Promise.resolve('ran'),
            () => 'busy',
        );

        expect(result).toBe('ran');
    });

    it('rejects a second concurrent run of the same key', async () => {
        const gate = deferred();
        const first = withAudiobookSweepLock(
            SWEEP_ALL_KEY,
            () => gate.promise.then(() => 'first'),
            () => 'busy',
        );

        const second = await withAudiobookSweepLock(
            SWEEP_ALL_KEY,
            () => Promise.resolve('second'),
            () => 'busy',
        );

        expect(second).toBe('busy');
        gate.resolve();
        await expect(first).resolves.toBe('first');
    });

    it('does not insert a duplicate book: the skipped run never touches the store', async () => {
        // The reason the guard exists. Two sweeps that both read "absent
        // locally" both insert, and the second `external_ids` upsert steals the
        // mapping, orphaning the first media_items row forever.
        const inserts: string[] = [];
        const gate = deferred();
        const sweep = (label: string) => async (): Promise<void> => {
            await gate.promise;
            inserts.push(label);
        };

        const first = withAudiobookSweepLock(SWEEP_ALL_KEY, sweep('first'), () => undefined);
        await withAudiobookSweepLock(SWEEP_ALL_KEY, sweep('second'), () => undefined);

        gate.resolve();
        await first;

        expect(inserts).toEqual(['first']);
    });

    it('lets two different library paths sweep in parallel', async () => {
        const gate = deferred();
        const first = withAudiobookSweepLock(
            'path-a',
            () => gate.promise.then(() => 'a'),
            () => 'busy',
        );

        const second = await withAudiobookSweepLock(
            'path-b',
            () => Promise.resolve('b'),
            () => 'busy',
        );

        expect(second).toBe('b');
        gate.resolve();
        await expect(first).resolves.toBe('a');
    });

    it('blocks a per-path run while a full sweep is in flight', async () => {
        const gate = deferred();
        const full = withAudiobookSweepLock(
            SWEEP_ALL_KEY,
            () => gate.promise.then(() => 'all'),
            () => 'busy',
        );

        expect(isAudiobookSweepBlocked('path-a')).toBe(true);
        await expect(
            withAudiobookSweepLock(
                'path-a',
                () => Promise.resolve('a'),
                () => 'busy',
            ),
        ).resolves.toBe('busy');

        gate.resolve();
        await full;
    });

    it('blocks a full sweep while any per-path run is in flight', async () => {
        const gate = deferred();
        const path = withAudiobookSweepLock(
            'path-a',
            () => gate.promise.then(() => 'a'),
            () => 'busy',
        );

        await expect(
            withAudiobookSweepLock(
                SWEEP_ALL_KEY,
                () => Promise.resolve('all'),
                () => 'busy',
            ),
        ).resolves.toBe('busy');

        gate.resolve();
        await path;
    });

    it('releases the key when the operation throws', async () => {
        await expect(
            withAudiobookSweepLock(
                SWEEP_ALL_KEY,
                () => Promise.reject(new Error('boom')),
                () => 'busy',
            ),
        ).rejects.toThrow('boom');

        // A crashed run must not wedge the source until the process restarts.
        expect(isAudiobookSweepRunning()).toBe(false);
        await expect(
            withAudiobookSweepLock(
                SWEEP_ALL_KEY,
                () => Promise.resolve('ran'),
                () => 'busy',
            ),
        ).resolves.toBe('ran');
    });

    it('does not hold the key after a successful run', async () => {
        await withAudiobookSweepLock(
            'path-a',
            () => Promise.resolve(null),
            () => null,
        );

        expect(isAudiobookSweepRunning()).toBe(false);
        expect(isAudiobookSweepBlocked('path-a')).toBe(false);
    });
});

describe('isAudiobookSweepRunning', () => {
    it('is false at rest and true for the duration of a run', async () => {
        expect(isAudiobookSweepRunning()).toBe(false);

        const gate = deferred();
        const run = withAudiobookSweepLock(
            SWEEP_ALL_KEY,
            () => gate.promise,
            () => undefined,
        );

        expect(isAudiobookSweepRunning()).toBe(true);

        gate.resolve();
        await run;

        expect(isAudiobookSweepRunning()).toBe(false);
    });
});
