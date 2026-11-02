// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    SessionRow,
    AudiobookClosePayload,
} from '../database/queries/play-sessions.queries.js';
import type { SessionUpdateInternal } from '$lib/schemas/session-update.js';
const mocks = vi.hoisted(() => ({
    get: vi.fn(),
    touch: vi.fn(),
    ratchet: vi.fn(),
    advance: vi.fn(),
    mirror: vi.fn(),
    prepare: vi.fn(),
    claim: vi.fn(),
    done: vi.fn(),
    release: vi.fn(),
    sync: vi.fn(),
    close: vi.fn(),
    finish: vi.fn(),
    patch: vi.fn(),
    sql: vi.fn(),
    revoke: vi.fn(async () => 0),
    inTx: false,
}));
vi.mock('../database/with-tx.js', () => ({
    withTx: async (sql: unknown, cb: (sql: unknown) => unknown) => {
        mocks.inTx = true;
        try {
            return await cb(sql);
        } finally {
            mocks.inTx = false;
        }
    },
}));
vi.mock('../database/queries/play-sessions.queries.js', () => ({
    getSessionById: mocks.get,
    getSessionBySourceKey: mocks.get,
    prepareAudiobookSessionClose: mocks.prepare,
    claimAudiobookSessionClose: mocks.claim,
    markAudiobookSessionCloseDone: mocks.done,
    releaseAudiobookSessionClose: mocks.release,
    getAudiobookClosePayload: (row: SessionRow) => row.external_payload,
    supersedeReplacedAudiobookSessions: vi.fn(),
    upsertExternalSession: vi.fn(),
    AUDIOBOOK_PURPOSE_KEY: '__lumastra_audiobook_purpose',
}));
vi.mock('../database/queries/audiobooks.queries.js', () => ({
    advanceAudiobookSessionPosition: mocks.advance,
    touchAudiobookSessionHeartbeat: mocks.touch,
    ratchetAudiobookSessionElapsed: mocks.ratchet,
    resolveAudiobookPlaybackTarget: vi.fn(async () => ({ absItemId: 'book-upstream' })),
}));
vi.mock('./watch-state-rebuilder.service.js', () => ({ appendEventAndRebuild: mocks.mirror }));
vi.mock('./audiobookshelf-credentials.service.js', () => ({
    resolveUserApiKey: vi.fn(async () => 'listener-key'),
}));
vi.mock('../tasks/secrets.js', () => ({ PluginSecrets: class {} }));
vi.mock('../config/config.service.js', () => ({ getConfigState: () => null }));
vi.mock('./play-sessions.service.js', () => ({
    enforceStreamPolicy: vi.fn(),
    isPolicyError: vi.fn(),
}));
vi.mock('../oauth/streaming-session.service.js', () => ({
    getStreamingSessionService: vi.fn(),
    WILDCARD_IP: '*',
}));
vi.mock('./playback-grant.js', () => ({
    mintPlaybackGrant: vi.fn(),
    buildGrantedHref: vi.fn(),
    revokeGrantsForPlaySession: mocks.revoke,
}));
vi.mock('./play-session-events.service.js', () => ({ notifySessionTerminated: vi.fn() }));
import { reportAudiobookPlaybackSession } from './audiobook-session.service.js';
import { toUserId } from '$lib/shared/user-id.js';
const userId = toUserId('00000000-0000-4000-8000-000000000001');
let row: SessionRow;
function report(overrides: Partial<SessionUpdateInternal> = {}) {
    return reportAudiobookPlaybackSession({
        sql: mocks.sql as never,
        playbackSessionId: 'local-playback-id',
        userId,
        username: 'listener',
        deps: {
            client: {
                syncSessionAs: mocks.sync,
                closeSessionAs: mocks.close,
                markFinishedAs: mocks.finish,
                patchProgressAs: mocks.patch,
                startPlaybackSessionAs: vi.fn(),
                getMeAs: vi.fn(async () => ({
                    id: 'abs-listener',
                    username: 'listener',
                    mediaProgress: [],
                })),
            },
            credentials: {} as never,
        },
        report: {
            position_ms: 90000,
            listened_ms: 12000,
            session_elapsed_ms: 15000,
            status: 'ACTIVE',
            event_seq: 2,
            ...overrides,
        },
    });
}
beforeEach(() => {
    vi.resetAllMocks();
    row = {
        id: 'local-playback-id',
        user_id: userId,
        media_id: 'local-book',
        media_type: 'audiobook',
        source_session_id: 'abs-only-on-server',
        status: 'ACTIVE',
        last_event_seq: 1,
        runtime_ms: 600000,
        position_ms: 1000,
        paused_at: null,
        last_seen_at: new Date(),
        external_payload: null,
    } as unknown as SessionRow;
    mocks.get.mockImplementation(async () => row);
    mocks.touch.mockResolvedValue({ positionMs: 1000, runtimeMs: 600000 });
    mocks.ratchet.mockResolvedValue(0);
    mocks.advance.mockResolvedValue(1);
    mocks.sync.mockResolvedValue(true);
    mocks.close.mockResolvedValue(true);
    mocks.finish.mockResolvedValue(true);
    mocks.patch.mockResolvedValue(true);
    mocks.claim.mockImplementation(async () => row);
    mocks.prepare.mockImplementation(async (_sql, input) => {
        row = {
            ...row,
            status: 'COMPLETED',
            stopped_at: new Date(),
            external_payload: { ...input.payload, state: 'pending' },
        };
        return row;
    });
    mocks.release.mockImplementation(async () => {
        const payload = row.external_payload as AudiobookClosePayload;
        row.external_payload = {
            ...payload,
            state: 'pending',
            attempts: (payload.attempts ?? 0) + 1,
        };
        return false;
    });
    mocks.done.mockImplementation(async () => {
        row.external_payload = {
            ...(row.external_payload as AudiobookClosePayload),
            state: 'done',
        };
    });
});
describe('unified audiobook report adapter', () => {
    it('maps ms to ABS seconds, uses the row source id, and durably queues local playback for recovery', async () => {
        expect((await report()).ok).toBe(true);
        expect(mocks.get).toHaveBeenCalledWith(mocks.sql, 'local-playback-id');
        expect(mocks.sync).toHaveBeenCalledWith('listener-key', 'abs-only-on-server', {
            currentTime: 90,
            timeListened: 12,
            duration: 600,
        });
        expect(mocks.mirror).toHaveBeenCalledWith(
            mocks.sql,
            expect.objectContaining({ source: 'lumastra-player', position_ms: 90000 }),
        );
        expect(mocks.touch.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.advance.mock.invocationCallOrder[0],
        );
    });
    it('does not acknowledge or sync progress when its durable queue write fails', async () => {
        mocks.mirror.mockRejectedValueOnce(new Error('database write failed'));
        await expect(report()).rejects.toThrow('database write failed');
        expect(mocks.sync).not.toHaveBeenCalled();
    });
    it('derives heard audio from elapsed when listened_ms is absent', async () => {
        await report({ listened_ms: undefined });
        expect(mocks.sync).toHaveBeenCalledWith(
            'listener-key',
            'abs-only-on-server',
            expect.objectContaining({ timeListened: 15 }),
        );
    });
    it('forwards the delta of the cumulative elapsed time when listened_ms is absent', async () => {
        // The stored highest elapsed time before each report: 0, 30 s, 60 s.
        for (const [seq, elapsed, previous] of [
            [2, 30000, 0],
            [3, 60000, 30000],
            [4, 90000, 60000],
        ] as const) {
            mocks.ratchet.mockResolvedValueOnce(previous);
            await report({ listened_ms: undefined, session_elapsed_ms: elapsed, event_seq: seq });
        }
        expect(mocks.ratchet.mock.calls.map((c) => c[2])).toEqual([30000, 60000, 90000]);
        expect(mocks.sync.mock.calls.map((c) => c[2].timeListened)).toEqual([30, 30, 30]);
    });
    it('never forwards a negative delta, and ratchets explicit reports too', async () => {
        mocks.ratchet.mockResolvedValueOnce(90000);
        await report({ listened_ms: undefined, session_elapsed_ms: 30000, event_seq: 3 });
        expect(mocks.sync.mock.calls[0][2].timeListened).toBe(0);
        mocks.ratchet.mockClear();
        await report({ listened_ms: 12000, session_elapsed_ms: 99000, event_seq: 4 });
        expect(mocks.ratchet).toHaveBeenCalledWith(mocks.sql, row.id, 99000);
        expect(mocks.sync.mock.calls[1][2].timeListened).toBe(12);
    });
    it('mixed explicit and omitted heard reports advance one baseline', async () => {
        let baseline = 0;
        mocks.ratchet.mockImplementation(async (_sql, _id, elapsed) => {
            const previous = baseline;
            baseline = Math.max(baseline, elapsed);
            return previous;
        });
        await report({ event_seq: 2, listened_ms: 15000, session_elapsed_ms: 15000 });
        await report({ event_seq: 3, listened_ms: undefined, session_elapsed_ms: 20000 });
        await report({ event_seq: 4, listened_ms: 3000, session_elapsed_ms: 23000 });
        await report({ event_seq: 5, listened_ms: undefined, session_elapsed_ms: 25000 });
        expect(mocks.sync.mock.calls.map((call) => call[2].timeListened)).toEqual([15, 5, 3, 2]);
    });
    it.each([0, 1])('stale sequence %s is a no-op acknowledgement', async (event_seq) => {
        expect((await report({ event_seq })).ok).toBe(true);
        expect(mocks.advance).not.toHaveBeenCalled();
        expect(mocks.sync).not.toHaveBeenCalled();
        expect(mocks.mirror).not.toHaveBeenCalled();
    });
    it('refuses a terminal row without reviving it', async () => {
        row.status = 'COMPLETED';
        expect((await report()).ok).toBe(false);
        expect(mocks.touch).not.toHaveBeenCalled();
        expect(mocks.sync).not.toHaveBeenCalled();
    });
    it('refuses another owner', async () => {
        row.user_id = '00000000-0000-4000-8000-000000000002';
        expect((await report()).ok).toBe(false);
        expect(mocks.advance).not.toHaveBeenCalled();
    });
    it('maps finished into the durable close payload', async () => {
        await report({ status: 'COMPLETED', finished: true });
        expect(mocks.prepare).toHaveBeenCalledWith(
            mocks.sql,
            expect.objectContaining({
                sourceSessionId: 'abs-only-on-server',
                payload: expect.objectContaining({
                    positionMs: 90000,
                    listenedMs: 12000,
                    isFinished: true,
                }),
            }),
        );
        expect(mocks.finish).toHaveBeenCalledWith('listener-key', 'book-upstream');
        expect(mocks.revoke).toHaveBeenCalledWith(row.id, mocks.sql, 'stopped');
    });
    it('does not discard explicit finished:false as an unchanged heartbeat', async () => {
        await report({ finished: false, listened_ms: 0, position_ms: 1000 });
        expect(mocks.patch).toHaveBeenCalledWith('listener-key', 'book-upstream', {
            isFinished: false,
        });
        expect(mocks.finish).not.toHaveBeenCalled();
    });
    it('retries an explicit unfinish without closing the ABS session twice', async () => {
        mocks.patch.mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValue(true);
        await report({ status: 'COMPLETED', finished: false });
        expect(mocks.release).toHaveBeenCalledWith(
            mocks.sql,
            'abs-only-on-server',
            expect.any(String),
            { upstreamClosed: true },
        );
        // The persisted retry marker is written by the real query on release.
        (row.external_payload as AudiobookClosePayload).upstreamClosed = true;
        await report({ status: 'COMPLETED', event_seq: 1 });
        expect(mocks.patch).toHaveBeenCalledTimes(2);
        expect(mocks.close).toHaveBeenCalledOnce();
        expect(mocks.done).toHaveBeenCalledOnce();
    });

    it('a stale paused close does not assert position locally or upstream', async () => {
        row.status = 'PAUSED';
        row.paused_at = new Date(Date.now() - 20 * 60000);
        await report({ status: 'COMPLETED' });
        expect(mocks.mirror).not.toHaveBeenCalled();
        expect(mocks.close).toHaveBeenCalledWith('listener-key', 'abs-only-on-server', null);
    });
    it('retries a failed close without replaying progress, even with a stale sequence', async () => {
        mocks.close
            .mockRejectedValueOnce(new Error('upstream unavailable'))
            .mockResolvedValue(true);
        await report({ status: 'COMPLETED' });
        expect(mocks.release).toHaveBeenCalledOnce();
        mocks.mirror.mockClear();
        await report({
            status: 'COMPLETED',
            event_seq: 1,
            position_ms: 1,
            listened_ms: 999,
            finished: true,
        });
        expect(mocks.close.mock.calls[1]).toEqual(['listener-key', 'abs-only-on-server', null]);
        expect(mocks.prepare).toHaveBeenCalledOnce();
        expect(mocks.mirror).not.toHaveBeenCalled();
        expect(mocks.finish).not.toHaveBeenCalled();
    });
    it.each(['ACTIVE', 'PAUSED'] as const)(
        'heartbeat-only %s touches liveness without overwriting progress',
        async (status) => {
            await report({ status, listened_ms: 0, position_ms: 1000 });
            expect(mocks.touch).toHaveBeenCalledOnce();
            expect(mocks.advance).not.toHaveBeenCalled();
            expect(mocks.mirror).not.toHaveBeenCalled();
            expect(mocks.sync).not.toHaveBeenCalled();
        },
    );
    it.each(['ACTIVE', 'PAUSED'] as const)(
        'stale COMPLETED still closes a live %s row',
        async (status) => {
            row.status = status;
            await report({ status: 'COMPLETED', event_seq: 1 });
            expect(mocks.prepare).toHaveBeenCalledOnce();
            expect(mocks.close).toHaveBeenCalledOnce();
        },
    );
    it('finished bypasses stale ordering and closes', async () => {
        await report({ finished: true, event_seq: 1 });
        expect(mocks.finish).toHaveBeenCalledOnce();
    });
    it.each(['ACTIVE', 'COMPLETED'] as const)(
        'never holds a transaction over ABS calls: %s',
        async (status) => {
            mocks.sync.mockImplementation(async () => {
                expect(mocks.inTx).toBe(false);
                return true;
            });
            mocks.close.mockImplementation(async () => {
                expect(mocks.inTx).toBe(false);
                return true;
            });
            await report({ status });
            expect(status === 'ACTIVE' ? mocks.sync : mocks.close).toHaveBeenCalledOnce();
        },
    );
    it('claims the immutable close under the lock and finalizes after commit', async () => {
        mocks.claim.mockImplementation(async () => {
            expect(mocks.inTx).toBe(true);
            return row;
        });
        mocks.done.mockImplementation(async () => {
            expect(mocks.inTx).toBe(false);
        });
        await report({ status: 'COMPLETED' });
        expect(mocks.claim).toHaveBeenCalledOnce();
        expect(mocks.done).toHaveBeenCalledOnce();
    });
    it('honors the durable close claim held by another worker', async () => {
        mocks.claim.mockResolvedValue(null);
        await report({ status: 'COMPLETED' });
        expect(mocks.close).not.toHaveBeenCalled();
    });
});
