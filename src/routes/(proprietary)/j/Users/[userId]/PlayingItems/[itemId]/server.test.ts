// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * The legacy playback-report endpoints (POST /j/Users/{userId}/PlayingItems/{itemId},
 * .../Progress, DELETE ...; also mounted userless at /j/PlayingItems/{itemId}).
 *
 * - They create the same /j session as /j/Sessions/Playing, so they must run the
 *   free-tier /j stream cap too (the counting lives in enforceFreemiumStreamLimit
 *   and is tested next to it; this pins that the routes call it and stop on a kick).
 * - Jellyfin sends positionTicks / isPaused / playSessionId as QUERY params on
 *   these routes. A body-only read saved position 0 on every stop. The real
 *   parsePlaybackReport runs here (not mocked): the query is the seam under test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/database/queries/media-type-cache.queries', () => ({
    getMediaType: async () => 'movie',
}));
vi.mock('$lib/server/database/queries/media-files.queries', () => ({
    getOwnerItemForFile: async () => null,
}));

import type { RequestHandler } from './$types';

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

vi.mock('$lib/server/services/database.service', () => ({
    aiDbService: { getSql: async () => ({}) },
}));

const mockCheckMediaAccess = vi.fn();
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...a: unknown[]) => mockCheckMediaAccess(...a),
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
        recordProgressHeartbeat: (...a: unknown[]) => mockRecordProgressHeartbeat(...a),
        stopJobForUser: (...a: unknown[]) => mockStopJobForUser(...(a as [])),
        stopJobByItemAndUser: (...a: unknown[]) => mockStopJobByItemAndUser(...(a as [])),
    }),
}));

const mockDisarmSilentStart = vi.fn(async () => undefined);
vi.mock('$lib/server/proprietary/jellyfin-compat/silent-start', () => ({
    disarmSilentStart: (...a: unknown[]) => mockDisarmSilentStart(...(a as [])),
}));

const mockRenewPlayToken = vi.fn(async () => undefined);
vi.mock('$lib/server/proprietary/jellyfin-compat/play-token', () => ({
    renewPlayTokenBySession: (...a: unknown[]) => mockRenewPlayToken(...(a as [])),
    revokePlayTokenBySession: async () => undefined,
    markStreamLimitBan: async () => undefined,
    isStreamLimitBanned: async () => false,
}));

const mockFindOrCreateJellyfinSession = vi.fn();
const mockEnforceFreemiumStreamLimit = vi.fn();
vi.mock('$lib/server/proprietary/jellyfin-compat/playback-utils', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('$lib/server/proprietary/jellyfin-compat/playback-utils')
        >();
    return {
        parsePlaybackBody: actual.parsePlaybackBody,
        parsePlaybackReport: actual.parsePlaybackReport,
        findOrCreateJellyfinSession: (...a: unknown[]) => mockFindOrCreateJellyfinSession(...a),
        enforceFreemiumStreamLimit: (...a: unknown[]) => mockEnforceFreemiumStreamLimit(...a),
        isPolicyError: (x: unknown): boolean =>
            typeof x === 'object' && x !== null && 'kind' in (x as Record<string, unknown>),
    };
});

const mockUpdate = vi.fn();
vi.mock('$lib/server/services/play-session-lifecycle.service', () => ({
    getPlaySessionLifecycleService: () => ({ update: mockUpdate }),
}));

const legacy = await import('./+server.js');
const legacyProgress = await import('./Progress/+server.js');
const root = await import('../../../../PlayingItems/[itemId]/+server.js');
const rootProgress = await import('../../../../PlayingItems/[itemId]/Progress/+server.js');

const ITEM_ID = '00000000-0000-4000-a000-000000000001';
const TICKS_PER_MS = 10_000;

function makeEvent(
    method: 'POST' | 'DELETE',
    opts: { query?: string; body?: unknown; suffix?: string } = {},
) {
    const url = new URL(
        `https://app.example/j/Users/uid-alice/PlayingItems/${ITEM_ID}${opts.suffix ?? ''}${opts.query ?? ''}`,
    );
    return {
        request: new Request(url, {
            method,
            ...(opts.body !== undefined
                ? {
                      body: JSON.stringify(opts.body),
                      headers: { 'content-type': 'application/json' },
                  }
                : {}),
        }),
        getClientAddress: () => '198.51.100.9',
        locals: {
            user: { userId: 'uid-alice', username: 'alice' },
            jfDevice: { deviceId: 'dev-1' },
        },
        url,
        params: { userId: 'uid-alice', itemId: ITEM_ID },
    } as never;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockFindOrCreateJellyfinSession.mockResolvedValue({ id: 'play-session-1' });
    mockEnforceFreemiumStreamLimit.mockResolvedValue(false);
    mockUpdate.mockResolvedValue(undefined);
    mockFindActiveSession.mockResolvedValue({ id: 'play-session-1' });
    mockCheckMediaAccess.mockResolvedValue(true);
});

describe('userless /j/PlayingItems routes', () => {
    it('are the legacy /Users/{userId}/PlayingItems handlers', () => {
        expect(root.POST).toBe(legacy.POST);
        expect(root.DELETE).toBe(legacy.DELETE);
        expect(rootProgress.POST).toBe(legacyProgress.POST);
    });
});

describe.each([
    ['start', () => legacy.POST!],
    ['progress', () => legacyProgress.POST!],
])('POST PlayingItems (%s) — free-tier /j stream cap', (_name, handler) => {
    it('asks the cap about this /j session and writes progress when allowed', async () => {
        const res = await handler()(
            makeEvent('POST', {
                body: { PositionTicks: 4200 * TICKS_PER_MS, PlaySessionId: 'sess-1' },
            }),
        );

        expect(res.status).toBe(204);
        expect(mockEnforceFreemiumStreamLimit).toHaveBeenCalledWith(
            expect.anything(),
            'uid-alice',
            'play-session-1',
            4200,
            'sess-1',
        );
        expect(mockUpdate).toHaveBeenCalled();
    });

    it('returns the kick response and writes no progress when the stream is the extra', async () => {
        mockEnforceFreemiumStreamLimit.mockResolvedValue(true);
        const res = await handler()(makeEvent('POST'));

        expect(res.status).toBe(403);
        expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('reads position and session from the query (Jellyfin) and disarms the detector', async () => {
        const res = await handler()(
            makeEvent('POST', {
                query: `?positionTicks=${90_000 * TICKS_PER_MS}&playSessionId=q-sess&mediaSourceId=src`,
            }),
        );

        expect(res.status).toBe(204);
        expect(mockUpdate).toHaveBeenCalledWith(
            'play-session-1',
            expect.objectContaining({ position_ms: 90_000 }),
        );
        expect(mockDisarmSilentStart).toHaveBeenCalledWith({
            playSessionId: 'q-sess',
            username: 'alice',
            itemId: ITEM_ID,
            userId: 'uid-alice',
            deviceId: 'dev-1',
        });
    });

    it('lets the query win over the body, field by field', async () => {
        await handler()(
            makeEvent('POST', {
                query: `?PositionTicks=${5000 * TICKS_PER_MS}`,
                body: { PositionTicks: 1, PlaySessionId: 'body-sess' },
            }),
        );
        expect(mockUpdate).toHaveBeenCalledWith(
            'play-session-1',
            expect.objectContaining({ position_ms: 5000 }),
        );
        expect(mockEnforceFreemiumStreamLimit).toHaveBeenCalledWith(
            expect.anything(),
            'uid-alice',
            'play-session-1',
            5000,
            'body-sess',
        );
    });
});

describe('POST PlayingItems/{id}/Progress', () => {
    it('honours ?isPaused=true and keeps the transcode alive as PAUSED', async () => {
        await legacyProgress.POST!(
            makeEvent('POST', {
                suffix: '/Progress',
                query: `?positionTicks=${1000 * TICKS_PER_MS}&isPaused=true&playSessionId=q-sess`,
            }),
        );
        expect(mockUpdate).toHaveBeenCalledWith(
            'play-session-1',
            expect.objectContaining({ position_ms: 1000, status: 'PAUSED' }),
        );
        expect(mockRecordProgressHeartbeat).toHaveBeenCalledWith('q-sess', 'PAUSED', 'alice');
    });

    it('records an ACTIVE heartbeat while playing', async () => {
        await legacyProgress.POST!(
            makeEvent('POST', { suffix: '/Progress', query: '?isPaused=false&playSessionId=q2' }),
        );
        expect(mockRecordProgressHeartbeat).toHaveBeenCalledWith('q2', 'ACTIVE', 'alice');
    });

    it('sends no heartbeat without a playSessionId', async () => {
        await legacyProgress.POST!(makeEvent('POST', { suffix: '/Progress' }));
        expect(mockRecordProgressHeartbeat).not.toHaveBeenCalled();
    });
});

describe('DELETE PlayingItems/{id} (stopped)', () => {
    it('saves the ?positionTicks= stop position, not 0', async () => {
        const res = await legacy.DELETE!(
            makeEvent('DELETE', { query: `?positionTicks=${123_000 * TICKS_PER_MS}` }),
        );

        expect(res.status).toBe(204);
        expect(mockUpdate).toHaveBeenCalledWith(
            'play-session-1',
            expect.objectContaining({ position_ms: 123_000, status: 'COMPLETED' }),
        );
    });

    it('still reads a JSON body when the query has no position', async () => {
        await legacy.DELETE!(makeEvent('DELETE', { body: { PositionTicks: 7000 * TICKS_PER_MS } }));
        expect(mockUpdate).toHaveBeenCalledWith(
            'play-session-1',
            expect.objectContaining({ position_ms: 7000 }),
        );
    });

    it('stops the transcode the report names, for this user only', async () => {
        await legacy.DELETE!(makeEvent('DELETE', { query: '?playSessionId=q-sess' }));
        expect(mockStopJobForUser).toHaveBeenCalledWith('q-sess', 'alice', 'client_stopped');
        expect(mockStopJobByItemAndUser).not.toHaveBeenCalled();
    });

    it('falls back to item + user only when a session of this user exists', async () => {
        await legacy.DELETE!(makeEvent('DELETE'));
        expect(mockStopJobByItemAndUser).toHaveBeenCalledWith(ITEM_ID, 'alice', 'client_stopped');

        vi.clearAllMocks();
        mockFindActiveSession.mockResolvedValue(null);
        await legacy.DELETE!(makeEvent('DELETE'));
        expect(mockStopJobByItemAndUser).not.toHaveBeenCalled();
        expect(mockUpdate).not.toHaveBeenCalled();
    });
});

describe.each([
    ['start', () => legacy.POST!, ''],
    ['progress', () => legacyProgress.POST!, '/Progress'],
])('POST PlayingItems (%s) — an item the caller may not see', (_name, handler, suffix) => {
    it('is a 404 with no disarm, no session write, no heartbeat and no token renewal', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);
        const res = await handler()(
            makeEvent('POST', {
                suffix,
                query: `?positionTicks=${1000 * TICKS_PER_MS}&isPaused=false&playSessionId=q-sess`,
            }),
        );

        expect(res.status).toBe(404);
        expect(mockDisarmSilentStart).not.toHaveBeenCalled();
        expect(mockFindOrCreateJellyfinSession).not.toHaveBeenCalled();
        expect(mockUpdate).not.toHaveBeenCalled();
        expect(mockRecordProgressHeartbeat).not.toHaveBeenCalled();
        expect(mockRenewPlayToken).not.toHaveBeenCalled();
    });
});

describe('DELETE PlayingItems/{id} — query vs body', () => {
    it('takes position and session from the query when both carry them', async () => {
        await legacy.DELETE!(
            makeEvent('DELETE', {
                query: `?positionTicks=${2000 * TICKS_PER_MS}&playSessionId=q-sess`,
                body: { PositionTicks: 9000 * TICKS_PER_MS, PlaySessionId: 'body-sess' },
            }),
        );
        expect(mockUpdate).toHaveBeenCalledWith(
            'play-session-1',
            expect.objectContaining({ position_ms: 2000 }),
        );
        expect(mockStopJobForUser).toHaveBeenCalledWith('q-sess', 'alice', 'client_stopped');
    });

    it('fills what the query leaves out from the body', async () => {
        await legacy.DELETE!(
            makeEvent('DELETE', {
                query: `?positionTicks=${2000 * TICKS_PER_MS}`,
                body: { PlaySessionId: 'body-sess' },
            }),
        );
        expect(mockStopJobForUser).toHaveBeenCalledWith('body-sess', 'alice', 'client_stopped');
    });
});
