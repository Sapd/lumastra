// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Backdrop artwork id resolution.
 *
 * Shared by MediaSessionController (lock-screen artwork) and the audio-only
 * backdrop overlay so both surfaces agree on which catalog id backs the
 * fetched image.
 */

import { isEpisode as isEpisodeType } from '$lib/shared/media-types';
import type { PlaybackInfo } from '$lib/types/playback';

/**
 * Backdrop art is series-level: an episode id resolves to null (TMDB
 * episode IDs are a separate namespace), so use the series id for episodes.
 */
export function getBackdropArtworkId(playbackInfo: PlaybackInfo): string {
    const isEpisode = isEpisodeType(playbackInfo.mediaType);
    return isEpisode && playbackInfo.seriesId
        ? playbackInfo.seriesId
        : (playbackInfo.internalId ?? playbackInfo.itemId);
}
