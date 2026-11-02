// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    AUDIO_FILTER_LANGUAGES,
    SUBTITLE_FILTER_LANGUAGES,
    parseLangCsv,
} from './track-language.js';

describe('parseLangCsv', () => {
    it('keeps only allowed audio tokens, lowercased and deduped', () => {
        expect(parseLangCsv('de,EN,de,xx,ru', AUDIO_FILTER_LANGUAGES)).toEqual(['de', 'en']);
    });
    it('returns [] for undefined or empty', () => {
        expect(parseLangCsv(undefined, AUDIO_FILTER_LANGUAGES)).toEqual([]);
        expect(parseLangCsv('', AUDIO_FILTER_LANGUAGES)).toEqual([]);
    });
    it('respects a narrower subtitle allow-list', () => {
        expect(parseLangCsv('de,ja,en', SUBTITLE_FILTER_LANGUAGES)).toEqual(['de', 'en']);
    });
});
