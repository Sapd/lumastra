// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    parseUserAgent,
    looksLikeUserAgent,
    deviceLabel,
    isBrowserUserAgent,
} from './user-agent.js';

const FIREFOX_WINDOWS =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0';
const SAFARI_IOS =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const CHROME_MAC =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const CHROME_ANDROID =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';
const EDGE_WINDOWS =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0';
const LUMASTRA_TVOS = 'Lumastra/1.4 (tvOS 18.0; AppleTV14,1)';
const OPAQUE_DEVICE_NAME = "Testuser's iPhone";

describe('parseUserAgent', () => {
    it('parses a desktop Firefox-on-Windows UA', () => {
        const result = parseUserAgent(FIREFOX_WINDOWS);
        expect(result.recognized).toBe(true);
        expect(result.isBrowser).toBe(true);
        expect(result.label).toBe('Firefox 156 · Windows');
    });

    it('parses a mobile Safari-on-iOS UA', () => {
        const result = parseUserAgent(SAFARI_IOS);
        expect(result.recognized).toBe(true);
        expect(result.isBrowser).toBe(true);
        expect(result.label).toBe('Safari 18 · iOS 18');
    });

    it('parses Chrome-on-macOS', () => {
        const result = parseUserAgent(CHROME_MAC);
        expect(result.label).toBe('Chrome 128 · macOS 10.15');
    });

    it('parses Chrome-on-Android', () => {
        const result = parseUserAgent(CHROME_ANDROID);
        expect(result.label).toBe('Chrome 128 · Android 14');
    });

    it('prefers Edge over the Chrome/Safari tokens its UA also carries', () => {
        const result = parseUserAgent(EDGE_WINDOWS);
        expect(result.label).toBe('Edge 128 · Windows');
    });

    it('parses a native app UA that is not browser-shaped', () => {
        const result = parseUserAgent(LUMASTRA_TVOS);
        expect(result.recognized).toBe(true);
        expect(result.isBrowser).toBe(false);
        expect(result.label).toBe('Lumastra 1.4 · tvOS · Apple TV');
    });

    it('passes through a value that is not a UA at all', () => {
        const result = parseUserAgent(OPAQUE_DEVICE_NAME);
        expect(result.recognized).toBe(false);
        expect(result.label).toBe(OPAQUE_DEVICE_NAME);
    });

    it('passes through an empty string', () => {
        const result = parseUserAgent('');
        expect(result.recognized).toBe(false);
        expect(result.label).toBe('');
    });
});

describe('looksLikeUserAgent', () => {
    it('recognizes a Mozilla-style browser UA', () => {
        expect(looksLikeUserAgent(FIREFOX_WINDOWS)).toBe(true);
    });

    it('recognizes a native-app self-identifying UA', () => {
        expect(looksLikeUserAgent(LUMASTRA_TVOS)).toBe(true);
    });

    it('rejects a plain device name', () => {
        expect(looksLikeUserAgent(OPAQUE_DEVICE_NAME)).toBe(false);
    });
});

describe('isBrowserUserAgent', () => {
    it('is true for a browser UA', () => {
        expect(isBrowserUserAgent(FIREFOX_WINDOWS)).toBe(true);
    });

    it('is false for a native app UA', () => {
        expect(isBrowserUserAgent(LUMASTRA_TVOS)).toBe(false);
    });

    it('is false for a plain device name', () => {
        expect(isBrowserUserAgent(OPAQUE_DEVICE_NAME)).toBe(false);
    });
});

describe('deviceLabel', () => {
    it('parses a raw UA deviceName and keeps the full string as a tooltip', () => {
        const result = deviceLabel(FIREFOX_WINDOWS, 'device-1');
        expect(result.label).toBe('Firefox 156 · Windows');
        expect(result.tooltip).toBe(FIREFOX_WINDOWS);
    });

    it('passes through a normal device name unchanged, with no tooltip', () => {
        const result = deviceLabel(OPAQUE_DEVICE_NAME, 'device-1');
        expect(result).toEqual({ label: OPAQUE_DEVICE_NAME });
    });

    it('falls back to deviceId when deviceName is null', () => {
        const result = deviceLabel(null, 'device-42');
        expect(result).toEqual({ label: 'device-42' });
    });

    it('falls back to an em dash when both are null', () => {
        const result = deviceLabel(null, null);
        expect(result).toEqual({ label: '—' });
    });
});
