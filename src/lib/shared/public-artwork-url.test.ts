// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { buildPublicArtworkUrl } from './public-artwork-url.js';

describe('buildPublicArtworkUrl', () => {
    it('turns a TMDB-relative path into an absolute CDN URL', () => {
        expect(buildPublicArtworkUrl('/abc123.jpg')).toBe(
            'https://image.tmdb.org/t/p/w500/abc123.jpg',
        );
    });

    it('passes through an absolute https URL unchanged', () => {
        const url = 'https://coverartarchive.org/release/xyz/front-500.jpg';
        expect(buildPublicArtworkUrl(url)).toBe(url);
    });

    it('rejects http URLs — Discord requires https', () => {
        expect(buildPublicArtworkUrl('http://example.com/a.jpg')).toBeUndefined();
    });

    it('returns undefined for null, empty, and whitespace input', () => {
        expect(buildPublicArtworkUrl(null)).toBeUndefined();
        expect(buildPublicArtworkUrl('')).toBeUndefined();
        expect(buildPublicArtworkUrl('   ')).toBeUndefined();
    });

    it('returns undefined for a relative path that is not TMDB-shaped', () => {
        expect(buildPublicArtworkUrl('abc123.jpg')).toBeUndefined();
    });
});
