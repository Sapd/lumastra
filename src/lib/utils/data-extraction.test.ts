// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for data-extraction utilities
 *
 * Tests edge cases for null, undefined, wrong-type inputs.
 */

import { describe, it, expect } from 'vitest';
import { isRecord, toString, toNumberOr, parseInteger, extractBody } from './data-extraction';

describe('isRecord', () => {
    it('returns true for plain objects', () => {
        expect(isRecord({})).toBe(true);
        expect(isRecord({ a: 1 })).toBe(true);
    });

    it('returns false for null', () => {
        expect(isRecord(null)).toBe(false);
    });

    it('returns false for undefined', () => {
        expect(isRecord(undefined)).toBe(false);
    });

    it('returns true for arrays (arrays are objects in JS)', () => {
        // Note: isRecord uses typeof === 'object' && !== null
        // Arrays pass this check — callers should use isArrayOf for stricter checks
        expect(isRecord([])).toBe(true);
        expect(isRecord([1, 2])).toBe(true);
    });

    it('returns false for primitives', () => {
        expect(isRecord('hello')).toBe(false);
        expect(isRecord(42)).toBe(false);
        expect(isRecord(true)).toBe(false);
    });
});

describe('toString', () => {
    it('returns the string for string input', () => {
        expect(toString('hello')).toBe('hello');
    });

    it('returns undefined for null', () => {
        expect(toString(null)).toBeUndefined();
    });

    it('returns undefined for undefined', () => {
        expect(toString(undefined)).toBeUndefined();
    });

    it('returns undefined for number', () => {
        expect(toString(42)).toBeUndefined();
    });

    it('returns undefined for boolean', () => {
        expect(toString(true)).toBeUndefined();
    });

    it('returns undefined for object', () => {
        expect(toString({})).toBeUndefined();
    });
});

describe('toNumberOr', () => {
    it('returns the number for finite number input', () => {
        expect(toNumberOr(42, 0)).toBe(42);
    });

    it('returns fallback for null', () => {
        expect(toNumberOr(null, 99)).toBe(99);
    });

    it('returns fallback for undefined', () => {
        expect(toNumberOr(undefined, 99)).toBe(99);
    });

    it('returns fallback for NaN', () => {
        expect(toNumberOr(NaN, 99)).toBe(99);
    });

    it('returns fallback for Infinity', () => {
        expect(toNumberOr(Infinity, 99)).toBe(99);
    });

    it('returns fallback for string', () => {
        expect(toNumberOr('42', 99)).toBe(99);
    });

    it('returns fallback for object', () => {
        expect(toNumberOr({}, 99)).toBe(99);
    });
});

describe('parseInteger', () => {
    it('returns integer for number input', () => {
        expect(parseInteger(42)).toBe(42);
    });

    it('returns integer from numeric string', () => {
        expect(parseInteger('42')).toBe(42);
    });

    it('returns undefined for null', () => {
        expect(parseInteger(null)).toBeUndefined();
    });

    it('returns undefined for undefined', () => {
        expect(parseInteger(undefined)).toBeUndefined();
    });

    it('returns undefined for non-numeric string', () => {
        expect(parseInteger('not-a-number')).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
        expect(parseInteger('')).toBeUndefined();
    });

    it('returns undefined for float string', () => {
        // parseInt('3.14', 10) is 3, which is finite
        expect(parseInteger('3.14')).toBe(3);
    });

    it('returns undefined for NaN', () => {
        expect(parseInteger(NaN)).toBeUndefined();
    });

    it('returns undefined for Infinity', () => {
        expect(parseInteger(Infinity)).toBeUndefined();
    });

    it('returns undefined for float number', () => {
        // Number.isInteger(3.14) is false
        expect(parseInteger(3.14)).toBeUndefined();
    });
});

describe('extractBody', () => {
    it('returns parsed JSON object', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            body: JSON.stringify({ name: 'test' }),
        });
        const body = await extractBody(request);
        expect(body).toEqual({ name: 'test' });
    });

    it('returns empty object for invalid JSON', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            body: 'not-json',
        });
        const body = await extractBody(request);
        expect(body).toEqual({});
    });

    it('returns empty object for non-JSON body', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            body: new FormData(),
        });
        const body = await extractBody(request);
        expect(body).toEqual({});
    });

    it('returns array for array JSON (arrays are objects in JS)', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            body: JSON.stringify([1, 2, 3]),
        });
        const body = await extractBody(request);
        expect(body).toEqual([1, 2, 3]);
    });

    it('returns empty object for null JSON', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            body: 'null',
        });
        const body = await extractBody(request);
        expect(body).toEqual({});
    });

    it('returns empty object for primitive JSON', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            body: '"string"',
        });
        const body = await extractBody(request);
        expect(body).toEqual({});
    });

    it('returns empty object for empty request body', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            body: '',
        });
        const body = await extractBody(request);
        expect(body).toEqual({});
    });
});
