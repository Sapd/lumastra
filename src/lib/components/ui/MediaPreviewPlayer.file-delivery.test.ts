// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

const api = vi.hoisted(() => ({ create: vi.fn(), loadSource: vi.fn(), construct: vi.fn() }));
vi.mock('hls.js', () => ({
    default: class {
        static isSupported() {
            return true;
        }
        static Events = {};
        constructor() {
            api.construct();
        }
        loadSource = api.loadSource;
        attachMedia() {}
        on() {}
        destroy() {}
    },
}));
vi.mock('$lib/api/playback', () => ({
    createPreviewSession: api.create,
    releasePreviewPlayback: vi.fn(),
}));
vi.mock('$app/stores', () => ({
    page: readable({ data: { hover: {} }, url: new URL('http://localhost/') }),
}));
import MediaPreviewPlayer from './MediaPreviewPlayer.svelte';
import { __resetPreviewSessionCacheForTests } from '$lib/utils/preview-session-cache';

beforeEach(() => {
    vi.clearAllMocks();
    __resetPreviewSessionCacheForTests();
    api.create.mockResolvedValue({
        status: 201,
        error: null,
        data: {
            mode: 'preview',
            playSessionId: 'preview',
            sessionItemId: 'media',
            streamUrl: '/issued/compatible-720p.mp4?grant=opaque',
            deliveryKind: 'file',
            hlsStartPosition: 12,
        },
    });
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { status: 204 })),
    );
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
});
afterEach(() => {
    cleanup();
    __resetPreviewSessionCacheForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

it('loads an issued MP4 directly at the start position and retains its kind through memo reuse', async () => {
    const onTimeUpdate = vi.fn();
    const props = { internalId: 'media', itemId: 'media', startPositionSeconds: 12, onTimeUpdate };
    const first = render(MediaPreviewPlayer, { props });
    const video = first.container.querySelector('video')!;
    await vi.waitFor(() =>
        expect(video.getAttribute('src')).toBe('/issued/compatible-720p.mp4?grant=opaque'),
    );
    await fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(12);
    await fireEvent.timeUpdate(video);
    expect(onTimeUpdate).toHaveBeenLastCalledWith(12);
    expect(api.construct).not.toHaveBeenCalled();
    expect(api.loadSource).not.toHaveBeenCalled();
    first.unmount();
    const second = render(MediaPreviewPlayer, { props });
    const next = second.container.querySelector('video')!;
    await vi.waitFor(() =>
        expect(next.getAttribute('src')).toBe('/issued/compatible-720p.mp4?grant=opaque'),
    );
    await fireEvent.loadedMetadata(next);
    expect(next.currentTime).toBe(12);
    expect(api.create).toHaveBeenCalledOnce();
});
