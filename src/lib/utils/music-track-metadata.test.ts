// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { parseMusicChapters } from './music-track-metadata';

describe('parseMusicChapters', () => {
    it('returns sorted, sanitized chapters from mixed shapes', () => {
        const result = parseMusicChapters([
            { title: 'B', start_ms: 90_000, end_ms: 120_000 },
            { title: 'A', startMs: 30_000, endMs: 90_000, artist: 'DJ' },
            { title: 'Broken', startMs: -1 },
            { title: 'Zero length', startMs: 120_000, endMs: 120_000 },
        ]);

        expect(result).toEqual([
            { title: 'A', startMs: 30_000, endMs: 90_000, artist: 'DJ' },
            { title: 'B', startMs: 90_000, endMs: 120_000 },
            { title: 'Zero length', startMs: 120_000 },
        ]);
    });

    it('returns undefined for non-arrays', () => {
        expect(parseMusicChapters(undefined)).toBeUndefined();
        expect(parseMusicChapters({})).toBeUndefined();
    });
});
