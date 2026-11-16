// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { sanitizePathSegment } from './path-sanitize';

describe('sanitizePathSegment', () => {
    test('sanitizes path segments', () => {
        expect(sanitizePathSegment('Law & Order: SVU')).toBe('Law & Order_ SVU');
        expect(sanitizePathSegment('Mr. Robot.')).toBe('Mr. Robot');
        expect(sanitizePathSegment('a/b\\c*d?e"f<g>h|i')).toBe('a_b_c_d_e_f_g_h_i');
        expect(sanitizePathSegment('tab\there\u0000x')).toBe('tab_here_x');
        expect(sanitizePathSegment('trailing   ')).toBe('trailing');
    });

    test('never returns an empty segment', () => {
        expect(sanitizePathSegment('')).toBe('_');
        expect(sanitizePathSegment('...')).toBe('_');
        expect(sanitizePathSegment('   ')).toBe('_');
    });

    test('caps at 120 characters and keeps the extension', () => {
        const out = sanitizePathSegment(`${'x'.repeat(300)}.mkv`);
        expect(out).toHaveLength(120);
        expect(out.endsWith('.mkv')).toBe(true);
        expect(sanitizePathSegment('y'.repeat(300))).toHaveLength(120);
    });

    test('two names that sanitize equal get a numeric suffix', () => {
        const used = new Set<string>();
        expect(sanitizePathSegment('Show: A.mkv', used)).toBe('Show_ A.mkv');
        expect(sanitizePathSegment('Show? A.mkv', used)).toBe('Show_ A (2).mkv');
        expect(sanitizePathSegment('Show* A.mkv', used)).toBe('Show_ A (3).mkv');
        // FAT is case-insensitive
        expect(sanitizePathSegment('show_ a.MKV', used)).toBe('show_ a (4).MKV');
    });
});
