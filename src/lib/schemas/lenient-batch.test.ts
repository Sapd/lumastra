// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { lenientBatchBody, parseBatchRecords } from './lenient-batch.js';

const record = z.object({ id: z.string().uuid(), count: z.number().int() });
const valid = { id: '00000000-0000-4000-8000-000000000001', count: 2 };

describe('lenientBatchBody', () => {
    const { runtime, docs } = lenientBatchBody(record, { min: 1, max: 3 });

    it('accepts bad records at runtime while retaining a typed docs schema', () => {
        const items = [valid, null, { id: 'invalid' }];
        expect(runtime.parse({ items })).toEqual({ items });
        expect(docs.safeParse({ items }).success).toBe(false);
        expect(docs.parse({ items: [valid] })).toEqual({ items: [valid] });
        expectTypeOf<z.output<typeof docs>>().toEqualTypeOf<{
            items: { id: string; count: number }[];
        }>();
        const jsonSchema = z.toJSONSchema(docs);
        expect(jsonSchema.properties?.items).toMatchObject({
            minItems: 1,
            maxItems: 3,
            items: { type: 'object', required: ['id', 'count'] },
        });
    });

    it.each([null, {}, { items: null }, { items: 'bad' }, { items: [] }, { items: [1, 2, 3, 4] }])(
        'rejects a malformed or out-of-bounds envelope: %j',
        (body) => {
            expect(runtime.safeParse(body).success).toBe(false);
            expect(docs.safeParse(body).success).toBe(false);
        },
    );

    it('supports a custom envelope key with the same bounds', () => {
        const batch = lenientBatchBody(record, { key: 'sessions', min: 0, max: 1 });
        expect(batch.runtime.parse({ sessions: [false] })).toEqual({ sessions: [false] });
        expect(batch.docs.parse({ sessions: [valid] })).toEqual({ sessions: [valid] });
        expect(batch.runtime.parse({ sessions: [] })).toEqual({ sessions: [] });
        expect(batch.runtime.safeParse({ items: [valid] }).success).toBe(false);
        expect(batch.runtime.safeParse({ sessions: [valid, valid] }).success).toBe(false);
        expectTypeOf<z.output<typeof batch.runtime>>().toEqualTypeOf<{ sessions: unknown[] }>();
    });
});

describe('parseBatchRecords', () => {
    it('preserves input indexes and field issues across partial failures', () => {
        const results = parseBatchRecords(record, [valid, { ...valid, count: 'bad' }, null, valid]);
        expect(results[0]).toEqual({ index: 0, ok: true, value: valid });
        expect(results[1]).toMatchObject({
            index: 1,
            ok: false,
            issues: [{ path: ['count'], code: 'invalid_type' }],
        });
        expect(results[2]).toMatchObject({ index: 2, ok: false });
        expect(results[3]).toEqual({ index: 3, ok: true, value: valid });
    });

    it('returns parsed defaults and transforms, with inferred output types', () => {
        const transformed = z.object({ count: z.coerce.number().default(1) });
        const results = parseBatchRecords(transformed, [{}, { count: '3' }]);
        expect(results).toEqual([
            { index: 0, ok: true, value: { count: 1 } },
            { index: 1, ok: true, value: { count: 3 } },
        ]);
        const first = results[0];
        if (first.ok) expectTypeOf(first.value).toEqualTypeOf<{ count: number }>();
        expect(parseBatchRecords(record, [])).toEqual([]);
    });
});
