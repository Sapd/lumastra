// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Save-time format rules for `color` and `url` settings. The admin settings UI
 * used to accept `#7c3aedx` as a theme colour without complaint, and the branding
 * URL fields document root-relative paths (`/custom/logo.webp`) that a plain
 * absolute-URL rule would have rejected.
 */
import { describe, expect, it } from 'vitest';
import { configSchema, validateSettingFormat, validateSettingValue } from './schema';

const color = { type: 'color' as const };
const url = { type: 'url' as const };

describe('validateSettingFormat', () => {
    it.each(['#7c3aed', '#FFF', '#0f172a80', '#abcd', ''])('accepts colour %j', (value) => {
        expect(validateSettingFormat(color, value).valid).toBe(true);
    });

    it.each(['#7c3aedx', '7c3aed', 'purple', '#12', 'rgb(0,0,0)'])('rejects colour %j', (value) => {
        expect(validateSettingFormat(color, value).valid).toBe(false);
    });

    it.each([
        '',
        '/custom/site-button.webp',
        'https://cdn.example.com/logo.png',
        'http://jellyfin:8096',
    ])('accepts url %j', (value) => {
        expect(validateSettingFormat(url, value).valid).toBe(true);
    });

    it.each(['custom/logo.png', 'javascript:alert(1)', 'ftp://x/y', 'https://has space'])(
        'rejects url %j',
        (value) => {
            expect(validateSettingFormat(url, value).valid).toBe(false);
        },
    );

    it('is NOT part of load-time validation, which would silently drop a legacy value', () => {
        const theme = configSchema.find((s) => s.key === 'APP_THEME_COLOR');
        expect(theme?.type).toBe('color');
        expect(validateSettingValue(theme!, 'purple').valid).toBe(true);
    });
});

describe('TMDB_LANGUAGE schema format', () => {
    const setting = configSchema.find((s) => s.key === 'TMDB_LANGUAGE')!;
    it.each([null, undefined])('preserves default handling for %s', (value) => {
        expect(validateSettingFormat(setting, value).valid).toBe(true);
        expect(validateSettingValue(setting, value).valid).toBe(true);
    });
    it.each(['en', 'de-DE', 'es-419', 'zh-Hans', 'en-001', 'zh-Hant-TW'])('accepts %s', (value) => {
        expect(validateSettingFormat(setting, value).valid).toBe(true);
    });
    it.each(['german', 'en--US', 'https://user:secret@example.com', ''])(
        'rejects a changed invalid primary tag without echoing it',
        (value) => {
            const result = validateSettingFormat(setting, value);
            expect(result.valid).toBe(false);
            expect(result.error).toMatch(/language code/i);
            expect(result.error).not.toMatch(/german|user:secret|example.com/);
        },
    );
    it('keeps legacy load-time values intact; format rules apply only to changed saves', () => {
        expect(validateSettingValue(setting, 'legacy-language').valid).toBe(true);
    });
});
