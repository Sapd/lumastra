// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * i18n parity guard (L15): the `en` and `de` paraglide message catalogs must
 * carry the SAME set of keys. A key present in one locale but not the other
 * ships an untranslated (or dead) string. Asserts on the source `messages/*.json`
 * — NOT the compiled `src/paraglide` output (which is gitignored and regenerated).
 */
function loadKeys(locale: string): string[] {
    const path = fileURLToPath(new URL(`../messages/${locale}.json`, import.meta.url));
    const json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    // `$schema` is metadata, not a message key.
    return Object.keys(json).filter((k) => k !== '$schema');
}

describe('i18n en/de parity', () => {
    const en = loadKeys('en');
    const de = loadKeys('de');
    const enSet = new Set(en);
    const deSet = new Set(de);

    it('every en key exists in de (no untranslated keys)', () => {
        const missingInDe = en.filter((k) => !deSet.has(k));
        expect(
            missingInDe,
            `keys present in en but missing in de: ${missingInDe.join(', ')}`,
        ).toEqual([]);
    });

    it('every de key exists in en (no orphaned de keys)', () => {
        const orphanInDe = de.filter((k) => !enSet.has(k));
        expect(
            orphanInDe,
            `keys present in de but missing in en: ${orphanInDe.join(', ')}`,
        ).toEqual([]);
    });
});
