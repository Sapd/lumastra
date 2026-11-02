// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { settingValueEqual } from './setting-value-equal';

describe('settingValueEqual', () => {
    it('compares objects and lists by content', () => {
        expect(settingValueEqual({ a: '1' }, { a: '1' })).toBe(true);
        expect(settingValueEqual(['x'], ['x'])).toBe(true);
        expect(settingValueEqual({ a: '1' }, { a: '2' })).toBe(false);
    });

    it("treats the list input's text as the stored array", () => {
        expect(settingValueEqual('en, de', ['en', 'de'])).toBe(true);
        expect(settingValueEqual('en,de ', ['en', 'de'])).toBe(true);
        expect(settingValueEqual('en', ['en', 'de'])).toBe(false);
    });

    it('keeps types apart for scalars', () => {
        expect(settingValueEqual(5, 5)).toBe(true);
        expect(settingValueEqual('5', 5)).toBe(false);
        expect(settingValueEqual('', undefined)).toBe(false);
    });
});
