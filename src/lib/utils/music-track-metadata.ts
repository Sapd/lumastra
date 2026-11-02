// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { TrackChapter as MusicChapter } from '$lib/schemas/api-music-dto';

export function parseMusicChapters(raw: unknown): MusicChapter[] | undefined {
    if (!Array.isArray(raw)) return undefined;

    const chapters: MusicChapter[] = [];

    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;

        const row = entry as Record<string, unknown>;
        const title = typeof row.title === 'string' ? row.title : '';
        const startMsRaw =
            typeof row.start_ms === 'number'
                ? row.start_ms
                : typeof row.startMs === 'number'
                  ? row.startMs
                  : NaN;

        if (!Number.isFinite(startMsRaw) || startMsRaw < 0) continue;

        const next: MusicChapter = {
            title,
            startMs: Math.floor(startMsRaw),
        };

        if (typeof row.artist === 'string' && row.artist) {
            next.artist = row.artist;
        }

        const endMsRaw =
            typeof row.end_ms === 'number'
                ? row.end_ms
                : typeof row.endMs === 'number'
                  ? row.endMs
                  : undefined;

        if (endMsRaw !== undefined && Number.isFinite(endMsRaw) && endMsRaw > next.startMs) {
            next.endMs = Math.floor(endMsRaw);
        }

        chapters.push(next);
    }

    chapters.sort((a, b) => a.startMs - b.startMs);
    return chapters;
}
