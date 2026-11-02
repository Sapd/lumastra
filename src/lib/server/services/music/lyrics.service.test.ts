// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * resolveLyrics — not-found marker behaviour for the bulk lyrics-lrclib-fetch
 * task, whose eligibility is `custom_metadata->'lyrics' IS NULL`.
 *
 * A definitive LRCLIB miss must write the marker (so the row leaves the
 * candidate set); a transient failure must propagate and persist a retry deadline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import type { TrackDetailRow } from '$lib/server/database/queries/music.queries.js';

vi.mock('$lib/server/config.js', () => ({
    features: { autoLyrics: true, saveLyricsToDisk: false },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    },
}));

vi.mock('$lib/server/utils/music-scanner-utils.js', () => ({ writeLyricsSidecar: vi.fn() }));
vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    findMediaFilePathForTrack: vi.fn(),
}));
vi.mock('$lib/server/plugins/runtime/lyrics-providers.js', () => ({
    fetchLyricsFromPlugins: vi.fn().mockResolvedValue(null),
}));

const lrclibMock = vi.hoisted(() => ({ getLyrics: vi.fn() }));
vi.mock('$lib/server/providers/implementations/musicbrainz/lrclib.js', () => lrclibMock);

import { resolveLyrics } from './lyrics.service.js';

function makeSql(): { sql: postgres.Sql; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const fn = vi.fn(async (...args: unknown[]) => {
        calls.push(args);
        return [];
    });
    const sql = Object.assign(fn, { json: (v: unknown) => v }) as unknown as postgres.Sql;
    return { sql, calls };
}

function makeTrack(): TrackDetailRow {
    return {
        id: 'track-1',
        title: 'Long Mix',
        artist_title: 'DJ Someone',
        album_title: 'Mixes',
        runtime_seconds: 4798,
        custom_metadata: {},
    } as unknown as TrackDetailRow;
}

describe('resolveLyrics not-found marker', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('writes the not-found marker when LRCLIB reports a miss (null)', async () => {
        lrclibMock.getLyrics.mockResolvedValue(null);
        const { sql, calls } = makeSql();

        await expect(resolveLyrics(sql, makeTrack())).resolves.toBeNull();

        expect(calls).toHaveLength(1);
        expect(calls[0]).toContainEqual({
            lyrics: { plain: null, synced: null, source: 'lrclib', fetchedAt: expect.any(String) },
        });
    });

    it.each([500, 429, undefined])('backs off transient LRCLIB failures (%s)', async (status) => {
        const now = Date.now();
        const failure = Object.assign(new Error('LRCLIB unavailable'), { status });
        lrclibMock.getLyrics.mockRejectedValue(failure);
        const { sql, calls } = makeSql();
        const track = makeTrack();

        await expect(resolveLyrics(sql, track)).rejects.toThrow('LRCLIB unavailable');
        const payload = calls[0]?.find((v) => typeof v === 'object' && v && 'lyricsRetry' in v) as
            { lyricsRetry: { attempts: number; nextRetryAt: string } } | undefined;
        expect(payload?.lyricsRetry.attempts).toBe(1);
        expect(Date.parse(payload!.lyricsRetry.nextRetryAt)).toBeGreaterThanOrEqual(
            now + 3_600_000,
        );
        expect(calls[0]).not.toContainEqual(expect.objectContaining({ lyrics: expect.anything() }));

        track.custom_metadata = { lyricsRetry: payload!.lyricsRetry };
        lrclibMock.getLyrics.mockClear();
        await expect(resolveLyrics(sql, track)).resolves.toBeNull();
        expect(lrclibMock.getLyrics).not.toHaveBeenCalled();
    });

    it.each([1, 2, 5, 50])('doubles the retry delay up to 24h (attempts=%i)', async (attempts) => {
        const { sql, calls } = makeSql();
        const track = makeTrack();
        track.custom_metadata = {
            lyricsRetry: { attempts, nextRetryAt: new Date(0).toISOString() },
        };
        lrclibMock.getLyrics.mockRejectedValue(new TypeError('network failure'));
        const now = Date.now();
        await expect(resolveLyrics(sql, track)).rejects.toThrow('network failure');
        const payload = calls[0]?.find((v) => typeof v === 'object' && v && 'lyricsRetry' in v) as {
            lyricsRetry: { attempts: number; nextRetryAt: string };
        };
        expect(payload.lyricsRetry.attempts).toBe(attempts + 1);
        expect(Date.parse(payload.lyricsRetry.nextRetryAt) - now).toBeCloseTo(
            Math.min(24, 2 ** Math.min(attempts, 5)) * 3_600_000,
            -2,
        );
    });

    it('honours a longer Retry-After and clears retry state on a definitive miss', async () => {
        const { sql, calls } = makeSql();
        const track = makeTrack();
        lrclibMock.getLyrics.mockRejectedValue(
            Object.assign(new Error('throttled'), { retryAfterMs: 172_800_000 }),
        );
        const now = Date.now();
        await expect(resolveLyrics(sql, track)).rejects.toThrow('throttled');
        const payload = calls[0]?.find((v) => typeof v === 'object' && v && 'lyricsRetry' in v) as {
            lyricsRetry: { nextRetryAt: string };
        };
        expect(Date.parse(payload.lyricsRetry.nextRetryAt)).toBeGreaterThanOrEqual(
            now + 172_800_000,
        );
        track.custom_metadata = {
            lyricsRetry: { attempts: 2, nextRetryAt: new Date(0).toISOString() },
        };
        lrclibMock.getLyrics.mockResolvedValue(null);
        await resolveLyrics(sql, track);
        expect(String(calls[1]?.[0])).toContain("- 'lyricsRetry'");
    });
});
