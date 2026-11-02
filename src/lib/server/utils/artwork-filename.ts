// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Naming for artwork files written alongside a media file.
 *
 * One place, because two implementations of this already drifted: the copy in
 * `episode-thumbnail-generate` clamped its length and the one in
 * `video-frame-extractor.service.ts` did not, so the same episode could produce
 * a working filename through one path and ENAMETOOLONG through the other.
 */

import { basename, extname } from 'path';

/**
 * Most filesystems (ext4, and the NFS export in front of it) cap a single path
 * COMPONENT at 255 bytes — not characters. 250 leaves headroom.
 */
export const MAX_FILENAME_BYTES = 250;

/**
 * Trim a stem so `stem + suffix` fits the filename byte limit, cutting whole
 * characters so a multi-byte sequence is never split in half.
 *
 * Anime releases genuinely exceed this: a real S02E21 of "The Disastrous Life
 * of Saiki K." carries four episode titles plus release tags in one filename,
 * and appending `-<uuid8>-thumb.jpg` pushed it past the limit — two of the
 * first eighteen production generation attempts died with ENAMETOOLONG.
 */
export function fitStem(stem: string, suffix: string): string {
    const budget = MAX_FILENAME_BYTES - Buffer.byteLength(suffix, 'utf8');
    if (budget <= 0) return '';
    let out = stem;
    while (Buffer.byteLength(out, 'utf8') > budget) {
        out = out.slice(0, -1);
    }
    return out;
}

/**
 * Artwork filename for a media file, length-clamped.
 *
 * The id suffix keeps two episodes that share one physical file (combined
 * multi-episode releases) from colliding on the same alongside filename.
 */
export function artworkFileName(
    videoPath: string,
    artworkType: string,
    mediaItemId?: string,
    ext = '.jpg',
): string {
    const stem = basename(videoPath, extname(videoPath));
    const suffix = `${mediaItemId ? `-${mediaItemId.slice(0, 8)}` : ''}-${artworkType}${ext}`;
    return `${fitStem(stem, suffix)}${suffix}`;
}
