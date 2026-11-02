// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { fitStem, artworkFileName, MAX_FILENAME_BYTES } from './artwork-filename.js';

describe('fitStem — ENAMETOOLONG guard', () => {
    const SUFFIX = '-0093a356-thumb.jpg';

    it('leaves a normal filename untouched', () => {
        const stem = 'Ghosts (US) - S04E05 - A Star is Dead - WEBDL-1080p';
        expect(fitStem(stem, SUFFIX)).toBe(stem);
    });

    it('clamps a real over-long anime filename', () => {
        // The exact file that failed on the first production run.
        const stem =
            'The Disastrous Life of Saiki K. (2016) - S02E21 - 045 - Chronicles of the Grandparents Travels + Returning the Favor Toritsukas Ascetic Fasting + A Misunderstanding Between Opposite Sex Friends + A B... [HDTV-720p][8bit][x264][EAC3 2.0][JA]-Erai-raws';
        const name = `${fitStem(stem, SUFFIX)}${SUFFIX}`;
        expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(250);
        expect(name.endsWith(SUFFIX)).toBe(true);
    });

    it('counts BYTES, not characters, and never splits a multi-byte char', () => {
        // 'é' is 2 bytes; a length-based clamp would overshoot the byte budget.
        const stem = 'é'.repeat(400);
        const out = fitStem(stem, SUFFIX);
        const name = `${out}${SUFFIX}`;
        expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(250);
        // Round-tripping proves no surrogate/continuation byte was cut.
        expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
    });

    it('degrades to empty rather than producing an over-long name', () => {
        expect(fitStem('anything', 'x'.repeat(300))).toBe('');
    });
});

describe('artworkFileName', () => {
    it('produces the id-suffixed alongside name', () => {
        expect(
            artworkFileName(
                '/m/Show - S01E05.mkv',
                'thumb',
                'abcdef12-3456-7890-abcd-ef1234567890',
            ),
        ).toBe('Show - S01E05-abcdef12-thumb.jpg');
    });

    it('omits the id suffix when no media item is given', () => {
        expect(artworkFileName('/m/Show - S01E05.mkv', 'thumb')).toBe('Show - S01E05-thumb.jpg');
    });

    it('never exceeds the filename byte budget, even for absurd names', () => {
        const name = artworkFileName(`/m/${'ü'.repeat(500)}.mkv`, 'thumb', 'abcdef12-3456');
        expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(MAX_FILENAME_BYTES);
    });
});
