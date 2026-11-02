// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlayerControls from './PlayerControls.svelte';
import { playerStore } from './playerStore.svelte';
import { isPWAInstalled } from '$lib/pwa';
import { playbackPreferences } from './preferences-sync.svelte';

vi.mock('$lib/pwa', () => ({ isPWAInstalled: vi.fn(() => false) }));

beforeEach(() => {
    // PiP support detection in onMount() checks this — force it on so the
    // button is present at all outside audio-only mode.
    Object.defineProperty(document, 'pictureInPictureEnabled', {
        value: true,
        configurable: true,
    });
});

afterEach(() => {
    // Dispatched before cleanup() — the component's document listener is
    // torn down by cleanup(), so firing this after it would be a no-op.
    document.dispatchEvent(new Event('leavepictureinpicture'));
    cleanup();
    playerStore.qualityMode = 'original';
    playerStore.setFullscreen(false);
    Reflect.deleteProperty(document, 'pictureInPictureEnabled');
});

describe('PlayerControls audio-only chrome gating', () => {
    it('shows fullscreen and PiP controls outside audio-only mode', async () => {
        playerStore.qualityMode = 'auto';

        const { getByLabelText } = render(PlayerControls, { props: {} });
        await tick();

        expect(getByLabelText(/fullscreen/i)).toBeTruthy();
        expect(getByLabelText(/picture-in-picture/i)).toBeTruthy();
    });

    it('hides fullscreen and PiP controls in audio-only mode', async () => {
        playerStore.qualityMode = 'audio-only';

        const { queryByLabelText } = render(PlayerControls, { props: {} });
        await tick();

        expect(queryByLabelText(/fullscreen/i)).toBeFalsy();
        expect(queryByLabelText(/picture-in-picture/i)).toBeFalsy();
    });
});

/**
 * Audio-only hides the chrome that has nothing to show — but hiding the button
 * that EXITS a mode the user is already in strands them. On a touch device
 * there is no Esc key, so the fullscreen button is the only way out of
 * fullscreen; and an already-open PiP window with no in-app control is an empty
 * orphan the user cannot close from the player.
 *
 * The rule these pin: hide the ENTER action, never the EXIT action.
 *
 * PiP state is driven the way the browser drives it — the component's own
 * `enterpictureinpicture`/`leavepictureinpicture` document listeners — rather
 * than by poking internals, so the test exercises the real activation path.
 *
 * What they do NOT prove: that the buttons are hit-testable (not covered by an
 * overlay) or that clicking them actually leaves fullscreen/PiP — these assert
 * presence and the exit-labelled affordance only.
 */
describe('PlayerControls audio-only escape hatches', () => {
    it('keeps the fullscreen control while already fullscreen in audio-only mode', async () => {
        playerStore.qualityMode = 'audio-only';
        playerStore.setFullscreen(true);

        const { getByLabelText } = render(PlayerControls, { props: {} });
        await tick();

        // Specifically the EXIT affordance — a button labelled "enter
        // fullscreen" while already fullscreen would be the wrong fix.
        expect(getByLabelText(/exit fullscreen/i)).toBeTruthy();
    });

    it('keeps the PiP control while a PiP window is already open in audio-only mode', async () => {
        playerStore.qualityMode = 'audio-only';

        const { getByLabelText, queryByLabelText } = render(PlayerControls, { props: {} });
        await tick();

        // Not yet in PiP: still correctly hidden (this is the control that makes
        // the assertion below meaningful rather than trivially true).
        expect(queryByLabelText(/picture-in-picture/i)).toBeFalsy();

        document.dispatchEvent(new Event('enterpictureinpicture'));
        await tick();

        expect(getByLabelText(/exit picture-in-picture/i)).toBeTruthy();
    });
});

/**
 * Share button. It exists because an installed PWA has no address bar — the
 * URL the user would otherwise copy by hand is simply not reachable. In a
 * normal browser tab it would be redundant chrome, so it must stay hidden
 * there.
 *
 * These drive the real `$lib/utils/web-share` module (only `$lib/pwa` and the
 * platform's share sheet are stubbed), so the asserted URL is the one a
 * recipient would actually receive.
 */
describe('PlayerControls share button', () => {
    beforeEach(() => {
        playerStore.itemId = 'abc-123';
        playerStore.title = 'The Lantern';
        playerStore.currentTime = 137.6;
    });

    afterEach(() => {
        playerStore.itemId = null;
        playerStore.title = '';
        playerStore.currentTime = 0;
        vi.unstubAllGlobals();
        vi.mocked(isPWAInstalled).mockReturnValue(false);
    });

    it('stays hidden in a normal browser tab', async () => {
        vi.mocked(isPWAInstalled).mockReturnValue(false);

        const { queryByLabelText } = render(PlayerControls, { props: {} });
        await tick();

        expect(queryByLabelText(/share/i)).toBeFalsy();
    });

    it('appears when running as an installed PWA', async () => {
        vi.mocked(isPWAInstalled).mockReturnValue(true);

        const { getByLabelText } = render(PlayerControls, { props: {} });
        await tick();

        expect(getByLabelText(/share/i)).toBeTruthy();
    });

    it('shares a watch link anchored at the current position', async () => {
        vi.mocked(isPWAInstalled).mockReturnValue(true);
        const share = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { share, clipboard: { writeText: vi.fn() } });

        const { getByLabelText } = render(PlayerControls, { props: {} });
        await tick();
        await fireEvent.click(getByLabelText(/share/i));

        expect(share).toHaveBeenCalledOnce();
        const { title, url } = share.mock.calls[0][0] as { title: string; url: string };
        expect(title).toBe('The Lantern');
        const parsed = new URL(url);
        expect(parsed.pathname).toBe('/watch/abc-123');
        expect(parsed.searchParams.get('t')).toBe('137');
    });

    it('shares a Live TV link by station id, not by the shown feed id', async () => {
        vi.mocked(isPWAInstalled).mockReturnValue(true);
        const share = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { share, clipboard: { writeText: vi.fn() } });
        const oldInfo = playerStore.playbackInfo;
        playerStore.isLive = true;
        playerStore.playbackInfo = { itemId: 'station-1', internalId: 'abc-123' } as never;
        try {
            const { getByLabelText } = render(PlayerControls, { props: {} });
            await tick();
            await fireEvent.click(getByLabelText(/share/i));
            const { url } = share.mock.calls[0][0] as { url: string };
            expect(new URL(url).pathname).toBe('/watch/station-1');
        } finally {
            playerStore.isLive = false;
            playerStore.playbackInfo = oldInfo;
        }
    });

    it('has nothing to share before an item is loaded', async () => {
        vi.mocked(isPWAInstalled).mockReturnValue(true);
        playerStore.itemId = null;

        const { queryByLabelText } = render(PlayerControls, { props: {} });
        await tick();

        expect(queryByLabelText(/share/i)).toBeFalsy();
    });
});

/**
 * Mobile popup backdrop layering.
 *
 * On mobile portrait the track/quality popups are backed by a full-screen
 * `.mobile-popup-backdrop` whose only job is to close them on a tap outside.
 * Its `z-index: 99` is meant to put it just BELOW the popups (`z-index: 100`)
 * — but a z-index only ranks an element against its siblings inside the
 * nearest ancestor stacking context. `.controls-container` is `z-index: 3`,
 * i.e. a stacking context, so while the backdrop sat OUTSIDE it, the popups'
 * 100 could not lift them past the backdrop's 99: the backdrop painted on top
 * of the menu, and on a phone every tap on a subtitle/audio/quality option hit
 * the backdrop and closed the menu instead of selecting the track.
 *
 * Verified in a real browser via `document.elementFromPoint` on a chip: with
 * the backdrop as a sibling it returned the backdrop, as a child it returns
 * the chip. happy-dom has no layout, so this pins the structural precondition
 * — both the backdrop and the popup must live in the SAME stacking context —
 * rather than the hit-test itself.
 */
describe('PlayerControls mobile popup backdrop', () => {
    afterEach(() => {
        playerStore.currentMediaSource = null;
    });

    it('puts the close-menu backdrop in the same stacking context as the popup', async () => {
        playerStore.currentMediaSource = {
            id: 'source-1',
            audioStreams: [],
            subtitleStreams: [
                {
                    index: 3,
                    type: 'Subtitle',
                    codec: 'subrip',
                    language: 'eng',
                    languageCode: 'eng',
                    displayTitle: 'English',
                    isDefault: false,
                    isForced: false,
                    deliveryMethod: 'External',
                },
            ],
        } as unknown as typeof playerStore.currentMediaSource;

        const { container, getByLabelText } = render(PlayerControls, { props: {} });
        await tick();

        // Before the menu opens this label is unambiguous; the open menu
        // carries the same aria-label as the button that opens it.
        await fireEvent.click(getByLabelText('Audio and subtitle tracks'));
        await tick();

        const controls = container.querySelector('.controls-container');
        const popup = container.querySelector('.track-selector');
        const backdrop = container.querySelector('.mobile-popup-backdrop');

        expect(popup).toBeTruthy();
        expect(backdrop).toBeTruthy();
        // The popup is nested in the control bar and cannot escape its
        // stacking context, so the backdrop has to share it.
        expect(controls!.contains(popup!)).toBe(true);
        expect(controls!.contains(backdrop!)).toBe(true);
    });
});

describe('player menu switching', () => {
    it('closes speed choices when opening quality settings', async () => {
        playerStore.qualityMode = 'original';
        playerStore.isLive = false;
        const view = render(PlayerControls, { props: {} });
        await tick();
        await fireEvent.click(view.getByLabelText(/playback speed/i));
        expect(view.getByRole('menu', { name: /playback speed/i })).toBeTruthy();
        await fireEvent.click(view.getByLabelText(/video quality/i));
        expect(view.queryByRole('menu', { name: /playback speed/i })).toBeNull();
        expect(view.getByRole('menu', { name: /video quality/i })).toBeTruthy();
    });
});

describe('open menu persistence', () => {
    afterEach(() => {
        playerStore.currentMediaSource = null;
    });

    it.each(['Audio and subtitle tracks', 'Video quality', 'Playback speed'])(
        'keeps %s open through auto-hide and allows explicit dismissal',
        async (name) => {
            playerStore.isLive = false;
            playerStore.qualityMode = 'original';
            playerStore.currentMediaSource = {
                id: 'menu-test',
                audioStreams: [],
                videoStreams: [],
                subtitleStreams: [
                    { index: 1, language: 'eng', codec: 'subrip', displayTitle: 'English' },
                ],
            } as unknown as typeof playerStore.currentMediaSource;
            const view = render(PlayerControls, { props: { visible: true } });
            const toggle = view.getByRole('button', { name });
            await fireEvent.click(toggle);
            expect(view.component.hasOpenMenu()).toBe(true);

            // The parent's timer (or mouse leaving the player) requests hiding.
            await view.rerender({ visible: false });
            expect(view.component.hasOpenMenu()).toBe(true);
            expect(view.container.querySelector('.controls-hidden')).toBeNull();
            await fireEvent.click(toggle);
            expect(view.component.hasOpenMenu()).toBe(false);
            expect(view.container.querySelector('.controls-hidden')).toBeTruthy();

            await view.rerender({ visible: true });
            await fireEvent.click(toggle);
            await fireEvent.click(view.getByRole('button', { name: 'Close menu' }));
            expect(view.component.hasOpenMenu()).toBe(false);

            await fireEvent.click(toggle);
            // Escape and clicks on the video use this public dismissal method.
            expect(view.component.closeAllMenus()).toBe(true);
            await tick();
            expect(view.component.hasOpenMenu()).toBe(false);
        },
    );
});

it('uses playback speed when showing the expected finish time', async () => {
    const now = new Date('2026-09-29T12:00:00Z').getTime();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const oldDuration = playerStore.duration;
    const oldTime = playerStore.currentTime;
    const oldRate = playerStore.playbackRate;
    try {
        playerStore.duration = 7200;
        playerStore.currentTime = 0;
        playerStore.playbackRate = 2;
        const view = render(PlayerControls, { props: {} });
        await tick();
        const expected = new Date(now + 3600000).toLocaleTimeString('en', {
            hour: '2-digit',
            minute: '2-digit',
        });
        expect(view.getByText(`Ends at ${expected}`)).toBeTruthy();
    } finally {
        nowSpy.mockRestore();
        playerStore.duration = oldDuration;
        playerStore.currentTime = oldTime;
        playerStore.playbackRate = oldRate;
    }
});

/**
 * The skip buttons jump by the user's own seek step, and without one by the
 * server's PLAYER_SKIP_SECONDS (via client-tuning). Before 2026-10-06 the
 * fallback was a hard-coded 10 and the admin setting did nothing.
 */
describe('PlayerControls skip step', () => {
    afterEach(async () => {
        const { resetClientTuning } = await import('$lib/stores/client-tuning');
        resetClientTuning();
    });

    it.each([
        ['the shipped default', undefined, 110, 'Skip forward 10 seconds'],
        ['PLAYER_SKIP_SECONDS from the server', 30, 130, 'Skip forward 30 seconds'],
    ])(
        'skips forward by %s when the user has no seek step',
        async (_label, skip, expected, name) => {
            const { hydrateClientTuning } = await import('$lib/stores/client-tuning');
            if (skip !== undefined) hydrateClientTuning({ playerSkipSeconds: skip });
            const oldDuration = playerStore.duration;
            const oldTime = playerStore.currentTime;
            const oldStep = playbackPreferences.seekStepSeconds;
            try {
                playbackPreferences.seekStepSeconds = null;
                playerStore.duration = 1000;
                playerStore.currentTime = 100;
                const onseek = vi.fn();
                const view = render(PlayerControls, { props: { onseek } });
                await tick();
                await fireEvent.click(view.getByLabelText(name));
                expect(onseek).toHaveBeenCalledWith(expected);
            } finally {
                playerStore.duration = oldDuration;
                playerStore.currentTime = oldTime;
                playbackPreferences.seekStepSeconds = oldStep;
            }
        },
    );

    // The accessible names used to say "10 seconds" whatever the step was.
    it.each([
        [45, 'Skip back 45 seconds', 'Skip forward 45 seconds'],
        [1, 'Skip back 1 second', 'Skip forward 1 second'],
    ])('names the buttons after a %s s user seek step', async (step, back, forward) => {
        const oldStep = playbackPreferences.seekStepSeconds;
        try {
            playbackPreferences.seekStepSeconds = step;
            const view = render(PlayerControls, { props: {} });
            await tick();
            expect(view.getByLabelText(back)).toBeTruthy();
            expect(view.getByLabelText(forward)).toBeTruthy();
        } finally {
            playbackPreferences.seekStepSeconds = oldStep;
        }
    });
});

// Prod 2026-10-21: the feed button asked /api/livetv/stations/<feed id>/feeds and
// got 404 for a grouped channel. The route takes the STATION id (the watch page's
// playbackInfo.itemId); playerStore.itemId is the shown feed's media item id.
describe('PlayerControls feed button', () => {
    it('lists feeds by station id, not by the shown feed id', async () => {
        const STATION = '7eeb26ce-026d-4911-b312-c7449d0c9399';
        const FEED = '43d9a492-51ee-44be-802b-109361cd2cea';
        const fetchMock = vi.fn(async (_url: unknown) => new Response('{}', { status: 404 }));
        vi.stubGlobal('fetch', fetchMock);
        playerStore.itemId = FEED;
        playerStore.playbackInfo = {
            itemId: STATION,
            internalId: FEED,
            mediaType: 'tvchannel',
            title: 'RTL FHD',
        } as never;
        try {
            render(PlayerControls, { props: { onselectfeed: () => {} } });
            await tick();
            await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
            const urls = fetchMock.mock.calls.map(([u]) => String(u));
            expect(urls.some((u) => u.includes(`/api/livetv/stations/${STATION}/feeds`))).toBe(
                true,
            );
            expect(urls.some((u) => u.includes(`/stations/${FEED}/`))).toBe(false);
        } finally {
            vi.unstubAllGlobals();
            playerStore.itemId = null;
            playerStore.playbackInfo = null;
        }
    });
});

it('integrates feed menus with transport dismissal, menu exclusivity and auto-hide', async () => {
    const oldInfo = playerStore.playbackInfo;
    const oldLive = playerStore.isLive;
    const oldSource = playerStore.currentMediaSource;
    const fetchMock = vi.fn(
        async () =>
            new Response(
                JSON.stringify({
                    stationId: 'station-menu',
                    feeds: ['feed-a', 'feed-b'].map((id, index) => ({
                        id,
                        name: id,
                        qualityTier: 'hd',
                        isDegraded: false,
                        isPrimary: index === 0,
                        isVisible: index === 0,
                        isDefault: index === 0,
                    })),
                }),
                { headers: { 'content-type': 'application/json' } },
            ),
    );
    vi.stubGlobal('fetch', fetchMock);
    playerStore.isLive = true;
    playerStore.playbackInfo = {
        itemId: 'station-menu',
        mediaType: 'tvchannel',
        title: 'Station menu',
    } as never;
    playerStore.currentMediaSource = {
        id: 'source',
        audioStreams: [],
        videoStreams: [],
        subtitleStreams: [{ index: 1, language: 'eng', codec: 'subrip', displayTitle: 'English' }],
    } as never;
    try {
        const view = render(PlayerControls, { props: { onselectfeed: vi.fn(), visible: true } });
        const toggle = await view.findByRole('button', { name: 'Choose a feed of Station menu' });
        await fireEvent.click(toggle);
        expect(view.component.hasOpenMenu()).toBe(true);
        await view.rerender({ visible: false });
        expect(view.container.querySelector('.controls-hidden')).toBeNull();
        // handleVideoClick consumes this true return value and skips toggling playback.
        expect(view.component.closeAllMenus()).toBe(true);
        await tick();
        expect(view.queryByRole('menu', { name: 'Feeds of Station menu' })).toBeNull();
        expect(view.component.hasOpenMenu()).toBe(false);
        expect(view.component.closeAllMenus()).toBe(false);
        await view.rerender({ visible: true });
        await fireEvent.click(toggle);
        await fireEvent.click(view.getByRole('button', { name: 'Video quality' }));
        expect(view.queryByRole('menu', { name: 'Feeds of Station menu' })).toBeNull();
        expect(view.getByRole('menu', { name: 'Video quality' })).toBeTruthy();
        await fireEvent.click(toggle);
        expect(view.queryByRole('menu', { name: 'Video quality' })).toBeNull();
        expect(view.getByRole('menu', { name: 'Feeds of Station menu' })).toBeTruthy();
        await fireEvent.click(view.getByRole('button', { name: 'Close menu' }));
        expect(view.component.hasOpenMenu()).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
        vi.unstubAllGlobals();
        playerStore.playbackInfo = oldInfo;
        playerStore.isLive = oldLive;
        playerStore.currentMediaSource = oldSource;
    }
});
