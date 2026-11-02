// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Continue-Watching dismissal helper.
 *
 * Extracted so ForYou.svelte and any other surface that renders a CW row
 * (e.g. browse/+page.svelte) agrees on:
 *
 * - how to derive the dismissal target from a UniversalMediaItem
 *   (episodes dismiss at the series level; movies dismiss themselves)
 * - how to POST / DELETE against `/api/continue-watching/dismissals`
 *
 * The endpoint itself is idempotent, so dismiss / restore are fire-and-
 * forget from the caller's perspective. The helpers return a boolean for
 * UI flows that want to distinguish success from failure (e.g. for toast
 * rollback).
 */

import { isAudiobook, isEpisode } from '$lib/shared/media-types';
import type { DismissalTargetType } from '$lib/schemas/api-dismissals-responses';
import type { UniversalMediaItem } from '$lib/types/server-driven-ui';
import { getExternalIdFor } from '$lib/utils/media-id-helpers';
import { postCwDismissal, deleteCwDismissal } from '$lib/api/for-you';

export type CwDismissTargetType = DismissalTargetType;

export interface CwDismissArgs {
    targetId: string;
    targetType: CwDismissTargetType;
}

/**
 * Derive the dismissal target for a CW card.
 *
 * - Episode rows dismiss the parent series — the server populates
 *   `item.seriesId` (series UUID) on episode-context rows specifically
 *   so UI can do this without re-resolving.
 * - Orphan episodes (seriesId missing — broken grandparent chain or live
 *   overlay row with no series join) fall back to the episode's own UUID.
 *   The server-side dismissed_cw filter already coalesces:
 *   `COALESCE(grandparent_mi.id, mi.id)`, so dismissing by the episode
 *   UUID hides that specific card without touching the rest of the series.
 * - Movie and audiobook rows dismiss themselves — the canonical internal
 *   UUID lives in `externalIds.internal`.
 *
 * Returns `null` only when no internal UUID is resolvable at all; callers
 * should surface an error toast in that case.
 */
export function getCwDismissArgs(item: UniversalMediaItem): CwDismissArgs | null {
    const isEp = isEpisode(item.mediaType);
    if (isEp) {
        const seriesId = item.seriesId;
        if (seriesId) {
            return { targetId: seriesId, targetType: 'series' };
        }
        // Orphan episode: no series UUID available. Fall back to the
        // episode's own internal UUID. The server COALESCE already handles
        // this case in the dismissed_cw anti-join, so it will suppress this
        // specific card without affecting the rest of any series.
        const episodeId = item.externalIds
            ? getExternalIdFor(item.externalIds, 'internal')
            : undefined;
        if (!episodeId) return null;
        return { targetId: episodeId, targetType: 'movie' };
    }
    const targetId = item.externalIds ? getExternalIdFor(item.externalIds, 'internal') : undefined;
    if (!targetId) return null;
    return { targetId, targetType: isAudiobook(item.mediaType) ? 'audiobook' : 'movie' };
}

/**
 * Name of what a dismissal hides, for the tooltip and the toast. Episode
 * rows hide the whole series (see getCwDismissArgs), so they name the
 * series rather than the episode.
 */
export function getCwDismissDisplayName(item: UniversalMediaItem): string {
    if (isEpisode(item.mediaType) && item.seriesId && item.seriesName) return item.seriesName;
    return item.title;
}

/**
 * POST the dismissal — marks the target hidden from CW / Next Up read
 * queries. Idempotent server-side: repeating the call is a no-op.
 */
export async function dismissCwItem(args: CwDismissArgs): Promise<boolean> {
    const { error } = await postCwDismissal(args);
    return !error;
}

/**
 * DELETE the dismissal — un-hides the target. Used by the "Undo" action
 * on the dismissal toast.
 */
export async function restoreCwItem(args: CwDismissArgs): Promise<boolean> {
    const { error } = await deleteCwDismissal(args);
    return !error;
}
