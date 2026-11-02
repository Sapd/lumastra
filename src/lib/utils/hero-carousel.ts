// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages';

/** Next index with wraparound; safe for len 0/1. */
export function nextIndex(i: number, len: number): number {
    if (len <= 1) return 0;
    return (i + 1) % len;
}

/** Previous index with wraparound; safe for len 0/1. */
export function prevIndex(i: number, len: number): number {
    if (len <= 1) return 0;
    return (i - 1 + len) % len;
}

/** Clamp an index into [0, len-1]; returns 0 for empty. */
export function clampIndex(i: number, len: number): number {
    if (len <= 0) return 0;
    return Math.max(0, Math.min(len - 1, i));
}

/** Autoplay only with more than one slide, when enabled and motion is allowed. */
export function shouldAutoplay(len: number, enabled: boolean, reducedMotion: boolean): boolean {
    return enabled && !reducedMotion && len > 1;
}

/**
 * Re-size a parallel boolean state array to match the current slide count,
 * preserving already-set entries for slides that still exist.
 *
 * Used to keep `videoAvailable` / `videoLoaded` / `logoExists` in lock-step with
 * the live `items` array as it grows from the SSR seed / loading section into the
 * full client list (and on later refreshes). Without re-syncing, indices for new
 * slides are `undefined`, so the trailer `{#if videoLoaded[index]}` gate never
 * becomes true and the carousel never plays a trailer.
 *
 * @param prev      Existing array (may be shorter, longer, or empty).
 * @param length    Target length (current `items.length`).
 * @param fillValue Value for newly-added slots (`true` for availability, `false` for loaded).
 */
export function resizeBoolArray(
    prev: readonly boolean[],
    length: number,
    fillValue: boolean,
): boolean[] {
    const next: boolean[] = new Array(length);
    for (let i = 0; i < length; i++) {
        next[i] = i < prev.length ? prev[i] : fillValue;
    }
    return next;
}

/**
 * Re-size the `window.videoPlayers` array to the current slide count, preserving
 * already-constructed players for slides that still exist (so we don't re-create
 * a working YouTube player) and `null`-filling new slots.
 *
 * @param prev   Existing players array (may be empty or wrong-length).
 * @param length Target length (current `items.length`).
 */
export function resizePlayerArray<T>(
    prev: ReadonlyArray<T | null> | undefined,
    length: number,
): Array<T | null> {
    const next: Array<T | null> = new Array(length).fill(null);
    if (prev) {
        for (let i = 0; i < Math.min(prev.length, length); i++) {
            next[i] = prev[i] ?? null;
        }
    }
    return next;
}

/**
 * Decide whether two slide lists are content-equal for reconciliation purposes.
 *
 * The hero's parent (`+page.svelte`) hands the component a BRAND-NEW
 * `section.items` array reference on every stale-while-revalidate refresh and on
 * every `afterNavigate` — even when the refreshed list contains the very same
 * slides. The reconcile `$effect` used to react to any new reference
 * (`next !== items`), which re-pointed `items`, re-ran the autoplay effect, and
 * (because the refreshed list can come back in a different order) changed the
 * keyed-`{#each}` keys per index. That destroyed and recreated the active
 * slide's `#player{idx}` iframe out from under the just-scheduled
 * `loadSingleTrailer(...)`, so the YouTube player never attached and the trailer
 * never rendered.
 *
 * Comparing by the same content-stable render keys the `{#each}` uses (length +
 * per-index key) lets a no-op refresh be ignored, so the active slide's loaded
 * trailer survives. A genuine change (new slides, reordered slides, grow from
 * the SSR seed) still differs and triggers a real reconcile.
 *
 * @param a Current render keys (`renderItemKeys` for the live `items`).
 * @param b Next render keys (for the incoming `section.items`).
 */
export function slideKeysEqual(a: readonly string[], b: readonly string[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * Indices whose `<img>` backdrop is allowed to render: the active slide plus
 * its two neighbours (wrapping, same as `prevIndex`/`nextIndex`).
 *
 * Every hero slide sits in the DOM at once (cross-faded via opacity), so
 * without this gate the browser eagerly fetches the 1920w `srcset` candidate
 * for every off-screen slide on first paint — directly on the LCP path, for
 * slides nobody has scrolled to yet. Bounding the render to 3 slides caps
 * that to what could plausibly be seen next (one rotation either direction).
 *
 * Deliberately WIDER than `playerSlots` (active, next): `playerSlots` bounds
 * concurrent ffmpeg transcode sessions, `imageSlots` bounds image bytes, and
 * a `prev` peek is cheap for a static image in a way it is not for video.
 *
 * @param currentIndex The active slide index (clamped internally).
 * @param len          Total slide count.
 */
export function heroImageSlots(currentIndex: number, len: number): number[] {
    if (len <= 0) return [];
    const active = clampIndex(currentIndex, len);
    const slots = new Set<number>([prevIndex(active, len), active, nextIndex(active, len)]);
    return Array.from(slots).sort((a, b) => a - b);
}

/** "X min left" for a resume affordance, or null when not computable. */
export function resumeLabel(
    progress: number | undefined,
    runtimeMinutes: number | undefined,
): string | null {
    if (!progress || progress <= 0 || progress >= 1) return null;
    if (!runtimeMinutes || runtimeMinutes <= 0) return null;
    const left = Math.round(runtimeMinutes * (1 - progress));
    if (left <= 0) return null;
    return m.hero_minutes_left({ n: left });
}
