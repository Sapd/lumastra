// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Invariant guard for keyword display-name translations.
 *
 * The "Explore by genre" chips, the "You like X" rows AND the /browse tag
 * typeahead render provider keywords whose display names resolve through
 * KEYWORD_I18N_MAP in $lib/shared/keyword-vocabulary. Every keyword in the
 * ALLOWED_KEYWORDS whitelist must map to a paraglide message key, and that key
 * must exist (with a non-empty value) in every shipped locale — otherwise the
 * chip silently falls back to a title-cased English string under a
 * non-English UI.
 *
 * This test reads the source/message files directly (rather than importing the
 * module) so it stays a cheap, dependency-free structural check that fails the
 * moment someone adds a whitelist entry without a translation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');

function readVocabulary(): string {
    return readFileSync(join(repoRoot, 'src', 'lib', 'shared', 'keyword-vocabulary.ts'), 'utf8');
}

function block(src: string, header: RegExp): string {
    const start = src.search(header);
    if (start === -1) throw new Error(`block not found: ${header}`);
    const open = src.indexOf('{', start);
    // Walk to the matching close brace of the literal.
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(open, i + 1);
        }
    }
    throw new Error(`unterminated block: ${header}`);
}

function allowedKeywords(src: string): string[] {
    const set = src.match(/export const ALLOWED_KEYWORDS = new Set\(\[([\s\S]*?)\]\);/);
    if (!set) throw new Error('ALLOWED_KEYWORDS not found');
    return [...set[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** keyword -> paraglide function name (m.<name>); covers quoted + bare keys. */
function keywordI18nMap(src: string): Map<string, string> {
    const body = block(src, /export const KEYWORD_I18N_MAP\b/);
    const map = new Map<string, string>();
    for (const m of body.matchAll(/(?:'([^']+)'|([A-Za-z_]\w*))\s*:\s*m\.(\w+)/g)) {
        map.set(m[1] ?? m[2], m[3]);
    }
    return map;
}

describe('keyword display-name i18n coverage', () => {
    const src = readVocabulary();
    const allowed = allowedKeywords(src);
    const map = keywordI18nMap(src);
    const en = JSON.parse(readFileSync(join(repoRoot, 'messages', 'en.json'), 'utf8')) as Record<
        string,
        string
    >;
    const de = JSON.parse(readFileSync(join(repoRoot, 'messages', 'de.json'), 'utf8')) as Record<
        string,
        string
    >;

    it('maps every whitelisted keyword to a translation function', () => {
        const missing = allowed.filter((k) => !map.has(k));
        expect(missing, `whitelisted keywords with no KEYWORD_I18N_MAP entry: ${missing}`).toEqual(
            [],
        );
    });

    it('has an English + German message for every mapped keyword function', () => {
        const fns = [...new Set(map.values())];
        const missingEn = fns.filter((fn) => !en[fn]?.trim());
        const missingDe = fns.filter((fn) => !de[fn]?.trim());
        expect(missingEn, `mapped functions without an en.json value: ${missingEn}`).toEqual([]);
        expect(missingDe, `mapped functions without a de.json value: ${missingDe}`).toEqual([]);
    });
});
