// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { parseTokens, makeToken, stripTokens } from './tokens.js';

const UUID_1 = '00000000-0000-0000-0000-000000000001';
const UUID_2 = '00000000-0000-0000-0000-000000000002';
const KEEP = '11111111-1111-1111-1111-111111111111';
const DROP = '22222222-2222-2222-2222-222222222222';

describe('media tokens', () => {
    it('makeToken + parseTokens round-trips refs with positions', () => {
        const body = `watch ${makeToken(UUID_1, 'movie')} and ${makeToken(UUID_2, 'episode')}`;
        const refs = parseTokens(body);
        expect(refs).toEqual([
            { id: UUID_1, mediaType: 'movie' },
            { id: UUID_2, mediaType: 'episode' },
        ]);
    });
    it('ignores malformed tokens', () => {
        expect(parseTokens('{{media:}} {{media:x}} {{nope}}')).toEqual([]);
    });
    it('ignores tokens whose id is not a 36-char uuid', () => {
        expect(parseTokens('{{media:uuid-1:movie}}')).toEqual([]);
    });
    it('stripTokens removes refs not in the allowed set', () => {
        const body = `${makeToken(KEEP, 'movie')} ${makeToken(DROP, 'tv')}`;
        const out = stripTokens(body, new Set([`${KEEP}:movie`]));
        expect(out).toContain(makeToken(KEEP, 'movie'));
        expect(out).not.toContain(DROP);
    });
    it('makeToken rejects ids containing a colon', () => {
        expect(() => makeToken('tmdb:550', 'movie')).toThrow(TypeError);
    });
    it('parseTokens returns [] for non-string input', () => {
        // @ts-expect-error testing runtime guard
        expect(parseTokens(null)).toEqual([]);
        // @ts-expect-error testing runtime guard
        expect(parseTokens(42)).toEqual([]);
    });
    it('stripTokens tolerates non-string body and missing allowedKeys', () => {
        // @ts-expect-error testing runtime guard
        expect(stripTokens(null)).toEqual('');
        const body = makeToken(KEEP, 'movie');
        // @ts-expect-error testing runtime guard
        expect(stripTokens(body)).toEqual('');
    });
});
