// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { MusicTrack } from '$lib/schemas/music.js';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import { toMusicTrack, type MusicTrackRow } from '$lib/server/services/music/track-projection.js';

export interface MusicSearchRow extends Omit<MusicTrackRow, 'id'> {
    media_id: string;
}

export function musicSearchRowToTrack(row: MusicSearchRow, images: ImageSet): MusicTrack {
    return toMusicTrack({ ...row, id: row.media_id }, images);
}
