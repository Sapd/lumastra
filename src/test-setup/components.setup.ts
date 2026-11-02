// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeAll } from 'vitest';

// Shared setup for Svelte component tests (vitest.config.components.ts).
//
// happy-dom implements `navigator.sendBeacon` on top of its internal Fetch.
// `reportClientError` in `$lib/api/client` fires a beacon to
// `/api/dev/client-errors` whenever a real (un-mocked) apiGet call sees a
// schema mismatch — `dev && browser` are both true under vitest. With no
// server listening on happy-dom's default origin (http://localhost:3000) that
// internal fetch rejects, and because sendBeacon swallows its own promise the
// rejection surfaces as an UNHANDLED rejection that fails the whole run
// (exit 1) even though every test passed. Stub it to a synchronous no-op so the
// fire-and-forget reporter can't leak network noise into the test process.
beforeAll(() => {
    // happy-dom has neither Web Locks nor IndexedDB. Exercise origin-wide
    // preference serialization with the browser API's FIFO semantics.
    if (typeof navigator !== 'undefined' && !navigator.locks) {
        const tails = new Map<string, Promise<unknown>>();
        Object.defineProperty(navigator, 'locks', {
            configurable: true,
            value: {
                request: async <T>(
                    name: string,
                    options: { signal?: AbortSignal },
                    callback: () => Promise<T>,
                ): Promise<T> => {
                    const previous = tails.get(name) ?? Promise.resolve();
                    const pending = previous
                        .catch(() => {})
                        .then(() => {
                            if (options.signal?.aborted) throw new Error('Lock request aborted');
                            return callback();
                        });
                    const tail = pending.catch(() => {});
                    tails.set(name, tail);
                    try {
                        return await pending;
                    } finally {
                        if (tails.get(name) === tail) tails.delete(name);
                    }
                },
            },
        });
    }
    if (typeof navigator !== 'undefined') {
        navigator.sendBeacon = (() => true) as typeof navigator.sendBeacon;
    }

    // Svelte's `transition:` directives call `element.animate(...)` on intro/outro.
    // Older happy-dom had no Web Animations API at all ("element.animate is not a
    // function"); happy-dom ≥20.14 ships a real one whose animations run on timers
    // and get CANCELLED when the element unmounts, so an outro never reports
    // finished and the DOM cleanup never runs (a dialog "collapsed" with Escape
    // stayed in the tree, plus unhandled "The animation was canceled" rejections).
    // Either way the tests want deterministic, instant transitions: always install
    // the stub, overriding whatever the environment provides.
    if (typeof Element !== 'undefined') {
        Element.prototype.animate = function stubAnimate() {
            const animation = {
                onfinish: null as (() => void) | null,
                oncancel: null as (() => void) | null,
                currentTime: 0,
                startTime: 0,
                playbackRate: 1,
                playState: 'finished',
                finished: Promise.resolve(),
                effect: { getComputedTiming: () => ({ duration: 0 }) },
                play() {},
                pause() {},
                cancel() {
                    this.oncancel?.();
                },
            };
            queueMicrotask(() => animation.onfinish?.());
            return animation as unknown as Animation;
        } as Element['animate'];
    }
});
