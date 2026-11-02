// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zod Validation Middleware for API Routes
 *
 * Provides type-safe request validation that integrates with existing
 * auth middleware and ApiResponses error handling.
 *
 * @example
 * // Basic body validation
 * export const POST = withValidation(
 *   async ({ validated, locals }) => {
 *     const { name, description } = validated.body;
 *     // ... handler logic
 *   },
 *   { body: createPlaylistSchema }
 * );
 *
 * @example
 * // Combined with auth middleware
 * export const POST = requireAuth(
 *   withValidation(
 *     async ({ validated, locals }) => {
 *       // validated.body and validated.query are fully typed
 *     },
 *     { body: ratingSchema, query: paginationSchema }
 *   )
 * );
 */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import type { ZodSchema, ZodError } from 'zod';
import { ApiResponses } from '$lib/server/utils/api-responses';
import {
    DEFAULT_MAX_BODY_BYTES,
    BODY_TOO_LARGE,
    isDeclaredContentLengthOverCap,
    readBoundedBodyText,
    restoreRequestBody,
} from '$lib/server/utils/bounded-body-reader';

/**
 * Schema configuration for request validation
 */
export interface ValidationSchemas<TBody = unknown, TQuery = unknown, TParams = unknown> {
    /** Schema for request body (POST, PUT, PATCH) */
    body?: ZodSchema<TBody>;
    /** Schema for URL query parameters */
    query?: ZodSchema<TQuery>;
    /** Schema for URL path parameters */
    params?: ZodSchema<TParams>;
    /**
     * Optional cap (in bytes) on the request body (C15). Enforced two ways,
     * matching mount.ts's `readRequestBody()` exactly (both now share the
     * implementation in `utils/bounded-body-reader.ts`): a declared
     * `Content-Length` over the cap is rejected with `413 payload_too_large`
     * before any read, and a streamed reader aborts mid-buffer if a
     * missing/lying `Content-Length` would otherwise let an oversized body
     * through. Only meaningful alongside `body`. Defaults to 256 KB — the same
     * default mount()'s declarative `request.maxBodyBytes` uses, so both
     * request-validation paths share one budget by default.
     */
    maxBodyBytes?: number;
}

/**
 * Validated data container added to the request event
 */
export interface ValidatedData<TBody, TQuery, TParams> {
    body: TBody;
    query: TQuery;
    params: TParams;
}

/**
 * Extended request event with validated data
 */
export type ValidatedRequestEvent<
    TBody = unknown,
    TQuery = unknown,
    TParams = unknown,
> = RequestEvent & {
    validated: ValidatedData<TBody, TQuery, TParams>;
};

/**
 * Handler type for validated requests
 */
export type ValidatedHandler<TBody = unknown, TQuery = unknown, TParams = unknown> = (
    event: ValidatedRequestEvent<TBody, TQuery, TParams>,
) => Promise<Response> | Response;

/**
 * Format Zod validation errors into API response format
 */
function formatZodError(
    error: ZodError,
    source: 'body' | 'query' | 'params',
    endpoint?: string,
): Response {
    const issues = error.issues || [];
    const errors = issues.map((issue) => ({
        field:
            source === 'body' && issue.path.length === 0
                ? source
                : `${source}.${issue.path.join('.')}`,
        message: issue.message,
    }));

    return ApiResponses.validationError(errors, endpoint);
}

/**
 * Validation middleware factory
 *
 * Creates a middleware that validates request body, query params, and/or path params
 * against Zod schemas. The validated data is attached to the event as `validated`.
 *
 * @param handler - Request handler that receives validated data
 * @param schemas - Object containing optional body, query, and params schemas
 * @returns RequestHandler that validates before calling the handler
 */
/**
 * True when the request carries a body but no Content-Type and is not
 * Bearer-authenticated — the shape only a cookie-riding cross-site request has
 * any reason to produce. `content-length: 0` / absent counts as no body.
 */
export function untypedBodyOnCookieAuth(request: Request): boolean {
    if (request.headers.get('content-type')) return false;
    if (/^bearer[ \t]+\S/i.test(request.headers.get('authorization') ?? '')) return false;
    const length = request.headers.get('content-length');
    const hasBody = request.body !== null && length !== '0';
    return hasBody;
}

export function withValidation<TBody = unknown, TQuery = unknown, TParams = unknown>(
    handler: ValidatedHandler<TBody, TQuery, TParams>,
    schemas: ValidationSchemas<TBody, TQuery, TParams>,
): RequestHandler {
    return async (event: RequestEvent): Promise<Response> => {
        const endpoint = event.url.pathname;
        const validated: ValidatedData<TBody, TQuery, TParams> = {
            body: undefined as TBody,
            query: undefined as TQuery,
            params: undefined as TParams,
        };

        try {
            // Validate request body
            if (schemas.body) {
                // A body with NO Content-Type on a cookie-authenticated request is the
                // CORS simple-request shape a cross-site page can send with the victim's
                // cookies (`fetch(..., { body: new Blob([json]) })`). Never guess "JSON"
                // for it — the CSRF hook rejects it first, this is the backstop for any
                // route outside that hook. Bearer requests carry no cookie: unaffected.
                // Security review 2026-09-12, C1.
                if (untypedBodyOnCookieAuth(event.request)) {
                    return ApiResponses.badRequest(
                        'Content-Type header is required for a request body',
                        undefined,
                        endpoint,
                    );
                }

                // C15 (fix round 1, finding 3): reject a declared-oversized body
                // before reading it, and — the gap the round-1 review found —
                // abort a STREAMED read mid-buffer if a missing/lying
                // Content-Length would otherwise let an oversized body through
                // anyway.
                //
                // Reads the request's OWN stream, NOT a `.clone()`: cancelling
                // a reader obtained from a cloned Request's body hangs
                // indefinitely in Node's fetch implementation once any data
                // has flowed (see bounded-body-reader.ts's module docstring —
                // reproduced locally with both a fully-buffered and a
                // genuinely streamed body). `restoreRequestBody()` then
                // reconstructs `event.request` from the buffered text so the
                // wrapped handler's own `event.request` stays fully readable
                // afterward, exactly like the `.clone().json()` this replaces
                // — just via mount.ts's proven buffer-and-rebuild approach
                // instead of the clone that hangs.
                const maxBodyBytes = schemas.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
                if (isDeclaredContentLengthOverCap(event.request, maxBodyBytes)) {
                    return ApiResponses.payloadTooLarge('Request body is too large', endpoint);
                }

                const boundedText = await readBoundedBodyText(event.request, maxBodyBytes);
                if (boundedText === BODY_TOO_LARGE) {
                    return ApiResponses.payloadTooLarge('Request body is too large', endpoint);
                }
                restoreRequestBody(event, boundedText);

                let rawBody: unknown;
                try {
                    // Mirror `.json()` throwing on an empty string — the catch
                    // below is what actually decides empty-vs-malformed.
                    if (boundedText.trim() === '') {
                        throw new SyntaxError('Unexpected end of JSON input');
                    }
                    rawBody = JSON.parse(boundedText);
                } catch {
                    // Differentiate empty body (e.g. no Content-Type) from malformed JSON
                    const contentType = event.request.headers.get('content-type') || '';
                    const hasJsonContent = contentType.includes('application/json');
                    const contentLength = event.request.headers.get('content-length');
                    const hasBody = contentLength !== null && contentLength !== '0';

                    if (hasJsonContent || hasBody) {
                        // Client sent a body but it was malformed JSON
                        return ApiResponses.badRequest(
                            'Invalid JSON in request body',
                            undefined,
                            endpoint,
                        );
                    }
                    // No body sent - use empty object and let schema validation handle required fields
                    rawBody = {};
                }

                const result = schemas.body.safeParse(rawBody);
                if (!result.success) {
                    return formatZodError(result.error, 'body', endpoint);
                }
                validated.body = result.data;
            }

            // Validate query parameters
            // Note: Object.fromEntries drops duplicate keys (e.g., ?a=1&a=2 keeps last value).
            // This is fine because schemas use comma-separated strings for multi-value fields.
            if (schemas.query) {
                const queryParams = Object.fromEntries(event.url.searchParams);
                const result = schemas.query.safeParse(queryParams);
                if (!result.success) {
                    return formatZodError(result.error, 'query', endpoint);
                }
                validated.query = result.data;
            }

            // Validate path parameters
            if (schemas.params) {
                const result = schemas.params.safeParse(event.params);
                if (!result.success) {
                    return formatZodError(result.error, 'params', endpoint);
                }
                validated.params = result.data;
            }

            // Call the handler with validated data
            const validatedEvent = Object.assign(event, {
                validated,
            }) as ValidatedRequestEvent<TBody, TQuery, TParams>;
            return await handler(validatedEvent);
        } catch (error) {
            // Handle JSON parsing errors that might slip through
            if (error instanceof SyntaxError) {
                return ApiResponses.badRequest('Invalid JSON in request body');
            }
            throw error;
        }
    };
}

/**
 * Type helper to extract the validated body type from a schema
 */
export type InferBody<T> = T extends ValidationSchemas<infer B, unknown, unknown> ? B : never;

/**
 * Type helper to extract the validated query type from a schema
 */
export type InferQuery<T> = T extends ValidationSchemas<unknown, infer Q, unknown> ? Q : never;

/**
 * Type helper to extract the validated params type from a schema
 */
export type InferParams<T> = T extends ValidationSchemas<unknown, unknown, infer P> ? P : never;

/**
 * Validate only body (convenience wrapper)
 */
export function withBodyValidation<TBody>(
    handler: ValidatedHandler<TBody, unknown, unknown>,
    schema: ZodSchema<TBody>,
): RequestHandler {
    return withValidation(handler, { body: schema });
}

/**
 * Validate only query params (convenience wrapper)
 */
export function withQueryValidation<TQuery>(
    handler: ValidatedHandler<unknown, TQuery, unknown>,
    schema: ZodSchema<TQuery>,
): RequestHandler {
    return withValidation(handler, { query: schema });
}

/**
 * Validate only path params (convenience wrapper)
 */
export function withParamsValidation<TParams>(
    handler: ValidatedHandler<unknown, unknown, TParams>,
    schema: ZodSchema<TParams>,
): RequestHandler {
    return withValidation(handler, { params: schema });
}
