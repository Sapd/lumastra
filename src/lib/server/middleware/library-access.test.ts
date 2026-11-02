// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for Library Access Middleware
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withLibraryAccess } from './library-access';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';

// Mock dependencies
vi.mock('$lib/server/database/index.js', () => ({
    getDb: vi.fn(),
}));

vi.mock('$lib/server/cache/library-group-permissions-cache.js', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('$lib/server/cache/library-group-permissions-cache.js')
        >();
    return { ...actual, isMediaAccessible: vi.fn() };
});
vi.mock('$lib/server/cache/valkey.js', () => ({
    publishMessage: vi.fn(async () => true),
    subscribeToChannel: vi.fn(async () => undefined),
}));

import { getDb } from '$lib/server/database/index.js';
import { isMediaAccessible } from '$lib/server/cache/library-group-permissions-cache.js';

const mockGetDb = vi.mocked(getDb);
const mockIsMediaAccessible = vi.mocked(isMediaAccessible);

// Stub handler that returns 200 OK
const okHandler: RequestHandler = async () => new Response('ok', { status: 200 });

function createMockEvent(
    overrides: {
        user?: {
            username: string;
            ownerIsAdmin: boolean;
            mediaAccessIsAdmin?: boolean;
            userGroups: string[];
        } | null;
        resolvedIds?: { internalId?: string } | null;
    } = {},
): RequestEvent {
    return {
        url: new URL('http://localhost/api/test'),
        request: new Request('http://localhost/api/test'),
        params: {},
        route: { id: '/api/test' as const },
        locals: {
            user: overrides.user ?? null,
            resolvedIds: overrides.resolvedIds ?? null,
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

describe('withLibraryAccess', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('passes through when no user is present', async () => {
        const handler = withLibraryAccess(okHandler);
        const event = createMockEvent({
            user: null,
            resolvedIds: { internalId: 'abc-123' },
        });

        const response = await handler(event);

        expect(response.status).toBe(200);
        expect(mockIsMediaAccessible).not.toHaveBeenCalled();
    });

    it('passes through when no resolvedIds', async () => {
        const handler = withLibraryAccess(okHandler);
        const event = createMockEvent({
            user: { username: 'alice', ownerIsAdmin: false, userGroups: ['users'] },
            resolvedIds: null,
        });

        const response = await handler(event);

        expect(response.status).toBe(200);
        expect(mockIsMediaAccessible).not.toHaveBeenCalled();
    });

    it('passes through when no internalId in resolvedIds', async () => {
        const handler = withLibraryAccess(okHandler);
        const event = createMockEvent({
            user: { username: 'alice', ownerIsAdmin: false, userGroups: ['users'] },
            resolvedIds: {},
        });

        const response = await handler(event);

        expect(response.status).toBe(200);
        expect(mockIsMediaAccessible).not.toHaveBeenCalled();
    });

    it('allows access when media is accessible', async () => {
        const mockSql = {} as ReturnType<typeof getDb>;
        mockGetDb.mockReturnValue(mockSql);
        mockIsMediaAccessible.mockResolvedValue(true);

        const handler = withLibraryAccess(okHandler);
        const event = createMockEvent({
            user: {
                username: 'alice',
                ownerIsAdmin: false,
                userGroups: ['media-users'],
            },
            resolvedIds: { internalId: 'uuid-123' },
        });

        const response = await handler(event);

        expect(response.status).toBe(200);
        expect(mockIsMediaAccessible).toHaveBeenCalledWith(mockSql, 'uuid-123', {
            isAdmin: false,
            userGroups: ['media-users'],
        });
    });

    it('returns 404 when media is not accessible', async () => {
        const mockSql = {} as ReturnType<typeof getDb>;
        mockGetDb.mockReturnValue(mockSql);
        mockIsMediaAccessible.mockResolvedValue(false);

        const handler = withLibraryAccess(okHandler);
        const event = createMockEvent({
            user: { username: 'bob', ownerIsAdmin: false, userGroups: ['basic'] },
            resolvedIds: { internalId: 'uuid-456' },
        });

        const response = await handler(event);

        // 404 (not 403): a library-restricted user must not be able to
        // distinguish "exists but forbidden" from "does not exist".
        expect(response.status).toBe(404);
    });

    it('fails closed for non-admin when DB is unavailable', async () => {
        mockGetDb.mockReturnValue(undefined as unknown as ReturnType<typeof getDb>);

        const handler = withLibraryAccess(okHandler);
        const event = createMockEvent({
            user: { username: 'bob', ownerIsAdmin: false, userGroups: ['users'] },
            resolvedIds: { internalId: 'uuid-789' },
        });

        const response = await handler(event);

        expect(response.status).toBe(500);
        expect(mockIsMediaAccessible).not.toHaveBeenCalled();
    });

    it('passes through for admin when DB is unavailable', async () => {
        mockGetDb.mockReturnValue(undefined as unknown as ReturnType<typeof getDb>);

        const handler = withLibraryAccess(okHandler);
        const event = createMockEvent({
            user: { username: 'admin', ownerIsAdmin: true, userGroups: ['admins'] },
            resolvedIds: { internalId: 'uuid-999' },
        });

        const response = await handler(event);

        expect(response.status).toBe(200);
        expect(mockIsMediaAccessible).not.toHaveBeenCalled();
    });

    it('calls the inner handler with the original event', async () => {
        const mockSql = {} as ReturnType<typeof getDb>;
        mockGetDb.mockReturnValue(mockSql);
        mockIsMediaAccessible.mockResolvedValue(true);

        const innerHandler = vi.fn<RequestHandler>(
            async () => new Response('inner', { status: 200 }),
        );

        const handler = withLibraryAccess(innerHandler);
        const event = createMockEvent({
            user: { username: 'alice', ownerIsAdmin: false, userGroups: ['users'] },
            resolvedIds: { internalId: 'uuid-123' },
        });

        await handler(event);

        expect(innerHandler).toHaveBeenCalledWith(event);
    });

    it('blocks a scoped admin owner when the database is unavailable', async () => {
        mockGetDb.mockReturnValue(undefined as unknown as ReturnType<typeof getDb>);
        const inner = vi.fn<RequestHandler>(okHandler);
        const event = createMockEvent({
            user: {
                username: 'admin',
                ownerIsAdmin: true,
                mediaAccessIsAdmin: false,
                userGroups: ['admins'],
            },
            resolvedIds: { internalId: 'uuid-scoped-owner' },
        });
        expect((await withLibraryAccess(inner)(event)).status).toBe(500);
        expect(inner).not.toHaveBeenCalled();
    });
});
