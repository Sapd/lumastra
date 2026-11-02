// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { problem, ApiProblem, paginate } from './problem.js';
import type { ProblemCode, ValidationDetail } from './problem.js';

// ---------------------------------------------------------------------------
// problem() — core builder
// ---------------------------------------------------------------------------

describe('problem(): core builder', () => {
    it('sets Content-Type to application/problem+json', async () => {
        const res = problem('not_found');
        expect(res.headers.get('content-type')).toMatch('application/problem+json');
    });

    it.each<[ProblemCode, number]>([
        ['unauthorized', 401],
        ['invalid_token', 401],
        ['forbidden', 403],
        ['scope_required', 403],
        ['not_found', 404],
        ['conflict', 409],
        ['gone', 410],
        ['validation_failed', 422],
        ['rate_limited', 429],
        ['internal_error', 500],
        ['bad_gateway', 502],
        ['dependency_unavailable', 503],
        ['server_id_unavailable', 503],
        ['shutting_down', 503],
    ])('code=%s → HTTP status %i', async (code, expectedStatus) => {
        const res = problem(code);
        expect(res.status).toBe(expectedStatus);
        const body = (await res.json()) as { code: string; status: number };
        expect(body.code).toBe(code);
        expect(body.status).toBe(expectedStatus);
    });

    it('uses default error message when none supplied', async () => {
        const res = problem('not_found');
        const body = (await res.json()) as { error: string };
        expect(body.error).toBeTruthy();
        expect(typeof body.error).toBe('string');
    });

    it('uses supplied error message when provided', async () => {
        const res = problem('not_found', { error: 'Series xyz not found' });
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe('Series xyz not found');
    });

    it('includes details when provided as string', async () => {
        const res = problem('validation_failed', { details: 'limit must be positive' });
        const body = (await res.json()) as { details: unknown };
        expect(body.details).toBe('limit must be positive');
    });

    it('includes details when provided as ValidationDetail array', async () => {
        const details: ValidationDetail[] = [{ field: 'limit', message: 'Must be > 0' }];
        const res = problem('validation_failed', { details });
        const body = (await res.json()) as { details: ValidationDetail[] };
        expect(Array.isArray(body.details)).toBe(true);
        expect((body.details as ValidationDetail[])[0].field).toBe('limit');
    });

    it('omits details field when not provided', async () => {
        const res = problem('forbidden');
        const body = (await res.json()) as Record<string, unknown>;
        expect('details' in body).toBe(false);
    });

    it('includes requestId when provided', async () => {
        const res = problem('internal_error', { requestId: 'req-abc-123' });
        const body = (await res.json()) as { requestId: string };
        expect(body.requestId).toBe('req-abc-123');
    });

    it('omits requestId when not provided', async () => {
        const res = problem('internal_error');
        const body = (await res.json()) as Record<string, unknown>;
        expect('requestId' in body).toBe(false);
    });

    it('sets Retry-After header and body field when retryAfter provided', async () => {
        const res = problem('rate_limited', { retryAfter: 60 });
        expect(res.headers.get('Retry-After')).toBe('60');
        const body = (await res.json()) as { retryAfter: number };
        expect(body.retryAfter).toBe(60);
    });

    it('does not set Retry-After header when retryAfter is absent', async () => {
        const res = problem('rate_limited');
        expect(res.headers.get('Retry-After')).toBeNull();
    });

    it('forwards extra headers', async () => {
        const res = problem('forbidden', { headers: { 'X-Custom': 'value' } });
        expect(res.headers.get('X-Custom')).toBe('value');
    });
});

// ---------------------------------------------------------------------------
// ApiProblem.* shortcuts
// ---------------------------------------------------------------------------

describe('ApiProblem shortcuts', () => {
    it('unauthorized() → 401', async () => {
        const res = ApiProblem.unauthorized();
        expect(res.status).toBe(401);
        const body = (await res.json()) as { code: string };
        expect(body.code).toBe('unauthorized');
    });

    it('invalidToken() → 401 invalid_token', async () => {
        const res = ApiProblem.invalidToken('Token expired');
        expect(res.status).toBe(401);
        const body = (await res.json()) as { code: string; error: string };
        expect(body.code).toBe('invalid_token');
        expect(body.error).toBe('Token expired');
    });

    it('forbidden() → 403', async () => {
        const res = ApiProblem.forbidden();
        expect(res.status).toBe(403);
    });

    it('scopeRequired() → 403 scope_required with scope list', async () => {
        const res = ApiProblem.scopeRequired(['tasks:run', 'admin']);
        expect(res.status).toBe(403);
        const body = (await res.json()) as { code: string; error: string };
        expect(body.code).toBe('scope_required');
        expect(body.error).toContain('tasks:run');
        expect(body.error).toContain('admin');
    });

    it('notFound() → 404', async () => {
        const res = ApiProblem.notFound('Series not found');
        expect(res.status).toBe(404);
        const body = (await res.json()) as { code: string; error: string };
        expect(body.code).toBe('not_found');
        expect(body.error).toBe('Series not found');
    });

    it('conflict() → 409', async () => {
        const res = ApiProblem.conflict();
        expect(res.status).toBe(409);
    });

    it('gone() → 410', async () => {
        const res = ApiProblem.gone();
        expect(res.status).toBe(410);
    });

    it('validationFailed() → 422 with details array', async () => {
        const details: ValidationDetail[] = [{ field: 'offset', message: 'Must be >= 0' }];
        const res = ApiProblem.validationFailed(details);
        expect(res.status).toBe(422);
        const body = (await res.json()) as { code: string; details: ValidationDetail[] };
        expect(body.code).toBe('validation_failed');
        expect(body.details[0].field).toBe('offset');
    });

    it('validationFailed(string) → 422 promotes reason to `error` (clients read error, not details)', async () => {
        const res = ApiProblem.validationFailed("User 'test' not found");
        expect(res.status).toBe(422);
        const body = (await res.json()) as { code: string; error: string; details?: unknown };
        expect(body.code).toBe('validation_failed');
        // The human reason must land in `error` — that is the field the client surfaces.
        expect(body.error).toBe("User 'test' not found");
        // It must NOT be buried in structured `details` (that is for field-level errors).
        expect('details' in body).toBe(false);
    });

    it('rateLimited() → 429 with Retry-After header', async () => {
        const res = ApiProblem.rateLimited(30);
        expect(res.status).toBe(429);
        expect(res.headers.get('Retry-After')).toBe('30');
    });

    it('rateLimited() without retryAfter has no Retry-After header', async () => {
        const res = ApiProblem.rateLimited();
        expect(res.headers.get('Retry-After')).toBeNull();
    });

    it('internalError() → 500', async () => {
        const res = ApiProblem.internalError();
        expect(res.status).toBe(500);
    });

    it('badGateway() → 502', async () => {
        const res = ApiProblem.badGateway();
        expect(res.status).toBe(502);
    });

    it('dependencyUnavailable() → 503', async () => {
        const res = ApiProblem.dependencyUnavailable('Postgres is down');
        expect(res.status).toBe(503);
        const body = (await res.json()) as { code: string; error: string };
        expect(body.code).toBe('dependency_unavailable');
        expect(body.error).toBe('Postgres is down');
    });
});

// ---------------------------------------------------------------------------
// paginate() — collection envelope
// ---------------------------------------------------------------------------

describe('paginate()', () => {
    it('wraps items and page block', () => {
        const items = [{ id: '1' }, { id: '2' }];
        const page = { limit: 20, offset: 0, hasMore: false };
        const result = paginate(items, page);
        expect(result.items).toStrictEqual(items);
        expect(result.page).toStrictEqual(page);
    });

    it('preserves all page fields including optional ones', () => {
        const page = {
            limit: 10,
            offset: 20,
            hasMore: true,
            total: 150,
        };
        const result = paginate([], page);
        expect(result.page.total).toBe(150);
        expect(result.page.hasMore).toBe(true);
    });

    it('works with cursor-based paging', () => {
        const page = {
            limit: 25,
            nextCursor: 'eyJpZCI6IjEwMCJ9',
            hasMore: true,
        };
        const result = paginate(['a', 'b'], page);
        expect(result.page.nextCursor).toBe('eyJpZCI6IjEwMCJ9');
        expect('offset' in result.page).toBe(false);
    });

    it('returns an empty items array correctly', () => {
        const result = paginate([], { limit: 20, offset: 0, hasMore: false });
        expect(result.items).toStrictEqual([]);
        expect(result.page.hasMore).toBe(false);
    });
});
