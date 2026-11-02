// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { buildImageSet } from '$lib/shared/image-descriptor.js';
import { SeasonNodeSchema } from './api-series-responses.js';

describe('SeasonNodeSchema — premiereDate field', () => {
    it('preserves premiereDate (always emitted by GET /series/{id}/seasons/{n})', () => {
        // defs/catalog/series/seasons.ts always sets `premiereDate` on the SeasonNode
        // it returns (see buildSeasonNodes' physical season mapping), so this schema
        // — the one wired into the OpenAPI contract for that endpoint — must declare
        // the field or strict client codegen (tvOS) never expects it even though the
        // server always sends it. Zod strips undeclared keys silently on a bare
        // z.object(), so `success` alone doesn't prove the field is part of the
        // schema — assert it survives parsing.
        const result = SeasonNodeSchema.safeParse({
            id: '22222222-2222-4222-8222-222222222222',
            catalogId: '22222222-2222-4222-8222-222222222222',
            ordering: 'standard',
            virtual: false,
            href: '/api/v1/seasons/22222222-2222-4222-8222-222222222222',
            type: 'season',
            ids: {},
            title: 'Season 1',
            seasonNumber: 1,
            premiereDate: '2024-01-15T00:00:00.000Z',
            episodeCount: 10,
            watchedCount: 3,
            images: buildImageSet('v1', {
                poster: { ownerId: '22222222-2222-4222-8222-222222222222' },
            }),
            series: {
                id: '11111111-1111-4111-8111-111111111111',
                catalogId: '11111111-1111-4111-8111-111111111111',
                href: '/api/v1/series/series-uuid',
            },
            episodes: { href: '/api/v1/series/series-uuid/episodes?season=1' },
        });

        expect(result.success).toBe(true);
        expect(result.data?.premiereDate).toBe('2024-01-15T00:00:00.000Z');
    });

    it('allows premiereDate to be omitted (virtual-ordering seasons never set it)', () => {
        // buildSeasonNodes' virtual-ordering branch (non-standard episode ordering)
        // never populates `premiereDate`, so the field must be optional, not required.
        const result = SeasonNodeSchema.safeParse({
            id: '22222222-2222-4222-8222-222222222222',
            catalogId: '22222222-2222-4222-8222-222222222222',
            ordering: 'standard',
            virtual: false,
            href: '/api/v1/seasons/22222222-2222-4222-8222-222222222222',
            type: 'season',
            ids: {},
            title: 'Season 1',
            seasonNumber: 1,
            episodeCount: 10,
            watchedCount: 3,
            images: buildImageSet('v1', {
                poster: { ownerId: '22222222-2222-4222-8222-222222222222' },
            }),
            series: {
                id: '11111111-1111-4111-8111-111111111111',
                catalogId: '11111111-1111-4111-8111-111111111111',
                href: '/api/v1/series/series-uuid',
            },
            episodes: { href: '/api/v1/series/series-uuid/episodes?season=1' },
        });

        expect(result.success).toBe(true);
        expect(result.data?.premiereDate).toBeUndefined();
    });
});
