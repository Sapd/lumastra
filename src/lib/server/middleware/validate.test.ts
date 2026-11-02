// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for withValidation middleware
 *
 * Tests request body and params validation against Zod schemas,
 * verified data attachment, and error response formatting.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
    withValidation,
    withBodyValidation,
    withQueryValidation,
    withParamsValidation,
} from './validate';
import type { RequestEvent } from '@sveltejs/kit';

// ============================================================================
// Helpers
// ============================================================================

interface ValidationErrorBody {
    code: string;
    error: string;
    status: number;
    details: Array<{ field: string; message: string; value?: unknown }>;
}

function createMockEvent(overrides: Partial<RequestEvent> = {}): RequestEvent {
    const defaultUser = {
        username: 'testuser',
        groups: 'Users',
        userGroups: ['Users'] as string[],
        hasWatchPermission: true,
        hasLiveTvPermission: false,
        hasRequestPermission: true,
        isAdmin: false,
        isModerator: false,
        maxAgeRating: null,
        isAgeRestricted: false,
    };

    const baseEvent = {
        url: new URL('http://localhost/api/test'),
        request: new Request('http://localhost/api/test', {
            method: 'GET',
        }),
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

    return { ...baseEvent, ...overrides };
}

function createJsonRequest(body: unknown, method = 'POST'): Request {
    return new Request('http://localhost/api/test', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

async function parseBody<T>(response: Response): Promise<T> {
    return (await response.json()) as T;
}

// ============================================================================
// Body validation
// ============================================================================

describe('withValidation — body', () => {
    const nameSchema = z.object({ name: z.string().min(1) });

    it('valid body passes through and is available on event.validated.body', async () => {
        const handler = vi.fn().mockImplementation(({ validated }) => {
            return new Response(JSON.stringify(validated.body), {
                status: 200,
            });
        });

        const wrapped = withValidation(handler, { body: nameSchema });
        const event = createMockEvent({
            request: createJsonRequest({ name: 'Alice' }),
        });

        const response = await wrapped(event);

        expect(response.status).toBe(200);
        const body = await parseBody<{ name: string }>(response);
        expect(body.name).toBe('Alice');
        expect(handler).toHaveBeenCalledOnce();
    });

    it('invalid body returns 422 with validation error details', async () => {
        const handler = vi.fn();
        const wrapped = withValidation(handler, { body: nameSchema });
        const event = createMockEvent({
            request: createJsonRequest({ name: 42 }),
        });

        const response = await wrapped(event);

        expect(response.status).toBe(422);
        const body = await parseBody<ValidationErrorBody>(response);
        expect(body.code).toBe('validation_failed');
        expect(body.error).toBe('Validation failed');
        expect(body.details.length).toBeGreaterThan(0);
        expect(handler).not.toHaveBeenCalled();
    });

    it('missing required field returns 422', async () => {
        const handler = vi.fn();
        const wrapped = withValidation(handler, { body: nameSchema });
        const event = createMockEvent({
            request: createJsonRequest({}),
        });

        const response = await wrapped(event);

        expect(response.status).toBe(422);
        const body = await parseBody<ValidationErrorBody>(response);
        expect(body.details.some((e) => e.field.includes('name'))).toBe(true);
        expect(handler).not.toHaveBeenCalled();
    });

    it('handler is NOT called when body validation fails', async () => {
        const handler = vi.fn();
        const wrapped = withValidation(handler, { body: nameSchema });
        const event = createMockEvent({
            request: createJsonRequest({ name: '' }),
        });

        await wrapped(event);

        expect(handler).not.toHaveBeenCalled();
    });

    it('malformed JSON with Content-Type header returns 422', async () => {
        const handler = vi.fn();
        const wrapped = withValidation(handler, { body: nameSchema });
        const event = createMockEvent({
            request: new Request('http://localhost/api/test', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': '10',
                },
                body: 'not-json!!',
            }),
        });

        const response = await wrapped(event);

        expect(response.status).toBe(422);
        expect(handler).not.toHaveBeenCalled();
    });

    it('no body sent treats empty object and lets schema report missing fields', async () => {
        const handler = vi.fn();
        const wrapped = withValidation(handler, { body: nameSchema });
        const event = createMockEvent({
            request: new Request('http://localhost/api/test', {
                method: 'POST',
            }),
        });

        const response = await wrapped(event);

        expect(response.status).toBe(422);
        expect(handler).not.toHaveBeenCalled();
    });

    it('rejects a declared Content-Length over the default 256KB cap with 413, handler not called (C15)', async () => {
        const handler = vi.fn();
        const wrapped = withValidation(handler, { body: nameSchema });
        const event = createMockEvent({
            request: new Request('http://localhost/api/test', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': String(1_000_000),
                },
                body: JSON.stringify({ name: 'Alice' }),
            }),
        });

        const response = await wrapped(event);

        expect(response.status).toBe(413);
        const body = await parseBody<{ code: string }>(response);
        expect(body.code).toBe('payload_too_large');
        expect(handler).not.toHaveBeenCalled();
    });

    it('accepts a body over the default cap when an explicit maxBodyBytes override allows it', async () => {
        const handler = vi.fn().mockImplementation(({ validated }) => {
            return new Response(JSON.stringify(validated.body), { status: 200 });
        });
        const wrapped = withValidation(handler, { body: nameSchema, maxBodyBytes: 2_000_000 });
        const event = createMockEvent({
            request: new Request('http://localhost/api/test', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': String(1_000_000),
                },
                body: JSON.stringify({ name: 'Alice' }),
            }),
        });

        const response = await wrapped(event);

        expect(response.status).toBe(200);
        expect(handler).toHaveBeenCalled();
    });
});

// ============================================================================
// Params validation
// ============================================================================

describe('withValidation — params', () => {
    const idSchema = z.object({ id: z.string().uuid() });

    it('valid params pass through and are available on event.validated.params', async () => {
        const handler = vi.fn().mockImplementation(({ validated }) => {
            return new Response(JSON.stringify(validated.params), {
                status: 200,
            });
        });

        const wrapped = withValidation(handler, { params: idSchema });
        const event = createMockEvent({
            params: { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' },
        });

        const response = await wrapped(event);

        expect(response.status).toBe(200);
        const body = await parseBody<{ id: string }>(response);
        expect(body.id).toBe('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
        expect(handler).toHaveBeenCalledOnce();
    });

    it('invalid params return 422', async () => {
        const handler = vi.fn();
        const wrapped = withValidation(handler, { params: idSchema });
        const event = createMockEvent({
            params: { id: 'not-a-uuid' },
        });

        const response = await wrapped(event);

        expect(response.status).toBe(422);
        const body = await parseBody<ValidationErrorBody>(response);
        expect(body.code).toBe('validation_failed');
        expect(body.details.some((e) => e.field.includes('id'))).toBe(true);
        expect(handler).not.toHaveBeenCalled();
    });

    it('handler is NOT called when params validation fails', async () => {
        const handler = vi.fn();
        const wrapped = withValidation(handler, { params: idSchema });
        const event = createMockEvent({
            params: { id: 'bad' },
        });

        await wrapped(event);

        expect(handler).not.toHaveBeenCalled();
    });
});

// ============================================================================
// Query validation
// ============================================================================

describe('withValidation — query', () => {
    const paginationSchema = z.object({
        page: z.string().regex(/^\d+$/),
        limit: z.string().regex(/^\d+$/).optional(),
    });

    it('valid query params pass through and are available on event.validated.query', async () => {
        const handler = vi.fn().mockImplementation(({ validated }) => {
            return new Response(JSON.stringify(validated.query), {
                status: 200,
            });
        });

        const wrapped = withValidation(handler, { query: paginationSchema });
        const event = createMockEvent({
            url: new URL('http://localhost/api/test?page=2&limit=20'),
        });

        const response = await wrapped(event);

        expect(response.status).toBe(200);
        const body = await parseBody<{ page: string; limit?: string }>(response);
        expect(body.page).toBe('2');
        expect(body.limit).toBe('20');
        expect(handler).toHaveBeenCalledOnce();
    });

    it('invalid query params return 422', async () => {
        const handler = vi.fn();
        const wrapped = withValidation(handler, { query: paginationSchema });
        const event = createMockEvent({
            url: new URL('http://localhost/api/test?page=abc'),
        });

        const response = await wrapped(event);

        expect(response.status).toBe(422);
        const body = await parseBody<ValidationErrorBody>(response);
        expect(body.code).toBe('validation_failed');
        expect(handler).not.toHaveBeenCalled();
    });
});

// ============================================================================
// Combined body + params
// ============================================================================

describe('withValidation — combined body and params', () => {
    const bodySchema = z.object({ rating: z.number().min(1).max(5) });
    const paramsSchema = z.object({ id: z.string().uuid() });

    it('passes both valid body and params to handler', async () => {
        const handler = vi.fn().mockImplementation(({ validated }) => {
            return new Response(
                JSON.stringify({
                    body: validated.body,
                    params: validated.params,
                }),
                { status: 200 },
            );
        });

        const wrapped = withValidation(handler, {
            body: bodySchema,
            params: paramsSchema,
        });
        const event = createMockEvent({
            request: createJsonRequest({ rating: 4 }),
            params: { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' },
        });

        const response = await wrapped(event);

        expect(response.status).toBe(200);
        const body = await parseBody<{
            body: { rating: number };
            params: { id: string };
        }>(response);
        expect(body.body.rating).toBe(4);
        expect(body.params.id).toBe('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
        expect(handler).toHaveBeenCalledOnce();
    });

    it('returns 422 and does not call handler when body fails even if params are valid', async () => {
        const handler = vi.fn();
        const wrapped = withValidation(handler, {
            body: bodySchema,
            params: paramsSchema,
        });
        const event = createMockEvent({
            request: createJsonRequest({ rating: 10 }),
            params: { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' },
        });

        const response = await wrapped(event);

        expect(response.status).toBe(422);
        expect(handler).not.toHaveBeenCalled();
    });
});

// ============================================================================
// Convenience wrappers
// ============================================================================

describe('withBodyValidation convenience wrapper', () => {
    it('validates body and calls handler on success', async () => {
        const schema = z.object({ count: z.number() });
        const handler = vi.fn().mockImplementation(({ validated }) => {
            return new Response(JSON.stringify(validated.body), {
                status: 200,
            });
        });

        const wrapped = withBodyValidation(handler, schema);
        const event = createMockEvent({
            request: createJsonRequest({ count: 7 }),
        });

        const response = await wrapped(event);

        expect(response.status).toBe(200);
        const body = await parseBody<{ count: number }>(response);
        expect(body.count).toBe(7);
    });

    it('returns 422 for invalid body', async () => {
        const schema = z.object({ count: z.number() });
        const handler = vi.fn();
        const wrapped = withBodyValidation(handler, schema);
        const event = createMockEvent({
            request: createJsonRequest({ count: 'seven' }),
        });

        const response = await wrapped(event);

        expect(response.status).toBe(422);
        expect(handler).not.toHaveBeenCalled();
    });
});

describe('withQueryValidation convenience wrapper', () => {
    it('validates query and calls handler on success', async () => {
        const schema = z.object({ q: z.string().min(1) });
        const handler = vi.fn().mockImplementation(({ validated }) => {
            return new Response(JSON.stringify(validated.query), {
                status: 200,
            });
        });

        const wrapped = withQueryValidation(handler, schema);
        const event = createMockEvent({
            url: new URL('http://localhost/api/test?q=hello'),
        });

        const response = await wrapped(event);

        expect(response.status).toBe(200);
    });
});

describe('withParamsValidation convenience wrapper', () => {
    it('validates params and calls handler on success', async () => {
        const schema = z.object({ id: z.string().min(1) });
        const handler = vi.fn().mockImplementation(({ validated }) => {
            return new Response(JSON.stringify(validated.params), {
                status: 200,
            });
        });

        const wrapped = withParamsValidation(handler, schema);
        const event = createMockEvent({
            params: { id: 'my-movie' },
        });

        const response = await wrapped(event);

        expect(response.status).toBe(200);
    });

    it('returns 422 for invalid params', async () => {
        const schema = z.object({ id: z.string().min(1) });
        const handler = vi.fn();
        const wrapped = withParamsValidation(handler, schema);
        const event = createMockEvent({
            params: { id: '' },
        });

        const response = await wrapped(event);

        expect(response.status).toBe(422);
        expect(handler).not.toHaveBeenCalled();
    });
});

// ============================================================================
// Error field path formatting
// ============================================================================

describe('validation error field paths', () => {
    it('reports body field path as body.<fieldname>', async () => {
        const schema = z.object({ user: z.object({ age: z.number() }) });
        const handler = vi.fn();
        const wrapped = withValidation(handler, { body: schema });
        const event = createMockEvent({
            request: createJsonRequest({ user: { age: 'old' } }),
        });

        const response = await wrapped(event);
        const body = await parseBody<ValidationErrorBody>(response);

        const fields = body.details.map((e) => e.field);
        expect(fields.some((f) => f.startsWith('body.'))).toBe(true);
    });

    it('reports params field path as params.<fieldname>', async () => {
        const schema = z.object({ id: z.string().uuid() });
        const handler = vi.fn();
        const wrapped = withValidation(handler, { params: schema });
        const event = createMockEvent({ params: { id: 'bad' } });

        const response = await wrapped(event);
        const body = await parseBody<ValidationErrorBody>(response);

        const fields = body.details.map((e) => e.field);
        expect(fields.some((f) => f.startsWith('params.'))).toBe(true);
    });
});

/**
 * Security review 2026-09-12, C1 (defense in depth behind the CSRF fix): a body
 * that arrives with NO Content-Type on a cookie-authenticated request is exactly
 * what a cross-site `fetch(..., { body: new Blob([json]) })` produces. The origin
 * check now rejects it up front; the parser must ALSO refuse to guess "JSON" for
 * it, so a route that ever bypasses the CSRF hook still cannot be forged. Bearer
 * requests carry no cookie and are unaffected.
 */
describe('withBodyValidation: a body with no Content-Type is not parsed as JSON on cookie auth', () => {
    const schema = z.object({ name: z.string() });

    it('rejects it as validation_failed and never calls the handler', async () => {
        const handler = vi.fn(async () => new Response('ok'));
        const wrapped = withBodyValidation(handler, schema);
        const event = createMockEvent({
            request: new Request('http://localhost/api/test', {
                method: 'POST',
                body: '{"name":"x"}',
            }),
        });
        // Request() adds text/plain for a string body — strip it to model the Blob case.
        event.request.headers.delete('content-type');
        const response = await wrapped(event);
        // ApiResponses.badRequest() is the 422 validation_failed problem by contract.
        expect(response.status).toBe(422);
        const body = (await response.json()) as { code: string; error: string };
        expect(body.code).toBe('validation_failed');
        expect(body.error).toContain('Content-Type header is required');
        expect(handler).not.toHaveBeenCalled();
    });

    it('accepts the same body when the request is Bearer-authenticated (no cookie in play)', async () => {
        const handler = vi.fn(async () => new Response('ok'));
        const wrapped = withBodyValidation(handler, schema);
        const event = createMockEvent({
            request: new Request('http://localhost/api/test', {
                method: 'POST',
                body: '{"name":"x"}',
                headers: { authorization: 'Bearer pat_abc' },
            }),
        });
        event.request.headers.delete('content-type');
        const response = await wrapped(event);
        expect(response.status).toBe(200);
        expect(handler).toHaveBeenCalled();
    });
});
