// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET media/{id}/images/{role}, DB-unavailable fallback (UUID and composite-key
 * branches): only an admin PRINCIPAL may skip the access check; an admin owner's
 * device token gets 503 (spec 2026-10-07-auth-route-policy-design §5.1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import {
    adminOwnersDeviceToken,
    adminSession,
    adminUserWithoutPrincipal,
} from '$lib/server/api/principal-locals.test-helpers.js';

const mockGetImageByCatalogId = vi.fn();
const mockGetImageByCompositeKey = vi.fn();

vi.mock('$lib/server/services/image-proxy/index.js', () => ({
    getImageProxyService: () => ({
        getImageByCatalogId: (...a: unknown[]) => mockGetImageByCatalogId(...a),
        getImageByCompositeKey: (...a: unknown[]) => mockGetImageByCompositeKey(...a),
        cachedResolveMediaIdByProvider: vi.fn(async () => null),
    }),
    imageResponse: () => new Response('img', { status: 200 }),
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess: vi.fn() }));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => null }));
vi.mock('$lib/server/utils/image-params.js', () => ({
    resolvePublicImageOptions: () => ({ bounded: true }),
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

const { def } = await import('./[role].js');

const UUID = '11111111-1111-4111-8111-111111111111';
const COMPOSITE = 'tmdb:603:movie';
const ctx = { surface: 'v1' } as never;

async function call(locals: RequestEvent['locals'], id: string): Promise<Response> {
    const url = `http://localhost/api/v1/media/${encodeURIComponent(id)}/images/poster`;
    return def.handlers.GET!(
        {
            locals,
            url: new URL(url),
            params: { id, role: 'poster' },
            request: new Request(url),
        } as unknown as RequestEvent,
        ctx,
    );
}

describe.each([
    ['UUID', UUID, mockGetImageByCatalogId],
    ['composite key', COMPOSITE, mockGetImageByCompositeKey],
] as const)('media image by %s with the database unavailable', (_name, id, service) => {
    beforeEach(() => {
        vi.clearAllMocks();
        const result = { buffer: Buffer.from('x'), contentType: 'image/webp', cacheControl: 'x' };
        mockGetImageByCatalogId.mockResolvedValue(result);
        mockGetImageByCompositeKey.mockResolvedValue(result);
    });

    it("an admin owner's device token gets 503", async () => {
        expect((await call(adminOwnersDeviceToken(), id)).status).toBe(503);
        expect(service).not.toHaveBeenCalled();
    });

    it('a request without a principal gets 503', async () => {
        expect((await call(adminUserWithoutPrincipal(), id)).status).toBe(503);
        expect(service).not.toHaveBeenCalled();
    });

    it('an admin session only retains the internal UUID fallback when the database is down', async () => {
        expect((await call(adminSession(), id)).status).toBe(id === UUID ? 200 : 503);
        expect(service).toHaveBeenCalledTimes(id === UUID ? 1 : 0);
    });
});
