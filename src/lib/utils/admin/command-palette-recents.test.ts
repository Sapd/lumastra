// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRecents, recordRecent, type RecentEntry } from './command-palette-recents';

/** Plain in-memory localStorage shim (happy-dom's is unreliable in some harness configs). */
function installLocalStorageShim(): void {
    const store = new Map<string, string>();
    const mock = {
        getItem: (key: string) => (store.has(key) ? (store.get(key) ?? null) : null),
        setItem: (key: string, value: string) => {
            store.set(key, String(value));
        },
        removeItem: (key: string) => {
            store.delete(key);
        },
        clear: () => {
            store.clear();
        },
        key: (index: number) => Array.from(store.keys())[index] ?? null,
        get length() {
            return store.size;
        },
    };
    Object.defineProperty(window, 'localStorage', {
        value: mock,
        writable: true,
        configurable: true,
    });
}

beforeEach(() => {
    installLocalStorageShim();
});

afterEach(() => {
    localStorage.clear();
});

function makeEntry(
    href: string,
    over: Partial<Omit<RecentEntry, 'timestamp'>> = {},
): Omit<RecentEntry, 'timestamp'> {
    return { kind: 'page', href, label: `Label ${href}`, ...over };
}

describe('command-palette-recents', () => {
    it('getRecents returns [] when nothing is stored', () => {
        expect(getRecents()).toEqual([]);
    });

    it('getRecents returns [] on corrupt JSON', () => {
        localStorage.setItem('admin-command-palette-recents', '{not json');
        expect(getRecents()).toEqual([]);
    });

    it('getRecents filters out malformed entries', () => {
        localStorage.setItem(
            'admin-command-palette-recents',
            JSON.stringify([{ kind: 'page', href: '/a' /* missing label/timestamp */ }]),
        );
        expect(getRecents()).toEqual([]);
    });

    it('recordRecent stores a new entry, most recent first', () => {
        recordRecent(makeEntry('/admin/a'));
        recordRecent(makeEntry('/admin/b'));
        expect(getRecents().map((r) => r.href)).toEqual(['/admin/b', '/admin/a']);
    });

    it('recordRecent dedupes by href, bumping the existing entry to the front', () => {
        recordRecent(makeEntry('/admin/a'));
        recordRecent(makeEntry('/admin/b'));
        recordRecent(makeEntry('/admin/a'));
        const recents = getRecents();
        expect(recents.map((r) => r.href)).toEqual(['/admin/a', '/admin/b']);
        expect(recents.length).toBe(2);
    });

    it('recordRecent caps at 5 entries', () => {
        for (let i = 0; i < 7; i++) recordRecent(makeEntry(`/admin/${i}`));
        expect(getRecents().length).toBe(5);
        expect(getRecents().map((r) => r.href)).toEqual([
            '/admin/6',
            '/admin/5',
            '/admin/4',
            '/admin/3',
            '/admin/2',
        ]);
    });

    it('recordRecent does not throw when localStorage.setItem fails', () => {
        const original = localStorage.setItem.bind(localStorage);
        localStorage.setItem = () => {
            throw new Error('quota exceeded');
        };
        expect(() => recordRecent(makeEntry('/admin/a'))).not.toThrow();
        localStorage.setItem = original;
    });
});
