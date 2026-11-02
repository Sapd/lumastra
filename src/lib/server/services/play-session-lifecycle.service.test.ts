// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { revokeGrantsForPlaySession } = vi.hoisted(() => ({
    revokeGrantsForPlaySession: vi.fn().mockResolvedValue(0),
}));
vi.mock('$lib/server/services/playback-grant.js', () => ({ revokeGrantsForPlaySession }));
import {
    PlaySessionLifecycleService,
    reportMusicSessionStart,
    type LifecycleDeps,
} from './play-session-lifecycle.service';
vi.mock('./watch-state-events.service.js', () => ({ watchStateEvents: { emit: vi.fn() } }));
import { watchStateEvents } from './watch-state-events.service.js';
import { MIN_ENGAGEMENT_MS } from '$lib/server/utils/watch-constants';
import { toUserId } from '$lib/shared/user-id';

// play_sessions.user_id is the stable users.id UUID (mig 16.46.0); the service
// mints it via toUserId(session.user_id) and forwards it as `userId` to the
// watch manager / history service. The mock session rows must carry a real UUID
// (a username would throw in toUserId), and assertions key on this same value.
const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';

const audiobookReportMock = vi.fn();
vi.mock('./audiobook-session.service.js', () => ({
    reportAudiobookPlaybackSession: (...args: unknown[]) => audiobookReportMock(...args),
}));

const applyMusicLiveInfoMock = vi.fn();
vi.mock('./music-session-live-info.js', () => ({
    applyMusicHeartbeatLiveInfo: (...args: unknown[]) => applyMusicLiveInfoMock(...args),
    clearMusicSessionLiveInfo: vi.fn(),
}));

const reportPlayEndMock = vi.fn().mockResolvedValue({ duplicate: false });
const reportPlayStartMock = vi.fn().mockResolvedValue(undefined);
const { publishIntegrationEvent } = vi.hoisted(() => ({
    publishIntegrationEvent: vi.fn(async (_event: { type: string; payload: unknown }) => undefined),
}));
vi.mock('$lib/server/plugins/runtime/integration-events.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    publishIntegrationEvent,
}));
vi.mock('$lib/server/services/music-interaction-manager.service.js', () => ({
    musicInteractionManager: {
        reportPlayEnd: (...args: unknown[]) => reportPlayEndMock(...args),
        reportPlayStart: (...args: unknown[]) => reportPlayStartMock(...args),
        reportSessionStart: (...args: unknown[]) => reportPlayStartMock(...args),
    },
}));

function makeDeps(overrides?: Partial<LifecycleDeps>): LifecycleDeps {
    const tx = { savepoint: (cb: (sql: unknown) => Promise<unknown>) => cb(tx) };
    return {
        watchManager: {
            reportProgress: vi.fn(),
            markWatched: vi.fn(),
        },
        watchHistoryService: {
            recordCompletedSession: vi.fn(),
        },
        queries: {
            updateHeartbeat: vi.fn().mockResolvedValue(true),
            stopSession: vi.fn().mockResolvedValue({
                id: 'session-1',
                started_at: new Date('2026-01-01'),
                media_id: 'media-1',
                user_id: TEST_USER_ID,
                runtime_ms: 120000,
            }),
            getSessionById: vi.fn().mockResolvedValue({
                id: 'session-1',
                started_at: new Date('2026-01-01'),
                media_id: 'media-1',
                user_id: TEST_USER_ID,
                runtime_ms: 120000,
                play_method: 'direct',
            }),
            // Default: row vanished. Each backstop test overrides this to
            // exercise specific (status, stop_reason) combinations.
            getSessionStatusAndReason: vi.fn().mockResolvedValue(null),
            getSessionDurableProgressMs: vi.fn().mockResolvedValue(null),
            sessionHasCompletion: vi.fn().mockResolvedValue(false),
        },
        getMediaMetadata: vi.fn().mockResolvedValue({
            title: 'Test Movie',
            media_type: 'movie',
            season_number: null,
            episode_number: null,
            series_name: null,
            runtime_seconds: 120,
            year: 2026,
        }),
        getSql: vi.fn().mockReturnValue({
            begin: vi.fn().mockImplementation((cb: (sql: unknown) => Promise<unknown>) => cb(tx)),
        }),
        ...overrides,
    };
}

describe('PlaySessionLifecycleService', () => {
    let deps: LifecycleDeps;
    let service: PlaySessionLifecycleService;

    beforeEach(() => {
        vi.clearAllMocks();
        deps = makeDeps();
        service = new PlaySessionLifecycleService(deps);
    });

    it.each(['ACTIVE', 'PAUSED', 'COMPLETED'] as const)(
        'radio %s maintains only the lease',
        async (status) => {
            vi.mocked(deps.queries.getSessionById).mockResolvedValue({
                id: 'session-1',
                media_id: 'radio-1',
                user_id: TEST_USER_ID,
                media_type: 'radio',
                runtime_ms: 120000,
                position_ms: 0,
                started_at: new Date('2026-01-01'),
                status: 'ACTIVE',
                play_method: 'direct',
            } as never);
            const result = await service.update('session-1', {
                status,
                position_ms: 120000,
                event_seq: 1,
                session_elapsed_ms: 120000,
                end_reason: status === 'COMPLETED' ? 'completion' : undefined,
            });
            if (status === 'COMPLETED') {
                expect(deps.queries.stopSession).toHaveBeenCalledWith(
                    expect.anything(),
                    'session-1',
                    0,
                    'completion',
                );
                expect(revokeGrantsForPlaySession).toHaveBeenCalledWith(
                    'session-1',
                    expect.anything(),
                    'stopped',
                );
            } else {
                expect(deps.queries.updateHeartbeat).toHaveBeenCalledWith(
                    expect.anything(),
                    'session-1',
                    expect.objectContaining({ status, position_ms: 0 }),
                );
                expect(result).toEqual({ resume_anchor: null, wrote_to_durable: false });
            }
            expect(deps.watchManager.reportProgress).not.toHaveBeenCalled();
            expect(deps.watchManager.markWatched).not.toHaveBeenCalled();
            expect(deps.watchHistoryService.recordCompletedSession).not.toHaveBeenCalled();
            expect(reportPlayStartMock).not.toHaveBeenCalled();
            expect(reportPlayEndMock).not.toHaveBeenCalled();
            expect(applyMusicLiveInfoMock).not.toHaveBeenCalled();
        },
    );

    it('updates play_sessions and watch state on ACTIVE heartbeat when engaged', async () => {
        await service.update('session-1', {
            position_ms: 60000,
            status: 'ACTIVE',
            event_seq: 1,
            session_elapsed_ms: MIN_ENGAGEMENT_MS,
        });

        expect(deps.queries.updateHeartbeat).toHaveBeenCalledWith(
            expect.anything(),
            'session-1',
            expect.objectContaining({
                position_ms: 60000,
                status: 'ACTIVE',
            }),
        );
        expect(deps.watchManager.reportProgress).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: TEST_USER_ID,
                mediaId: 'media-1',
                positionMs: 60000,
                runtimeMs: 120000,
                sessionId: 'session-1',
                eventSeq: 1,
            }),
        );
    });

    it('signals committed partial playback on stop so other Home tabs and details refresh', async () => {
        await service.update('session-1', {
            position_ms: 60000,
            status: 'COMPLETED',
            event_seq: 5,
            session_elapsed_ms: MIN_ENGAGEMENT_MS,
        });
        expect(deps.watchManager.reportProgress).toHaveBeenCalled();
        expect(watchStateEvents.emit).toHaveBeenCalledWith(TEST_USER_ID, {
            type: 'watch_state_set_changed',
            mediaId: 'media-1',
            reason: 'playback_stop',
        });
    });

    it('creates watch_history on COMPLETED', async () => {
        await service.update('session-1', {
            position_ms: 108000,
            status: 'COMPLETED',
            event_seq: 5,
            session_elapsed_ms: 0, // unrelated to engagement gate; stopSession/recordCompletedSession run unconditionally
        });

        expect(revokeGrantsForPlaySession).toHaveBeenCalledWith(
            'session-1',
            expect.anything(),
            'stopped',
        );
        expect(deps.queries.stopSession).toHaveBeenCalledWith(
            expect.anything(),
            'session-1',
            108000,
            'user',
        );
        expect(deps.watchHistoryService.recordCompletedSession).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: TEST_USER_ID,
                mediaId: 'media-1',
                playSessionId: 'session-1',
            }),
            expect.anything(),
        );
    });

    it('marks watched when COMPLETED and position >= 90% of runtime', async () => {
        await service.update('session-1', {
            position_ms: 108000, // 90% of 120000
            status: 'COMPLETED',
            event_seq: 5,
            session_elapsed_ms: 0, // crossedCompletion (position >= completion threshold) drives markWatched regardless of engagement
        });

        expect(deps.watchManager.markWatched).toHaveBeenCalledWith(
            {
                userId: TEST_USER_ID,
                mediaId: 'media-1',
            },
            expect.anything(),
        );
    });

    it('does not mark watched again when the session already completed the item itself', async () => {
        // reportProgress wrote this session's `completed`; a user-mark on top
        // counted the same viewing twice (and again on every later stop).
        (deps.queries.sessionHasCompletion as ReturnType<typeof vi.fn>).mockResolvedValue(true);

        await service.update('session-1', {
            position_ms: 108000,
            status: 'COMPLETED',
            event_seq: 5,
            session_elapsed_ms: 0,
        });

        expect(deps.queries.sessionHasCompletion).toHaveBeenCalledWith(
            expect.anything(),
            TEST_USER_ID,
            'media-1',
            'session-1',
        );
        expect(deps.watchManager.markWatched).not.toHaveBeenCalled();
    });

    it('does NOT mark watched when COMPLETED but position < 90% of runtime', async () => {
        await service.update('session-1', {
            position_ms: 50000,
            status: 'COMPLETED',
            event_seq: 3,
            session_elapsed_ms: 0, // position below completion threshold; engagement is irrelevant to this assertion
        });

        expect(deps.watchManager.markWatched).not.toHaveBeenCalled();
    });

    it('returns { action: "kill" } when heartbeat update returns false and row is gone', async () => {
        (deps.queries.updateHeartbeat as ReturnType<typeof vi.fn>).mockResolvedValue(false);
        // Row vanished — the disambiguation SELECT finds nothing.
        (deps.queries.getSessionStatusAndReason as ReturnType<typeof vi.fn>).mockResolvedValue(
            null,
        );

        const result = await service.update('session-1', {
            position_ms: 60000,
            status: 'ACTIVE',
            event_seq: 2,
            session_elapsed_ms: 0,
        });

        // Heartbeat acks always carry resume_anchor + wrote_to_durable; on a
        // killed session we have no eligible anchor source, so it's null.
        expect(result).toEqual({
            action: 'kill',
            reason: 'session_ended',
            resume_anchor: null,
            wrote_to_durable: false,
        });
    });

    // Backstop disambiguation table — when `updateHeartbeat` returns null,
    // the lifecycle service re-reads (status, stop_reason) and routes per
    // spec §4.3. Critical: a stale-seq row (still ACTIVE) MUST resolve to
    // silent success, not supersede.
    // The progress-write path (distinct from the backstop above): a heartbeat
    // that reaches reportProgress but does not land. Only a genuinely newer
    // session may surface as 'superseded' — clients treat that as terminal and
    // auto-pause until a full reload, so a duplicate or out-of-order heartbeat
    // reaching that branch stops playback on a session that is still live.
    describe('progress-write outcome → client action', () => {
        const heartbeat = {
            position_ms: 60000,
            status: 'ACTIVE' as const,
            event_seq: 2,
            session_elapsed_ms: MIN_ENGAGEMENT_MS,
        };

        it("reports 'superseded' when a newer session took over", async () => {
            (deps.watchManager.reportProgress as ReturnType<typeof vi.fn>).mockResolvedValue(
                'superseded',
            );

            const result = await service.update('session-1', heartbeat);

            expect(result).toMatchObject({
                action: 'superseded',
                reason: 'session_superseded',
                wrote_to_durable: false,
            });
        });

        it('does NOT report superseded for a stale_seq (duplicate/out-of-order) heartbeat', async () => {
            (deps.watchManager.reportProgress as ReturnType<typeof vi.fn>).mockResolvedValue(
                'stale_seq',
            );

            const result = await service.update('session-1', heartbeat);

            expect(result).not.toHaveProperty('action');
            expect(result).toMatchObject({ wrote_to_durable: false });
        });

        it('does NOT report superseded for an idempotent duplicate insert', async () => {
            (deps.watchManager.reportProgress as ReturnType<typeof vi.fn>).mockResolvedValue(
                'duplicate',
            );

            const result = await service.update('session-1', heartbeat);

            expect(result).not.toHaveProperty('action');
            expect(result).toMatchObject({ wrote_to_durable: false });
        });

        it("marks wrote_to_durable on 'accepted'", async () => {
            (deps.watchManager.reportProgress as ReturnType<typeof vi.fn>).mockResolvedValue(
                'accepted',
            );

            const result = await service.update('session-1', heartbeat);

            expect(result).not.toHaveProperty('action');
            expect(result).toMatchObject({ wrote_to_durable: true });
        });
    });

    describe('heartbeat backstop disambiguation', () => {
        beforeEach(() => {
            (deps.queries.updateHeartbeat as ReturnType<typeof vi.fn>).mockResolvedValue(false);
        });

        it("KILLED + stop_reason='superseded' → action: 'superseded'", async () => {
            (deps.queries.getSessionStatusAndReason as ReturnType<typeof vi.fn>).mockResolvedValue({
                status: 'KILLED',
                stop_reason: 'superseded',
            });

            const result = await service.update('session-1', {
                position_ms: 60000,
                status: 'ACTIVE',
                event_seq: 2,
                session_elapsed_ms: 0,
            });

            expect(result).toEqual({
                action: 'superseded',
                reason: 'superseded',
                resume_anchor: null,
                wrote_to_durable: false,
            });
        });

        it("KILLED + stop_reason='admin:alice' → action: 'kill' with that reason", async () => {
            (deps.queries.getSessionStatusAndReason as ReturnType<typeof vi.fn>).mockResolvedValue({
                status: 'KILLED',
                stop_reason: 'admin:alice',
            });

            const result = await service.update('session-1', {
                position_ms: 60000,
                status: 'ACTIVE',
                event_seq: 2,
                session_elapsed_ms: 0,
            });

            expect(result).toMatchObject({
                action: 'kill',
                reason: 'admin:alice',
                resume_anchor: null,
                wrote_to_durable: false,
            });
        });

        it("KILLED + stop_reason='kicked' → action: 'kill' with reason 'kicked'", async () => {
            (deps.queries.getSessionStatusAndReason as ReturnType<typeof vi.fn>).mockResolvedValue({
                status: 'KILLED',
                stop_reason: 'kicked',
            });

            const result = await service.update('session-1', {
                position_ms: 60000,
                status: 'ACTIVE',
                event_seq: 2,
                session_elapsed_ms: 0,
            });

            expect(result).toMatchObject({
                action: 'kill',
                reason: 'kicked',
            });
        });

        it("COMPLETED + stop_reason='user' → silent kill (session_ended)", async () => {
            (deps.queries.getSessionStatusAndReason as ReturnType<typeof vi.fn>).mockResolvedValue({
                status: 'COMPLETED',
                stop_reason: 'user',
            });

            const result = await service.update('session-1', {
                position_ms: 60000,
                status: 'ACTIVE',
                event_seq: 2,
                session_elapsed_ms: 0,
            });

            expect(result).toEqual({
                action: 'kill',
                reason: 'session_ended',
                resume_anchor: null,
                wrote_to_durable: false,
            });
        });

        it('status=ACTIVE (stale-seq race) → silent success, NOT supersede', async () => {
            // Critical regression guard: updateHeartbeat returns null when
            // the event_seq gate fails for an out-of-order or duplicate
            // heartbeat. The row is still ACTIVE; surfacing this as
            // supersede would falsely toast healthy sessions.
            (deps.queries.getSessionStatusAndReason as ReturnType<typeof vi.fn>).mockResolvedValue({
                status: 'ACTIVE',
                stop_reason: null,
            });

            const result = await service.update('session-1', {
                position_ms: 60000,
                status: 'ACTIVE',
                event_seq: 2,
                session_elapsed_ms: 0,
            });

            expect(result).toEqual({
                resume_anchor: null,
                wrote_to_durable: false,
            });
            expect(result).not.toHaveProperty('action');
        });

        it('status=PAUSED (stale-seq race) → silent success', async () => {
            (deps.queries.getSessionStatusAndReason as ReturnType<typeof vi.fn>).mockResolvedValue({
                status: 'PAUSED',
                stop_reason: null,
            });

            const result = await service.update('session-1', {
                position_ms: 60000,
                status: 'ACTIVE',
                event_seq: 2,
                session_elapsed_ms: 0,
            });

            expect(result).not.toHaveProperty('action');
        });

        it('status=CRASHED (stale-seq race on revivable row) → silent success', async () => {
            (deps.queries.getSessionStatusAndReason as ReturnType<typeof vi.fn>).mockResolvedValue({
                status: 'CRASHED',
                stop_reason: null,
            });

            const result = await service.update('session-1', {
                position_ms: 60000,
                status: 'ACTIVE',
                event_seq: 2,
                session_elapsed_ms: 0,
            });

            expect(result).not.toHaveProperty('action');
        });

        it('SELECT throws → silent no-op (must NOT bubble as 500 on heartbeat)', async () => {
            // Transient DB error or unexpected exception during the
            // disambiguation SELECT must degrade to silent success — surfacing
            // a 500 on heartbeat would just leave the client retrying without
            // any actionable signal, and could mask a healthy session as kill.
            (deps.queries.getSessionStatusAndReason as ReturnType<typeof vi.fn>).mockRejectedValue(
                new Error('connection lost'),
            );

            const result = await service.update('session-1', {
                position_ms: 60000,
                status: 'ACTIVE',
                event_seq: 2,
                session_elapsed_ms: 0,
            });

            expect(result).toEqual({
                resume_anchor: null,
                wrote_to_durable: false,
            });
            expect(result).not.toHaveProperty('action');
        });
    });

    it('swallows downstream errors without failing the update', async () => {
        (deps.watchManager.reportProgress as ReturnType<typeof vi.fn>).mockRejectedValue(
            new Error('DB down'),
        );

        const result = await service.update('session-1', {
            position_ms: 60000,
            status: 'ACTIVE',
            event_seq: 1,
            session_elapsed_ms: MIN_ENGAGEMENT_MS, // must be engaged so the mocked reportProgress rejection is actually exercised
        });

        // Should not throw; session update itself succeeds. The success branch
        // now returns the heartbeat-ack shape (was previously undefined).
        expect(result).toMatchObject({ wrote_to_durable: false });
        expect(result).toHaveProperty('resume_anchor');
    });

    it('returns kill action when session not found', async () => {
        (deps.queries.getSessionById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

        const result = await service.update('nonexistent', {
            position_ms: 0,
            status: 'ACTIVE',
            event_seq: 0,
            session_elapsed_ms: 0,
        });

        expect(result).toEqual({
            action: 'kill',
            reason: 'session_not_found',
            resume_anchor: null,
            wrote_to_durable: false,
        });
    });

    it('returns undefined when getSql returns null', async () => {
        deps = makeDeps({
            getSql: vi.fn().mockReturnValue(null),
        });
        service = new PlaySessionLifecycleService(deps);

        const result = await service.update('session-1', {
            position_ms: 60000,
            status: 'ACTIVE',
            event_seq: 1,
            session_elapsed_ms: 0,
        });

        expect(result).toBeUndefined();
        expect(deps.queries.getSessionById).not.toHaveBeenCalled();
    });

    it('still completes stop when markWatched throws', async () => {
        (deps.watchManager.markWatched as ReturnType<typeof vi.fn>).mockRejectedValue(
            new Error('watch state DB error'),
        );

        const result = await service.update('session-1', {
            position_ms: 108000,
            status: 'COMPLETED',
            event_seq: 5,
            session_elapsed_ms: 0,
        });

        // Stop should succeed despite markWatched failure
        expect(result).toBeUndefined();
        expect(deps.queries.stopSession).toHaveBeenCalled();
    });

    it('still completes stop when recordCompletedSession throws', async () => {
        (
            deps.watchHistoryService.recordCompletedSession as ReturnType<typeof vi.fn>
        ).mockRejectedValue(new Error('history insert failed'));

        const result = await service.update('session-1', {
            position_ms: 108000,
            status: 'COMPLETED',
            event_seq: 5,
            session_elapsed_ms: 0,
        });

        expect(result).toBeUndefined();
        expect(deps.queries.stopSession).toHaveBeenCalled();
    });

    it('skips watch_history when getMediaMetadata returns null', async () => {
        deps = makeDeps({
            getMediaMetadata: vi.fn().mockResolvedValue(null),
        });
        service = new PlaySessionLifecycleService(deps);

        await service.update('session-1', {
            position_ms: 108000,
            status: 'COMPLETED',
            event_seq: 5,
            session_elapsed_ms: 0,
        });

        expect(deps.watchHistoryService.recordCompletedSession).not.toHaveBeenCalled();
    });

    it('skips steps 2-3 when stopSession returns null (already stopped)', async () => {
        (deps.queries.stopSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);

        await service.update('session-1', {
            position_ms: 108000,
            status: 'COMPLETED',
            event_seq: 5,
            session_elapsed_ms: 0,
        });

        expect(deps.queries.stopSession).toHaveBeenCalled();
        // Steps 2-3 should be skipped
        expect(deps.watchManager.reportProgress).not.toHaveBeenCalled();
        expect(deps.watchManager.markWatched).not.toHaveBeenCalled();
        expect(deps.watchHistoryService.recordCompletedSession).not.toHaveBeenCalled();
    });

    // --- Idle keepalive gate: retry after a durable write that did not land ---

    describe('idle gate after a failed durable write', () => {
        const PAUSED_AT_MS = 60_000;

        /** The row as the NEXT heartbeat reads it: the previous one stored PAUSED_AT_MS. */
        function rowAfterHeartbeat() {
            return {
                id: 'session-1',
                started_at: new Date('2026-01-01'),
                media_id: 'media-1',
                user_id: TEST_USER_ID,
                runtime_ms: 120000,
                play_method: 'direct',
                position_ms: PAUSED_AT_MS,
                last_event_seq: 1,
            };
        }

        const heartbeat = (seq: number) => ({
            position_ms: PAUSED_AT_MS,
            status: 'PAUSED' as const,
            event_seq: seq,
            session_elapsed_ms: MIN_ENGAGEMENT_MS,
        });

        it('an unmoved keepalive retries when durable state never got the position', async () => {
            (deps.queries.getSessionById as ReturnType<typeof vi.fn>).mockResolvedValue(
                rowAfterHeartbeat(),
            );
            // Heartbeat 1's write threw: no durable event for this session.
            (
                deps.queries.getSessionDurableProgressMs as ReturnType<typeof vi.fn>
            ).mockResolvedValue(null);
            (deps.watchManager.reportProgress as ReturnType<typeof vi.fn>).mockResolvedValue(
                'accepted',
            );

            const result = await service.update('session-1', heartbeat(2));

            expect(deps.watchManager.reportProgress).toHaveBeenCalledWith(
                expect.objectContaining({ positionMs: PAUSED_AT_MS, eventSeq: 2 }),
            );
            expect(result).toMatchObject({ wrote_to_durable: true });
        });

        it('a write that throws once is retried by the next unmoved keepalive', async () => {
            const reportProgress = deps.watchManager.reportProgress as ReturnType<typeof vi.fn>;
            reportProgress.mockRejectedValueOnce(new Error('db blip'));
            reportProgress.mockResolvedValue('accepted');
            // Heartbeat 1 moved the playhead to PAUSED_AT_MS; its write throws.
            await service.update('session-1', heartbeat(1));
            expect(reportProgress).toHaveBeenCalledTimes(1);

            // Heartbeat 2 at the same spot: the row says unmoved, durable says
            // nothing of this session — it must write.
            (deps.queries.getSessionById as ReturnType<typeof vi.fn>).mockResolvedValue(
                rowAfterHeartbeat(),
            );
            await service.update('session-1', heartbeat(2));

            expect(reportProgress).toHaveBeenCalledTimes(2);
            expect(reportProgress).toHaveBeenLastCalledWith(
                expect.objectContaining({ positionMs: PAUSED_AT_MS, eventSeq: 2 }),
            );
        });

        it('an unmoved keepalive whose position durable state holds is skipped', async () => {
            (deps.queries.getSessionById as ReturnType<typeof vi.fn>).mockResolvedValue(
                rowAfterHeartbeat(),
            );
            (
                deps.queries.getSessionDurableProgressMs as ReturnType<typeof vi.fn>
            ).mockResolvedValue(PAUSED_AT_MS);

            const result = await service.update('session-1', heartbeat(2));

            expect(deps.watchManager.reportProgress).not.toHaveBeenCalled();
            expect(result).toMatchObject({ wrote_to_durable: false });
            expect(deps.queries.getSessionDurableProgressMs).toHaveBeenCalledWith(
                expect.anything(),
                TEST_USER_ID,
                'media-1',
                'session-1',
            );
        });

        it('a stop at the unmoved position still writes when durable state lacks it', async () => {
            (deps.queries.getSessionById as ReturnType<typeof vi.fn>).mockResolvedValue(
                rowAfterHeartbeat(),
            );

            await service.update('session-1', {
                position_ms: PAUSED_AT_MS,
                status: 'COMPLETED',
                event_seq: 3,
                session_elapsed_ms: MIN_ENGAGEMENT_MS,
            });

            expect(deps.watchManager.reportProgress).toHaveBeenCalledWith(
                expect.objectContaining({ positionMs: PAUSED_AT_MS }),
                expect.anything(),
            );
        });

        it('an unmoved stop whose position durable state holds is skipped', async () => {
            (deps.queries.getSessionById as ReturnType<typeof vi.fn>).mockResolvedValue(
                rowAfterHeartbeat(),
            );
            (
                deps.queries.getSessionDurableProgressMs as ReturnType<typeof vi.fn>
            ).mockResolvedValue(PAUSED_AT_MS + 500);

            await service.update('session-1', {
                position_ms: PAUSED_AT_MS,
                status: 'COMPLETED',
                event_seq: 3,
                session_elapsed_ms: MIN_ENGAGEMENT_MS,
            });

            expect(deps.watchManager.reportProgress).not.toHaveBeenCalled();
        });
    });

    // --- Engagement gate tests ---

    it('does NOT call reportProgress below the runtime-scaled engagement threshold', async () => {
        await service.update('session-1', {
            position_ms: 30000,
            status: 'ACTIVE',
            event_seq: 1,
            session_elapsed_ms: 30_000 - 1, // 25% of the fixture's 120 s runtime
        });

        expect(deps.queries.updateHeartbeat).toHaveBeenCalled();
        expect(deps.watchManager.reportProgress).not.toHaveBeenCalled();
    });

    it('calls reportProgress when session_elapsed_ms >= MIN_ENGAGEMENT_MS', async () => {
        await service.update('session-1', {
            position_ms: 90000,
            status: 'ACTIVE',
            event_seq: 2,
            session_elapsed_ms: MIN_ENGAGEMENT_MS,
        });

        expect(deps.queries.updateHeartbeat).toHaveBeenCalled();
        expect(deps.watchManager.reportProgress).toHaveBeenCalledWith(
            expect.objectContaining({
                positionMs: 90000,
                sessionElapsedMs: MIN_ENGAGEMENT_MS,
            }),
        );
    });

    it('gates as un-engaged when session_elapsed_ms is undefined', async () => {
        await service.update('session-1', {
            position_ms: 45000,
            status: 'ACTIVE',
            event_seq: 1,
            // Field is now required by the schema, so "absent" can no longer be
            // expressed literally; 0 reproduces the same effectiveElapsedMs ?? 0
            // outcome the old omitted-field case exercised.
            session_elapsed_ms: 0,
        });

        expect(deps.queries.updateHeartbeat).toHaveBeenCalled();
        expect(deps.watchManager.reportProgress).not.toHaveBeenCalled();
    });

    it('persists durable state on engaged unload beacon (watch 20min, close tab)', async () => {
        // The most common real path: user watched a chunk, closed the tab.
        // handleBeforeUnload on the client now forwards
        // session_elapsed_ms via the beacon body. The gate must let this
        // through so partial progress survives.
        await service.update('session-1', {
            position_ms: 30_000,
            status: 'COMPLETED',
            event_seq: 5,
            session_elapsed_ms: 20 * 60_000,
            end_reason: 'unload',
        });

        expect(deps.watchManager.reportProgress).toHaveBeenCalledWith(
            expect.objectContaining({
                positionMs: 30_000,
                userId: TEST_USER_ID,
                sessionElapsedMs: 20 * 60_000,
            }),
            expect.anything(),
        );
    });

    it('skips reportProgress on low-engagement stop (scrub-and-leave)', async () => {
        // User opens item, drags scrubber to mid-content, closes tab without
        // playing. beforeUnload sends COMPLETED/unload with the scrubbed
        // position but near-zero engagement. The session row gets marked
        // COMPLETED, but durable user_media_state must NOT be written — that
        // would surface the item in CW at the scrubbed position.
        // Fixture runtime 120000ms; threshold 90% (no media_type set) =
        // 108000ms. Scrub to 30000ms (well below threshold).
        await service.update('session-1', {
            position_ms: 30_000,
            status: 'COMPLETED',
            event_seq: 5,
            session_elapsed_ms: 1_000, // well below MIN_ENGAGEMENT_MS
            end_reason: 'unload',
        });

        expect(deps.queries.stopSession).toHaveBeenCalled();
        expect(deps.watchManager.reportProgress).not.toHaveBeenCalled();
        expect(deps.watchManager.markWatched).not.toHaveBeenCalled();
    });

    it('calls reportProgress on engaged stop', async () => {
        // Real watching session that ended — durable state must persist.
        await service.update('session-1', {
            position_ms: 30_000,
            status: 'COMPLETED',
            event_seq: 5,
            session_elapsed_ms: MIN_ENGAGEMENT_MS,
            end_reason: 'user',
        });

        expect(deps.watchManager.reportProgress).toHaveBeenCalledWith(
            expect.objectContaining({ positionMs: 30_000, userId: TEST_USER_ID }),
            expect.anything(),
        );
    });

    it('calls reportProgress on completion-end regardless of engagement', async () => {
        // Player itself decided the video ended at end-of-content — even with
        // low recorded engagement (e.g. tab was background), we want to mark
        // the item watched. Fixture runtime_ms = 120000.
        await service.update('session-1', {
            position_ms: 100_000, // not past 95% threshold, but end_reason carries the signal
            status: 'COMPLETED',
            event_seq: 5,
            session_elapsed_ms: 0,
            end_reason: 'completion',
        });

        expect(deps.watchManager.reportProgress).toHaveBeenCalled();
    });

    it('calls reportProgress when position past completion threshold even with low engagement', async () => {
        // Auto-complete: user scrubbed past the threshold and the session
        // ended. Position itself signals completion (fixture runtime 120000ms;
        // movie threshold 95% → 114_000ms).
        await service.update('session-1', {
            position_ms: 119_000,
            status: 'COMPLETED',
            event_seq: 5,
            session_elapsed_ms: 0,
        });

        expect(deps.watchManager.reportProgress).toHaveBeenCalled();
        expect(deps.watchManager.markWatched).toHaveBeenCalled();
    });
    // ── Music ────────────────────────────────────────────────────────────
    //
    // Native music counts its first positive heard report; /j has a
    // protocol-specific Playing event. Both share a durable session claim.
    describe('music', () => {
        function musicSession(overrides?: Record<string, unknown>) {
            const tx = vi
                .fn()
                .mockResolvedValue([
                    { status: 'ACTIVE', last_event_seq: 0, surface: overrides?.surface ?? 'web' },
                ]);
            deps.getSql = vi
                .fn()
                .mockReturnValue({ begin: (cb: (sql: unknown) => unknown) => cb(tx) });
            return {
                id: 'session-1',
                started_at: new Date('2026-01-01'),
                media_id: 'track-1',
                user_id: TEST_USER_ID,
                runtime_ms: 200000,
                media_type: 'track',
                client_name: 'Streamyfin',
                play_method: 'direct',
                ...overrides,
            };
        }

        it.each(['track', 'audio'])('counts the play at session start for %s', async (type) => {
            const { aiDbService } = await import('./database.service.js');
            vi.spyOn(aiDbService, 'getSql').mockResolvedValue(
                vi.fn().mockResolvedValue([{ id: 'session-1' }]) as never,
            );
            await reportMusicSessionStart({
                userId: toUserId(TEST_USER_ID),
                mediaId: 'track-1',
                mediaType: type,
                playbackSessionId: 'session-1',
            });

            expect(reportPlayStartMock).toHaveBeenCalledWith(
                expect.anything(),
                TEST_USER_ID,
                'track-1',
                'session-1',
            );
        });

        it.each(['movie', 'episode', 'audiobook', null, undefined])(
            'is a no-op at session start for %s',
            async (type) => {
                await reportMusicSessionStart({
                    userId: toUserId(TEST_USER_ID),
                    mediaId: 'media-1',
                    mediaType: type,
                    playbackSessionId: 'session-1',
                });

                expect(reportPlayStartMock).not.toHaveBeenCalled();
            },
        );

        it.each([0, 1])('only positive heard time counts on a live report: %s', async (heard) => {
            deps.queries.getSessionById = vi.fn().mockResolvedValue(musicSession());
            await service.update('session-1', {
                position_ms: 190000,
                status: 'ACTIVE',
                event_seq: 2,
                listened_ms: heard,
                session_elapsed_ms: 50000,
            });
            expect(reportPlayStartMock).toHaveBeenCalledTimes(heard > 0 ? 1 : 0);
        });

        it('keeps Jellyfin protocol completion timing when no heard accumulator exists', async () => {
            deps.queries.getSessionById = vi
                .fn()
                .mockResolvedValue(musicSession({ surface: 'jellyfin_compat' }));
            await service.update('session-1', {
                position_ms: 190000,
                status: 'COMPLETED',
                event_seq: 2,
                end_reason: 'completion',
            });
            expect(reportPlayEndMock.mock.calls[0][2]).toBe(190000);
        });

        it('a jellyfin_compat scrub-then-pause never counts position as heard', async () => {
            deps.queries.getSessionById = vi
                .fn()
                .mockResolvedValue(musicSession({ surface: 'jellyfin_compat' }));
            await service.update('session-1', {
                position_ms: 180000,
                status: 'PAUSED',
                event_seq: 2,
            });
            await service.update('session-1', {
                position_ms: 180000,
                status: 'ACTIVE',
                event_seq: 3,
            });
            expect(reportPlayStartMock).not.toHaveBeenCalled();
        });

        it('jellyfin_compat completion without end_reason=completion counts zero', async () => {
            deps.queries.getSessionById = vi
                .fn()
                .mockResolvedValue(musicSession({ surface: 'jellyfin_compat' }));
            await service.update('session-1', {
                position_ms: 190000,
                status: 'COMPLETED',
                event_seq: 2,
                end_reason: 'user',
            });
            expect(reportPlayEndMock.mock.calls[0][2]).toBe(0);
        });

        it('only rewrites the stored heard total when it grows', async () => {
            deps.queries.getSessionById = vi.fn().mockResolvedValue(musicSession());
            const writes: string[] = [];
            const tx = vi.fn(async (strings: TemplateStringsArray) => {
                const text = strings.join('?');
                if (text.includes('jsonb_set')) writes.push(text);
                return text.includes('FOR UPDATE')
                    ? [
                          {
                              status: 'ACTIVE',
                              last_event_seq: 0,
                              surface: 'web',
                              listened_total_ms: 5000,
                          },
                      ]
                    : [];
            });
            deps.getSql = vi
                .fn()
                .mockReturnValue({ begin: (cb: (sql: unknown) => unknown) => cb(tx) });
            await service.update('session-1', {
                position_ms: 10000,
                status: 'ACTIVE',
                event_seq: 1,
                listened_ms: 3000,
                session_elapsed_ms: 3000,
            });
            expect(writes).toHaveLength(0);
            await service.update('session-1', {
                position_ms: 10000,
                status: 'ACTIVE',
                event_seq: 2,
                listened_ms: 6000,
                session_elapsed_ms: 6000,
            });
            expect(writes).toHaveLength(1);
        });

        it('does NOT bump play_count again on stop', async () => {
            deps.queries.getSessionById = vi.fn().mockResolvedValue(musicSession());

            await service.update('session-1', {
                position_ms: 194000,
                status: 'COMPLETED',
                event_seq: 5,
                session_elapsed_ms: 0,
            });

            expect(reportPlayEndMock).toHaveBeenCalledTimes(1);
            const [userId, trackId, listenedMs, , durationMs, wasSkipped] =
                reportPlayEndMock.mock.calls[0];
            expect(userId).toBe(TEST_USER_ID);
            expect(trackId).toBe('track-1');
            expect(listenedMs).toBe(0);
            expect(durationMs).toBe(200000);
            expect(wasSkipped).toBe(false);
            // noPlayStartReported (9th positional): left at its default so
            // recordPlayEnd's UPDATE branch does not touch play_count.
            expect(reportPlayEndMock.mock.calls[0][8]).toBeFalsy();
        });

        it('completion after seeking with no heard audio counts zero', async () => {
            deps.queries.getSessionById = vi.fn().mockResolvedValue(musicSession());
            await service.update('session-1', {
                position_ms: 190000,
                status: 'COMPLETED',
                event_seq: 5,
                end_reason: 'completion',
                session_elapsed_ms: 0,
            });
            expect(reportPlayEndMock.mock.calls[0][2]).toBe(0);
            expect(reportPlayStartMock).not.toHaveBeenCalled();
        });

        it('uses heard audio, marks skips, and keys the listen by the playback session id', async () => {
            deps.queries.getSessionById = vi.fn().mockResolvedValue(musicSession());
            await service.update('session-1', {
                position_ms: 190000,
                listened_ms: 1200,
                session_elapsed_ms: 1800,
                status: 'COMPLETED',
                event_seq: 5,
                end_reason: 'skip',
            });
            expect(reportPlayEndMock).toHaveBeenCalledWith(
                TEST_USER_ID,
                'track-1',
                1200,
                expect.any(Date),
                200000,
                true,
                undefined,
                'session-1',
                false,
                expect.anything(),
            );
        });

        it('passes music live extras through the accepted report, for either transport', async () => {
            deps.queries.getSessionById = vi.fn().mockResolvedValue(musicSession());
            const crossfade = {
                otherTrackId: 'other-track',
                role: 'incoming' as const,
                remainingMs: 100,
                durationMs: 500,
            };
            await service.update(
                'session-1',
                {
                    position_ms: 1200,
                    session_elapsed_ms: 1200,
                    status: 'PAUSED',
                    event_seq: 5,
                    next_media_id: 'next-track',
                    crossfade,
                },
                { userId: TEST_USER_ID } as never,
            );
            expect(applyMusicLiveInfoMock).toHaveBeenCalledWith(
                expect.anything(),
                'session-1',
                expect.objectContaining({ userId: TEST_USER_ID }),
                { status: 'PAUSED', nextTrackId: 'next-track', crossfade },
            );
        });

        it('stale reports never reach music counters or live extras', async () => {
            deps.queries.getSessionById = vi.fn().mockResolvedValue(musicSession());
            const tx = vi.fn().mockResolvedValue([{ status: 'ACTIVE', last_event_seq: 5 }]);
            deps.getSql = vi
                .fn()
                .mockReturnValue({ begin: (cb: (sql: unknown) => unknown) => cb(tx) });
            await service.update('session-1', {
                position_ms: 1200,
                session_elapsed_ms: 1200,
                status: 'COMPLETED',
                event_seq: 5,
            });
            expect(reportPlayEndMock).not.toHaveBeenCalled();
            expect(reportPlayStartMock).not.toHaveBeenCalled();
            expect(deps.queries.stopSession).not.toHaveBeenCalled();
        });

        it('a failed music write leaves the session stop retryable', async () => {
            deps.queries.getSessionById = vi.fn().mockResolvedValue(musicSession());
            reportPlayEndMock.mockRejectedValueOnce(new Error('write failed'));
            await expect(
                service.update('session-1', {
                    position_ms: 1200,
                    session_elapsed_ms: 1200,
                    status: 'COMPLETED',
                    event_seq: 5,
                }),
            ).rejects.toThrow('write failed');
            expect(deps.queries.stopSession).not.toHaveBeenCalled();
        });

        it.each([
            ['COMPLETED', 'track_change'],
            ['COMPLETED', 'superseded'],
            ['CRASHED', 'heartbeat_timeout'],
        ])(
            'records a late completion after %s/%s even with a stale sequence',
            async (status, stop_reason) => {
                deps.queries.getSessionById = vi.fn().mockResolvedValue(musicSession());
                const tx = vi.fn().mockResolvedValue([{ status, stop_reason, last_event_seq: 10 }]);
                deps.getSql = vi
                    .fn()
                    .mockReturnValue({ begin: (cb: (sql: unknown) => unknown) => cb(tx) });
                expect(
                    await service.update('session-1', {
                        status: 'COMPLETED',
                        position_ms: 190000,
                        event_seq: 5,
                        end_reason: 'completion',
                    }),
                ).toBeUndefined();
                expect(reportPlayEndMock).toHaveBeenCalledWith(
                    TEST_USER_ID,
                    'track-1',
                    0,
                    expect.any(Date),
                    200000,
                    false,
                    undefined,
                    'session-1',
                    false,
                    tx,
                );
            },
        );
        it('a cancelled music session records nothing', async () => {
            deps.queries.getSessionById = vi.fn().mockResolvedValue(musicSession());
            const tx = vi
                .fn()
                .mockResolvedValue([
                    { status: 'KILLED', stop_reason: 'admin_kill', last_event_seq: 0 },
                ]);
            deps.getSql = vi
                .fn()
                .mockReturnValue({ begin: (cb: (sql: unknown) => unknown) => cb(tx) });
            expect(
                await service.update('session-1', {
                    status: 'COMPLETED',
                    position_ms: 1000,
                    event_seq: 1,
                }),
            ).toMatchObject({ action: 'kill' });
            expect(reportPlayEndMock).not.toHaveBeenCalled();
        });
        it.each(['skip', 'user', 'unload'] as const)(
            'missing heard/elapsed audio falls back to zero for %s',
            async (end_reason) => {
                deps.queries.getSessionById = vi.fn().mockResolvedValue(musicSession());
                await service.update('session-1', {
                    status: 'COMPLETED',
                    position_ms: 190000,
                    event_seq: 1,
                    end_reason,
                });
                expect(reportPlayEndMock.mock.calls[0][2]).toBe(0);
            },
        );
        it('updates live extras only after transaction commit', async () => {
            deps.queries.getSessionById = vi.fn().mockResolvedValue(musicSession());
            let committed = false;
            const tx = vi.fn().mockResolvedValue([{ status: 'ACTIVE', last_event_seq: 0 }]);
            deps.getSql = vi.fn().mockReturnValue({
                begin: async (cb: (sql: unknown) => Promise<unknown>) => {
                    const result = await cb(tx);
                    committed = true;
                    return result;
                },
            });
            applyMusicLiveInfoMock.mockImplementationOnce(async () => {
                expect(committed).toBe(true);
            });
            await service.update(
                'session-1',
                { status: 'PAUSED', position_ms: 1000, event_seq: 1 },
                { userId: toUserId(TEST_USER_ID) } as never,
            );
            expect(applyMusicLiveInfoMock).toHaveBeenCalledOnce();
        });

        it('never writes watch state for a music stop', async () => {
            deps.queries.getSessionById = vi.fn().mockResolvedValue(musicSession());

            await service.update('session-1', {
                position_ms: 194000,
                status: 'COMPLETED',
                event_seq: 5,
                session_elapsed_ms: 0,
                end_reason: 'completion',
            });

            expect(deps.watchManager.reportProgress).not.toHaveBeenCalled();
            expect(deps.watchManager.markWatched).not.toHaveBeenCalled();
            expect(deps.watchHistoryService.recordCompletedSession).not.toHaveBeenCalled();
        });

        it('takes the watch-state branch for a non-music session', async () => {
            deps.queries.getSessionById = vi
                .fn()
                .mockResolvedValue(musicSession({ media_type: 'movie' }));

            await service.update('session-1', {
                position_ms: 194000,
                status: 'COMPLETED',
                event_seq: 5,
                session_elapsed_ms: 0,
                end_reason: 'completion',
            });

            expect(reportPlayEndMock).not.toHaveBeenCalled();
            expect(deps.watchManager.reportProgress).toHaveBeenCalled();
        });
    });

    describe('plugin playback events', () => {
        it('publishes playback.started when a session is announced', () => {
            service.notifySessionStarted(toUserId(TEST_USER_ID), 'session-1', 'media-1');

            expect(publishIntegrationEvent).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'org.lumastra.playback.started',
                    payload: expect.objectContaining({
                        sessionId: 'session-1',
                        mediaId: 'media-1',
                    }),
                }),
            );
        });

        it('publishes playback.paused on a PAUSED heartbeat, not on an ACTIVE one', async () => {
            await service.update('session-1', {
                position_ms: 1000,
                status: 'ACTIVE',
                event_seq: 1,
                session_elapsed_ms: MIN_ENGAGEMENT_MS,
            });
            const activeTypes = publishIntegrationEvent.mock.calls.map((c) => c[0].type);
            expect(activeTypes).not.toContain('org.lumastra.playback.paused');

            await service.update('session-1', {
                position_ms: 2000,
                status: 'PAUSED',
                event_seq: 2,
                session_elapsed_ms: MIN_ENGAGEMENT_MS,
            });

            expect(publishIntegrationEvent).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'org.lumastra.playback.paused' }),
            );
        });

        it('publishes playback.stopped when the session completes', async () => {
            await service.update('session-1', {
                position_ms: 90000,
                status: 'COMPLETED',
                event_seq: 3,
                session_elapsed_ms: MIN_ENGAGEMENT_MS,
            });

            expect(publishIntegrationEvent).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'org.lumastra.playback.stopped',
                    payload: expect.objectContaining({ sessionId: 'session-1' }),
                }),
            );
        });
    });
});

describe('audiobook lifecycle dispatch', () => {
    it('uses the unified adapter for live and terminal reports without invoking the video watch path', async () => {
        const deps = makeDeps();
        vi.mocked(deps.queries.getSessionById).mockResolvedValue({
            id: 'playback-id',
            user_id: TEST_USER_ID,
            media_id: 'book-id',
            media_type: 'audiobook',
        } as never);
        audiobookReportMock.mockResolvedValue({
            ok: true,
            sessionLost: false,
            wroteToDurable: true,
        });
        const service = new PlaySessionLifecycleService(deps);
        for (const status of ['ACTIVE', 'PAUSED', 'COMPLETED'] as const) {
            const report = {
                position_ms: 10000,
                listened_ms: 2000,
                finished: status === 'COMPLETED',
                status,
                event_seq: 3,
                session_elapsed_ms: 5000,
            };
            await service.update('playback-id', report);
            expect(audiobookReportMock).toHaveBeenLastCalledWith(
                expect.objectContaining({ playbackSessionId: 'playback-id', report }),
            );
        }
        expect(deps.watchManager.reportProgress).not.toHaveBeenCalled();
        expect(deps.watchHistoryService.recordCompletedSession).not.toHaveBeenCalled();
    });
    it.each([
        [{ ok: true, sessionLost: true, superseded: true }, 'superseded'],
        [{ ok: true, sessionLost: true }, undefined],
        [{ ok: false, sessionLost: false }, undefined],
    ] as const)('maps audiobook superseded/lost/closed explicitly: %j', async (outcome, action) => {
        const deps = makeDeps();
        vi.mocked(deps.queries.getSessionById).mockResolvedValue({
            id: 'playback-id',
            user_id: TEST_USER_ID,
            media_id: 'book-id',
            media_type: 'audiobook',
        } as never);
        audiobookReportMock.mockResolvedValue(outcome);
        const result = await new PlaySessionLifecycleService(deps).update('playback-id', {
            status: 'ACTIVE',
            position_ms: 1000,
            event_seq: 1,
        });
        expect(result).toMatchObject({ sessionLost: true });
        expect(result && 'action' in result ? result.action : undefined).toBe(action);
    });
});
