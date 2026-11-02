// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared helpers for OpenAPI spec generation.
 *
 * Provides reusable response builders and security constants
 * that mirror the ApiResponse<T> shape from api-responses.ts.
 */

import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import type { ResponseHeaders } from '../../src/lib/server/openapi';

// ============================================================================
// Security Constants
// ============================================================================

export const BEARER_AUTH = [{ bearerAuth: [] }];
export const NO_AUTH: [] = [];

// ============================================================================
// Response Helpers
// ============================================================================

/**
 * Build a success response that returns the data directly (no ApiResponse wrapper).
 */
export function jsonResponse(
    schema: z.ZodType,
    description = 'Successful response',
): Record<string, unknown> {
    return {
        description,
        content: {
            'application/json': {
                schema,
            },
        },
    };
}

/**
 * Closed `code` taxonomy for problem+json error responses.
 *
 * MUST stay in sync with `ProblemCode` in
 * `src/lib/server/api/problem.ts` — the runtime contract.
 */
export const PROBLEM_CODES = [
    'unauthorized',
    'invalid_token',
    'invalid_grant',
    'ip_mismatch',
    'forbidden',
    'scope_required',
    'not_found',
    'conflict',
    'gone',
    'payload_too_large',
    'validation_failed',
    'quota_exceeded',
    'rate_limited',
    'internal_error',
    'bad_gateway',
    'server_id_unavailable',
    'dependency_unavailable',
    'shutting_down',
    'stream_limit',
    'cap_unavailable',
    'channel_offline',
    'provider_auth_failed',
    'provider_connection_limit',
    'provider_unreachable',
    'geo_blocked',
    'no_video',
    'encoder_failed',
    'all_feeds_failed',
    'upstream_stalled',
    'ip_restricted',
    'plugin_denied',
    'prefetch_requires_current_session',
    'route_retired',
    'source_incompatible',
    'transcode_not_allowed',
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

/**
 * Default `code` per HTTP status, matching the STATUS_FOR_CODE mapping in
 * `src/lib/server/api/problem.ts`. When a status maps to multiple codes the
 * most common/general one is chosen.
 */
const DEFAULT_CODE_FOR_STATUS: Record<number, ProblemCode> = {
    400: 'validation_failed',
    401: 'unauthorized',
    403: 'forbidden',
    404: 'not_found',
    409: 'conflict',
    410: 'gone',
    413: 'payload_too_large',
    422: 'validation_failed',
    429: 'rate_limited',
    500: 'internal_error',
    502: 'bad_gateway',
    503: 'dependency_unavailable',
};

/**
 * Build an error response entry as `application/problem+json`.
 *
 * Mirrors the runtime contract in `src/lib/server/api/problem.ts`:
 * `{ code, error, status, details?, requestId?, retryAfter? }` with the
 * `code` field constrained to the {@link ProblemCode} taxonomy.
 *
 * @param description  Human-readable response description (OpenAPI metadata).
 * @param status       HTTP status this response models. Drives the default
 *                     `code` and the example `status` value. Defaults to 500.
 * @param code         Explicit ProblemCode override (otherwise derived from status).
 */
export function apiErrorResponse(
    description: string,
    status = 500,
    code?: ProblemCode,
): Record<string, unknown> {
    const resolvedCode = code ?? DEFAULT_CODE_FOR_STATUS[status] ?? 'internal_error';
    return {
        description,
        content: {
            'application/problem+json': {
                schema: z.object({
                    code: z.enum(PROBLEM_CODES).meta({
                        description: 'Stable, machine-parseable error code (switch on this).',
                        example: resolvedCode,
                    }),
                    error: z
                        .string()
                        .meta({ description: 'Human-readable description — display only.' }),
                    status: z.number().int().meta({
                        description: 'HTTP status code, mirrored into the body.',
                        example: status,
                    }),
                    details: z
                        .union([
                            z.array(
                                z.object({
                                    field: z.string(),
                                    message: z.string(),
                                    value: z.unknown().optional(),
                                }),
                            ),
                            z.object({
                                bucket: z.string(),
                                limit: z.number().int(),
                                used: z.number().int(),
                                remaining: z.number().int().nullable(),
                            }),
                            z.string(),
                        ])
                        .optional()
                        .meta({
                            description:
                                'Structured detail: field-level validation errors, quota info, or a freeform string.',
                        }),
                    requestId: z
                        .string()
                        .optional()
                        .meta({ description: 'Correlation ID, when available.' }),
                    retryAfter: z
                        .number()
                        .int()
                        .optional()
                        .meta({ description: 'Seconds until retry (mirrors Retry-After header).' }),
                }),
            },
        },
    };
}

/**
 * Generator-time record of routes that declared a STRING `binary:` content type
 * instead of the required `string[]`. {@link binaryResponse} coerces the value
 * so the emitted spec stays valid, but it also appends a human-readable note
 * here so `openapi:check` can fail loudly (a string binary should be caught at
 * build, not silently coerced). Drained/inspected by generate.ts under --check.
 */
export const binaryStringViolations: string[] = [];

/**
 * Build a binary/media response (images, video, subtitles, etc.).
 *
 * @param contentTypes  Content type(s). MUST be a `string[]` per ResponseDef.
 *                      A bare string is a typo (`binary: 'image/jpeg'` instead
 *                      of `binary: ['image/jpeg']`); it is coerced here so the
 *                      spec stays valid, but also recorded in
 *                      {@link binaryStringViolations} so --check can fail.
 * @param description   Human-readable response description.
 * @param context       Optional `METHOD /path` label for the violation message.
 */
export function binaryResponse(
    contentTypes: string[] | string,
    description: string,
    context?: string,
): Record<string, unknown> {
    // Defensive: a string content type (a `binary: 'image/jpeg'` typo instead
    // of `binary: ['image/jpeg']`) would otherwise be iterated char-by-char by
    // the for..of below and serialize as single-letter content keys
    // (i:, m:, a:, …), which breaks the generated spec. Coerce to an array so
    // that can't happen — AND record it so the build can reject it.
    if (typeof contentTypes === 'string') {
        binaryStringViolations.push(
            `${context ? `${context} → ` : ''}binary content type is a string ("${contentTypes}") — must be a string[] (e.g. binary: ['${contentTypes}'])`,
        );
    }
    const types = Array.isArray(contentTypes) ? contentTypes : [contentTypes];
    const content: Record<string, unknown> = {};
    for (const ct of types) {
        content[ct] = {
            schema: z.string().meta({ format: 'binary' }),
        };
    }
    return { description, content };
}

/**
 * Build the response-headers value for a {@link ResponseHeaders} declaration.
 *
 * zod-openapi expects `responses[code].headers` to be a SINGLE Zod object whose
 * keys are header names and whose values are the header value schemas — it then
 * serialises each into an OpenAPI Header Object. The per-header `description` is
 * carried via `.meta({ description })` on the value schema (the value schema
 * defaults to a plain string when none is given).
 *
 * Returns `undefined` when there are no headers so callers can conditionally
 * spread without emitting an empty `headers`.
 */
export function buildResponseHeaders(
    headers: ResponseHeaders | undefined,
): z.ZodObject | undefined {
    if (!headers) return undefined;
    const names = Object.keys(headers);
    if (names.length === 0) return undefined;
    const shape: Record<string, z.ZodType> = {};
    for (const name of names) {
        const header = headers[name];
        const base = header.schema ?? z.string();
        shape[name] = header.description ? base.meta({ description: header.description }) : base;
    }
    return z.object(shape);
}

/**
 * Build a text response (VTT subtitles, plain text, etc.).
 */
export function textResponse(contentType: string, description: string): Record<string, unknown> {
    return {
        description,
        content: {
            [contentType]: {
                schema: z.string(),
            },
        },
    };
}

/**
 * Build an SSE (Server-Sent Events) response.
 */
export function sseResponse(description: string): Record<string, unknown> {
    return {
        description,
        content: {
            'text/event-stream': {
                schema: z.string().meta({ description: 'Server-Sent Events stream' }),
            },
        },
    };
}

/**
 * Build a response matching ApiResponses.success() shape: { success, data, timestamp }.
 */
export function successResponse(
    dataSchema: z.ZodType,
    description = 'Successful response',
): Record<string, unknown> {
    return jsonResponse(
        z.object({
            success: z.boolean(),
            data: dataSchema,
            timestamp: z.string(),
        }),
        description,
    );
}

// ============================================================================
// Common Error Responses
// ============================================================================

export const COMMON_ERRORS = {
    401: apiErrorResponse('Authentication required', 401),
    500: apiErrorResponse('Internal server error', 500),
} as const;

export const COMMON_ERRORS_WITH_404 = {
    ...COMMON_ERRORS,
    404: apiErrorResponse('Resource not found', 404),
} as const;

export const COMMON_ERRORS_WITH_400 = {
    ...COMMON_ERRORS,
    400: apiErrorResponse('Bad request — invalid parameters', 400),
} as const;

// ============================================================================
// Type re-export for route files
// ============================================================================

export type PathsObject = ZodOpenApiPathsObject;
