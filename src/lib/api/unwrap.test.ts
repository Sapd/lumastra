// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for API Result Unwrapping Utilities
 */

import { describe, it, expect, vi } from 'vitest';
import { unwrapApiResult } from './unwrap';
import type { ApiResult } from './types';
import { z } from 'zod';

describe('unwrapApiResult', () => {
    it('returns data when API call succeeds', async () => {
        const result: ApiResult<string> = {
            data: 'success',
            error: null,
            status: 200,
        };

        const unwrapped = await unwrapApiResult(Promise.resolve(result), {
            defaultValue: 'default',
        });

        expect(unwrapped).toBe('success');
    });

    it('returns default value when error is present', async () => {
        const result: ApiResult<string> = {
            data: null,
            error: 'Network error',
            status: 500,
        };

        const unwrapped = await unwrapApiResult(Promise.resolve(result), {
            defaultValue: 'default',
        });

        expect(unwrapped).toBe('default');
    });

    it('returns default value when data is null', async () => {
        const result: ApiResult<string> = {
            data: null,
            error: null,
            status: 200,
        };

        const unwrapped = await unwrapApiResult(Promise.resolve(result), {
            defaultValue: 'default',
        });

        expect(unwrapped).toBe('default');
    });

    it('returns default value when validation error is present', async () => {
        const schema = z.object({ value: z.string() });
        const validationError = schema.safeParse({ value: 123 });

        const result: ApiResult<{ value: string }> = {
            data: null,
            error: null,
            validationError: validationError.error,
            status: 200,
        };

        const unwrapped = await unwrapApiResult(Promise.resolve(result), {
            defaultValue: { value: 'default' },
        });

        expect(unwrapped).toEqual({ value: 'default' });
    });

    it('calls onError callback with error string', async () => {
        const onError = vi.fn();
        const result: ApiResult<string> = {
            data: null,
            error: 'API error',
            status: 500,
        };

        await unwrapApiResult(Promise.resolve(result), {
            defaultValue: 'default',
            onError,
        });

        expect(onError).toHaveBeenCalledWith('API error');
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it('calls onError callback with validation error', async () => {
        const onError = vi.fn();
        const schema = z.object({ value: z.string() });
        const validationError = schema.safeParse({ value: 123 });

        const result: ApiResult<{ value: string }> = {
            data: null,
            error: null,
            validationError: validationError.error,
            status: 200,
        };

        await unwrapApiResult(Promise.resolve(result), {
            defaultValue: { value: 'default' },
            onError,
        });

        expect(onError).toHaveBeenCalledWith(validationError.error);
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it('calls onError when data is null', async () => {
        const onError = vi.fn();
        const result: ApiResult<string> = {
            data: null,
            error: null,
            status: 200,
        };

        await unwrapApiResult(Promise.resolve(result), {
            defaultValue: 'default',
            onError,
        });

        expect(onError).toHaveBeenCalledWith('No data returned');
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it('does not call onError when data is present', async () => {
        const onError = vi.fn();
        const result: ApiResult<string> = {
            data: 'success',
            error: null,
            status: 200,
        };

        await unwrapApiResult(Promise.resolve(result), {
            defaultValue: 'default',
            onError,
        });

        expect(onError).not.toHaveBeenCalled();
    });

    it('applies transform function to successful data', async () => {
        const result: ApiResult<{ value: number }> = {
            data: { value: 42 },
            error: null,
            status: 200,
        };

        const unwrapped = await unwrapApiResult(Promise.resolve(result), {
            defaultValue: 0,
            transform: (data) => data.value * 2,
        });

        expect(unwrapped).toBe(84);
    });

    it('does not call transform on error', async () => {
        const transform = vi.fn((data: { value: number }) => data.value * 2);
        const result: ApiResult<{ value: number }> = {
            data: null,
            error: 'Error',
            status: 500,
        };

        const unwrapped = await unwrapApiResult(Promise.resolve(result), {
            defaultValue: 0,
            transform,
        });

        expect(unwrapped).toBe(0);
        expect(transform).not.toHaveBeenCalled();
    });

    it('handles complex transformations', async () => {
        interface ApiData {
            users: Array<{ username: string; id: string }>;
        }

        const result: ApiResult<ApiData> = {
            data: {
                users: [
                    { username: 'alice', id: '1' },
                    { username: 'bob', id: '2' },
                ],
            },
            error: null,
            status: 200,
        };

        const usernames = await unwrapApiResult(Promise.resolve(result), {
            defaultValue: [],
            transform: (data) => data.users.map((u) => u.username),
        });

        expect(usernames).toEqual(['alice', 'bob']);
    });

    it('prioritizes validationError over error string', async () => {
        const onError = vi.fn();
        const schema = z.object({ value: z.string() });
        const validationError = schema.safeParse({ value: 123 });

        const result: ApiResult<{ value: string }> = {
            data: null,
            error: 'API error',
            validationError: validationError.error,
            status: 500,
        };

        await unwrapApiResult(Promise.resolve(result), {
            defaultValue: { value: 'default' },
            onError,
        });

        // Should call with validation error, not the string error
        expect(onError).toHaveBeenCalledWith(validationError.error);
        expect(onError).not.toHaveBeenCalledWith('API error');
    });

    it('handles empty arrays as default values', async () => {
        const result: ApiResult<string[]> = {
            data: null,
            error: 'Error',
            status: 500,
        };

        const unwrapped = await unwrapApiResult(Promise.resolve(result), {
            defaultValue: [],
        });

        expect(unwrapped).toEqual([]);
        expect(Array.isArray(unwrapped)).toBe(true);
    });

    it('handles empty objects as default values', async () => {
        const result: ApiResult<Record<string, unknown>> = {
            data: null,
            error: 'Error',
            status: 500,
        };

        const unwrapped = await unwrapApiResult(Promise.resolve(result), {
            defaultValue: {},
        });

        expect(unwrapped).toEqual({});
        expect(typeof unwrapped).toBe('object');
    });
});
