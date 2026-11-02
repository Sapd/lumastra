// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LazyPlayerLoader — the seam +layout.svelte uses to decide whether to
 * dynamic-import() MiniPlayer/FullScreenPlayer/AudiobookMiniPlayer/
 * AudiobookFullScreen (Task 8).
 *
 * Lives under src/lib/components/, so it is picked up by
 * vitest.config.components.ts (run: `npm run test:components`) like every
 * other test in this directory. It does NOT need that config's browser
 * conditions, though: the loader is deliberately built on plain
 * `store.subscribe()` rather than `$effect`/`$store` auto-subscription, so
 * its behaviour — does a store flip cause the right module to load — would
 * be exercisable under the plain node config too (see the module's own
 * header comment and src/lib/composables/use-modal-data.test.ts for why
 * `$effect` bodies don't run there).
 *
 * Hand-rolled store doubles (not svelte/store's `writable`), matching the
 * pattern in AudiobookPlayer.svelte.test.ts: `vi.mock`'s factory is hoisted
 * above every import, so it cannot close over an ordinary module-scope
 * variable — built inside `vi.hoisted` instead.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const { musicMiniState, musicPlayerState, audiobookState, audiobookOpenState } = vi.hoisted(() => {
    function makeStore<T>(initial: T) {
        let value = initial;
        const subscribers = new Set<(v: T) => void>();
        return {
            subscribe(fn: (v: T) => void) {
                subscribers.add(fn);
                fn(value);
                return () => subscribers.delete(fn);
            },
            set(next: T) {
                value = next;
                for (const fn of subscribers) fn(value);
            },
            get(): T {
                return value;
            },
        };
    }
    return {
        musicMiniState: makeStore(false),
        musicPlayerState: makeStore({ isFullScreen: false, fullScreenSwipeProgress: 0 }),
        audiobookState: makeStore<{ book: unknown }>({ book: null }),
        audiobookOpenState: makeStore(false),
    };
});

vi.mock('$lib/stores/music-player.store', () => ({
    isMinPlayerVisible: { subscribe: musicMiniState.subscribe },
    musicPlayerStore: { subscribe: musicPlayerState.subscribe },
}));

vi.mock('$lib/stores/audiobook-player.store', () => ({
    audiobookPlayerStore: { subscribe: audiobookState.subscribe },
}));

vi.mock('$lib/stores/audiobook-ui', () => ({
    audiobookFullScreenOpen: { subscribe: audiobookOpenState.subscribe },
}));

// NOT mocked: the four player .svelte files. A `vi.mock()` registered here
// for a path that lazy-player-loader.svelte.ts reaches via dynamic import()
// was silently NOT honoured in practice (the loader ended up with the REAL
// component instead of the stub — verified experimentally) — the four
// player modules are heavy enough (MiniPlayer.svelte alone is ~2200 lines)
// that mocking them was the point, but real dynamic `import()` of the SAME
// specifier, done here as an ordinary static import, resolves to the exact
// same cached module instance under Vite's module graph either way. So
// identity is compared against the real default export instead of a stub.
import MiniPlayerReal from '$lib/components/music/MiniPlayer.svelte';
import FullScreenPlayerReal from '$lib/components/music/FullScreenPlayer.svelte';
import AudiobookMiniPlayerReal from '$lib/components/audiobook/AudiobookMiniPlayer.svelte';
import AudiobookFullScreenReal from '$lib/components/audiobook/AudiobookFullScreen.svelte';

import { LazyPlayerLoader } from './lazy-player-loader.svelte';

function resetStores(): void {
    musicMiniState.set(false);
    musicPlayerState.set({ isFullScreen: false, fullScreenSwipeProgress: 0 });
    audiobookState.set({ book: null });
    audiobookOpenState.set(false);
}

/** Waits for a dynamic `import()` → `.then(assign)` chain to settle by
 *  polling for a non-null value. A plain microtask-count flush was NOT
 *  enough in practice — vitest/Vite's dynamic `import()` of a (mocked)
 *  module goes through real module-loader machinery, not just a handful of
 *  promise ticks. */
function waitForLoaded<T>(read: () => T | null): Promise<T> {
    return vi.waitFor(
        () => {
            const value = read();
            if (value === null) throw new Error('not loaded yet');
            return value;
        },
        { timeout: 8000, interval: 20 },
    );
}

/** Waits a real (short) tick so a load that should NOT have happened has had
 *  every chance to (falsely) happen before we assert it stayed null. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 50));
}

describe('LazyPlayerLoader', () => {
    afterEach(() => {
        resetStores();
    });

    it('loads none of the four players while every store is idle', async () => {
        const loader = new LazyPlayerLoader();
        await loader.start();
        await settle();

        expect(loader.miniPlayer).toBeNull();
        expect(loader.fullScreenPlayer).toBeNull();
        expect(loader.audiobookMiniPlayer).toBeNull();
        expect(loader.audiobookFullScreen).toBeNull();
    });

    it('loads MiniPlayer once isMinPlayerVisible goes true', async () => {
        const loader = new LazyPlayerLoader();
        await loader.start();
        expect(loader.miniPlayer).toBeNull();

        musicMiniState.set(true);
        await waitForLoaded(() => loader.miniPlayer);

        expect(loader.miniPlayer).toBe(MiniPlayerReal);
        // Untouched by this trigger.
        expect(loader.fullScreenPlayer).toBeNull();
        expect(loader.audiobookMiniPlayer).toBeNull();
        expect(loader.audiobookFullScreen).toBeNull();
    });

    it('loads FullScreenPlayer once musicPlayerStore.isFullScreen goes true', async () => {
        const loader = new LazyPlayerLoader();
        await loader.start();

        musicPlayerState.set({ isFullScreen: true, fullScreenSwipeProgress: 0 });
        await waitForLoaded(() => loader.fullScreenPlayer);

        expect(loader.fullScreenPlayer).toBe(FullScreenPlayerReal);
        expect(loader.miniPlayer).toBeNull();
    });

    it('loads FullScreenPlayer from fullScreenSwipeProgress alone (mid-drag preview, before isFullScreen commits) — fix round 1, Critical 2', async () => {
        // FullScreenPlayer.svelte's own root {#if} is
        // `(isFullScreen || fullScreenSwipeProgress > 0) && currentTrack`:
        // MiniPlayer sets fullScreenSwipeProgress on every touchmove during
        // the swipe-up gesture, well before isFullScreen commits on release.
        // The loader's trigger must match that exactly or the drag preview
        // shows nothing.
        const loader = new LazyPlayerLoader();
        await loader.start();

        musicPlayerState.set({ isFullScreen: false, fullScreenSwipeProgress: 0.3 });
        await waitForLoaded(() => loader.fullScreenPlayer);

        expect(loader.fullScreenPlayer).toBe(FullScreenPlayerReal);
    });

    it('prefetches FullScreenPlayer once MiniPlayer loads, WITHOUT making it visible before its own trigger fires', async () => {
        // "Prefetch" only warms the import() cache — it must never set the
        // field ahead of the real trigger (isFullScreen/swipeProgress), or
        // FullScreenPlayer would mount before its own condition is true.
        const loader = new LazyPlayerLoader();
        await loader.start();

        musicMiniState.set(true);
        await waitForLoaded(() => loader.miniPlayer);

        // Give the idle-time prefetch every chance to (wrongly) set the
        // field before asserting it did not.
        await settle();
        await settle();

        expect(loader.fullScreenPlayer).toBeNull();
    });

    it('loads AudiobookMiniPlayer once the audiobook store reports a book', async () => {
        const loader = new LazyPlayerLoader();
        await loader.start();

        audiobookState.set({ book: { title: 'Dawn' } });
        await waitForLoaded(() => loader.audiobookMiniPlayer);

        expect(loader.audiobookMiniPlayer).toBe(AudiobookMiniPlayerReal);
        expect(loader.audiobookFullScreen).toBeNull();
    });

    it('does NOT load AudiobookFullScreen from fullscreen-open alone, without a book', async () => {
        const loader = new LazyPlayerLoader();
        await loader.start();

        audiobookOpenState.set(true);
        await settle();

        expect(loader.audiobookFullScreen).toBeNull();
    });

    it("loads AudiobookFullScreen once BOTH fullscreen-open and a book are true — matching the real component's own `open` condition", async () => {
        const loader = new LazyPlayerLoader();
        await loader.start();

        audiobookState.set({ book: { title: 'Dawn' } });
        audiobookOpenState.set(true);
        await waitForLoaded(() => loader.audiobookFullScreen);

        expect(loader.audiobookFullScreen).toBe(AudiobookFullScreenReal);
    });

    it('never reloads a component once loaded, even if the trigger flips again', async () => {
        const loader = new LazyPlayerLoader();
        await loader.start();

        musicMiniState.set(true);
        const first = await waitForLoaded(() => loader.miniPlayer);
        expect(first).toBe(MiniPlayerReal);

        musicMiniState.set(false);
        musicMiniState.set(true);
        await settle();

        expect(loader.miniPlayer).toBe(first);
    });

    it('start() cleans up all subscriptions', async () => {
        const loader = new LazyPlayerLoader();
        const stop = await loader.start();
        stop();

        // A store change after teardown must not load anything (no listeners left).
        musicMiniState.set(true);
        audiobookState.set({ book: { title: 'Dawn' } });
        await settle();

        expect(loader.miniPlayer).toBeNull();
        expect(loader.audiobookMiniPlayer).toBeNull();
    });
});
