// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'vitest';
import AudiobookProgress from './AudiobookProgress.svelte';

const HOUR = 3_600_000;
const MIN = 60_000;

// Chapter starts at 0, 1h, 2h, 3h, plus the untagged tail at 3h50m.
const chapters = [
    { startMs: 0 },
    { startMs: 3600000 },
    { startMs: 7200000 },
    { startMs: 10800000 },
    { startMs: 13800000, synthetic: true },
];

describe('AudiobookProgress', () => {
    afterEach(() => cleanup());

    test('a started book shows percent, chapter and position against length', () => {
        render(AudiobookProgress, {
            positionMs: 2 * HOUR + 30 * MIN,
            durationMs: 4 * HOUR,
            finished: false,
            chapters,
        });

        const bar = screen.getByRole('progressbar');
        expect(bar.getAttribute('aria-valuenow')).toBe('63');
        expect(screen.getByText('63%')).toBeTruthy();
        // The synthetic tail is not a chapter, so there are 4, and 2h30m is in the third.
        expect(screen.getByText('Chapter 3 of 4')).toBeTruthy();
        expect(screen.getByText('2h 30m of 4h 00m')).toBeTruthy();
    });

    test('a finished book that was not restarted shows Finished, no bar', () => {
        render(AudiobookProgress, { positionMs: 0, durationMs: 4 * HOUR, finished: true });
        expect(screen.getByText('Finished')).toBeTruthy();
        expect(screen.queryByRole('progressbar')).toBeNull();
    });

    test('a finished book being listened to again shows the bar', () => {
        render(AudiobookProgress, { positionMs: 10 * MIN, durationMs: 4 * HOUR, finished: true });
        expect(screen.getByRole('progressbar')).toBeTruthy();
        expect(screen.queryByText('Finished')).toBeNull();
    });

    test('a book never started shows nothing', () => {
        const { container } = render(AudiobookProgress, {
            positionMs: 0,
            durationMs: 4 * HOUR,
            finished: false,
        });
        expect(container.textContent?.trim()).toBe('');
    });
});
