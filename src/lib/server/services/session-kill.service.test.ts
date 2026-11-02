// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for session-kill.service.ts — kick-cooldown decision.
 *
 * Regression guard for the "user stops their own stream → locked out of new
 * playback for 120s" bug: force-stopping your OWN session must NOT set the
 * anti-resurrection kick cooldown (which would make the next HLS manifest fetch
 * 403 → "your session is no longer authorized"). An admin killing SOMEONE
 * ELSE's session still sets the cooldown.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { revokeGrantsForPlaySession } = vi.hoisted(() => ({
    revokeGrantsForPlaySession: vi.fn().mockResolvedValue(0),
}));
vi.mock('$lib/server/services/playback-grant.js', () => ({ revokeGrantsForPlaySession }));

// ── Module mocks ─────────────────────────────────────────────────────────────

const mockKillSession = vi.fn();
const mockNotifySessionKilled = vi.fn();
const mockCoordSet = vi.fn();
const mockGetCoordinationClient = vi.fn();

vi.mock('$lib/server/database/queries/play-sessions.queries.js', () => ({
    killSession: (...args: unknown[]) => mockKillSession(...args),
}));

vi.mock('$lib/server/services/play-session-events.service.js', () => ({
    notifySessionKilled: (...args: unknown[]) => mockNotifySessionKilled(...args),
}));

vi.mock('$lib/server/cache/valkey.js', () => ({
    getCoordinationClient: () => mockGetCoordinationClient(),
}));

vi.mock('@valkey/valkey-glide', () => ({
    TimeUnit: { Seconds: 'Seconds' },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

// Dynamic imports inside the service — stub so they resolve to no-op services.
vi.mock('$lib/server/services/ffmpeg-transcode.service.js', () => ({
    getFFmpegTranscodeService: () => ({ stopJob: vi.fn().mockResolvedValue(false) }),
}));
vi.mock('$lib/server/services/music-transcode/index.js', () => ({
    getMusicTranscodeService: () => ({ cancel: vi.fn().mockReturnValue(false) }),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { killSessionUnified } from './session-kill.service.js';

const KICK_KEY_PREFIX = 'sessions:v1:kicked:';
const fakeSql = {} as never;

beforeEach(() => {
    vi.clearAllMocks();
    mockGetCoordinationClient.mockReturnValue({ set: (...a: unknown[]) => mockCoordSet(...a) });
});

describe('killSessionUnified kick cooldown', () => {
    it('sets the kick cooldown when an admin kills another user’s session', async () => {
        mockKillSession.mockResolvedValue({ id: 'sess-1', owner_username: 'testviewer' });

        const result = await killSessionUnified(fakeSql, 'sess-1', 'admin-testuser');

        expect(revokeGrantsForPlaySession).toHaveBeenCalledWith('sess-1', fakeSql, 'admin_kill');
        expect(result).toEqual({ killed: true, source: 'database', username: 'testviewer' });
        expect(mockCoordSet).toHaveBeenCalledTimes(1);
        expect(mockCoordSet.mock.calls[0][0]).toBe(`${KICK_KEY_PREFIX}testviewer`);
    });

    it('does NOT set the cooldown when the owner stops their own session (self-kill)', async () => {
        mockKillSession.mockResolvedValue({ id: 'sess-1', owner_username: 'testviewer' });

        const result = await killSessionUnified(fakeSql, 'sess-1', 'testviewer');

        expect(result).toEqual({ killed: true, source: 'database', username: 'testviewer' });
        expect(mockCoordSet).not.toHaveBeenCalled();
    });

    it('treats a self-kill whose username differs only in case as a self-kill', async () => {
        mockKillSession.mockResolvedValue({ id: 'sess-1', owner_username: 'testviewer' });

        await killSessionUnified(fakeSql, 'sess-1', 'Testviewer');

        expect(mockCoordSet).not.toHaveBeenCalled();
    });

    it('keys the cooldown by the folded username, so a mixed-case check still finds it', async () => {
        mockKillSession.mockResolvedValue({ id: 'sess-1', owner_username: 'Testviewer' });

        await killSessionUnified(fakeSql, 'sess-1', 'admin-testuser');

        expect(mockCoordSet.mock.calls[0][0]).toBe(`${KICK_KEY_PREFIX}testviewer`);
    });

    it('respects an explicit setCooldown:false even for a foreign kill (reconciler path)', async () => {
        mockKillSession.mockResolvedValue({ id: 'sess-1', owner_username: 'testviewer' });

        await killSessionUnified(fakeSql, 'sess-1', 'stream-limit-reconciler', {
            setCooldown: false,
            reason: 'stream_limit',
        });

        expect(mockCoordSet).not.toHaveBeenCalled();
    });

    it('returns null and never touches the cooldown when the session does not exist', async () => {
        mockKillSession.mockResolvedValue(null);

        const result = await killSessionUnified(fakeSql, 'missing', 'admin-testuser');

        expect(result).toBeNull();
        expect(mockCoordSet).not.toHaveBeenCalled();
    });
});
