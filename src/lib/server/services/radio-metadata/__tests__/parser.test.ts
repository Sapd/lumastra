// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { parseJson, parseRegex } from '../parser';

describe('parseJson', () => {
    it('extracts simple top-level fields via JSONPath', () => {
        const res = parseJson(
            { song: { title: 'Lantern-Tale', artist: 'Lanter' } },
            { title: '$.song.title', artist: '$.song.artist' },
        );
        expect(res).toEqual({ title: 'Lantern-Tale', artist: 'Lanter' });
    });

    it('coerces numeric strings to numbers for duration fields', () => {
        const res = parseJson({ song: { dur: '213' } }, { trackDurationSeconds: '$.song.dur' });
        expect(res).toEqual({ trackDurationSeconds: 213 });
    });

    it('skips missing paths without throwing', () => {
        const res = parseJson(
            { song: { title: 'X' } },
            { title: '$.song.title', djName: '$.dj.name' },
        );
        expect(res).toEqual({ title: 'X' });
    });

    it('supports array index in path', () => {
        const res = parseJson(
            { history: [{ title: 'now' }, { title: 'before' }] },
            { title: '$.history[0].title' },
        );
        expect(res).toEqual({ title: 'now' });
    });

    it('trims leading/trailing whitespace on strings', () => {
        const res = parseJson({ t: '  Lantern-Tale  ' }, { title: '$.t' });
        expect(res).toEqual({ title: 'Lantern-Tale' });
    });

    it('drops empty-string values', () => {
        const res = parseJson({ t: '' }, { title: '$.t' });
        expect(res).toEqual({});
    });
});

describe('parseRegex', () => {
    it('extracts named groups', async () => {
        const res = await parseRegex(
            'Artist: Lanter\nTitle: Lantern-Tale',
            'Artist:\\s+(?<artist>.+)\\nTitle:\\s+(?<title>.+)',
        );
        expect(res).toEqual({ artist: 'Lanter', title: 'Lantern-Tale' });
    });

    it('returns empty object on no match', async () => {
        const res = await parseRegex('nothing here', '(?<title>XYZ)');
        expect(res).toEqual({});
    });

    it('ignores non-canonical named groups', async () => {
        const res = await parseRegex('foo=bar', '(?<foo>\\w+)=(?<title>\\w+)');
        expect(res).toEqual({ title: 'bar' });
    });

    it('throws a clear error for invalid regex', async () => {
        await expect(parseRegex('x', '(unclosed')).rejects.toThrow(/regex/i);
    });

    it('rejects catastrophic-backtracking patterns', async () => {
        await expect(parseRegex('aaaa', '(a+)+')).rejects.toThrow(/unsafe/i);
    });
});

// Security review 2026-09-12, C7 — the "now playing" regex is admin-configured
// but runs over attacker-influenced upstream text.
describe('parseRegex ReDoS hardening (C7)', () => {
    it.each([
        ['duplicate alternation under a quantifier', '(a|a)+'],
        ['alternation nested inside a quantified group', '((a|b)+)+'],
        ['star inside a counted repetition', '(a*){2,}'],
        ['prefix-overlapping alternation', '(?<title>(a|aa)+)$'],
        ['nested quantifier behind a named group', '(?<title>(\\w+)+)$'],
    ])('rejects %s', async (_label, pattern) => {
        await expect(parseRegex('aaaaaaaaaa', pattern)).rejects.toThrow(/unsafe/i);
    });

    it('still accepts ordinary station patterns', async () => {
        const res = await parseRegex('Lanter - Lantern-Tale', '(?<artist>.+) - (?<title>.+)');
        expect(res).toEqual({ artist: 'Lanter', title: 'Lantern-Tale' });
    });

    it('still accepts a quantified alternation of distinct single characters', async () => {
        const res = await parseRegex('abab=Lantern-Tale', '(?:a|b)+=(?<title>.+)');
        expect(res).toEqual({ title: 'Lantern-Tale' });
    });

    it('gives up on a quadratic pattern instead of stalling', async () => {
        // Passes every static heuristic (it is the documented example pattern),
        // but is quadratic against a long line that never contains " - ".
        const started = Date.now();
        await expect(
            parseRegex('a'.repeat(60_000), '(?<artist>.+) - (?<title>.+)'),
        ).rejects.toThrow(/budget|timed out/i);
        expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('truncates input beyond the 64 KiB cap before matching', async () => {
        const far = await parseRegex('x'.repeat(70_000) + 'NEEDLE', '(?<title>NEEDLE)');
        expect(far).toEqual({});
        const near = await parseRegex('x'.repeat(1_000) + 'NEEDLE', '(?<title>NEEDLE)');
        expect(near).toEqual({ title: 'NEEDLE' });
    });

    it('truncates input beyond the 200-line cap before matching', async () => {
        const far = await parseRegex('x\n'.repeat(300) + 'NEEDLE', '(?<title>NEEDLE)');
        expect(far).toEqual({});
        const near = await parseRegex('x\n'.repeat(10) + 'NEEDLE', '(?<title>NEEDLE)');
        expect(near).toEqual({ title: 'NEEDLE' });
    });
});
