// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { isAudio, isAudiobook, isMusic, isMusicType } from '$lib/shared/media-types';

/**
 * MediaHoverCard is a video/trailer hover surface. Audio-only cards should
 * render directly so they never arm irrelevant preview affordances.
 */
export function canWrapMediaHoverCard(item: { mediaType?: string }): boolean {
    return (
        !isAudiobook(item.mediaType) &&
        !isMusicType(item.mediaType) &&
        !isAudio(item.mediaType) &&
        !isMusic(item.mediaType)
    );
}
