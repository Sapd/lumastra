// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Security fix C15/P5 interaction (fix round 1, 2026-09-16): P5 made
 * findOrCreateJellyfinSession() resolve the caller's own per-user
 * user_stream_policies row (including require_single_ip), but this route
 * still fed it the LAX getClientIp(event) resolver — the same class of bug
 * C15 fixed at POST /api/play-sessions. A forged X-Forwarded-For could
 * defeat require_single_ip on /j the same way it could there.
 *
 * This test does NOT mock `$lib/server/utils/client-ip` — the IP resolution
 * itself is the seam under test, mirroring
 * `src/lib/server/api/defs/play-sessions/index.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/database/queries/media-type-cache.queries', () => ({
    getMediaType: async () => 'movie',
}));

import type { RequestHandler } from './$types';

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

const mockGetSql = vi.fn();
vi.mock('$lib/server/services/database.service', () => ({
    aiDbService: { getSql: () => mockGetSql() },
}));

const mockCheckSessionKickCooldown = vi.fn();
vi.mock('$lib/server/services/session-kill.service', () => ({
    checkSessionKickCooldown: (...a: unknown[]) => mockCheckSessionKickCooldown(...a),
}));

const mockGetOwnerItemForFile = vi.fn();
vi.mock('$lib/server/database/queries/media-files.queries', () => ({
    getOwnerItemForFile: (...a: unknown[]) => mockGetOwnerItemForFile(...a),
}));

const mockCheckMediaAccess = vi.fn();
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...a: unknown[]) => mockCheckMediaAccess(...a),
}));

const mockParsePlaybackBody = vi.fn();
const mockFindOrCreateJellyfinSession = vi.fn();
vi.mock('$lib/server/proprietary/jellyfin-compat/playback-utils', () => ({
    parsePlaybackBody: (...a: unknown[]) => mockParsePlaybackBody(...a),
    findOrCreateJellyfinSession: (...a: unknown[]) => mockFindOrCreateJellyfinSession(...a),
    isPolicyError: (x: unknown): boolean =>
        typeof x === 'object' && x !== null && 'kind' in (x as Record<string, unknown>),
}));

const mockUpdate = vi.fn();
vi.mock('$lib/server/services/play-session-lifecycle.service', () => ({
    getPlaySessionLifecycleService: () => ({ update: mockUpdate }),
}));

const valkey = new Map<string, string>();
vi.mock('$lib/server/cache/valkey', () => ({
    cacheGet: async (k: string) => valkey.get(k) ?? null,
    cacheSet: async () => true,
}));

const mockFindActiveSession = vi.fn();
vi.mock('$lib/server/database/queries/play-sessions.queries', () => ({
    findActiveSession: (...a: unknown[]) => mockFindActiveSession(...a),
}));
const mockRecordProgressHeartbeat = vi.fn();
const mockStopJobForUser = vi.fn(async () => true);
const mockStopJobByItemAndUser = vi.fn(async () => true);
vi.mock('$lib/server/services/ffmpeg-transcode.service', () => ({
    getFFmpegTranscodeService: () => ({
        stopJobByItemAndUser: (...a: unknown[]) => mockStopJobByItemAndUser(...(a as [])),
        stopJobForUser: (...a: unknown[]) => mockStopJobForUser(...(a as [])),
        recordProgressHeartbeat: (...a: unknown[]) => mockRecordProgressHeartbeat(...a),
    }),
}));
const mockRenewPlayToken = vi.fn(async () => {});
vi.mock('$lib/server/proprietary/jellyfin-compat/play-token', () => ({
    renewPlayTokenBySession: (...a: unknown[]) => mockRenewPlayToken(...(a as [])),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/silent-start', () => ({
    armSilentStart: vi.fn(),
    disarmSilentStart: vi.fn(),
}));
const { disarmSilentStart } = await import('$lib/server/proprietary/jellyfin-compat/silent-start');
const { POST } = await import('./+server.js');
const { POST: PROGRESS } = await import('./Progress/+server.js');
const { POST: STOPPED } = await import('./Stopped/+server.js');
const { __test: noticeInternals } =
    await import('$lib/server/proprietary/jellyfin-compat/stream-limit-notice');

const ITEM_ID = '00000000-0000-4000-a000-000000000001';

function makeEvent(opts: { peer: string; xForwardedFor?: string }) {
    const headers = new Headers();
    if (opts.xForwardedFor) headers.set('x-forwarded-for', opts.xForwardedFor);
    return {
        request: new Request('https://app.example/j/Sessions/Playing', {
            method: 'POST',
            headers,
        }),
        getClientAddress: () => opts.peer,
        locals: {
            user: { userId: 'uid-alice', username: 'alice' },
            jfDevice: undefined,
        },
        url: new URL('https://app.example/j/Sessions/Playing'),
        params: {},
    } as never;
}

beforeEach(() => {
    vi.clearAllMocks();
    valkey.clear();
    mockGetSql.mockResolvedValue({});
    mockCheckSessionKickCooldown.mockResolvedValue({ kicked: false });
    mockGetOwnerItemForFile.mockResolvedValue(null);
    mockCheckMediaAccess.mockResolvedValue(true);
    mockParsePlaybackBody.mockResolvedValue({
        itemId: ITEM_ID,
        positionMs: 0,
        playSessionId: 'sess-1',
    });
    mockFindOrCreateJellyfinSession.mockResolvedValue({ id: 'play-session-1' });
    mockUpdate.mockResolvedValue(undefined);
});

describe('POST /j/Sessions/Playing — client-IP resolution feeding require_single_ip (C15/P5)', () => {
    it('uses the STRICT resolver: a forged X-Forwarded-For does not override the real peer', async () => {
        await POST!(makeEvent({ peer: '198.51.100.9', xForwardedFor: '203.0.113.5' }));

        expect(mockFindOrCreateJellyfinSession).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ ipAddress: '198.51.100.9' }),
        );
    });
});

describe('POST /j/Sessions/Playing — silent-start detector', () => {
    it('disarms with the reported PlaySessionId, the user and the resolved item', async () => {
        await POST!(makeEvent({ peer: '198.51.100.9' }));

        expect(disarmSilentStart).toHaveBeenCalledWith(
            expect.objectContaining({
                playSessionId: 'sess-1',
                username: 'alice',
                itemId: ITEM_ID,
            }),
        );
    });
});

describe('POST /j/Sessions/Playing/Progress — silent-start detector', () => {
    it('disarms with the reported PlaySessionId, the user and the resolved item', async () => {
        await PROGRESS!(makeEvent({ peer: '198.51.100.9' }));
        expect(disarmSilentStart).toHaveBeenCalledWith(
            expect.objectContaining({
                playSessionId: 'sess-1',
                username: 'alice',
                userId: 'uid-alice',
                itemId: ITEM_ID,
            }),
        );
    });

    it('does not disarm when the caller may not see the item', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);
        const res = await PROGRESS!(makeEvent({ peer: '198.51.100.9' }));
        expect(res.status).toBe(404);
        expect(disarmSilentStart).not.toHaveBeenCalled();
    });
});

// The "stream limit reached" clip a PlaybackInfo hands out for a Live TV
// provider's own limit is not a stream: its reports must not create a session or
// write progress onto the real item.
describe('POST /j/Sessions/Playing|Progress|Stopped — limit-clip reports are ignored', () => {
    const NOTICE = 'c0ffee'.padEnd(32, '0');

    beforeEach(() => {
        valkey.set(
            noticeInternals.noticeKey(NOTICE),
            JSON.stringify({ userId: 'uid-alice', kind: 'livetv_source', lang: 'en', cap: 2 }),
        );
    });

    for (const [name, handler] of [
        ['Playing', () => POST],
        ['Progress', () => PROGRESS],
        ['Stopped', () => STOPPED],
    ] as const) {
        it(`${name}: a report carrying the clip's PlaySessionId is a no-op`, async () => {
            mockParsePlaybackBody.mockResolvedValue({
                itemId: ITEM_ID,
                positionMs: 15_000,
                playSessionId: NOTICE,
                isPaused: false,
            });
            const res = await handler()!(makeEvent({ peer: '198.51.100.9' }));
            expect(res.status).toBe(204);
            expect(mockFindOrCreateJellyfinSession).not.toHaveBeenCalled();
            expect(mockFindActiveSession).not.toHaveBeenCalled();
            expect(mockUpdate).not.toHaveBeenCalled();
        });
    }

    it('matches on MediaSourceId too (clients that drop PlaySessionId)', async () => {
        mockParsePlaybackBody.mockResolvedValue({
            itemId: ITEM_ID,
            positionMs: 15_000,
            playSessionId: undefined,
            mediaSourceId: NOTICE,
        });
        const res = await POST!(makeEvent({ peer: '198.51.100.9' }));
        expect(res.status).toBe(204);
        expect(mockFindOrCreateJellyfinSession).not.toHaveBeenCalled();
    });

    it('a real report with an unknown 32-hex PlaySessionId is still tracked', async () => {
        mockParsePlaybackBody.mockResolvedValue({
            itemId: ITEM_ID,
            positionMs: 1000,
            playSessionId: 'd'.repeat(32),
        });
        const res = await POST!(makeEvent({ peer: '198.51.100.9' }));
        expect(res.status).toBe(204);
        expect(mockFindOrCreateJellyfinSession).toHaveBeenCalled();
        expect(mockUpdate).toHaveBeenCalled();
    });
});

// A /j client's play_sessions row has its OWN id, so the lifecycle heartbeat
// never reaches the transcode job, which is keyed by the client's PlaySessionId.
// Without this a paused Jellyfin client (no segment fetches) looks gone to the
// client-gone reaper after FFMPEG_CLIENT_GONE_TIMEOUT_SECONDS.
describe('POST /j/Sessions/Playing/Progress — keeps the transcode job alive', () => {
    it('forwards the report to the transcode job under the client PlaySessionId', async () => {
        const sid = 'a8a1d0c2-5c1e-4f5b-9a57-6f0b8f3c2e11';
        mockParsePlaybackBody.mockResolvedValue({
            itemId: ITEM_ID,
            positionMs: 4200,
            isPaused: true,
            playSessionId: sid,
        });

        const res = await PROGRESS!(makeEvent({ peer: '198.51.100.9' }));

        expect(res.status).toBe(204);
        expect(mockRecordProgressHeartbeat).toHaveBeenCalledWith(sid, 'PAUSED', 'alice');
    });
});

describe('POST /j/Sessions/Playing/Progress — play-token renewal', () => {
    it('renews the play token only after the access check passes', async () => {
        mockParsePlaybackBody.mockResolvedValue({
            itemId: ITEM_ID,
            positionMs: 0,
            playSessionId: 'sess-r',
        });
        mockCheckMediaAccess.mockResolvedValue(false);
        const denied = await PROGRESS!(makeEvent({ peer: '198.51.100.9' }));
        expect(denied.status).toBe(404);
        expect(mockRenewPlayToken).not.toHaveBeenCalled();

        mockCheckMediaAccess.mockResolvedValue(true);
        await PROGRESS!(makeEvent({ peer: '198.51.100.9' }));
        expect(mockRenewPlayToken).toHaveBeenCalledWith(
            'sess-r',
            expect.objectContaining({ userId: expect.any(String), itemId: expect.any(String) }),
        );
    });
});

// Android TV reports the OLD session Stopped as it starts the new one (audio or
// subtitle switch). Stopping by item + user, and only when a play_sessions row
// matched, left the old 4K burn-in transcode running beside the new one until
// the web pod was OOM-killed (prod 2026-10-02).
describe('POST /j/Sessions/Playing/Stopped — stops the transcode it names', () => {
    it('stops the reported PlaySessionId for this user, even without a session row', async () => {
        mockFindActiveSession.mockResolvedValue(null);
        const res = await STOPPED!(makeEvent({ peer: '198.51.100.9' }));
        expect(res.status).toBe(204);
        await vi.waitFor(() =>
            expect(mockStopJobForUser).toHaveBeenCalledWith('sess-1', 'alice', 'client_stopped'),
        );
        expect(mockStopJobByItemAndUser).not.toHaveBeenCalled();
    });

    it('never guesses by item + user when the named session is already gone', async () => {
        // After a switch the old job may be gone; item + user would hit the NEW one.
        mockFindActiveSession.mockResolvedValue({ id: 'play-session-1' });
        mockStopJobForUser.mockResolvedValueOnce(false);
        await STOPPED!(makeEvent({ peer: '198.51.100.9' }));
        await vi.waitFor(() => expect(mockStopJobForUser).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 10));
        expect(mockStopJobByItemAndUser).not.toHaveBeenCalled();
    });

    it('a report without a session id falls back to item + user when a session row matched', async () => {
        mockParsePlaybackBody.mockResolvedValue({ itemId: ITEM_ID, positionMs: 0 });
        mockFindActiveSession.mockResolvedValue({ id: 'play-session-1' });
        await STOPPED!(makeEvent({ peer: '198.51.100.9' }));
        await vi.waitFor(() =>
            expect(mockStopJobByItemAndUser).toHaveBeenCalledWith(
                ITEM_ID,
                'alice',
                'client_stopped',
            ),
        );
        expect(mockStopJobForUser).not.toHaveBeenCalled();
    });

    it('a report with neither a session id nor a session row stops nothing', async () => {
        mockParsePlaybackBody.mockResolvedValue({ itemId: ITEM_ID, positionMs: 0 });
        mockFindActiveSession.mockResolvedValue(null);
        await STOPPED!(makeEvent({ peer: '198.51.100.9' }));
        await new Promise((r) => setTimeout(r, 10));
        expect(mockStopJobForUser).not.toHaveBeenCalled();
        expect(mockStopJobByItemAndUser).not.toHaveBeenCalled();
    });
});
