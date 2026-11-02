// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Error Handling Utilities
 *
 * Provides consistent error message extraction and formatting across the application.
 */

/**
 * Extract a user-friendly error message from an unknown error type.
 *
 * @param error - The caught error (unknown type from catch block)
 * @param fallback - Fallback message if error cannot be extracted
 * @returns User-friendly error message string
 *
 * @example
 * ```typescript
 * try {
 *     await riskyOperation();
 * } catch (error) {
 *     console.error('Operation failed:', error);
 *     toasts.error(getErrorMessage(error, 'Failed to complete operation'));
 * }
 * ```
 */
export function getErrorMessage(error: unknown, fallback: string): string {
    // Error instance - use message property
    if (error instanceof Error) {
        return error.message || fallback;
    }

    // String error
    if (typeof error === 'string') {
        return error || fallback;
    }

    // Object with message property (API error responses)
    if (
        error &&
        typeof error === 'object' &&
        'message' in error &&
        typeof error.message === 'string'
    ) {
        return error.message || fallback;
    }

    // Unknown error type - use fallback
    return fallback;
}

/**
 * Format an error for logging purposes (includes stack trace if available).
 *
 * @param error - The caught error
 * @returns Formatted error object for logging
 *
 * @example
 * ```typescript
 * catch (error) {
 *     console.error('Failed to load data:', formatErrorForLogging(error));
 * }
 * ```
 */
export function formatErrorForLogging(error: unknown): {
    message: string;
    stack?: string;
    raw?: unknown;
} {
    if (error instanceof Error) {
        return {
            message: error.message,
            stack: error.stack,
            raw: error,
        };
    }

    return {
        message: String(error),
        raw: error,
    };
}
