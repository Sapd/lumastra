// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { MetadataFieldDef } from './library-type-templates';

// ---------------------------------------------------------------------------
// Formatted field discriminated union
// ---------------------------------------------------------------------------

export type FormattedField =
    | { type: 'text'; text: string }
    | { type: 'boolean'; value: boolean }
    | { type: 'tags'; tags: string[] }
    | { type: 'date'; formatted: string };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** A metadata field definition enriched with its raw key for lookup. */
export interface DetailField {
    key: string;
    label: string;
    fieldType: MetadataFieldDef['type'];
    formatted: FormattedField;
}

/**
 * Return only those fields from `fields` that:
 *   1. Have `showInDetail: true`
 *   2. Have a non-empty value in `metadata`
 *
 * Fields are returned in the same order as they appear in `fields`.
 *
 * "Non-empty" means not null, undefined, "" (empty string), or [] (empty array).
 * Boolean `false` and number `0` ARE included (they are meaningful values).
 */
export function getDetailFields(
    fields: MetadataFieldDef[],
    metadata: Record<string, unknown>,
): DetailField[] {
    const result: DetailField[] = [];
    for (const field of fields) {
        if (!field.showInDetail) continue;
        const raw = metadata[field.key];
        if (!hasValue(raw)) continue;
        result.push({
            key: field.key,
            label: field.label,
            fieldType: field.type,
            formatted: formatMetadataValue(field, raw),
        });
    }
    return result;
}

/**
 * Format a raw metadata value according to its field type.
 *
 * The caller must already have verified that `value` is non-empty before
 * calling this function.
 */
export function formatMetadataValue(field: MetadataFieldDef, value: unknown): FormattedField {
    switch (field.type) {
        case 'boolean':
            return { type: 'boolean', value: coerceBool(value) };

        case 'tags':
            return { type: 'tags', tags: coerceTags(value) };

        case 'date':
            return { type: 'date', formatted: formatDate(value) };

        // text, select, number → plain string
        default:
            return { type: 'text', text: String(value) };
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function hasValue(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (value === '') return false;
    if (Array.isArray(value) && value.length === 0) return false;
    if (typeof value === 'number' && isNaN(value)) return false;
    return true;
}

/** Explicit allowlist for truthy strings; everything else defaults to false. */
const BOOL_TRUE_STRINGS = new Set(['true', '1', 'yes', 'on', 'enabled']);

function coerceBool(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') return BOOL_TRUE_STRINGS.has(value.toLowerCase());
    return false;
}

function coerceTags(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String);
    return [String(value)];
}

function formatDate(value: unknown): string {
    let date: Date;
    if (typeof value === 'number') {
        date = new Date(value);
    } else if (typeof value === 'string') {
        // Handle YYYY-MM-DD by appending T00:00:00 to avoid UTC midnight → day-before-local
        const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value;
        date = new Date(iso);
    } else {
        return String(value);
    }
    if (isNaN(date.getTime())) return String(value);
    try {
        return new Intl.DateTimeFormat(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        }).format(date);
    } catch {
        return String(value);
    }
}
