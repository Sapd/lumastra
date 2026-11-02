// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A single "load once" slot with bounded retry and no retry storms.
 *
 * Extracted out of `LazyPlayerLoader` (Task 8 fix round 1, Important 3):
 * none of the four `import()` calls there had a `.catch()`. A rejected
 * import (e.g. a stale chunk after a deploy) was an unhandled rejection, and
 * the FullScreenPlayer trigger in particular subscribes to a raw writable
 * (`musicPlayerStore`) that emits on every playback `timeUpdate` — so a
 * persistent failure would become a retry storm, re-attempting the same
 * doomed `import()` many times a second for as long as music kept playing.
 *
 * `T` is generic and `importFn` is passed in rather than hard-coded so this
 * is testable with a plain injected function — no `vi.mock()` on a real
 * module path needed, which matters here: mocking one of the four `.svelte`
 * player paths for a dynamic `import()` reached from a DIFFERENT module was
 * tried for the sibling loader test and was silently not honoured in
 * practice (verified experimentally — see lazy-player-loader.test.ts).
 *
 * `notify(active)` is meant to be called from a store's `.subscribe()`
 * callback, on every emission, unconditionally. It is a no-op unless
 * `active` is true and nothing is loaded/in-flight/exhausted yet, so calling
 * it many times a second is free. A fresh false→true transition (not a
 * continuously-true stream of calls — that would defeat the backoff
 * entirely against a fast-ticking store) resets an exhausted attempt counter
 * and retries immediately.
 */

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 1000;

export interface BoundedRetryLoaderOptions<T> {
    /** After this many failed attempts, `notify()` stops retrying on its own
     *  and waits for a fresh false→true transition. Default 3. */
    maxAttempts?: number;
    /** Exponential backoff base between retries (base, 2×base, 4×base, ...).
     *  Default 1000ms. */
    backoffBaseMs?: number;
    /** Called once per failed attempt, after the attempt counter for it is
     *  incremented. Defaults to a single `console.error` line. */
    onAttemptFailed?: (attempt: number, maxAttempts: number, err: unknown) => void;
    /** Called exactly once, right after `value` is first set — i.e. on the
     *  null→non-null transition, not on every `notify()` call. Consumers
     *  that need to react to "this finished loading" (e.g. prefetching a
     *  related module) MUST use this rather than checking `.value` inside
     *  the same synchronous callback that triggered `notify()`: `notify()`
     *  kicks off an async `import()`, so `.value` is still null when that
     *  callback returns — checking it there would never fire. */
    onLoaded?: (value: T) => void;
}

export class BoundedRetryLoader<T> {
    value = $state<T | null>(null);

    readonly #importFn: () => Promise<{ default: T }>;
    readonly #maxAttempts: number;
    readonly #backoffBaseMs: number;
    readonly #onAttemptFailed: (attempt: number, maxAttempts: number, err: unknown) => void;
    readonly #onLoaded: ((value: T) => void) | undefined;

    #attempts = 0;
    // True only while the actual `importFn()` promise is unsettled. A re-arm
    // (false→true) must NEVER touch this — clearing it while a real import is
    // still pending would let a second, concurrent `importFn()` call start,
    // and `onLoaded` would then fire once per resolved promise instead of
    // once overall.
    #importInFlight = false;
    // True while waiting out a backoff delay between failed attempts (no
    // import call in flight during this window). A re-arm MAY cancel this —
    // that's the "give up the wait, retry immediately" behaviour — because
    // there is no outstanding promise to duplicate.
    #backoffTimer: ReturnType<typeof setTimeout> | null = null;
    #wasActive = false;

    constructor(
        importFn: () => Promise<{ default: T }>,
        options: BoundedRetryLoaderOptions<T> = {},
    ) {
        this.#importFn = importFn;
        this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
        this.#backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
        this.#onAttemptFailed =
            options.onAttemptFailed ??
            ((attempt, maxAttempts, err) => {
                console.error(
                    `[BoundedRetryLoader] load failed (attempt ${attempt}/${maxAttempts})`,
                    err,
                );
            });
        this.#onLoaded = options.onLoaded;
    }

    notify(active: boolean): void {
        const wasActive = this.#wasActive;
        this.#wasActive = active;
        if (!active || this.value !== null) return;

        if (!wasActive) {
            // Fresh re-arm: forget any prior exhaustion and give up on a
            // pending BACKOFF wait (retry immediately instead). Deliberately
            // does NOT touch #importInFlight — if a real `importFn()` call is
            // still outstanding from before this re-arm, it must be left
            // alone so it can't be duplicated.
            this.#attempts = 0;
            if (this.#backoffTimer !== null) {
                clearTimeout(this.#backoffTimer);
                this.#backoffTimer = null;
            }
        }

        // Either a real import is genuinely outstanding, or we're mid-backoff
        // waiting to retry — either way, don't start a second one.
        if (this.#importInFlight || this.#backoffTimer !== null) return;
        if (this.#attempts >= this.#maxAttempts) return; // exhausted; wait for a fresh transition

        this.#importInFlight = true;
        this.#importFn()
            .then((mod) => {
                this.#importInFlight = false;
                // Guard the null→non-null transition explicitly rather than
                // relying on single-flight alone: `onLoaded` must fire at
                // most once, ever, no matter what races upstream.
                if (this.value === null) {
                    this.value = mod.default;
                    this.#onLoaded?.(mod.default);
                }
            })
            .catch((err: unknown) => {
                this.#importInFlight = false;
                this.#attempts += 1;
                this.#onAttemptFailed(this.#attempts, this.#maxAttempts, err);
                if (this.#attempts >= this.#maxAttempts) return;
                const delayMs = this.#backoffBaseMs * 2 ** (this.#attempts - 1);
                this.#backoffTimer = setTimeout(() => {
                    this.#backoffTimer = null;
                    // Re-drive against the last known active state — a
                    // no-op false-transition reset, since it's unchanged.
                    this.notify(this.#wasActive);
                }, delayMs);
            });
    }

    /** Cancels any pending backoff retry. Call on host teardown. */
    dispose(): void {
        if (this.#backoffTimer !== null) {
            clearTimeout(this.#backoffTimer);
            this.#backoffTimer = null;
        }
    }
}
