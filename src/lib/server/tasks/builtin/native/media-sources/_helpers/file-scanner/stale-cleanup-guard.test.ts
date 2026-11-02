// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { staleCleanupGuard } from './stale-cleanup-guard.js';
import {
    holdConfirmsCleanup,
    type CleanupHoldRow,
} from '../../../../../../database/queries/library-cleanup-holds.queries.js';

describe('staleCleanupGuard', () => {
    it.each([
        [0, 0, null],
        [0, 3, 'no_files'],
        [1, 19, null], // under 20 known files the ratio says nothing
        [4, 20, null], // exactly 20 % passes
        [3, 20, 'few_files'],
        [1, 25, 'few_files'],
        [25, 25, null],
    ])('walked %i of %i known -> %s', (walked, known, expected) => {
        expect(staleCleanupGuard(walked, known)).toBe(expected);
    });
});

describe('holdConfirmsCleanup: a confirmation covers only the walk the admin saw', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    const hold: CleanupHoldRow = {
        library_path_id: 'p',
        reason: 'few_files',
        walked: 5,
        known: 100,
        first_held_at: now,
        last_held_at: now,
        confirmed_at: new Date('2026-10-20T11:00:00Z'),
        confirmed_by: 'admin',
        confirmed_walked: 5,
        confirmed_known: 100,
    };
    const scan = { reason: 'few_files' as const, walked: 5, known: 100 };

    it('the same walk is confirmed', () => {
        expect(holdConfirmsCleanup(hold, scan, now)).toBe(true);
    });
    it('a walk that finds fewer files is not (the share degraded further)', () => {
        expect(holdConfirmsCleanup(hold, { ...scan, walked: 2 }, now)).toBe(false);
    });
    it('a walk that finds more files is not (the share came back partly)', () => {
        expect(holdConfirmsCleanup(hold, { ...scan, walked: 15 }, now)).toBe(false);
    });
    it('more known files than the admin saw is not', () => {
        expect(holdConfirmsCleanup(hold, { ...scan, known: 140 }, now)).toBe(false);
    });
    it('another reason is not', () => {
        expect(holdConfirmsCleanup(hold, { ...scan, reason: 'no_files' }, now)).toBe(false);
    });
    it('a confirmation older than a day has expired', () => {
        expect(holdConfirmsCleanup(hold, scan, new Date('2026-10-21T11:30:00Z'))).toBe(false);
    });
    it('an unconfirmed hold is not', () => {
        expect(holdConfirmsCleanup({ ...hold, confirmed_at: null }, scan, now)).toBe(false);
    });
});
