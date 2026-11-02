// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * hls.js config for the ambient preview player (hero slide + hover popup).
 *
 * Buffer sizing is deliberate and load-bearing, not a default:
 *
 * - FORWARD buffer is small. The preview artifact is capped at
 *   PREVIEW_TRANSCODE_MAX_SECONDS (30s), so hls.js's resolved default of 30s
 *   pulls the ENTIRE clip (~3 MB at 640x360) even for a 2-second hover the
 *   user abandons. 4s covers startup without prefetching a clip nobody
 *   watches. Note maxBufferLength is a floor, not a cap: hls.js resolves
 *   min(max(8 * maxBufferSize / bitrate, maxBufferLength), maxMaxBufferLength),
 *   so maxMaxBufferLength is the value that actually bounds it.
 *
 * - BACK buffer is conditionally INFINITE, via `retainBackBuffer`. This
 *   player backs FOUR different playback shapes (`MediaPreviewPlayer.svelte`
 *   is mounted by the hero, the hover popup, and the trailer overlay), and
 *   only TWO of them are a short, bounded, endlessly-looping snippet — the
 *   shape this was designed for:
 *
 *     - hero ambient clip (`loop === true`, not live TV): bounded by
 *       PREVIEW_TRANSCODE_MAX_SECONDS (30s) per replay — retaining the back
 *       buffer costs a known ~3.75 MB of SourceBuffer and avoids
 *       re-downloading the whole clip on every loop (see below).
 *     - hover-popup snippet (`loop === false`, but internally re-looped by
 *       MediaPreviewPlayer's own hover-cap `handleEnded` — see
 *       `hoverCapActive`/`decideHoverLoopCap`): the SAME 30s-capped snippet
 *       as the hero, just replayed under a total-elapsed-hover budget
 *       (PREVIEW_HOVER_MAX_SECONDS) instead of `loop`. This is the
 *       highest-frequency preview path (every card hover), so paying the
 *       buffer cost here is exactly where it matters most.
 *     - full-length local trailer (trailer overlay / hover trailer probe,
 *       `trailerPreferred === true`): bounded by TRAILER_MAX_SECONDS,
 *       default 360s — 12x the snippet cap. An infinite back buffer here
 *       grows toward QuotaExceededError over a single playthrough.
 *     - live TV, standalone (`nativeStreamUrl` set) or via a normal preview
 *       (`isLiveTv === true`): a live stream never ends, so an infinite back
 *       buffer is unbounded on WALL-CLOCK time, not just clip length.
 *
 *   A finite `backBufferLength` flushes everything before
 *   `currentTime - max(backBufferLength, targetDuration)`, so for either
 *   bounded looping snippet a finite value means the seek back to 0 finds an
 *   empty buffer and re-downloads the whole clip on EVERY loop (unbounded on
 *   a non-rotating hero — reduced-motion, or HERO_AUTOPLAY_ENABLED=false —
 *   and, for the hover popup, on every re-loop within the hover-cap window).
 *   That trade only pays off for the two bounded looping-snippet shapes, so
 *   `retainBackBuffer` must be false everywhere else.
 */
export function buildPreviewHlsConfig(options?: {
    retainBackBuffer?: boolean;
}): Record<string, unknown> {
    const retainBackBuffer = options?.retainBackBuffer ?? false;
    return {
        debug: false,
        enableWorker: true,
        lowLatencyMode: false,
        // 10s: enough to survive a small backward seek without re-fetching,
        // without letting an unbounded (trailer/live) stream grow forever.
        backBufferLength: retainBackBuffer ? Infinity : 10,
        maxBufferLength: 4,
        maxMaxBufferLength: 8,
        autoStartLoad: false,
        startOnSegmentBoundary: true,
        manifestLoadingMaxRetry: 15,
        manifestLoadingRetryDelay: 300,
        manifestLoadingMaxRetryTimeout: 10000,
    };
}

/**
 * Decides `retainBackBuffer` for `buildPreviewHlsConfig()` at the one call
 * site (`MediaPreviewPlayer.svelte`). Extracted as a pure function so the
 * four playback shapes documented above can be pinned by unit test without
 * mounting the component or faking `<video>`/hls.js — mirrors the
 * `decideHoverLoopCap` pattern in `media-preview-hover-cap.ts`.
 *
 * The predicate must express "this is a bounded looping snippet", not
 * "the caller passed `loop`" — `loop` is only the HERO's signal for its own
 * ambient replay. The hover popup loops its 30s snippet internally via
 * `hoverCapActive` (see MediaPreviewPlayer's `handleEnded`/
 * `advanceOrExpireHoverLoop`) while always passing `loop: false`, so
 * `hoverCapActive` must be OR'd in — otherwise the highest-frequency preview
 * path silently falls back to the finite buffer and re-downloads its clip on
 * every loop.
 */
export function shouldRetainBackBuffer(params: {
    loop: boolean;
    hoverCapActive: boolean;
    isLiveTv: boolean;
    nativeStreamUrl: boolean;
}): boolean {
    return (params.loop || params.hoverCapActive) && !params.isLiveTv && !params.nativeStreamUrl;
}
