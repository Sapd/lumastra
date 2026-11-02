// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { lenientBatchBody } from '../../src/lib/schemas/lenient-batch.js';
import { isLenientBatchDocs } from './lenient-batch.js';

const record = z
    .object({ eventId: z.string().uuid(), positionMs: z.number().int().nonnegative() })
    .meta({ id: 'OfflineRecordReconciliationTest' });
describe('lenient batch documentation reconciliation', () => {
    it('retains typed records for an identical runtime envelope', () => {
        const batch = lenientBatchBody(record, { key: 'sessions', min: 1, max: 50 });
        expect(isLenientBatchDocs(batch.runtime, batch.docs)).toBe(true);
        expect(batch.runtime.safeParse({ sessions: [null] }).success).toBe(true);
        expect(batch.docs.safeParse({ sessions: [null] }).success).toBe(false);
    });
    it('does not conceal different batch bounds, keys or required fields', () => {
        const batch = lenientBatchBody(record, { key: 'sessions', min: 1, max: 50 });
        expect(
            isLenientBatchDocs(
                batch.runtime,
                z.object({ sessions: z.array(record).min(1).max(51) }),
            ),
        ).toBe(false);
        expect(
            isLenientBatchDocs(
                batch.runtime,
                z.object({ sessions: z.array(record).min(1).max(50).optional() }),
            ),
        ).toBe(false);
        expect(
            isLenientBatchDocs(batch.runtime, z.object({ items: z.array(record).min(1).max(50) })),
        ).toBe(false);
        expect(
            isLenientBatchDocs(
                batch.runtime,
                z.object({ sessions: z.array(record).min(1).max(50), extra: z.string() }),
            ),
        ).toBe(false);
    });
    it('does not override a runtime schema which validates records', () => {
        const strict = z.object({ sessions: z.array(record).min(1).max(50) });
        expect(isLenientBatchDocs(strict, strict)).toBe(false);
    });
});
