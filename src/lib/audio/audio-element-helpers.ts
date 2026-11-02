// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// ---------------------------------------------------------------------------
// waitForMetadata — I6
// ---------------------------------------------------------------------------

/**
 * Wait for an HTMLAudioElement to have metadata available (readyState >= 1),
 * then invoke `onReady` and forward its result.
 *
 * This is the `loadedmetadata` wait pattern triplicated across
 * `preload()` and `reloadCurrentSrc()` in all three audio backends.
 *
 * Behaviour:
 * - If `el.error` is already set at call time the promise settles immediately
 *   via `onError` (if provided) or `onReady` (fallback), preventing an
 *   infinite hang when the error event fired before this function was called.
 * - If `el.readyState >= 1` at call time (metadata already cached), `onReady`
 *   is called synchronously within the returned promise.
 * - Otherwise the function waits for the `loadedmetadata` event on `el`.
 * - An `error` listener is always attached. When `onError` is provided it is
 *   called and the promise resolves to its return value. When `onError` is
 *   omitted the error is treated as "metadata available" and `onReady` is
 *   invoked as a fallback so callers that do not care about errors continue
 *   to work without change.
 * - A `timeoutMs` guard (default 10 000 ms) ensures the promise always
 *   settles: on timeout the same onReady/onError fallback logic applies.
 *
 * @param el        The audio element to observe.
 * @param onReady   Callback invoked once metadata is available (or on
 *                  timeout/error when `onError` is omitted).
 *                  Return a Promise<T> — its settled value becomes the
 *                  settled value of `waitForMetadata`.
 * @param onError   Optional callback invoked on an `error` event or timeout
 *                  while errored. Must return T (or a Promise<T>) so the
 *                  caller's promise can resolve to a consistent type.
 * @param timeoutMs Maximum milliseconds to wait before settling via the
 *                  onReady/onError fallback. Defaults to 10 000 ms.
 */
export function waitForMetadata<T>(
    el: HTMLAudioElement,
    onReady: () => Promise<T>,
    onError?: () => T | Promise<T>,
    timeoutMs = 10_000,
): Promise<T> {
    // Pre-attached error: the 'error' event already fired before we got here.
    if (el.error !== null) {
        return onError !== undefined ? Promise.resolve(onError()) : onReady();
    }

    // Fast path: metadata already available (cached resource).
    if (el.readyState >= 1) {
        return onReady();
    }

    return new Promise<T>((resolve) => {
        let settled = false;

        const settle = (useErrorPath: boolean): void => {
            if (settled) return;
            settled = true;
            el.removeEventListener('loadedmetadata', onMetadata);
            el.removeEventListener('error', onErrorEvent);
            clearTimeout(timer);

            if (useErrorPath && onError !== undefined) {
                void Promise.resolve(onError()).then(resolve);
            } else {
                void onReady().then(resolve);
            }
        };

        const onMetadata = (): void => settle(false);
        const onErrorEvent = (): void => settle(true);

        const timer = setTimeout(() => settle(el.error !== null), timeoutMs);

        el.addEventListener('loadedmetadata', onMetadata, { once: true });
        el.addEventListener('error', onErrorEvent, { once: true });
    });
}

// ---------------------------------------------------------------------------
// Playback failures — shared by all three backends
// ---------------------------------------------------------------------------

/**
 * The current track's element failed to load or decode.
 *
 * `code` is the element's `MediaError.code` (1 aborted, 2 network, 3 decode,
 * 4 source not supported) or null when the browser rejected `play()` without
 * setting one. There is no HTTP status: a 415, a 500 and an undecodable body
 * all surface as code 4, and the element never exposes which it was.
 */
export class MediaPlaybackError extends Error {
    override readonly name = 'MediaPlaybackError';
    readonly code: number | null;

    constructor(code: number | null, message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.code = code;
    }
}

function errorFromElement(el: HTMLMediaElement, cause?: unknown): MediaPlaybackError {
    const mediaError = el.error;
    const code = mediaError?.code ?? null;
    const detail = mediaError?.message || (cause instanceof Error ? cause.message : '');
    return new MediaPlaybackError(
        code,
        `media element failed${code === null ? '' : ` (MediaError ${code})`}${detail ? `: ${detail}` : ''}`,
        cause === undefined ? undefined : { cause },
    );
}

/** The element's load/decode failure as a {@link MediaPlaybackError}, or null. */
export function elementFailure(el: HTMLMediaElement): MediaPlaybackError | null {
    return el.error !== null && hasSource(el) ? errorFromElement(el) : null;
}

/** How long a crossfade waits for the incoming deck's `play()` to settle. */
export const INCOMING_PLAY_TIMEOUT_MS = 8000;

/**
 * Start a crossfade's incoming deck, bounded. Rejects when the source fails,
 * the browser refuses to play, or `play()` has not settled within
 * `timeoutMs` — the caller must then abandon the fade (the store hard-cuts
 * to the promoted track through its recovery path) instead of fading the
 * outgoing track out over a deck that will never sound, or waiting forever
 * with the fade flag stuck.
 */
export async function startIncomingDeck(
    el: HTMLMediaElement,
    timeoutMs: number = INCOMING_PLAY_TIMEOUT_MS,
): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
        playMediaElement(el),
        new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), timeoutMs);
        }),
    ]).finally(() => clearTimeout(timer));
    if (outcome === true) return;
    el.pause();
    throw new MediaPlaybackError(
        el.error?.code ?? null,
        outcome === 'timeout'
            ? `incoming deck did not start within ${timeoutMs}ms`
            : 'incoming deck play() was refused',
    );
}

/**
 * Rejections that are a normal outcome, not a failed track: `NotAllowedError`
 * is the autoplay policy waiting for a gesture, and `AbortError` means a newer
 * load replaced this one before it started.
 */
export function isExpectedPlayRejection(err: unknown): boolean {
    const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : null;
    return name === 'NotAllowedError' || name === 'AbortError';
}

/**
 * An `error` event is only a failed TRACK while the element has a source.
 * Emptying `src` (every backend's `stop()`) runs the load algorithm on an
 * empty URL, and engines report that as a code-4 error too.
 */
function hasSource(el: HTMLMediaElement): boolean {
    return (el.getAttribute('src') ?? '') !== '';
}

/** `play()` calls still waiting to settle, per element. */
const playsInFlight = new WeakMap<HTMLMediaElement, number>();
/** Errors a {@link playMediaElement} rejection already carried to the caller. */
const claimedErrors = new WeakSet<object>();

/**
 * `el.play()`, with the failures the backends used to swallow turned into a
 * rejection.
 *
 * - Resolves `true` once playback started.
 * - Resolves `false` for an expected rejection ({@link isExpectedPlayRejection}).
 * - Rejects with {@link MediaPlaybackError} when the source failed. That covers
 *   a rejected `play()` (a 415 rejects with `NotSupportedError`) AND an
 *   `error` event while the call is pending: a decode or network failure after
 *   metadata fires the event but does not reject pending play promises, so
 *   without the race the caller would wait forever.
 *
 * An error it rejects with is claimed, so {@link watchMediaErrors} does not
 * report the same failure a second time.
 */
export function playMediaElement(el: HTMLMediaElement): Promise<boolean> {
    if (el.error !== null && hasSource(el)) {
        claimedErrors.add(el.error);
        return Promise.reject(errorFromElement(el));
    }

    playsInFlight.set(el, (playsInFlight.get(el) ?? 0) + 1);

    return new Promise<boolean>((resolve, reject) => {
        let settled = false;
        const settle = (finish: () => void): void => {
            if (settled) return;
            settled = true;
            el.removeEventListener('error', onErrorEvent);
            playsInFlight.set(el, (playsInFlight.get(el) ?? 1) - 1);
            finish();
        };
        const fail = (cause?: unknown): void => {
            if (el.error !== null) claimedErrors.add(el.error);
            reject(errorFromElement(el, cause));
        };
        const onErrorEvent = (): void => {
            if (el.error === null || !hasSource(el)) return;
            settle(() => fail());
        };
        el.addEventListener('error', onErrorEvent);

        let attempt: Promise<void>;
        try {
            attempt = Promise.resolve(el.play());
        } catch (err) {
            attempt = Promise.reject(err);
        }
        attempt.then(
            () => settle(() => resolve(true)),
            (err: unknown) =>
                settle(() => (isExpectedPlayRejection(err) ? resolve(false) : fail(err))),
        );
    });
}

/**
 * Report load/decode failures of the current track that arrive as an `error`
 * event outside a pending {@link playMediaElement} — mid-stream network drops
 * and decode errors after playback started.
 *
 * Registered once per deck at init. `isCurrent` decides whether this deck is
 * the audible current track; an idle or preloading deck failing is not a
 * failed track. Returns an unsubscribe function.
 */
export function watchMediaErrors(
    el: HTMLMediaElement,
    isCurrent: () => boolean,
    onError: (error: MediaPlaybackError) => void,
): () => void {
    const handler = (): void => {
        const mediaError = el.error;
        if (mediaError === null || !hasSource(el)) return;
        // A pending play() rejects with this error itself.
        if ((playsInFlight.get(el) ?? 0) > 0 || claimedErrors.has(mediaError)) return;
        if (!isCurrent()) return;
        onError(errorFromElement(el));
    };
    el.addEventListener('error', handler);
    return () => el.removeEventListener('error', handler);
}

// ---------------------------------------------------------------------------
// Playback rate + pitch
// ---------------------------------------------------------------------------

/**
 * Elements that expose the pitch-preservation flag, including the two vendor
 * spellings still shipping. Chromium and WebKit implemented
 * `webkitPreservesPitch` before the unprefixed name; Firefox shipped
 * `mozPreservesPitch`.
 */
type PitchCapableElement = HTMLMediaElement & {
    preservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
    mozPreservesPitch?: boolean;
};

/**
 * Apply a playback rate, stating explicitly whether pitch is preserved.
 *
 * The default differs by engine and by history, so it is never inherited here:
 * the BPM-matching path wants the pitch to move with the tempo (that IS the
 * effect), and an audiobook at 1.5× wants it pinned (otherwise, chipmunks).
 * Writing every spelling is cheap and avoids a per-engine capability table.
 */
export function applyPlaybackRate(
    el: HTMLMediaElement,
    rate: number,
    preservePitch: boolean,
): void {
    const pitched = el as PitchCapableElement;
    // Set the flag BEFORE the rate: Chromium applies pitch preservation at the
    // moment the rate changes, so writing it afterwards leaves the current
    // stretch un-corrected until the next rate write.
    try {
        if ('preservesPitch' in pitched) pitched.preservesPitch = preservePitch;
        if ('webkitPreservesPitch' in pitched) pitched.webkitPreservesPitch = preservePitch;
        if ('mozPreservesPitch' in pitched) pitched.mozPreservesPitch = preservePitch;
    } catch {
        // Read-only in some engines/versions — the rate itself still applies.
    }
    el.playbackRate = rate;
}

/**
 * Seek an element to `positionMs` once it knows enough to accept the write.
 *
 * A `currentTime` write before `loadedmetadata` does not throw — per the HTML
 * spec it sets the *default playback start position*, which engines then honour
 * when the media loads. That path works, but it is a different mechanism with
 * different failure modes (a subsequent `load()`, or a src that turns out to be
 * unseekable, discards it silently). Waiting makes the write an ordinary seek,
 * which is what the caller means and what a 20-hour book losing its place
 * cannot afford to get wrong.
 *
 * Note `WebAudioBackend`'s Android shadow element deliberately uses the
 * default-start-position path instead: it is a fire-and-forget mirror of the
 * active deck, so an awaited seek there would serialise the visibility handler.
 */
export function seekWhenReady(el: HTMLAudioElement, positionMs: number): Promise<void> {
    if (positionMs <= 0) return Promise.resolve();
    return waitForMetadata(
        el,
        async () => {
            el.currentTime = positionMs / 1000;
        },
        () => undefined,
    );
}

// ---------------------------------------------------------------------------
// registerVisibilityHandlers — I7
// ---------------------------------------------------------------------------

/**
 * Callbacks injected into `registerVisibilityHandlers`.
 *
 * The caller provides what should happen on each transition so this helper
 * stays generic across backends (WebAudioBackend is the only backend that
 * currently uses it, but the signature is shaped for future use).
 */
export interface VisibilityHandlerCallbacks {
    /**
     * Called when the document transitions to `hidden`.
     * On WebAudioBackend: activates the shadow audio element for background
     * playback on Android.
     */
    onHidden: () => void;
    /**
     * Called when the document transitions to `visible`.
     * On WebAudioBackend: deactivates the shadow element and resumes the
     * AudioContext if it was suspended.
     */
    onVisible: () => void;
    /**
     * Called on the `resume` (page-resume) event fired by some iOS/Android
     * WebViews when the page comes back to the foreground from a freeze.
     * Treated identically to `onVisible` in the current backend.
     */
    onResume: () => void;
}

/**
 * Register `visibilitychange` and `resume` document event listeners and
 * return an unsubscribe function that removes both.
 *
 * This is the registration block that appears twice in `WebAudioBackend`
 * (once in `init()`, once re-registered after `stop()`) and would otherwise
 * be copy-pasted verbatim.
 *
 * Usage:
 * ```ts
 * this.cleanupVisibilityHandler = registerVisibilityHandlers({
 *     onHidden: () => this.activateShadowAudio(),
 *     onVisible: () => {
 *         this.deactivateShadowAudio();
 *         if (this.audioContext?.state === 'suspended' && !this.userPaused) {
 *             void this.audioContext.resume();
 *         }
 *     },
 *     onResume: () => {
 *         if (this.userPaused) return;
 *         this.deactivateShadowAudio();
 *         if (this.audioContext?.state === 'suspended') void this.audioContext.resume();
 *         const deck = this.getActiveDeck();
 *         if (deck && deck.audio.paused) void deck.audio.play().catch(() => {});
 *     },
 * });
 * ```
 *
 * @returns A zero-argument cleanup function that removes the registered
 *          listeners. Store the return value and call it from `destroy()`
 *          or wherever cleanup is required.
 */
export function registerVisibilityHandlers(callbacks: VisibilityHandlerCallbacks): () => void {
    const handleVisibility = (): void => {
        if (document.visibilityState === 'hidden') {
            callbacks.onHidden();
        } else if (document.visibilityState === 'visible') {
            callbacks.onVisible();
        }
    };

    const handlePageResume = (): void => {
        callbacks.onResume();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    document.addEventListener('resume', handlePageResume);

    return (): void => {
        document.removeEventListener('visibilitychange', handleVisibility);
        document.removeEventListener('resume', handlePageResume);
    };
}
