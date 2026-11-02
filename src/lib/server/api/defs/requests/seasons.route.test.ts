// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/requests/seasons — exercised through the real `mount()` via the
 * route module, so auth, body validation and `series`/`tv` normalisation are
 * covered end to end (the def-level tests call the handler directly).
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

const { POST } = await import('../../../../../routes/api/v1/requests/seasons/+server.js');
const { def } = await import('./seasons.js');
const { def: statusDef } = await import('./status.js');

function makeEvent(body: unknown, authed: boolean): RequestEvent {
    return {
        request: new Request('http://localhost/api/v1/requests/seasons', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
        url: new URL('http://localhost/api/v1/requests/seasons'),
        params: {},
        locals: authed
            ? { user: { username: 'alice', hasRequestPermission: true } }
            : { user: undefined, principal: undefined },
    } as unknown as RequestEvent;
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

describe('POST /api/v1/requests/seasons (mounted)', () => {
    it('requires the same auth as POST /requests/status (any authenticated credential, no scope)', () => {
        expect(def.auth).toEqual({ kind: 'user' });
        expect(def.auth).toEqual(statusDef.auth);
    });

    it('returns 401 without a credential', async () => {
        const res = await POST!(
            makeEvent({ externalIds: { tmdb: '1396' }, mediaType: 'series' }, false),
        );
        expect(res.status).toBe(401);
        expect(mockGetRequestSeasons).not.toHaveBeenCalled();
    });

    it.each(['series'])('accepts mediaType %s', async (mediaType) => {
        const res = await POST!(makeEvent({ externalIds: { tmdb: '1396' }, mediaType }, true));
        expect(res.status).toBe(200);
        expect((await res.json()).items).toEqual([SEASON]);
        expect(mockResolveToTmdb).toHaveBeenCalledWith({ tmdb: '1396' }, 'tv');
    });

    it('rejects the tv alias', async () => {
        const res = await POST!(
            makeEvent({ externalIds: { tmdb: '1396' }, mediaType: 'tv' }, true),
        );
        expect(res.status).toBe(422);
    });

    it('returns 422 for a movie', async () => {
        const res = await POST!(
            makeEvent({ externalIds: { tmdb: '1' }, mediaType: 'movie' }, true),
        );
        expect(res.status).toBe(422);
        expect(mockGetRequestSeasons).not.toHaveBeenCalled();
    });

    it('returns 422 for an unknown mediaType', async () => {
        const res = await POST!(
            makeEvent({ externalIds: { tmdb: '1' }, mediaType: 'album' }, true),
        );
        expect(res.status).toBe(422);
    });
});
