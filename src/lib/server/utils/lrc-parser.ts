// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LRC Lyrics Parser — server-side
 *
 * Parses LRC (Lyric) format into structured timed lyric lines with typed
 * metadata. The low-level tokenizer (`parseLRCRaw`) and timestamp parser
 * (`parseLRCTimestamp`) are shared with the client parser in
 * `$lib/utils/lrc-parser.ts` — the single source of truth. This module only
 * adds the server-specific typed-metadata shaping and API formatting.
 *
 * Supported formats:
 * - Standard: [MM:SS.xx]Line text
 * - Metadata tags: [ar:Artist], [ti:Title], [al:Album], [length:4:19]
 * - Multiple timestamps: [00:12.34][00:45.67]Repeated line
 */

import { parseLRCRaw } from '$lib/utils/lrc-parser.js';

export interface ParsedLyricLine {
    startMs: number;
    text: string;
}

export interface ParsedLyrics {
    lines: ParsedLyricLine[];
    metadata: {
        artist?: string;
        title?: string;
        album?: string;
        length?: string;
    };
}

// Re-export the shared timestamp parser so existing server-side imports keep
// working from a single source of truth (defined in $lib/utils/lrc-parser).
export { parseLRCTimestamp } from '$lib/utils/lrc-parser.js';

/**
 * Parse an LRC string into structured data with typed metadata.
 *
 * Delegates tokenization to the shared `parseLRCRaw`, then maps the raw
 * metadata map onto the well-known `ar`/`ti`/`al`/`length` tags.
 *
 * @param lrcString - Raw LRC file content
 * @returns Parsed lyrics with timed lines and metadata
 */
export function parseLRC(lrcString: string): ParsedLyrics {
    const { timed, metadata: raw } = parseLRCRaw(lrcString);

    const metadata: ParsedLyrics['metadata'] = {};
    if (raw.ar !== undefined) metadata.artist = raw.ar;
    if (raw.ti !== undefined) metadata.title = raw.ti;
    if (raw.al !== undefined) metadata.album = raw.al;
    if (raw.length !== undefined) metadata.length = raw.length;

    return { lines: timed, metadata };
}

/**
 * Format parsed lyrics for API response.
 * Calculates endMs as the startMs of the following line.
 * The last line has no endMs.
 *
 * @param lyrics - Output of parseLRC
 * @returns Array of synced lyric lines suitable for API responses
 */
export function formatLyricsForResponse(
    lyrics: ParsedLyrics,
): Array<{ startMs: number; endMs?: number; text: string }> {
    return lyrics.lines.map((line, index) => {
        const next = lyrics.lines[index + 1];
        return {
            startMs: line.startMs,
            ...(next !== undefined ? { endMs: next.startMs } : {}),
            text: line.text,
        };
    });
}
