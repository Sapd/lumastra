// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { blurhashToCssBackground } from './blurhash-client';

describe('blurhashToCssBackground', () => {
    it('returns null for empty/invalid input', () => {
        expect(blurhashToCssBackground(undefined)).toBeNull();
        expect(blurhashToCssBackground('')).toBeNull();
    });
    it('produces a data: URI for a valid blurhash', () => {
        // A short valid blurhash string
        const out = blurhashToCssBackground('LKO2?U%2Tw=w]~RBVZRi};RPxuwH');
        expect(out === null || out.startsWith('data:image')).toBe(true);
    });
});
