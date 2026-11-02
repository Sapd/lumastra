// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getItemImageUrl } from './browse-modals';

describe('getItemImageUrl', () => {
    it('uses tv for a series when falling back to TMDB', () => {
        expect(
            getItemImageUrl({ id: '', name: '', type: 'Series', externalIds: { tmdb: '1399' } }),
        ).toBe('/api/media/tmdb:1399:tv/images/poster?size=full');
    });

    it('keeps movie fallback behavior for movie items', () => {
        expect(
            getItemImageUrl({ id: '', name: '', type: 'Movie', externalIds: { tmdb: '550' } }),
        ).toBe('/api/media/tmdb:550:movie/images/poster?size=full');
    });
});
