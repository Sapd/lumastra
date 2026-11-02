// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** One ancestor of the current media item (as returned in `parentChain`). */
export interface ParentChainEntry {
    id: string;
    mediaType: string;
    title?: string | null;
}

/**
 * Child-listing tab to open on a parent, keyed by the parent's media type.
 * Mirrors the `*Only` tab filters in `+page.svelte` so we land on the tab that
 * lists the siblings of the just-deleted item.
 */
const PARENT_TAB_BY_TYPE: Record<string, string> = {
    album: 'tracks',
    artist: 'discography',
    // `media_items.media_type` stores TV shows as the canonical lowercase 'tv';
    // 'series' is only a legacy/external alias, tolerated here for safety.
    tv: 'episodes',
    series: 'episodes',
    season: 'episodes',
};

const MEDIA_OVERVIEW = '/admin/library/media';

/**
 * Decide where to send the admin after deleting a media item.
 *
 * When the item lived under a parent (a track in an album, an album under an
 * artist, an episode in a season) we return to that parent's child-listing tab
 * so the admin stays in context — e.g. after deleting a track they remain in
 * the album's Tracks view instead of being bounced back to the flat media
 * overview. Top-level items (no parent) fall back to the overview.
 *
 * Returns an app-relative path with no base prefix; callers wrap it with
 * `appPath()` before navigating.
 */
export function afterDeletePath(
    parentId: string | undefined,
    parentChain: readonly ParentChainEntry[],
): string {
    if (!parentId) return MEDIA_OVERVIEW;
    const parent = parentChain.find((entry) => entry.id === parentId);
    const tab = parent ? PARENT_TAB_BY_TYPE[parent.mediaType] : undefined;
    const base = `${MEDIA_OVERVIEW}/${parentId}`;
    return tab ? `${base}?tab=${tab}` : base;
}
