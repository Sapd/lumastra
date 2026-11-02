// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { CuratedListsResponseSchema } from '$lib/server/api/defs/lists/index.js';

describe('CuratedListsResponseSchema — GET /api/v1/lists contract parity', () => {
    it('accepts and preserves cached (emitted by the cache-hit path in defs/lists/index.ts but previously undeclared)', () => {
        const result = CuratedListsResponseSchema.safeParse({
            items: [],
            page: { limit: 0, offset: 0, hasMore: false },
            syncing: false,
            cached: true,
        });

        expect(result.success).toBe(true);
        // Zod strips undeclared keys silently on a bare z.object(), so `success`
        // alone doesn't prove the field is part of the schema — assert it
        // survives parsing (i.e. the schema declares it, not merely tolerates it).
        expect(result.data?.cached).toBe(true);
    });

    it('still validates without cached (non-cache-hit path omits the field)', () => {
        const result = CuratedListsResponseSchema.safeParse({
            items: [],
            page: { limit: 0, offset: 0, hasMore: false },
            syncing: true,
        });

        expect(result.success).toBe(true);
        expect(result.data?.cached).toBeUndefined();
    });
});
