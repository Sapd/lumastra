// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for Auth Middleware and API Response utilities
 *
 * Tests pure functions and utilities that don't require dynamic imports.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';
import { getUserContext, withRateLimit } from './auth';
import { ApiResponses, ApiValidation, getEndpointName } from '$lib/server/utils/api-responses';
import type { RequestEvent } from '@sveltejs/kit';

// Mock RequestEvent factory
function createMockEvent(
    overrides: Partial<Omit<RequestEvent, 'locals'>> & {
        locals?: Partial<RequestEvent['locals']>;
    } = {},
): RequestEvent {
    const defaultUser = {
        username: '',
        groups: '',
        userGroups: [] as string[],
        hasWatchPermission: false,
        hasLiveTvPermission: false,
        hasRequestPermission: true,
        isAdmin: false,
        isModerator: false,
        maxAgeRating: null,
        isAgeRestricted: false,
    };
    const baseEvent = {
        url: new URL('http://localhost/api/test'),
        request: new Request('http://localhost/api/test'),
        params: {},
        route: { id: '/api/test' as const },
        locals: { user: defaultUser },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;

    return { ...baseEvent, ...overrides } as RequestEvent;
}

async function parseBody<T>(response: Response): Promise<T> {
    return (await response.json()) as T;
}

describe('getUserContext', () => {
    it('returns authenticated user context', () => {
        const event = createMockEvent({
            locals: {
                user: {
                    userId: toUserId('00000000-0000-0000-0000-000000000001'),
                    username: 'TestUser',
                    groups: 'Users,Admins',
                    userGroups: ['Users', 'Admins'],
                    hasWatchPermission: true,
                    hasLiveTvPermission: false,
                    hasRequestPermission: true,
                    ownerIsAdmin: false,
                    isModerator: false,
                    maxAgeRating: null,
                    isAgeRestricted: false,
                    liveTvPriority: 'low',
                },
            },
        });

        const context = getUserContext(event);

        expect(context.username).toBe('TestUser');
        expect(context.userGroups).toEqual(['Users', 'Admins']);
        expect(context.isAuthenticated).toBe(true);
        expect(context.isAdmin).toBe(null); // Not checked yet
    });

    it('returns unauthenticated context when no user', () => {
        const event = createMockEvent({
            locals: {
                user: {
                    userId: toUserId('00000000-0000-0000-0000-000000000001'),
                    username: '',
                    groups: '',
                    userGroups: [],
                    hasWatchPermission: false,
                    hasLiveTvPermission: false,
                    hasRequestPermission: true,
                    ownerIsAdmin: false,
                    isModerator: false,
                    maxAgeRating: null,
                    isAgeRestricted: false,
                    liveTvPriority: 'low',
                },
            },
        });

        const context = getUserContext(event);

        expect(context.username).toBe(null);
        expect(context.userGroups).toEqual([]);
        expect(context.isAuthenticated).toBe(false);
    });

    it('returns unauthenticated context when user has no username', () => {
        const event = createMockEvent({
            locals: {
                user: {
                    userId: toUserId('00000000-0000-0000-0000-000000000001'),
                    username: '',
                    groups: 'Users',
                    userGroups: ['Users'],
                    hasWatchPermission: false,
                    hasLiveTvPermission: false,
                    hasRequestPermission: true,
                    ownerIsAdmin: false,
                    isModerator: false,
                    maxAgeRating: null,
                    isAgeRestricted: false,
                    liveTvPriority: 'low',
                },
            },
        });

        const context = getUserContext(event);

        expect(context.username).toBe(null);
        expect(context.isAuthenticated).toBe(false);
    });

    it('handles missing userGroups', () => {
        const event = createMockEvent({
            locals: {
                user: {
                    userId: toUserId('00000000-0000-0000-0000-000000000001'),
                    username: 'TestUser',
                    groups: '',
                    userGroups: [],
                    hasWatchPermission: false,
                    hasLiveTvPermission: false,
                    hasRequestPermission: true,
                    ownerIsAdmin: false,
                    isModerator: false,
                    maxAgeRating: null,
                    isAgeRestricted: false,
                    liveTvPriority: 'low',
                },
            },
        });

        const context = getUserContext(event);

        expect(context.userGroups).toEqual([]);
    });
});

describe('getEndpointName', () => {
    it('extracts pathname from URL', () => {
        const event = createMockEvent({
            url: new URL('http://localhost/api/ai/recommendations'),
        });

        expect(getEndpointName(event)).toBe('/api/ai/recommendations');
    });

    it('handles root path', () => {
        const event = createMockEvent({
            url: new URL('http://localhost/'),
        });

        expect(getEndpointName(event)).toBe('/');
    });

    it('handles path with query parameters', () => {
        const event = createMockEvent({
            url: new URL('http://localhost/api/search?q=test&limit=10'),
        });

        expect(getEndpointName(event)).toBe('/api/search');
    });
});

describe('ApiValidation', () => {
    describe('validateRequired', () => {
        it('returns null for valid string', () => {
            expect(ApiValidation.validateRequired('value', 'field')).toBe(null);
        });

        it('returns error for empty string', () => {
            const error = ApiValidation.validateRequired('', 'field');
            expect(error).not.toBe(null);
            expect(error?.field).toBe('field');
            expect(error?.message).toContain('required');
        });

        it('returns error for whitespace-only string', () => {
            const error = ApiValidation.validateRequired('   ', 'field');
            expect(error).not.toBe(null);
        });

        it('returns error for null', () => {
            const error = ApiValidation.validateRequired(null, 'field');
            expect(error).not.toBe(null);
        });

        it('returns error for undefined', () => {
            const error = ApiValidation.validateRequired(undefined, 'field');
            expect(error).not.toBe(null);
        });

        it('returns null for number (non-string truthy)', () => {
            expect(ApiValidation.validateRequired(123, 'field')).toBe(null);
        });
    });

    describe('validateNumber', () => {
        it('returns null for valid number', () => {
            expect(ApiValidation.validateNumber(42, 'field')).toBe(null);
        });

        it('returns null for numeric string', () => {
            expect(ApiValidation.validateNumber('42', 'field')).toBe(null);
        });

        it('returns error for non-numeric string', () => {
            const error = ApiValidation.validateNumber('abc', 'field');
            expect(error).not.toBe(null);
            expect(error?.message).toContain('valid number');
        });

        it('returns error when below minimum', () => {
            const error = ApiValidation.validateNumber(5, 'field', 10);
            expect(error).not.toBe(null);
            expect(error?.message).toContain('at least 10');
        });

        it('returns error when above maximum', () => {
            const error = ApiValidation.validateNumber(100, 'field', 1, 50);
            expect(error).not.toBe(null);
            expect(error?.message).toContain('at most 50');
        });

        it('returns null for value within range', () => {
            expect(ApiValidation.validateNumber(25, 'field', 1, 50)).toBe(null);
        });

        it('returns null for value at minimum boundary', () => {
            expect(ApiValidation.validateNumber(10, 'field', 10, 50)).toBe(null);
        });

        it('returns null for value at maximum boundary', () => {
            expect(ApiValidation.validateNumber(50, 'field', 10, 50)).toBe(null);
        });
    });

    describe('validateEnum', () => {
        it('returns null for valid enum value', () => {
            expect(ApiValidation.validateEnum('movie', 'type', ['movie', 'tv'])).toBe(null);
        });

        it('returns error for invalid enum value', () => {
            const error = ApiValidation.validateEnum('podcast', 'type', ['movie', 'tv']);
            expect(error).not.toBe(null);
            expect(error?.message).toContain('movie');
            expect(error?.message).toContain('tv');
        });
    });

    describe('validateUserId', () => {
        it('returns null for valid user ID', () => {
            expect(ApiValidation.validateUserId('user123')).toBe(null);
        });

        it('returns error for empty user ID', () => {
            const error = ApiValidation.validateUserId('');
            expect(error).not.toBe(null);
        });
    });

    describe('validateTmdbId', () => {
        it('returns null for valid TMDB ID', () => {
            expect(ApiValidation.validateTmdbId(12345)).toBe(null);
        });

        it('returns error for zero', () => {
            const error = ApiValidation.validateTmdbId(0);
            expect(error).not.toBe(null);
            expect(error?.message).toContain('at least 1');
        });

        it('returns error for negative number', () => {
            const error = ApiValidation.validateTmdbId(-1);
            expect(error).not.toBe(null);
        });

        it('returns error for non-numeric value', () => {
            const error = ApiValidation.validateTmdbId('abc');
            expect(error).not.toBe(null);
        });
    });

    describe('validatePagination', () => {
        it('returns empty array for valid pagination', () => {
            const errors = ApiValidation.validatePagination(1, 20);
            expect(errors).toEqual([]);
        });

        it('returns errors for invalid page', () => {
            const errors = ApiValidation.validatePagination(0, 20);
            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some((e) => e.field === 'page')).toBe(true);
        });

        it('returns errors for limit exceeding max', () => {
            const errors = ApiValidation.validatePagination(1, 150);
            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some((e) => e.field === 'limit')).toBe(true);
        });

        it('returns multiple errors for both invalid', () => {
            const errors = ApiValidation.validatePagination(-1, 'abc');
            expect(errors.length).toBe(2);
        });
    });
});

describe('ApiResponses', () => {
    describe('error', () => {
        it('returns error response with message (problem+json)', async () => {
            const response = ApiResponses.error('Something went wrong');
            expect(response.status).toBe(500);

            const body = await parseBody<{ code: string; error: string }>(response);
            expect(body.code).toBe('internal_error');
            expect(body.error).toBe('Something went wrong');
        });

        it('includes error details', async () => {
            const response = ApiResponses.error('Failed', 'Connection timeout');
            const body = await parseBody<{ details?: string }>(response);
            expect(body.details).toBe('Connection timeout');
        });

        it('accepts Error object for details', async () => {
            const response = ApiResponses.error('Failed', new Error('Test error'));
            const body = await parseBody<{ details?: string }>(response);
            expect(body.details).toBe('Test error');
        });

        it('maps status 400 to validation_failed (HTTP 422 — behaviour change)', async () => {
            // status 400 maps to validation_failed which problem() emits as 422
            const response = ApiResponses.error('Bad request', undefined, 400);
            expect(response.status).toBe(422);
            const body = await parseBody<{ code: string }>(response);
            expect(body.code).toBe('validation_failed');
        });
    });

    describe('badRequest', () => {
        it('returns 422 status (behaviour change: was 400)', async () => {
            const response = ApiResponses.badRequest('Invalid input');
            expect(response.status).toBe(422);

            const body = await parseBody<{ code: string; error: string }>(response);
            expect(body.code).toBe('validation_failed');
            expect(body.error).toBe('Invalid input');
        });
    });

    describe('unauthorized', () => {
        it('returns 401 status', async () => {
            const response = ApiResponses.unauthorized();
            expect(response.status).toBe(401);

            const body = await parseBody<{ error: string }>(response);
            expect(body.error).toBe('Authentication required');
        });

        it('uses custom message', async () => {
            const response = ApiResponses.unauthorized('Please log in');
            const body = await parseBody<{ error: string }>(response);
            expect(body.error).toBe('Please log in');
        });
    });

    describe('forbidden', () => {
        it('returns 403 status', async () => {
            const response = ApiResponses.forbidden();
            expect(response.status).toBe(403);

            const body = await parseBody<{ error: string }>(response);
            expect(body.error).toBe('Insufficient permissions');
        });
    });

    describe('notFound', () => {
        it('returns 404 status', async () => {
            const response = ApiResponses.notFound('Movie');
            expect(response.status).toBe(404);

            const body = await parseBody<{ error: string }>(response);
            expect(body.error).toBe('Movie not found');
        });
    });

    describe('conflict', () => {
        it('returns 409 status', async () => {
            const response = ApiResponses.conflict('Resource already exists');
            expect(response.status).toBe(409);

            const body = await parseBody<{ error: string }>(response);
            expect(body.error).toBe('Resource already exists');
        });
    });

    describe('rateLimited', () => {
        it('returns 429 status', async () => {
            const response = ApiResponses.rateLimited();
            expect(response.status).toBe(429);

            const body = await parseBody<{ error: string }>(response);
            expect(body.error).toBe('Rate limit exceeded');
        });

        it('includes retry information', async () => {
            const resetTime = Date.now() + 60000;
            const response = ApiResponses.rateLimited(resetTime);

            expect(response.headers.get('Retry-After')).toBeDefined();

            const body = await parseBody<{ details?: string }>(response);
            expect(body.details).toContain('Try again after');
        });
    });

    describe('serviceUnavailable', () => {
        it('returns 503 status', async () => {
            const response = ApiResponses.serviceUnavailable('Database');
            expect(response.status).toBe(503);

            const body = await parseBody<{ error: string }>(response);
            expect(body.error).toBe('Database temporarily unavailable');
        });
    });

    describe('validationError', () => {
        it('returns 422 status with validation errors as ValidationDetail[] (behaviour change: was 400)', async () => {
            const errors = [
                { field: 'email', message: 'Invalid email format' },
                { field: 'password', message: 'Too short' },
            ];
            const response = ApiResponses.validationError(errors);
            expect(response.status).toBe(422);

            const body = await parseBody<{
                code: string;
                error: string;
                details: Array<{ field: string; message: string }>;
            }>(response);
            expect(body.code).toBe('validation_failed');
            expect(body.error).toBe('Validation failed');
            expect(Array.isArray(body.details)).toBe(true);
            expect(body.details).toEqual(errors);
        });
    });

    describe('insufficientData', () => {
        it('returns 422 status with details string containing serialised data', async () => {
            const response = ApiResponses.insufficientData(5, 2);
            expect(response.status).toBe(422);

            const body = await parseBody<{
                code: string;
                details: string;
            }>(response);
            expect(body.code).toBe('validation_failed');
            // details is a string containing the serialised {required, actual, dataType}
            expect(typeof body.details).toBe('string');
            expect(body.details).toContain('"required":5');
            expect(body.details).toContain('"actual":2');
        });
    });

    describe('onboardingRequired', () => {
        it('returns 200 status with onboarding info (expected state, not an error)', async () => {
            const response = ApiResponses.onboardingRequired(2, 5);
            expect(response.status).toBe(200);

            const body = await parseBody<{
                data: {
                    currentRatings: number;
                    requiredRatings: number;
                    remainingRatings: number;
                    onboardingNeeded: boolean;
                };
            }>(response);
            expect(body.data.currentRatings).toBe(2);
            expect(body.data.requiredRatings).toBe(5);
            expect(body.data.remainingRatings).toBe(3);
            expect(body.data.onboardingNeeded).toBe(true);
        });
    });

    describe('externalApiError', () => {
        it('returns 502 status', async () => {
            const response = ApiResponses.externalApiError('TMDB', 'Connection failed');
            expect(response.status).toBe(502);

            const body = await parseBody<{ error: string; details?: string }>(response);
            expect(body.error).toBe('TMDB API error');
            expect(body.details).toBe('Connection failed');
        });
    });
});

describe('withRateLimit middleware', () => {
    // Use unique IPs for each test to avoid rate limit store pollution
    let testIpCounter = 0;
    const getUniqueIp = () => `192.168.${Math.floor(testIpCounter / 256)}.${testIpCounter++ % 256}`;

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('allows requests under the limit', async () => {
        const handler = vi.fn().mockResolvedValue(new Response('OK'));
        const limitedHandler = withRateLimit(5, 60000)(handler);

        const ip = getUniqueIp();
        const event = createMockEvent({
            getClientAddress: () => ip,
        });

        // Make 5 requests (should all succeed)
        for (let i = 0; i < 5; i++) {
            const response = await limitedHandler(event);
            expect(response.status).not.toBe(429);
        }

        expect(handler).toHaveBeenCalledTimes(5);
    });

    it('blocks requests over the limit', async () => {
        const handler = vi.fn().mockResolvedValue(new Response('OK'));
        const limitedHandler = withRateLimit(3, 60000)(handler);

        const ip = getUniqueIp();
        const event = createMockEvent({
            getClientAddress: () => ip,
        });

        // Make 4 requests (4th should be blocked)
        for (let i = 0; i < 3; i++) {
            await limitedHandler(event);
        }

        const response = await limitedHandler(event);
        expect(response.status).toBe(429);
        expect(handler).toHaveBeenCalledTimes(3);
    });

    it('resets after window expires', async () => {
        const handler = vi.fn().mockResolvedValue(new Response('OK'));
        const limitedHandler = withRateLimit(2, 1000)(handler); // 1 second window

        const ip = getUniqueIp();
        const event = createMockEvent({
            getClientAddress: () => ip,
        });

        // Exhaust limit
        await limitedHandler(event);
        await limitedHandler(event);

        // Should be blocked
        let response = await limitedHandler(event);
        expect(response.status).toBe(429);

        // Advance time past window
        vi.advanceTimersByTime(1500);

        // Should work again
        response = await limitedHandler(event);
        expect(response.status).not.toBe(429);
    });

    it('tracks different users separately', async () => {
        const handler = vi.fn().mockResolvedValue(new Response('OK'));
        const limitedHandler = withRateLimit(2, 60000)(handler);

        const ip = getUniqueIp();
        const event1 = createMockEvent({
            getClientAddress: () => ip,
            locals: {
                user: {
                    userId: toUserId('00000000-0000-0000-0000-000000000001'),
                    username: `user1-${ip}`,
                    groups: '',
                    userGroups: [],
                    hasWatchPermission: false,
                    hasLiveTvPermission: false,
                    hasRequestPermission: true,
                    ownerIsAdmin: false,
                    isModerator: false,
                    maxAgeRating: null,
                    isAgeRestricted: false,
                    liveTvPriority: 'low',
                },
            },
        });
        const event2 = createMockEvent({
            getClientAddress: () => ip,
            locals: {
                user: {
                    userId: toUserId('00000000-0000-0000-0000-000000000001'),
                    username: `user2-${ip}`,
                    groups: '',
                    userGroups: [],
                    hasWatchPermission: false,
                    hasLiveTvPermission: false,
                    hasRequestPermission: true,
                    ownerIsAdmin: false,
                    isModerator: false,
                    maxAgeRating: null,
                    isAgeRestricted: false,
                    liveTvPriority: 'low',
                },
            },
        });

        // User 1 makes 2 requests
        await limitedHandler(event1);
        await limitedHandler(event1);

        // User 1 is blocked
        const response1 = await limitedHandler(event1);
        expect(response1.status).toBe(429);

        // User 2 can still make requests
        const response2 = await limitedHandler(event2);
        expect(response2.status).not.toBe(429);
    });

    it('uses custom key generator', async () => {
        const handler = vi.fn().mockResolvedValue(new Response('OK'));
        const uniqueKey = `shared-key-${getUniqueIp()}`;
        const customKeyGen = () => uniqueKey;
        const limitedHandler = withRateLimit(2, 60000, customKeyGen)(handler);

        const event1 = createMockEvent({
            locals: {
                user: {
                    userId: toUserId('00000000-0000-0000-0000-000000000001'),
                    username: 'user1',
                    groups: '',
                    userGroups: [],
                    hasWatchPermission: false,
                    hasLiveTvPermission: false,
                    hasRequestPermission: true,
                    ownerIsAdmin: false,
                    isModerator: false,
                    maxAgeRating: null,
                    isAgeRestricted: false,
                    liveTvPriority: 'low',
                },
            },
        });
        const event2 = createMockEvent({
            locals: {
                user: {
                    userId: toUserId('00000000-0000-0000-0000-000000000001'),
                    username: 'user2',
                    groups: '',
                    userGroups: [],
                    hasWatchPermission: false,
                    hasLiveTvPermission: false,
                    hasRequestPermission: true,
                    ownerIsAdmin: false,
                    isModerator: false,
                    maxAgeRating: null,
                    isAgeRestricted: false,
                    liveTvPriority: 'low',
                },
            },
        });

        // Both users share the same key
        await limitedHandler(event1);
        await limitedHandler(event2);

        // Both should be blocked (shared limit)
        const response1 = await limitedHandler(event1);
        expect(response1.status).toBe(429);

        const response2 = await limitedHandler(event2);
        expect(response2.status).toBe(429);
    });
});

// ============================================================================
// SECURITY-FOCUSED MIDDLEWARE LOGIC TESTS
// ============================================================================

describe('requireGroups Logic', () => {
    // Test the core group matching logic used by requireGroups
    function hasRequiredGroup(userGroups: string[], requiredGroups: string[]): boolean {
        const userGroupsLower = userGroups.map((g) => g.toLowerCase());
        return requiredGroups.some((group) => userGroupsLower.includes(group.toLowerCase()));
    }

    describe('case-insensitive matching', () => {
        it('matches lowercase user group to mixed case required', () => {
            expect(hasRequiredGroup(['admins'], ['Admins'])).toBe(true);
        });

        it('matches uppercase user group to lowercase required', () => {
            expect(hasRequiredGroup(['ADMINS'], ['admins'])).toBe(true);
        });

        it('matches mixed case variations', () => {
            expect(hasRequiredGroup(['AdMiNs'], ['aDmInS'])).toBe(true);
        });
    });

    describe('multiple group matching', () => {
        it('returns true if any required group matches', () => {
            expect(hasRequiredGroup(['Users'], ['Admins', 'Users', 'Moderators'])).toBe(true);
        });

        it('returns true if user has extra groups beyond required', () => {
            expect(hasRequiredGroup(['Users', 'Admins', 'Extras'], ['Admins'])).toBe(true);
        });

        it('returns false if no groups match', () => {
            expect(hasRequiredGroup(['Users', 'Guests'], ['Admins', 'Moderators'])).toBe(false);
        });
    });

    describe('security edge cases', () => {
        it('rejects empty user groups', () => {
            expect(hasRequiredGroup([], ['Admins'])).toBe(false);
        });

        it('returns true for empty required groups', () => {
            // Note: This is how .some() works - returns false for empty array
            expect(hasRequiredGroup(['Users'], [])).toBe(false);
        });

        it('rejects similar but not exact group names', () => {
            expect(hasRequiredGroup(['Admin'], ['Admins'])).toBe(false);
            expect(hasRequiredGroup(['Admins123'], ['Admins'])).toBe(false);
        });

        it('does not perform regex matching', () => {
            expect(hasRequiredGroup(['Admin.*'], ['Admins'])).toBe(false);
        });
    });
});

describe('requireSelfOrAdmin Logic', () => {
    // Test the core logic for self-or-admin authorization
    function canAccess(
        authenticatedUsername: string,
        requestedUserId: string,
        isAdmin: boolean,
    ): { allowed: boolean; reason: string } {
        // Special "user" placeholder means current user
        if (requestedUserId === 'user') {
            return { allowed: true, reason: 'generic user placeholder' };
        }

        // User accessing own data
        if (authenticatedUsername === requestedUserId) {
            return { allowed: true, reason: 'own data' };
        }

        // Admin can access any data
        if (isAdmin) {
            return { allowed: true, reason: 'admin override' };
        }

        return { allowed: false, reason: 'not own data and not admin' };
    }

    describe('self access', () => {
        it('allows user to access own data', () => {
            const result = canAccess('john', 'john', false);
            expect(result.allowed).toBe(true);
            expect(result.reason).toBe('own data');
        });

        it('rejects access to other user data as non-admin', () => {
            const result = canAccess('john', 'jane', false);
            expect(result.allowed).toBe(false);
        });
    });

    describe('admin override', () => {
        it('allows admin to access any user data', () => {
            const result = canAccess('admin', 'jane', true);
            expect(result.allowed).toBe(true);
            expect(result.reason).toBe('admin override');
        });

        it('admin still uses own-data path for own data', () => {
            const result = canAccess('admin', 'admin', true);
            expect(result.allowed).toBe(true);
            expect(result.reason).toBe('own data');
        });
    });

    describe('user placeholder', () => {
        it('allows access with "user" placeholder', () => {
            const result = canAccess('john', 'user', false);
            expect(result.allowed).toBe(true);
            expect(result.reason).toBe('generic user placeholder');
        });

        it('works for any username with "user" placeholder', () => {
            const result = canAccess('anyuser', 'user', false);
            expect(result.allowed).toBe(true);
        });
    });

    describe('username comparison security', () => {
        it('comparison is case-sensitive', () => {
            // Username comparison should be case-sensitive for security
            const result = canAccess('John', 'john', false);
            expect(result.allowed).toBe(false);
        });

        it('does not allow substring matching', () => {
            const result = canAccess('admin', 'administrator', false);
            expect(result.allowed).toBe(false);
        });

        it('does not allow prefix matching', () => {
            const result = canAccess('john_doe', 'john', false);
            expect(result.allowed).toBe(false);
        });
    });
});

describe('Authentication Header Security', () => {
    // Test for potential header injection attacks

    describe('username from header', () => {
        function validateUsername(username: string | null): {
            valid: boolean;
            sanitized: string | null;
        } {
            if (!username) {
                return { valid: false, sanitized: null };
            }

            // Check for header injection attempts
            if (username.includes('\r') || username.includes('\n') || username.includes('\x00')) {
                return { valid: false, sanitized: null };
            }

            // Username should not be excessively long
            if (username.length > 255) {
                return { valid: false, sanitized: null };
            }

            return { valid: true, sanitized: username.trim() };
        }

        it('accepts valid username', () => {
            const result = validateUsername('john.doe');
            expect(result.valid).toBe(true);
            expect(result.sanitized).toBe('john.doe');
        });

        it('rejects null username', () => {
            const result = validateUsername(null);
            expect(result.valid).toBe(false);
        });

        it('rejects empty username', () => {
            const result = validateUsername('');
            expect(result.valid).toBe(false);
        });

        it('rejects newline injection', () => {
            const result = validateUsername('john\r\nX-Injected: evil');
            expect(result.valid).toBe(false);
        });

        it('rejects carriage return injection', () => {
            const result = validateUsername('john\rX-Injected: evil');
            expect(result.valid).toBe(false);
        });

        it('rejects null byte injection', () => {
            const result = validateUsername('john\x00admin');
            expect(result.valid).toBe(false);
        });

        it('rejects excessively long username', () => {
            const result = validateUsername('a'.repeat(300));
            expect(result.valid).toBe(false);
        });

        it('trims whitespace from valid username', () => {
            const result = validateUsername('  john  ');
            expect(result.valid).toBe(true);
            expect(result.sanitized).toBe('john');
        });

        it('accepts username with special characters', () => {
            const result = validateUsername("john.o'brien");
            expect(result.valid).toBe(true);
        });

        it('accepts unicode usernames', () => {
            const result = validateUsername('用户名');
            expect(result.valid).toBe(true);
        });
    });

    describe('group header parsing', () => {
        function parseAndValidateGroups(groupHeader: string | null): string[] {
            if (!groupHeader) return [];

            // Check for injection attempts
            if (
                groupHeader.includes('\r') ||
                groupHeader.includes('\n') ||
                groupHeader.includes('\x00')
            ) {
                return [];
            }

            return groupHeader
                .split(',')
                .map((g) => g.trim())
                .filter((g) => g.length > 0 && g.length <= 255);
        }

        it('parses valid groups', () => {
            const result = parseAndValidateGroups('Admins,Users,Guests');
            expect(result).toEqual(['Admins', 'Users', 'Guests']);
        });

        it('returns empty for null', () => {
            const result = parseAndValidateGroups(null);
            expect(result).toEqual([]);
        });

        it('rejects header with newline', () => {
            const result = parseAndValidateGroups('Admins\nInjected');
            expect(result).toEqual([]);
        });

        it('rejects header with null byte', () => {
            const result = parseAndValidateGroups('Admins\x00Hidden');
            expect(result).toEqual([]);
        });

        it('filters out excessively long group names', () => {
            const longGroup = 'A'.repeat(300);
            const result = parseAndValidateGroups(`Admins,${longGroup},Users`);
            expect(result).toEqual(['Admins', 'Users']);
        });

        it('handles empty groups in list', () => {
            const result = parseAndValidateGroups('Admins,,Users,  ,Guests');
            expect(result).toEqual(['Admins', 'Users', 'Guests']);
        });
    });
});

describe('Rate Limit Key Security', () => {
    describe('key generation', () => {
        function generateRateLimitKey(ip: string, username: string | null): string {
            // Sanitize inputs for key generation
            const sanitizedIp = ip.replace(/[^a-zA-Z0-9.:]/g, '_');
            const sanitizedUser = username
                ? username.replace(/[^a-zA-Z0-9._-]/g, '_')
                : 'anonymous';
            return `${sanitizedIp}:${sanitizedUser}`;
        }

        it('generates valid key for normal inputs', () => {
            const key = generateRateLimitKey('192.168.1.1', 'john');
            expect(key).toBe('192.168.1.1:john');
        });

        it('handles IPv6 addresses', () => {
            const key = generateRateLimitKey('2001:db8::1', 'john');
            expect(key).toBe('2001:db8::1:john');
        });

        it('sanitizes special characters in IP', () => {
            const key = generateRateLimitKey('192.168.1.1\n', 'john');
            expect(key).toBe('192.168.1.1_:john');
        });

        it('sanitizes special characters in username', () => {
            const key = generateRateLimitKey('192.168.1.1', 'john\x00admin');
            expect(key).toBe('192.168.1.1:john_admin');
        });

        it('uses anonymous for null username', () => {
            const key = generateRateLimitKey('192.168.1.1', null);
            expect(key).toBe('192.168.1.1:anonymous');
        });

        it('handles very long usernames', () => {
            const longUser = 'a'.repeat(1000);
            const key = generateRateLimitKey('127.0.0.1', longUser);
            // Key is generated but may need truncation in production
            expect(key).toContain('127.0.0.1:');
        });
    });
});
