// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    buildSubtitleDisplayTitle,
    distinctSubtitleChipLabels,
    formatAudioTrackLabel,
    isUnknownLanguage,
    languagesMatch,
    normalizeLanguage,
    trackLanguageName,
} from './language-utils';

describe('trackLanguageName (human names instead of ISO codes)', () => {
    it('names ISO 639-2 tags in the UI locale', () => {
        expect(trackLanguageName('ger', 'en')).toBe('German');
        expect(trackLanguageName('ger', 'de')).toBe('Deutsch');
        expect(trackLanguageName('nob', 'en')).toMatch(/^Norwegian/);
    });

    it('names tags the normalization table lacks via Intl (BAQ)', () => {
        expect(trackLanguageName('baq', 'en')).toBe('Basque');
    });

    it('is empty for untagged tracks and keeps an unknown code as-is', () => {
        expect(trackLanguageName('und', 'en')).toBe('');
        expect(trackLanguageName(null, 'en')).toBe('');
        expect(trackLanguageName('qqq', 'en')).toBe('QQQ');
    });
});

describe('distinctSubtitleChipLabels', () => {
    it('leaves unique labels alone', () => {
        const labels = distinctSubtitleChipLabels([
            { index: 1, label: 'German', codecType: 'SRT' },
            { index: 2, label: 'German (Forced)', codecType: 'SRT' },
        ]);
        expect([...labels.values()]).toEqual(['German', 'German (Forced)']);
    });

    it('adds the codec to colliding labels, then a track number', () => {
        const labels = distinctSubtitleChipLabels([
            { index: 1, label: 'German', codecType: 'SRT' },
            { index: 2, label: 'German', codecType: 'PGS' },
            { index: 3, label: 'German', codecType: 'SRT' },
            { index: 4, label: 'English', codecType: 'SRT' },
        ]);
        expect(labels.get(1)).toBe('German · SRT · Track 1');
        expect(labels.get(2)).toBe('German · PGS');
        expect(labels.get(3)).toBe('German · SRT · Track 2');
        expect(labels.get(4)).toBe('English');
        expect(new Set(labels.values()).size).toBe(4);
    });
});

describe('buildSubtitleDisplayTitle', () => {
    it('distinguishes a forced track from the full one of the same language', () => {
        const full = buildSubtitleDisplayTitle({ language: 'ger', title: null }, 'en');
        const forced = buildSubtitleDisplayTitle(
            { language: 'ger', title: null, forced: true },
            'en',
        );
        expect(full).toBe('German');
        expect(forced).toBe('German (Forced)');
    });

    it('marks hearing-impaired tracks with SDH (the badge reads that token)', () => {
        expect(buildSubtitleDisplayTitle({ language: 'eng', hearingImpaired: true }, 'en')).toBe(
            'English (SDH)',
        );
    });

    it('keeps a meaningful title and drops a redundant one', () => {
        expect(buildSubtitleDisplayTitle({ language: 'jpn', title: 'Signs & Songs' }, 'en')).toBe(
            'Japanese — Signs & Songs',
        );
        expect(
            buildSubtitleDisplayTitle(
                { language: 'ger', title: 'German Forced', forced: true },
                'en',
            ),
        ).toBe('German (Forced)');
    });

    it('keeps "forced"/"SDH" words the downstream heuristics read from the title', () => {
        // No forced flag, only the title says so: the title-based forced
        // heuristic must still find "forced" in the display title.
        expect(
            buildSubtitleDisplayTitle({ language: 'ger', title: 'Forced' }, 'en').toLowerCase(),
        ).toContain('forced');
        expect(buildSubtitleDisplayTitle({ language: 'eng', title: 'SDH' }, 'en')).toContain('SDH');
    });

    it('falls back to "Unknown language" for untagged tracks', () => {
        expect(buildSubtitleDisplayTitle({ language: 'und' }, 'en')).toBe('Unknown language');
    });
});

describe('normalizeLanguage', () => {
    it('maps ISO 639-2/B to ISO 639-1', () => {
        expect(normalizeLanguage('ger')).toBe('de');
        expect(normalizeLanguage('eng')).toBe('en');
    });

    it('passes through unknown codes lowercased', () => {
        expect(normalizeLanguage('xyz')).toBe('xyz');
    });

    it('returns empty for nullish input', () => {
        expect(normalizeLanguage(null)).toBe('');
        expect(normalizeLanguage(undefined)).toBe('');
        expect(normalizeLanguage('')).toBe('');
    });
});

describe('languagesMatch', () => {
    it('matches ger and de as same language', () => {
        expect(languagesMatch('ger', 'de')).toBe(true);
    });

    it('does not match when either side is missing', () => {
        expect(languagesMatch(undefined, undefined)).toBe(false);
        expect(languagesMatch('eng', undefined)).toBe(false);
        expect(languagesMatch(null, 'eng')).toBe(false);
    });
});

describe('isUnknownLanguage', () => {
    it('treats undefined / null / empty as unknown', () => {
        expect(isUnknownLanguage(undefined)).toBe(true);
        expect(isUnknownLanguage(null)).toBe(true);
        expect(isUnknownLanguage('')).toBe(true);
    });

    it('treats ISO "und" and "mul" as unknown', () => {
        expect(isUnknownLanguage('und')).toBe(true);
        expect(isUnknownLanguage('UND')).toBe(true);
        expect(isUnknownLanguage('mul')).toBe(true);
    });

    it('treats real language codes as known', () => {
        expect(isUnknownLanguage('eng')).toBe(false);
        expect(isUnknownLanguage('en')).toBe(false);
        expect(isUnknownLanguage('ger')).toBe(false);
        expect(isUnknownLanguage('jpn')).toBe(false);
    });
});

describe('formatAudioTrackLabel', () => {
    it('returns the upper-cased language when present', () => {
        expect(
            formatAudioTrackLabel({
                language: 'ger',
                codec: 'ac3',
                displayTitle: 'whatever',
            }),
        ).toBe('GER');
    });

    it('falls back to "UNK" when no language and displayTitle starts with codec', () => {
        // Regression: title "AC3 5.1 @ 640 kbps" with codec "ac3" must NOT
        // produce "AC3" as if it were a language tag.
        expect(
            formatAudioTrackLabel({
                language: undefined,
                codec: 'ac3',
                displayTitle: 'AC3 5.1 @ 640 kbps',
            }),
        ).toBe('UNK');
    });

    it('uses displayTitle slice when it does NOT begin with codec name', () => {
        expect(
            formatAudioTrackLabel({
                language: undefined,
                codec: 'aac',
                displayTitle: 'English Stereo',
            }),
        ).toBe('ENG');
    });

    it('treats ISO "und" as missing language and falls through', () => {
        // 'und' is the ISO marker for undetermined — should not be shown
        // verbatim because it gives the user no actionable info.
        expect(
            formatAudioTrackLabel({
                language: 'und',
                codec: 'aac',
                displayTitle: 'Commentary track',
            }),
        ).toBe('COM');
    });

    it('treats ISO "mul" as missing language and falls through', () => {
        expect(
            formatAudioTrackLabel({
                language: 'mul',
                codec: 'aac',
                displayTitle: 'Mixed Languages',
            }),
        ).toBe('MIX');
    });

    it('strips leading non-alphanumeric chars from displayTitle', () => {
        // Title with leading whitespace or symbols must not produce
        // visually-broken labels like ' AC' or '@ E'.
        expect(
            formatAudioTrackLabel({
                language: undefined,
                codec: 'aac',
                displayTitle: '   Spanish Surround',
            }),
        ).toBe('SPA');
        expect(
            formatAudioTrackLabel({
                language: undefined,
                codec: 'aac',
                displayTitle: '@@@English',
            }),
        ).toBe('ENG');
    });

    it('returns "UNK" when codec is empty string and language is missing', () => {
        // Empty-string codec should be treated as missing, not as a prefix
        // that matches everything (startsWith('') is always true).
        expect(
            formatAudioTrackLabel({
                language: undefined,
                codec: '',
                displayTitle: 'English',
            }),
        ).toBe('UNK');
    });

    it('returns "UNK" when everything is missing', () => {
        expect(formatAudioTrackLabel({})).toBe('UNK');
    });

    it('returns "UNK" when displayTitle has no alphanumeric content', () => {
        expect(
            formatAudioTrackLabel({
                language: undefined,
                codec: 'aac',
                displayTitle: '@@@@',
            }),
        ).toBe('UNK');
    });
});

describe('language codes TMDB emits that the map must cover', () => {
    // `provider_metadata.metadata->>'original_language'` is a TMDB value, and
    // TMDB's namespace is not strictly ISO 639-1. These are the prod values the
    // "prefer original language" preference has to match against file tags.
    it("maps TMDB's 'cn' onto the same language as chi/zho tags", () => {
        expect(normalizeLanguage('cn')).toBe('zh');
        expect(languagesMatch('cn', 'chi')).toBe(true);
        expect(languagesMatch('cn', 'zho')).toBe(true);
    });

    it("treats 'xx' (no linguistic content) as unknown", () => {
        expect(isUnknownLanguage('xx')).toBe(true);
    });

    it('normalizes 639-2 tags for languages beyond the original map', () => {
        expect(languagesMatch('tl', 'tgl')).toBe(true);
        expect(languagesMatch('te', 'tel')).toBe(true);
        expect(languagesMatch('ta', 'tam')).toBe(true);
        expect(languagesMatch('fa', 'per')).toBe(true);
        expect(languagesMatch('fa', 'fas')).toBe(true);
        expect(languagesMatch('ml', 'mal')).toBe(true);
        expect(languagesMatch('bn', 'ben')).toBe(true);
        expect(languagesMatch('mr', 'mar')).toBe(true);
        expect(languagesMatch('kn', 'kan')).toBe(true);
        expect(languagesMatch('is', 'ice')).toBe(true);
        expect(languagesMatch('is', 'isl')).toBe(true);
    });

    it("does not collapse 'est' onto Spanish when truncating", () => {
        expect(languagesMatch('es', 'est')).toBe(false);
    });
});

describe('formatAudioTrackLabel and isUnknownLanguage agree on empty tags', () => {
    it('does not label a no-linguistic-content track with its raw code', () => {
        // isUnknownLanguage treats zxx/xx as carrying no information; the chip
        // label must not then render "XX" as though it were a language.
        expect(formatAudioTrackLabel({ language: 'xx', displayTitle: '', codec: 'ac3' })).toBe(
            'UNK',
        );
        expect(formatAudioTrackLabel({ language: 'zxx', displayTitle: '', codec: 'ac3' })).toBe(
            'UNK',
        );
    });
});
