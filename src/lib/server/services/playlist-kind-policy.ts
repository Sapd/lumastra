// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What each kind of playlist allows.
 *
 * Every behavioural difference between a watchlist and an ordinary playlist
 * lives here, as data. The alternative — an `isWatchlist` boolean threaded
 * through PlaylistItemManager and the item defs — spreads the same decision
 * across a dozen call sites, where the next kind of system playlist would have
 * to find them all again.
 *
 * `general`, `music` and `video` are identical and describe today's behaviour
 * exactly; they exist so the lookup is total and so a future divergence has an
 * obvious home.
 */

import type { PlaylistTypeValue } from '$lib/server/database/queries/playlists.queries.js';

export interface PlaylistKindPolicy {
    /** `'all'` or the exact set of `media_items.media_type` values accepted. */
    readonly allowedMediaTypes: ReadonlySet<string> | 'all';
    /** Whether adding a series expands to episodes and an album to tracks. */
    readonly expandContainers: boolean;
    /**
     * How the item list is ordered on read.
     *
     * There is deliberately no `allowReorder` here: blocking reorder is the
     * `is_system` guard's job at the def layer, and a second switch saying the
     * same thing is a second thing to forget.
     */
    readonly sort: 'position' | 'added_at_desc';
}

const OPEN_POLICY: PlaylistKindPolicy = {
    allowedMediaTypes: 'all',
    expandContainers: true,
    sort: 'position',
};

/**
 * A watchlist is a SET of things you intend to watch, not an ordered list of
 * playable items. Adding a series records the series, not its 62 episodes —
 * which is also what keeps the /j IsFavorite semantics identical to the old
 * `user_watchlist` table.
 */
const WATCHLIST_POLICY: PlaylistKindPolicy = {
    allowedMediaTypes: new Set(['movie', 'tv', 'audiobook']),
    expandContainers: false,
    sort: 'added_at_desc',
};

const POLICIES: Readonly<Record<PlaylistTypeValue, PlaylistKindPolicy>> = {
    general: OPEN_POLICY,
    music: OPEN_POLICY,
    video: OPEN_POLICY,
    watchlist: WATCHLIST_POLICY,
};

/** The policy for a playlist type. Unknown/absent types get the open policy. */
export function getPlaylistKindPolicy(
    playlistType: PlaylistTypeValue | null | undefined,
): PlaylistKindPolicy {
    if (!playlistType) return OPEN_POLICY;
    return POLICIES[playlistType] ?? OPEN_POLICY;
}

/** Whether a media type may be added to a playlist governed by `policy`. */
export function isMediaTypeAllowed(policy: PlaylistKindPolicy, mediaType: string): boolean {
    return policy.allowedMediaTypes === 'all' || policy.allowedMediaTypes.has(mediaType);
}
