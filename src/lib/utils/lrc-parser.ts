// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LRC Lyrics Parser — client-side (shared)
 *
 * Parses LRC format and provides utilities for synchronized lyric display.
 * This module must NOT import from $lib/server/.
 *
 * Supported formats:
 * - Standard: [MM:SS.xx]Line text
 * - Metadata tags: [ar:Artist], [ti:Title], [al:Album], [length:4:19]
 * - Multiple timestamps: [00:12.34][00:45.67]Repeated line
 */

export interface SyncedLyricLine {
    startMs: number;
    endMs?: number;
    text: string;
}

/**
 * Parse a single LRC timestamp to milliseconds.
 * Handles [MM:SS.xx], [MM:SS.xxx], and [MM:SS] formats.
 *
 * @param timestamp - Timestamp string including brackets, e.g. "[01:23.45]"
 * @returns Milliseconds, or null if the format is not a valid timestamp
 */
export function parseLRCTimestamp(timestamp: string): number | null {
    const match = timestamp.match(/^\[(\d+):(\d{2})(?:\.(\d{2,3}))?\]$/);
    if (!match) {
        return null;
    }

    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    const centisOrMillis = match[3] ?? '0';

    let fracMs: number;
    if (centisOrMillis.length === 3) {
        fracMs = parseInt(centisOrMillis, 10);
    } else {
        fracMs = parseInt(centisOrMillis, 10) * 10;
    }

    const result = minutes * 60_000 + seconds * 1_000 + fracMs;
    return Number.isNaN(result) ? null : result;
}

/**
 * Low-level LRC parse: tokenize raw LRC text into sorted timed lines and a raw
 * metadata key/value map. Shared source of truth for both the client `parseLRC`
 * (which adds `endMs`) and the server parser (which maps metadata to a typed
 * shape). Keep this dependency-free so server code can import it.
 *
 * @param lrcString - Raw LRC file content
 * @returns Sorted timed lines (no `endMs`) and lowercased raw metadata map
 */
export function parseLRCRaw(lrcString: string): {
    timed: Array<{ startMs: number; text: string }>;
    metadata: Record<string, string>;
} {
    const rawLines = lrcString.split(/\r?\n/);
    const timed: Array<{ startMs: number; text: string }> = [];
    const metadata: Record<string, string> = {};

    const metaPattern = /^\[([a-zA-Z]+):(.+)\]$/;
    const timestampPattern = /^(\[[\d:.\]]+)+/;

    for (const rawLine of rawLines) {
        const line = rawLine.trim();
        if (line === '') {
            continue;
        }

        const metaMatch = line.match(metaPattern);
        if (metaMatch) {
            metadata[metaMatch[1].toLowerCase()] = metaMatch[2].trim();
            continue;
        }

        const tsAreaMatch = line.match(timestampPattern);
        if (!tsAreaMatch) {
            continue;
        }

        const tsArea = tsAreaMatch[0];
        const text = line.slice(tsArea.length);
        const tokens = tsArea.match(/\[[^\]]*\]/g) ?? [];

        for (const token of tokens) {
            const ms = parseLRCTimestamp(token);
            if (ms === null) {
                continue;
            }
            timed.push({ startMs: ms, text });
        }
    }

    timed.sort((a, b) => a.startMs - b.startMs);

    return { timed, metadata };
}

/**
 * Parse an LRC string into synced lyric lines with endMs calculated.
 *
 * @param lrcString - Raw LRC file content
 * @returns Parsed lines (with endMs) and raw metadata key/value map
 */
export function parseLRC(lrcString: string): {
    lines: SyncedLyricLine[];
    metadata: Record<string, string>;
} {
    const { timed, metadata } = parseLRCRaw(lrcString);

    const lines: SyncedLyricLine[] = timed.map((entry, index) => {
        const next = timed[index + 1];
        return {
            startMs: entry.startMs,
            ...(next !== undefined ? { endMs: next.startMs } : {}),
            text: entry.text,
        };
    });

    return { lines, metadata };
}

/**
 * Find the index of the currently active lyric line based on playback time.
 *
 * Returns -1 if currentTimeMs is before the first line.
 * Returns the index of the last line once playback is past it.
 *
 * @param lines - Sorted array of synced lyric lines
 * @param currentTimeMs - Current playback position in milliseconds
 * @returns Index of the active line, or -1 if none is active yet
 */
export function getCurrentLine(lines: SyncedLyricLine[], currentTimeMs: number): number {
    if (lines.length === 0) {
        return -1;
    }

    if (currentTimeMs < lines[0].startMs) {
        return -1;
    }

    // Binary search for the rightmost line whose startMs <= currentTimeMs
    let lo = 0;
    let hi = lines.length - 1;

    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lines[mid].startMs <= currentTimeMs) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }

    return lo;
}

/**
 * Get a window of visible lines centred around the current line.
 *
 * Returns up to windowSize lines before and windowSize lines after
 * currentIndex, clamped to array bounds.
 *
 * @param lines - All synced lyric lines
 * @param currentIndex - Index of the active line (may be -1)
 * @param windowSize - Number of lines to show on each side of the active line
 * @returns Sliced lines and the absolute start index within the original array
 */
export function getVisibleLines(
    lines: SyncedLyricLine[],
    currentIndex: number,
    windowSize: number = 5,
): { lines: SyncedLyricLine[]; startIndex: number } {
    if (lines.length === 0) {
        return { lines: [], startIndex: 0 };
    }

    // Treat -1 (before first line) as if we are at position 0
    const center = Math.max(0, currentIndex);

    const startIndex = Math.max(0, center - windowSize);
    const endIndex = Math.min(lines.length, center + windowSize + 1);

    return {
        lines: lines.slice(startIndex, endIndex),
        startIndex,
    };
}

/** A stretch of a synced track where nobody sings (intro, solo, bridge). */
export interface LyricInterlude {
    /** Index of the line the interlude follows; -1 for the intro before the first line. */
    afterIndex: number;
    startMs: number;
    endMs: number;
}

/** Shortest silence worth an indicator; shorter breaks are just breathing room. */
export const MIN_INTERLUDE_MS = 5_000;

/**
 * LRC carries only start times, so how long a line is SUNG has to be guessed:
 * a base plus a per-word share, capped. Over-estimating only shortens the
 * indicator; under-estimating would show it while the singer is still going.
 */
export function estimateSungMs(text: string): number {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    return Math.min(1_500 + words * 450, 7_000);
}

/**
 * Find the instrumental gaps in synced lyrics: the intro before the first line,
 * blank LRC lines (the usual instrumental marker), and long silences after a
 * sung line. Nothing is reported after the last line — an outro has no next
 * line to count down to.
 */
export function findLyricInterludes(
    lines: SyncedLyricLine[],
    minGapMs: number = MIN_INTERLUDE_MS,
): LyricInterlude[] {
    const interludes: LyricInterlude[] = [];
    if (lines.length === 0) return interludes;

    if (lines[0].startMs >= minGapMs) {
        interludes.push({ afterIndex: -1, startMs: 0, endMs: lines[0].startMs });
    }

    for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        const nextStartMs = lines[i + 1].startMs;
        const startMs =
            line.text.trim() === '' ? line.startMs : line.startMs + estimateSungMs(line.text);
        if (nextStartMs - startMs >= minGapMs) {
            interludes.push({ afterIndex: i, startMs, endMs: nextStartMs });
        }
    }

    return interludes;
}
