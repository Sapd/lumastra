// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * VideoShortcuts
 * Handles keyboard shortcuts for video player
 * Extracted from VideoPlayer.svelte to reduce complexity
 */

import { mapKeyboardAction } from './video-input';

/**
 * Callbacks for keyboard actions
 * All callbacks should be simple function calls that trigger actions in the parent component
 */
export interface KeyboardCallbacks {
    // Playback control
    onTogglePlayPause: () => void;
    onSeek: (seconds: number) => void;
    onSeekToPercent: (percent: number) => void;
    onStartAcceleratingSeek: (direction: 'forward' | 'backward') => void;
    onStopAcceleratingSeek: () => void;

    // Volume control
    onAdjustVolume: (delta: number) => void;
    onToggleMute: () => void;
    onShowVolumeIndicator: () => void;

    // Subtitles
    onToggleSubtitles: () => void;

    // Fullscreen & UI
    onToggleFullscreen: () => void;
    onCloseAllOverlays: () => boolean; // Returns true if closed something
    onBack: () => void;

    // Speed control
    onAdjustSpeed: (delta: number) => void;

    // Frame stepping
    onStepFrame: (direction: number) => void;

    // Skipping
    onSkipSegment: () => void;
    onGoToNextItem: (event: CustomEvent) => void;

    // OSD indicators
    onShowSeekPercentIndicator: (percent: number) => void;

    // Watch party
    onShowWatchPartyBackConfirm: () => void;

    // Auto-skip cancel
    onCancelAutoSkip: () => void;
}

/**
 * State needed for keyboard shortcut handling
 * Passed as parameters to avoid tight coupling to component state
 */
export interface KeyboardState {
    isFullscreen: boolean;
    isWatchPartyGuest: boolean;
    overlayHasActiveAutoSkip: boolean;
    isActiveWatchPartyHost: boolean;
    activeSegment: {
        type: 'intro' | 'outro' | 'recap' | 'preview' | 'commercial';
        endMs: number;
    } | null;
    effectiveNextItem: {
        type: 'playlist' | 'episode';
        itemId: string;
        playlistId?: number;
        position?: number;
    } | null;
    showNextItemPrompt: boolean;
}

/**
 * VideoShortcuts class
 * Encapsulates keyboard handling logic for video player
 */
export class VideoShortcuts {
    private callbacks: KeyboardCallbacks;
    private seekKeys = ['ArrowLeft', 'ArrowRight', 'j', 'l'];

    constructor(callbacks: KeyboardCallbacks) {
        this.callbacks = callbacks;
    }

    /**
     * Handle keydown events
     * Main entry point for keyboard shortcuts
     */
    handleKeydown(event: KeyboardEvent, state: KeyboardState): void {
        const { action, percent, preventDefault } = mapKeyboardAction(event, state.isFullscreen);

        if (action === 'none') return;
        if (preventDefault) event.preventDefault();

        switch (action) {
            case 'toggle_play':
                this.callbacks.onTogglePlayPause();
                break;

            case 'toggle_fullscreen':
                this.callbacks.onToggleFullscreen();
                break;

            case 'toggle_mute':
                this.callbacks.onToggleMute();
                this.callbacks.onShowVolumeIndicator();
                break;

            case 'seek_backward':
                // Only seek on initial press, not on key repeat (timer handles acceleration)
                // Don't start acceleration for watch party guests on VOD (they can't seek)
                if (!event.repeat && !state.isWatchPartyGuest) {
                    this.callbacks.onSeek(-10); // SEEK.DEFAULT_SECONDS
                    this.callbacks.onStartAcceleratingSeek('backward');
                }
                break;

            case 'seek_forward':
                // Only seek on initial press, not on key repeat (timer handles acceleration)
                // Don't start acceleration for watch party guests on VOD (they can't seek)
                if (!event.repeat && !state.isWatchPartyGuest) {
                    this.callbacks.onSeek(10); // SEEK.DEFAULT_SECONDS
                    this.callbacks.onStartAcceleratingSeek('forward');
                }
                break;

            case 'volume_up':
                this.callbacks.onAdjustVolume(0.1);
                break;

            case 'volume_down':
                this.callbacks.onAdjustVolume(-0.1);
                break;

            case 'toggle_subtitles':
                this.callbacks.onToggleSubtitles();
                break;

            case 'exit_fullscreen':
                // Priority: 1) Cancel auto-skip, 2) Close overlays/menus, 3) Exit fullscreen
                if (state.overlayHasActiveAutoSkip) {
                    this.callbacks.onCancelAutoSkip();
                } else if (this.callbacks.onCloseAllOverlays()) {
                    // Closed a sidebar or menu, don't exit fullscreen
                } else {
                    this.callbacks.onToggleFullscreen();
                }
                break;

            case 'back':
                // Priority: 1) Cancel auto-skip, 2) Close overlays/menus, 3) Go back
                if (state.overlayHasActiveAutoSkip) {
                    this.callbacks.onCancelAutoSkip();
                } else if (this.callbacks.onCloseAllOverlays()) {
                    // Closed a sidebar or menu, don't go back
                } else if (state.isActiveWatchPartyHost) {
                    // Watch party host: show options instead of leaving directly
                    this.callbacks.onShowWatchPartyBackConfirm();
                } else {
                    this.callbacks.onBack();
                }
                break;

            case 'seek_to_percent':
                // Don't show indicator for watch party guests on VOD (they can't seek)
                if (percent !== undefined && !event.repeat && !state.isWatchPartyGuest) {
                    this.callbacks.onSeekToPercent(percent);
                    this.callbacks.onShowSeekPercentIndicator(percent);
                }
                break;

            case 'speed_up':
                if (!event.repeat) this.callbacks.onAdjustSpeed(1);
                break;

            case 'speed_down':
                if (!event.repeat) this.callbacks.onAdjustSpeed(-1);
                break;

            case 'frame_forward':
                if (!event.repeat) this.callbacks.onStepFrame(1);
                break;

            case 'frame_backward':
                if (!event.repeat) this.callbacks.onStepFrame(-1);
                break;

            case 'skip_or_next':
                // Context-aware: skip segment if visible, otherwise go to next item
                // Guests are followers: Enter must not bypass the disabled skip
                // overlay and issue a local seek while the host owns the party
                // position. That local seek can overlap the host barrier and leave
                // the guest paused at a stale target.
                if (!event.repeat && !state.isWatchPartyGuest) {
                    if (state.activeSegment) {
                        this.callbacks.onSkipSegment();
                    } else if (state.effectiveNextItem && state.showNextItemPrompt) {
                        const next = state.effectiveNextItem;
                        this.callbacks.onGoToNextItem(
                            new CustomEvent('nextItem', {
                                detail: {
                                    type: next.type,
                                    itemId: next.itemId,
                                    playlistId: next.playlistId,
                                    position: next.position,
                                },
                            }),
                        );
                    }
                }
                break;
        }
    }

    /**
     * Handle keyup events
     * Stops accelerating seek when arrow keys are released
     */
    handleKeyup(event: KeyboardEvent): void {
        if (this.seekKeys.includes(event.key)) {
            this.callbacks.onStopAcceleratingSeek();
        }
    }

    /**
     * Handle window blur
     * Stops accelerating seek when window loses focus (keyup might not fire)
     */
    handleWindowBlur(): void {
        this.callbacks.onStopAcceleratingSeek();
    }
}
