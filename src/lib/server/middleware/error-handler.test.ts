// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for Error Handler Middleware
 *
 * Tests withErrorHandler wrapper behavior: passthrough on success,
 * 500 response on Error throws, 500 on non-Error throws, status/header preservation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withErrorHandler } from './error-handler';
import type { RequestEvent } from '@sveltejs/kit';

// Mock the Logger to suppress console output and allow spy assertions
vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: vi.fn(() => ({
            error: vi.fn(),
            warn: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
        })),
    },
}));

// Mock ApiResponses to return controlled, inspectable responses
vi.mock('$lib/server/utils/api-responses', () => ({
    ApiResponses: {
        error: vi.fn((message: string, error?: Error, statusCode?: number, endpoint?: string) => {
            return new Response(
                JSON.stringify({
                    success: false,
                    error: message,
                    details: error?.message,
                    endpoint,
                    timestamp: new Date().toISOString(),
                }),
                { status: statusCode ?? 500 },
            );
        }),
    },
    getEndpointName: vi.fn((event: RequestEvent) => event.url.pathname),
}));

// Mock RequestEvent factory
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

    return { ...baseEvent, ...overrides };
}

async function parseBody<T>(response: Response): Promise<T> {
    return (await response.json()) as T;
}

describe('withErrorHandler', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('normal handler passthrough', () => {
        it('returns the handler response unmodified', async () => {
            const innerResponse = new Response(JSON.stringify({ success: true, data: 'ok' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
            const handler = vi.fn().mockResolvedValue(innerResponse);
            const wrapped = withErrorHandler(handler);
            const event = createMockEvent();

            const response = await wrapped(event);

            expect(response).toBe(innerResponse);
            expect(handler).toHaveBeenCalledOnce();
            expect(handler).toHaveBeenCalledWith(event);
        });

        it('passes the event through to the handler unchanged', async () => {
            const handler = vi.fn().mockResolvedValue(new Response('OK'));
            const wrapped = withErrorHandler(handler);
            const event = createMockEvent({
                url: new URL('http://localhost/api/media/123'),
            });

            await wrapped(event);

            expect(handler).toHaveBeenCalledWith(event);
        });

        it('preserves a 201 status code from the inner handler', async () => {
            const handler = vi.fn().mockResolvedValue(new Response('Created', { status: 201 }));
            const wrapped = withErrorHandler(handler);

            const response = await wrapped(createMockEvent());

            expect(response.status).toBe(201);
        });

        it('preserves a 404 status code from the inner handler', async () => {
            const handler = vi.fn().mockResolvedValue(new Response('Not Found', { status: 404 }));
            const wrapped = withErrorHandler(handler);

            const response = await wrapped(createMockEvent());

            expect(response.status).toBe(404);
        });

        it('preserves custom response headers from the inner handler', async () => {
            const headers = new Headers({
                'X-Custom-Header': 'custom-value',
                'Cache-Control': 'no-store',
            });
            const handler = vi.fn().mockResolvedValue(new Response('OK', { status: 200, headers }));
            const wrapped = withErrorHandler(handler);

            const response = await wrapped(createMockEvent());

            expect(response.headers.get('X-Custom-Header')).toBe('custom-value');
            expect(response.headers.get('Cache-Control')).toBe('no-store');
        });

        it('preserves the response body from the inner handler', async () => {
            const body = { items: [1, 2, 3], count: 3 };
            const handler = vi
                .fn()
                .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
            const wrapped = withErrorHandler(handler);

            const response = await wrapped(createMockEvent());
            const parsed = await parseBody<typeof body>(response);

            expect(parsed).toEqual(body);
        });
    });

    describe('Error throws', () => {
        it('returns 500 when handler throws an Error', async () => {
            const handler = vi.fn().mockRejectedValue(new Error('Something failed'));
            const wrapped = withErrorHandler(handler);

            const response = await wrapped(createMockEvent());

            expect(response.status).toBe(500);
        });

        it('returns JSON body with success false when handler throws', async () => {
            const handler = vi.fn().mockRejectedValue(new Error('Database error'));
            const wrapped = withErrorHandler(handler);

            const response = await wrapped(createMockEvent());
            const body = await parseBody<{ success: boolean; error: string }>(response);

            expect(body.success).toBe(false);
            expect(body.error).toBeDefined();
        });

        it('uses custom errorMessage option in error response', async () => {
            const handler = vi.fn().mockRejectedValue(new Error('Internal'));
            const wrapped = withErrorHandler(handler, {
                errorMessage: 'Media service unavailable',
            });

            const response = await wrapped(createMockEvent());
            const body = await parseBody<{ error: string }>(response);

            expect(body.error).toBe('Media service unavailable');
        });

        it("returns 413 for adapter-node's body-limit error (`status` 413, not `statusCode`)", async () => {
            const handler = vi.fn().mockRejectedValue(
                Object.assign(
                    new Error('Content-length of 1048576 exceeds limit of 524288 bytes.'),
                    {
                        status: 413,
                        text: 'Payload Too Large',
                    },
                ),
            );
            const wrapped = withErrorHandler(handler);

            const response = await wrapped(createMockEvent());

            expect(response.status).toBe(413);
        });

        it('does not rethrow the error', async () => {
            const handler = vi.fn().mockRejectedValue(new Error('Unexpected failure'));
            const wrapped = withErrorHandler(handler);

            await expect(wrapped(createMockEvent())).resolves.toBeInstanceOf(Response);
        });
    });

    describe('non-Error throws', () => {
        it('returns 500 when handler throws a string', async () => {
            const handler = vi.fn().mockRejectedValue('something went wrong as a string');
            const wrapped = withErrorHandler(handler);

            const response = await wrapped(createMockEvent());

            expect(response.status).toBe(500);
        });

        it('returns 500 when handler throws a plain object', async () => {
            const handler = vi.fn().mockRejectedValue({ code: 'INTERNAL', reason: 'crash' });
            const wrapped = withErrorHandler(handler);

            const response = await wrapped(createMockEvent());

            expect(response.status).toBe(500);
        });

        it('returns 500 when handler throws null', async () => {
            const handler = vi.fn().mockRejectedValue(null);
            const wrapped = withErrorHandler(handler);

            const response = await wrapped(createMockEvent());

            expect(response.status).toBe(500);
        });

        it('returns a valid JSON response body when handler throws a non-Error', async () => {
            const handler = vi.fn().mockRejectedValue('plain string error');
            const wrapped = withErrorHandler(handler);

            const response = await wrapped(createMockEvent());
            const body = await parseBody<{ success: boolean }>(response);

            expect(body.success).toBe(false);
        });

        it('does not rethrow non-Error throws', async () => {
            const handler = vi.fn().mockRejectedValue(42);
            const wrapped = withErrorHandler(handler);

            await expect(wrapped(createMockEvent())).resolves.toBeInstanceOf(Response);
        });
    });

    describe('synchronous handler support', () => {
        it('supports a handler returning a plain Response (not a Promise)', async () => {
            const handler = vi.fn().mockReturnValue(new Response('sync ok', { status: 200 }));
            const wrapped = withErrorHandler(handler);

            const response = await wrapped(createMockEvent());

            expect(response.status).toBe(200);
        });
    });

    describe('options', () => {
        it('uses a custom loggerName without affecting normal operation', async () => {
            const handler = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
            const wrapped = withErrorHandler(handler, {
                loggerName: 'CustomLogger',
            });

            const response = await wrapped(createMockEvent());

            expect(response.status).toBe(200);
        });

        it('applies logContext option without affecting successful responses', async () => {
            const handler = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
            const wrapped = withErrorHandler(handler, {
                logContext: { service: 'ai', version: 'v2' },
            });

            const response = await wrapped(createMockEvent());

            expect(response.status).toBe(200);
        });
    });
});
