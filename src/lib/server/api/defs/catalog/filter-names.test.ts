// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { MediaListingQuerySchema } from './media.js';
import { applyDef, OrderingInfoResponseSchema } from './series/ordering.js';

describe('filter concepts remain distinct', () => {
    it('requires the new library name and retains both conjunctive keyword inputs', () => {
        const libraryGroupId = '11111111-1111-4111-8111-111111111111';
        expect(
            MediaListingQuerySchema.parse({ libraryGroupId, tag: 'space', keyword: 'time' }),
        ).toMatchObject({ libraryGroupId, tag: 'space', keyword: 'time' });
        expect(MediaListingQuerySchema.safeParse({ library: libraryGroupId }).success).toBe(false);
    });
    it('keeps provider ordering groupId independent of libraryGroupId', () => {
        const groupId = 'tmdb-episode-ordering-group';
        expect(applyDef.request!.body!.parse({ provider: 'tmdb', groupId })).toMatchObject({
            groupId,
        });
        const response = OrderingInfoResponseSchema.parse({
            current: { orderingType: 'tmdb', orderingSource: 'manual', provider: 'tmdb', groupId },
            available: [],
            hasCachedOrderings: true,
        });
        expect(response.current.groupId).toBe(groupId);
        expect(response.current).not.toHaveProperty('libraryGroupId');
    });
});
