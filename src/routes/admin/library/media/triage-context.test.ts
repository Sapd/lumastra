// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    listSearchWithout,
    loadTriageContext,
    saveTriageContext,
    triagePosition,
    type TriageContext,
} from './triage-context.js';

function memoryStorage(): Storage {
    const m = new Map<string, string>();
    return {
        get length() {
            return m.size;
        },
        clear: () => m.clear(),
        getItem: (k) => m.get(k) ?? null,
        key: (i) => [...m.keys()][i] ?? null,
        removeItem: (k) => void m.delete(k),
        setItem: (k, v) => void m.set(k, String(v)),
    };
}

const CTX: TriageContext = {
    search: '?view=artwork',
    viewLabel: 'Missing artwork',
    ids: ['a', 'b', 'c'],
    page: 2,
    pageSize: 3,
    total: 8,
};

describe('triage context', () => {
    it('round-trips through storage and rejects foreign shapes', () => {
        const s = memoryStorage();
        saveTriageContext(s, CTX);
        expect(loadTriageContext(s)).toEqual(CTX);
        s.setItem('admin-media-triage', '{"v":99}');
        expect(loadTriageContext(s)).toBeNull();
        s.setItem('admin-media-triage', 'not json');
        expect(loadTriageContext(s)).toBeNull();
    });

    it('strips paging and triage params from the saved search', () => {
        expect(listSearchWithout('?view=files&page=3&jump=C&triage=first&type=tv')).toBe(
            '?view=files&type=tv',
        );
        expect(listSearchWithout('?page=2')).toBe('');
    });

    it('walks within the page and counts across the whole view', () => {
        const p = triagePosition(CTX, 'b')!;
        expect(p.index).toBe(5);
        expect(p.total).toBe(8);
        expect(p.prevHref).toBe('/admin/library/media/a');
        expect(p.nextHref).toBe('/admin/library/media/c');
        expect(p.listHref).toBe('/admin/library/media?view=artwork&page=2&restore=1');
    });

    it('crosses a page boundary through the list with ?triage=', () => {
        expect(triagePosition(CTX, 'a')!.prevHref).toBe(
            '/admin/library/media?view=artwork&triage=last',
        );
        expect(triagePosition(CTX, 'c')!.nextHref).toBe(
            '/admin/library/media?view=artwork&page=3&triage=first',
        );
    });

    it('has no Next on the last page and no bar for an item not on the saved page', () => {
        const last = triagePosition({ ...CTX, page: 3, ids: ['x', 'y'] }, 'y')!;
        expect(last.nextHref).toBeNull();
        expect(triagePosition(CTX, 'zzz')).toBeNull();
        expect(triagePosition(null, 'a')).toBeNull();
    });
});
