// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { afterFirstVideoFrame, shouldBootstrapWatchModals } from './watch-startup-work';

type FrameCallback = Parameters<HTMLVideoElement['requestVideoFrameCallback']>[0];

beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

it('keeps explicit dialogs and non-watch routes immediate', () => {
    expect(shouldBootstrapWatchModals(true, false, false, new URLSearchParams())).toBe(false);
    expect(shouldBootstrapWatchModals(false, false, false, new URLSearchParams())).toBe(true);
    expect(shouldBootstrapWatchModals(true, true, false, new URLSearchParams())).toBe(true);
    expect(shouldBootstrapWatchModals(true, false, true, new URLSearchParams())).toBe(true);
    for (const key of ['modal', 'actor', 'artist', 'album']) {
        expect(
            shouldBootstrapWatchModals(
                true,
                false,
                false,
                new URLSearchParams({ [key]: 'requested' }),
            ),
        ).toBe(true);
    }
});

it('waits for a frame from a video that appears after layout mount', () => {
    const ready = vi.fn();
    const stop = afterFirstVideoFrame(document, ready);
    const video = document.createElement('video');
    let frame!: FrameCallback;
    video.requestVideoFrameCallback = vi.fn((callback) => {
        frame = callback;
        return 7;
    });
    video.cancelVideoFrameCallback = vi.fn();
    document.body.append(video);
    video.dispatchEvent(new Event('playing'));
    expect(ready).not.toHaveBeenCalled();
    frame(1, {} as Parameters<FrameCallback>[1]);
    expect(ready).toHaveBeenCalledTimes(1);
    video.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(20_000);
    expect(ready).toHaveBeenCalledTimes(1);
    stop();
});

it('supports browsers without video frame callbacks', () => {
    const ready = vi.fn();
    const video = document.createElement('video');
    Object.defineProperty(video, 'requestVideoFrameCallback', { value: undefined });
    document.body.append(video);
    const stop = afterFirstVideoFrame(document, ready);
    video.dispatchEvent(new Event('playing'));
    expect(ready).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30);
    expect(ready).toHaveBeenCalledTimes(1);
    stop();
});

it('cleans up pending frames and ignores late callbacks after unmount', () => {
    const ready = vi.fn();
    const video = document.createElement('video');
    let frame!: FrameCallback;
    video.requestVideoFrameCallback = vi.fn((callback) => {
        frame = callback;
        return 9;
    });
    video.cancelVideoFrameCallback = vi.fn();
    document.body.append(video);
    const stop = afterFirstVideoFrame(document, ready, 100);
    video.dispatchEvent(new Event('playing'));
    stop();
    frame(1, {} as Parameters<FrameCallback>[1]);
    vi.advanceTimersByTime(1000);
    expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(9);
    expect(ready).not.toHaveBeenCalled();
});

it('releases background work after a bounded failure to start video', () => {
    const ready = vi.fn();
    const stop = afterFirstVideoFrame(document, ready, 1000);
    vi.advanceTimersByTime(999);
    expect(ready).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ready).toHaveBeenCalledTimes(1);
    stop();
});

it('handles a video already playing when the layout subscribes', () => {
    const ready = vi.fn();
    const video = document.createElement('video');
    Object.defineProperty(video, 'paused', { value: false });
    Object.defineProperty(video, 'readyState', { value: 4 });
    let frame!: FrameCallback;
    video.requestVideoFrameCallback = vi.fn((callback) => {
        frame = callback;
        return 1;
    });
    document.body.append(video);
    const stop = afterFirstVideoFrame(document, ready);
    expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(1);
    frame(1, {} as Parameters<FrameCallback>[1]);
    expect(ready).toHaveBeenCalledTimes(1);
    stop();
});
