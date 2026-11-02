// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    clampBitrate,
    defaultBitrateFor,
    MP3_BITRATES,
    OPUS_BITRATES,
    AAC_BITRATES,
} from './bitrate-clamp.js';

describe('clampBitrate', () => {
    it('picks largest allowed ≤ requested', () => {
        expect(clampBitrate('mp3', 200)).toBe(192);
        expect(clampBitrate('mp3', 320)).toBe(320);
        expect(clampBitrate('mp3', 321)).toBe(320);
        expect(clampBitrate('opus', 100)).toBe(96);
        expect(clampBitrate('aac', 999)).toBe(320);
    });
    it('clamps to minimum when below all values', () => {
        expect(clampBitrate('mp3', 32)).toBe(64);
        expect(clampBitrate('opus', 0)).toBe(32);
    });
    it('defaults are inside the allowed sets', () => {
        expect(MP3_BITRATES).toContain(defaultBitrateFor('mp3'));
        expect(OPUS_BITRATES).toContain(defaultBitrateFor('opus'));
        expect(AAC_BITRATES).toContain(defaultBitrateFor('aac'));
    });
});
