// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { Logger } from './logger.js';

const logger = Logger.for('ImageScanPatterns');

export function buildPatterns(patterns: string[]): {
    episode: RegExp[];
    season: RegExp[];
} {
    const episode: RegExp[] = [];
    const season: RegExp[] = [];

    for (const pattern of patterns) {
        // Match the "<number-part>-<arttype>" shape, e.g. "S##E##-poster" or
        // "season#-poster". Keep the raw pattern (don't pre-expand '#') so the
        // '#' count tells us whether it's a season (one number) or an episode
        // (two numbers) pattern.
        const typeMatch = pattern.match(/^(.+?)-(backdrop|poster|logo|thumb|banner)$/i);
        if (!typeMatch) continue;

        const [, numberPart, artType] = typeMatch;
        // A number field is a RUN of '#' (e.g. "S##E##" has two fields "##",
        // "season#" has one). Count runs, not individual '#'.
        const fieldCount = (numberPart.match(/#+/g) ?? []).length;
        // Bare "poster"/"backdrop" (no number) are folder-level art handled by
        // parseArtworkType, not here.
        if (fieldCount === 0) continue;

        // Turn each '#'-run into ONE CAPTURING group of width max(2, runLength):
        // "#" and "##" -> \d{1,2} (both unchanged), "###" -> \d{1,3}.
        //
        // The floor of 2 is load-bearing, not cosmetic. The shipped config uses
        // "season#-poster" with a SINGLE '#', but real files are zero-padded
        // ("season01-poster.jpg"). Compiling that to \d{1} stops it matching at
        // all. A '#'-run is a field marker, not a strict width — so widen for
        // longer runs, never narrow below the historical two.
        //
        // parseEpisodeNumbers reads match[1] (season) + match[2] (episode);
        // parseSeasonNumber reads match[1] — so the number MUST be captured.
        // Case-insensitivity comes from the 'i' flag, so S/E stay literal.
        const body = `${numberPart.replace(
            /#+/g,
            (run) => `(\\d{1,${Math.max(2, run.length)}})`,
        )}[-_]?${artType.toLowerCase()}`;
        try {
            const re = new RegExp(body, 'i');
            // Two number fields => a season+episode (episode) pattern; one
            // field => a season-only pattern. Routing by count stops a season
            // pattern from ever producing a bogus single-group "episode" regex
            // whose match[2] is undefined (parseInt(undefined) = NaN => 22P02).
            if (fieldCount >= 2) episode.push(re);
            else season.push(re);
        } catch {
            logger.warn('Invalid pattern', { pattern });
        }
    }

    if (episode.length === 0) {
        episode.push(
            // Episode group is \d{1,4}: absolute-numbered anime reaches four
            // digits (Boruto S01E293, Sky Harbor). The literal S/E anchor these,
            // so widening cannot swallow unrelated digit runs.
            /[sS](\d{1,2})[eE](\d{1,4})[-_]?(backdrop|poster|logo|thumb|banner)/i,
            // NxM DELIBERATELY stays \d{1,2}. This form has no letter anchor,
            // so \d{1,4} would make "1920x1080-thumb.jpg" parse as season 20
            // episode 1080 and "3840x2160-backdrop.jpg" as season 40 episode
            // 2160 — attaching resolution-named files to real episodes. The
            // form exists for classic "1x05" numbering, which is never 3-digit.
            /(\d{1,2})[xX](\d{1,2})[-_]?(backdrop|poster|logo|thumb|banner)/i,
            /[sS]eason[\s_-]?(\d{1,2})[\s_-]?[eE]p?(\d{1,4})[-_]?(backdrop|poster|logo|thumb|banner)/i,
        );
    }
    if (season.length === 0) {
        season.push(
            /[sS]eason[\s_-]?(\d{1,2})[-_]?(backdrop|poster|logo|thumb|banner)/i,
            /season[\s_-]?(\d{1,2})[-_]?(backdrop|poster|logo|thumb|banner)/i,
        );
    }

    return { episode, season };
}

export function parseEpisodeNumbers(
    filename: string,
    patterns: RegExp[],
): { seasonNumber: number; episodeNumber: number } | null {
    for (const pattern of patterns) {
        const match = filename.match(pattern);
        if (match) {
            const seasonNumber = parseInt(match[1], 10);
            const episodeNumber = parseInt(match[2], 10);
            // A malformed / single-capture "episode" regex (e.g. the one
            // buildPatterns derives from a season-only pattern like
            // "season#-poster") can match a season poster with match[2]
            // undefined => parseInt(undefined) = NaN. Reject it so the file
            // falls through to season matching instead of sending NaN to an
            // int column (Postgres 22P02 "invalid input syntax for integer").
            if (Number.isNaN(seasonNumber) || Number.isNaN(episodeNumber)) continue;
            return { seasonNumber, episodeNumber };
        }
    }
    return null;
}
