// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

vi.mock('$lib/server/services/image-descriptor/resolver.js', () => ({
    resolveImageSets: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('./client.js', () => ({
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    apiPut: vi.fn(),
    apiDelete: vi.fn(),
}));

import { searchPreviews } from '$lib/server/api/defs/search/preview-mapper.js';
import { SearchResponseSchema } from './content';
import { transformSearchItem } from '$lib/utils/search/transformers';

const ID = '11111111-1111-4111-8111-111111111111';
const page = { limit: 20, offset: 0, hasMore: false };

// The web client must accept exactly what /api/search emits. Building the items with the real
// mapper means a renamed server field fails here instead of only being reported in prod.
describe('web search schema vs. the real /api/search item shape', () => {
    it('parses searchPreviews output and keeps score and reason', async () => {
        const items = await searchPreviews({} as Sql, 'v1', [
            {
                id: ID,
                type: 'episode',
                ids: { internal: ID },
                title: 'Pilot',
                rank: 2.5,
                matchSource: 'title',
                images: { poster: { href: 'x' } },
                seriesId: ID,
                seriesName: 'Show',
                seasonNumber: 1,
                episodeNumber: 2,
                isAvailable: true,
            },
            {
                id: 'track-1',
                type: 'track',
                ids: {},
                title: 'Song',
                rank: 1,
                matchSource: 'title',
                images: { poster: { href: 'x' } },
                duration: 187,
            },
        ]);
        const parsed = SearchResponseSchema.safeParse({ items, page });
        expect(parsed.success).toBe(true);
        if (!parsed.success) return;
        expect(parsed.data.items[0]).toMatchObject({ score: 2.5, reason: { kind: 'title' } });
        expect(parsed.data.items[1].durationMs).toBe(187000);
    });

    it('a description hit (reason.kind overview) still gets its marker and excerpt', async () => {
        const items = await searchPreviews({} as Sql, 'v1', [
            {
                id: ID,
                type: 'movie',
                ids: { internal: ID },
                title: 'Quiet Orbit',
                overview: 'A spaceship arrives at the station.',
                rank: 0.4,
                matchSource: 'overview',
                images: { poster: { href: 'x' } },
                isAvailable: true,
            },
        ]);
        const parsed = SearchResponseSchema.parse({ items, page });
        const card = transformSearchItem(parsed.items[0], 'spaceship');
        expect(card.matchSource).toBe('overview');
        expect(card.matchSnippet).toContain('spaceship');
    });
});
