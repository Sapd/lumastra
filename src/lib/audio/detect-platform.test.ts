// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, afterEach } from 'vitest';
import { detectPlatform, isSafariDesktop } from './detect-platform';

const originalNavigator = globalThis.navigator;

function mockNavigator(overrides: Partial<Navigator>): void {
    Object.defineProperty(globalThis, 'navigator', {
        value: { ...originalNavigator, ...overrides },
        writable: true,
        configurable: true,
    });
}

afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        writable: true,
        configurable: true,
    });
});

describe('detectPlatform', () => {
    it('detects iPhone as ios', () => {
        mockNavigator({
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
            maxTouchPoints: 5,
            platform: 'iPhone',
        });
        expect(detectPlatform()).toBe('ios');
    });

    it('detects iPad in desktop mode as ios', () => {
        mockNavigator({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            maxTouchPoints: 5,
            platform: 'MacIntel',
        });
        expect(detectPlatform()).toBe('ios');
    });

    it('detects real Mac as desktop', () => {
        mockNavigator({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            maxTouchPoints: 0,
            platform: 'MacIntel',
        });
        expect(detectPlatform()).toBe('desktop');
    });

    it('detects Android as android', () => {
        mockNavigator({
            userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0',
            maxTouchPoints: 5,
            platform: 'Linux armv8l',
        });
        expect(detectPlatform()).toBe('android');
    });

    it('detects Windows as desktop', () => {
        mockNavigator({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            maxTouchPoints: 0,
            platform: 'Win32',
        });
        expect(detectPlatform()).toBe('desktop');
    });

    it('detects Linux as desktop', () => {
        mockNavigator({
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
            maxTouchPoints: 0,
            platform: 'Linux x86_64',
        });
        expect(detectPlatform()).toBe('desktop');
    });
});

describe('isSafariDesktop', () => {
    it('detects Safari on macOS as true', () => {
        mockNavigator({
            userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
            maxTouchPoints: 0,
            platform: 'MacIntel',
        });
        expect(isSafariDesktop()).toBe(true);
    });

    it('returns false for Chrome on macOS', () => {
        mockNavigator({
            userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            maxTouchPoints: 0,
            platform: 'MacIntel',
        });
        expect(isSafariDesktop()).toBe(false);
    });

    it('returns false for Firefox on macOS', () => {
        mockNavigator({
            userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
            maxTouchPoints: 0,
            platform: 'MacIntel',
        });
        expect(isSafariDesktop()).toBe(false);
    });

    it('returns false for iPad in desktop mode', () => {
        mockNavigator({
            userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
            maxTouchPoints: 5,
            platform: 'MacIntel',
        });
        expect(isSafariDesktop()).toBe(false);
    });

    it('returns false for Safari on iPhone', () => {
        mockNavigator({
            userAgent:
                'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
            maxTouchPoints: 5,
            platform: 'iPhone',
        });
        expect(isSafariDesktop()).toBe(false);
    });

    it('returns false on SSR (no navigator)', () => {
        Object.defineProperty(globalThis, 'navigator', {
            value: undefined,
            writable: true,
            configurable: true,
        });
        expect(isSafariDesktop()).toBe(false);
    });
});
