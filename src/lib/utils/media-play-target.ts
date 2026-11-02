// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * media-play-target.ts
 *
 * ONE answer to "where does pressing play on this card go?".
 *
 * `/watch` is the VIDEO route: its loader resolves a video stream and 404s
 * anything else outright ("Non-playable types (audiobook, book, etc.) are not
 * watchable" — `src/routes/watch/[itemId]/+page.server.ts`). But
 * `getPlayableId()` happily returns an audiobook's internal UUID, so every
 * `if (getPlayableId(item)) navigateToWatch(...)` gate in the app passed for
 * books and sent them to a dead end. This module is that gate, done once, with
 * the audiobook arm checked FIRST and against the RAW media type.
 */

import { isAudiobook, isEpisode } from '$lib/shared/media-types';
import { getLocalPreviewId, getPlayableId } from '$lib/utils/media-id-helpers';
// =============================================================================
// Play target
// =============================================================================

/** Where a play affordance (card button, hover popup, context menu) should go. */
export type MediaPlayTarget =
    /** Start the globally-mounted audiobook player on this internal UUID. */
    | { kind: 'audiobook'; mediaId: string }
    /** Navigate to the video player route `/watch/{playbackId}`. */
    | { kind: 'watch'; playbackId: string }
    /**
     * Nothing this component can start itself — hand off to the `onplay`
     * callback (requests, metadata-only / external items).
     */
    | { kind: 'delegate' };

/**
 * The minimum shape of a card item needed to resolve a play target.
 *
 * Deliberately structural rather than `UniversalMediaItem` so this module stays
 * testable with plain object literals.
 */
export interface PlayableMediaItem {
    mediaType?: string | null;
    id?: string;
    hasFiles?: boolean;
    externalIds?: { jellyfin?: string; internal?: string };
}

/**
 * Resolve where "play" goes for a hovered card.
 *
 * `/watch` is the VIDEO route: its loader resolves a video stream and its page
 * mounts the video player, so an audiobook reaching it is a dead end (this is
 * also why `buildWatchSlug()` returns `null` for audiobooks — deliberately).
 * An audiobook instead plays through the audiobook player that
 * `+layout.svelte` mounts on every page, addressed by the internal
 * `media_items.id` UUID.
 *
 * **No position is threaded for the audiobook case, by design.** Omitting
 * `positionMs` makes the server answer with AudiobookShelf's own saved
 * progress — the position both systems already agree on. Our Continue Watching
 * row can legitimately disagree with ABS (the listener may have continued in
 * the ABS app since), so sending our number could overwrite theirs. A client
 * that never sends a position structurally cannot reset progress. Only a
 * genuine "start HERE" (a chapter jump) supplies one.
 *
 * The audiobook arm is checked FIRST and against the RAW `mediaType`: putting
 * it after the `getPlayableId()` result — which happily returns the UUID of a
 * book — is how the book ended up on `/watch`.
 */
export function resolveMediaPlayTarget(item: PlayableMediaItem): MediaPlayTarget {
    if (isAudiobook(item.mediaType)) {
        // The audiobook session route resolves `media_items.id`, so this needs
        // the internal UUID specifically — never a Jellyfin id, which is what
        // `getPlayableId()` may return. `getLocalPreviewId()` is that internal-
        // UUID resolver (named for its first caller, the preview pipeline,
        // which has the same requirement).
        const mediaId = getLocalPreviewId(item);
        return mediaId === undefined ? { kind: 'delegate' } : { kind: 'audiobook', mediaId };
    }

    const playbackId = getPlayableId(item);
    return playbackId === undefined ? { kind: 'delegate' } : { kind: 'watch', playbackId };
}

/**
 * Build the `/watch` URL for a video play target.
 *
 * `previewPositionSeconds` is the preview player's ABSOLUTE source time, and is
 * only present once real preview playback has started — so its presence means
 * the viewer actually watched some of the preview and `?t=` should continue
 * from there. Absent, the watch page resumes from server state.
 */
export function buildWatchUrlWithPosition(
    playbackId: string,
    previewPositionSeconds?: number,
): string {
    return previewPositionSeconds !== undefined && previewPositionSeconds > 0
        ? `/watch/${playbackId}?t=${Math.floor(previewPositionSeconds)}`
        : `/watch/${playbackId}`;
}

/** The minimum shape of a Continue Watching / Hero item for {@link continueTargetFor}. */
export interface ContinuableMediaItem {
    mediaType?: string | null;
    seriesId?: string;
    /** Season of an episode; 0 = specials. */
    seasonNumber?: number | null;
    /** Watch progress, 0-100. */
    progress?: number;
}

/**
 * The `/watch/{id}` id for a Continue Watching / Hero **resume** action, or
 * null when the item's own play target applies.
 *
 * A resumed episode with a known series enters continue mode through the
 * series URL: `/watch/<seriesId>` redirects to the series watch marker, so a
 * stale card cannot pin an episode the user has since moved past on another
 * device. Movies, non-resume items and `?t=` links (explicit episode mode)
 * keep their own target. So do season-0 specials: the series marker never
 * resolves to a special, so the series URL would send a special's card to a
 * main-line episode.
 *
 * M15 (card label = click target): the card shows its row's own episode, and
 * the marker's durable step is that same Continue Watching row. Only a fresh
 * live session elsewhere in the series wins over it, and that is the more
 * recent position.
 */
export function continueTargetFor(item: ContinuableMediaItem): string | null {
    if (!item.seriesId || !isEpisode(item.mediaType)) return null;
    if (item.seasonNumber === 0) return null;
    return (item.progress ?? 0) > 0 ? item.seriesId : null;
}
