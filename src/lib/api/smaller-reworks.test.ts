// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
}));
vi.mock('./client.js', () => ({
    apiGet: calls.get,
    apiPost: calls.post,
    apiPut: calls.put,
    apiPatch: calls.patch,
    apiDelete: calls.delete,
}));
import { followSeries, unfollowSeries, getSeriesFollows } from './notifications.js';
import { getSimilarTracks, searchMusicByText, searchMusicByLyrics } from './music.js';

beforeEach(() => vi.clearAllMocks());
describe('series-follow web contracts', () => {
    it('uses path-based idempotent follows and accepts empty 204 responses', () => {
        followSeries('series-id');
        unfollowSeries('series-id');
        expect(calls.put.mock.calls[0][0]).toBe('/api/me/series-follows/series-id');
        expect(calls.delete.mock.calls[0][0]).toBe('/api/me/series-follows/series-id');
        expect(calls.put.mock.calls[0][1].safeParse(null).success).toBe(true);
        expect(calls.delete.mock.calls[0][1].safeParse(null).success).toBe(true);
        getSeriesFollows(100, 100);
        expect(calls.get).toHaveBeenCalledWith('/api/me/series-follows', expect.anything(), {
            params: { limit: 100, offset: 100 },
        });
    });
});

it('validates music limit-only envelopes using truncated', () => {
    getSimilarTracks('track-id');
    searchMusicByText('piano');
    searchMusicByLyrics('moon');
    for (const [, schema] of calls.get.mock.calls) {
        expect(
            schema.safeParse({
                items: [],
                source: 'metadata',
                page: { limit: 20, offset: 0, truncated: false },
            }).success,
        ).toBe(true);
        expect(
            schema.safeParse({
                items: [],
                source: 'metadata',
                page: { limit: 20, offset: 0, hasMore: false },
            }).success,
        ).toBe(false);
    }
});
