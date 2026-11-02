// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the ID Resolution Middleware (withIdResolution /
 * withOptionalIdResolution).
 *
 * Covers:
 *   - rawId precedence: params.id || params.mediaId || params.itemId || params.seriesId
 *   - no-id passthrough (handler called, resolver not consulted)
 *   - substring-based error → HTTP status mapping:
 *       'Invalid media ID format'          -> validation_failed (422)
 *       'not found'                        -> 404
 *       'Database connection not available' -> 503
 *       anything else                      -> 500
 *   - withOptionalIdResolution swallows resolver errors and still calls the handler
 *
 * mediaIdResolver is mocked so tests are fast and dependency-free.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';

const { mockResolveAnyMediaId } = vi.hoisted(() => ({
    mockResolveAnyMediaId: vi.fn(),
}));

vi.mock('../services/media-id-resolver.js', () => ({
    mediaIdResolver: {
        resolveAnyMediaId: mockResolveAnyMediaId,
    },
}));

import { withIdResolution, withOptionalIdResolution } from './id-resolution';

const RESOLVED = {
    internalId: '12345678-1234-1234-1234-123456789012',
    source: 'uuid',
};

function fakeEvent(params: Record<string, string | undefined>): RequestEvent {
    return {
        url: new URL('http://localhost/api/test'),
        request: new Request('http://localhost/api/test'),
        params,
        route: { id: '/api/test' as const },
        locals: {},
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const okHandler: RequestHandler = vi.fn(async () => new Response('ok', { status: 200 }));

describe('withIdResolution — rawId precedence', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockResolveAnyMediaId.mockResolvedValue(RESOLVED);
    });

    it('prefers params.id over mediaId/itemId/seriesId', async () => {
        const handler = withIdResolution(okHandler);
        await handler(
            fakeEvent({
                id: 'id-val',
                mediaId: 'media-val',
                itemId: 'item-val',
                seriesId: 'series-val',
            }),
        );
        expect(mockResolveAnyMediaId).toHaveBeenCalledWith('id-val');
    });

    it('falls back to params.mediaId when id is absent', async () => {
        const handler = withIdResolution(okHandler);
        await handler(
            fakeEvent({ mediaId: 'media-val', itemId: 'item-val', seriesId: 'series-val' }),
        );
        expect(mockResolveAnyMediaId).toHaveBeenCalledWith('media-val');
    });

    it('falls back to params.itemId when id and mediaId are absent', async () => {
        const handler = withIdResolution(okHandler);
        await handler(fakeEvent({ itemId: 'item-val', seriesId: 'series-val' }));
        expect(mockResolveAnyMediaId).toHaveBeenCalledWith('item-val');
    });

    it('falls back to params.seriesId when id, mediaId, and itemId are absent', async () => {
        const handler = withIdResolution(okHandler);
        await handler(fakeEvent({ seriesId: 'series-val' }));
        expect(mockResolveAnyMediaId).toHaveBeenCalledWith('series-val');
    });

    it('injects the resolved ids into event.locals.resolvedIds', async () => {
        const handler = withIdResolution(okHandler);
        const event = fakeEvent({ id: 'id-val' });
        await handler(event);
        expect(event.locals.resolvedIds).toEqual(RESOLVED);
    });
});

describe('withIdResolution — no-id passthrough', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('calls the handler without consulting the resolver when no id param is present', async () => {
        const handler = withIdResolution(okHandler);
        const response = await handler(fakeEvent({}));
        expect(response.status).toBe(200);
        expect(mockResolveAnyMediaId).not.toHaveBeenCalled();
    });
});

describe('withIdResolution — error → HTTP status mapping', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('maps "Invalid media ID format" to a validation error (422)', async () => {
        mockResolveAnyMediaId.mockRejectedValue(
            new Error('Invalid media ID format: foo (expected UUID or provider:id:mediaType)'),
        );
        const handler = withIdResolution(okHandler);
        const response = await handler(fakeEvent({ id: 'foo' }));
        expect(response.status).toBe(422);
    });

    it('maps a "not found" message to 404', async () => {
        mockResolveAnyMediaId.mockRejectedValue(new Error('Media not found: foo'));
        const handler = withIdResolution(okHandler);
        const response = await handler(fakeEvent({ id: 'foo' }));
        expect(response.status).toBe(404);
    });

    it('maps "Database connection not available" to 503', async () => {
        mockResolveAnyMediaId.mockRejectedValue(new Error('Database connection not available'));
        const handler = withIdResolution(okHandler);
        const response = await handler(fakeEvent({ id: 'foo' }));
        expect(response.status).toBe(503);
    });

    it('maps any other error message to 500', async () => {
        mockResolveAnyMediaId.mockRejectedValue(new Error('Something unexpected exploded'));
        const handler = withIdResolution(okHandler);
        const response = await handler(fakeEvent({ id: 'foo' }));
        expect(response.status).toBe(500);
    });

    it('maps a non-Error throw to 500 via the "Unknown error" fallback message', async () => {
        mockResolveAnyMediaId.mockRejectedValue('a plain string rejection');
        const handler = withIdResolution(okHandler);
        const response = await handler(fakeEvent({ id: 'foo' }));
        expect(response.status).toBe(500);
    });
});

describe('withOptionalIdResolution — swallows resolver errors', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('calls the handler with 200 even when the resolver throws', async () => {
        mockResolveAnyMediaId.mockRejectedValue(new Error('Media not found: foo'));
        const handler = withOptionalIdResolution(okHandler);
        const response = await handler(fakeEvent({ id: 'foo' }));
        expect(response.status).toBe(200);
        expect(response).toBeInstanceOf(Response);
    });

    it('does not set event.locals.resolvedIds when the resolver throws', async () => {
        mockResolveAnyMediaId.mockRejectedValue(new Error('Media not found: foo'));
        const handler = withOptionalIdResolution(okHandler);
        const event = fakeEvent({ id: 'foo' });
        await handler(event);
        expect(event.locals.resolvedIds).toBeUndefined();
    });

    it('passes through without calling the resolver when no id param is present', async () => {
        const handler = withOptionalIdResolution(okHandler);
        const response = await handler(fakeEvent({}));
        expect(response.status).toBe(200);
        expect(mockResolveAnyMediaId).not.toHaveBeenCalled();
    });

    it('injects resolvedIds into locals on success', async () => {
        mockResolveAnyMediaId.mockResolvedValue(RESOLVED);
        const handler = withOptionalIdResolution(okHandler);
        const event = fakeEvent({ id: 'foo' });
        await handler(event);
        expect(event.locals.resolvedIds).toEqual(RESOLVED);
    });
});
