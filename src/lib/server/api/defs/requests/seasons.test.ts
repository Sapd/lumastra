// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /requests/seasons — handler contract tests (shared by the internal web
 * mount and the public `/api/v1/requests/seasons` mount).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockCheckRateLimit = vi.fn();
const mockResolveToTmdb = vi.fn();
const mockGetRequestSeasons = vi.fn();

vi.mock('$lib/server/jellyseerr.js', () => ({
    jellyseerrClient: {
        getRequestSeasons: (...a: unknown[]) => mockGetRequestSeasons(...a),
    },
}));

vi.mock('$lib/server/services/provider-resolution.service.js', () => ({
    providerResolutionService: { resolveToTmdb: (...a: unknown[]) => mockResolveToTmdb(...a) },
}));

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: (...a: unknown[]) => mockCheckRateLimit(...a),
    RateLimitPresets: { STANDARD: { limit: 100, windowSeconds: 60 } },
}));

vi.mock('$lib/server/utils/client-ip.js', () => ({ getClientIp: () => '1.2.3.4' }));

const { def } = await import('./seasons.js');
const { RequestSeasonsResponseSchema } = await import('$lib/schemas/request-seasons.js');

function makeEvent(hasRequestPermission: boolean): RequestEvent {
    return {
        locals: { user: { username: 'alice', hasRequestPermission } },
    } as unknown as RequestEvent;
}

function makeCtx(mediaType: 'movie' | 'tv') {
    return {
        surface: 'v1' as const,
        input: { body: { externalIds: { tmdb: '1396' }, mediaType } },
    } as unknown as Parameters<NonNullable<typeof def.handlers.POST>>[1];
}

const SEASON = {
    seasonNumber: 1,
    name: 'Season 1',
    episodeCount: 7,
    airDate: '2008-01-20',
    overview: null,
    posterPath: null,
    isAvailable: false,
    isPending: true,
};

beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });
    mockResolveToTmdb.mockResolvedValue({ success: true, tmdbId: 1396 });
    mockGetRequestSeasons.mockResolvedValue([SEASON]);
});

describe('POST /requests/seasons', () => {
    it('is published on the public surface with Bearer auth', () => {
        expect(def.visibility).not.toBe('internal');
        expect(def.docs?.POST?.auth).toBe('bearer');
    });

    it('returns 403 without request permission', async () => {
        const res = (await def.handlers.POST!(makeEvent(false), makeCtx('tv'))) as Response;
        expect(res.status).toBe(403);
        expect(mockGetRequestSeasons).not.toHaveBeenCalled();
    });

    it('returns 429 when rate limited', async () => {
        mockCheckRateLimit.mockResolvedValue({ allowed: false, resetAt: Date.now() / 1000 + 30 });
        const res = (await def.handlers.POST!(makeEvent(true), makeCtx('tv'))) as Response;
        expect(res.status).toBe(429);
    });

    it('returns 422 for a movie', async () => {
        const res = (await def.handlers.POST!(makeEvent(true), makeCtx('movie'))) as Response;
        expect(res.status).toBe(422);
    });

    it('returns 404 when the series cannot be resolved', async () => {
        mockResolveToTmdb.mockResolvedValue({ success: false });
        const res = (await def.handlers.POST!(makeEvent(true), makeCtx('tv'))) as Response;
        expect(res.status).toBe(404);
    });

    it('returns the seasons in the documented shape', async () => {
        const res = (await def.handlers.POST!(makeEvent(true), makeCtx('tv'))) as Response;
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(RequestSeasonsResponseSchema.safeParse(body).success).toBe(true);
        expect(body.items).toEqual([SEASON]);
        expect(mockGetRequestSeasons).toHaveBeenCalledWith(1396);
    });

    it('returns 503 when the request service is unavailable', async () => {
        mockGetRequestSeasons.mockResolvedValue(null);
        const res = (await def.handlers.POST!(makeEvent(true), makeCtx('tv'))) as Response;
        expect(res.status).toBe(503);
        expect(JSON.stringify(await res.json())).toContain('Request service is not reachable');
    });
});
