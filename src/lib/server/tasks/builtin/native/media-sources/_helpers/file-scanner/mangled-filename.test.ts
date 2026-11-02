// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { isMangledFilename } from './mangled-filename';

describe('isMangledFilename', () => {
    it('returns false for a plain ASCII path', () => {
        expect(isMangledFilename('/data/music/Robin/Beastmode.mp3')).toBe(false);
    });

    it('returns false for a valid UTF-8 umlaut path (NFC)', () => {
        expect(isMangledFilename('/data/music/Robin/Erlkönig.mp3')).toBe(false);
    });

    it('returns false for a valid UTF-8 umlaut path (NFD)', () => {
        // o + combining diaeresis — still valid UTF-8, must not be flagged.
        expect(isMangledFilename('/data/music/Robin/Erlkönig.mp3')).toBe(false);
    });

    it('returns true when the path contains a U+FFFD replacement char', () => {
        // What fs.readdir produces for a Latin-1 `ö` (byte 0xF6).
        expect(isMangledFilename('/data/music/Robin/Erlk�nig.mp3')).toBe(true);
    });

    it('returns true when the replacement char is anywhere in the path', () => {
        expect(isMangledFilename('/data/music/Gummib�rsong.mp3')).toBe(true);
        expect(isMangledFilename('�')).toBe(true);
    });

    it('returns false for an empty string', () => {
        expect(isMangledFilename('')).toBe(false);
    });
});
