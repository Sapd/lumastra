// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPreferredFeed, getPreferredFeed, setPreferredFeed } from './feed-preference.js';

const KEY = 'lumastra:livetv-feeds:v1';

describe('feed preference', () => {
    beforeEach(() => localStorage.clear());
    afterEach(() => vi.unstubAllGlobals());

    it('remembers a non-default feed per station and forgets it on the default', () => {
        setPreferredFeed('g1', 'feed-hd', false);
        setPreferredFeed('g2', 'feed-sd', false);
        expect(getPreferredFeed('g1')).toBe('feed-hd');
        setPreferredFeed('g1', 'feed-fhd', true);
        expect(getPreferredFeed('g1')).toBeUndefined();
        expect(getPreferredFeed('g2')).toBe('feed-sd');
        clearPreferredFeed('g2');
        expect(JSON.parse(localStorage.getItem(KEY) ?? '')).toEqual({});
    });

    it('ignores channels without a backup group', () => {
        setPreferredFeed(undefined, 'x', false);
        expect(getPreferredFeed(undefined)).toBeUndefined();
        expect(localStorage.getItem(KEY)).toBeNull();
    });

    it('survives garbage in storage and a throwing localStorage', () => {
        localStorage.setItem(KEY, '[1,2');
        expect(getPreferredFeed('g1')).toBeUndefined();
        localStorage.setItem(KEY, JSON.stringify({ g1: 42, g2: 'ok' }));
        expect(getPreferredFeed('g1')).toBeUndefined();
        expect(getPreferredFeed('g2')).toBe('ok');
        vi.stubGlobal('localStorage', {
            getItem: () => {
                throw new Error('SecurityError');
            },
            setItem: () => {
                throw new Error('QuotaExceeded');
            },
        });
        expect(getPreferredFeed('g2')).toBeUndefined();
        expect(() => setPreferredFeed('g3', 'f', false)).not.toThrow();
        expect(() => clearPreferredFeed('g3')).not.toThrow();
    });

    it('keeps at most 200 stations, dropping the oldest', () => {
        for (let i = 0; i < 205; i++) setPreferredFeed(`g${i}`, `f${i}`, false);
        const map = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>;
        expect(Object.keys(map)).toHaveLength(200);
        expect(map.g0).toBeUndefined();
        expect(map.g204).toBe('f204');
    });
});
