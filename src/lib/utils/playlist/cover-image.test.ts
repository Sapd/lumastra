// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { getCoverItemPosterUrl } from './cover-image';

const UUID = '0c27418e-f75b-4ffc-8fd0-d943391695f7';

describe('getCoverItemPosterUrl', () => {
    it('resolves a movie through the catalog route even when custom_poster_url dangles', () => {
        // Observed on preprod: `custom_poster_url` pointed at the item's own
        // custom endpoint after the backing media_artwork row was purged.
        // /api/image/custom/<id>/poster 404s; /api/image/catalog/<id>/poster
        // serves the item's provider art. Trusting posterUrl here is what
        // painted the tile grey.
        const url = getCoverItemPosterUrl({
            externalIds: { internal: UUID, tmdb: '12345' },
            mediaType: 'movie',
            posterUrl: `/api/image/custom/${UUID}/poster`,
        });

        // Canonical entity route — same ImageProxyService.getImageByCatalogId()
        // resolution (local artwork + parent walk + provider chain).
        expect(url).toContain(`/api/media/${UUID}/images/poster`);
        expect(url).not.toContain('/api/image/custom/');
    });

    it('resolves a music track through the catalog route so it inherits album art', () => {
        const url = getCoverItemPosterUrl({
            externalIds: { internal: UUID },
            mediaType: 'track',
        });

        expect(url).toContain(`/api/media/${UUID}/images/poster`);
    });

    it('still resolves an episode by series external ids when there is no internal uuid', () => {
        const url = getCoverItemPosterUrl({
            externalIds: { tmdb: '999' },
            mediaType: 'episode',
            seriesExternalIds: { tmdb: '271607' },
        });

        expect(url).toBeTruthy();
        expect(url).toContain('271607');
    });

    it('falls back to a bare posterUrl only when the item has no internal uuid', () => {
        const url = getCoverItemPosterUrl({
            externalIds: {},
            mediaType: 'movie',
            posterUrl: '/api/image/custom/legacy/poster',
        });

        expect(url).toBe('/api/image/custom/legacy/poster');
    });
});
