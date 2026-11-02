// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for ApiResponses
 *
 * ERROR methods now emit application/problem+json via problem() — all shape
 * assertions reflect the problem+json contract:
 *   { code, error, status, details?, retryAfter? }
 *
 * The {success:false, timestamp} envelope is gone from error responses.
 * SUCCESS responses are unchanged.
 *
 * Status-change notes (behaviour changes vs. the old legacy envelope):
 *   - validationError():  was 400, now 422
 *   - badRequest():       was 400, now 422
 */

import { describe, it, expect } from 'vitest';
import { ApiResponses, ApiValidation } from './api-responses';

describe('ApiResponses', () => {
    describe('notFound', () => {
        it('returns 404 status', async () => {
            const response = ApiResponses.notFound('Movie');
            expect(response.status).toBe(404);
        });

        it('has correct problem+json shape with resource name', async () => {
            const response = ApiResponses.notFound('Movie');
            const body = await response.json();
            expect(body.code).toBe('not_found');
            expect(body.status).toBe(404);
            expect(body.error).toBe('Movie not found');
            expect(body.success).toBeUndefined();
            expect(body.timestamp).toBeUndefined();
        });

        it('has problem+json Content-Type', () => {
            const response = ApiResponses.notFound('Series');
            expect(response.headers.get('Content-Type')).toContain('application/problem+json');
        });
    });

    describe('forbidden', () => {
        it('returns 403 status', async () => {
            const response = ApiResponses.forbidden();
            expect(response.status).toBe(403);
        });

        it('has default error message', async () => {
            const response = ApiResponses.forbidden();
            const body = await response.json();
            expect(body.code).toBe('forbidden');
            expect(body.error).toBe('Insufficient permissions');
        });

        it('accepts custom message', async () => {
            const response = ApiResponses.forbidden('Admin only');
            const body = await response.json();
            expect(body.error).toBe('Admin only');
        });
    });

    describe('404-not-403 existence-leak rule', () => {
        it('notFound and forbidden have distinct status codes', async () => {
            expect(ApiResponses.notFound().status).toBe(404);
            expect(ApiResponses.forbidden().status).toBe(403);
        });

        it('notFound never reveals whether resource exists', async () => {
            const genuinelyMissing = await ApiResponses.notFound('Movie').json();
            const accessDenied = await ApiResponses.notFound('Movie').json();

            expect(genuinelyMissing).toEqual(accessDenied);
            expect(genuinelyMissing.code).toBe('not_found');
        });
    });

    describe('badRequest', () => {
        it('returns 422 status (behaviour change: was 400)', async () => {
            const response = ApiResponses.badRequest();
            expect(response.status).toBe(422);
        });

        it('has correct code', async () => {
            const response = ApiResponses.badRequest();
            const body = await response.json();
            expect(body.code).toBe('validation_failed');
            expect(body.error).toBe('Invalid request');
        });

        it('includes details when provided', async () => {
            const response = ApiResponses.badRequest('Bad input', 'name is required');
            const body = await response.json();
            expect(body.error).toBe('Bad input');
            expect(body.details).toBe('name is required');
        });
    });

    describe('unauthorized', () => {
        it('returns 401 status', async () => {
            const response = ApiResponses.unauthorized();
            expect(response.status).toBe(401);
        });

        it('has default error message', async () => {
            const response = ApiResponses.unauthorized();
            const body = await response.json();
            expect(body.code).toBe('unauthorized');
            expect(body.error).toBe('Authentication required');
        });
    });

    describe('error', () => {
        it('returns 500 by default (internal_error)', async () => {
            const response = ApiResponses.error('Something broke');
            expect(response.status).toBe(500);
            const body = await response.json();
            expect(body.code).toBe('internal_error');
        });

        it('maps status 409 to conflict code', async () => {
            const response = ApiResponses.error('Conflict', undefined, 409);
            expect(response.status).toBe(409);
            const body = await response.json();
            expect(body.code).toBe('conflict');
        });

        it('maps status 400 to validation_failed (HTTP 422)', async () => {
            const response = ApiResponses.error('Bad', undefined, 400);
            expect(response.status).toBe(422);
            const body = await response.json();
            expect(body.code).toBe('validation_failed');
        });

        it('includes details string', async () => {
            const response = ApiResponses.error('Failed', 'connection timeout');
            const body = await response.json();
            expect(body.error).toBe('Failed');
            expect(body.details).toBe('connection timeout');
        });

        it('extracts message from Error details', async () => {
            const response = ApiResponses.error('Failed', new Error('boom'));
            const body = await response.json();
            expect(body.details).toBe('boom');
        });
    });

    describe('validationError', () => {
        it('returns 422 status (behaviour change: was 400)', async () => {
            const response = ApiResponses.validationError([
                { field: 'email', message: 'Invalid email' },
            ]);
            expect(response.status).toBe(422);
        });

        it('encodes validation errors as ValidationDetail[] in details', async () => {
            const errors = [
                { field: 'email', message: 'Invalid email', value: 'bad' },
                { field: 'age', message: 'Must be positive', value: -1 },
            ];
            const response = ApiResponses.validationError(errors);
            const body = await response.json();

            expect(body.code).toBe('validation_failed');
            expect(body.error).toBe('Validation failed');
            expect(Array.isArray(body.details)).toBe(true);
            expect(body.details).toEqual(errors);
        });

        it('does NOT leak existence of resources (consistent with 404-not-403 rule)', async () => {
            const response = ApiResponses.validationError([
                { field: 'id', message: 'Must be a positive integer' },
            ]);
            const body = await response.json();

            expect(body.code).toBe('validation_failed');
            expect(body.error).not.toContain('not found');
            expect(body.error).not.toContain('forbidden');
        });
    });

    describe('kicked', () => {
        it('returns 403 with remainingSeconds in retryAfter', async () => {
            const response = ApiResponses.kicked(30);
            const body = await response.json();
            expect(response.status).toBe(403);
            expect(body.code).toBe('forbidden');
            expect(body.retryAfter).toBe(30);
        });
    });

    describe('conflict', () => {
        it('returns 409', async () => {
            const response = ApiResponses.conflict();
            expect(response.status).toBe(409);
            const body = await response.json();
            expect(body.code).toBe('conflict');
        });
    });

    describe('rateLimited', () => {
        it('returns 429 with Retry-After header', async () => {
            const resetTime = Date.now() + 60000;
            const response = ApiResponses.rateLimited(resetTime);
            expect(response.status).toBe(429);
            expect(response.headers.get('Retry-After')).toBeDefined();
            const body = await response.json();
            expect(body.code).toBe('rate_limited');
            expect(body.retryAfter).toBeGreaterThan(0);
        });
    });

    describe('serviceUnavailable', () => {
        it('returns 503 with dependency_unavailable code', async () => {
            const response = ApiResponses.serviceUnavailable('Database');
            expect(response.status).toBe(503);
            const body = await response.json();
            expect(body.code).toBe('dependency_unavailable');
        });
    });

    describe('insufficientData', () => {
        it('returns 422 with validation_failed code', async () => {
            const response = ApiResponses.insufficientData(5, 2);
            expect(response.status).toBe(422);
            const body = await response.json();
            expect(body.code).toBe('validation_failed');
            expect(typeof body.details).toBe('string');
            expect(body.details).toContain('"required":5');
            expect(body.details).toContain('"actual":2');
        });
    });

    describe('onboardingRequired', () => {
        it('returns 200 with onboardingNeeded flag (NOT migrated to problem+json)', async () => {
            const response = ApiResponses.onboardingRequired(2, 5);
            expect(response.status).toBe(200);
            const body = await response.json();
            expect(body.success).toBe(false);
            expect(body.data.onboardingNeeded).toBe(true);
            expect(body.data.currentRatings).toBe(2);
            expect(body.data.requiredRatings).toBe(5);
            expect(body.data.remainingRatings).toBe(3);
        });
    });

    describe('externalApiError', () => {
        it('returns 502 with bad_gateway code', async () => {
            const response = ApiResponses.externalApiError('TMDB', 'Connection failed');
            expect(response.status).toBe(502);
            const body = await response.json();
            expect(body.code).toBe('bad_gateway');
            expect(body.details).toBe('Connection failed');
        });
    });
});

describe('ApiValidation', () => {
    describe('validateRequired', () => {
        it('returns error for null', () => {
            const result = ApiValidation.validateRequired(null, 'name');
            expect(result).toEqual({
                field: 'name',
                message: 'This field is required',
                value: null,
            });
        });

        it('returns error for undefined', () => {
            const result = ApiValidation.validateRequired(undefined, 'name');
            expect(result).toEqual({
                field: 'name',
                message: 'This field is required',
                value: undefined,
            });
        });

        it('returns error for empty string', () => {
            const result = ApiValidation.validateRequired('', 'name');
            expect(result).toEqual({
                field: 'name',
                message: 'This field is required',
                value: '',
            });
        });

        it('returns null for non-empty string', () => {
            const result = ApiValidation.validateRequired('hello', 'name');
            expect(result).toBeNull();
        });
    });

    describe('validateNumber', () => {
        it('returns error for NaN', () => {
            const result = ApiValidation.validateNumber('abc', 'count');
            expect(result?.message).toBe('Must be a valid number');
        });

        it('returns error for below min', () => {
            const result = ApiValidation.validateNumber(5, 'count', 10);
            expect(result?.message).toBe('Must be at least 10');
        });

        it('returns error for above max', () => {
            const result = ApiValidation.validateNumber(100, 'count', 0, 50);
            expect(result?.message).toBe('Must be at most 50');
        });

        it('returns null for valid number', () => {
            const result = ApiValidation.validateNumber(42, 'count');
            expect(result).toBeNull();
        });
    });
});
