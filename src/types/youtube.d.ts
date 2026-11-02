// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

declare namespace YT {
    interface PlayerOptions {
        videoId?: string;
        width?: string | number;
        height?: string | number;
        playerVars?: Record<string, unknown>;
        events?: {
            onReady?: (event: PlayerEvent) => void;
            onStateChange?: (event: PlayerStateChangeEvent) => void;
            onError?: (event: PlayerEvent) => void;
        };
        host?: string;
        mute?: number;
    }

    interface PlayerEvent {
        target: Player;
    }

    interface PlayerStateChangeEvent extends PlayerEvent {
        data: PlayerState;
    }

    enum PlayerState {
        ENDED = 0,
        PLAYING = 1,
        PAUSED = 2,
        BUFFERING = 3,
        CUED = 5,
    }

    class Player {
        constructor(elementId: string | HTMLElement, options?: PlayerOptions);
        playVideo(): void;
        pauseVideo(): void;
        mute(): void;
        unMute(): void;
        setVolume(volume: number): void;
        getCurrentTime(): number;
        destroy(): void;
        videoTitle?: string;
    }
}
