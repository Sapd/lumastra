// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import type { PlaybackInfo } from '$lib/types/playback';
import VideoOverlays from './VideoOverlays.svelte';
import { playerStore } from './playerStore.svelte';
import {
    recordAutoplayedEpisode,
    resetStillWatchingStreak,
    shouldPromptStillWatching,
} from './still-watching.js';

afterEach(() => {
    cleanup();
    playerStore.qualityMode = 'original';
    playerStore.playbackInfo = null;
    playerStore.title = '';
    playerStore.mediaType = null;
    playerStore.seriesName = undefined;
    playerStore.seasonNumber = undefined;
    playerStore.episodeNumber = undefined;
    playerStore.episodeStartNumber = undefined;
    playerStore.episodeEndNumber = undefined;
});

function setMoviePlaybackInfo() {
    playerStore.playbackInfo = {
        itemId: 'item-1',
        internalId: 'internal-1',
        title: 'Test Movie',
        mediaType: 'movie',
    } as unknown as PlaybackInfo;
    playerStore.title = 'Test Movie';
    playerStore.mediaType = 'movie';
}

describe('VideoOverlays audio-only backdrop gating', () => {
    it('renders the backdrop when qualityMode is audio-only', () => {
        playerStore.qualityMode = 'audio-only';
        setMoviePlaybackInfo();

        const { container } = render(VideoOverlays, { props: {} });

        expect(container.querySelector('.audio-only-backdrop')).toBeTruthy();
    });

    it('does not render the backdrop for other quality modes', () => {
        playerStore.qualityMode = 'auto';
        setMoviePlaybackInfo();

        const { container } = render(VideoOverlays, { props: {} });

        expect(container.querySelector('.audio-only-backdrop')).toBeFalsy();
    });

    it('does not render the backdrop without playback info even in audio-only mode', () => {
        playerStore.qualityMode = 'audio-only';
        playerStore.playbackInfo = null;

        const { container } = render(VideoOverlays, { props: {} });

        expect(container.querySelector('.audio-only-backdrop')).toBeFalsy();
    });
});

describe('VideoOverlays still-watching gate', () => {
    const NEXT_EPISODE = {
        type: 'episode' as const,
        itemId: 'ep-2',
        title: 'The Next One',
        seriesName: 'Test Series',
        seasonNumber: 1,
        episodeNumber: 2,
        hasPrimaryImage: false,
    };

    function setEpisodePlayback() {
        playerStore.mediaType = 'episode';
        playerStore.seriesName = 'Test Series';
        playerStore.seasonNumber = 1;
        playerStore.episodeNumber = 1;
    }

    function renderPrompt(props: Record<string, unknown> = {}) {
        return render(VideoOverlays, {
            props: {
                showNextItemPrompt: true,
                nextItem: NEXT_EPISODE,
                autoPlayNextEnabled: true,
                autoSkipCreditsDelay: 10,
                ...props,
            },
        });
    }

    beforeEach(() => {
        sessionStorage.clear();
        setEpisodePlayback();
    });

    it('counts down as usual when no episodes have auto-played', async () => {
        const { container } = renderPrompt({ stillWatchingEnabled: true });
        await tick();

        expect(container.querySelector('.countdown-circle')).toBeTruthy();
        expect(container.querySelector('.still-watching-label')).toBeFalsy();
    });

    it('holds the countdown after two unattended auto-played episodes', async () => {
        recordAutoplayedEpisode('Test Series', 'ep-2');
        recordAutoplayedEpisode('Test Series', 'ep-2');

        const { container } = renderPrompt({ stillWatchingEnabled: true });
        await tick();

        expect(container.querySelector('.countdown-circle')).toBeFalsy();
        expect(container.querySelector('.still-watching-label')).toBeTruthy();
    });

    it('still counts down when the viewer has not opted in', async () => {
        recordAutoplayedEpisode('Test Series', 'ep-2');
        recordAutoplayedEpisode('Test Series', 'ep-2');

        const { container } = renderPrompt({ stillWatchingEnabled: false });
        await tick();

        expect(container.querySelector('.countdown-circle')).toBeTruthy();
        expect(container.querySelector('.still-watching-label')).toBeFalsy();
    });

    it('keeps holding even if the viewer jiggles the mouse while it is up', async () => {
        recordAutoplayedEpisode('Test Series', 'ep-2');
        recordAutoplayedEpisode('Test Series', 'ep-2');

        const { container } = renderPrompt({ stillWatchingEnabled: true });
        await tick();
        resetStillWatchingStreak();
        await tick();

        expect(container.querySelector('.countdown-circle')).toBeFalsy();
        expect(container.querySelector('.still-watching-label')).toBeTruthy();
    });

    it('offers an explicit way to answer the question', async () => {
        recordAutoplayedEpisode('Test Series', 'ep-2');
        recordAutoplayedEpisode('Test Series', 'ep-2');

        let advancedTo: string | null = null;
        const { container } = renderPrompt({
            stillWatchingEnabled: true,
            onnextitem: (detail: { itemId: string }) => {
                advancedTo = detail.itemId;
            },
        });
        await tick();

        const confirm = container.querySelector('.still-watching-continue') as HTMLElement;
        expect(confirm).toBeTruthy();
        confirm.click();
        await tick();

        expect(advancedTo).toBe('ep-2');
        expect(shouldPromptStillWatching('Test Series')).toBe(false);
    });

    it('offers no such button during an ordinary countdown', async () => {
        const { container } = renderPrompt({ stillWatchingEnabled: true });
        await tick();

        expect(container.querySelector('.still-watching-continue')).toBeFalsy();
    });

    it('never holds audio-only playback, whatever the streak says', async () => {
        recordAutoplayedEpisode('Test Series', 'ep-2');
        recordAutoplayedEpisode('Test Series', 'ep-2');
        // Streak banked while watching; the viewer then switched to audio-only,
        // which exists precisely to keep running unattended.
        playerStore.qualityMode = 'audio-only';

        const { container } = renderPrompt({ stillWatchingEnabled: true });
        await tick();

        expect(container.querySelector('.still-watching-label')).toBeFalsy();
        expect(container.querySelector('.countdown-circle')).toBeTruthy();
    });

    it('releases its grip on credits auto-skip once the prompt closes', async () => {
        recordAutoplayedEpisode('Test Series', 'ep-2');
        recordAutoplayedEpisode('Test Series', 'ep-2');

        const { container, rerender } = renderPrompt({
            stillWatchingEnabled: true,
            autoSkipCreditsEnabled: true,
        });
        await tick();
        expect(container.querySelector('.still-watching-label')).toBeTruthy();

        // Viewer seeks back out of the prompt window; credits auto-skip is a
        // separate setting and must not stay disabled behind a stale hold.
        await rerender({
            showNextItemPrompt: false,
            nextItem: null,
            autoPlayNextEnabled: true,
            autoSkipCreditsDelay: 10,
            stillWatchingEnabled: true,
            autoSkipCreditsEnabled: true,
            activeSegment: { type: 'outro', endMs: 100_000 },
        });
        await tick();

        expect(container.querySelector('.countdown-badge')).toBeTruthy();
    });

    it('clears the streak when the viewer confirms', async () => {
        recordAutoplayedEpisode('Test Series', 'ep-2');
        recordAutoplayedEpisode('Test Series', 'ep-2');

        let advancedTo: string | null = null;
        const { container } = renderPrompt({
            stillWatchingEnabled: true,
            onnextitem: (detail: { itemId: string }) => {
                advancedTo = detail.itemId;
            },
        });
        await tick();

        (container.querySelector('.next-episode-button') as HTMLElement).click();
        await tick();

        expect(advancedTo).toBe('ep-2');
        expect(shouldPromptStillWatching('Test Series')).toBe(false);
    });
});

describe('player logo failures', () => {
    it('removes failed artwork and does not request it again after a player remount', async () => {
        const logoUrl = '/api/media/missing-logo/images/logo?fallback=none';
        const onlogoerror = vi.fn();
        const view = render(VideoOverlays, { logoUrl, onlogoerror });
        const img = view.container.querySelector('.player-logo') as HTMLImageElement;
        expect(img.getAttribute('src')).toBe(logoUrl);
        // Image errors do not expose HTTP status. A missing logo (404) must
        // stop using this URL for the tab, including after remounts.
        await fireEvent.error(img);
        expect(onlogoerror).toHaveBeenCalledWith(logoUrl);
        expect(view.container.querySelector('.player-logo')).toBeNull();
        view.unmount();
        const next = render(VideoOverlays, { logoUrl });
        expect(next.container.querySelector('.player-logo')).toBeNull();
        await next.rerender({ logoUrl: '/api/media/other/images/logo?fallback=none' });
        expect(next.container.querySelector('.player-logo')).toBeTruthy();
    });
});
