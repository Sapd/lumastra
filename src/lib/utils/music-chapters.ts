// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music chapter helpers — pure functions shared by MiniPlayer, FullScreenPlayer,
 * and the mobile chapter picker sheet.
 *
 * Chapters are stored in `custom_metadata.chapters` on music media_items and
 * edited from the admin ChaptersTab. They map start/end timestamps (ms) to a
 * title + optional artist — typically used for DJ mixes or compilations.
 */

import type { TrackChapter as MusicChapter } from '$lib/schemas/api-music-dto';

/**
 * Return chapters with `endMs` filled in where missing. Uses the next
 * chapter's start as the fallback end; the last chapter falls back to the
 * total duration (ms). Non-destructive — returns new objects.
 *
 * Assumes chapters are already ordered by startMs. The admin editor keeps
 * them ordered on save.
 */
export function computeChapterEnds(
    chapters: readonly MusicChapter[],
    durationMs: number | undefined,
): MusicChapter[] {
    return chapters.map((ch, i) => {
        if (ch.endMs !== undefined) return { ...ch };
        const next = chapters[i + 1]?.startMs;
        const fallback = next ?? durationMs;
        return fallback !== undefined ? { ...ch, endMs: fallback } : { ...ch };
    });
}

/**
 * Find the chapter covering `positionMs`. Returns the chapter and its index,
 * or null if no chapter contains the position (e.g. before the first chapter
 * starts, or past the final end).
 *
 * Iterates from the last chapter backwards so overlapping entries prefer the
 * later one — same semantics as the video player's `getChapterAtTime`.
 */
export function findChapterAtMs(
    chapters: readonly MusicChapter[],
    positionMs: number,
): { chapter: MusicChapter; index: number } | null {
    for (let i = chapters.length - 1; i >= 0; i--) {
        const ch = chapters[i];
        if (positionMs >= ch.startMs) {
            if (ch.endMs !== undefined && positionMs >= ch.endMs) continue;
            return { chapter: ch, index: i };
        }
    }
    return null;
}

/** Return the chapter immediately after the one containing `positionMs`, if any. */
export function getNextChapter(
    chapters: readonly MusicChapter[],
    positionMs: number,
): MusicChapter | null {
    const current = findChapterAtMs(chapters, positionMs);
    const nextIndex =
        current !== null ? current.index + 1 : chapters.findIndex((ch) => ch.startMs > positionMs);
    if (nextIndex < 0 || nextIndex >= chapters.length) return null;
    return chapters[nextIndex];
}

/**
 * Format milliseconds as `m:ss` or `h:mm:ss`. Used for chapter time labels.
 * Negative / NaN inputs collapse to `0:00`.
 */
export function formatChapterTime(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '0:00';
    const totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}
