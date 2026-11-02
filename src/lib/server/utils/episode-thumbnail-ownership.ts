// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { buildPatterns, parseEpisodeNumbers } from './image-scan-patterns.js';
import { basename, dirname, extname } from 'path';

/** A sidecar must identify this item or one of its actual physical files. */
export function ownsEpisodeThumb(
    imagePath: string,
    videoPaths: readonly string[],
    episodeId: string,
    numbering?: {
        seasonNumber: number | null;
        episodeNumber: number | null;
        patterns: RegExp[];
    },
): boolean {
    const stem = basename(imagePath, extname(imagePath)).toLowerCase();
    const owner = episodeId.toLowerCase();
    // New immutable frame files carry the full owner UUID followed by a nonce.
    if (
        stem.startsWith(`${owner}-`) &&
        /^[0-9a-f-]{36}-thumb$/i.test(stem.slice(episodeId.length + 1))
    )
        return true;
    if (
        videoPaths.some(
            (video) =>
                dirname(video) === dirname(imagePath) &&
                stem === `${basename(video, extname(video)).toLowerCase()}-thumb`,
        )
    )
        return true;
    // Numbered sidecars are independent of the current release name. Only
    // explicit artwork patterns qualify here; broad release parsing would also
    // accept obsolete releases. Require the episode's actual video directory.
    if (numbering && videoPaths.some((video) => dirname(video) === dirname(imagePath))) {
        const numbers = parseEpisodeNumbers(basename(imagePath), [
            ...numbering.patterns,
            ...buildPatterns([]).episode,
        ]);
        if (
            numbers &&
            numbers.seasonNumber === numbering.seasonNumber &&
            numbers.episodeNumber === numbering.episodeNumber
        )
            return true;
    }
    // A clamped filename carries an owner suffix; a sibling's suffix must not
    // be accepted just because both episodes have the same video-stem prefix.
    const suffix = /-([0-9a-f]{8})-thumb$/i.exec(stem);
    return suffix?.[1] === owner.slice(0, 8);
}
