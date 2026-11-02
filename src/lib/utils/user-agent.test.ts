// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { parseUserAgent, detectFormFactor } from './user-agent.js';

// Real UA strings captured from browsers in 2025.
const UAS = {
    chromeMac:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.109 Safari/537.36',
    chromeWin:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.109 Safari/537.36',
    chromeAndroid:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.109 Mobile Safari/537.36',
    firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
    firefoxWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    safariMac:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    safariIphone:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    safariIpad:
        'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    edgeWin:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.89',
    operaWin:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0',
} as const;

describe('parseUserAgent', () => {
    describe('real browser UA strings', () => {
        it('parses Chrome on macOS', () => {
            const result = parseUserAgent(UAS.chromeMac);
            expect(result).toContain('Chrome');
            expect(result).toContain('120');
            expect(result).toContain('macOS');
            expect(result).toBe('Chrome 120 on macOS');
        });

        it('parses Chrome on Windows', () => {
            const result = parseUserAgent(UAS.chromeWin);
            expect(result).toBe('Chrome 120 on Windows');
        });

        it('parses Chrome on Android (Android must win over Linux)', () => {
            const result = parseUserAgent(UAS.chromeAndroid);
            expect(result).toContain('Chrome');
            expect(result).toContain('Android');
            expect(result).not.toContain('Linux');
            expect(result).toBe('Chrome 120 on Android');
        });

        it('parses Firefox on Linux', () => {
            const result = parseUserAgent(UAS.firefoxLinux);
            expect(result).toBe('Firefox 121 on Linux');
        });

        it('parses Firefox on Windows', () => {
            const result = parseUserAgent(UAS.firefoxWin);
            expect(result).toBe('Firefox 121 on Windows');
        });

        it('parses Safari on macOS using the Version/ token', () => {
            const result = parseUserAgent(UAS.safariMac);
            expect(result).toBe('Safari 17 on macOS');
        });

        it('parses Safari on iPhone', () => {
            const result = parseUserAgent(UAS.safariIphone);
            expect(result).toBe('Safari 17 on iPhone');
        });

        it('parses Safari on iPad', () => {
            const result = parseUserAgent(UAS.safariIpad);
            expect(result).toBe('Safari 17 on iPad');
        });

        it('parses Edge on Windows — must NOT return Chrome despite Chrome substring', () => {
            const result = parseUserAgent(UAS.edgeWin);
            expect(result).toContain('Edge');
            expect(result).not.toContain('Chrome');
            expect(result).toBe('Edge 120 on Windows');
        });

        it('parses Opera on Windows — must NOT return Chrome despite Chrome substring', () => {
            const result = parseUserAgent(UAS.operaWin);
            expect(result).toContain('Opera');
            expect(result).not.toContain('Chrome');
            expect(result).toBe('Opera 106 on Windows');
        });
    });

    describe('browser detection order-sensitivity', () => {
        it('Edge UA containing "Chrome" substring returns Edge', () => {
            // Minimal synthetic UA with both tokens — Edge must still win.
            const ua = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Edg/120.0';
            expect(parseUserAgent(ua)).toBe('Edge 120 on Windows');
        });

        it('Opera UA containing "Chrome" substring returns Opera', () => {
            const ua = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 OPR/106.0';
            expect(parseUserAgent(ua)).toBe('Opera 106 on Windows');
        });
    });

    describe('empty / null / whitespace inputs', () => {
        it('returns "Unknown" for null', () => {
            expect(parseUserAgent(null)).toBe('Unknown');
        });

        it('returns "Unknown" for undefined', () => {
            expect(parseUserAgent(undefined)).toBe('Unknown');
        });

        it('returns "Unknown" for empty string', () => {
            expect(parseUserAgent('')).toBe('Unknown');
        });

        it('returns "Unknown" for whitespace-only string', () => {
            expect(parseUserAgent('   \t\n')).toBe('Unknown');
        });
    });

    describe('non-UA short strings pass through unchanged', () => {
        it('leaves "Chrome 120" alone (no Mozilla/AppleWebKit/Gecko marker)', () => {
            expect(parseUserAgent('Chrome 120')).toBe('Chrome 120');
        });

        it('leaves "Lumastra iOS 1.2" alone', () => {
            expect(parseUserAgent('Lumastra iOS 1.2')).toBe('Lumastra iOS 1.2');
        });

        it('leaves "Apple TV" alone', () => {
            expect(parseUserAgent('Apple TV')).toBe('Apple TV');
        });

        it('trims surrounding whitespace from non-UA strings', () => {
            expect(parseUserAgent('  Lumastra Web 2.0  ')).toBe('Lumastra Web 2.0');
        });
    });

    describe('non-UA long strings truncate with ellipsis at 40 chars', () => {
        it('truncates a 60-char non-UA string', () => {
            const long = 'A'.repeat(60);
            const result = parseUserAgent(long);
            expect(result.endsWith('…')).toBe(true);
            // 40 chars of content plus the ellipsis
            expect(result).toBe('A'.repeat(40) + '…');
            expect([...result].length).toBe(41);
        });

        it('does not truncate a non-UA string at exactly 40 chars', () => {
            const exact = 'B'.repeat(40);
            expect(parseUserAgent(exact)).toBe(exact);
        });

        it('does not truncate a non-UA string at 41 chars (strict > 40)', () => {
            // Implementation uses `.length > 40`; 41-char string IS truncated.
            const s = 'C'.repeat(41);
            const result = parseUserAgent(s);
            expect(result).toBe('C'.repeat(40) + '…');
        });
    });

    describe('UA with recognized OS but unknown browser', () => {
        it('"Mozilla/5.0 (Linux)" → returns "Linux"', () => {
            expect(parseUserAgent('Mozilla/5.0 (Linux)')).toBe('Linux');
        });

        it('"Mozilla/5.0 (Windows NT 10.0)" → returns "Windows"', () => {
            expect(parseUserAgent('Mozilla/5.0 (Windows NT 10.0)')).toBe('Windows');
        });

        it('"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" with no browser token → "macOS"', () => {
            expect(parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macOS');
        });
    });

    describe('UA with no recognizable parts — truncates raw string', () => {
        it('short UA-marker string with no browser and no OS returns trimmed string', () => {
            // Contains the UA marker so it enters the parse branch, but no
            // browser and no OS regex matches, so raw string is returned
            // (truncated if > 40 chars).
            const ua = 'Mozilla/5.0 (Unknown Device)';
            expect(parseUserAgent(ua)).toBe(ua);
        });

        it('long UA-marker string with no browser and no OS truncates at 40', () => {
            const ua = 'Mozilla/5.0 ' + 'Z'.repeat(80);
            const result = parseUserAgent(ua);
            expect(result.endsWith('…')).toBe(true);
            expect([...result].length).toBe(41);
        });
    });

    describe('version extraction — major only', () => {
        it('Chrome/120.0.6099.109 → "Chrome 120" (major version only)', () => {
            expect(parseUserAgent(UAS.chromeWin)).toContain('Chrome 120');
            expect(parseUserAgent(UAS.chromeWin)).not.toContain('120.0');
        });

        it('Firefox/121.0 → "Firefox 121"', () => {
            const result = parseUserAgent(UAS.firefoxLinux);
            expect(result).toContain('Firefox 121');
            expect(result).not.toContain('121.0');
        });

        it('Safari Version/17.2 → "Safari 17"', () => {
            expect(parseUserAgent(UAS.safariMac)).toContain('Safari 17');
            expect(parseUserAgent(UAS.safariMac)).not.toContain('17.2');
        });

        it('single-component version still returns the number', () => {
            const ua = 'Mozilla/5.0 (Linux) Firefox/99';
            expect(parseUserAgent(ua)).toBe('Firefox 99 on Linux');
        });
    });

    describe('browser detected but no OS', () => {
        it('returns just the browser label when OS is unknown', () => {
            // UA with Firefox token but no OS the regex recognizes
            const ua = 'Mozilla/5.0 (SomeFutureOS) Gecko/20100101 Firefox/200.0';
            expect(parseUserAgent(ua)).toBe('Firefox 200');
        });
    });
});

describe('detectFormFactor', () => {
    it('classifies iPhone Safari as mobile', () => {
        expect(detectFormFactor(UAS.safariIphone)).toBe('mobile');
    });

    it('classifies iPad Safari as tablet', () => {
        expect(detectFormFactor(UAS.safariIpad)).toBe('tablet');
    });

    it('classifies Android tablets without a Mobile token as tablet', () => {
        expect(
            detectFormFactor(
                'Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
            ),
        ).toBe('tablet');
    });

    it('classifies Android Chrome as mobile (must beat the Linux token)', () => {
        expect(detectFormFactor(UAS.chromeAndroid)).toBe('mobile');
    });

    it('classifies macOS Chrome as desktop', () => {
        expect(detectFormFactor(UAS.chromeMac)).toBe('desktop');
    });

    it('classifies Windows Chrome as desktop', () => {
        expect(detectFormFactor(UAS.chromeWin)).toBe('desktop');
    });

    it('classifies Linux Firefox as desktop', () => {
        expect(detectFormFactor(UAS.firefoxLinux)).toBe('desktop');
    });

    it('classifies Apple TV via tvOS token', () => {
        expect(detectFormFactor('Mozilla/5.0 (Apple TV; CPU OS like tvOS)')).toBe('tv');
    });

    it('classifies Tizen / WebOS / Roku as tv', () => {
        expect(detectFormFactor('Mozilla/5.0 (SmartHub; Tizen 6.0)')).toBe('tv');
        expect(detectFormFactor('Mozilla/5.0 WebOS/4.0')).toBe('tv');
        expect(detectFormFactor('Roku/DVP-12.0')).toBe('tv');
    });

    // Android-based TVs all carry the `Android` token and would otherwise be
    // misclassified as `mobile` if the TV check ran second.
    it('classifies NVIDIA Shield as tv (Android UA must not win)', () => {
        const ua =
            'Mozilla/5.0 (Linux; Android 11; SHIELD Android TV Build/RQ1A.210105.003) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.105 Safari/537.36';
        expect(detectFormFactor(ua)).toBe('tv');
    });

    it('classifies Sony Bravia (Android TV) as tv', () => {
        const ua =
            'Mozilla/5.0 (Linux; Android 9; BRAVIA 4K UR3 Build/PTT1.190204.183) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/72.0.3626.121 Safari/537.36';
        expect(detectFormFactor(ua)).toBe('tv');
    });

    it('classifies Amazon Fire TV (AFT* codename) as tv', () => {
        const ua =
            'Mozilla/5.0 (Linux; Android 9; AFTSS Build/PS7307; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/74.0.3729.157 Safari/537.36';
        expect(detectFormFactor(ua)).toBe('tv');
    });

    it('classifies a UA carrying the literal "Android TV" token as tv', () => {
        const ua =
            'Mozilla/5.0 (Linux; Android 12; Android TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';
        expect(detectFormFactor(ua)).toBe('tv');
    });

    it('classifies Google TV as tv', () => {
        const ua =
            'Mozilla/5.0 (Linux; Android 12; GoogleTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';
        expect(detectFormFactor(ua)).toBe('tv');
    });

    it('still classifies a regular Android phone as mobile (Mobile token present)', () => {
        // Make sure the broader TV regex did not over-claim normal Android
        // phones — Pixel UA carries "Mobile Safari" but no TV token.
        expect(detectFormFactor(UAS.chromeAndroid)).toBe('mobile');
    });

    it('uses client-name hint when UA is missing', () => {
        expect(detectFormFactor(null, 'Lumastra iOS')).toBe('mobile');
        expect(detectFormFactor(undefined, 'Lumastra TV')).toBe('tv');
        expect(detectFormFactor('', 'Lumastra Web')).toBe('unknown');
    });

    it('uses the device reported name when UA and client name say nothing', () => {
        // Seen on prod: TV and tablet clients report these names, with a
        // client name that alone would read as a phone ("Lumastra iOS").
        expect(detectFormFactor(null, 'Lumastra iOS', 'iPad Pro 13-inch (M5)')).toBe('tablet');
        expect(detectFormFactor(null, 'Lumastra tvOS', 'Apple TV')).toBe('tv');
        expect(detectFormFactor(null, 'Jellyfin Android TV', '4K Hybrid STB')).toBe('tv');
        expect(detectFormFactor(null, 'Lumastra iOS', 'iPhone 17 Pro')).toBe('mobile');
    });

    it('classifies app names that only say "TV" or "Mac"', () => {
        // Prod device names from personal stats (2026-09-27).
        expect(detectFormFactor('Example TV App', 'Example Dashboard 1.0.0')).toBe('tv');
        expect(detectFormFactor('Mac', 'Infuse-Direct 8.4.4')).toBe('desktop');
        expect(detectFormFactor('Macbeth Player')).toBe('unknown');
        expect(detectFormFactor('TVersity')).toBe('unknown');
    });

    it('fences whole-word tokens without over-matching inside other words', () => {
        expect(detectFormFactor('Automobile Player')).toBe('unknown');
        expect(detectFormFactor(null, 'Swiftfin iOSx')).toBe('unknown');
        expect(detectFormFactor('Mozilla/5.0 (X11; CrOS x86_64 15000.0.0)')).toBe('desktop');
    });

    it('returns unknown for empty input', () => {
        expect(detectFormFactor(null)).toBe('unknown');
        expect(detectFormFactor(undefined, undefined)).toBe('unknown');
        expect(detectFormFactor('', '')).toBe('unknown');
    });

    it('returns unknown for unrecognized strings', () => {
        expect(detectFormFactor('Some random tool')).toBe('unknown');
    });
});
