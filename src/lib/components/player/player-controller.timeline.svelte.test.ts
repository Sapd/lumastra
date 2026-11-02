// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerController } from './player-controller.svelte';
import { playerStore } from './playerStore.svelte';

const getTimelineByHref = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/playback.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/api/playback.js')>()),
    getTimelineByHref,
}));

interface TimelineController {
    fetchTimeline(href: string, itemId: string, fileId?: string): Promise<void>;
}
let controller: TimelineController;
const chapters = [{ index: 0, name: 'Chapter', startMs: 0, endMs: 1000, image: null }];
const segments = [{ type: 'intro' as const, startMs: 0, endMs: 500 }];
const variants = [{ width: 320, manifestHref: '/manifest' }];
const data = { fileId: 'file', chapters, segments, trickplay: { variants }, durationMs: 10_000 };

beforeEach(() => {
    getTimelineByHref.mockReset();
    const target = Object.create(PlayerController.prototype);
    for (const [key, value] of Object.entries({
        timelineRequestId: 0,
        timelineItemId: 'item',
        timelineFileId: 'file',
        currentMediaDbId: 'item',
        playbackStart: {
            delivery: { timeline: { href: '/issued/timeline?fileId=file&grant=opaque' } },
        },
    }))
        Object.defineProperty(target, key, { value, writable: true, configurable: true });
    controller = target as TimelineController;
    playerStore.itemId = 'item';
    playerStore.duration = 20;
    playerStore.chapters = chapters;
    playerStore.mediaSegments = segments;
    playerStore.trickplayVariants = variants;
    // Exercise updates without constructing an entire playback session.
    vi.spyOn(playerStore, 'setChaptersAndSegments').mockImplementation(
        (nextChapters, nextSegments) => {
            playerStore.chapters = nextChapters;
            playerStore.mediaSegments = nextSegments;
        },
    );
});
afterEach(() => {
    vi.restoreAllMocks();
    playerStore.reset();
});

describe('timeline refresh during quality changes', () => {
    it('retains existing data during a refresh and when it fails', async () => {
        let reject!: (error: Error) => void;
        getTimelineByHref.mockReturnValue(
            new Promise((_resolve, fail) => {
                reject = fail;
            }),
        );
        const refresh = controller.fetchTimeline('/ready/timeline?grant=one', 'item', 'file');
        expect(playerStore.chapters).toEqual(chapters);
        expect(playerStore.trickplayVariants).toEqual(variants);
        await vi.waitFor(() => expect(getTimelineByHref).toHaveBeenCalled());
        reject(new Error('offline'));
        await refresh;
        expect(playerStore.chapters).toEqual(chapters);
        expect(playerStore.mediaSegments).toEqual(segments);
        expect(playerStore.trickplayVariants).toEqual(variants);
    });
    it('accepts the requested file before currentMediaSource is set and preserves an established duration', async () => {
        playerStore.currentMediaSource = null;
        getTimelineByHref.mockResolvedValue({ data });
        await controller.fetchTimeline('/ready/timeline?grant=one', 'item', 'file');
        expect(playerStore.setChaptersAndSegments).toHaveBeenCalledWith(chapters, segments);
        expect(playerStore.duration).toBe(20);
        expect(getTimelineByHref).toHaveBeenCalledWith('/ready/timeline?grant=one');
    });
    it('fills a missing duration and rejects mismatched file responses', async () => {
        playerStore.duration = 0;
        getTimelineByHref.mockResolvedValueOnce({ data });
        await controller.fetchTimeline('/ready/timeline?grant=one', 'item', 'file');
        expect(playerStore.duration).toBe(10);
        vi.mocked(playerStore.setChaptersAndSegments).mockClear();
        getTimelineByHref.mockResolvedValueOnce({ data: { ...data, fileId: 'other' } });
        await controller.fetchTimeline('/ready/timeline?grant=one', 'item', 'file');
        expect(playerStore.setChaptersAndSegments).not.toHaveBeenCalled();
    });
    it('ignores an older response after a new selected-file request', async () => {
        let resolve!: (value: { data: typeof data }) => void;
        getTimelineByHref.mockReturnValueOnce(
            new Promise((done) => {
                resolve = done;
            }),
        );
        const old = controller.fetchTimeline('/ready/timeline?grant=one', 'item', 'file');
        await vi.waitFor(() => expect(getTimelineByHref).toHaveBeenCalledTimes(1));
        getTimelineByHref.mockResolvedValueOnce({
            data: { ...data, fileId: 'next', chapters: [] },
        });
        await controller.fetchTimeline('/ready/timeline?grant=two', 'item', 'next');
        resolve({ data });
        await old;
        expect(playerStore.chapters).toEqual([]);
    });
});
