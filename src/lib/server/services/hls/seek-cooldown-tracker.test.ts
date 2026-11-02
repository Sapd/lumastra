// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import {
    clearSeekCooldownTrackerForTests,
    clearSeekTimestamp,
    getLastSeekTimestamp,
    pruneExpiredSeekTimestamps,
    setLastSeekTimestamp,
} from './seek-cooldown-tracker.js';

describe('hls seek cooldown tracker', () => {
    afterEach(() => {
        clearSeekCooldownTrackerForTests();
    });

    it('stores and clears seek timestamps', () => {
        setLastSeekTimestamp('play', 1000);
        expect(getLastSeekTimestamp('play')).toBe(1000);

        clearSeekTimestamp('play');
        expect(getLastSeekTimestamp('play')).toBeUndefined();
    });

    it('prunes old timestamps only after threshold is reached', () => {
        setLastSeekTimestamp('old', 1000);
        pruneExpiredSeekTimestamps({
            pruneThreshold: 2,
            maxAgeMs: 500,
            now: 2000,
        });
        expect(getLastSeekTimestamp('old')).toBe(1000);

        setLastSeekTimestamp('new', 1900);
        pruneExpiredSeekTimestamps({
            pruneThreshold: 2,
            maxAgeMs: 500,
            now: 2000,
        });
        expect(getLastSeekTimestamp('old')).toBeUndefined();
        expect(getLastSeekTimestamp('new')).toBe(1900);
    });
});
