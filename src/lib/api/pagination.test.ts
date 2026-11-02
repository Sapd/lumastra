// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the client-facing pagination re-exports.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { PageBlockSchema, paginatedEnvelope } from './pagination';

describe('api/pagination re-exports', () => {
    it('re-exports the same PageBlockSchema as $lib/schemas/pagination', () => {
        expect(() =>
            PageBlockSchema.parse({ limit: 10, offset: 0, hasMore: false, total: 0 }),
        ).not.toThrow();
    });

    it('re-exports a working paginatedEnvelope() helper', () => {
        const schema = paginatedEnvelope(z.object({ id: z.string() }));
        const parsed = schema.parse({
            items: [{ id: 'a' }],
            page: { limit: 10, hasMore: false },
        });
        expect(parsed.items).toEqual([{ id: 'a' }]);
    });
});
