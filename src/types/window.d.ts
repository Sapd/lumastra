// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Extended Window interface for additional browser globals used in the player utilities.
// YouTube IFrame API types (YT namespace + Window.YT) are declared in src/app.d.ts.
declare global {
    interface Window {
        videoPlayers?: Array<{
            playVideo: () => void;
            mute: () => void;
            unMute: () => void;
            pauseVideo?: () => void;
            setVolume?: (volume: number) => void;
            stopVideo?: () => void;
            destroy?: () => void;
        } | null>;
        testWatchlistBinding?: unknown;
        testMovieSavedEvent?: unknown;
    }
}

export {};
