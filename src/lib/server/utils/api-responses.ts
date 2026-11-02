// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { Logger } from './logger';
import { problem, type ProblemCode, type ValidationDetail } from '$lib/server/api/problem';

const logger = Logger.for('ApiResponses');

/**
 * Standardized API Response Utilities
 *
 * ERROR methods are re-aliased onto problem() (application/problem+json) so
 * that all ~434 non-v1 /api routes emit the same error envelope as /api/v1.
 * SUCCESS methods are unchanged — the {success:true} envelope is out of scope.
 *
 * HTTP STATUS IS CANONICAL-FROM-CODE: each error method picks a ProblemCode
 * and lets problem() derive the HTTP status from the canonical code→status
 * mapping. Most methods still emit their historical status because the chosen
 * code's canonical status matches it. The EXCEPTION is the validation family:
 * the taxonomy has no 400 code (validation_failed maps to 422), so the legacy
 * 400 overrides were dropped and these now emit 422. Consumers should branch
 * on `!res.ok` or the problem `code`, not a hard-coded status number.
 *
 * Status mapping:
 *   - validationError():       422 (code validation_failed)
 *   - badRequest():            422 (code validation_failed)
 *   - error(msg, det, status): status → code via codeForStatus(), then the
 *       code's canonical status (so 400→validation_failed→422)
 *   - unprocessableEntity():   422 (code validation_failed)
 *   - insufficientData():      422 (code validation_failed)
 *   - unauthorized 401, forbidden/kicked 403, notFound 404, conflict 409,
 *     rateLimited 429, externalApiError 502, serviceUnavailable 503.
 *
 * Callers need no edits — all method signatures are preserved.
 */

export interface ApiResponse<T = unknown> {
    success: boolean;
    error?: string;
    details?: string;
    message?: string;
    timestamp: string;
    endpoint?: string;
    /**
     * @deprecated Legacy field — responses now spread data at top level.
     * Only present on error responses that include structured error data.
     */
    data?: T;
}

export interface ValidationError {
    field: string;
    message: string;
    value?: unknown;
}

/** Map an HTTP status code to a ProblemCode. */
export function codeForStatus(status: number): ProblemCode {
    switch (status) {
        case 400:
        case 422:
            return 'validation_failed';
        case 401:
            return 'unauthorized';
        case 403:
            return 'forbidden';
        case 404:
            return 'not_found';
        case 409:
            return 'conflict';
        case 413:
            return 'payload_too_large';
        case 429:
            return 'rate_limited';
        case 502:
            return 'bad_gateway';
        case 503:
            return 'dependency_unavailable';
        default:
            return 'internal_error';
    }
}

/**
 * Standardized API response utilities
 */
export class ApiResponses {
    /**
     * Error response with details.
     *
     * Maps the passed `status` → ProblemCode via codeForStatus(), then lets
     * problem() derive the HTTP status from that code (the canonical
     * code→status mapping). The human message is forwarded to problem()'s
     * `error` field; details (string or Error) become the `details` string
     * in the problem body.
     *
     * Status is CANONICAL-FROM-CODE, not preserved: the `status` argument
     * only selects the ProblemCode. A 4xx that maps to `validation_failed`
     * (i.e. 400 or 422) therefore emits HTTP 422 — the taxonomy has no 400
     * code. Other statuses (401/403/404/409/429/502/503/500) round-trip
     * unchanged because each maps to a code whose canonical status equals
     * the input.
     */
    static error(message: string, details?: string | Error, status = 500, endpoint?: string) {
        const detailsStr = details instanceof Error ? details.message : details;

        // Log server errors for debugging (preserved from legacy implementation)
        if (status >= 500) {
            logger.error(
                `${endpoint || 'Unknown'}: ${message}`,
                details instanceof Error ? details : undefined,
            );
        }

        return problem(codeForStatus(status), {
            error: message,
            details: detailsStr,
        });
    }

    /**
     * Validation error response.
     *
     * Status is derived from the problem code: validation_failed → HTTP 422
     * (the canonical taxonomy status; the legacy 400 override was removed).
     * Structured errors are forwarded as ValidationDetail[] in the problem
     * body's `details` field.
     */
    static validationError(errors: ValidationError[], _endpoint?: string) {
        const details: ValidationDetail[] = errors.map((err) => ({
            field: err.field,
            message: err.message,
            value: err.value,
        }));

        return problem('validation_failed', {
            error: m.api_error_validation_failed(),
            details,
        });
    }

    /**
     * Unauthorized - user is not authenticated (401)
     */
    static unauthorized(message: string = m.api_error_auth_required(), _endpoint?: string) {
        // Status PRESERVED: HTTP 401.
        return problem('unauthorized', { error: message, status: 401 });
    }

    /**
     * Forbidden access (different from unauthorized - user is authenticated but lacks permission)
     */
    static forbidden(message: string = m.api_error_insufficient_permissions(), _endpoint?: string) {
        // Status PRESERVED: HTTP 403.
        return problem('forbidden', { error: message, status: 403 });
    }

    /**
     * Kicked (rate-limited by admin kick) — emits forbidden (403).
     *
     * remainingSeconds is forwarded as retryAfter (seconds) in the problem
     * body and the Retry-After header. The machine field `remainingSeconds` is
     * not consumed by the frontend so this mapping is low-risk.
     */
    static kicked(remainingSeconds: number) {
        // Status PRESERVED: HTTP 403.
        return problem('forbidden', {
            error: m.api_error_kicked({ seconds: String(remainingSeconds) }),
            retryAfter: remainingSeconds,
            status: 403,
        });
    }

    /**
     * Not found response
     */
    static notFound(resource: string = m.api_error_resource_default(), _endpoint?: string) {
        // Status PRESERVED: HTTP 404.
        return problem('not_found', {
            error: m.api_error_not_found({ resource }),
            status: 404,
        });
    }

    /**
     * Conflict response (409 - resource already exists or operation in progress)
     */
    static conflict(
        message: string = m.api_error_resource_conflict(),
        details?: string,
        _endpoint?: string,
    ) {
        // Status PRESERVED: HTTP 409.
        return problem('conflict', { error: message, details, status: 409 });
    }

    /**
     * Payload too large (413) — the request body exceeds this endpoint's size cap.
     */
    static payloadTooLarge(message: string = 'Request body is too large', _endpoint?: string) {
        return problem('payload_too_large', { error: message });
    }

    /**
     * Unprocessable entity (422 — request is syntactically valid but semantically wrong).
     *
     * The legacy implementation spread arbitrary `details` fields at the top level
     * of the response body. problem() only allows details as ValidationDetail[]|
     * QuotaDetail|string — arbitrary spread fields are serialised as a JSON string
     * in `details` so no information is lost for existing call sites.
     */
    static unprocessableEntity(message: string, details?: Record<string, unknown>) {
        const detailsStr = details !== undefined ? JSON.stringify(details) : undefined;
        // Status PRESERVED: HTTP 422 (matches the validation_failed default,
        // set explicitly so it stays 422 regardless of taxonomy changes).
        return problem('validation_failed', { error: message, details: detailsStr, status: 422 });
    }

    /**
     * Bad request response.
     *
     * Status is derived from the problem code: validation_failed → HTTP 422
     * (the canonical taxonomy status; the legacy 400 override was removed).
     */
    static badRequest(
        message: string = m.api_error_invalid_request(),
        details?: string,
        _endpoint?: string,
    ) {
        return problem('validation_failed', { error: message, details });
    }

    /**
     * Service unavailable (AI database down, external API issues)
     */
    static serviceUnavailable(
        service: string = m.api_error_service_default(),
        details?: string,
        _endpoint?: string,
    ) {
        // Status PRESERVED: HTTP 503.
        return problem('dependency_unavailable', {
            error: m.api_error_service_unavailable({ service }),
            details: details ?? m.api_error_try_again_later(),
            status: 503,
        });
    }

    /**
     * Rate limit exceeded.
     *
     * resetTime is an epoch-ms timestamp; it is converted to seconds-until-reset
     * and forwarded as retryAfter (mapped to both the body and Retry-After header
     * by problem()).
     */
    static rateLimited(resetTime?: number, _endpoint?: string) {
        const retryAfter =
            resetTime !== undefined ? Math.ceil((resetTime - Date.now()) / 1000) : undefined;

        const detailsStr = resetTime
            ? m.api_error_try_again_after({ time: new Date(resetTime).toISOString() })
            : m.api_error_wait_before_retry();

        // Status PRESERVED: HTTP 429.
        return problem('rate_limited', {
            error: m.api_error_rate_limited(),
            details: detailsStr,
            retryAfter,
            status: 429,
        });
    }

    /**
     * AI database unavailable (common in AI endpoints)
     */
    static aiDatabaseUnavailable(endpoint?: string) {
        return this.serviceUnavailable(
            m.api_error_ai_system(),
            m.api_error_db_maintenance(),
            endpoint,
        );
    }

    /**
     * Insufficient data for AI operations.
     *
     * The legacy `data: {required, actual, dataType}` payload is forwarded as
     * a string in the problem body's `details` field (problem() does not allow
     * arbitrary top-level fields). The human-readable error and detail strings
     * are preserved.
     */
    static insufficientData(
        required: number,
        actual: number,
        dataType = 'ratings',
        _endpoint?: string,
    ) {
        const detailsStr = [
            m.api_error_required_available({ required: String(required), actual: String(actual) }),
            JSON.stringify({ required, actual, dataType }),
        ].join(' ');

        // Status PRESERVED: HTTP 422 (legacy "Unprocessable Entity").
        return problem('validation_failed', {
            error: m.api_error_insufficient_data({ dataType }),
            details: detailsStr,
            status: 422,
        });
    }

    /**
     * External API failure (TMDB, Jellyfin, etc.)
     */
    static externalApiError(apiName: string, error: string | Error, _endpoint?: string) {
        const errorMessage = error instanceof Error ? error.message : error;

        // Log external API errors for monitoring (preserved from legacy implementation)
        console.error(`[External API Error] ${apiName}:`, errorMessage);

        // Status PRESERVED: HTTP 502 (Bad Gateway).
        return problem('bad_gateway', {
            error: m.api_error_api_name({ apiName }),
            details: errorMessage,
            status: 502,
        });
    }

    /**
     * Onboarding required response (user needs to rate more items).
     *
     * NOT migrated to problem(): this deliberately returns HTTP 200.
     * problem() always sets status from the code and has no 200 code.
     * Callers detect the state via the `onboardingNeeded` flag in the body.
     */
    static onboardingRequired(currentRatings: number, requiredRatings = 5, endpoint?: string) {
        const response: ApiResponse = {
            success: false,
            error: m.api_error_onboarding_required(),
            message: m.api_error_rate_more({ count: String(requiredRatings) }),
            data: {
                currentRatings,
                requiredRatings,
                remainingRatings: Math.max(0, requiredRatings - currentRatings),
                onboardingNeeded: true,
            },
            timestamp: new Date().toISOString(),
        };

        if (endpoint) response.endpoint = endpoint;

        // 200, not 4xx: "onboarding required" is an EXPECTED state for a new
        // account with too few ratings — the request was perfectly valid. A 4xx
        // made the browser log a scary "Failed to load resource: 422" on every
        // fresh home load (the hero fetches AI suggestions). Callers detect the
        // state via the `onboardingNeeded` flag in the body, not the status.
        return json(response, { status: 200 });
    }
}

/**
 * Common validation helpers
 */
export class ApiValidation {
    /**
     * Validate required string parameter
     */
    static validateRequired(value: unknown, fieldName: string): ValidationError | null {
        if (
            value === null ||
            value === undefined ||
            (typeof value === 'string' && value.trim() === '')
        ) {
            return {
                field: fieldName,
                message: m.api_validation_field_required(),
                value,
            };
        }
        return null;
    }

    /**
     * Validate numeric parameter
     */
    static validateNumber(
        value: unknown,
        fieldName: string,
        min?: number,
        max?: number,
    ): ValidationError | null {
        const num =
            typeof value === 'number' && Number.isFinite(value)
                ? value
                : typeof value === 'string'
                  ? Number(value)
                  : NaN;

        if (isNaN(num)) {
            return {
                field: fieldName,
                message: m.api_validation_must_be_number(),
                value,
            };
        }

        if (min !== undefined && num < min) {
            return {
                field: fieldName,
                message: m.api_validation_must_be_at_least({
                    min: String(min),
                }),
                value,
            };
        }

        if (max !== undefined && num > max) {
            return {
                field: fieldName,
                message: m.api_validation_must_be_at_most({ max: String(max) }),
                value,
            };
        }

        return null;
    }

    /**
     * Validate enum value
     */
    static validateEnum(
        value: unknown,
        fieldName: string,
        allowedValues: string[],
    ): ValidationError | null {
        if (typeof value !== 'string' || !allowedValues.includes(value)) {
            return {
                field: fieldName,
                message: m.api_validation_must_be_one_of({
                    values: allowedValues.join(', '),
                }),
                value,
            };
        }
        return null;
    }

    /**
     * Validate user ID
     */
    static validateUserId(userId: unknown): ValidationError | null {
        return this.validateRequired(userId, 'userId');
    }

    /**
     * Validate TMDB ID
     *
     * @deprecated **DO NOT USE in new code.** Use parseMediaId() from media-key-parser.ts instead
     * for provider-agnostic ID handling. This validates TMDB IDs only and will be removed in a future version.
     *
     * For public APIs: Use composite keys (provider:id:mediaType) or UUIDs.
     * For internal TMDB provider code: This method is acceptable but prefer parseMediaId() for consistency.
     */
    static validateTmdbId(tmdbId: unknown): ValidationError | null {
        return this.validateNumber(tmdbId, 'tmdbId', 1);
    }

    /**
     * Validate pagination parameters
     */
    static validatePagination(page: unknown, limit: unknown): ValidationError[] {
        const errors: ValidationError[] = [];

        const pageError = this.validateNumber(page, 'page', 1);
        if (pageError) errors.push(pageError);

        const limitError = this.validateNumber(limit, 'limit', 1, 100);
        if (limitError) errors.push(limitError);

        return errors;
    }
}

/**
 * Helper to extract endpoint name from request event
 */
export function getEndpointName(event: RequestEvent): string {
    return event.url.pathname;
}

/**
 * Wrapper for endpoint functions to add consistent error handling
 *
 * @deprecated Use `withErrorHandler` from `$lib/server/middleware/error-handler` instead.
 * This function lacks the rich features of the middleware-based error handler (status code
 * detection, custom error messages, logger integration, etc.). Zero routes currently
 * import this function. It will be removed in a future version.
 */
export function withErrorHandling(
    handler: (event: RequestEvent) => Promise<Response>,
    endpointName?: string,
) {
    return async (event: RequestEvent): Promise<Response> => {
        const endpoint = endpointName || getEndpointName(event);

        try {
            return await handler(event);
        } catch (error) {
            console.error(`[Endpoint Error] ${endpoint}:`, error);

            if (error instanceof Response) {
                return error; // Already a response, pass through
            }

            return ApiResponses.error(
                'Internal server error',
                error instanceof Error ? error.message : 'Unknown error',
                500,
                endpoint,
            );
        }
    };
}
