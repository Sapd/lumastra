// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Curated keyword vocabulary: alias groups and label uniqueness.
 *
 * The /browse tag typeahead renders `keywordDisplayName(slug)` per suggestion.
 * Two slugs sharing one label therefore render as two IDENTICAL rows — observed
 * on prod as "Whodunit" listed twice, each filtering to a different subset with
 * no way for the user to tell them apart.
 *
 * Two different defects hide behind that one symptom, and they need OPPOSITE
 * fixes, so both are locked down here:
 *
 *   1. Same concept, two slugs (`whodunit` / `whodunnit-mystery`) — alias them
 *      onto one canonical, so one row covers the whole group.
 *   2. Distinct concepts that collide in ONE translation (`satire` /
 *      `satire-comedy` are both "Satire" in German) — fix the translation.
 *      Aliasing these would silently merge two legitimate filters.
 *
 * The label-uniqueness test runs over EVERY locale, so a future translation
 * that reintroduces a collision fails here rather than on a user's screen.
 */

import { describe, it, expect } from 'vitest';
import {
    ALLOWED_KEYWORDS,
    KEYWORD_ALIASES,
    CANONICAL_KEYWORDS_ARRAY,
    KEYWORD_ALIAS_SQL_PAIRS,
    canonicalKeyword,
    keywordGroupMembers,
    KEYWORD_I18N_MAP,
} from './keyword-vocabulary.js';
import { locales, type Locale } from '$lib/paraglide/runtime.js';

/**
 * Read a label in a SPECIFIC locale.
 *
 * Deliberately NOT `setLocale()` — paraglide's strategies here are
 * cookie/preferredLanguage/baseLocale, none of which exist under vitest's node
 * environment, so `setLocale('de')` silently leaves `getLocale()` at 'en' and a
 * loop over `locales` would assert the English labels twice while looking green.
 * The per-call `{ locale }` option is strategy-independent and does switch.
 *
 * KEYWORD_I18N_MAP is typed `() => string` for its call sites, which never pass
 * options; the cast reaches the real paraglide signature.
 */
function labelIn(slug: string, locale: Locale): string | undefined {
    const fn = KEYWORD_I18N_MAP[slug] as unknown as
        ((inputs?: Record<string, never>, options?: { locale: Locale }) => string) | undefined;
    return fn?.({}, { locale });
}

describe('KEYWORD_ALIASES integrity', () => {
    it('only maps slugs that are in the curated vocabulary', () => {
        for (const [alias, canonical] of Object.entries(KEYWORD_ALIASES)) {
            expect(ALLOWED_KEYWORDS.has(alias), `alias "${alias}" not curated`).toBe(true);
            expect(
                ALLOWED_KEYWORDS.has(canonical),
                `canonical "${canonical}" (of "${alias}") not curated`,
            ).toBe(true);
        }
    });

    it('has no alias chains: a canonical is never itself an alias', () => {
        // Otherwise canonicalKeyword() would need to iterate to a fixed point,
        // and the SQL unnest mapping (one hop, by construction) would disagree
        // with it.
        for (const canonical of Object.values(KEYWORD_ALIASES)) {
            expect(canonical in KEYWORD_ALIASES, `"${canonical}" is both alias and canonical`).toBe(
                false,
            );
        }
    });

    it('drops exactly the aliases from the suggestible set', () => {
        const aliases = Object.keys(KEYWORD_ALIASES);
        expect(CANONICAL_KEYWORDS_ARRAY.length).toBe(ALLOWED_KEYWORDS.size - aliases.length);
        for (const alias of aliases) {
            expect(CANONICAL_KEYWORDS_ARRAY).not.toContain(alias);
        }
        for (const canonical of Object.values(KEYWORD_ALIASES)) {
            expect(CANONICAL_KEYWORDS_ARRAY).toContain(canonical);
        }
    });

    it('exposes every alias to SQL, and only aliases', () => {
        // Deliberately NOT `from[i] -> KEYWORD_ALIASES[from[i]] === to[i]`: with
        // from/to built as Object.keys/Object.values of the same object, ES
        // ordering guarantees make that true for ANY input, so it asserts
        // nothing. What SQL actually depends on is that the pairs cover the map
        // exactly — a missing pair silently un-aliases a group.
        const { from, to } = KEYWORD_ALIAS_SQL_PAIRS;
        expect(from.length).toBe(to.length);

        const rebuilt = Object.fromEntries(from.map((alias, i) => [alias, to[i]]));
        expect(rebuilt).toEqual({ ...KEYWORD_ALIASES });
    });
});

describe('canonicalKeyword / keywordGroupMembers', () => {
    it('folds an alias onto its canonical', () => {
        expect(canonicalKeyword('whodunnit-mystery')).toBe('whodunit');
        expect(canonicalKeyword('espionage')).toBe('spy');
    });

    it('passes through canonicals and non-curated slugs untouched', () => {
        expect(canonicalKeyword('whodunit')).toBe('whodunit');
        expect(canonicalKeyword('whore-of-babylon')).toBe('whore-of-babylon');
    });

    it('returns the whole group for either member', () => {
        const fromCanonical = [...keywordGroupMembers('whodunit')].sort();
        const fromAlias = [...keywordGroupMembers('whodunnit-mystery')].sort();

        expect(fromCanonical).toEqual(['whodunit', 'whodunnit-mystery']);
        // A legacy ?tag=whodunnit-mystery deep link must resolve to the SAME set
        // as the canonical, not to the alias alone.
        expect(fromAlias).toEqual(fromCanonical);
    });

    it('returns a group of one for an unaliased or unknown slug', () => {
        expect(keywordGroupMembers('heist')).toEqual(['heist']);
        expect(keywordGroupMembers('whore-of-babylon')).toEqual(['whore-of-babylon']);
    });

    it('treats Object.prototype keys as ordinary unknown slugs', () => {
        // `?tag=` is user input. On a plain object literal these would resolve
        // to Function/Object.prototype rather than "not an alias", and the
        // active-filter chip would render "[object Object]".
        for (const hostile of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
            expect(canonicalKeyword(hostile), hostile).toBe(hostile);
            expect(keywordGroupMembers(hostile), hostile).toEqual([hostile]);
        }
    });
});

describe('suggestible labels are unique in every locale', () => {
    it.each(locales)('%s', (locale) => {
        const byLabel = new Map<string, string[]>();
        for (const slug of CANONICAL_KEYWORDS_ARRAY) {
            const label = labelIn(slug, locale);
            // Skipping a missing entry would let a future curated slug shipped
            // without a message key escape this guard entirely — and it would
            // still be able to collide, because keywordDisplayName() falls back
            // to title-casing the slug. Demand the entry instead.
            expect(label, `no ${locale} label for curated slug "${slug}"`).toBeTruthy();
            if (!label) continue;
            byLabel.set(label, [...(byLabel.get(label) ?? []), slug]);
        }

        const collisions = [...byLabel.entries()]
            .filter(([, slugs]) => slugs.length > 1)
            .map(([label, slugs]) => `${label} <- ${slugs.join(', ')}`);

        // Either alias the slugs (same concept) or fix the translation
        // (distinct concepts) — never ship two identical rows in the typeahead.
        expect(collisions).toEqual([]);
    });
});
