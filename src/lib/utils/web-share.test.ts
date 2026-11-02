// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * web-share.ts Unit Tests
 *
 * The share button is PWA-only, so these helpers are the only place the
 * share link's SHAPE is decided. Two things need pinning:
 *
 *  1. `buildWatchShareUrl` must carry the params a recipient needs
 *     (`fileId`, `slug`) and DROP the ones that are the sharer's own
 *     session state (`playlist`, `position`, `info`, `resolved`).
 *     Leaking those hands someone else your playlist position.
 *  2. `shareOrCopy` must treat a user-cancelled share sheet as a no-op
 *     (no toast, no clipboard write) while still falling back to the
 *     clipboard when the platform has no share sheet or it genuinely
 *     fails.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toasts } from '$lib/stores/toast.store';
import { buildWatchShareUrl, shareOrCopy } from './web-share';

describe('buildWatchShareUrl', () => {
    it('builds a bare watch URL when there is no playback position', () => {
        expect(buildWatchShareUrl({ origin: 'https://example.com', itemId: 'abc-123' })).toBe(
            'https://example.com/watch/abc-123',
        );
    });

    it('appends the current position as a whole-second t param', () => {
        expect(
            buildWatchShareUrl({
                origin: 'https://example.com',
                itemId: 'abc-123',
                currentTime: 137.82,
            }),
        ).toBe('https://example.com/watch/abc-123?t=137');
    });

    it('omits t at the very start of playback', () => {
        expect(
            buildWatchShareUrl({
                origin: 'https://example.com',
                itemId: 'abc-123',
                currentTime: 0,
            }),
        ).toBe('https://example.com/watch/abc-123');
    });

    it('omits t for a non-finite position', () => {
        expect(
            buildWatchShareUrl({
                origin: 'https://example.com',
                itemId: 'abc-123',
                currentTime: Number.NaN,
            }),
        ).toBe('https://example.com/watch/abc-123');
    });

    it('carries fileId and slug but drops the sharer session params', () => {
        const url = buildWatchShareUrl({
            origin: 'https://example.com',
            itemId: 'abc-123',
            currentTime: 42,
            params: new URLSearchParams({
                fileId: 'file-9',
                slug: 'the-lantern-1999',
                playlist: 'pl-1',
                position: '4',
                info: 'something',
                resolved: 'tmdb',
            }),
        });

        const parsed = new URL(url);
        expect(parsed.searchParams.get('fileId')).toBe('file-9');
        expect(parsed.searchParams.get('slug')).toBe('the-lantern-1999');
        expect(parsed.searchParams.get('t')).toBe('42');
        expect(parsed.searchParams.has('playlist')).toBe(false);
        expect(parsed.searchParams.has('position')).toBe(false);
        expect(parsed.searchParams.has('info')).toBe(false);
        expect(parsed.searchParams.has('resolved')).toBe(false);
    });

    it('overwrites a t already present in the current URL', () => {
        const url = buildWatchShareUrl({
            origin: 'https://example.com',
            itemId: 'abc-123',
            currentTime: 90,
            params: new URLSearchParams({ t: '5' }),
        });

        expect(new URL(url).searchParams.getAll('t')).toEqual(['90']);
    });

    it('honours a subfolder base path', () => {
        expect(
            buildWatchShareUrl({
                origin: 'https://example.com',
                basePath: '/media',
                itemId: 'abc-123',
            }),
        ).toBe('https://example.com/media/watch/abc-123');
    });

    it('encodes an item id that needs it', () => {
        expect(
            buildWatchShareUrl({ origin: 'https://example.com', itemId: 'tmdb:603:movie' }),
        ).toBe('https://example.com/watch/tmdb%3A603%3Amovie');
    });
});

describe('shareOrCopy', () => {
    beforeEach(() => {
        vi.spyOn(toasts, 'info').mockImplementation(() => 0);
        vi.spyOn(toasts, 'error').mockImplementation(() => 0);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('hands the link to the native share sheet when one exists', async () => {
        const share = vi.fn().mockResolvedValue(undefined);
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { share, clipboard: { writeText } });

        await shareOrCopy({ title: 'The Lantern', url: 'https://example.com/watch/abc' });

        expect(share).toHaveBeenCalledWith({
            title: 'The Lantern',
            url: 'https://example.com/watch/abc',
        });
        expect(writeText).not.toHaveBeenCalled();
        expect(toasts.info).not.toHaveBeenCalled();
    });

    it('stays silent when the user dismisses the share sheet', async () => {
        const abort = new DOMException('The user aborted a request.', 'AbortError');
        const share = vi.fn().mockRejectedValue(abort);
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { share, clipboard: { writeText } });

        await shareOrCopy({ title: 'The Lantern', url: 'https://example.com/watch/abc' });

        expect(writeText).not.toHaveBeenCalled();
        expect(toasts.info).not.toHaveBeenCalled();
        expect(toasts.error).not.toHaveBeenCalled();
    });

    it('falls back to the clipboard when the share sheet fails for real', async () => {
        const share = vi.fn().mockRejectedValue(new Error('not allowed'));
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { share, clipboard: { writeText } });

        await shareOrCopy({ title: 'The Lantern', url: 'https://example.com/watch/abc' });

        expect(writeText).toHaveBeenCalledWith('https://example.com/watch/abc');
        expect(toasts.info).toHaveBeenCalledOnce();
    });

    it('copies to the clipboard on platforms with no share sheet', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { clipboard: { writeText } });

        await shareOrCopy({ title: 'The Lantern', url: 'https://example.com/watch/abc' });

        expect(writeText).toHaveBeenCalledWith('https://example.com/watch/abc');
        expect(toasts.info).toHaveBeenCalledOnce();
    });

    it('never claims success when there is no navigator (SSR)', async () => {
        vi.stubGlobal('navigator', undefined);

        await shareOrCopy({ title: 'The Lantern', url: 'https://example.com/watch/abc' });

        expect(toasts.info).not.toHaveBeenCalled();
    });

    it('reports failure when there is no clipboard at all', async () => {
        vi.stubGlobal('navigator', {});

        await shareOrCopy({ title: 'The Lantern', url: 'https://example.com/watch/abc' });

        expect(toasts.error).toHaveBeenCalledOnce();
        expect(toasts.info).not.toHaveBeenCalled();
    });

    it('reports failure when the clipboard is blocked too', async () => {
        const writeText = vi.fn().mockRejectedValue(new Error('denied'));
        vi.stubGlobal('navigator', { clipboard: { writeText } });

        await shareOrCopy({ title: 'The Lantern', url: 'https://example.com/watch/abc' });

        expect(toasts.error).toHaveBeenCalledOnce();
        expect(toasts.info).not.toHaveBeenCalled();
    });
});
