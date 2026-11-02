// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import {
    buildPlaybackProgress,
    type PlaybackProgress,
} from '$lib/schemas/api-playback-progress.js';

/**
 * Contract-neutral Continue Watching presentation decisions.
 *
 * The web section and the public feed/continue-watching endpoints have
 * different envelopes, but they must agree on the media discriminator,
 * progress math, episode context, and which image roles are valid. Keep those
 * decisions here; endpoint adapters should only add their own envelope fields.
 */

import type { PublicMediaType } from '$lib/schemas/common.js';
import { getExternalIdFor } from '$lib/utils/external-ids.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain';
import type { ContinueWatchingItem } from '$lib/server/utils/section-builder.js';

export type ContinueWatchingImageRole = 'poster' | 'backdrop' | 'thumb';

export interface ContinueWatchingPresentation {
    internalId: string;
    publicType: PublicMediaType;
    title: string;
    progress: PlaybackProgress;
    lastPlayedAt?: string;
    overview?: string;
    seriesId?: string;
    seriesName?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    imageRoles: readonly ContinueWatchingImageRole[];
}

/**
 * Map the shared service item once. Returns null for an internal type with no
 * public representation; callers must drop it rather than relabel it.
 */
export function presentContinueWatchingItem(
    item: ContinueWatchingItem & { resumePositionSeconds?: number },
): ContinueWatchingPresentation | null {
    const publicType = toPublicMediaType(item.mediaType);
    if (!publicType) return null;

    const internalId = getExternalIdFor(item.externalIds, 'internal') ?? item.id;
    const durationSeconds = item.duration != null ? item.duration : undefined;
    const rawPosition =
        item.resumePositionSeconds ??
        (durationSeconds != null
            ? durationSeconds * (item.resumeRatio ?? item.watchProgress / 100)
            : undefined);
    const positionSeconds =
        rawPosition == null
            ? undefined
            : durationSeconds != null
              ? Math.min(Math.max(rawPosition, 0), durationSeconds)
              : Math.max(rawPosition, 0);

    return {
        internalId,
        publicType,
        title: item.title,
        progress: buildPlaybackProgress({
            positionMs: positionSeconds == null ? null : Math.round(positionSeconds * 1000),
            durationMs: durationSeconds == null ? null : Math.round(durationSeconds * 1000),
            fraction:
                durationSeconds == null && item.watchProgress > 0
                    ? Math.min(1, Math.max(0, item.watchProgress / 100))
                    : null,
            finished: false,
            updatedAt: item.updatedAt,
        }),
        ...(item.updatedAt ? { lastPlayedAt: item.updatedAt } : {}),
        ...(item.overview ? { overview: item.overview } : {}),
        ...(publicType === 'episode'
            ? {
                  ...(item.seriesId ? { seriesId: item.seriesId } : {}),
                  ...(item.seriesId && item.seriesName ? { seriesName: item.seriesName } : {}),
                  ...(item.seasonNumber != null ? { seasonNumber: item.seasonNumber } : {}),
                  ...(item.episodeNumber != null ? { episodeNumber: item.episodeNumber } : {}),
              }
            : {}),
        // AudiobookShelf books have cover art only. Never publish a backdrop
        // href for them: that role resolves to the generic placeholder.
        imageRoles:
            publicType === 'audiobook' ? ['poster'] : (['poster', 'backdrop', 'thumb'] as const),
    };
}
