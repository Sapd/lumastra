// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The chapter sheet after its injection refactor.
 *
 * It used to import `musicPlayerStore` and read `currentTrack.chapters`,
 * `currentTimeMs` and `durationMs` off it directly. The audiobook player reuses
 * this sheet with a DIFFERENT clock — book time, not the backend's file time —
 * so the reading moved to the call site.
 *
 * Two things are pinned here:
 *
 *  1. **The music surface still behaves as it did.** That is the regression
 *     risk of the refactor: it touches a live surface for a feature that has no
 *     users yet.
 *  2. **The sheet has no opinion about which clock it is given.** The
 *     book-time case is asserted with positions that are far past the end of
 *     any single file, which is precisely the input that would have highlighted
 *     the wrong chapter had the sheet kept reading file time.
 */

import { render, cleanup, fireEvent } from '@testing-library/svelte';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import MusicChapterSheet from './MusicChapterSheet.svelte';
import type { TrackChapter as MusicChapter } from '$lib/schemas/api-music-dto';

afterEach(cleanup);

/** A DJ mix: the music surface's shape. Minutes. */
const MIX_CHAPTERS: MusicChapter[] = [
    { title: 'Intro', startMs: 0 },
    { title: 'Second Track', startMs: 240_000 },
    { title: 'Closer', startMs: 600_000 },
];

/**
 * A three-file audiobook, in BOOK time.
 *
 * The second chapter starts 2h42m in — a position that on the transcode path
 * happens to equal the element's own clock, and on the direct path does NOT
 * (file two's clock restarts at 0). The sheet must be told which it is holding.
 */
const BOOK_CHAPTERS: MusicChapter[] = [
    { title: 'CD1', startMs: 0 },
    { title: 'CD2', startMs: 9_735_696 },
    { title: 'CD3', startMs: 17_735_696 },
];

function activeTitle(container: HTMLElement): string | null {
    const active = container.querySelector('.bg-primary-500\\/15');
    return active?.querySelector('.font-medium')?.textContent?.trim() ?? null;
}

describe('MusicChapterSheet', () => {
    it('renders nothing while closed', () => {
        const { container } = render(MusicChapterSheet, {
            props: {
                open: false,
                onclose: vi.fn(),
                chapters: MIX_CHAPTERS,
                positionMs: 0,
                onseek: vi.fn(),
            },
        });
        expect(container.querySelector('[role="dialog"]')).toBeNull();
    });

    it('highlights the chapter containing the injected position (music surface)', () => {
        const { container } = render(MusicChapterSheet, {
            props: {
                open: true,
                onclose: vi.fn(),
                chapters: MIX_CHAPTERS,
                positionMs: 300_000,
                durationMs: 900_000,
                onseek: vi.fn(),
            },
        });
        expect(activeTitle(container)).toBe('Second Track');
    });

    it('closes the final chapter with the injected duration', () => {
        // Past the last start but inside the track: still the last chapter.
        const { container } = render(MusicChapterSheet, {
            props: {
                open: true,
                onclose: vi.fn(),
                chapters: MIX_CHAPTERS,
                positionMs: 899_000,
                durationMs: 900_000,
                onseek: vi.fn(),
            },
        });
        expect(activeTitle(container)).toBe('Closer');
    });

    it('seeks through the injected callback, not through the music store', async () => {
        const onseek = vi.fn();
        const onclose = vi.fn();
        const { getAllByRole } = render(MusicChapterSheet, {
            props: {
                open: true,
                onclose,
                chapters: MIX_CHAPTERS,
                positionMs: 0,
                onseek,
            },
        });

        // [0] is the sheet's close button; chapter rows follow.
        const rows = getAllByRole('button').filter((el) =>
            el.textContent?.includes('Second Track'),
        );
        await fireEvent.click(rows[0]);

        expect(onseek).toHaveBeenCalledWith(240_000);
        expect(onclose).toHaveBeenCalledTimes(1);
    });

    /**
     * The reason the refactor exists.
     *
     * 3 000 000 ms is inside the FIRST chapter of the book but is also a
     * perfectly plausible file-time position. Feeding book time in gives the
     * right answer; the old wiring would have fed whatever the music store held
     * and there would have been no way to tell from the component.
     */
    it('takes book time verbatim for an audiobook', () => {
        const { container, rerender } = render(MusicChapterSheet, {
            props: {
                open: true,
                onclose: vi.fn(),
                chapters: BOOK_CHAPTERS,
                positionMs: 3_000_000,
                durationMs: 26_128_860,
                onseek: vi.fn(),
            },
        });
        expect(activeTitle(container)).toBe('CD1');

        // A minute into file two is 9 795 696 ms of BOOK time, not 60 000.
        rerender({
            open: true,
            onclose: vi.fn(),
            chapters: BOOK_CHAPTERS,
            positionMs: 9_795_696,
            durationMs: 26_128_860,
            onseek: vi.fn(),
        });
        expect(activeTitle(container)).toBe('CD2');
    });

    it('accepts a caller-supplied heading', () => {
        const { getByText } = render(MusicChapterSheet, {
            props: {
                open: true,
                onclose: vi.fn(),
                chapters: BOOK_CHAPTERS,
                positionMs: 0,
                onseek: vi.fn(),
                heading: 'Kapitel',
            },
        });
        expect(getByText('Kapitel')).toBeTruthy();
    });
});
