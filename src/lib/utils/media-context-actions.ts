// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * media-context-actions.ts
 *
 * Shared right-click / context-menu action helpers used by surfaces that
 * cannot host UniversalMediaCard's full menu builder — currently
 * HeroSection and FeaturedPickSection. UMC keeps its own copies of these
 * actions inline; the surfaces here import from this module so the
 * behaviour stays consistent without forcing a UMC refactor.
 */

import { z } from 'zod';
import { invalidateWhenIdle } from '$lib/utils/invalidate-when-idle';
import { apiDelete } from '$lib/api/client';
import { syncMediaMetadata } from '$lib/api/media-sync';
import * as aiApi from '$lib/api/ai';
import { markWatched, unmarkWatched } from '$lib/api/user';
import { toasts } from '$lib/stores/toast.store';
import * as m from '$lib/paraglide/messages';
import { isSeries, isMovie, isEpisode } from '$lib/shared/media-types';
import { getExternalIdFor } from '$lib/utils/external-ids';
import {
    addToWatchlistStore,
    removeFromWatchlistStore,
    type WatchlistItem,
} from '$lib/stores/watchlist';
import type { UniversalMediaItem } from '$lib/types/server-driven-ui';
import type { ApiMediaType } from '$lib/types/api-common';

const WatchedDeleteSchema = z.object({
    watched: z.boolean(),
    itemId: z.string(),
});

/**
 * Stable id for sharing-style URLs — internal UUID, then jellyfin, then composite.
 *
 * Takes only the two fields it reads (not a whole `UniversalMediaItem`) so
 * surfaces that hold ids without a full item — ModalActions' share button —
 * can call it directly.
 */
export function buildMediaShareId(
    // `mediaType` is optional HERE even though UniversalMediaItem requires it:
    // the guard below already returns null for an absent one, and the callers
    // that need this — ModalActions, whose prop is a loose string — genuinely
    // may not have a recognised type. Declaring it required made that guard
    // dead code by the type system while remaining live in fact.
    item: Pick<UniversalMediaItem, 'externalIds'> & {
        mediaType?: UniversalMediaItem['mediaType'];
    },
): string | null {
    const internal = getExternalIdFor(item.externalIds, 'internal');
    if (internal) return internal;
    const tmdb = getExternalIdFor(item.externalIds, 'tmdb');
    if (!tmdb || !item.mediaType) return null;
    // Composite keys are lowercase by convention. Map series→tv since
    // the resolver only knows movie/tv/episode/season.
    const lower = String(item.mediaType).toLowerCase();
    const canonical = lower === 'series' ? 'tv' : lower;
    return `tmdb:${tmdb}:${canonical}`;
}

/** Copy the modal-url-sync style link for `item` to the clipboard. */
export async function copyMediaLink(item: UniversalMediaItem): Promise<void> {
    const id = buildMediaShareId(item);
    if (!id || typeof window === 'undefined') return;
    const url = `${window.location.origin}/?modal=${encodeURIComponent(id)}`;
    try {
        await navigator.clipboard.writeText(url);
        toasts.info(m.card_copy_link_done());
    } catch {
        // best-effort: clipboard write blocked/denied → surface failure to the user via toast.
        toasts.error(m.card_copy_link_failed());
    }
}

/** Mark a watched movie/episode/series as unwatched, then refresh CW. */
export async function markMediaUnwatched(item: UniversalMediaItem): Promise<void> {
    const internalId = getExternalIdFor(item.externalIds, 'internal');
    if (!internalId) return;
    const { error } = await apiDelete(
        `/api/watched/${encodeURIComponent(internalId)}`,
        WatchedDeleteSchema,
    );
    if (error) {
        toasts.error(m.card_mark_unwatched_failed());
        return;
    }
    toasts.info(m.card_mark_unwatched_done());
    invalidateWhenIdle('app:watch-state');
}

const episodeWatchQueues = new Map<string, Promise<void>>();

/** Change only this episode's watch state, in selection order, then refresh CW / Next Up. */
export async function setEpisodeWatchState(
    item: UniversalMediaItem,
    watched: boolean,
): Promise<void> {
    if (!isEpisode(item.mediaType)) return;
    const episodeId = getExternalIdFor(item.externalIds, 'internal');
    if (!episodeId) return;
    const previous = episodeWatchQueues.get(episodeId) ?? Promise.resolve();
    const pending = previous
        .catch(() => {})
        .then(async (): Promise<void> => {
            const failureMessage = watched
                ? m.toast_mark_watched_failed()
                : m.card_mark_unwatched_failed();
            try {
                // These canonical helpers also bump the client watch-state revision.
                // Never substitute seriesId: marking the series would affect every episode.
                const { error } = watched
                    ? await markWatched(episodeId, {
                          externalIds: item.externalIds,
                          mediaType: 'episode',
                          title: item.title,
                      })
                    : await unmarkWatched(episodeId);
                if (error) {
                    toasts.error(failureMessage);
                    return;
                }
                toasts.info(watched ? m.modal_episode_watched() : m.card_mark_unwatched_done());
                invalidateWhenIdle('app:watch-state');
            } catch {
                toasts.error(failureMessage);
            }
        });
    episodeWatchQueues.set(episodeId, pending);
    try {
        await pending;
    } finally {
        if (episodeWatchQueues.get(episodeId) === pending) episodeWatchQueues.delete(episodeId);
    }
}

/** Enqueue a metadata refresh for an admin-targetable item. */
export async function refreshMediaMetadata(item: UniversalMediaItem): Promise<void> {
    const internalId = getExternalIdFor(item.externalIds, 'internal');
    if (!internalId) return;
    const includeChildren = isSeries(item.mediaType);
    const { error } = await syncMediaMetadata(internalId, includeChildren);
    if (error) {
        toasts.error(m.card_refresh_metadata_failed());
        return;
    }
    toasts.info(m.card_refresh_metadata_done());
}

/**
 * Strong negative signal — submits rating=1 to /api/ai/rate so the AI
 * taste profile learns to avoid similar titles. Movies and series only.
 */
export async function dontRecommendMedia(item: UniversalMediaItem): Promise<boolean> {
    if (!isMovie(item.mediaType) && !isSeries(item.mediaType)) return false;
    const rateMediaType = isSeries(item.mediaType) ? 'tv' : 'movie';
    const { error } = await aiApi.submitRating(
        item.externalIds,
        rateMediaType as ApiMediaType,
        1,
        `User: don't recommend titles like "${item.title}"`,
    );
    if (error) {
        toasts.error(m.card_rate_failed());
        return false;
    }
    toasts.info(m.card_dislike_done());
    return true;
}

/** Whether the item is a video (movie / episode / series). */
export function isVideoItem(item: UniversalMediaItem): boolean {
    return isMovie(item.mediaType) || isEpisode(item.mediaType) || isSeries(item.mediaType);
}

/** Whether the item can be saved to / removed from the watchlist. */
export function canWatchlistMedia(item: UniversalMediaItem): boolean {
    return isMovie(item.mediaType) || isSeries(item.mediaType);
}

/**
 * Toggle an item's watchlist membership. Updates the store optimistically
 * so the menu's add/remove label flips instantly, then reconciles with
 * the server response. Returns the resulting state ('added' | 'removed' |
 * 'unchanged' on error) so callers can fire dependent UI.
 */
export async function toggleWatchlistMedia(
    item: UniversalMediaItem,
    options: { isInWatchlist: boolean },
): Promise<'added' | 'removed' | 'unchanged'> {
    if (!canWatchlistMedia(item)) return 'unchanged';
    const rateMediaType = isSeries(item.mediaType) ? 'tv' : 'movie';
    if (options.isInWatchlist) {
        const { error } = await aiApi.unsaveMovie({
            externalIds: item.externalIds,
            mediaType: rateMediaType as ApiMediaType,
        });
        if (error) {
            toasts.error(m.card_watchlist_remove_failed());
            return 'unchanged';
        }
        removeFromWatchlistStore(item.externalIds, rateMediaType);
        toasts.info(m.card_watchlist_remove_done());
        return 'removed';
    }
    const ratingNum =
        typeof item.rating === 'number'
            ? item.rating
            : Number.parseFloat(String(item.rating ?? ''));
    const { error } = await aiApi.saveMovie({
        externalIds: item.externalIds,
        mediaType: rateMediaType as ApiMediaType,
        title: item.title,
        overview: item.overview ?? undefined,
        rating: Number.isFinite(ratingNum) ? ratingNum : undefined,
        criticRating: item.criticRating ?? undefined,
        canRequest: item.canRequest,
        isAvailable: item.isAvailable,
    });
    if (error) {
        toasts.error(m.card_watchlist_add_failed());
        return 'unchanged';
    }
    const storeItem: WatchlistItem = {
        externalIds: item.externalIds,
        mediaType: rateMediaType,
        title: item.title,
        overview: item.overview ?? undefined,
        rating: Number.isFinite(ratingNum) ? ratingNum : undefined,
        criticRating: item.criticRating ?? undefined,
        canRequest: item.canRequest,
        isAvailable: item.isAvailable,
        savedAt: new Date().toISOString(),
    };
    addToWatchlistStore(storeItem);
    toasts.info(m.card_watchlist_add_done());
    return 'added';
}

/**
 * Case-insensitive admin-group membership check, given the data shape
 * SvelteKit hands us via `$page.data`. Mirrors the inline pattern in
 * `ModalActions.svelte` — pulled out here so HeroSection,
 * FeaturedPickSection, and UniversalMediaCard share one implementation
 * and one place to adjust if `adminGroups` shape changes.
 */
export function isPageAdmin(
    pageData: { user?: { userGroups?: string[] }; adminGroups?: string[] } | null | undefined,
): boolean {
    if (!pageData) return false;
    const adminGroups = (pageData.adminGroups ?? []).map((g) => g.toLowerCase());
    if (adminGroups.length === 0) return false;
    const userGroups = (pageData.user?.userGroups ?? []).map((g) => g.toLowerCase());
    return adminGroups.some((g) => userGroups.includes(g));
}

/** Whether the item carries enough id to use rating endpoints. */
export function canRateMedia(item: UniversalMediaItem): boolean {
    if (!isMovie(item.mediaType) && !isSeries(item.mediaType)) return false;
    const ids = item.externalIds;
    return Boolean(ids?.tmdb || ids?.imdb || ids?.internal);
}

/**
 * One-shot quick-rate path. The right-click menu surfaces three quick
 * buttons (Dislike / Liked / Loved) that all call this with a fixed
 * rating, avoiding the picker for users who just want to thumbs-up.
 *
 * `kind` is recorded in the context string for analytics + AI taste
 * profile bookkeeping.
 */
export async function quickRateMedia(
    item: UniversalMediaItem,
    kind: 'dislike' | 'liked' | 'loved',
): Promise<boolean> {
    if (!canRateMedia(item)) return false;
    const rateMediaType = isSeries(item.mediaType) ? 'tv' : 'movie';
    const rating = kind === 'dislike' ? 1 : kind === 'liked' ? 8 : 10;
    const { error } = await aiApi.submitRating(
        item.externalIds,
        rateMediaType as ApiMediaType,
        rating,
        `User ${kind} "${item.title}" via card menu`,
    );
    if (error) {
        toasts.error(m.card_rate_failed());
        return false;
    }
    toasts.info(
        kind === 'dislike'
            ? m.card_dislike_done()
            : kind === 'liked'
              ? m.card_liked_done()
              : m.card_loved_done(),
    );
    return true;
}
