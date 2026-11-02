// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadBrowseSelection, saveBrowseSelection } from './browse-selection';

let storage: Map<string, string>;
beforeEach(() => {
    storage = new Map();
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
    });
});
afterEach(() => vi.unstubAllGlobals());

describe('complete Browse selection', () => {
    it('round-trips every dimension and only stores allowlisted selection params', () => {
        const params = new URLSearchParams({
            mode: 'az',
            type: 'series',
            libraryGroupId: '11111111-1111-4111-8111-111111111111',
            layout: 'list',
            q: '  blue  ',
            genre: 'Animation',
            tag: 'family',
            letter: 'B',
            sort: 'title_desc',
            audio: 'de,de,en',
            subs: 'en',
            includeUnknown: 'true',
            res: '4K',
            hdr: 'hdr',
            codec: 'hevc',
            qUnknown: 'true',
            offset: '500',
            scroll: '100',
            token: 'secret',
            url: 'https://example.com',
        });
        saveBrowseSelection('one', params);
        const restored = loadBrowseSelection('one')!;
        expect(Object.fromEntries(restored)).toEqual({
            mode: 'az',
            type: 'series',
            libraryGroupId: '11111111-1111-4111-8111-111111111111',
            layout: 'list',
            q: 'blue',
            genre: 'Animation',
            tag: 'family',
            letter: 'B',
            sort: 'title_desc',
            audio: 'de,en',
            subs: 'en',
            includeUnknown: 'true',
            res: '4K',
            hdr: 'hdr',
            codec: 'hevc',
            qUnknown: 'true',
        });
        expect([...storage.values()].join('')).not.toContain('secret');
    });

    it('persists explicit default and empty choices over an earlier selection', () => {
        saveBrowseSelection(
            'one',
            new URLSearchParams(
                'mode=az&libraryGroupId=11111111-1111-4111-8111-111111111111&layout=list&audio=de',
            ),
        );
        saveBrowseSelection('one', new URLSearchParams());
        const restored = loadBrowseSelection('one')!;
        expect(restored.get('libraryGroupId')).toBe('');
        expect(restored.get('layout')).toBe('grid');
        expect(restored.get('audio')).toBe('');
        expect(restored.get('sort')).toBe('title_asc');
        expect(restored.get('mode')).toBe('discover');
    });

    it('isolates users and never uses an anonymous shared key', () => {
        saveBrowseSelection(
            'one',
            new URLSearchParams('libraryGroupId=11111111-1111-4111-8111-111111111111'),
        );
        expect(loadBrowseSelection('two')).toBeNull();
        saveBrowseSelection(undefined, new URLSearchParams('libraryGroupId=other'));
        expect(loadBrowseSelection(undefined)).toBeNull();
        expect(storage.size).toBe(1);
    });

    it.each(['not-json', 'null', '[]', '{"version":2}', '{"version":1,"selection":{}}'])(
        'ignores malformed or unsupported storage: %s',
        (raw) => {
            storage.set('browse-selection:v1:one', raw);
            expect(loadBrowseSelection('one')).toBeNull();
        },
    );

    it.each([
        ['sort', 'invalid'],
        ['audio', 'invalid'],
        ['layout', 'table'],
        ['includeUnknown', 1],
    ])('ignores invalid saved %s', (key, value) => {
        saveBrowseSelection('one', new URLSearchParams());
        const saved = JSON.parse(storage.get('browse-selection:v1:one')!);
        saved.selection[key] = value;
        storage.set('browse-selection:v1:one', JSON.stringify(saved));
        expect(loadBrowseSelection('one')).toBeNull();
    });

    it('normalizes lowercase letters without discarding the saved selection', () => {
        saveBrowseSelection('one', new URLSearchParams('mode=az&letter=b&layout=list'));
        expect(loadBrowseSelection('one')?.get('letter')).toBe('B');
        expect(loadBrowseSelection('one')?.get('layout')).toBe('list');
    });

    it.each(['genre', 'tag'])(
        'preserves API-valid %s values through 100 characters and rejects longer storage',
        (key) => {
            const params = new URLSearchParams({ [key]: 'a'.repeat(100) });
            saveBrowseSelection('one', params);
            expect(loadBrowseSelection('one')?.get(key)).toBe('a'.repeat(100));
            const saved = JSON.parse(storage.get('browse-selection:v1:one')!);
            saved.selection[key] = 'a'.repeat(101);
            storage.set('browse-selection:v1:one', JSON.stringify(saved));
            expect(loadBrowseSelection('one')).toBeNull();
        },
    );

    it('rejects an invalid library identifier instead of sending it to the API', () => {
        saveBrowseSelection('one', new URLSearchParams());
        const saved = JSON.parse(storage.get('browse-selection:v1:one')!);
        saved.selection.libraryGroupId = 'bad-id';
        storage.set('browse-selection:v1:one', JSON.stringify(saved));
        expect(loadBrowseSelection('one')).toBeNull();
    });

    it('tolerates inaccessible storage on read and write', () => {
        vi.stubGlobal('localStorage', {
            getItem: () => {
                throw new Error('blocked');
            },
            setItem: () => {
                throw new Error('quota');
            },
        });
        expect(() => saveBrowseSelection('one', new URLSearchParams())).not.toThrow();
        expect(loadBrowseSelection('one')).toBeNull();
    });
});
