// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { linkModeProfile, type BrowserEnv } from './browser-profile';

const CHROME =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0';
const SAFARI =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

const env = (userAgent: string, over: Partial<BrowserEnv> = {}): BrowserEnv => ({
    userAgent,
    maxTouchPoints: 0,
    brave: false,
    ...over,
});

describe('linkModeProfile', () => {
    test('Chrome: generic, batch = parallel limit, 1500 ms gap', () => {
        const p = linkModeProfile(env(CHROME));
        expect(p.hint).toBe('generic');
        expect(p.gapMs).toBe(1500);
        expect(p.batchSize(3)).toBe(3);
        expect(p.batchSize(0)).toBe(4);
    });

    test('Brave (Chrome UA + navigator.brave): generic', () => {
        expect(linkModeProfile(env(CHROME, { brave: true })).hint).toBe('generic');
    });

    test('Firefox keeps the default batch and gets the firefox hint', () => {
        const p = linkModeProfile(env(FIREFOX));
        expect(p.hint).toBe('firefox');
        expect(p.batchSize(3)).toBe(3);
        expect(p.gapMs).toBe(1500);
    });

    test('Safari macOS: at most 2 at once, 2000 ms gap', () => {
        const p = linkModeProfile(env(SAFARI));
        expect(p.hint).toBe('safari');
        expect(p.gapMs).toBe(2000);
        expect(p.batchSize(5)).toBe(2);
        expect(p.batchSize(0)).toBe(2);
        expect(p.batchSize(1)).toBe(1);
    });

    test('iPhone: one file at a time', () => {
        const p = linkModeProfile(env(IPHONE, { maxTouchPoints: 5 }));
        expect(p.hint).toBe('ios');
        expect(p.batchSize(5)).toBe(1);
    });

    test('iPad with desktop user agent is iOS, a Mac without touch is Safari', () => {
        expect(linkModeProfile(env(SAFARI, { maxTouchPoints: 5 })).hint).toBe('ios');
        expect(linkModeProfile(env(SAFARI, { maxTouchPoints: 0 })).hint).toBe('safari');
    });
});
