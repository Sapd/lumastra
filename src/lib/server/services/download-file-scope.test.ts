// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/cache/library-group-permissions-cache.js', () => ({
    getDeniedLibraryGroups: async () => null,
    toLibraryAccessUser: () => undefined,
}));

import { allowedFileIds, scopeSelection } from './download-file-scope';

const f = (id: string, is_default = false) => ({ id, is_default });

describe('scopeSelection', () => {
    it('an explicit denied file leaves nothing (404)', () => {
        expect(scopeSelection({ files: [f('a')], fileId: 'a' }, new Set())).toEqual({
            files: [],
            fileId: null,
        });
    });

    it('a denied default falls to the default-else-first allowed file', () => {
        const sel = { files: [f('a', true), f('b'), f('c', false)], fileId: 'a' };
        expect(scopeSelection(sel, new Set(['b', 'c'])).fileId).toBe('b');
        expect(
            scopeSelection(
                { ...sel, files: [f('a', true), f('b'), f('c', true)] },
                new Set(['b', 'c']),
            ).fileId,
        ).toBe('c');
    });

    it('an allowed default stays', () => {
        const sel = { files: [f('a'), f('b', true)], fileId: 'b' };
        expect(scopeSelection(sel, new Set(['a', 'b'])).fileId).toBe('b');
    });
});

describe('allowedFileIds', () => {
    it('nothing denied: every id is allowed without a query', async () => {
        const sql = vi.fn() as never;
        expect(await allowedFileIds(sql, ['a', 'b'], null)).toEqual(new Set(['a', 'b']));
        expect(sql).not.toHaveBeenCalled();
    });
});
