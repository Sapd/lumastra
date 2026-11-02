// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach } from 'vitest';
import { getResumeEntry, setResumeEntry, clearResumeEntry } from './playback-progress-cache';

// happy-dom's localStorage implementation is file-backed and unreliable in
// some harness configurations; install a plain in-memory shim per test,
// matching the pattern used in preferences-sync.test.ts.
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

describe('playback-progress-cache', () => {
    beforeEach(() => {
        installLocalStorageShim();
    });

    it('round-trips set then get', () => {
        setResumeEntry('alice', 'uuid-1', 30_000, 1700000000000);
        expect(getResumeEntry('alice', 'uuid-1')).toEqual({
            positionMs: 30_000,
            anchor: 1700000000000,
        });
    });

    it('returns null for missing entries', () => {
        expect(getResumeEntry('alice', 'uuid-missing')).toBeNull();
    });

    it('clear removes only the targeted entry', () => {
        setResumeEntry('alice', 'uuid-1', 30_000, 1);
        setResumeEntry('alice', 'uuid-2', 60_000, 2);
        clearResumeEntry('alice', 'uuid-1');
        expect(getResumeEntry('alice', 'uuid-1')).toBeNull();
        expect(getResumeEntry('alice', 'uuid-2')?.positionMs).toBe(60_000);
    });

    it('namespaces by username — alice cannot read bobs entries', () => {
        setResumeEntry('alice', 'uuid-1', 30_000, 1);
        expect(getResumeEntry('bob', 'uuid-1')).toBeNull();
    });

    it('does not cache zero / negative positions', () => {
        setResumeEntry('alice', 'uuid-1', 0, 1);
        setResumeEntry('alice', 'uuid-2', -10, 1);
        expect(getResumeEntry('alice', 'uuid-1')).toBeNull();
        expect(getResumeEntry('alice', 'uuid-2')).toBeNull();
    });

    it('all ops are no-ops for an empty username', () => {
        setResumeEntry('', 'uuid-1', 30_000, 1);
        expect(getResumeEntry('', 'uuid-1')).toBeNull();
    });

    it('evicts the oldest entry when the cap is exceeded', () => {
        for (let i = 0; i < 205; i++) {
            setResumeEntry('alice', `uuid-${i}`, 1000 + i, i);
        }
        expect(getResumeEntry('alice', 'uuid-0')).toBeNull(); // evicted
        expect(getResumeEntry('alice', 'uuid-204')).not.toBeNull();
    });

    it('returns null and clears the key on corrupt JSON', () => {
        localStorage.setItem('lumastra:resume:v1:alice', '{not json');
        expect(getResumeEntry('alice', 'uuid-1')).toBeNull();
        expect(localStorage.getItem('lumastra:resume:v1:alice')).toBeNull();
    });

    it('rejects entries with non-numeric position or anchor', () => {
        localStorage.setItem(
            'lumastra:resume:v1:alice',
            JSON.stringify({ 'uuid-1': { p: 'oops', a: 1 } }),
        );
        expect(getResumeEntry('alice', 'uuid-1')).toBeNull();
    });

    it('rejects p === 0 (foreign-injected) on read', () => {
        localStorage.setItem(
            'lumastra:resume:v1:alice',
            JSON.stringify({ 'uuid-1': { p: 0, a: 1 } }),
        );
        expect(getResumeEntry('alice', 'uuid-1')).toBeNull();
    });

    it('rejects Infinity and NaN anchors (foreign-injected) on read', () => {
        localStorage.setItem(
            'lumastra:resume:v1:alice',
            JSON.stringify({ 'uuid-1': { p: 5000, a: Infinity } }),
        );
        expect(getResumeEntry('alice', 'uuid-1')).toBeNull();
    });
});
