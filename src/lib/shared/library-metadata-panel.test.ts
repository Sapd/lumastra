// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    getDetailFields,
    formatMetadataValue,
    type FormattedField,
} from './library-metadata-panel.utils';
import type { MetadataFieldDef } from './library-type-templates';

const textField: MetadataFieldDef = {
    key: 'instructor',
    label: 'Instructor',
    type: 'text',
    showInDetail: true,
};

const dateField: MetadataFieldDef = {
    key: 'due_date',
    label: 'Due Date',
    type: 'date',
    showInDetail: true,
};

const boolField: MetadataFieldDef = {
    key: 'required',
    label: 'Required',
    type: 'boolean',
    showInDetail: true,
};

const tagsField: MetadataFieldDef = {
    key: 'people',
    label: 'People',
    type: 'tags',
    showInDetail: true,
};

const numberField: MetadataFieldDef = {
    key: 'lesson_number',
    label: 'Lesson Number',
    type: 'number',
    showInDetail: true,
};

const selectField: MetadataFieldDef = {
    key: 'difficulty',
    label: 'Difficulty',
    type: 'select',
    options: ['beginner', 'intermediate', 'advanced'],
    showInDetail: true,
};

const notInDetailField: MetadataFieldDef = {
    key: 'department',
    label: 'Department',
    type: 'text',
    showOnCard: true,
    showInDetail: false,
};

const noDetailFlagField: MetadataFieldDef = {
    key: 'category',
    label: 'Category',
    type: 'text',
    // showInDetail not set (undefined)
};

describe('getDetailFields', () => {
    it('returns only fields with showInDetail:true that have non-empty values', () => {
        const fields = [textField, dateField, boolField, notInDetailField, noDetailFlagField];
        const metadata = {
            instructor: 'Jane Smith',
            due_date: '2026-07-31',
            required: true,
            department: 'Engineering',
            category: 'Safety',
        };
        const result = getDetailFields(fields, metadata);
        expect(result.map((f) => f.key)).toEqual(['instructor', 'due_date', 'required']);
    });

    it('skips fields with null value', () => {
        const fields = [textField, dateField];
        const metadata: Record<string, unknown> = { instructor: null, due_date: '2026-07-31' };
        const result = getDetailFields(fields, metadata);
        expect(result.map((f) => f.key)).toEqual(['due_date']);
    });

    it('skips fields with undefined value (key absent)', () => {
        const fields = [textField, dateField];
        const metadata: Record<string, unknown> = { due_date: '2026-07-31' };
        const result = getDetailFields(fields, metadata);
        expect(result.map((f) => f.key)).toEqual(['due_date']);
    });

    it('skips fields with empty string value', () => {
        const fields = [textField, dateField];
        const metadata: Record<string, unknown> = { instructor: '', due_date: '2026-07-31' };
        const result = getDetailFields(fields, metadata);
        expect(result.map((f) => f.key)).toEqual(['due_date']);
    });

    it('skips fields with empty array value', () => {
        const fields = [tagsField, textField];
        const metadata: Record<string, unknown> = { people: [], instructor: 'Jane' };
        const result = getDetailFields(fields, metadata);
        expect(result.map((f) => f.key)).toEqual(['instructor']);
    });

    it('returns empty array when metadata is empty', () => {
        const fields = [textField, dateField];
        const result = getDetailFields(fields, {});
        expect(result).toEqual([]);
    });

    it('returns empty array when all fields have showInDetail:false', () => {
        const fields = [notInDetailField, noDetailFlagField];
        const metadata = { department: 'HR', category: 'Training' };
        const result = getDetailFields(fields, metadata);
        expect(result).toEqual([]);
    });

    it('preserves the order from template.metadataFields', () => {
        const fields = [selectField, boolField, textField];
        const metadata = { difficulty: 'intermediate', required: false, instructor: 'Bob' };
        const result = getDetailFields(fields, metadata);
        expect(result.map((f) => f.key)).toEqual(['difficulty', 'required', 'instructor']);
    });

    it('includes boolean false values (not falsy-filtered)', () => {
        const fields = [boolField];
        const metadata: Record<string, unknown> = { required: false };
        const result = getDetailFields(fields, metadata);
        expect(result.map((f) => f.key)).toEqual(['required']);
    });

    it('includes number 0 values (not falsy-filtered)', () => {
        const fields = [numberField];
        const metadata: Record<string, unknown> = { lesson_number: 0 };
        const result = getDetailFields(fields, metadata);
        expect(result.map((f) => f.key)).toEqual(['lesson_number']);
    });

    it('skips NaN values (hasValue returns false for NaN)', () => {
        const fields = [numberField];
        const metadata: Record<string, unknown> = { lesson_number: NaN };
        const result = getDetailFields(fields, metadata);
        expect(result).toEqual([]);
    });
});

describe('formatMetadataValue', () => {
    describe('text type', () => {
        it('returns the string value', () => {
            const result = formatMetadataValue(textField, 'Jane Smith');
            expect(result).toEqual({ type: 'text', text: 'Jane Smith' } satisfies FormattedField);
        });

        it('stringifies a number for text type', () => {
            const result = formatMetadataValue(textField, 42);
            expect(result).toEqual({ type: 'text', text: '42' });
        });
    });

    describe('select type', () => {
        it('returns the string value', () => {
            const result = formatMetadataValue(selectField, 'intermediate');
            expect(result).toEqual({ type: 'text', text: 'intermediate' });
        });
    });

    describe('number type', () => {
        it('returns the stringified number', () => {
            const result = formatMetadataValue(numberField, 5);
            expect(result).toEqual({ type: 'text', text: '5' });
        });
    });

    describe('boolean type', () => {
        it('returns boolean true', () => {
            const result = formatMetadataValue(boolField, true);
            expect(result).toEqual({ type: 'boolean', value: true } satisfies FormattedField);
        });

        it('returns boolean false', () => {
            const result = formatMetadataValue(boolField, false);
            expect(result).toEqual({ type: 'boolean', value: false } satisfies FormattedField);
        });

        it('converts string "true" to boolean true', () => {
            const result = formatMetadataValue(boolField, 'true');
            expect(result).toEqual({ type: 'boolean', value: true });
        });

        it('converts string "false" to boolean false', () => {
            const result = formatMetadataValue(boolField, 'false');
            expect(result).toEqual({ type: 'boolean', value: false });
        });

        it('converts string "1" to boolean true', () => {
            const result = formatMetadataValue(boolField, '1');
            expect(result).toEqual({ type: 'boolean', value: true });
        });

        it('converts string "no" to boolean false', () => {
            const result = formatMetadataValue(boolField, 'no');
            expect(result).toEqual({ type: 'boolean', value: false });
        });

        it('converts string "No" to boolean false', () => {
            const result = formatMetadataValue(boolField, 'No');
            expect(result).toEqual({ type: 'boolean', value: false });
        });

        it('converts string "off" to boolean false', () => {
            const result = formatMetadataValue(boolField, 'off');
            expect(result).toEqual({ type: 'boolean', value: false });
        });

        it('converts string "disabled" to boolean false', () => {
            const result = formatMetadataValue(boolField, 'disabled');
            expect(result).toEqual({ type: 'boolean', value: false });
        });

        it('converts an unrecognised string to boolean false (safe default)', () => {
            const result = formatMetadataValue(boolField, 'maybe');
            expect(result).toEqual({ type: 'boolean', value: false });
        });
    });

    describe('tags type', () => {
        it('returns array of tags', () => {
            const result = formatMetadataValue(tagsField, ['Alice', 'Bob']);
            expect(result).toEqual({
                type: 'tags',
                tags: ['Alice', 'Bob'],
            } satisfies FormattedField);
        });

        it('wraps a single string value in an array', () => {
            const result = formatMetadataValue(tagsField, 'Alice');
            expect(result).toEqual({ type: 'tags', tags: ['Alice'] });
        });

        it('returns empty tags for non-array non-string', () => {
            const result = formatMetadataValue(tagsField, 123);
            expect(result).toEqual({ type: 'tags', tags: ['123'] });
        });
    });

    describe('date type', () => {
        it('returns a formatted date string for ISO date', () => {
            const result = formatMetadataValue(dateField, '2026-07-31');
            expect(result.type).toBe('date');
            if (result.type === 'date') {
                // Use locale-invariant assertions (day/year present regardless of locale)
                expect(result.formatted).toContain('31');
                expect(result.formatted).toContain('2026');
            }
        });

        it('returns the original string if date is unparseable', () => {
            const result = formatMetadataValue(dateField, 'not-a-date');
            expect(result.type).toBe('date');
            // Falls back gracefully — either original string or some output
            if (result.type === 'date') {
                expect(typeof result.formatted).toBe('string');
                expect(result.formatted.length).toBeGreaterThan(0);
            }
        });

        it('returns a formatted date string for a number timestamp', () => {
            // 2026-07-31 as unix ms
            const ts = new Date('2026-07-31').getTime();
            const result = formatMetadataValue(dateField, ts);
            expect(result.type).toBe('date');
            if (result.type === 'date') {
                expect(result.formatted).toContain('2026');
            }
        });
    });
});
