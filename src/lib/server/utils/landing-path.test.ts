// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { isValidLandingPath } from './landing-path';

describe('isValidLandingPath', () => {
    it('accepts app-relative single-slash paths', () => {
        expect(isValidLandingPath('/music')).toBe(true);
        expect(isValidLandingPath('/library/home_video')).toBe(true);
    });
    it('rejects empty, root, and nullish (no redirect)', () => {
        expect(isValidLandingPath('')).toBe(false);
        expect(isValidLandingPath('/')).toBe(false);
        expect(isValidLandingPath(null)).toBe(false);
        expect(isValidLandingPath(undefined)).toBe(false);
    });
    it('rejects protocol-relative and absolute URLs', () => {
        expect(isValidLandingPath('//evil.com')).toBe(false);
        expect(isValidLandingPath('https://evil.com')).toBe(false);
        expect(isValidLandingPath('javascript:alert(1)')).toBe(false);
    });
    it('rejects backslashes, encoded slashes, control chars, whitespace', () => {
        expect(isValidLandingPath('/\\evil')).toBe(false);
        expect(isValidLandingPath('/%2f%2fevil')).toBe(false);
        expect(isValidLandingPath('/a\tb')).toBe(false);
        expect(isValidLandingPath('/a b')).toBe(false);
    });
});
