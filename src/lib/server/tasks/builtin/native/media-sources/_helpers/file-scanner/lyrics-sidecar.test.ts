// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSidecarLyrics } from '$lib/server/utils/music-scanner-utils.js';
import {
    sidecarStemKey,
    buildSidecarStemIndex,
    sidecarLyricsNeedsRefresh,
    type StoredLyricsState,
} from './lyrics-sidecar.js';

describe('sidecarStemKey', () => {
    it('strips the extension and keys by dir + stem', () => {
        expect(sidecarStemKey('/music/A/song.lrc')).toBe('/music/A\u0000song');
        expect(sidecarStemKey('/music/A/song.txt')).toBe('/music/A\u0000song');
    });

    it('matches an audio file to its sibling sidecar', () => {
        expect(sidecarStemKey('/music/A/song.mp3')).toBe(sidecarStemKey('/music/A/song.lrc'));
    });

    it('keeps tracks with the same stem in different folders distinct', () => {
        expect(sidecarStemKey('/music/A/song.mp3')).not.toBe(sidecarStemKey('/music/B/song.mp3'));
    });

    it('preserves a dotted stem (only the final extension is stripped)', () => {
        expect(sidecarStemKey('/music/A/track.2.0.lrc')).toBe('/music/A\u0000track.2.0');
    });
});

describe('buildSidecarStemIndex', () => {
    it('groups .lrc and .txt sharing a stem under one key', () => {
        const index = buildSidecarStemIndex(['/m/song.lrc', '/m/song.txt', '/m/other.txt']);
        expect(index.get(sidecarStemKey('/m/song.mp3'))).toEqual(['/m/song.lrc', '/m/song.txt']);
        expect(index.get(sidecarStemKey('/m/other.flac'))).toEqual(['/m/other.txt']);
    });

    it('returns an empty map for no sidecars', () => {
        expect(buildSidecarStemIndex([]).size).toBe(0);
    });
});

describe('sidecarLyricsNeedsRefresh', () => {
    const file = (over: Partial<StoredLyricsState> = {}): StoredLyricsState => ({
        source: 'file',
        sidecarPath: '/m/song.lrc',
        sidecarMtimeMs: 1000,
        ...over,
    });

    it('is false when no sidecar exists for the stem', () => {
        expect(sidecarLyricsNeedsRefresh(null, [], 1000)).toBe(false);
        expect(sidecarLyricsNeedsRefresh(file(), [], 1000)).toBe(false);
    });

    it('never overrides user-uploaded lyrics', () => {
        expect(sidecarLyricsNeedsRefresh({ source: 'user' }, ['/m/song.lrc'], 1000)).toBe(false);
    });

    it('ingests when no lyrics exist yet', () => {
        expect(sidecarLyricsNeedsRefresh(null, ['/m/song.txt'], null)).toBe(true);
        expect(sidecarLyricsNeedsRefresh(undefined, ['/m/song.txt'], null)).toBe(true);
    });

    it('lets a file sidecar win over embedded / lrclib lyrics', () => {
        expect(sidecarLyricsNeedsRefresh({ source: 'embedded' }, ['/m/song.lrc'], null)).toBe(true);
        expect(sidecarLyricsNeedsRefresh({ source: 'lrclib' }, ['/m/song.lrc'], null)).toBe(true);
    });

    it('upgrades a stored .txt when a .lrc now exists', () => {
        const lyrics = file({ sidecarPath: '/m/song.txt' });
        expect(sidecarLyricsNeedsRefresh(lyrics, ['/m/song.txt', '/m/song.lrc'], 1000)).toBe(true);
    });

    it('does not re-upgrade when the stored sidecar is already the .lrc', () => {
        expect(
            sidecarLyricsNeedsRefresh(file({ sidecarPath: '/m/song.lrc' }), ['/m/song.lrc'], 1000),
        ).toBe(false);
    });

    it('promotes a legacy file-sourced row with no stored path (backfill)', () => {
        expect(sidecarLyricsNeedsRefresh({ source: 'file' }, ['/m/song.lrc'], 1234)).toBe(true);
    });

    it('leaves a file-sourced row alone when its stored sidecar is gone/central', () => {
        // storedPathCurrentMtimeMs === null → not walk-visible
        expect(sidecarLyricsNeedsRefresh(file(), ['/m/song.lrc'], null)).toBe(false);
    });

    it('detects an in-place edit (mtime changed)', () => {
        expect(
            sidecarLyricsNeedsRefresh(file({ sidecarMtimeMs: 1000 }), ['/m/song.lrc'], 5000),
        ).toBe(true);
    });

    it('ignores sub-2ms mtime jitter', () => {
        expect(
            sidecarLyricsNeedsRefresh(file({ sidecarMtimeMs: 1000 }), ['/m/song.lrc'], 1001),
        ).toBe(false);
    });

    it('promotes when the stored mtime is missing but the file is present', () => {
        expect(
            sidecarLyricsNeedsRefresh(file({ sidecarMtimeMs: undefined }), ['/m/song.lrc'], 1000),
        ).toBe(true);
    });
});

describe('sidecar lyrics text', () => {
    it.each(['lrc', 'txt'])(
        'strips NULs from a .%s sidecar (Postgres rejects 0x00)',
        async (ext) => {
            const dir = await mkdtemp(join(tmpdir(), 'lumastra-sidecar-nul-'));
            try {
                await writeFile(join(dir, `song.${ext}`), 'first\0 line\nsecond');
                const r = await findSidecarLyrics(join(dir, 'song.mp3'));
                expect(r?.plain).toBe('first line\nsecond');
                expect(JSON.stringify(r)).not.toContain('\\u0000');
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        },
    );
});
