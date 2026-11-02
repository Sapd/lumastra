// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';
import type { PlayerController } from './player-controller.svelte';
import { DEFAULT_SUBTITLE_STYLE, playbackPreferences } from './preferences-sync.svelte';

const controllerRef = vi.hoisted(() => ({ current: null as unknown }));
const logoCallbacks = vi.hoisted(() => ({
    current: null as {
        activeSegment: unknown;
        showNextItemPrompt: boolean;
        onlogoerror: (url: string) => void;
        onlogoload: (url: string) => void;
    } | null,
}));

vi.mock('./player-controller.svelte', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./player-controller.svelte')>();
    class OverlayTestController extends actual.PlayerController {
        constructor(props: ConstructorParameters<typeof actual.PlayerController>[0]) {
            super(props);
            this.activeSrtCue = 'Caption position regression';
            controllerRef.current = this;
        }

        // Keep the real position derivation while avoiding playback/session effects.
        override initEffects(): void {}
        override async mount(): Promise<undefined> {
            return undefined;
        }
        override destroy(): void {}
    }
    return { ...actual, PlayerController: OverlayTestController };
});

vi.mock('$app/navigation', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$app/navigation')>()),
    onNavigate: vi.fn(),
}));
vi.mock('$app/stores', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$app/stores')>()),
    page: {
        subscribe: (run: (value: { data: object }) => void) => {
            run({ data: {} });
            return () => {};
        },
    },
}));
vi.mock('./still-watching', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./still-watching')>()),
    startViewerActivityTracking: vi.fn(() => () => {}),
    noteEpisodeArrival: vi.fn(),
}));
vi.mock('$lib/stores/watchTogether.svelte', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/stores/watchTogether.svelte')>()),
    watchTogether: { isInWatchParty: false, watchPartyParticipants: [], session: null },
}));

// Other player panels are outside this composition seam. Keep the real player
// shell, controller position derivation, and rendered text overlay.
vi.mock('./PlayerControls.svelte', () => ({ default: vi.fn() }));
vi.mock('./PlayerOverlay.svelte', () => ({ default: vi.fn() }));
vi.mock('./LiveTvOverlay.svelte', () => ({ default: vi.fn() }));
vi.mock('./ChannelSwitcher.svelte', () => ({ default: vi.fn() }));
vi.mock('$lib/components/livetv/StreamFailureOverlay.svelte', () => ({ default: vi.fn() }));
vi.mock('$lib/components/livetv/LiveTvFailureCard.svelte', () => ({ default: vi.fn() }));
vi.mock('$lib/components/livetv/LiveTvKickedOverlay.svelte', () => ({ default: vi.fn() }));
vi.mock('./MovieSidebar.svelte', () => ({ default: vi.fn() }));
vi.mock('./EpisodeBrowser.svelte', () => ({ default: vi.fn() }));
vi.mock('./PlaylistBrowser.svelte', () => ({ default: vi.fn() }));
vi.mock('$lib/Search.svelte', () => ({ default: vi.fn() }));
vi.mock('./WatchTogetherOverlay.svelte', () => ({ default: vi.fn() }));
vi.mock('./WatchPartyAvatarCluster.svelte', () => ({ default: vi.fn() }));
vi.mock('./WatchPartyBackDialog.svelte', () => ({ default: vi.fn() }));
vi.mock('./WatchTogetherToast.svelte', () => ({ default: vi.fn() }));
vi.mock('./ReactionOverlay.svelte', () => ({ default: vi.fn() }));
vi.mock('./ScreenEffectsOverlay.svelte', () => ({ default: vi.fn() }));
vi.mock('./SyncStatusIndicator.svelte', () => ({ default: vi.fn() }));
vi.mock('./VideoOverlays.svelte', () => ({
    default: vi.fn((_anchor, props) => {
        logoCallbacks.current = props;
    }),
}));
vi.mock('./AutoplayMutedPrompt.svelte', () => ({ default: vi.fn() }));
vi.mock('./TabConflictModal.svelte', () => ({ default: vi.fn() }));
vi.mock('./AnnotationsSidebar.svelte', () => ({ default: vi.fn() }));
vi.mock('./AnnotationPopup.svelte', () => ({ default: vi.fn() }));
vi.mock('$lib/components/plugins/PluginPlayerRegion.svelte', () => ({ default: vi.fn() }));

import VideoPlayer from './VideoPlayer.svelte';
import { playerStore } from './playerStore.svelte';

afterEach(() => {
    cleanup();
    playerStore.reset();
    playbackPreferences.subtitleStyle = { ...DEFAULT_SUBTITLE_STYLE };
    vi.restoreAllMocks();
    controllerRef.current = null;
});

test('mounted player overlay follows effective preference position and mobile landscape cap', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    );
    const width = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
    const height = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
    playbackPreferences.subtitleStyle = { ...DEFAULT_SUBTITLE_STYLE, positionY: 85 };

    const view = render(VideoPlayer, {
        playbackInfo: {
            itemId: 'subtitle-position-test',
            title: 'Caption test',
            mediaType: 'movie',
            runTimeTicks: 0,
            userData: { playbackPositionTicks: 0, playedPercentage: 0, played: false },
            resumeAnchor: null,
            isWatched: false,
            mediaSources: [],
            playSessionId: 'subtitle-position-session',
        },
        username: 'viewer',
        userId: 'viewer',
    });
    const controller = controllerRef.current as PlayerController;
    const overlay = view.container.querySelector('.portrait-subtitle-overlay') as HTMLElement;
    expect(overlay.textContent).toBe('Caption position regression');
    expect(controller.effectiveSubtitleLineY).toBe(85);
    expect(overlay.style.top).toBe('85%');

    playbackPreferences.subtitleStyle = { ...DEFAULT_SUBTITLE_STYLE, positionY: 64 };
    await vi.waitFor(() => expect(overlay.style.top).toBe('64%'));
    expect(controller.effectiveSubtitleLineY).toBe(64);

    width.mockReturnValue(844);
    height.mockReturnValue(390);
    playbackPreferences.subtitleStyle = { ...DEFAULT_SUBTITLE_STYLE, positionY: 85 };
    controller.videoHeight += 1; // ResizeObserver's orientation signal.
    await vi.waitFor(() => expect(overlay.style.top).toBe('72%'));
    expect(controller.effectiveSubtitleLineY).toBe(72);
    expect(view.container.querySelector('.portrait-subtitle-overlay')).toBe(overlay);

    width.mockReturnValue(390);
    height.mockReturnValue(844);
    controller.videoHeight += 1;
    await vi.waitFor(() => expect(overlay.style.top).toBe('85%'));
    expect(controller.effectiveSubtitleLineY).toBe(85);
});

test('late logo events after navigation do not read discarded playback props', () => {
    render(VideoPlayer, {
        playbackInfo: {
            itemId: 'late-logo-test',
            title: 'Movie',
            mediaType: 'movie',
            runTimeTicks: 0,
            userData: { playbackPositionTicks: 0, playedPercentage: 0, played: false },
            resumeAnchor: null,
            isWatched: false,
            mediaSources: [],
            playSessionId: 'logo-session',
        },
        username: 'viewer',
        userId: 'viewer',
    });
    const controller = controllerRef.current as PlayerController;
    const callbacks = logoCallbacks.current!;
    Object.defineProperty(controller, 'props', { value: {} });
    expect(() => callbacks.onlogoerror('/api/media/old/images/logo')).not.toThrow();
    expect(() => callbacks.onlogoload('/api/media/old/images/logo')).not.toThrow();
    expect(controller.logoUrl).toBeNull();
});

test('saved credits cannot start skip or next-episode overlays before canonical startup is resolved', async () => {
    const playbackInfo = {
        itemId: 'startup-episode',
        title: 'Startup',
        mediaType: 'episode' as const,
        runTimeTicks: 1450000000,
        userData: { playbackPositionTicks: 1250000000, playedPercentage: 86, played: false },
        mediaSources: [],
        playSessionId: 'startup-session',
        resumeAnchor: null,
        isWatched: false,
        nextEpisode: {
            itemId: 'next-episode',
            title: 'Next',
            hasPrimaryImage: false,
            isNewSeason: false,
        },
    };
    playerStore.initialize(playbackInfo, 30);
    render(VideoPlayer, { playbackInfo, username: 'viewer', userId: 'viewer' });
    const controller = controllerRef.current as PlayerController;
    expect(playerStore.showNextItemPrompt).toBe(true);
    expect(logoCallbacks.current?.showNextItemPrompt).toBe(false);
    expect(logoCallbacks.current?.activeSegment).toBeNull();
    playerStore.setCurrentTime(0);
    controller.startupPositionResolved = true;
    await vi.waitFor(() => expect(logoCallbacks.current?.showNextItemPrompt).toBe(false));
    playerStore.setCurrentTime(125);
    await vi.waitFor(() => expect(logoCallbacks.current?.showNextItemPrompt).toBe(true));
});
