// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Feature Flag Middleware Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requireFeature } from './feature-flag';
import type { RequestEvent } from '@sveltejs/kit';

// Mock the config module
vi.mock('$lib/server/config', () => ({
    features: {
        playlists: true,
        aiAssistant: false,
        aiRecommendations: true,
        liveTV: false,
    },
}));

// Mock the api-responses module
vi.mock('$lib/server/utils/api-responses', () => ({
    ApiResponses: {
        notFound: vi.fn((message: string, endpoint?: string) => {
            return new Response(
                JSON.stringify({
                    success: false,
                    error: message,
                    endpoint,
                    timestamp: new Date().toISOString(),
                }),
                { status: 404 },
            );
        }),
        error: vi.fn((message: string, error: Error, status: number, endpoint?: string) => {
            return new Response(
                JSON.stringify({
                    success: false,
                    error: message,
                    details: error.message,
                    endpoint,
                    timestamp: new Date().toISOString(),
                }),
                { status },
            );
        }),
    },
    getEndpointName: vi.fn((event: RequestEvent) => event.url.pathname),
}));

// Mock the logger
vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: vi.fn(() => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        })),
    },
}));

type MockHandler = (event: RequestEvent) => Promise<Response>;

describe('requireFeature middleware', () => {
    let mockEvent: RequestEvent;
    let mockHandler: MockHandler & ReturnType<typeof vi.fn>;

    beforeEach(() => {
        // Create mock request event
        mockEvent = {
            url: new URL('http://localhost:3000/api/test'),
            request: new Request('http://localhost:3000/api/test'),
            locals: {
                user: {
                    username: 'testuser',
                    userGroups: [],
                },
            },
            params: {},
            route: { id: '/api/test' },
        } as unknown as RequestEvent;

        // Create mock handler that returns success
        mockHandler = vi.fn(async (_event: RequestEvent) => {
            return new Response(JSON.stringify({ success: true }), {
                status: 200,
            });
        }) as MockHandler & ReturnType<typeof vi.fn>;
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('should allow request when feature is enabled', async () => {
        const middleware = requireFeature('playlists');
        const wrappedHandler = middleware(mockHandler);

        const response = await wrappedHandler(mockEvent);

        expect(mockHandler).toHaveBeenCalledWith(mockEvent);
        expect(response.status).toBe(200);

        const body = await response.json();

        expect(body.success).toBe(true);
    });

    it('should return 404 when feature is disabled', async () => {
        const middleware = requireFeature('aiAssistant');
        const wrappedHandler = middleware(mockHandler);

        const response = await wrappedHandler(mockEvent);

        // Handler should not be called
        expect(mockHandler).not.toHaveBeenCalled();

        // Should return 404
        expect(response.status).toBe(404);

        const body = await response.json();

        expect(body.success).toBe(false);

        expect(body.error).toBe('Feature not available');
    });

    it('should check multiple different features correctly', async () => {
        // Test enabled feature
        const enabledMiddleware = requireFeature('aiRecommendations');
        const enabledWrapped = enabledMiddleware(mockHandler);
        const enabledResponse = await enabledWrapped(mockEvent);
        expect(enabledResponse.status).toBe(200);
        expect(mockHandler).toHaveBeenCalledTimes(1);

        // Reset mock
        mockHandler.mockClear();

        // Test disabled feature
        const disabledMiddleware = requireFeature('liveTV');
        const disabledWrapped = disabledMiddleware(mockHandler);
        const disabledResponse = await disabledWrapped(mockEvent);
        expect(disabledResponse.status).toBe(404);
        expect(mockHandler).not.toHaveBeenCalled();
    });

    it('should pass through event correctly to handler', async () => {
        const middleware = requireFeature('playlists');
        const wrappedHandler = middleware(mockHandler);

        await wrappedHandler(mockEvent);

        expect(mockHandler).toHaveBeenCalledWith(mockEvent);
    });

    it('should work with anonymous users', async () => {
        // Remove user from event
        (mockEvent.locals as { user?: typeof mockEvent.locals.user }).user = undefined;

        const middleware = requireFeature('playlists');
        const wrappedHandler = middleware(mockHandler);

        const response = await wrappedHandler(mockEvent);

        // Should still check feature flag and allow if enabled
        expect(response.status).toBe(200);
        expect(mockHandler).toHaveBeenCalledWith(mockEvent);
    });

    it('should compose with other middleware', async () => {
        // Simulate composition with auth middleware
        const authMiddleware = (handler: (event: RequestEvent) => Promise<Response>) => {
            return async (event: RequestEvent) => {
                if (!event.locals.user) {
                    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                        status: 401,
                    });
                }
                return handler(event);
            };
        };

        // Apply middlewares: feature -> auth -> handler
        const featureMiddleware = requireFeature('playlists');
        const composedHandler = featureMiddleware(authMiddleware(mockHandler));

        const response = await composedHandler(mockEvent);

        expect(response.status).toBe(200);
        expect(mockHandler).toHaveBeenCalledWith(mockEvent);
    });
});
