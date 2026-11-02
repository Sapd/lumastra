// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

/** A typed batch's docs may refine records, while preserving its runtime envelope exactly. */
export function isLenientBatchDocs(runtime: z.ZodType, docs: z.ZodType): boolean {
    try {
        const input = z.toJSONSchema(runtime, { io: 'input', unrepresentable: 'any' });
        const documented = z.toJSONSchema(docs, { io: 'input', unrepresentable: 'any' });
        if (input.type !== 'object' || documented.type !== 'object') return false;
        const keys = Object.keys(input.properties ?? {});
        if (
            keys.length !== 1 ||
            JSON.stringify(keys) !== JSON.stringify(Object.keys(documented.properties ?? {}))
        )
            return false;
        const key = keys[0];
        const untyped = input.properties?.[key];
        const typed = documented.properties?.[key];
        if (!untyped || !typed || typeof untyped === 'boolean' || typeof typed === 'boolean')
            return false;
        if (untyped.type !== 'array' || typed.type !== 'array') return false;
        if (JSON.stringify(untyped.items) !== '{}') return false;
        const rawRecord = typed.items;
        if (!rawRecord || Array.isArray(rawRecord) || typeof rawRecord === 'boolean') return false;
        const record = rawRecord.$ref?.startsWith('#/$defs/')
            ? documented.$defs?.[rawRecord.$ref.slice('#/$defs/'.length)]
            : rawRecord;
        if (
            !record ||
            Array.isArray(record) ||
            typeof record === 'boolean' ||
            record.type !== 'object'
        )
            return false;
        // Remove ONLY the record's schema. Bounds, required fields and every other
        // envelope constraint must remain identical, so this cannot hide runtime drift.
        const eraseRecord = (schema: typeof input, array: typeof untyped): string => {
            const { $schema: _dialect, $defs: _records, ...envelope } = schema;
            return JSON.stringify({ ...envelope, properties: { [key]: { ...array, items: {} } } });
        };
        return eraseRecord(input, untyped) === eraseRecord(documented, typed);
    } catch {
        return false;
    }
}
