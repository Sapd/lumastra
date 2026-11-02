// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Genre Serializers

import type { MusicGenreRow } from '$lib/server/database/queries/music.queries.js';
import type { SubsonicGenre } from '../types.js';

/**
 * Convert one genre DB row to a SubsonicGenre wire object.
 *
 * The genre name is surfaced as `value`. In JSON responses it is a plain
 * field; in XML the serialiser renders it as element text content via the
 * `_text` convention when the XML builder encounters the genre element.
 */
export function serializeGenre(row: MusicGenreRow): SubsonicGenre {
    return {
        songCount: row.track_count,
        albumCount: row.album_count,
        value: row.genre,
    };
}
