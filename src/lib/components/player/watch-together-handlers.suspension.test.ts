// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A host whose browser suspends it in the background (Chromium: Page Lifecycle
 * freeze/resume; Safari/iOS and Firefox: the video is just paused, no event) must
 * catch up with the party on return instead of reporting "paused" — but a USER pause
 * from the lock screen / headset (no party sync either) must be left alone.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWatchTogetherHandlers, type VideoController } from './watch-together-handlers';
import type { WatchTogetherStore } from '$lib/stores/watchTogether.svelte';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/paths', () => ({ resolve: (u: string) => u }));
const timers: Record<string, () => void> = {};
vi.mock('$lib/utils/worker-timer', () => ({
    WorkerTimer: class {
        start(name: string, cb: () => void) {
            timers[name] = cb;
        }
        dispose() {}
    },
}));

let visibility: Document['visibilityState'] = 'visible';

function setVisibility(state: Document['visibilityState']): void {
    visibility = state;
    document.dispatchEvent(new Event('visibilitychange'));
}

function setup(opts: { pausedByUser?: boolean; live?: boolean } = {}) {
    let paused = false;
    let time = 20;
    const controller = {
        getCurrentTime: () => time,
        seekTo: vi.fn((t: number) => {
            time = t;
        }),
        play: vi.fn(async () => {
            paused = false;
        }),
        pause: vi.fn(() => {
            paused = true;
        }),
        isPaused: () => paused,
        isReady: () => true,
        hasLiveSource: () => true,
        setPlaybackRate: vi.fn(),
    } as unknown as VideoController;
    const callbacks: Record<string, (...args: never[]) => void> = {};
    const base = {
        sendHeartbeat: vi.fn(),
        reportPosition: vi.fn(),
        freezeCatchUpTarget: vi.fn(async () => 60),
        isCatchUpPaused: () => false,
        getExpectedHostPosition: () => null,
        getSessionState: () => ({ currentTime: 0, isPlaying: true }),
    };
    // Every on<Event>(cb) registration is recorded so a test can emit that event.
    const store = new Proxy(base, {
        get(target, prop: string) {
            if (prop in target) return target[prop as keyof typeof target];
            if (prop.startsWith('on'))
                return (cb: (...args: never[]) => void) => (callbacks[prop] = cb);
            return vi.fn();
        },
    });
    let pausedByUser = opts.pausedByUser ?? false;
    const handlers = createWatchTogetherHandlers({
        getItemId: () => 'item',
        isHost: () => true,
        isPausedByUser: () => pausedByUser,
        isLive: () => opts.live ?? false,
    });
    handlers.setController(controller);
    handlers.registerHandlers(store as unknown as WatchTogetherStore);
    const cleanup = handlers.setupIntervals(
        store as unknown as WatchTogetherStore,
        () => true,
        () => false,
        () => true,
    );
    return {
        controller,
        handlers,
        store: base,
        callbacks,
        cleanup,
        browserPause: () => {
            paused = true;
        },
        userPause: () => {
            pausedByUser = true;
            paused = true;
        },
    };
}

describe('host suspended by the browser in the background', () => {
    beforeEach(() => {
        visibility = 'visible';
        vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    });
    afterEach(() => vi.restoreAllMocks());

    it('Safari-like (no freeze event): catches up on return, sends no "paused" heartbeat', async () => {
        const h = setup();
        setVisibility('hidden');
        h.browserPause();
        setVisibility('visible');
        await vi.waitFor(() => expect(h.controller.play).toHaveBeenCalled());
        expect(h.store.freezeCatchUpTarget).toHaveBeenCalledWith(
            expect.objectContaining({ wasPlaying: true, position: 20 }),
        );
        expect(h.controller.seekTo).toHaveBeenCalledWith(60, 'watch_party_sync');
        expect(h.store.sendHeartbeat).not.toHaveBeenCalled();
        h.cleanup();
    });

    it('Chromium freeze/resume: catches up on resume, once', async () => {
        const h = setup();
        setVisibility('hidden');
        document.dispatchEvent(new Event('freeze'));
        h.browserPause();
        document.dispatchEvent(new Event('resume'));
        await vi.waitFor(() => expect(h.controller.play).toHaveBeenCalled());
        setVisibility('visible');
        expect(h.store.freezeCatchUpTarget).toHaveBeenCalledTimes(1);
        h.cleanup();
    });

    it("a lock-screen pause while hidden is the user's: no catch-up, heartbeat reports it", () => {
        const h = setup();
        setVisibility('hidden');
        h.userPause();
        setVisibility('visible');
        expect(h.store.freezeCatchUpTarget).not.toHaveBeenCalled();
        expect(h.controller.play).not.toHaveBeenCalled();
        expect(h.store.sendHeartbeat).toHaveBeenCalledWith(20, false);
        h.cleanup();
    });

    it('the periodic heartbeat is held while the browser keeps the host paused', () => {
        const h = setup();
        setVisibility('hidden');
        h.browserPause();
        timers.heartbeat();
        expect(h.store.sendHeartbeat).not.toHaveBeenCalled();
        h.cleanup();
    });

    it('lock-screen Play while suspended catches up instead of syncing the stale spot', async () => {
        const h = setup();
        setVisibility('hidden');
        h.browserPause();
        expect(h.handlers.catchUpIfSuspended()).toBe(true);
        await vi.waitFor(() => expect(h.controller.play).toHaveBeenCalled());
        expect(h.controller.seekTo).toHaveBeenCalledWith(60, 'watch_party_sync');
        setVisibility('visible');
        expect(h.store.freezeCatchUpTarget).toHaveBeenCalledTimes(1); // once
        h.cleanup();
    });

    it('lock-screen Pause while suspended gets where the party has got to, once', () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        const h = setup();
        setVisibility('hidden'); // recorded at 20 s
        h.browserPause();
        now.mockReturnValue(1_030_000); // 30 s later
        expect(h.handlers.takeSuspendedPosition()).toBeCloseTo(50, 3);
        expect(h.handlers.takeSuspendedPosition()).toBeNull();
        h.cleanup();
    });

    it('a guest pausing the party while the host is hidden re-bases the record', () => {
        const h = setup();
        setVisibility('hidden');
        (h.callbacks.onSync as unknown as (s: object) => void)({
            currentTime: 31,
            isPlaying: false,
            playbackRate: 1,
            timestamp: Date.now(),
        });
        h.browserPause();
        setVisibility('visible');
        // The party is paused: nothing to catch up to, and "paused" may be reported.
        expect(h.store.freezeCatchUpTarget).not.toHaveBeenCalled();
        expect(h.store.sendHeartbeat).toHaveBeenCalled();
        h.cleanup();
    });

    it('live TV: no catch-up', () => {
        const h = setup({ live: true });
        setVisibility('hidden');
        h.browserPause();
        setVisibility('visible');
        expect(h.store.freezeCatchUpTarget).not.toHaveBeenCalled();
        h.cleanup();
    });

    it('a desktop background tab that kept playing just sends a heartbeat', () => {
        const h = setup();
        setVisibility('hidden');
        setVisibility('visible');
        expect(h.store.freezeCatchUpTarget).not.toHaveBeenCalled();
        expect(h.store.sendHeartbeat).toHaveBeenCalledWith(20, true);
        h.cleanup();
    });
});
