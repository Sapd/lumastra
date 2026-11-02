// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { configSchema, validateSettingFormat } from './schema';
const setting = configSchema.find((s) => s.key === 'PUBLIC_BASE_URL')!;
describe('Public Base URL', () => {
    it('is a normal URL setting', () => {
        expect(setting.type).toBe('url');
        expect(setting.section).not.toBe('advanced');
    });
    it.each([
        'https://user:private-key@example.com/path',
        '/relative',
        'ftp://example.com',
        'https://',
        'https://has space',
        'https://example.com?token=private-key',
        'https://example.com/#private-key',
    ])('rejects unsafe or invalid input without echoing it', (value) => {
        const result = validateSettingFormat(setting, value);
        expect(result.valid).toBe(false);
        expect(result.error).not.toContain('private-key');
        expect(result.error).not.toContain(value);
    });
    it.each(['', 'http://localhost:5173', 'https://example.com/media/'])(
        'accepts optional http(s) URLs and subpaths',
        (value) => {
            expect(validateSettingFormat(setting, value).valid).toBe(true);
        },
    );
});
