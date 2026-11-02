// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { MusicTrack } from '$lib/schemas/music';

/** A catalog card can start playback before its full detail request completes. */
export function musicTrackFromCard(input: Pick<MusicTrack, 'id' | 'title'> & Partial<MusicTrack>): MusicTrack {
    return {
        type: 'track', artists: [], albumArtist: null, album: null,
        trackNumber: null, discNumber: null, durationMs: null,
        genres: [], year: null, isRadio: false,
        ...input,
        images: input.images ?? {},
    };
}
