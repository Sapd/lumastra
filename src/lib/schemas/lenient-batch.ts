// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

/** Validate the envelope at mount time; leave record validation to the handler. */
export function lenientBatchBody<T extends z.ZodType, K extends string = 'items'>(
    recordSchema: T,
    { min, max, key = 'items' as K }: { min: number; max: number; key?: K },
): {
    runtime: z.ZodObject<Record<K, z.ZodArray<z.ZodUnknown>>>;
    docs: z.ZodObject<Record<K, z.ZodArray<T>>>;
} {
    return {
        runtime: z.object({
            [key]: z.array(z.unknown()).min(min).max(max),
        } as Record<K, z.ZodArray<z.ZodUnknown>>),
        docs: z.object({
            [key]: z.array(recordSchema).min(min).max(max),
        } as Record<K, z.ZodArray<T>>),
    };
}

export type BatchRecordResult<T> =
    | { index: number; ok: true; value: T }
    | { index: number; ok: false; issues: z.ZodIssue[] };

/** Keep every input's position, including invalid records, for partial-success responses. */
export function parseBatchRecords<T extends z.ZodType>(
    recordSchema: T,
    items: readonly unknown[],
): BatchRecordResult<z.output<T>>[] {
    return items.map((item, index): BatchRecordResult<z.output<T>> => {
        const result = recordSchema.safeParse(item);
        return result.success
            ? { index, ok: true, value: result.data }
            : { index, ok: false, issues: result.error.issues };
    });
}
