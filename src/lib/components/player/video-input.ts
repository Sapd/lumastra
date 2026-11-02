// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Video Input Handler
 *
 * Handles keyboard and touch input for the video player.
 * Maps key events to action strings for clean separation of concerns.
 */

/**
 * Player actions that can be triggered by input
 */
export type PlayerAction =
    | 'toggle_play'
    | 'toggle_fullscreen'
    | 'toggle_mute'
    | 'seek_backward'
    | 'seek_forward'
    | 'volume_up'
    | 'volume_down'
    | 'toggle_subtitles'
    | 'exit_fullscreen'
    | 'back'
    | 'seek_to_percent'
    | 'speed_up'
    | 'speed_down'
    | 'frame_forward'
    | 'frame_backward'
    | 'skip_or_next'
    | 'none';

/**
 * Result from mapping a keyboard event to an action
 */
export interface KeyboardActionResult {
    action: PlayerAction;
    /** For seek_to_percent, the target percentage (0-100) */
    percent?: number;
    /** Whether the default browser action should be prevented */
    preventDefault: boolean;
}

/**
 * Map a keyboard event to a player action
 *
 * @param event - The keyboard event
 * @param isFullscreen - Whether the player is currently in fullscreen mode
 * @returns The action to perform and whether to prevent default
 */
export function mapKeyboardAction(
    event: KeyboardEvent,
    isFullscreen: boolean,
): KeyboardActionResult {
    // Local widgets and browser shortcuts own their keys. In particular, Enter
    // and Space on menu buttons must activate the button rather than seek/play.
    const target = event.target instanceof Element ? event.target : null;
    if (
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (event.key !== 'Escape' &&
            target?.closest(
                'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="menu"], [role="listbox"], [role="slider"]',
            )) ||
        ((event.key === 'Enter' || event.key === ' ') &&
            target?.closest('button, a[href], [role="button"]'))
    ) {
        return { action: 'none', preventDefault: false };
    }

    switch (event.key) {
        case ' ':
        case 'k':
            return { action: 'toggle_play', preventDefault: true };

        case 'f':
            return { action: 'toggle_fullscreen', preventDefault: true };

        case 'm':
            return { action: 'toggle_mute', preventDefault: true };

        case 'ArrowLeft':
            return { action: 'seek_backward', preventDefault: true };

        case 'ArrowRight':
            return { action: 'seek_forward', preventDefault: true };

        case 'ArrowUp':
            return { action: 'volume_up', preventDefault: true };

        case 'ArrowDown':
            return { action: 'volume_down', preventDefault: true };

        case 'c':
            return { action: 'toggle_subtitles', preventDefault: true };

        // J/L - YouTube-style seek (same as arrow keys)
        case 'j':
            return { action: 'seek_backward', preventDefault: true };

        case 'l':
            return { action: 'seek_forward', preventDefault: true };

        // Speed control: > (Shift+.) and < (Shift+,)
        case '>':
            return { action: 'speed_up', preventDefault: true };

        case '<':
            return { action: 'speed_down', preventDefault: true };

        // Frame stepping: . and , (when paused)
        case '.':
            return { action: 'frame_forward', preventDefault: true };

        case ',':
            return { action: 'frame_backward', preventDefault: true };

        // Enter - Skip intro/credits segment or go to next item (context-aware)
        case 'Enter':
            return { action: 'skip_or_next', preventDefault: true };

        case 'Escape':
            if (isFullscreen) {
                return { action: 'exit_fullscreen', preventDefault: true };
            }
            return { action: 'back', preventDefault: false };

        case '0':
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6':
        case '7':
        case '8':
        case '9':
            return {
                action: 'seek_to_percent',
                percent: parseInt(event.key) * 10,
                preventDefault: true,
            };

        default:
            return { action: 'none', preventDefault: false };
    }
}

/**
 * Double-tap detection state
 */
export interface DoubleTapState {
    lastTapTime: number;
    lastTapSide: 'left' | 'right' | null;
}

/**
 * Create initial double-tap state
 */
export function createDoubleTapState(): DoubleTapState {
    return {
        lastTapTime: 0,
        lastTapSide: null,
    };
}

/**
 * Result from detecting a double-tap
 */
export interface DoubleTapResult {
    isDoubleTap: boolean;
    side: 'left' | 'right';
    newState: DoubleTapState;
}

/**
 * Detect double-tap on video for skip functionality
 *
 * @param event - The mouse or touch event
 * @param state - Current double-tap tracking state
 * @param containerRect - Bounding rect of the video container
 * @returns Result indicating if double-tap was detected and on which side
 */
export function detectDoubleTap(
    event: MouseEvent | TouchEvent,
    state: DoubleTapState,
    containerRect: DOMRect,
): DoubleTapResult {
    const now = Date.now();

    // Get tap position
    const clientX = 'touches' in event ? event.changedTouches[0].clientX : event.clientX;
    const tapX = clientX - containerRect.left;
    const tapSide: 'left' | 'right' = tapX < containerRect.width / 2 ? 'left' : 'right';

    // Check for double tap (within 300ms and same side)
    const isDoubleTap = now - state.lastTapTime < 300 && tapSide === state.lastTapSide;

    if (isDoubleTap) {
        // Reset state after successful double-tap
        return {
            isDoubleTap: true,
            side: tapSide,
            newState: { lastTapTime: 0, lastTapSide: null },
        };
    }

    // Single tap - record it
    return {
        isDoubleTap: false,
        side: tapSide,
        newState: { lastTapTime: now, lastTapSide: tapSide },
    };
}

/**
 * Skip animation state for UI feedback
 */
export interface SkipAnimationState {
    side: 'left' | 'right';
    amount: number;
}

/**
 * Update skip animation state for accumulated skips
 *
 * @param currentState - Current animation state (null if none)
 * @param side - Side of the skip (left = backward, right = forward)
 * @param skipAmount - Amount of seconds to skip (absolute value)
 * @returns New animation state
 */
export function updateSkipAnimation(
    currentState: SkipAnimationState | null,
    side: 'left' | 'right',
    skipAmount: number,
): SkipAnimationState {
    // Accumulate skip amount if same side
    const currentAmount =
        currentState?.side === side ? currentState.amount + skipAmount : skipAmount;

    return { side, amount: currentAmount };
}
