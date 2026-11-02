// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

vi.mock('$lib/server/config.js', () => ({
    config: {},
    features: {},
}));

vi.mock('$lib/server/tasks/api-auth.js', () => ({
    authenticate: vi.fn(),
    requireScope: vi.fn(),
    scopeGranted: vi.fn(),
}));

vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: vi.fn().mockResolvedValue(null) }),
}));

vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: vi.fn().mockResolvedValue(null) }),
}));

vi.mock('$lib/server/auth.js', () => ({ isUserAdmin: () => false }));

const mockGetEditionsForMediaItem = vi.fn();
const mockCheckMediaAccess = vi.fn();
const mockResolveAnyMediaId = vi.fn();
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: mockCheckMediaAccess,
}));

vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getEditionsForMediaItem: mockGetEditionsForMediaItem,
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn().mockResolvedValue({}) },
}));

// resolveCatalogInternalId reads event.locals.resolvedIds — supply it via the
// event mock rather than via a middleware wrapper (withIdResolution is not used
// in the current route which is a bare mount(def) call).
vi.mock('$lib/server/services/media-id-resolver.js', () => ({
    mediaIdResolver: { resolveAnyMediaId: mockResolveAnyMediaId },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(internalId: string): RequestEvent {
    const url = new URL('http://localhost/api/media/' + internalId + '/files');
    return {
        url,
        request: new Request(url.toString()),
        params: { id: internalId },
        route: { id: '/api/media/[id]/files' as const },
        locals: {
            user: {
                userId: 'user-uuid' as ReturnType<typeof import('$lib/shared/user-id.js').toUserId>,
                username: 'testuser',
                userGroups: [] as string[],
                ownerIsAdmin: false,
                maxAgeRating: null as null | number,
            },
            resolvedIds: { internalId },
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/media/[id]/files', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCheckMediaAccess.mockResolvedValue(true);
        mockResolveAnyMediaId.mockResolvedValue({ internalId: null });
    });

    it.each(['11111111-1111-4111-8111-111111111111', 'tmdb:550:movie'])(
        'denied editions match the unknown-item 404 for %s',
        async (id) => {
            const { GET } = await import('./+server.js');
            const unknown = makeEvent('unknown');
            delete unknown.locals.resolvedIds;
            const missing = await GET!(unknown);
            mockCheckMediaAccess.mockResolvedValue(false);
            const event = makeEvent(id);
            delete event.locals.resolvedIds;
            mockResolveAnyMediaId.mockResolvedValue({
                internalId: '11111111-1111-4111-8111-111111111111',
            });
            const denied = await GET!(event);
            expect(denied.status).toBe(404);
            expect(await denied.json()).toEqual(await missing.json());
            expect(mockGetEditionsForMediaItem).not.toHaveBeenCalled();
        },
    );

    it('fails closed for a principal without a resolved user context', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent('known-item');
        event.locals.principal = { username: 'testuser', isAdmin: false } as never;
        Object.defineProperty(event.locals, 'user', { value: undefined });
        expect((await GET!(event)).status).toBe(404);
        expect(mockGetEditionsForMediaItem).not.toHaveBeenCalled();
    });

    it('uses the effective principal admin verdict for the media access check', async () => {
        mockGetEditionsForMediaItem.mockResolvedValue(['extended']);
        const { GET } = await import('./+server.js');
        const event = makeEvent('known-item');
        event.locals.principal = { username: 'testuser', isAdmin: false } as never;
        event.locals.user!.mediaAccessIsAdmin = true;
        expect((await GET!(event)).status).toBe(200);
        expect(mockCheckMediaAccess).toHaveBeenCalledWith(
            expect.anything(),
            'known-item',
            expect.objectContaining({ mediaAccessIsAdmin: false }),
        );
    });

    it('returns empty editions list for single-file item', async () => {
        mockGetEditionsForMediaItem.mockResolvedValue([]);
        const { GET } = await import('./+server.js');
        expect(GET).toBeDefined();
        const response = await GET!(makeEvent('uuid-1'));
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body.editions).toEqual([]);
    });

    it('returns edition list for multi-edition item', async () => {
        mockGetEditionsForMediaItem.mockResolvedValue(['directors_cut', 'extended']);
        const { GET } = await import('./+server.js');
        expect(GET).toBeDefined();
        const response = await GET!(makeEvent('uuid-2'));
        const body = await response.json();
        expect(body.editions).toEqual(['directors_cut', 'extended']);
    });
});
