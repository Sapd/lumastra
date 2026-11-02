// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The value <-> chip round-trip that `GroupArrayInput` performs.
 *
 * Extracted as pure functions so the two edge cases that actually bite can be
 * asserted without mounting a component (component tests are excluded from the
 * default vitest run in this repo).
 *
 * The de-dup is not cosmetic: the chip list is rendered with a KEYED `{#each}`,
 * and a repeated key is a hard Svelte runtime error, not a warning. A stored
 * value can already contain repeats — `settings.json` is hand-editable and
 * `ADMIN_GROUPS="admin,admin"` is a legal env var — so without de-dup the
 * settings page crashes on load rather than rendering.
 */

import { describe, it, expect } from 'vitest';
import { foldGroupName, parseGroupList, mergeGroupNames } from './group-array-parse';

describe('parseGroupList', () => {
    it('splits, trims and drops empties', () => {
        expect(parseGroupList('family, bookclub ,, kids ')).toEqual(['family', 'bookclub', 'kids']);
    });

    it('accepts the array shape config hands over on first render', () => {
        expect(parseGroupList(['family', 'kids'])).toEqual(['family', 'kids']);
    });

    it('treats null/undefined/empty as no groups', () => {
        expect(parseGroupList(undefined)).toEqual([]);
        expect(parseGroupList(null)).toEqual([]);
        expect(parseGroupList('')).toEqual([]);
        expect(parseGroupList('   ,  , ')).toEqual([]);
    });

    it('de-duplicates case-insensitively, keeping the first spelling', () => {
        // Would otherwise produce duplicate keys in the keyed each -> runtime crash.
        expect(parseGroupList('admin,admin')).toEqual(['admin']);
        expect(parseGroupList('Family, family, FAMILY')).toEqual(['Family']);
    });

    it('preserves the operator spelling of the entry it keeps', () => {
        // Case must survive: the SQL side folds with Postgres `lower()`, and the
        // admin surface reports the circle in the operator's own spelling.
        expect(parseGroupList('HouseHold')).toEqual(['HouseHold']);
    });
});

describe('mergeGroupNames', () => {
    it('splits a pasted comma-separated string into separate entries', () => {
        // The keydown handler only catches a TYPED comma; a paste reaches here whole.
        expect(mergeGroupNames(['family'], 'bookclub, kids')).toEqual([
            'family',
            'bookclub',
            'kids',
        ]);
    });

    it('ignores entries already present, in any case', () => {
        expect(mergeGroupNames(['Family'], 'family')).toEqual(['Family']);
        expect(mergeGroupNames(['family'], 'family, family')).toEqual(['family']);
    });

    it('returns the original array reference contents when nothing is added', () => {
        expect(mergeGroupNames(['family'], '   ')).toEqual(['family']);
    });
});

describe('foldGroupName', () => {
    it('trims and lowercases, matching the Postgres-side comparison', () => {
        expect(foldGroupName('  HouseHold ')).toBe('household');
    });
});
