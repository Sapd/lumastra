// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { paginate } from '$lib/server/api/problem.js';
import { PageBlockSchema, paginatedEnvelope } from './pagination';

describe('PageBlockSchema', () => {
    it('accepts the offset-based page block produced by the server paginate() helper', () => {
        const { page } = paginate([], { limit: 20, offset: 0, hasMore: false, total: 0 });
        expect(() => PageBlockSchema.parse(page)).not.toThrow();
    });

    it('accepts a cursor-based page block with no offset/total', () => {
        const { page } = paginate(['a'], { limit: 10, nextCursor: 'abc', hasMore: true });
        expect(() => PageBlockSchema.parse(page)).not.toThrow();
    });

    it('rejects a block missing the required hasMore field', () => {
        expect(() => PageBlockSchema.parse({ limit: 10 })).toThrow();
    });
});

describe('paginatedEnvelope', () => {
    const ItemSchema = z.object({ id: z.string() });

    it('builds a schema validating the {items, page} envelope', () => {
        const schema = paginatedEnvelope(ItemSchema);
        const { items, page } = paginate([{ id: '1' }], { limit: 10, offset: 0, hasMore: false });
        const parsed = schema.parse({ items, page });
        expect(parsed.items).toHaveLength(1);
        expect(parsed.page.hasMore).toBe(false);
    });

    it('rejects an envelope whose items violate the item schema', () => {
        const schema = paginatedEnvelope(ItemSchema);
        expect(() =>
            schema.parse({ items: [{ id: 1 }], page: { limit: 10, hasMore: false } }),
        ).toThrow();
    });
});
