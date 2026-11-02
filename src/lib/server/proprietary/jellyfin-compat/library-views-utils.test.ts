// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, it, expect } from 'vitest';
import { lastSegment, MEDIA_TYPE_TO_COLLECTION } from './library-views-utils';

describe('lastSegment', () => {
    it('returns last segment of a normal path', () => {
        expect(lastSegment('/data/media/movies')).toBe('movies');
    });

    it('handles trailing slash', () => {
        expect(lastSegment('/data/media/movies/')).toBe('movies');
    });

    it('returns single segment path as-is', () => {
        expect(lastSegment('movies')).toBe('movies');
    });

    it('returns the full path as fallback for empty string', () => {
        // split('/').filter(Boolean) = [] for '', so segments[last-1] is undefined
        // fallback is the original path ''
        expect(lastSegment('')).toBe('');
    });

    it('handles deeply nested path', () => {
        expect(lastSegment('/a/b/c/d/e')).toBe('e');
    });
});

describe('MEDIA_TYPE_TO_COLLECTION', () => {
    it('maps movie to movies', () => {
        expect(MEDIA_TYPE_TO_COLLECTION['movie']).toBe('movies');
    });

    it('maps tv to tvshows', () => {
        expect(MEDIA_TYPE_TO_COLLECTION['tv']).toBe('tvshows');
    });

    it('maps music to music', () => {
        expect(MEDIA_TYPE_TO_COLLECTION['music']).toBe('music');
    });

    it('has no audiobook entry — excluded from /j library views (no playback path)', () => {
        expect(MEDIA_TYPE_TO_COLLECTION['audiobook']).toBeUndefined();
    });

    it('maps anime to tvshows', () => {
        expect(MEDIA_TYPE_TO_COLLECTION['anime']).toBe('tvshows');
    });
});
