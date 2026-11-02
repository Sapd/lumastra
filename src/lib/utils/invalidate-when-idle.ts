// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { invalidate } from '$app/navigation';
import { navigating } from '$app/stores';
import { get } from 'svelte/store';

/**
 * Re-run the `load` functions that `depends(resource)`, but never from inside a
 * navigation that is still finishing.
 *
 * `invalidate()` is not safe to call mid-navigation. SvelteKit's `_invalidate()`
 * takes over the router's navigation token as its very first act; the
 * navigation that is still in flight then hits its post-commit token check,
 * decides it was superseded, and returns early — down a path that never resets
 * the `navigating` store. The page itself is fine (it committed before the
 * check, so the new route renders and plays), but `$navigating` stays non-null
 * for the rest of the session, which pins the global NavigationProgressBar on
 * screen until a full page load. The invalidation itself is silently dropped
 * too, since `_invalidate()` bails once it sees a foreign token.
 *
 * That is exactly what the player's teardown used to do: the
 * `{#key playbackInfo.itemId}` block destroys the outgoing VideoPlayer *inside*
 * the next-episode `goto()`, and `PlayerController.destroy()` invalidated from
 * there — so every auto-advance to the next episode left the loading bar
 * running forever.
 *
 * Invalidating after the navigation settles is also the more correct ordering:
 * the destination's `load` then sees the progress this teardown just reported.
 */
export function invalidateWhenIdle(resource: string): void {
    if (!get(navigating)) {
        void invalidate(resource);
        return;
    }

    let unsubscribe: (() => void) | undefined;
    let scheduled = false;

    const settle = () => {
        scheduled = false;
        // A navigation that started in the meantime gets the same treatment:
        // stay subscribed and wait for the router to go idle again.
        if (get(navigating)) return;
        unsubscribe?.();
        void invalidate(resource);
    };

    unsubscribe = navigating.subscribe((nav) => {
        // `subscribe` calls back synchronously with the current value, which we
        // already know is non-null - the guard above returned otherwise.
        if (nav || scheduled) return;
        scheduled = true;
        // Leave SvelteKit's own frame before invalidating. This callback runs
        // inside the `set(null)` that ends a navigation, and taking the router
        // token there would strand a navigation that starts in the same tick -
        // the very failure this helper exists to avoid.
        setTimeout(settle, 0);
    });
}
