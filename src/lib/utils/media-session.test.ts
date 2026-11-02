// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initMediaSession, updateMediaSessionPositionState } from './media-session';

vi.mock('$app/environment', () => ({
    browser: true,
}));

describe('media-session helpers', () => {
    const setActionHandler = vi.fn();
    const setPositionState = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        Object.defineProperty(globalThis, 'MediaMetadata', {
            value: vi.fn(function MediaMetadata(metadata) {
                return metadata;
            }),
            configurable: true,
        });
        Object.defineProperty(navigator, 'mediaSession', {
            value: {
                metadata: null,
                playbackState: 'none',
                setActionHandler,
                setPositionState,
            },
            configurable: true,
        });
    });

    it('clears all seek actions and position state in track-controls-only mode', () => {
        initMediaSession(
            { title: 'Song', artist: 'Artist' },
            {
                onPlay: vi.fn(),
                onPause: vi.fn(),
                onNextTrack: vi.fn(),
                onPreviousTrack: vi.fn(),
                onSeekTo: vi.fn(),
                onSeekForward: vi.fn(),
                onSeekBackward: vi.fn(),
            },
            { trackControlsOnly: true },
        );

        expect(setActionHandler).toHaveBeenCalledWith('nexttrack', expect.any(Function));
        expect(setActionHandler).toHaveBeenCalledWith('previoustrack', expect.any(Function));
        expect(setActionHandler).toHaveBeenCalledWith('seekto', null);
        expect(setActionHandler).toHaveBeenCalledWith('seekforward', null);
        expect(setActionHandler).toHaveBeenCalledWith('seekbackward', null);
        expect(setPositionState).toHaveBeenCalledWith();

        updateMediaSessionPositionState(200, 20);
        expect(setPositionState).toHaveBeenCalledTimes(1);
    });

    it('allows absolute seeking without seek-skip actions in seekable track-controls mode', () => {
        const onSeekTo = vi.fn();

        initMediaSession(
            { title: 'Song', artist: 'Artist' },
            {
                onNextTrack: vi.fn(),
                onPreviousTrack: vi.fn(),
                onSeekTo,
                onSeekForward: vi.fn(),
                onSeekBackward: vi.fn(),
            },
            { trackControlsOnly: true, seekToWithTrackControls: true },
        );

        expect(setActionHandler).toHaveBeenCalledWith('nexttrack', expect.any(Function));
        expect(setActionHandler).toHaveBeenCalledWith('previoustrack', expect.any(Function));
        expect(setActionHandler).toHaveBeenCalledWith('seekto', expect.any(Function));
        expect(setActionHandler).toHaveBeenCalledWith('seekforward', null);
        expect(setActionHandler).toHaveBeenCalledWith('seekbackward', null);
        expect(setPositionState).not.toHaveBeenCalled();

        updateMediaSessionPositionState(200, 20);
        expect(setPositionState).toHaveBeenCalledWith({
            duration: 200,
            position: 20,
            playbackRate: 1,
        });
    });

    it('allows position state again after a normal media session init', () => {
        initMediaSession(
            { title: 'Video' },
            {
                onSeekTo: vi.fn(),
            },
        );

        updateMediaSessionPositionState(200, 20);
        expect(setPositionState).toHaveBeenCalledWith({
            duration: 200,
            position: 20,
            playbackRate: 1,
        });
    });
});
