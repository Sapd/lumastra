// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { languagePreferenceOptions, matchingOptionValue } from './language-options';

describe('languagePreferenceOptions', () => {
    it('labels codes in the reader’s language', () => {
        const de = languagePreferenceOptions('de', null);
        expect(de.find((o) => o.value === 'jpn')?.label).toBe('Japanisch');
        const en = languagePreferenceOptions('en', null);
        expect(en.find((o) => o.value === 'ger')?.label).toBe('German');
    });

    it('keeps an unusual saved code as its own option instead of dropping it', () => {
        const opts = languagePreferenceOptions('en', 'est');
        expect(opts.some((o) => o.value === 'est')).toBe(true);
    });

    it('does not duplicate a saved code that is a spelling of a listed language', () => {
        const opts = languagePreferenceOptions('en', 'deu');
        expect(opts.filter((o) => o.label === 'German')).toHaveLength(1);
    });
});

describe('matchingOptionValue', () => {
    it('maps every spelling of a language onto its listed option', () => {
        expect(matchingOptionValue('de')).toBe('ger');
        expect(matchingOptionValue('deu')).toBe('ger');
        expect(matchingOptionValue('ja')).toBe('jpn');
        expect(matchingOptionValue('')).toBe('');
        expect(matchingOptionValue(null)).toBe('');
    });
});
