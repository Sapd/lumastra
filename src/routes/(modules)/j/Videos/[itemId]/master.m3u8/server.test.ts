// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Route-seam regression for C1 (security review 3, 2026-09-15): a
 * client-supplied `PlaySessionId` reached `startHlsPlayback` with no shape
 * validation on this route. Before the fix, an id like `..` sailed past this
 * route straight into `startHlsPlayback` (real implementation, not mocked
 * here) and — since this test's fake `sql` isn't a real Postgres handle —
 * blew up on the first real query the (then-unvalidated) code path reached,
 * landing in the route's generic `catch` and its 500 fallback. That is the
 * accidental-500 shape the finding describes (in production the real failure
 * mode is a Postgres `22P02` from the `session_id` UUID column, see
 * `play-sessions.service.test.ts`'s `session_id UUID guard` tests for that
 * half; this route's `sql` stub just fails earlier and cruder, but the
 * observable shape — "not 400" — is the same).
 *
 * After the fix, `startHlsPlayback`'s seam guard rejects the id BEFORE it
 * touches `sql` at all, throws a typed `HlsPlaybackError(..., 400)`, and this
 * route's (unchanged) catch block turns that into an HTTP 400.
 *
 * Validation cases use the real `startHlsPlayback` seam. Admission-response
 * cases inject only the typed refusal to check this route's response headers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';

const mockCheckMediaAccess = vi.fn();
const mockGetMediaItemById = vi.fn();
const mockCheckSessionKickCooldown = vi.fn();
const mockGetClientIp = vi.fn();
const mockGetOwnerItemForFile = vi.fn();

vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

// A non-callable stub is deliberate: the point of the invalid-id test is that
// startHlsPlayback's seam guard must reject BEFORE ever calling `sql` as a
// tagged template. If a future change removed the guard, the first real query
// would throw on this stub (not a Postgres 22P02, but equally "not 400"),
// which is exactly the regression this test catches.
vi.mock('$lib/server/database', () => ({
    getDb: () => ({}),
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));

vi.mock('$lib/server/database/queries/catalog-operations.queries', () => ({
    getMediaItemById: (...args: unknown[]) => mockGetMediaItemById(...args),
}));

vi.mock('$lib/server/services/session-kill.service', () => ({
    checkSessionKickCooldown: (...args: unknown[]) => mockCheckSessionKickCooldown(...args),
}));

vi.mock('$lib/server/utils/client-ip', () => ({
    getClientIp: (...args: unknown[]) => mockGetClientIp(...args),
}));

vi.mock('$lib/server/database/queries/media-files.queries', () => ({
    getOwnerItemForFile: (...args: unknown[]) => mockGetOwnerItemForFile(...args),
}));

vi.mock('$lib/server/jellyfin-compat/playback-utils', () => ({
    jellyfinCompatDeviceId: () => 'jellyfin-compat-device',
}));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

vi.mock('$lib/server/jellyfin-compat/silent-start', () => ({
    armSilentStart: vi.fn(),
    disarmSilentStart: vi.fn(),
}));
import { disarmSilentStart } from '$lib/server/jellyfin-compat/silent-start';
import { GET } from './+server';

const mockStartHlsPlayback = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/services/hls/playback.service', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/services/hls/playback.service')>();
    return {
        ...actual,
        startHlsPlayback: (...args: Parameters<typeof actual.startHlsPlayback>) =>
            mockStartHlsPlayback(...args) ?? actual.startHlsPlayback(...args),
    };
});
import { HlsPlaybackError } from '$lib/server/services/hls/playback.service';

const ITEM_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';

function makeEvent(playSessionId: string): RequestEvent {
    const url = new URL(
        `https://example.test/j/Videos/${ITEM_ID}/master.m3u8?PlaySessionId=${encodeURIComponent(
            playSessionId,
        )}`,
    );
    return {
        params: { itemId: ITEM_ID },
        url,
        request: new Request(url),
        // No userId: this test exercises the charset seam guard, which fires
        // for every caller regardless of whether userId is present — see
        // playback.service.test.ts for the userId-present enforcement paths.
        locals: { user: { userId: undefined, username: 'unknown' } },
        cookies: { get: vi.fn(), set: vi.fn() },
    } as unknown as RequestEvent;
}

const callGet = (playSessionId: string) =>
    (GET as unknown as (event: RequestEvent) => Promise<Response>)(makeEvent(playSessionId));

describe('/j/Videos/[itemId]/master.m3u8 — C1 PlaySessionId rejection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockStartHlsPlayback.mockReset();
        mockCheckMediaAccess.mockResolvedValue(true);
        mockGetMediaItemById.mockResolvedValue(null);
        mockCheckSessionKickCooldown.mockResolvedValue({ kicked: false });
        mockGetClientIp.mockReturnValue('127.0.0.1');
        mockGetOwnerItemForFile.mockResolvedValue(null);
    });

    it.each(['transcode_capacity', 'transcode_load_shed'])(
        'forwards a retryable 503 for %s',
        async (code) => {
            mockStartHlsPlayback.mockRejectedValue(
                new HlsPlaybackError(JSON.stringify({ error: code, retry_after: 30 }), 503, 30),
            );
            const res = await callGet('valid-session');
            expect(res.status).toBe(503);
            expect(res.headers.get('Retry-After')).toBe('30');
            expect(res.headers.get('Content-Type')).toBe('application/json');
            expect(await res.json()).toMatchObject({ error: code, retry_after: 30 });
        },
    );

    it('turns a path-traversal PlaySessionId into 400, not the generic 500 fallback', async () => {
        const response = await callGet('..');

        expect(response.status).toBe(400);
    });

    it('rejects a deeper traversal (../../app) with 400 as well', async () => {
        const response = await callGet('../../app');

        expect(response.status).toBe(400);
    });
});

describe('/j/Videos/[itemId]/master.m3u8 — silent-start detector', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockStartHlsPlayback.mockReset();
        mockCheckMediaAccess.mockResolvedValue(true);
        mockGetMediaItemById.mockResolvedValue(null);
        mockCheckSessionKickCooldown.mockResolvedValue({ kicked: false });
        mockGetClientIp.mockReturnValue('127.0.0.1');
        mockGetOwnerItemForFile.mockResolvedValue(null);
    });

    it('disarms the detector with the client PlaySessionId', async () => {
        await callGet('abc');

        expect(disarmSilentStart).toHaveBeenCalledWith(
            expect.objectContaining({ playSessionId: 'abc', itemId: ITEM_ID }),
        );
    });
});
