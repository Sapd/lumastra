// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watchlist Hydration Service
 *
 * Fills the client-side `watchlistItems` membership index ONCE per session,
 * app-wide, so every surface that renders an add/remove affordance
 * (`MediaHoverCard`'s action row and context menu, `UniversalMediaCard`,
 * `HeroSection`, `FeaturedPickSection`, `StandardSection`) can tell saved
 * from unsaved.
 *
 * Before this existed the store was only ever filled by `Watchlist.svelte` —
 * so on `/browse`, search, or any page without the watchlist widget every
 * membership check silently answered "not saved". Nothing broke (the POST is
 * an idempotent upsert), but the labels lied.
 *
 * ## Why the fetch is deferred to idle
 *
 * `GET /api/watchlist` returns the FULL list unpaginated, enriched with the
 * metadata LATERAL join and a batch watched-state lookup. For a large
 * watchlist that is not a cheap query, and nothing on first paint needs it —
 * the earliest consumer is a hover, hundreds of milliseconds later at best.
 * `scheduleWatchlistHydration()` therefore parks it on `requestIdleCallback`
 * (with a timer fallback for Safari, which still lacks it).
 *
 * A failure is not retried: one attempt per page load, the error lands in
 * `watchlistState.error`, and membership degrades to the old "everything
 * looks unsaved" behaviour rather than throwing.
 */

import { setWatchlistItems, setWatchlistState, type WatchlistItem } from '$lib/stores/watchlist';
import type { WatchlistListResponse } from '$lib/schemas/api-watchlist-responses';
import * as aiApi from '$lib/api/ai';

/** Idle deadline (ms) — hydrate anyway if the main thread never goes quiet. */
const IDLE_TIMEOUT_MS = 3000;

/**
 * Flatten one canonical `{ media, isAvailable, … }` wire item into the flat
 * `WatchlistItem` the client store holds.
 *
 * The store is a MEMBERSHIP INDEX, not a mirror of the wire contract — so it
 * deliberately stays flat. Converting once here keeps `WatchlistButton`,
 * `UniversalMediaCard`, `MediaHoverCard` and `MovieSidebar` untouched; they
 * all compare `mediaCompositeKey(item.externalIds, item.mediaType)`.
 *
 * `media.type` is the canonical discriminator ('movie' | 'series'), but the
 * store and `/api/watchlist`'s body schema both use 'movie' | 'tv'.
 * Mapping 'series' → 'tv' here is REQUIRED, not cosmetic: leaving 'series'
 * in place would 400 the unsave call and break every TV membership check.
 */
export function toWatchlistStoreItem(item: WatchlistListResponse['items'][number]): WatchlistItem {
    const media = item;
    return {
        externalIds: { ...media.ids, internal: media.catalogId ?? undefined },
        mediaType: media.type === 'series' ? 'tv' : 'movie',
        title: media.title,
        overview: media.overview,
        rating: media.rating,
        criticRating: media.criticRating,
        canRequest: item.availability?.canRequest,
        isAvailable: item.availability?.isAvailable,
        savedAt: item.savedAt,
        letterboxdRating: media.ratings?.letterboxd,
        letterboxdVotes: media.ratings?.letterboxdVotes,
        rtCritic: media.criticRating,
        rtAudience: media.ratings?.rtAudience,
        mdblistScore: media.ratings?.mdblist,
        traktScore: media.ratings?.trakt,
        malScore: media.ratings?.mal,
    };
}

/** True once a fetch has succeeded — a second `ensure` call is then a no-op. */
let hydrated = false;
/** The in-flight fetch, so concurrent callers share one request. */
let inFlight: Promise<void> | null = null;

async function loadIntoStore(): Promise<void> {
    setWatchlistState({ loading: true, error: '' });
    try {
        const { data, error } = await aiApi.getSavedMovies();

        if (error) {
            setWatchlistState({ loading: false, error, isDatabaseAvailable: false });
            return;
        }

        setWatchlistItems((data?.items ?? []).map(toWatchlistStoreItem));
        setWatchlistState({ loading: false, error: '', isDatabaseAvailable: true });
        hydrated = true;
    } catch (err) {
        console.error('[watchlist-hydrate] Failed to load watchlist:', err);
        setWatchlistState({
            loading: false,
            error: 'Database not available',
            isDatabaseAvailable: false,
        });
    }
}

/**
 * Fill the watchlist store, at most once per session.
 *
 * @param options.force Refetch even when already hydrated — used by the
 *        `/watchlist` page, whose `refresh()` must always hit the server.
 */
export function ensureWatchlistHydrated(options: { force?: boolean } = {}): Promise<void> {
    if (!options.force) {
        if (hydrated) return Promise.resolve();
        if (inFlight) return inFlight;
    }

    const run = loadIntoStore();
    inFlight = run;
    return run.finally(() => {
        // Only clear if no newer force-refresh has taken the slot.
        if (inFlight === run) inFlight = null;
    });
}

/**
 * Kick off hydration off the critical path. Safe to call unconditionally on
 * a page that has an authenticated user; a no-op outside the browser.
 */
export function scheduleWatchlistHydration(): void {
    if (typeof window === 'undefined') return;

    const start = () => {
        void ensureWatchlistHydrated();
    };

    if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(start, { timeout: IDLE_TIMEOUT_MS });
        return;
    }
    // Safari: no requestIdleCallback — settle for "after first paint".
    setTimeout(start, 0);
}

/** Test seam — drops the once-per-session memo. */
export function resetWatchlistHydrationForTests(): void {
    hydrated = false;
    inFlight = null;
}
