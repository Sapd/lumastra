// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared types for the typed API client
 */

import type { z } from 'zod';
import type { operations, components } from './schema.js';

/** Result type returned by all API client methods */
export interface ApiResult<T> {
    data: T | null;
    error: string | null;
    /**
     * Machine-parseable error code from problem+json responses.
     * Prefer switching on `code` rather than pattern-matching `error` text.
     * Populated whenever the server emits `application/problem+json`.
     */
    code?: string;
    /**
     * Structured error detail from problem+json responses. Narrow per endpoint;
     * playback refusals carry an object, validation failures carry a field array.
     */
    details?: unknown;
    /** Zod validation error details if response validation failed */
    validationError?: z.ZodError;
    /** Server Retry-After delay for a rate-limited request, in milliseconds. */
    retryAfterMs?: number;
    status: number;
}

/** Options for API requests */
export interface ApiRequestOptions {
    /** Request timeout in milliseconds (default: 30000) */
    timeout?: number;
    /** Keep a small request alive during navigation (browser size limits still apply). */
    keepalive?: boolean;
    /** Additional headers to include */
    headers?: Record<string, string>;
    /** AbortSignal for external cancellation */
    signal?: AbortSignal;
    /** Query parameters to append to the URL */
    params?: Record<string, string | number | boolean | undefined>;
    /**
     * Fail CLOSED on a schema mismatch: return `{ data: null, error, code:
     * 'SCHEMA_MISMATCH', validationError }` instead of the raw payload. For
     * pages that render a verdict from the data (the /admin/fix guides), where
     * an unvalidated payload — typically a stale tab against a newer server —
     * would be read as a diagnosis. The default stays fail-open.
     */
    strict?: boolean;
}

/**
 * Extract the JSON response type for an operation from the generated schema.
 * Handles 200 and 201 response codes.
 *
 * Usage: `ApiResponse<"getSearch">` → the shape of the 200 JSON body
 */
export type ApiResponse<Op extends keyof operations> = operations[Op] extends {
    responses: { 200: { content: { 'application/json': infer R } } };
}
    ? R
    : operations[Op] extends {
            responses: { 201: { content: { 'application/json': infer R } } };
        }
      ? R
      : never;

/** Re-export commonly used schema component types */
export type SchemaPageSection = components['schemas']['PageSection'];
export type SchemaMediaItem = components['schemas']['UniversalMediaItem'];
export type SchemaExternalIds = components['schemas']['ExternalIds'];
