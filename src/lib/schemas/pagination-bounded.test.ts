// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { boundedListEnvelope, paginatedEnvelope } from './pagination.js';

describe('boundedListEnvelope', () => {
    const schema = boundedListEnvelope(z.object({ id: z.string() }));
    it.each([true, false])('retains explicit truncation %s', (truncated) => {
        const value = { items: [{ id: 'one' }], truncated };
        expect(schema.parse(value)).toEqual(value);
        expect(schema.parse({ items: [], truncated }).items).toEqual([]);
    });
    it.each([{ items: [] }, { items: [], truncated: 'false' },
        { items: [{ id: 1 }], truncated: false }])('rejects malformed envelopes %j', (value) => {
        expect(schema.safeParse(value).success).toBe(false);
    });
    it('keeps the existing paginated envelope available', () => {
        expect(paginatedEnvelope(z.string()).parse({ items: [], page: { limit: 10, hasMore: false } }))
            .toEqual({ items: [], page: { limit: 10, hasMore: false } });
    });
});
