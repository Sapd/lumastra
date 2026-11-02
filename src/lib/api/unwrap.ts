// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * API Response Unwrapping Utilities
 *
 * Provides a clean way to handle ApiResult errors with automatic
 * logging, default values, and optional transformations.
 */

import type { z } from 'zod';
import type { ApiResult } from './types';

/**
 * Options for unwrapping API results
 */
export interface UnwrapOptions<T, R = T> {
    /** Value to return if the API call fails or returns no data */
    defaultValue: R;
    /** Optional callback for error handling (logging, metrics, etc.) */
    onError?: (error: string | z.ZodError) => void;
    /** Optional transform function to convert data to desired type */
    transform?: (data: T) => R;
}

/**
 * Unwraps an ApiResult, handling errors and providing a default value.
 *
 * This utility consolidates the common pattern of:
 * ```
 * const { data, error } = await apiGet(...);
 * if (error || !data) {
 *     logger.warn('Failed', { error });
 *     return defaultValue;
 * }
 * ```
 *
 * Into:
 * ```
 * const result = await unwrapApiResult(apiGet(...), {
 *     defaultValue: [],
 *     onError: (err) => logger.warn('Failed', { error: err })
 * });
 * ```
 *
 * @param promise - Promise returning an ApiResult
 * @param options - Configuration for error handling and transformation
 * @returns The unwrapped data (or transformed data), or the default value on error
 *
 * @example
 * // Simple usage with default value
 * const users = await unwrapApiResult(
 *     apiGet('/users', UsersSchema),
 *     { defaultValue: [] }
 * );
 *
 * @example
 * // With error logging
 * const users = await unwrapApiResult(
 *     apiGet('/users', UsersSchema),
 *     {
 *         defaultValue: [],
 *         onError: (err) => logger.warn('Failed to load users', { error: err })
 *     }
 * );
 *
 * @example
 * // With data transformation
 * const usernames = await unwrapApiResult(
 *     apiGet('/users', UsersSchema),
 *     {
 *         defaultValue: [],
 *         transform: (data) => data.users.map(u => u.username)
 *     }
 * );
 */
export async function unwrapApiResult<T, R = T>(
    promise: Promise<ApiResult<T>>,
    options: UnwrapOptions<T, R>,
): Promise<R> {
    const { defaultValue, onError, transform } = options;

    const result = await promise;

    // Check for errors (API error or validation error)
    if (result.error || result.validationError) {
        const errorValue = result.validationError || result.error;
        if (onError && errorValue) {
            onError(errorValue);
        }
        return defaultValue;
    }

    // Check for missing data
    if (!result.data) {
        if (onError) {
            onError('No data returned');
        }
        return defaultValue;
    }

    // Transform if needed, otherwise return data as-is
    if (transform) {
        return transform(result.data);
    }

    // TypeScript needs help understanding that R = T when no transform
    return result.data as unknown as R;
}
