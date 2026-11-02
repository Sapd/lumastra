// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { normalizeAudiobookName } from './audiobook-catalog-maintenance.queries.js';
describe('audiobook catalog name normalization', () => {
    it('preserves case in the cleaned display form', () => {
        expect(normalizeAudiobookName('\u00a0 E\u0301mile\t  Zola \n', true)).toBe('Émile Zola');
    });
    it.each([
        ['  Jane   DOE  ', 'jane doe'],
        ['Jane\t\nDoe', 'jane doe'],
        ['Émile ZOLA', 'émile zola'],
        ['', ''],
        ['\t\u00a0E\u0301MILE\u0085  ZOLA\n', 'émile zola'],
        ['bad\0name', ''],
        ['x'.repeat(513), ''],
    ])('%s -> %s', (name, expected) => {
        expect(normalizeAudiobookName(name)).toBe(expected);
    });
});
