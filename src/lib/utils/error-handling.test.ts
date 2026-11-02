// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for error-handling utilities
 *
 * Tests getErrorMessage and formatErrorForLogging edge cases.
 */

import { describe, it, expect } from 'vitest';
import { getErrorMessage, formatErrorForLogging } from './error-handling';

const FALLBACK = 'Something went wrong';

describe('getErrorMessage', () => {
    it('returns Error instance message', () => {
        expect(getErrorMessage(new Error('boom'), FALLBACK)).toBe('boom');
    });

    it('returns fallback for Error instance with empty message', () => {
        expect(getErrorMessage(new Error(''), FALLBACK)).toBe(FALLBACK);
    });

    it('returns string error', () => {
        expect(getErrorMessage('string error', FALLBACK)).toBe('string error');
    });

    it('returns fallback for empty string', () => {
        expect(getErrorMessage('', FALLBACK)).toBe(FALLBACK);
    });

    it('returns object message property', () => {
        expect(getErrorMessage({ message: 'obj error' }, FALLBACK)).toBe('obj error');
    });

    it('returns fallback for object without message property', () => {
        expect(getErrorMessage({ foo: 'bar' }, FALLBACK)).toBe(FALLBACK);
    });

    it('returns fallback for null', () => {
        expect(getErrorMessage(null, FALLBACK)).toBe(FALLBACK);
    });

    it('returns fallback for undefined', () => {
        expect(getErrorMessage(undefined, FALLBACK)).toBe(FALLBACK);
    });

    it('returns fallback for number', () => {
        expect(getErrorMessage(42, FALLBACK)).toBe(FALLBACK);
    });

    it('returns fallback for boolean', () => {
        expect(getErrorMessage(false, FALLBACK)).toBe(FALLBACK);
    });

    it('returns fallback for object with non-string message', () => {
        expect(getErrorMessage({ message: 123 }, FALLBACK)).toBe(FALLBACK);
    });
});

describe('formatErrorForLogging', () => {
    it('returns message, stack, and raw for Error instance', () => {
        const error = new Error('logged error');
        const result = formatErrorForLogging(error);
        expect(result.message).toBe('logged error');
        expect(result.stack).toBeDefined();
        expect(result.raw).toBe(error);
    });

    it('returns message and raw for string', () => {
        const result = formatErrorForLogging('string error');
        expect(result.message).toBe('string error');
        expect(result.raw).toBe('string error');
        expect(result.stack).toBeUndefined();
    });

    it('returns message and raw for null', () => {
        const result = formatErrorForLogging(null);
        expect(result.message).toBe('null');
        expect(result.raw).toBeNull();
        expect(result.stack).toBeUndefined();
    });

    it('returns message and raw for undefined', () => {
        const result = formatErrorForLogging(undefined);
        expect(result.message).toBe('undefined');
        expect(result.raw).toBeUndefined();
        expect(result.stack).toBeUndefined();
    });

    it('returns message and raw for object', () => {
        const obj = { foo: 'bar' };
        const result = formatErrorForLogging(obj);
        expect(result.message).toBe('[object Object]');
        expect(result.raw).toBe(obj);
        expect(result.stack).toBeUndefined();
    });
});
