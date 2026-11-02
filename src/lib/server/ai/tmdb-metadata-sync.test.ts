// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    collectTmdbTranslationTitles,
    classifyTmdbFailure,
    buildCanonicalDetailFields,
} from './tmdb-metadata-sync.js';
import type { ProviderDetailResult } from '@sapd/lumastra-plugin-sdk';

describe('classifyTmdbFailure', () => {
    it('returns "unknown" for undefined (no recorded failure)', () => {
        expect(classifyTmdbFailure(undefined)).toBe('unknown');
    });

    it('detects a rate limit from a TmdbApiError 429 message', () => {
        expect(
            classifyTmdbFailure(
                'Failed to sync Foo: TMDB API request failed: 429 Too Many Requests',
            ),
        ).toBe('rate-limit');
    });

    it('detects an auth failure from "API key not configured"', () => {
        expect(classifyTmdbFailure('Failed to sync Foo: TMDB API key not configured')).toBe('auth');
    });

    it('detects an auth failure from "API key is invalid"', () => {
        expect(classifyTmdbFailure('Failed to sync Foo: TMDB API key is invalid')).toBe('auth');
    });

    it('returns "unknown" for a generic 5xx/network failure', () => {
        expect(
            classifyTmdbFailure(
                'Failed to sync Foo: TMDB API request failed: 503 Service Unavailable',
            ),
        ).toBe('unknown');
    });
});

/**
 * Example names are fictional; production shapes and measurements are retained.
 * The TMDB provider spreads the raw TMDB API response alongside the neutral
 * `ProviderDetailResult` fields (see `providers/tmdb.ts`), so a `translations`
 * key reaches `collectTmdbTranslationTitles` even though it isn't part of the
 * typed interface. These tests build that raw shape directly.
 */
function detailWithTranslations(
    translations: Array<{ iso_639_1?: unknown; data?: { title?: unknown; name?: unknown } }>,
): ProviderDetailResult {
    return { translations: { translations } } as ProviderDetailResult;
}

describe('buildCanonicalDetailFields', () => {
    it('maps a provider-neutral detail to the canonical provider_metadata keys', () => {
        // Raw TMDB stores `runtime` and `credits.cast`; the aggregator + detail
        // read only understand `runtime_minutes`, `cast` (with person_id), and
        // `actors`. This helper bridges that gap provider-agnostically from the
        // neutral ProviderDetailResult.
        const detail: ProviderDetailResult = {
            runtime: 139,
            directors: ['David Fincher'],
            producers: ['Art Linson'],
            writers: ['Jim Uhls'],
            trailerUrl: 'https://www.youtube.com/watch?v=abc',
            genreSlugs: ['drama', 'thriller'],
            keywordSlugs: ['based-on-novel'],
            rawKeywordIds: [818, 825],
            cast: [
                { name: 'Edward Vale', character: 'The Narrator', order: 0, personId: '819' },
                { name: 'Bram Fenwick', character: 'Tyler Durden', order: 1, personId: '287' },
            ],
        };

        const fields = buildCanonicalDetailFields(detail);

        expect(fields.runtime_minutes).toBe(139);
        expect(fields.directors).toEqual(['David Fincher']);
        expect(fields.cast).toEqual([
            { name: 'Edward Vale', character: 'The Narrator', person_id: '819' },
            { name: 'Bram Fenwick', character: 'Tyler Durden', person_id: '287' },
        ]);
        expect(fields.actors).toEqual(['Edward Vale', 'Bram Fenwick']);
        // Parity with the discovery path — the aggregator sources these canonical
        // keys from the tmdb row too, so a fresh item must carry them (e.g. so the
        // modal shows the YouTube trailer and slug-based browse matches).
        expect(fields.producers).toEqual(['Art Linson']);
        expect(fields.writers).toEqual(['Jim Uhls']);
        expect(fields.trailer_url).toBe('https://www.youtube.com/watch?v=abc');
        expect(fields.genre_slugs).toEqual(['drama', 'thriller']);
        expect(fields.keyword_slugs).toEqual(['based-on-novel']);
        expect(fields.tmdb_keyword_ids).toEqual([818, 825]);
    });

    it('returns an empty object for a null detail', () => {
        expect(buildCanonicalDetailFields(null)).toEqual({});
    });

    it('omits cast/actors/directors when absent but keeps runtime', () => {
        const fields = buildCanonicalDetailFields({ runtime: 90, cast: [] });
        expect(fields.runtime_minutes).toBe(90);
        expect(fields.cast).toBeUndefined();
        expect(fields.actors).toBeUndefined();
        expect(fields.directors).toBeUndefined();
    });
});

describe('collectTmdbTranslationTitles', () => {
    it('returns an empty list for null detail', () => {
        expect(collectTmdbTranslationTitles(null)).toEqual([]);
    });

    it('returns an empty list when the detail has no translations block', () => {
        expect(collectTmdbTranslationTitles({} as ProviderDetailResult)).toEqual([]);
    });

    it('extracts a movie-style translation (data.title)', () => {
        const detail = detailWithTranslations([
            { iso_639_1: 'de', data: { title: 'Der Hüter der Lichter: Die Begleiter' } },
        ]);
        expect(collectTmdbTranslationTitles(detail)).toEqual([
            { title: 'Der Hüter der Lichter: Die Begleiter', language: 'de', kind: 'localized' },
        ]);
    });

    it('extracts a TV-style translation (data.name)', () => {
        const detail = detailWithTranslations([
            { iso_639_1: 'de', data: { name: 'Harborfolk Große Pause' } },
        ]);
        expect(collectTmdbTranslationTitles(detail)).toEqual([
            { title: 'Harborfolk Große Pause', language: 'de', kind: 'localized' },
        ]);
    });

    it('skips translations with no title or name', () => {
        const detail = detailWithTranslations([
            { iso_639_1: 'xx', data: {} },
            { iso_639_1: 'de', data: { title: 'Real Title' } },
        ]);
        expect(collectTmdbTranslationTitles(detail)).toEqual([
            { title: 'Real Title', language: 'de', kind: 'localized' },
        ]);
    });

    it('skips translations with an empty-string title (TMDB untranslated placeholder)', () => {
        const detail = detailWithTranslations([{ iso_639_1: 'xx', data: { title: '' } }]);
        expect(collectTmdbTranslationTitles(detail)).toEqual([]);
    });

    it('falls back to a null language when iso_639_1 is not a string', () => {
        const detail = detailWithTranslations([{ iso_639_1: 42, data: { title: 'Untitled' } }]);
        expect(collectTmdbTranslationTitles(detail)).toEqual([
            { title: 'Untitled', language: null, kind: 'localized' },
        ]);
    });

    it('handles multiple translations', () => {
        const detail = detailWithTranslations([
            { iso_639_1: 'de', data: { title: 'German Title' } },
            { iso_639_1: 'fr', data: { title: 'French Title' } },
            { iso_639_1: 'ja', data: { title: 'Japanese Title' } },
        ]);
        expect(collectTmdbTranslationTitles(detail)).toEqual([
            { title: 'German Title', language: 'de', kind: 'localized' },
            { title: 'French Title', language: 'fr', kind: 'localized' },
            { title: 'Japanese Title', language: 'ja', kind: 'localized' },
        ]);
    });
});
