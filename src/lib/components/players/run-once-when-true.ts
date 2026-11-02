// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runs a callback exactly once — the first time a condition is true across a
 * series of re-evaluations — and never again.
 *
 * Extracted for `+layout.svelte`'s music-store bootstrap (Task 8 fix round 1,
 * Critical 1): `musicPlayerStore.init()`/`.hydrateFromPersistence()` used to
 * live in `MiniPlayer.svelte`'s own mount effect, which only ever mounted
 * inside the `{:else}` app-shell branch — i.e. NOT on `/login`, `/setup`, or
 * `/showcase*` (see `+layout.svelte`'s `isAuthPage`/`isShowcasePage`). Moving
 * it unconditionally into the root layout's `onMount` broke that: it created
 * the audio backend and read persisted playback state on those chrome-less
 * pages too, and if `persisted.wasPlaying` was true (e.g. a session expired
 * mid-playback and bounced the user to `/login`) it RESUMED PLAYBACK —
 * MediaSession, wake lock, autoplaying audio — with no player UI in sight.
 *
 * A plain `if (!isAuthPage && !isShowcasePage)` inside `onMount` isn't right
 * either: the root layout persists across client-side navigation, so
 * `onMount` runs exactly once. A user who lands on `/login` and then
 * navigates into the app would never get init()/hydrate() at all — a NEW
 * break, not a fix. This class is meant to be driven from a reactive
 * ($effect) context instead: call `.run(condition, fn)` on every
 * re-evaluation: `condition` true on the FIRST call fires `fn` immediately
 * (the common case — landing directly on an app route); `condition` false
 * defers; the first later call where `condition` is true fires `fn` exactly
 * once, whichever call that turns out to be.
 *
 * Deliberately not itself an `$effect`/`$state`-based Svelte construct: this
 * plain, dependency-free class is what makes the gate directly unit-testable
 * (see run-once-when-true.test.ts) without needing to render `+layout.svelte`
 * and its ~30 other dependencies (Sidebar, the modal system, PWA, SSE,
 * notifications, ...) just to exercise this one small piece of logic.
 */
export class RunOnceWhenTrue {
    #ran = false;

    /** True once `fn` has fired. Exposed for tests/inspection only. */
    get hasRun(): boolean {
        return this.#ran;
    }

    run(condition: boolean, fn: () => void): void {
        if (this.#ran || !condition) return;
        this.#ran = true;
        fn();
    }
}
