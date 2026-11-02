// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Freshness gate for SSR-seeded page payloads.
 *
 * The homepage embeds live data directly in its HTML — active streams, the
 * Continue Watching strip, the hero's first slide, the LiveTV "on now" rail.
 * That HTML is cached by the service worker as an app shell (`static/sw.js`,
 * `APP_SHELL_PATHS` includes `/`) with no TTL, so a reopen served from that
 * cache — offline, a network fetch error, or a >3s network race timeout —
 * replays whatever was live when the shell was last written. Days later that
 * paints long-dead streams, stale progress bars and finished episodes.
 *
 * Every seed on a page shares one fate: the age of the HTML it was baked into.
 * So consumers gate on a single render stamp (`ssrRenderedAt`) rather than each
 * carrying its own. A seed that fails this check must be treated as no seed at
 * all — fetch it rather than render it.
 */

/**
 * Maximum age of an SSR seed that we still render without a round-trip.
 *
 * A genuine SSR render delivers a seed that is milliseconds old, so this only
 * ever rejects replayed-from-cache HTML. Kept generous so an ordinary slow
 * render or a little clock drift is never mistaken for a stale shell.
 */
export const SSR_SEED_MAX_AGE_MS = 60_000;

/**
 * Whether an SSR seed is recent enough to render as-is.
 *
 * @param timestamp Server render/read time of the seed, or null/undefined when absent.
 * @param now Current wall-clock time, injected for testability.
 */
export function isSeedFresh(
    timestamp: number | null | undefined,
    now: number = Date.now(),
): boolean {
    if (!timestamp || timestamp <= 0) return false;
    const age = now - timestamp;
    // Negative ages mean the renderer's clock ran ahead of ours (replica skew).
    // Treat that as fresh rather than stale: a future timestamp is never the
    // days-old-cached-shell case this guard exists to catch.
    if (age < 0) return true;
    return age < SSR_SEED_MAX_AGE_MS;
}

/**
 * Sessions-specific alias, kept for readability at the Active Streams call
 * site. That surface gates on the sessions cache read time rather than the page
 * render stamp — a strictly more conservative signal, since the read always
 * precedes the render.
 */
export const isSessionSeedFresh = isSeedFresh;
