// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Extract human-readable title segments from a combined-episode filename.
 *
 * Handles two common patterns:
 *   1. Dotted release names:
 *      `Show.S01E05E06.Title.One.-.Title.Two.German.DL.480p.DSNP.WEB-DL.mkv`
 *      → ['Title One', 'Title Two']
 *
 *   2. Dash/space names:
 *      `ShowName-S06E01E02-Episode Title.mkv`
 *      → ['Episode Title']
 *
 * Returns [] when no parseable title region is found — callers must treat an
 * empty result as "no information" and not attempt to match.
 */

/** Technical/quality tokens that delimit the end of title content. */
const TECHNICAL_TOKEN_RE =
    /^(?:German|English|DL|MULTi|1080p|720p|480p|2160p|4K|WEB-DL|WEBRip|WEB|BluRay|BDRip|HDTV|x264|x265|H264|H265|HEVC|AAC|DDP|DD|AC3|FLAC|DSNP|NF|AMZN|iTunes|REPACK|PROPER|GERMAN|COMPLETE)$/i;

/** Matches `S01E01`, `S01E01E02`, `s06e01e02`, etc. */
const SEASON_EPISODE_RE = /[Ss]\d{1,4}[Ee]\d{1,4}(?:(?:[Ee]|-)[Ee]?\d{1,4})*/;

/**
 * Extract title segments from a combined-episode filename.
 *
 * Returns an array of cleaned title strings (1 or more). Returns an empty
 * array when no parseable title region exists or the pattern is ambiguous.
 */
export function extractTitleSegmentsFromFilename(fileName: string): string[] {
    if (!fileName) return [];

    // Strip extension
    const withoutExt = fileName.replace(/\.[^./\\]+$/, '');

    const seMatch = SEASON_EPISODE_RE.exec(withoutExt);
    if (!seMatch) return [];

    const afterSE = withoutExt.slice(seMatch.index + seMatch[0].length);

    // Determine whether the filename is dotted-release or dash/space style.
    // A dotted release has the season/episode token embedded between dots:
    //   Show.Name.S01E05E06.Title.Segment.German...
    // A dash/space release has dashes or spaces around the token:
    //   ShowName-S06E01E02-Title Segment
    const charBefore = withoutExt[seMatch.index - 1] ?? '';
    const charAfter = afterSE[0] ?? '';

    if (charBefore === '.' && charAfter === '.') {
        return parseDottedRelease(afterSE.slice(1)); // skip leading dot
    }

    if (charAfter === '-' || charAfter === ' ' || charAfter === '') {
        const rest = charAfter === '-' || charAfter === ' ' ? afterSE.slice(1) : afterSE;
        return parseDashSpaceRelease(rest);
    }

    return [];
}

/**
 * Parse the post-SE portion of a dotted release.
 * Tokens are separated by `.`; stop at the first technical/quality token.
 * Title segments are separated by `.-. ` (from `.-.` in the filename).
 */
function parseDottedRelease(afterSE: string): string[] {
    const tokens = afterSE.split('.');
    const titleTokens: string[] = [];

    for (const token of tokens) {
        if (!token) continue;
        if (TECHNICAL_TOKEN_RE.test(token)) break;
        titleTokens.push(token);
    }

    if (titleTokens.length === 0) return [];

    // Rejoin with spaces and split on ' - ' (which came from `.-. ` → `. - .`)
    const joined = titleTokens.join(' ').replace(/^\d{1,4}\s+-\s+/, '');
    const segments = joined
        .split(' - ')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

    return segments.length > 0 ? segments : [];
}

/**
 * Parse the post-SE portion of a dash/space-delimited release.
 * The title is the remainder of the string; split on ` - ` if present.
 */
function parseDashSpaceRelease(rest: string): string[] {
    const trimmed = rest
        .replace(/^[ _.-]+/, '')
        .replace(/^\d{1,4}\s+-\s+/, '')
        .trim();
    if (!trimmed) return [];

    const segments = trimmed
        .split(' - ')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

    return segments.length > 0 ? segments : [];
}
