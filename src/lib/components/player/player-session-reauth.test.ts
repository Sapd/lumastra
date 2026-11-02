// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerController } from './player-controller.svelte';
import { playerStore } from './playerStore.svelte';
import { REAUTH_RELOAD_KEY } from './session-reauth';

/** Real methods, without mounting the unrelated UI/effects constructor. */
function reauthController(video: HTMLVideoElement): {
    controller: PlayerController;
    navigate: ReturnType<typeof vi.fn>;
    check: (trigger: string) => void;
    probe: () => Promise<void> | null;
} {
    const controller = Object.create(PlayerController.prototype) as PlayerController;
    const navigate = vi.fn();
    const fields: Record<string, unknown> = {
        videoElement: video,
        playbackGeneration: 0,
        sessionLossProbe: null,
        lastSessionLossProbeAt: 0,
        log: vi.fn(),
        navigateForReauth: navigate,
    };
    for (const [key, value] of Object.entries(fields)) {
        Object.defineProperty(controller, key, { value, writable: true, configurable: true });
    }
    const internals = controller as unknown as {
        checkForLostBrowserSession(trigger: string): void;
        sessionLossProbe: Promise<void> | null;
    };
    return {
        controller,
        navigate,
        check: (trigger) => internals.checkForLostBrowserSession(trigger),
        probe: () => internals.sessionLossProbe,
    };
}

const fetchMock = vi.fn();

/** happy-dom's own URL setter: no navigation, no SvelteKit router involved. */
function setUrl(url: string): void {
    (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(url);
}

beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    setUrl('http://localhost/watch/item-1?fileId=f1');
    window.sessionStorage.removeItem(REAUTH_RELOAD_KEY);
});

afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    playerStore.reset();
    window.sessionStorage.removeItem(REAUTH_RELOAD_KEY);
});

function videoAt(seconds: number): HTMLVideoElement {
    const video = document.createElement('video');
    video.currentTime = seconds;
    return video;
}

function claimed(): string | null {
    return window.sessionStorage.getItem(REAUTH_RELOAD_KEY);
}

describe('PlayerController lost-session recovery', () => {
    it('reloads the watch page at the current position when the session is gone', async () => {
        fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
        playerStore.playheadTime = 2079.8;
        const { navigate, check, probe } = reauthController(videoAt(2079.8));

        check('hls-401');
        await probe();

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/auth\/check$/);
        expect(navigate).toHaveBeenCalledExactlyOnceWith('/watch/item-1?fileId=f1&t=2079');
        expect(claimed()).not.toBeNull();
    });

    it('uses the position from before the probe, even if the element reset meanwhile', async () => {
        let answer: (r: Response) => void = () => {};
        fetchMock.mockReturnValue(new Promise<Response>((r) => (answer = r)));
        playerStore.playheadTime = 640.2;
        const video = videoAt(640.2);
        const { navigate, check, probe } = reauthController(video);

        check('native-error');
        // e.g. the native → HLS fallback rebuilds the source at 0
        playerStore.playheadTime = 0;
        video.currentTime = 0;
        answer(new Response('{}', { status: 401 }));
        await probe();

        expect(navigate).toHaveBeenCalledExactlyOnceWith('/watch/item-1?fileId=f1&t=640');
    });

    it('falls back to the element time when the store has none yet', async () => {
        fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
        const { navigate, check, probe } = reauthController(videoAt(75.5));

        check('hls-401');
        await probe();

        expect(navigate).toHaveBeenCalledExactlyOnceWith('/watch/item-1?fileId=f1&t=75');
    });

    it('leaves playback alone when the session is still valid', async () => {
        fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
        const { navigate, check, probe } = reauthController(videoAt(60));

        check('hls-401');
        await probe();

        expect(navigate).not.toHaveBeenCalled();
        expect(claimed()).toBeNull();
    });

    it('sends one probe while one is in flight', async () => {
        let answer: (r: Response) => void = () => {};
        fetchMock.mockReturnValue(new Promise<Response>((r) => (answer = r)));
        const { check, probe } = reauthController(videoAt(60));

        check('hls-401');
        check('session-report-401');
        check('hls-retry-401');
        answer(new Response('{}', { status: 200 }));
        await probe();

        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('holds off 15 s after a definite answer, but not after an unknown one', async () => {
        const { check, probe } = reauthController(videoAt(60));

        fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
        check('hls-401');
        await probe();
        fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
        check('hls-401');
        await probe();
        check('hls-401');

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('reloads only once per tab within the cooldown', async () => {
        fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
        window.sessionStorage.setItem(REAUTH_RELOAD_KEY, String(Date.now()));
        const { navigate, check, probe } = reauthController(videoAt(60));

        check('hls-401');
        await probe();

        expect(navigate).not.toHaveBeenCalled();
    });

    it('drops the result when the player was torn down during the probe', async () => {
        let answer: (r: Response) => void = () => {};
        fetchMock.mockReturnValue(new Promise<Response>((r) => (answer = r)));
        const { controller, navigate, check, probe } = reauthController(videoAt(60));

        check('hls-401');
        (controller as unknown as { playbackGeneration: number }).playbackGeneration = 1;
        answer(new Response('{}', { status: 401 }));
        await probe();

        expect(navigate).not.toHaveBeenCalled();
        expect(claimed()).toBeNull();
    });

    it('does nothing in a hidden tab (background or page teardown)', async () => {
        fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        const { navigate, check, probe } = reauthController(videoAt(60));

        check('session-report-401');
        await probe();
        visibility.mockRestore();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
    });

    it('reloads a live watch page without a position', async () => {
        fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
        playerStore.isLive = true;
        playerStore.playheadTime = 500;
        const { navigate, check, probe } = reauthController(videoAt(500));

        check('native-error');
        await probe();

        expect(navigate).toHaveBeenCalledExactlyOnceWith('/watch/item-1?fileId=f1');
    });

    it('does not probe live playback off a watch page (nothing to resume)', async () => {
        setUrl('http://localhost/livetv');
        fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
        playerStore.isLive = true;
        playerStore.itemId = 'channel-1';
        const { navigate, check, probe } = reauthController(videoAt(500));

        check('hls-401');
        await probe();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
    });
});
