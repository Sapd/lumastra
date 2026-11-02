// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    entryFromLanding,
    isLinearEntry,
    readWatchEntry,
    setWatchEntry,
    withWatchEntry,
} from './watch-entry';

function memoryStorage(): Storage {
    const map = new Map<string, string>();
    return {
        get length() {
            return map.size;
        },
        clear: () => map.clear(),
        getItem: (k) => map.get(k) ?? null,
        key: (i) => [...map.keys()][i] ?? null,
        removeItem: (k) => void map.delete(k),
        setItem: (k, v) => void map.set(k, String(v)),
    };
}

const params = (q: string) => new URLSearchParams(q);
const FRESH = { autoplay: false, restored: false };

describe('entryFromLanding', () => {
    it('the series redirect is continue', () => {
        expect(entryFromLanding(params('resolved=series'), FRESH, 'explicit')).toBe('continue');
        expect(entryFromLanding(params('resolved=seek&seekMs=5000'), FRESH, 'explicit')).toBe(
            'continue',
        );
    });

    it('a handoff jump keeps the linear entry it carries', () => {
        expect(
            entryFromLanding(params('resolved=series&from=x&entry=next_up'), FRESH, 'explicit'),
        ).toBe('next_up');
    });

    it('a linear entry param counts', () => {
        expect(entryFromLanding(params('entry=next_up'), FRESH, 'explicit')).toBe('next_up');
        expect(entryFromLanding(params('entry=resume'), FRESH, 'explicit')).toBe('resume');
    });

    it('autoplay and explicit entry params from a link do not count', () => {
        expect(entryFromLanding(params('entry=autoplay'), FRESH, 'explicit')).toBe('explicit');
        expect(entryFromLanding(params('entry=bogus'), FRESH, 'continue')).toBe('explicit');
    });

    it('a start time, playlist or collection context is explicit, whatever else is there', () => {
        expect(entryFromLanding(params('t=120&entry=resume'), FRESH, 'continue')).toBe('explicit');
        expect(entryFromLanding(params('playlist=3&position=1'), FRESH, 'continue')).toBe(
            'explicit',
        );
        expect(entryFromLanding(params('ctx=col'), FRESH, 'continue')).toBe('explicit');
    });

    it('autoplay into the next episode is linear, whatever opened the first one', () => {
        const autoplay = { autoplay: true, restored: false };
        expect(entryFromLanding(params(''), autoplay, 'next_up')).toBe('autoplay');
        expect(entryFromLanding(params(''), autoplay, 'explicit')).toBe('autoplay');
    });

    it('a reload keeps the stored entry; a plain link (episode pick) is explicit', () => {
        expect(entryFromLanding(params(''), { autoplay: false, restored: true }, 'resume')).toBe(
            'resume',
        );
        expect(entryFromLanding(params(''), FRESH, 'continue')).toBe('explicit');
    });
});

describe('withWatchEntry', () => {
    it('appends linear entries with the right separator', () => {
        expect(withWatchEntry('/watch/e1', 'next_up')).toBe('/watch/e1?entry=next_up');
        expect(withWatchEntry('/watch/e1?playlist=2', 'resume')).toBe(
            '/watch/e1?playlist=2&entry=resume',
        );
    });

    it('leaves explicit and autoplay links alone', () => {
        expect(withWatchEntry('/watch/e1', 'explicit')).toBe('/watch/e1');
        expect(withWatchEntry('/watch/e1', 'autoplay')).toBe('/watch/e1');
    });
});

describe('stored entry', () => {
    beforeEach(() => vi.stubGlobal('sessionStorage', memoryStorage()));
    afterEach(() => vi.unstubAllGlobals());

    it('defaults to explicit and round-trips', () => {
        expect(readWatchEntry()).toBe('explicit');
        setWatchEntry('next_up');
        expect(readWatchEntry()).toBe('next_up');
        expect(isLinearEntry(readWatchEntry())).toBe(true);
    });

    it('a throwing storage reads as explicit', () => {
        vi.stubGlobal('sessionStorage', {
            getItem: () => {
                throw new Error('SecurityError');
            },
            setItem: () => {
                throw new Error('SecurityError');
            },
        });
        setWatchEntry('resume');
        expect(readWatchEntry()).toBe('explicit');
    });
});
