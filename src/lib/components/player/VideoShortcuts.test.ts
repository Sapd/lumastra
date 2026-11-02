// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { VideoShortcuts, type KeyboardCallbacks, type KeyboardState } from './VideoShortcuts';

function callbacks(): KeyboardCallbacks {
    return {
        onTogglePlayPause: vi.fn(),
        onSeek: vi.fn(),
        onSeekToPercent: vi.fn(),
        onStartAcceleratingSeek: vi.fn(),
        onStopAcceleratingSeek: vi.fn(),
        onAdjustVolume: vi.fn(),
        onToggleMute: vi.fn(),
        onShowVolumeIndicator: vi.fn(),
        onToggleSubtitles: vi.fn(),
        onToggleFullscreen: vi.fn(),
        onCloseAllOverlays: vi.fn(() => false),
        onBack: vi.fn(),
        onAdjustSpeed: vi.fn(),
        onStepFrame: vi.fn(),
        onSkipSegment: vi.fn(),
        onGoToNextItem: vi.fn(),
        onShowSeekPercentIndicator: vi.fn(),
        onShowWatchPartyBackConfirm: vi.fn(),
        onCancelAutoSkip: vi.fn(),
    };
}

const guestWithIntro: KeyboardState = {
    isFullscreen: false,
    isWatchPartyGuest: true,
    overlayHasActiveAutoSkip: false,
    isActiveWatchPartyHost: false,
    activeSegment: { type: 'intro', endMs: 90_000 },
    effectiveNextItem: null,
    showNextItemPrompt: false,
};

describe('VideoShortcuts watch-party guest restrictions', () => {
    it('does not let Enter skip an intro for a guest', () => {
        const handlers = callbacks();
        const shortcuts = new VideoShortcuts(handlers);

        shortcuts.handleKeydown(new KeyboardEvent('keydown', { key: 'Enter' }), guestWithIntro);

        expect(handlers.onSkipSegment).not.toHaveBeenCalled();
    });
});

describe('VideoShortcuts respects focused controls', () => {
    const state = { ...guestWithIntro, isWatchPartyGuest: false };
    it.each(['button', 'select', 'textarea', 'input'])('leaves Enter and Space to %s', (tag) => {
        const handlers = callbacks();
        const shortcuts = new VideoShortcuts(handlers);
        const target = document.createElement(tag);
        for (const key of ['Enter', ' ']) {
            const event = new KeyboardEvent('keydown', { key, cancelable: true });
            Object.defineProperty(event, 'target', { value: target });
            shortcuts.handleKeydown(event, state);
            expect(event.defaultPrevented).toBe(false);
        }
        expect(handlers.onSkipSegment).not.toHaveBeenCalled();
        expect(handlers.onTogglePlayPause).not.toHaveBeenCalled();
    });
    it('does not seek for a volume slider event already handled locally', () => {
        const handlers = callbacks();
        const event = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true });
        event.preventDefault();
        new VideoShortcuts(handlers).handleKeydown(event, state);
        expect(handlers.onSeek).not.toHaveBeenCalled();
    });
    it.each([{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }])(
        'preserves browser and composition keys: %j',
        (modifiers) => {
            const handlers = callbacks();
            new VideoShortcuts(handlers).handleKeydown(
                new KeyboardEvent('keydown', { key: 'f', ...modifiers }),
                state,
            );
            expect(handlers.onToggleFullscreen).not.toHaveBeenCalled();
        },
    );
    it('ignores typing in nested editable content', () => {
        const parent = document.createElement('div');
        parent.setAttribute('contenteditable', 'true');
        const child = parent.appendChild(document.createElement('span'));
        const event = new KeyboardEvent('keydown', { key: 'k' });
        Object.defineProperty(event, 'target', { value: child });
        const handlers = callbacks();
        new VideoShortcuts(handlers).handleKeydown(event, state);
        expect(handlers.onTogglePlayPause).not.toHaveBeenCalled();
    });
    it('still closes menus with Escape from a focused button', () => {
        const handlers = callbacks();
        vi.mocked(handlers.onCloseAllOverlays).mockReturnValue(true);
        const event = new KeyboardEvent('keydown', { key: 'Escape' });
        Object.defineProperty(event, 'target', { value: document.createElement('button') });
        new VideoShortcuts(handlers).handleKeydown(event, state);
        expect(handlers.onCloseAllOverlays).toHaveBeenCalledOnce();
        expect(handlers.onBack).not.toHaveBeenCalled();
    });
});

it('keeps single-letter playback shortcuts working after focusing a control', () => {
    const handlers = callbacks();
    const event = new KeyboardEvent('keydown', { key: 'k' });
    Object.defineProperty(event, 'target', { value: document.createElement('button') });
    new VideoShortcuts(handlers).handleKeydown(event, guestWithIntro);
    expect(handlers.onTogglePlayPause).toHaveBeenCalledOnce();
});

it('allows Escape to close menus while their search field is focused', () => {
    const handlers = callbacks();
    vi.mocked(handlers.onCloseAllOverlays).mockReturnValue(true);
    const event = new KeyboardEvent('keydown', { key: 'Escape' });
    Object.defineProperty(event, 'target', { value: document.createElement('input') });
    new VideoShortcuts(handlers).handleKeydown(event, guestWithIntro);
    expect(handlers.onCloseAllOverlays).toHaveBeenCalledOnce();
    expect(handlers.onBack).not.toHaveBeenCalled();
});
