// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lazy-loads the four player surfaces that used to be statically imported and
 * always mounted by `+layout.svelte` (MiniPlayer, FullScreenPlayer,
 * AudiobookMiniPlayer, AudiobookFullScreen — together ~270 KB rendered, plus
 * `svelte-dnd-action` dragged in only by FullScreenPlayer). Each is loaded
 * with a dynamic `import()` the first time ITS OWN visibility condition — the
 * same condition its own template root `{#if}` already gates rendering on —
 * goes true, and stays loaded once loaded (mirrors the previous "always
 * mounted" component lifetime; nothing here ever nulls a field back out).
 *
 * `isMinPlayerVisible`/`musicPlayerStore` are statically imported here (and
 * were already statically imported by +layout.svelte before this existed —
 * see the CSS var / with-miniplayer class logic there — so this adds no new
 * weight to the root layout's critical path). The two audiobook stores are
 * NOT statically imported anywhere: `audiobook-player.store.ts` alone is
 * ~1900 lines and pulls in the audio backend, so a plain top-level import
 * here would put that weight on every page. `start()` below loads both with
 * a dynamic `import()` instead, once, and watches them with a plain
 * `.subscribe()` — no restore-on-reload case exists for audiobooks today
 * (only a volume preference is persisted, read at the store's own module
 * init), so starting this asynchronously carries no chicken-and-egg risk,
 * unlike the music-store bootstrap in +layout.svelte.
 *
 * Deliberately built on plain `store.subscribe()` rather than `$effect` /
 * `$store` auto-subscription: this file is compiled through the Svelte rune
 * compiler (the `.svelte.ts` extension), but `$effect` bodies only run under
 * the browser-condition Vitest config (`vitest.config.components.ts` —
 * see `src/lib/composables/use-modal-data.test.ts` for the same finding), and
 * this project has no existing precedent for `$store` auto-subscription
 * inside a `.svelte.ts` module. `.subscribe()` has neither constraint, so the
 * loader's own logic is testable as a plain unit under the default config.
 *
 * ## FullScreenPlayer's trigger, and prefetch (fix round 1, Critical 2)
 *
 * FullScreenPlayer.svelte's own root `{#if}` is
 * `(isFullScreen || isSwiping) && currentTrack`, where `isSwiping` is
 * `$musicPlayerStore.fullScreenSwipeProgress > 0` — a STORE field MiniPlayer
 * sets on every `touchmove` during the swipe-up-to-open gesture, so the
 * fullscreen player progressively slides in as the finger moves, before the
 * gesture ever commits (`isFullScreen` only flips on release/threshold). The
 * load trigger below matches that exactly (`isFullScreen ||
 * fullScreenSwipeProgress > 0`), or the drag would show nothing until release.
 *
 * On top of that (still off the critical path — this only starts once
 * MiniPlayer itself has already loaded), FullScreenPlayer is proactively
 * `import()`ed at idle time the moment MiniPlayer loads, so even the FIRST
 * swipe has it warm in the module cache — this only prefetches the JS, it
 * does NOT set `fullScreenPlayer` (that still only happens once the real
 * trigger above fires; prefetching must never make the component visible
 * before its own condition is true). AudiobookFullScreen gets the same
 * idle-prefetch once AudiobookMiniPlayer loads, for the same snappier-tap
 * reason — though checked, and unlike the music pair, the audiobook swipe-up
 * gesture (`AudiobookMiniPlayer.svelte`'s `swipeDeltaY`) is local component
 * state, not a store field, and never partially reveals AudiobookFullScreen
 * mid-drag (`audiobookFullScreenOpen.set(true)` only fires on commit/tap) —
 * so there is no equivalent "no preview during the drag" correctness bug to
 * fix there, only the same prefetch optimization.
 *
 * ## Failure handling (fix round 1, Important 3)
 *
 * Each trigger is a `BoundedRetryLoader` (see that file): every `import()` is
 * caught, retried a bounded number of times with backoff, and never becomes
 * a per-tick retry storm even against `musicPlayerStore`, which emits on
 * every playback `timeUpdate`.
 */

import type { Component } from 'svelte';
import { isMinPlayerVisible, musicPlayerStore } from '$lib/stores/music-player.store';
import { BoundedRetryLoader } from './bounded-retry-loader.svelte';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = Component<any, any, any>;

/** `requestIdleCallback` with a `setTimeout` fallback (older Safari, and any
 *  non-browser environment — this is only ever actually invoked client-side,
 *  from `start()`, which itself is only ever called from `onMount`). */
function runOnIdle(fn: () => void): void {
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(fn);
    } else {
        setTimeout(fn, 200);
    }
}

/** Fire-and-forget idle-time `import()` that warms the module cache WITHOUT
 *  setting any component field — prefetching must never make a component
 *  visible before its own trigger condition is true. Errors are swallowed:
 *  the real `BoundedRetryLoader` for that key retries (and reports) for
 *  real when the component is actually needed. */
function prefetch(importFn: () => Promise<unknown>): void {
    runOnIdle(() => {
        void importFn().catch(() => {
            /* expected: a failed prefetch is not an error — the real trigger retries when needed */
        });
    });
}

export class LazyPlayerLoader {
    // `onLoaded` (not a check of `.value` inside the store-subscribe
    // callback that calls `.notify()`) is what correctly fires the prefetch
    // the moment each mini player finishes loading — see
    // BoundedRetryLoaderOptions.onLoaded's doc comment for why checking
    // `.value` synchronously in the same callback that triggered the load
    // can never work (the import is still in flight when that callback
    // returns). Caught during this task's own fix round 1: an earlier
    // version of this file did exactly that same-callback check, and its
    // own "prefetch fires, doesn't render" test passed anyway — for the
    // wrong reason (the check was simply always false, so the prefetch
    // silently never ran at all).
    readonly #miniPlayer = new BoundedRetryLoader<AnyComponent>(
        () => import('$lib/components/music/MiniPlayer.svelte'),
        {
            onLoaded: () => prefetch(() => import('$lib/components/music/FullScreenPlayer.svelte')),
        },
    );
    readonly #fullScreenPlayer = new BoundedRetryLoader<AnyComponent>(
        () => import('$lib/components/music/FullScreenPlayer.svelte'),
    );
    readonly #audiobookMiniPlayer = new BoundedRetryLoader<AnyComponent>(
        () => import('$lib/components/audiobook/AudiobookMiniPlayer.svelte'),
        {
            onLoaded: () =>
                prefetch(() => import('$lib/components/audiobook/AudiobookFullScreen.svelte')),
        },
    );
    readonly #audiobookFullScreen = new BoundedRetryLoader<AnyComponent>(
        () => import('$lib/components/audiobook/AudiobookFullScreen.svelte'),
    );

    get miniPlayer(): AnyComponent | null {
        return this.#miniPlayer.value;
    }
    get fullScreenPlayer(): AnyComponent | null {
        return this.#fullScreenPlayer.value;
    }
    get audiobookMiniPlayer(): AnyComponent | null {
        return this.#audiobookMiniPlayer.value;
    }
    get audiobookFullScreen(): AnyComponent | null {
        return this.#audiobookFullScreen.value;
    }

    #audiobookBookActive = false;
    #audiobookFullScreenIsOpen = false;
    #unsubscribers: Array<() => void> = [];
    #started = false;

    /**
     * Start watching every trigger and begin loading whichever components are
     * already due. Call exactly once, from the host component's `onMount`.
     * Returns a cleanup function to run on the host's teardown.
     */
    async start(): Promise<() => void> {
        if (this.#started) {
            return () => this.#dispose();
        }
        this.#started = true;

        const musicMiniUnsub = isMinPlayerVisible.subscribe((visible) => {
            this.#miniPlayer.notify(visible);
        });

        const musicFullScreenUnsub = musicPlayerStore.subscribe((state) => {
            this.#fullScreenPlayer.notify(state.isFullScreen || state.fullScreenSwipeProgress > 0);
        });

        const [{ audiobookPlayerStore }, { audiobookFullScreenOpen }] = await Promise.all([
            import('$lib/stores/audiobook-player.store'),
            import('$lib/stores/audiobook-ui'),
        ]);

        const notifyAudiobookFullScreen = (): void => {
            this.#audiobookFullScreen.notify(
                this.#audiobookFullScreenIsOpen && this.#audiobookBookActive,
            );
        };

        const audiobookBookUnsub = audiobookPlayerStore.subscribe((state) => {
            this.#audiobookBookActive = state.book !== null;
            this.#audiobookMiniPlayer.notify(this.#audiobookBookActive);
            notifyAudiobookFullScreen();
        });
        const audiobookOpenUnsub = audiobookFullScreenOpen.subscribe((open) => {
            this.#audiobookFullScreenIsOpen = open;
            notifyAudiobookFullScreen();
        });

        this.#unsubscribers = [
            musicMiniUnsub,
            musicFullScreenUnsub,
            audiobookBookUnsub,
            audiobookOpenUnsub,
        ];

        return () => this.#dispose();
    }

    #dispose(): void {
        for (const unsub of this.#unsubscribers) unsub();
        this.#miniPlayer.dispose();
        this.#fullScreenPlayer.dispose();
        this.#audiobookMiniPlayer.dispose();
        this.#audiobookFullScreen.dispose();
    }
}
