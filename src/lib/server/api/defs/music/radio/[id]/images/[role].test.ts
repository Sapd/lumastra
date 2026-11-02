// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/music/radio/{id}/image/{role} (also /api/v1/music/radio/stations/{id}/images/{role})
 *
 * This route was the one sibling on the radio station id that did NOT call
 * checkMediaAccess — [id]/stream and [id]/now-playing both gate by
 * library/age, this one served cached artwork straight from the image proxy.
 * These tests pin the gate: a denied user gets 404 even when a cached image
 * exists (the access check must run BEFORE the image is fetched, not after),
 * an allowed user still gets the image, and a station id that isn't a radio
 * row 404s without ever calling checkMediaAccess.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetSql = vi.fn();
const mockCheckMediaAccess = vi.fn();
const mockGetRadioMetadataImage = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));

vi.mock('$lib/server/services/image-proxy/index.js', async () => ({
    ...(await import('$lib/server/services/image-proxy/response.js')),
    getImageProxyService: () => ({
        getRadioMetadataImage: (...args: unknown[]) => mockGetRadioMetadataImage(...args),
    }),
}));

const { def } = await import('./[role].js');

const STATION_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/** Minimal postgres.js stand-in: a tagged template that always resolves rows. */
function fakeSql(rows: unknown[]) {
    return () => Promise.resolve(rows);
}

function makeEvent(user: unknown = { userId: 'u1', username: 'alice' }): RequestEvent {
    return {
        locals: { user },
        params: { id: STATION_ID, role: 'dj' },
        url: new URL(`http://localhost/api/music/radio/${STATION_ID}/image/dj`),
        request: new Request(`http://localhost/api/music/radio/${STATION_ID}/image/dj`),
    } as unknown as RequestEvent;
}

describe('radio station images/[role] access gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue(fakeSql([{ id: STATION_ID }]));
        mockGetRadioMetadataImage.mockResolvedValue({
            buffer: Buffer.from('png-bytes'),
            contentType: 'image/png',
            cacheControl: 'public, max-age=3600',
        });
    });

    it('returns 404 for a denied user even though a cached image exists', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);

        const res = await def.handlers.GET!(makeEvent(), {} as never);

        expect(res.status).toBe(404);
        // Denial must short-circuit BEFORE the image is fetched.
        expect(mockGetRadioMetadataImage).not.toHaveBeenCalled();
    });

    it('serves the cached image for an allowed user', async () => {
        mockCheckMediaAccess.mockResolvedValue(true);

        const res = await def.handlers.GET!(makeEvent(), {} as never);

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('image/png');
        expect(res.headers.get('cache-control')).toBe('private, max-age=300, stale-while-revalidate=86400');
        expect(res.headers.get('vary')).toContain('Authorization, Cookie');
        expect(mockCheckMediaAccess).toHaveBeenCalledWith(
            expect.anything(),
            STATION_ID,
            expect.objectContaining({ userId: 'u1' }),
        );
    });

    it('404s a non-radio/nonexistent station id without calling checkMediaAccess', async () => {
        mockGetSql.mockResolvedValue(fakeSql([]));

        const res = await def.handlers.GET!(makeEvent(), {} as never);

        expect(res.status).toBe(404);
        expect(mockCheckMediaAccess).not.toHaveBeenCalled();
        expect(mockGetRadioMetadataImage).not.toHaveBeenCalled();
    });
});
