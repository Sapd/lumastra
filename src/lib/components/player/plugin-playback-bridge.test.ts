// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test — the playback bridge handed to player-overlay plugins.
 *
 * The player is the one surface where a misbehaving plugin is not cosmetic, so
 * every test here is about containment: throttling, isolation, and giving up on
 * a subscriber that will not behave.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    createPlaybackBridge,
    DISARM_AFTER_THROWS,
    NOTIFY_INTERVAL_MS,
    type PlaybackSource,
} from './plugin-playback-bridge.js';

function source(over: Partial<PlaybackSource> = {}): PlaybackSource {
    return {
        itemId: 'item-1',
        mediaType: 'movie',
        currentTime: 10,
        duration: 100,
        isPaused: false,
        isLive: false,
        ...over,
    };
}

describe('createPlaybackBridge', () => {
    it('exposes a snapshot without any subscription', () => {
        const bridge = createPlaybackBridge(source({ currentTime: 42 }));
        expect(bridge.getSnapshot()).toMatchObject({
            mediaItemId: 'item-1',
            positionSeconds: 42,
            paused: false,
        });
    });

    it('hands over no player internals — only the documented fields', () => {
        // The contract IS the absence: no video element, no hls instance, no
        // stream URL (which carries session material), no store reference.
        const snapshot = createPlaybackBridge(source()).getSnapshot();
        expect(Object.keys(snapshot).sort()).toEqual([
            'durationSeconds',
            'isLive',
            'mediaItemId',
            'mediaType',
            'paused',
            'positionSeconds',
        ]);
    });

    it('throttles ticks that are not edges', () => {
        let t = 1000;
        const src = source();
        const bridge = createPlaybackBridge(src, { now: () => t });
        const cb = vi.fn();
        bridge.subscribe(cb);

        bridge.notify(); // first is an edge (no prior state)
        bridge.notify();
        bridge.notify();
        expect(cb).toHaveBeenCalledTimes(1);

        t += NOTIFY_INTERVAL_MS;
        bridge.notify();
        expect(cb).toHaveBeenCalledTimes(2);
    });

    it('always delivers a pause edge immediately', () => {
        let t = 1000;
        const src = source();
        const bridge = createPlaybackBridge(src, { now: () => t });
        const cb = vi.fn();
        bridge.subscribe(cb);
        bridge.notify();

        // No time passes, but the state changed — a plugin showing "playing"
        // must not sit on it for half a second.
        src.isPaused = true;
        bridge.notify();

        expect(cb).toHaveBeenCalledTimes(2);
        expect(cb.mock.calls[1][0].paused).toBe(true);
    });

    it('always delivers an item change immediately', () => {
        let t = 1000;
        const src = source();
        const bridge = createPlaybackBridge(src, { now: () => t });
        const cb = vi.fn();
        bridge.subscribe(cb);
        bridge.notify();

        src.itemId = 'item-2';
        bridge.notify();

        expect(cb.mock.calls[1][0].mediaItemId).toBe('item-2');
    });

    it('isolates a throwing subscriber from its peers', () => {
        const bridge = createPlaybackBridge(source());
        const good = vi.fn();
        bridge.subscribe(() => {
            throw new Error('boom');
        });
        bridge.subscribe(good);

        expect(() => bridge.notify()).not.toThrow();
        expect(good).toHaveBeenCalledTimes(1);
    });

    it('disarms a subscriber that throws repeatedly', () => {
        const src = source();
        let t = 0;
        const onDisarm = vi.fn();
        const bridge = createPlaybackBridge(src, { now: () => t, onDisarm });
        const bad = vi.fn(() => {
            throw new Error('boom');
        });
        bridge.subscribe(bad);

        for (let i = 0; i < DISARM_AFTER_THROWS; i++) {
            t += NOTIFY_INTERVAL_MS;
            bridge.notify();
        }
        expect(bad).toHaveBeenCalledTimes(DISARM_AFTER_THROWS);
        expect(onDisarm).toHaveBeenCalledTimes(1);

        // Dropped for the session — it never runs again, however long the
        // film is.
        t += NOTIFY_INTERVAL_MS;
        bridge.notify();
        expect(bad).toHaveBeenCalledTimes(DISARM_AFTER_THROWS);
    });

    it('forgives an intermittent failure rather than counting it toward a disarm', () => {
        const src = source();
        let t = 0;
        let shouldThrow = true;
        const onDisarm = vi.fn();
        const bridge = createPlaybackBridge(src, { now: () => t, onDisarm });
        bridge.subscribe(() => {
            if (shouldThrow) throw new Error('transient');
        });

        t += NOTIFY_INTERVAL_MS;
        bridge.notify();
        shouldThrow = false;
        t += NOTIFY_INTERVAL_MS;
        bridge.notify(); // clears the streak
        shouldThrow = true;
        t += NOTIFY_INTERVAL_MS;
        bridge.notify();
        t += NOTIFY_INTERVAL_MS;
        bridge.notify();

        expect(onDisarm).not.toHaveBeenCalled();
    });

    it('does nothing at all when nobody is subscribed', () => {
        // No player widget installed ⇒ no plugin code, and no snapshot work,
        // runs during playback.
        const src = source();
        const now = vi.fn(() => 0);
        const bridge = createPlaybackBridge(src, { now });
        bridge.notify();
        expect(now).not.toHaveBeenCalled();
    });

    it('stops delivering after unsubscribe', () => {
        let t = 0;
        const bridge = createPlaybackBridge(source(), { now: () => t });
        const cb = vi.fn();
        const off = bridge.subscribe(cb);
        bridge.notify();
        off();
        t += NOTIFY_INTERVAL_MS;
        bridge.notify();
        expect(cb).toHaveBeenCalledTimes(1);
    });
});

describe('async subscribers', () => {
    it('disarms a callback whose PROMISE rejects, not just one that throws', async () => {
        // `async (s) => { … }` is how most authors will write a subscriber, and
        // a rejection escapes a plain try/catch — so without async accounting
        // the streak is reset by the successful synchronous return, the
        // subscriber never disarms, and it emits an unhandled rejection twice a
        // second for the length of the film.
        const src = source();
        let t = 0;
        const onDisarm = vi.fn();
        const bridge = createPlaybackBridge(src, { now: () => t, onDisarm });
        bridge.subscribe(async () => {
            throw new Error('boom');
        });

        for (let i = 0; i < DISARM_AFTER_THROWS; i++) {
            t += NOTIFY_INTERVAL_MS;
            bridge.notify();
            await Promise.resolve();
            await Promise.resolve();
        }

        expect(onDisarm).toHaveBeenCalled();
    });

    it('leaves an async callback that RESOLVES armed', async () => {
        const src = source();
        let t = 0;
        const onDisarm = vi.fn();
        const bridge = createPlaybackBridge(src, { now: () => t, onDisarm });
        const good = vi.fn(async () => undefined);
        bridge.subscribe(good);

        for (let i = 0; i < DISARM_AFTER_THROWS + 2; i++) {
            t += NOTIFY_INTERVAL_MS;
            bridge.notify();
            await Promise.resolve();
            await Promise.resolve();
        }

        expect(onDisarm).not.toHaveBeenCalled();
        expect(good).toHaveBeenCalledTimes(DISARM_AFTER_THROWS + 2);
    });

    it('does not produce an unhandled rejection', async () => {
        const src = source();
        let t = 0;
        const onUnhandled = vi.fn();
        process.on('unhandledRejection', onUnhandled);
        const bridge = createPlaybackBridge(src, { now: () => t });
        bridge.subscribe(async () => {
            throw new Error('boom');
        });
        t += NOTIFY_INTERVAL_MS;
        bridge.notify();
        await new Promise((r) => setTimeout(r, 10));
        process.off('unhandledRejection', onUnhandled);
        expect(onUnhandled).not.toHaveBeenCalled();
    });
});
