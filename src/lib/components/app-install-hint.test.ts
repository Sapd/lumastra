// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { isIosSafari, shouldShowInstallHint, type InstallHintEnv } from './app-install-hint';

const IPHONE_SAFARI =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const IPAD_AS_MAC =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
const IPHONE_CHROME =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1';
const IPHONE_WEBVIEW =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPHONE_INSTAGRAM = `${IPHONE_SAFARI} Instagram 380.0.0.0.0`;
const DESKTOP_CHROME =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const ANDROID_CHROME =
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36';

const iphone: InstallHintEnv = {
    userAgent: IPHONE_SAFARI,
    platform: 'iPhone',
    maxTouchPoints: 5,
    protocol: 'https:',
    standalone: false,
};
const env = (over: Partial<InstallHintEnv>): InstallHintEnv => ({ ...iphone, ...over });

describe('shouldShowInstallHint', () => {
    it('shows for Safari on iPhone over HTTPS', () => {
        expect(shouldShowInstallHint(iphone, true, false)).toBe(true);
    });

    it('shows for iPad Safari that reports itself as a Mac (touch points > 1)', () => {
        expect(
            shouldShowInstallHint(
                env({ userAgent: IPAD_AS_MAC, platform: 'MacIntel' }),
                true,
                false,
            ),
        ).toBe(true);
    });

    it('hides on a real Mac with Safari (no touch points)', () => {
        expect(
            shouldShowInstallHint(
                env({ userAgent: IPAD_AS_MAC, platform: 'MacIntel', maxTouchPoints: 0 }),
                true,
                false,
            ),
        ).toBe(false);
    });

    it('hides on desktop Chrome and Android', () => {
        expect(
            shouldShowInstallHint(
                env({ userAgent: DESKTOP_CHROME, platform: 'MacIntel', maxTouchPoints: 0 }),
                true,
                false,
            ),
        ).toBe(false);
        expect(
            shouldShowInstallHint(
                env({ userAgent: ANDROID_CHROME, platform: 'Linux armv81' }),
                true,
                false,
            ),
        ).toBe(false);
    });

    it('hides in the installed PWA (standalone)', () => {
        expect(shouldShowInstallHint(env({ standalone: true }), true, false)).toBe(false);
    });

    it('hides over plain HTTP — the apps cannot connect there', () => {
        expect(shouldShowInstallHint(env({ protocol: 'http:' }), true, false)).toBe(false);
    });

    it('hides when the admin setting is off', () => {
        expect(shouldShowInstallHint(iphone, false, false)).toBe(false);
    });

    it('hides once dismissed', () => {
        expect(shouldShowInstallHint(iphone, true, true)).toBe(false);
    });
});

describe('isIosSafari', () => {
    it('rejects other iOS browsers and in-app web views', () => {
        expect(isIosSafari(env({ userAgent: IPHONE_CHROME }))).toBe(false);
        expect(isIosSafari(env({ userAgent: IPHONE_WEBVIEW }))).toBe(false);
        expect(isIosSafari(env({ userAgent: IPHONE_INSTAGRAM }))).toBe(false);
    });
});
