// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { azQuerySchema } from './browse.js';

describe('azQuerySchema language params', () => {
    it('parses audio/subs CSV into validated arrays, dropping unknown tokens', () => {
        const q = azQuerySchema.parse({ audio: 'de,ja,xx', subs: 'en,ja', includeUnknown: 'true' });
        expect(q.audio).toEqual(['de', 'ja']);
        expect(q.subs).toEqual(['en']); // 'ja' not a subtitle option
        expect(q.includeUnknown).toBe(true);
    });
    it('defaults to empty arrays and false', () => {
        const q = azQuerySchema.parse({});
        expect(q.audio).toEqual([]);
        expect(q.subs).toEqual([]);
        expect(q.includeUnknown).toBe(false);
    });
});

describe('azQuerySchema quality params', () => {
    it('parses res/hdr/codec CSV into validated arrays, dropping unknown tokens', () => {
        const q = azQuerySchema.parse({
            res: '4K,xx',
            hdr: 'hdr',
            codec: 'hevc',
            qUnknown: 'true',
        });
        expect(q.res).toEqual(['4K']);
        expect(q.hdr).toEqual(['hdr']);
        expect(q.codec).toEqual(['hevc']);
        expect(q.qUnknown).toBe(true);
    });
    it('defaults to empty arrays and false', () => {
        const q = azQuerySchema.parse({});
        expect(q.res).toEqual([]);
        expect(q.hdr).toEqual([]);
        expect(q.codec).toEqual([]);
        expect(q.qUnknown).toBe(false);
    });
});

describe('azQuerySchema genre/tag whitespace handling', () => {
    it('degrades a whitespace-only tag to an empty string rather than rejecting', () => {
        const q = azQuerySchema.parse({ tag: '   ' });
        expect(q.tag).toBe('');
    });

    it('degrades a whitespace-only genre to an empty string rather than rejecting', () => {
        const q = azQuerySchema.parse({ genre: '   ' });
        expect(q.genre).toBe('');
    });

    it('still validates and trims a genuinely present tag', () => {
        const q = azQuerySchema.parse({ tag: '  whodunit  ' });
        expect(q.tag).toBe('whodunit');
    });

    it('still validates and trims a genuinely present genre', () => {
        const q = azQuerySchema.parse({ genre: '  Science Fiction  ' });
        expect(q.genre).toBe('Science Fiction');
    });

    it('leaves tag/genre undefined when omitted entirely', () => {
        const q = azQuerySchema.parse({});
        expect(q.tag).toBeUndefined();
        expect(q.genre).toBeUndefined();
    });
});
