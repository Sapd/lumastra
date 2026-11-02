// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Error Handler Middleware for API Endpoints
 *
 * Provides automatic error handling, logging, and consistent error responses.
 * Eliminates repetitive try/catch patterns across API endpoints.
 *
 * @example
 * // Basic usage
 * export const GET = withErrorHandler(async ({ params, locals }) => {
 *     const data = await fetchData(params.id);
 *     return json(data);
 * });
 *
 * @example
 * // With custom error message
 * export const POST = withErrorHandler(
 *     async ({ request }) => {
 *         const data = await processRequest(request);
 *         return json(data);
 *     },
 *     { errorMessage: 'Failed to process request' }
 * );
 *
 * @example
 * // Combined with other middleware
 * export const GET = requireAuth(
 *     withErrorHandler(async ({ locals }) => {
 *         return json({ user: locals.user });
 *     })
 * );
 */

import {
    AuthDependencyUnavailableError,
    authUnavailableResponse,
} from '$lib/server/auth/dependency-unavailable.js';

import type { RequestEvent } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { ApiResponses, getEndpointName } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isPayloadTooLargeError } from '$lib/server/utils/bounded-body-reader';

const logger = Logger.for('ErrorHandler');

/**
 * Options for error handler middleware
 */
export interface ErrorHandlerOptions {
    /**
     * Custom error message to return to client.
     * Defaults to 'An unexpected error occurred'
     */
    errorMessage?: string;

    /**
     * HTTP status code for errors.
     * Defaults to 500
     */
    statusCode?: number;

    /**
     * Additional context to include in logs.
     * Merged with request context.
     */
    logContext?: Record<string, unknown>;

    /**
     * Custom logger name for this endpoint.
     * Defaults to 'ErrorHandler'
     */
    loggerName?: string;

    /**
     * Whether to include error details in response.
     * Defaults to true in development, false in production.
     */
    includeErrorDetails?: boolean;
}

/**
 * Known error types that should return specific status codes
 */
interface KnownError extends Error {
    code?: string;
    statusCode?: number;
}

/**
 * Determine the appropriate status code for an error
 */
function getStatusCodeForError(error: unknown): number {
    if (error instanceof Error) {
        const knownError = error as KnownError;

        // Check for explicit status code
        if (knownError.statusCode) {
            return knownError.statusCode;
        }

        // adapter-node's BODY_SIZE_LIMIT rejects `request.formData()`/`.json()`
        // with a SvelteKitError that carries `status`, not `statusCode`.
        if (isPayloadTooLargeError(error)) return 413;

        // Check for common error codes
        if (knownError.code) {
            switch (knownError.code) {
                case 'UNAUTHORIZED':
                    return 401;
                case 'FORBIDDEN':
                    return 403;
                case 'NOT_FOUND':
                    return 404;
                case 'CONFLICT':
                    return 409;
                case 'VALIDATION_ERROR':
                case 'BAD_REQUEST':
                    return 400;
                case 'RATE_LIMITED':
                    return 429;
            }
        }

        // Check for common error message patterns
        const message = error.message.toLowerCase();
        if (message.includes('not found')) return 404;
        if (message.includes('unauthorized')) return 401;
        if (message.includes('forbidden')) return 403;
        if (message.includes('invalid') || message.includes('validation')) return 400;
    }

    return 500;
}

/**
 * Wrap an API handler with automatic error handling.
 *
 * Catches all errors, logs them with context, and returns
 * a consistent error response using ApiResponses.
 *
 * @param handler - The request handler to wrap
 * @param options - Configuration options
 * @returns Wrapped handler with error handling
 */
export function withErrorHandler<
    Params extends Partial<Record<string, string>> = Partial<Record<string, string>>,
>(
    handler: (event: RequestEvent<Params>) => Response | Promise<Response>,
    options: ErrorHandlerOptions = {},
): (event: RequestEvent<Params>) => Promise<Response> {
    const {
        errorMessage = 'An unexpected error occurred',
        statusCode: defaultStatusCode = 500,
        logContext = {},
        loggerName,
        includeErrorDetails = dev,
    } = options;

    const endpointLogger = loggerName ? Logger.for(loggerName) : logger;

    return async (event: RequestEvent<Params>): Promise<Response> => {
        const endpoint = getEndpointName(event);

        try {
            return await handler(event);
        } catch (error) {
            if (error instanceof AuthDependencyUnavailableError) return authUnavailableResponse();
            const statusCode =
                error instanceof Error ? getStatusCodeForError(error) : defaultStatusCode;

            // Build log context
            const context = {
                endpoint,
                method: event.request.method,
                user: event.locals.user?.username,
                ...logContext,
            };

            // Log the error
            if (statusCode >= 500) {
                endpointLogger.error(errorMessage, error as Error, context);
            } else {
                // Also log the error for warnings (4xx) to show what went wrong
                endpointLogger.warn(
                    errorMessage,
                    context,
                    error instanceof Error ? error : undefined,
                );
            }

            // A body over the size limit is the caller's fault, and says so.
            if (statusCode === 413) {
                return ApiResponses.error('Request body is too large', undefined, 413, endpoint);
            }

            // Return error response
            return ApiResponses.error(
                errorMessage,
                includeErrorDetails && error instanceof Error ? error : new Error(errorMessage),
                statusCode,
                endpoint,
            );
        }
    };
}

/**
 * Create a configured error handler with preset options.
 *
 * Useful for creating endpoint-specific error handlers.
 *
 * @example
 * const handleAIError = createErrorHandler({
 *     errorMessage: 'AI service error',
 *     loggerName: 'AIEndpoint'
 * });
 *
 * export const GET = handleAIError(async ({ locals }) => {
 *     const suggestions = await generateSuggestions(locals.user);
 *     return json(suggestions);
 * });
 */
export function createErrorHandler(
    defaultOptions: ErrorHandlerOptions,
): <Params extends Partial<Record<string, string>> = Partial<Record<string, string>>>(
    handler: (event: RequestEvent<Params>) => Response | Promise<Response>,
    overrideOptions?: ErrorHandlerOptions,
) => (event: RequestEvent<Params>) => Promise<Response> {
    return (handler, overrideOptions = {}) =>
        withErrorHandler(handler, { ...defaultOptions, ...overrideOptions });
}

/**
 * Pre-configured error handler for AI endpoints
 */
export const withAIErrorHandler = createErrorHandler({
    errorMessage: 'AI service error',
    loggerName: 'AIEndpoint',
});

/**
 * Pre-configured error handler for media endpoints
 */
export const withMediaErrorHandler = createErrorHandler({
    errorMessage: 'Media service error',
    loggerName: 'MediaEndpoint',
});

/**
 * Pre-configured error handler for user endpoints
 */
export const withUserErrorHandler = createErrorHandler({
    errorMessage: 'User service error',
    loggerName: 'UserEndpoint',
});
