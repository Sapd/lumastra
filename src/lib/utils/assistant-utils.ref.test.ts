// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the model-cited reference linking path (pattern B): the model
 * emits [Title](ref:ID:type); we parse it to a modal link and resolve the ref
 * against the actual recommended cards (validating away hallucinated refs).
 */
import { describe, it, expect } from 'vitest';
import { parseMarkdownLinks, resolveMovieByRef } from './assistant-utils';

describe('parseMarkdownLinks — ref links', () => {
    it('converts [Title](ref:562:movie) to a modal link with data-ref', () => {
        const out = parseMarkdownLinks('Try [Die Harbor](ref:562:movie) tonight.');
        expect(out).toContain('data-internal-link="modal"');
        expect(out).toContain('data-ref="562:movie"');
        expect(out).toContain('>Die Harbor</a>');
    });

    it('keeps the visible (possibly translated) title while preserving the ref', () => {
        const out = parseMarkdownLinks('Schau [Stirb langsam](ref:562:movie).');
        expect(out).toContain('data-ref="562:movie"');
        expect(out).toContain('>Stirb langsam</a>');
    });

    it('still treats normal external links as external', () => {
        const out = parseMarkdownLinks('[site](https://example.com)');
        expect(out).toContain('target="_blank"');
        expect(out).not.toContain('data-internal-link="modal"');
    });
});

describe('resolveMovieByRef', () => {
    const movies = [
        { externalIds: { tmdb: '562' }, mediaType: 'movie', title: 'Die Harbor' },
        {
            externalIds: { tmdb: '1396' },
            mediaType: 'tv',
            title: 'Drifting Clouds',
        },
    ];

    it('resolves a ref to the matching card by id + media type', () => {
        expect(resolveMovieByRef(movies, '562:movie')?.title).toBe('Die Harbor');
        expect(resolveMovieByRef(movies, '1396:tv')?.title).toBe('Drifting Clouds');
    });

    it('does not match when the media type differs (composite-key safety)', () => {
        // 562 exists as a movie, not tv — must not resolve.
        expect(resolveMovieByRef(movies, '562:tv')).toBeUndefined();
    });

    it('returns undefined for a hallucinated / unknown ref', () => {
        expect(resolveMovieByRef(movies, '999999:movie')).toBeUndefined();
        expect(resolveMovieByRef(movies, '')).toBeUndefined();
    });
});
