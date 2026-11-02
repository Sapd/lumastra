// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { hasControlChars } from './filename-safety';

describe('hasControlChars', () => {
    it('returns false for a plain ASCII path', () => {
        expect(hasControlChars('/data/movies/Cinderella (1950)/Cinderella.mkv')).toBe(false);
    });

    it('returns false for a valid UTF-8 umlaut path', () => {
        expect(hasControlChars('/data/music/Robin/Erlkönig.mp3')).toBe(false);
    });

    it('returns true for an embedded newline', () => {
        expect(hasControlChars("Movie.Part2\nfile '/tmp/outside.mkv'.mkv")).toBe(true);
    });

    it('returns true for an embedded carriage return', () => {
        expect(hasControlChars('Movie.Part2\rfile.mkv')).toBe(true);
    });

    it('returns true for a NUL byte', () => {
        expect(hasControlChars('Movie\u0000.mkv')).toBe(true);
    });

    it('returns true for DEL (U+007F)', () => {
        expect(hasControlChars('Movie\u007f.mkv')).toBe(true);
    });

    it('returns false for an empty string', () => {
        expect(hasControlChars('')).toBe(false);
    });
});
