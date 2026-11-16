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

    test('Windows reserved names get an underscore, with or without extension', () => {
        expect(sanitizePathSegment('CON')).toBe('CON_');
        expect(sanitizePathSegment('nul.mkv')).toBe('nul_.mkv');
        expect(sanitizePathSegment('Com1')).toBe('Com1_');
        expect(sanitizePathSegment('LPT9.tar.gz')).toBe('LPT9_.tar.gz');
        expect(sanitizePathSegment('Console')).toBe('Console');
        expect(sanitizePathSegment('COM0')).toBe('COM0');
    });

    test('truncation never cuts a surrogate pair', () => {
        // 119 units + one emoji (2 units): a naive slice(0, 120) would keep a lone high surrogate
        const name = `${'a'.repeat(119)}\u{1F600}\u{1F600}`;
        const out = sanitizePathSegment(name);
        expect(out).toBe('a'.repeat(119));
        expect(out).not.toMatch(/[\ud800-\udbff]$/);
        const withExt = sanitizePathSegment(`${'a'.repeat(114)}\u{1F600}\u{1F600}.mkv`);
        expect(withExt.endsWith('.mkv')).toBe(true);
        expect(withExt).not.toMatch(/[\ud800-\udbff]\.mkv$/);
        expect(withExt.length).toBeLessThanOrEqual(120);
    });

    test('two names that sanitize equal get a numeric suffix', () => {
        const used = new Set<string>();
        expect(sanitizePathSegment('Show: A.mkv', used)).toBe('Show_ A.mkv');
        expect(sanitizePathSegment('Show? A.mkv', used)).toBe('Show_ A (2).mkv');
        expect(sanitizePathSegment('Show* A.mkv', used)).toBe('Show_ A (3).mkv');
        // FAT is case-insensitive
        expect(sanitizePathSegment('show_ a.MKV', used)).toBe('show_ a (4).MKV');
    });

    test('caps a segment at 200 UTF-8 bytes (CJK titles), keeps the extension, no split characters', () => {
        const title = '\u6f22'.repeat(100); // 100 chars, 300 bytes
        const out = sanitizePathSegment(`${title}.mkv`);
        expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(200);
        expect(out.endsWith('.mkv')).toBe(true);
        expect(out).not.toContain('\ufffd');
        expect(out.slice(0, -4)).toMatch(/^\u6f22+$/);
    });

    test('does not split a surrogate pair at the byte cap and keeps collision suffixes within the cap', () => {
        const emoji = '\u{1F600}'.repeat(60); // 4 bytes each
        const used = new Set<string>();
        const a = sanitizePathSegment(`${emoji}.mp4`, used);
        const b = sanitizePathSegment(`${emoji}.mp4`, used);
        for (const o of [a, b]) {
            expect(new TextEncoder().encode(o).length).toBeLessThanOrEqual(200);
            expect(o.endsWith('.mp4')).toBe(true);
            expect(o.slice(0, -4).replace(/ \(\d+\)$/, '')).toMatch(/^(\u{1F600})+$/u);
        }
        expect(a).not.toBe(b);
    });
});
