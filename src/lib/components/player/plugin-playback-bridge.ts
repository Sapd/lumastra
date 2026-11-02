// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The only thing a player-overlay plugin is allowed to know about playback.
 *
 * Pull and observe, never touch. A plugin gets a snapshot — where we are, how
 * long it is, whether it is paused — and nothing else. It does NOT get the
 * `<video>` element, the hls.js instance, the player store, or any stream URL,
 * because a stream URL carries session material and the element is the thing
 * the viewer is actually trying to use.
 *
 * Everything below exists so that a plugin cannot degrade playback:
 *
 *   - **Throttled.** Callbacks fire at most ~2Hz plus edges (play, pause, seek,
 *     item change). A subscriber woken on every `timeupdate` would run plugin
 *     code inside the player's hottest loop.
 *   - **Wrapped.** Every callback is caught. A subscriber that throws is not
 *     the player's problem.
 *   - **Disarmed.** Three consecutive throws and the subscription is dropped
 *     for the rest of the session. A plugin that throws once per tick would
 *     otherwise fill the console and burn CPU for the entire film, and there is
 *     no one at the keyboard to fix it mid-playback.
 */

export interface PlaybackSnapshot {
    /** Internal id of what is playing, when known. */
    mediaItemId: string | null;
    mediaType: string | null;
    positionSeconds: number;
    durationSeconds: number;
    paused: boolean;
    isLive: boolean;
}

/** What the host reads a snapshot from. Narrow on purpose. */
export interface PlaybackSource {
    itemId: string | null;
    mediaType: string | null;
    currentTime: number;
    duration: number;
    isPaused: boolean;
    isLive: boolean;
}

export interface PlaybackBridge {
    getSnapshot(): PlaybackSnapshot;
    /**
     * Returns an unsubscribe function. An async callback is supported and its
     * REJECTION counts toward the disarm streak — the type says so, because a
     * `void` return type is what let a rejecting async subscriber look healthy.
     */
    subscribe(cb: (s: PlaybackSnapshot) => void | PromiseLike<unknown>): () => void;
    /** Host-side: call when playback state changed. Cheap, throttles itself. */
    notify(force?: boolean): void;
    /** Host-side: drop every subscriber (player teardown). */
    destroy(): void;
}

/** Minimum gap between non-edge notifications. */
export const NOTIFY_INTERVAL_MS = 500;

/** Consecutive throws before a subscriber is dropped for the session. */
export const DISARM_AFTER_THROWS = 3;

export function readSnapshot(source: PlaybackSource): PlaybackSnapshot {
    return {
        mediaItemId: source.itemId,
        mediaType: source.mediaType,
        positionSeconds: source.currentTime,
        durationSeconds: source.duration,
        paused: source.isPaused,
        isLive: source.isLive,
    };
}

interface Subscriber {
    cb: (s: PlaybackSnapshot) => void | PromiseLike<unknown>;
    throws: number;
    disarmed: boolean;
}

export function createPlaybackBridge(
    source: PlaybackSource,
    opts: { now?: () => number; onDisarm?: (reason: string) => void } = {},
): PlaybackBridge {
    const now = opts.now ?? (() => Date.now());
    const subscribers = new Set<Subscriber>();
    let lastSentAt = 0;
    let lastPaused: boolean | null = null;
    let lastItemId: string | null = null;

    function fail(sub: { throws: number; disarmed: boolean }): void {
        sub.throws += 1;
        if (sub.throws >= DISARM_AFTER_THROWS) {
            sub.disarmed = true;
            opts.onDisarm?.(
                `subscriber threw ${DISARM_AFTER_THROWS} times in a row — dropped for this session`,
            );
        }
    }

    function deliver(snapshot: PlaybackSnapshot): void {
        for (const sub of subscribers) {
            if (sub.disarmed) continue;
            try {
                const result = sub.cb(snapshot);
                // `async (s) => …` is the natural way to write a subscriber, and
                // a rejected promise escapes the try/catch entirely: without
                // this the streak counter would be reset by the successful
                // SYNCHRONOUS return, the subscriber would never disarm, and a
                // rejecting callback would emit an unhandled rejection twice a
                // second for the length of the film — the exact runaway the
                // disarm exists to stop.
                if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
                    void Promise.resolve(result).then(
                        () => {
                            if (!sub.disarmed) sub.throws = 0;
                        },
                        () => fail(sub),
                    );
                    // The streak is settled asynchronously, so do NOT clear it
                    // here — that is what made the async case invisible.
                    continue;
                }
                // A good tick clears the streak: an intermittent failure is not
                // the same thing as a broken subscriber.
                sub.throws = 0;
            } catch {
                fail(sub);
            }
        }
    }

    return {
        getSnapshot: () => readSnapshot(source),

        subscribe(cb) {
            const sub: Subscriber = { cb, throws: 0, disarmed: false };
            subscribers.add(sub);
            return () => {
                subscribers.delete(sub);
            };
        },

        notify(force = false) {
            if (subscribers.size === 0) return;
            const snapshot = readSnapshot(source);

            // Edges always go through: a plugin showing "paused" must not sit
            // on stale state for half a second, and an item change invalidates
            // everything the subscriber was displaying.
            const isEdge =
                force ||
                lastPaused === null ||
                snapshot.paused !== lastPaused ||
                snapshot.mediaItemId !== lastItemId;

            const t = now();
            if (!isEdge && t - lastSentAt < NOTIFY_INTERVAL_MS) return;

            lastSentAt = t;
            lastPaused = snapshot.paused;
            lastItemId = snapshot.mediaItemId;
            deliver(snapshot);
        },

        destroy() {
            subscribers.clear();
        },
    };
}
