// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { RESOLUTION_TIERS, HDR_TIERS, parseTierCsv } from './quality-filter.js';

describe('parseTierCsv', () => {
    it('matches case-insensitively but returns the canonical allowed value, dropping unknown tokens', () => {
        expect(parseTierCsv('4k,1080P,xx', RESOLUTION_TIERS)).toEqual(['4K', '1080p']);
    });
    it('returns [] for undefined or empty', () => {
        expect(parseTierCsv(undefined, RESOLUTION_TIERS)).toEqual([]);
        expect(parseTierCsv('', RESOLUTION_TIERS)).toEqual([]);
    });
    it('respects a different tier vocabulary (hdr)', () => {
        expect(parseTierCsv('hdr,dolby_vision', HDR_TIERS)).toEqual(['hdr', 'dolby_vision']);
    });
});
