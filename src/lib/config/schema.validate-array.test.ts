// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * validateSettingValue — `array`-type coverage.
 *
 * Final-review IMPORTANT finding (multilingual-media-metadata): before this,
 * `validateSettingValue` had NO `array` branch at all — an admin could save
 * 40 garbage "languages" and the config service would happily persist them.
 * These tests cover the generic array validation (shape + `maxItems`) plus
 * the METADATA_ADDITIONAL_LANGUAGES-specific `languageTags` rule end to end
 * through the real schema entry.
 */

import { describe, it, expect } from 'vitest';
import { configSchema, toList, validateSettingValue, type SettingDefinition } from './schema.js';

function find(key: string): SettingDefinition {
    const setting = configSchema.find((s) => s.key === key);
    if (!setting) throw new Error(`Missing schema entry: ${key}`);
    return setting;
}

describe('toList', () => {
    it('passes through a string[] as-is (stringified)', () => {
        expect(toList(['de', 'ja'])).toEqual(['de', 'ja']);
    });

    it('splits a comma-separated string (the ArrayInput.svelte shape), trimming whitespace', () => {
        expect(toList('de, ja ,  fr')).toEqual(['de', 'ja', 'fr']);
    });

    it('drops empty segments', () => {
        expect(toList('de,, ja,')).toEqual(['de', 'ja']);
    });

    it('returns [] for null/undefined/non-string-non-array', () => {
        expect(toList(null)).toEqual([]);
        expect(toList(undefined)).toEqual([]);
        expect(toList(42)).toEqual([]);
    });
});

describe('validateSettingValue — array type (generic)', () => {
    const genericArraySetting: SettingDefinition = {
        key: 'TEST_ARRAY_SETTING',
        type: 'array',
        label: 'Test',
        description: 'Test',
        defaultValue: [],
        section: 'test',
        validation: { maxItems: 2 },
    };

    it('rejects a non-string, non-array value', () => {
        const result = validateSettingValue(genericArraySetting, 42);
        expect(result.valid).toBe(false);
    });

    it('accepts a string[] within maxItems', () => {
        expect(validateSettingValue(genericArraySetting, ['a', 'b']).valid).toBe(true);
    });

    it('accepts a comma-separated string within maxItems', () => {
        expect(validateSettingValue(genericArraySetting, 'a, b').valid).toBe(true);
    });

    it('rejects a comma-separated string exceeding maxItems', () => {
        const result = validateSettingValue(genericArraySetting, 'a, b, c');
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/at most 2/);
    });

    it('rejects a string[] exceeding maxItems', () => {
        expect(validateSettingValue(genericArraySetting, ['a', 'b', 'c']).valid).toBe(false);
    });

    it('undefined/null value is valid (falls back to default)', () => {
        expect(validateSettingValue(genericArraySetting, undefined).valid).toBe(true);
        expect(validateSettingValue(genericArraySetting, null).valid).toBe(true);
    });
});

describe('validateSettingValue — METADATA_ADDITIONAL_LANGUAGES (real schema entry)', () => {
    it('schema entry declares maxItems: 3 and languageTags: true', () => {
        const setting = find('METADATA_ADDITIONAL_LANGUAGES');
        expect(setting.validation?.maxItems).toBe(3);
        expect(setting.validation?.languageTags).toBe(true);
    });

    it('"de, ja" is accepted', () => {
        const setting = find('METADATA_ADDITIONAL_LANGUAGES');
        const result = validateSettingValue(setting, 'de, ja');
        expect(result.valid).toBe(true);
    });

    it('4 languages are rejected (exceeds maxItems: 3)', () => {
        const setting = find('METADATA_ADDITIONAL_LANGUAGES');
        const result = validateSettingValue(setting, 'de, ja, fr, es');
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/at most 3/);
    });

    it('"german" is rejected (not a BCP-47-ish tag)', () => {
        const setting = find('METADATA_ADDITIONAL_LANGUAGES');
        const result = validateSettingValue(setting, 'german');
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/Invalid language tag/);
    });

    it('a mix of valid and invalid tags is rejected, naming the bad entry', () => {
        const setting = find('METADATA_ADDITIONAL_LANGUAGES');
        const result = validateSettingValue(setting, 'de, german');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('german');
    });

    it('valid tags as a real string[] (non-UI programmatic shape) are accepted', () => {
        const setting = find('METADATA_ADDITIONAL_LANGUAGES');
        expect(validateSettingValue(setting, ['de', 'pt-BR']).valid).toBe(true);
    });

    // Finding 5: maxItems must count the NORMALIZED + DEDUPED list, not the
    // raw pre-normalize `toList()` output, or a save that would collapse to
    // ≤3 unique languages is confusingly rejected because of duplicate/casing
    // noise that never reaches storage.
    it('"de,de,de,fr" (2 unique after normalizing) is accepted despite 4 raw entries', () => {
        const setting = find('METADATA_ADDITIONAL_LANGUAGES');
        const result = validateSettingValue(setting, 'de,de,de,fr');
        expect(result.valid).toBe(true);
    });

    it('"de,fr,ja,pt" (4 unique) is still rejected (exceeds maxItems: 3)', () => {
        const setting = find('METADATA_ADDITIONAL_LANGUAGES');
        const result = validateSettingValue(setting, 'de,fr,ja,pt');
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/at most 3/);
    });
});

describe('validateSettingValue — array type (generic, non-languageTags) still counts the raw list', () => {
    it('a generic array setting rejects raw duplicates that would collapse under normalization semantics', () => {
        const genericArraySetting: SettingDefinition = {
            key: 'TEST_ARRAY_SETTING_DUPES',
            type: 'array',
            label: 'Test',
            description: 'Test',
            defaultValue: [],
            section: 'test',
            validation: { maxItems: 2 },
        };
        // No `languageTags`, so no normalize+dedupe step applies — 3 raw
        // entries (even literal duplicates) still exceed maxItems: 2.
        const result = validateSettingValue(genericArraySetting, 'a,a,a');
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/at most 2/);
    });
});
