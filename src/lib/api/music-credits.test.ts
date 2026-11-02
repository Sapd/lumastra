// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ apiGet: vi.fn(), apiPatch: vi.fn() }));
vi.mock('./client.js', () => mocks);
import { readArtistCredits, readArtistTracks } from './music-credits.js';
import {
    ArtistCreditReviewResponseSchema,
    ArtistTracksResponseSchema,
} from '$lib/schemas/music-credit-review.js';
it('passes the canonical review query as the actual API options argument', () => {
    readArtistCredits('track');
    expect(mocks.apiGet).toHaveBeenCalledWith(
        '/api/media/track/metadata',
        ArtistCreditReviewResponseSchema,
        { params: { includeArtistCredits: '1' } },
    );
});
it('uses a distinct artist inventory response and bounded paging options', () => {
    const params = { q: 'Guest', issue: 'missing-file', sort: 'title', page: '2' };
    readArtistTracks('artist', params);
    expect(mocks.apiGet).toHaveBeenCalledWith(
        '/api/admin/media/artist/tracks',
        ArtistTracksResponseSchema,
        { params },
    );
});
