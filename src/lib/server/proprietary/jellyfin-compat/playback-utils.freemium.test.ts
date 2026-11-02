// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the /j freemium concurrency enforcement. The cap is per
 * SERVER, so the session list here is every live /j session on the
 * install, oldest first, across users. The critical property: the allowed
 * (oldest) stream is NEVER kicked, and any error fails safe (no kick).
 *
 * That the query really returns only /j rows (and never web / native-app rows)
 * is covered against a real database in playback-utils.freemium.integration.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
    warn: vi.fn(),
    cap: null as number | null,
    sessions: [] as {
        id: string;
        user_id: string;
        media_id: string;
        started_at: Date;
        username: string;
        jellyfin_play_session_id: string | null;
        last_event_seq: number;
    }[],
    banned: false,
    stopSession: vi.fn(async () => ({}) as unknown),
    revoke: vi.fn(async () => {}),
    markBan: vi.fn(async () => {}),
    lifecycleUpdate: vi.fn(async (_id: string, _payload: Record<string, unknown>) => undefined),
    stopJob: vi.fn(async () => true),
    stopByItem: vi.fn(async () => true),
}));

vi.mock('$lib/server/licensing/entitlements', () => ({
    getEffectiveEntitlements: async () => ({
        jellyfinMaxConcurrentStreams: h.cap,
        aiAssistant: true,
    }),
}));
vi.mock('$lib/server/database/queries/play-sessions.queries', () => ({
    // Mirrors the real query: oldest first.
    getLiveJellyfinCompatSessions: async () =>
        [...h.sessions].sort((a, b) => a.started_at.getTime() - b.started_at.getTime()),
    stopSession: h.stopSession,
    findActiveSession: vi.fn(),
    createPlaySession: vi.fn(),
}));
vi.mock('$lib/server/services/play-sessions.service', () => ({
    enforceStreamPolicy: vi.fn(),
    isPolicyError: () => false,
}));
vi.mock('./play-token', () => ({
    revokePlayTokenBySession: h.revoke,
    markStreamLimitBan: h.markBan,
    isStreamLimitBanned: async () => h.banned,
}));
vi.mock('$lib/server/services/ffmpeg-transcode.service.js', () => ({
    getFFmpegTranscodeService: () => ({
        stopJob: h.stopJob,
        stopJobForUser: h.stopJob,
        stopJobByItemAndUser: h.stopByItem,
    }),
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info() {}, warn: h.warn, error() {}, debug() {} }) },
}));

vi.mock('$lib/server/services/play-session-lifecycle.service.js', () => ({
    getPlaySessionLifecycleService: () => ({ update: h.lifecycleUpdate }),
    reportMusicSessionStart: vi.fn(),
}));

import { enforceFreemiumStreamLimit } from './playback-utils';
import type { UserId } from '$lib/shared/user-id';

const USER = 'user-uuid' as UserId;
const OTHER = 'other-user-uuid' as UserId;
const SQL = {} as never;

function session(id: string, ageMs: number, mediaId = `media-${id}`, userId: string = USER) {
    return {
        id,
        user_id: userId,
        username: 'alice',
        jellyfin_play_session_id: null,
        last_event_seq: 0,
        media_id: mediaId,
        started_at: new Date(Date.now() - ageMs),
    };
}

beforeEach(() => {
    h.cap = null;
    h.sessions = [];
    h.banned = false;
    h.stopSession.mockClear();
    h.lifecycleUpdate.mockClear();
    h.stopJob.mockClear();
    h.stopByItem.mockClear();
    h.revoke.mockClear();
    h.markBan.mockClear();
});

describe('enforceFreemiumStreamLimit', () => {
    it('does nothing when unlimited (licensed / enforcement off)', async () => {
        h.cap = null;
        h.sessions = [session('a', 60_000), session('b', 60_000)];
        expect(await enforceFreemiumStreamLimit(SQL, USER, 'b', 0)).toBe(false);
        expect(h.lifecycleUpdate).not.toHaveBeenCalled();
    });

    it('never kicks the allowed (oldest) stream', async () => {
        h.cap = 1;
        // 'a' oldest (allowed), 'b' newer (extra). Ask about 'a'.
        h.sessions = [session('a', 60_000), session('b', 60_000)];
        expect(await enforceFreemiumStreamLimit(SQL, USER, 'a', 0)).toBe(false);
        expect(h.lifecycleUpdate).not.toHaveBeenCalled();
    });

    it('does not kick an extra stream still within grace', async () => {
        h.cap = 1;
        h.sessions = [session('a', 60_000), session('b', 3_000)]; // b is 3s old < 10s grace
        expect(await enforceFreemiumStreamLimit(SQL, USER, 'b', 0)).toBe(false);
        expect(h.lifecycleUpdate).not.toHaveBeenCalled();
    });

    it('kicks + tears down an extra stream past grace', async () => {
        h.cap = 1;
        h.sessions = [session('a', 60_000), session('b', 15_000)]; // b past 10s grace
        expect(await enforceFreemiumStreamLimit(SQL, USER, 'b', 1234, 'play-sess-b')).toBe(true);
        expect(h.lifecycleUpdate).toHaveBeenCalledWith(
            'b',
            expect.objectContaining({ position_ms: 1234, stop_reason: 'license_stream_limit' }),
        );
        expect(h.revoke).toHaveBeenCalledWith('play-sess-b');
        expect(h.stopJob).toHaveBeenCalledWith('play-sess-b', 'alice', 'license_stream_limit');
        expect(h.markBan).toHaveBeenCalledWith(USER);
    });

    it('kicks an extra immediately (zero grace) while banned', async () => {
        h.cap = 1;
        h.banned = true;
        h.sessions = [session('a', 60_000), session('b', 500)]; // b only 0.5s old
        expect(await enforceFreemiumStreamLimit(SQL, USER, 'b', 0)).toBe(true);
        expect(h.lifecycleUpdate).toHaveBeenCalled();
    });

    it('still revokes, stops and bans when lifecycle close fails', async () => {
        h.cap = 1;
        h.sessions = [session('a', 60_000), session('b', 15_000)];
        h.lifecycleUpdate.mockRejectedValueOnce(new Error('db down'));
        expect(await enforceFreemiumStreamLimit(SQL, USER, 'b', 0, 'client-b')).toBe(true);
        expect(h.revoke).toHaveBeenCalledWith('client-b');
        expect(h.stopJob).toHaveBeenCalledWith('client-b', 'alice', 'license_stream_limit');
        expect(h.markBan).toHaveBeenCalledWith(USER);
        expect(h.warn).toHaveBeenCalled();
    });

    it('does not stop another device playing the same item when the client id is unknown', async () => {
        h.cap = 1;
        h.sessions = [session('a', 60_000, 'same-item'), session('b', 15_000, 'same-item')];
        expect(await enforceFreemiumStreamLimit(SQL, USER, 'b', 0)).toBe(true);
        expect(h.stopByItem).not.toHaveBeenCalled();
        expect(h.stopJob).not.toHaveBeenCalled();
    });

    it('closes with an event sequence strictly above the last accepted event', async () => {
        h.cap = 0;
        const lastSeq = Date.now() + 60_000;
        h.sessions = [{ ...session('b', 15_000), last_event_seq: lastSeq }];
        await enforceFreemiumStreamLimit(SQL, USER, 'b', 0);
        expect(h.lifecycleUpdate.mock.calls[0]?.[1]).toEqual(
            expect.objectContaining({ event_seq: lastSeq + 1 }),
        );
    });

    it("counts /j streams across users: a second user's stream is the extra", async () => {
        h.cap = 1;
        // Alice's stream is older; Bob's is his only one but the server is full.
        h.sessions = [session('a', 60_000, 'media-a', OTHER), session('b', 15_000, 'media-b')];
        expect(await enforceFreemiumStreamLimit(SQL, OTHER, 'a', 0)).toBe(false);
        expect(await enforceFreemiumStreamLimit(SQL, USER, 'b', 0, 'play-sess-b')).toBe(true);
        expect(h.lifecycleUpdate).toHaveBeenCalledTimes(1);
        expect(h.lifecycleUpdate).toHaveBeenCalledWith(
            'b',
            expect.objectContaining({ position_ms: 0, stop_reason: 'license_stream_limit' }),
        );
        expect(h.markBan).toHaveBeenCalledWith(USER);
    });

    it('never kicks a session that is not a /j stream (web / native app)', async () => {
        h.cap = 1;
        // Two /j streams fill the server, but the session being reported is a
        // web-app row, which the /j query never returns.
        h.sessions = [session('a', 60_000), session('b', 60_000, 'media-b', OTHER)];
        expect(await enforceFreemiumStreamLimit(SQL, USER, 'web-row', 0)).toBe(false);
        expect(h.lifecycleUpdate).not.toHaveBeenCalled();
    });

    it('does nothing with one /j stream on the server', async () => {
        h.cap = 1;
        h.sessions = [session('a', 60_000)];
        expect(await enforceFreemiumStreamLimit(SQL, USER, 'a', 0)).toBe(false);
        expect(h.lifecycleUpdate).not.toHaveBeenCalled();
    });
});

describe('kick lifecycle', () => {
    it('saves the final position through the lifecycle service', async () => {
        h.cap = 1;
        h.sessions = [session('a', 60_000), session('b', 15_000)];
        expect(await enforceFreemiumStreamLimit(SQL, USER, 'b', 42000, 'client-b')).toBe(true);
        expect(h.lifecycleUpdate).toHaveBeenCalledWith(
            'b',
            expect.objectContaining({
                status: 'COMPLETED',
                position_ms: 42000,
                stop_reason: 'license_stream_limit',
            }),
        );
        expect(h.stopSession).not.toHaveBeenCalled();
    });
});

// The playback-START side of the cap (who gets the limit clip) is covered in
// stream-limit-notice.test.ts.
