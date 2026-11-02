// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { buildProviderDetailResult } from './detail-coerce.js';
import type { TmdbItem } from './detail-coerce.js';

describe('buildProviderDetailResult — cast', () => {
    it('uses credits.cast when present', () => {
        const d = buildProviderDetailResult(
            {
                id: 475557,
                title: 'Jasper',
                credits: {
                    cast: [
                        { id: 73421, name: 'Jules Fenwick', character: 'Arthur Fleck', order: 0 },
                    ],
                },
            } as unknown as TmdbItem,
            'movie',
        );
        expect(d.cast?.[0]).toMatchObject({
            name: 'Jules Fenwick',
            character: 'Arthur Fleck',
            personId: '73421',
        });
    });

    it('falls back to aggregate_credits for a series whose credits.cast is empty', () => {
        const d = buildProviderDetailResult(
            {
                id: 95479,
                name: 'JUJUTSU KAISEN',
                credits: { cast: [], crew: [] },
                aggregate_credits: {
                    cast: [
                        {
                            id: 1256603,
                            name: 'Junyo Fenwick',
                            order: 0,
                            roles: [
                                { character: 'Extra', episode_count: 1 },
                                { character: 'Yuji Itadori', episode_count: 59 },
                            ],
                        },
                    ],
                },
            } as unknown as TmdbItem,
            'tv',
        );
        expect(d.cast).toHaveLength(1);
        expect(d.cast?.[0]).toMatchObject({
            name: 'Junyo Fenwick',
            character: 'Yuji Itadori',
            personId: '1256603',
        });
    });
});
