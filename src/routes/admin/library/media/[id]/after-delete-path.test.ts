// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { afterDeletePath, type ParentChainEntry } from './after-delete-path';

describe('afterDeletePath', () => {
    it('falls back to the flat overview for a top-level item with no parent', () => {
        expect(afterDeletePath(undefined, [])).toBe('/admin/library/media');
    });

    it('returns to the album tracks tab after deleting a track', () => {
        const chain: ParentChainEntry[] = [
            { id: 'artist-1', mediaType: 'artist', title: 'Some Artist' },
            { id: 'album-1', mediaType: 'album', title: 'Eskalation' },
        ];
        expect(afterDeletePath('album-1', chain)).toBe('/admin/library/media/album-1?tab=tracks');
    });

    it('returns to the artist discography after deleting an album', () => {
        const chain: ParentChainEntry[] = [{ id: 'artist-1', mediaType: 'artist' }];
        expect(afterDeletePath('artist-1', chain)).toBe(
            '/admin/library/media/artist-1?tab=discography',
        );
    });

    it('returns to the season episodes tab after deleting an episode', () => {
        const chain: ParentChainEntry[] = [
            // TV shows are stored as the canonical lowercase 'tv', not 'series'.
            { id: 'series-1', mediaType: 'tv' },
            { id: 'season-1', mediaType: 'season' },
        ];
        expect(afterDeletePath('season-1', chain)).toBe(
            '/admin/library/media/season-1?tab=episodes',
        );
    });

    it('returns to the series episodes tab after deleting a season (canonical tv type)', () => {
        const chain: ParentChainEntry[] = [{ id: 'series-1', mediaType: 'tv' }];
        expect(afterDeletePath('series-1', chain)).toBe(
            '/admin/library/media/series-1?tab=episodes',
        );
    });

    it('navigates to the parent detail (no tab) when the parent type has no child tab', () => {
        const chain: ParentChainEntry[] = [{ id: 'movie-1', mediaType: 'movie' }];
        expect(afterDeletePath('movie-1', chain)).toBe('/admin/library/media/movie-1');
    });

    it('navigates to the parent detail when the parent is absent from the chain', () => {
        // ancestorChainFailed / inconsistent hierarchy: still better than the flat overview
        expect(afterDeletePath('album-9', [])).toBe('/admin/library/media/album-9');
    });
});
