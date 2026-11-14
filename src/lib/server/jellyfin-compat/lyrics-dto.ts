// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stored lyrics (`readStoredLyrics`) → Jellyfin `LyricDto`.
 *
 * Jellyfin returns ONE lyric set per track: the synced (LRC) one when it has
 * it, else the plain text. Synced lines carry `Start` in ticks; plain lines
 * carry none, which is how clients (Finamp, jellyfin-web) tell the two apart
 * along with `Metadata.IsSynced`.
 */

import type { ResolvedLyrics } from '$lib/server/services/music/lyrics.service.js';
import { parseLRC } from '$lib/utils/lrc-parser.js';
import { msToTicks, secondsToTicks } from './constants';
import type { JellyfinLyricDto, JellyfinLyricMetadata } from './types';

export interface LyricTrackInfo {
    title: string | null;
    artist: string | null;
    album: string | null;
    runtimeSeconds: number | null;
}

/** `[length:4:19]` / `[length:259]` → seconds; null when unparseable. */
function parseLrcLength(raw: string | undefined): number | null {
    if (!raw) return null;
    const parts = raw.trim().split(':').map(Number);
    if (parts.length === 0 || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** `[offset:+250]` (milliseconds, signed) → ticks. */
function parseLrcOffset(raw: string | undefined): number | null {
    if (!raw) return null;
    const ms = Number(raw.trim());
    return Number.isFinite(ms) ? msToTicks(ms) : null;
}

export function toJellyfinLyricDto(
    lyrics: ResolvedLyrics,
    track: LyricTrackInfo,
): JellyfinLyricDto | null {
    const trackLength = track.runtimeSeconds ? secondsToTicks(track.runtimeSeconds) : null;

    if (lyrics.synced) {
        const { lines, metadata } = parseLRC(lyrics.synced);
        if (lines.length > 0) {
            const lrcLength = parseLrcLength(metadata.length);
            const meta: JellyfinLyricMetadata = {
                Artist: metadata.ar ?? track.artist,
                Album: metadata.al ?? track.album,
                Title: metadata.ti ?? track.title,
                Author: metadata.au ?? null,
                Length: lrcLength !== null ? secondsToTicks(lrcLength) : trackLength,
                By: metadata.by ?? null,
                Offset: parseLrcOffset(metadata.offset),
                Creator: metadata.re ?? null,
                Version: metadata.ve ?? null,
                IsSynced: true,
            };
            return {
                Metadata: meta,
                Lyrics: lines.map((l) => ({ Text: l.text, Start: msToTicks(l.startMs) })),
            };
        }
    }

    if (lyrics.plain) {
        const lines = lyrics.plain.split(/\r?\n/).map((l) => l.trim());
        // Keep blank lines between stanzas (Jellyfin does) but not at the edges.
        while (lines.length > 0 && lines[0] === '') lines.shift();
        while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        if (lines.length === 0) return null;
        return {
            Metadata: {
                Artist: track.artist,
                Album: track.album,
                Title: track.title,
                Length: trackLength,
                IsSynced: false,
            },
            Lyrics: lines.map((text) => ({ Text: text })),
        };
    }

    return null;
}
