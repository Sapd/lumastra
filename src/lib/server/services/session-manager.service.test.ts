// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';

// ─── watch-state-events mock — must precede SessionManager import ────────────
// SessionManager emits `session_changed` on external lifecycle transitions;
// the mock lets us assert which transitions trigger emits without coalescing.

vi.mock('./watch-state-events.service.js', () => ({
    watchStateEvents: {
        emit: vi.fn(),
        subscribe: vi.fn(),
    },
}));

import {
    SessionManager,
    hasSemanticChange,
    type IngestExternalParams,
    type SessionManagerDeps,
} from './session-manager.service.js';
import { watchStateEvents } from './watch-state-events.service.js';
import type {
    SessionRow,
    UpsertExternalSessionParams,
} from '$lib/server/database/queries/play-sessions.queries.js';
import { toUserId } from '$lib/shared/user-id.js';

// Fixed valid users.id UUID — play_sessions.user_id values + ingest userId are
// now UUIDs (mig 16.46.0). emitSessionChanged mints toUserId(row.user_id), so
// row.user_id must be a valid UUID and the emit channel assertion uses the same.
const ALICE = toUserId('11111111-1111-4111-8111-111111111111');

// ─── Logger mock ──────────────────────────────────────────────────────────────

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
    return {
        purpose: 'play',
        id: 'row-uuid-1',
        media_id: 'media-uuid-1',
        user_id: ALICE,
        device_id: 'jellyfin',
        user_agent: 'Living Room',
        client_name: 'Jellyfin Web',
        client_version: '10.9.0',
        // A mirrored Jellyfin row: there is no first-party client to ask what
        // it can render, so this is NULL rather than an empty list.
        client_features: null,
        ip_address: '0.0.0.0',
        play_method: 'direct',
        transcode_mode: null,
        transcode_job_id: null,
        audio_codec: 'aac',
        video_codec: 'h264',
        container: 'mp4',
        bitrate_kbps: 4000,
        resolution: '1080p',
        status: 'ACTIVE',
        stop_reason: null,
        position_ms: 60_000,
        runtime_ms: 6_000_000,
        started_at: new Date('2026-04-27T10:00:00Z'),
        last_heartbeat_at: new Date('2026-04-27T10:00:00Z'),
        paused_at: null,
        stopped_at: null,
        jellyfin_session_id: null,
        device_capabilities: null,
        requested_format: null,
        jellyfin_media_source_id: null,
        audio_stream_index: null,
        subtitle_stream_index: null,
        audio_language: null,
        subtitle_language: null,
        buffer_health_sec: null,
        last_jellyfin_report_at: null,
        media_type: 'movie',
        plan_id: null,
        file_id: null,
        plan_mode: null,
        plan_reasons: null,
        subtitle_method: null,
        transcode_codec: null,
        delivery_path: null,
        last_event_seq: 0,
        source: 'jellyfin',
        source_session_id: 'jf-session-1',
        last_seen_at: new Date('2026-04-27T10:00:00Z'),
        external_payload: null,
        ...overrides,
    };
}

function makeExternalParams(overrides: Partial<IngestExternalParams> = {}): IngestExternalParams {
    return {
        source: 'jellyfin',
        sourceSessionId: 'jf-session-1',
        userId: ALICE,
        mediaId: 'media-uuid-1',
        positionMs: 60_000,
        status: 'ACTIVE',
        playMethod: 'direct',
        device: {
            name: 'Living Room',
            client: 'Jellyfin Web',
            clientVersion: '10.9.0',
            deviceId: 'jellyfin',
        },
        technical: {
            audioCodec: 'aac',
            videoCodec: 'h264',
            container: 'mp4',
            bitrate: 4000,
            resolution: '1080p',
        },
        runtimeMs: 6_000_000,
        ...overrides,
    };
}

interface MockedQueries {
    createPlaySession: ReturnType<typeof vi.fn>;
    getSessionBySourceKey: ReturnType<typeof vi.fn>;
    refreshExternalSessionPresence: ReturnType<typeof vi.fn>;
    stopExternalSession: ReturnType<typeof vi.fn>;
    stopSession: ReturnType<typeof vi.fn>;
    stopLumastraSession: ReturnType<typeof vi.fn>;
    updateHeartbeat: ReturnType<typeof vi.fn>;
    upsertExternalSession: ReturnType<typeof vi.fn>;
}

interface Harness {
    manager: SessionManager;
    queries: MockedQueries;
    sql: Sql;
    sqlTaggedCalls: string[];
}

function makeHarness(): Harness {
    const sqlTaggedCalls: string[] = [];
    // postgres.js tagged template — just record the SQL stub & resolve.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sqlFn: any = (...args: any[]) => {
        const template = Array.isArray(args[0]) ? args[0].join('?') : '';
        sqlTaggedCalls.push(template);
        return Promise.resolve({ count: 0 });
    };

    const queries: MockedQueries = {
        createPlaySession: vi.fn().mockResolvedValue(makeRow()),
        getSessionBySourceKey: vi.fn().mockResolvedValue(null),
        refreshExternalSessionPresence: vi.fn().mockResolvedValue(0),
        stopExternalSession: vi.fn().mockResolvedValue(makeRow({ status: 'CRASHED' })),
        stopSession: vi
            .fn()
            .mockResolvedValue(makeRow({ source: 'lumastra', status: 'COMPLETED' })),
        stopLumastraSession: vi.fn().mockResolvedValue(makeRow({ status: 'CRASHED' })),
        updateHeartbeat: vi.fn().mockResolvedValue(makeRow()),
        upsertExternalSession: vi.fn().mockResolvedValue({ row: makeRow(), created: true }),
    };

    const deps: SessionManagerDeps = {
        getSql: () => sqlFn as Sql,
        queries: queries as unknown as NonNullable<SessionManagerDeps['queries']>,
    };

    return {
        manager: new SessionManager(deps),
        queries,
        sql: sqlFn as Sql,
        sqlTaggedCalls,
    };
}

// ─── hasSemanticChange ────────────────────────────────────────────────────────

describe('hasSemanticChange', () => {
    it('returns false when nothing changed and position delta is sub-threshold', () => {
        const row = makeRow({ position_ms: 60_000 });
        const params = makeExternalParams({ positionMs: 62_000 }); // 2s drift
        expect(hasSemanticChange(row, params)).toBe(false);
    });

    it('returns true when position delta is at the 5s threshold', () => {
        const row = makeRow({ position_ms: 60_000 });
        const params = makeExternalParams({ positionMs: 65_000 });
        expect(hasSemanticChange(row, params)).toBe(true);
    });

    it('returns true when position delta exceeds threshold (forward seek)', () => {
        const row = makeRow({ position_ms: 60_000 });
        const params = makeExternalParams({ positionMs: 90_000 });
        expect(hasSemanticChange(row, params)).toBe(true);
    });

    it('returns true when position delta exceeds threshold (rewind)', () => {
        const row = makeRow({ position_ms: 60_000 });
        const params = makeExternalParams({ positionMs: 30_000 });
        expect(hasSemanticChange(row, params)).toBe(true);
    });

    it('returns true when status flips ACTIVE→PAUSED', () => {
        const row = makeRow({ status: 'ACTIVE' });
        const params = makeExternalParams({ status: 'PAUSED' });
        expect(hasSemanticChange(row, params)).toBe(true);
    });

    it('returns true when bitrate changes', () => {
        const row = makeRow({ bitrate_kbps: 4000 });
        const params = makeExternalParams({
            technical: { bitrate: 8000 },
        });
        expect(hasSemanticChange(row, params)).toBe(true);
    });

    it('returns true when external_payload differs', () => {
        const row = makeRow({ external_payload: { ratio: 0.1 } });
        const params = makeExternalParams({ externalPayload: { ratio: 0.2 } });
        expect(hasSemanticChange(row, params)).toBe(true);
    });

    it('returns false when external_payload is structurally equal', () => {
        const row = makeRow({ external_payload: { a: 1, b: 2 } });
        const params = makeExternalParams({ externalPayload: { a: 1, b: 2 } });
        expect(hasSemanticChange(row, params)).toBe(false);
    });
});

// ─── ingestExternal ───────────────────────────────────────────────────────────

describe('SessionManager.ingestExternal', () => {
    let harness: Harness;

    beforeEach(() => {
        vi.clearAllMocks();
        harness = makeHarness();
    });

    it('first sighting: refresh returns 0, runs full upsert and reports created=true', async () => {
        harness.queries.refreshExternalSessionPresence.mockResolvedValueOnce(0);
        harness.queries.upsertExternalSession.mockResolvedValueOnce({
            row: makeRow(),
            created: true,
        });

        const result = await harness.manager.ingestExternal(makeExternalParams());

        expect(harness.queries.refreshExternalSessionPresence).toHaveBeenCalledOnce();
        expect(harness.queries.upsertExternalSession).toHaveBeenCalledOnce();
        // No row to compare against on first sighting — getSessionBySourceKey
        // must not run.
        expect(harness.queries.getSessionBySourceKey).not.toHaveBeenCalled();
        expect(result).toEqual({ created: true, updated: false });
    });

    it('repeat poll, no semantic change: only refreshes liveness, no heavier upsert', async () => {
        harness.queries.refreshExternalSessionPresence.mockResolvedValueOnce(1);
        harness.queries.getSessionBySourceKey.mockResolvedValueOnce(makeRow());

        // Poll with identical fields except for a 1s position drift.
        const params = makeExternalParams({ positionMs: 61_000 });
        const result = await harness.manager.ingestExternal(params);

        expect(harness.queries.refreshExternalSessionPresence).toHaveBeenCalledOnce();
        expect(harness.queries.getSessionBySourceKey).toHaveBeenCalledOnce();
        expect(harness.queries.upsertExternalSession).not.toHaveBeenCalled();
        expect(result).toEqual({ created: false, updated: false });
    });

    it('repeat poll, position drift below 5s threshold: skips upsert', async () => {
        harness.queries.refreshExternalSessionPresence.mockResolvedValueOnce(1);
        harness.queries.getSessionBySourceKey.mockResolvedValueOnce(
            makeRow({ position_ms: 60_000 }),
        );

        // Exactly 4_999ms — must not trip the threshold.
        const params = makeExternalParams({ positionMs: 64_999 });
        const result = await harness.manager.ingestExternal(params);

        expect(harness.queries.upsertExternalSession).not.toHaveBeenCalled();
        expect(result.updated).toBe(false);
    });

    it('repeat poll, position movement >= 5s: runs full upsert and reports updated', async () => {
        harness.queries.refreshExternalSessionPresence.mockResolvedValueOnce(1);
        harness.queries.getSessionBySourceKey.mockResolvedValueOnce(
            makeRow({ position_ms: 60_000 }),
        );
        harness.queries.upsertExternalSession.mockResolvedValueOnce({
            row: makeRow({ position_ms: 65_000 }),
            created: false,
        });

        const params = makeExternalParams({ positionMs: 65_000 });
        const result = await harness.manager.ingestExternal(params);

        expect(harness.queries.upsertExternalSession).toHaveBeenCalledOnce();
        const upsertCall = harness.queries.upsertExternalSession.mock.calls[0];
        const upsertParams = upsertCall[1] as UpsertExternalSessionParams;
        expect(upsertParams.position_ms).toBe(65_000);
        expect(upsertParams.source).toBe('jellyfin');
        expect(upsertParams.source_session_id).toBe('jf-session-1');
        expect(result).toEqual({ created: false, updated: true });
    });

    it('repeat poll with status change ACTIVE→PAUSED: runs full upsert', async () => {
        harness.queries.refreshExternalSessionPresence.mockResolvedValueOnce(1);
        harness.queries.getSessionBySourceKey.mockResolvedValueOnce(makeRow({ status: 'ACTIVE' }));
        harness.queries.upsertExternalSession.mockResolvedValueOnce({
            row: makeRow({ status: 'PAUSED' }),
            created: false,
        });

        const result = await harness.manager.ingestExternal(
            makeExternalParams({ status: 'PAUSED' }),
        );

        expect(harness.queries.upsertExternalSession).toHaveBeenCalledOnce();
        expect(result).toEqual({ created: false, updated: true });
    });

    it('race: refresh sees row but lookup is null — falls back to upsert', async () => {
        harness.queries.refreshExternalSessionPresence.mockResolvedValueOnce(1);
        harness.queries.getSessionBySourceKey.mockResolvedValueOnce(null);
        harness.queries.upsertExternalSession.mockResolvedValueOnce({
            row: makeRow(),
            created: true,
        });

        const result = await harness.manager.ingestExternal(makeExternalParams());

        expect(harness.queries.upsertExternalSession).toHaveBeenCalledOnce();
        expect(result).toEqual({ created: true, updated: false });
    });

    it('passes external_payload through to upsertExternalSession', async () => {
        harness.queries.refreshExternalSessionPresence.mockResolvedValueOnce(0);
        const payload = { jfExtras: { foo: 'bar' } };

        await harness.manager.ingestExternal(makeExternalParams({ externalPayload: payload }));

        const args = harness.queries.upsertExternalSession.mock.calls[0];
        const upsertParams = args[1] as UpsertExternalSessionParams;
        expect(upsertParams.external_payload).toEqual(payload);
    });
});

// ─── ingestLumastra ────────────────────────────────────────────────────────────

describe('SessionManager.ingestLumastra', () => {
    let harness: Harness;

    beforeEach(() => {
        vi.clearAllMocks();
        harness = makeHarness();
    });

    it('routes to updateHeartbeat with the supplied event_seq', async () => {
        harness.queries.updateHeartbeat.mockResolvedValueOnce(
            makeRow({ source: 'lumastra', source_session_id: null }),
        );

        await harness.manager.ingestLumastra({
            sessionId: 'session-uuid-1',
            userId: ALICE,
            mediaId: 'media-uuid-1',
            positionMs: 90_000,
            status: 'ACTIVE',
            eventSeq: 42,
        });

        expect(harness.queries.updateHeartbeat).toHaveBeenCalledWith(
            harness.sql,
            'session-uuid-1',
            expect.objectContaining({
                position_ms: 90_000,
                status: 'ACTIVE',
                event_seq: 42,
            }),
        );
        // No semantic-change comparison happens for Lumastra — the event_seq
        // gate in updateHeartbeat is the sole authority.
        expect(harness.queries.getSessionBySourceKey).not.toHaveBeenCalled();
        expect(harness.queries.refreshExternalSessionPresence).not.toHaveBeenCalled();
    });

    it('falls back to createPlaySession when the row is missing and play_method is supplied', async () => {
        harness.queries.updateHeartbeat.mockResolvedValueOnce(null);

        await harness.manager.ingestLumastra({
            sessionId: 'session-uuid-2',
            userId: ALICE,
            mediaId: 'media-uuid-1',
            positionMs: 0,
            status: 'ACTIVE',
            eventSeq: 1,
            playMethod: 'direct',
        });

        expect(harness.queries.createPlaySession).toHaveBeenCalledOnce();
        const args = harness.queries.createPlaySession.mock.calls[0];
        expect(args[1]).toEqual(
            expect.objectContaining({
                id: 'session-uuid-2',
                user_id: ALICE,
                media_id: 'media-uuid-1',
                play_method: 'direct',
            }),
        );
    });

    it('skips create when the row is missing and play_method is not supplied', async () => {
        harness.queries.updateHeartbeat.mockResolvedValueOnce(null);

        await harness.manager.ingestLumastra({
            sessionId: 'session-uuid-3',
            userId: ALICE,
            mediaId: 'media-uuid-1',
            positionMs: 0,
            status: 'ACTIVE',
            eventSeq: 1,
        });

        expect(harness.queries.createPlaySession).not.toHaveBeenCalled();
    });
});

// ─── markStop ─────────────────────────────────────────────────────────────────

describe('SessionManager.markStop', () => {
    let harness: Harness;

    beforeEach(() => {
        vi.clearAllMocks();
        harness = makeHarness();
    });

    it('Lumastra completion routes to stopSession with COMPLETED status', async () => {
        await harness.manager.markStop({
            sessionId: 'session-uuid-1',
            reason: 'completed',
            finalPositionMs: 120_000,
        });

        expect(harness.queries.stopSession).toHaveBeenCalledOnce();
        const args = harness.queries.stopSession.mock.calls[0];
        // stopSession signature: (sql, id, position_ms, stop_reason)
        expect(args[1]).toBe('session-uuid-1');
        expect(args[2]).toBe(120_000);
        expect(args[3]).toBe('completed');
        expect(harness.queries.stopExternalSession).not.toHaveBeenCalled();
    });

    it('Lumastra crash routes to stopLumastraSession with CRASHED', async () => {
        await harness.manager.markStop({
            sessionId: 'session-uuid-1',
            reason: 'crashed',
            finalPositionMs: 90_000,
        });

        // stopSession is COMPLETED-only; CRASHED uses stopLumastraSession.
        expect(harness.queries.stopSession).not.toHaveBeenCalled();
        expect(harness.queries.stopLumastraSession).toHaveBeenCalledOnce();
        const args = harness.queries.stopLumastraSession.mock.calls[0];
        expect(args[1]).toBe('session-uuid-1');
        expect(args[2]).toEqual(
            expect.objectContaining({
                final_status: 'CRASHED',
                stop_reason: 'crashed',
                position_ms: 90_000,
            }),
        );
    });

    it('external session stop routes to stopExternalSession with CRASHED', async () => {
        await harness.manager.markStop({
            source: 'jellyfin',
            sourceSessionId: 'jf-session-1',
            reason: 'crashed',
        });

        expect(harness.queries.stopExternalSession).toHaveBeenCalledOnce();
        const args = harness.queries.stopExternalSession.mock.calls[0];
        expect(args[1]).toBe('jellyfin');
        expect(args[2]).toBe('jf-session-1');
        expect(args[3]).toEqual(
            expect.objectContaining({
                final_status: 'CRASHED',
                stop_reason: 'crashed',
            }),
        );
    });

    it('external killed appends detail to stop_reason', async () => {
        await harness.manager.markStop({
            source: 'livetv',
            sourceSessionId: 'livetv-session-1',
            reason: 'killed',
            detail: 'admin:bob',
        });

        const args = harness.queries.stopExternalSession.mock.calls[0];
        expect(args[3]).toEqual(
            expect.objectContaining({
                final_status: 'KILLED',
                stop_reason: 'killed:admin:bob',
            }),
        );
    });

    it('throws when both sessionId and source are supplied', async () => {
        await expect(
            harness.manager.markStop({
                sessionId: 'session-uuid-1',
                source: 'jellyfin',
                sourceSessionId: 'jf-session-1',
                reason: 'crashed',
            }),
        ).rejects.toThrow(/either sessionId/);
    });

    it('throws when neither sessionId nor source is supplied', async () => {
        await expect(harness.manager.markStop({ reason: 'crashed' })).rejects.toThrow(
            /requires either sessionId/,
        );
    });
});

// ─── session_changed emits ────────────────────────────────────────────────────

describe('SessionManager — session_changed emits', () => {
    let harness: Harness;

    beforeEach(() => {
        vi.clearAllMocks();
        harness = makeHarness();
    });

    it('ingestExternal emits session_changed on first sighting (created=true)', async () => {
        harness.queries.refreshExternalSessionPresence.mockResolvedValueOnce(0);
        harness.queries.upsertExternalSession.mockResolvedValueOnce({
            row: makeRow({ id: 'row-fresh', status: 'ACTIVE' }),
            created: true,
        });

        await harness.manager.ingestExternal(makeExternalParams());

        expect(watchStateEvents.emit).toHaveBeenCalledWith(ALICE, {
            type: 'session_changed',
            sessionId: 'row-fresh',
            status: 'ACTIVE',
            mediaId: 'media-uuid-1',
        });
    });

    it('ingestExternal emits session_changed on first sighting even when created=false (concurrent pod insert)', async () => {
        // Simulates the race: this pod saw refresh===0 but another pod inserted
        // between the refresh and this pod's upsert, so the upsert returns
        // created=false. The emit must still fire.
        harness.queries.refreshExternalSessionPresence.mockResolvedValueOnce(0);
        harness.queries.upsertExternalSession.mockResolvedValueOnce({
            row: makeRow({
                id: 'row-concurrent',
                status: 'ACTIVE',
                user_id: ALICE,
            }),
            created: false,
        });

        await harness.manager.ingestExternal(makeExternalParams());

        expect(watchStateEvents.emit).toHaveBeenCalledWith(ALICE, {
            type: 'session_changed',
            sessionId: 'row-concurrent',
            status: 'ACTIVE',
            mediaId: 'media-uuid-1',
        });
    });

    it('ingestExternal emits session_changed on status flip (ACTIVE→PAUSED)', async () => {
        harness.queries.refreshExternalSessionPresence.mockResolvedValueOnce(1);
        harness.queries.getSessionBySourceKey.mockResolvedValueOnce(makeRow({ status: 'ACTIVE' }));
        harness.queries.upsertExternalSession.mockResolvedValueOnce({
            row: makeRow({ id: 'row-existing', status: 'PAUSED' }),
            created: false,
        });

        await harness.manager.ingestExternal(makeExternalParams({ status: 'PAUSED' }));

        expect(watchStateEvents.emit).toHaveBeenCalledWith(ALICE, {
            type: 'session_changed',
            sessionId: 'row-existing',
            status: 'PAUSED',
            mediaId: 'media-uuid-1',
        });
    });

    it('ingestExternal emits session_changed when media_id changes while ACTIVE (auto-next)', async () => {
        // Jellyfin/ABS can keep the same SessionInfo.Id across an auto-next
        // episode — same source session, different media, still ACTIVE.
        // That's a lifecycle change for CW/admin even though status didn't flip.
        harness.queries.refreshExternalSessionPresence.mockResolvedValueOnce(1);
        harness.queries.getSessionBySourceKey.mockResolvedValueOnce(
            makeRow({ status: 'ACTIVE', media_id: 'media-uuid-1' }),
        );
        harness.queries.upsertExternalSession.mockResolvedValueOnce({
            row: makeRow({
                id: 'row-existing',
                status: 'ACTIVE',
                media_id: 'media-uuid-2',
            }),
            created: false,
        });

        await harness.manager.ingestExternal(
            makeExternalParams({ status: 'ACTIVE', mediaId: 'media-uuid-2' }),
        );

        expect(watchStateEvents.emit).toHaveBeenCalledWith(ALICE, {
            type: 'session_changed',
            sessionId: 'row-existing',
            status: 'ACTIVE',
            mediaId: 'media-uuid-2',
        });
    });

    it('ingestExternal does NOT emit when only position changed (no status flip)', async () => {
        harness.queries.refreshExternalSessionPresence.mockResolvedValueOnce(1);
        harness.queries.getSessionBySourceKey.mockResolvedValueOnce(
            makeRow({ status: 'ACTIVE', position_ms: 60_000 }),
        );
        harness.queries.upsertExternalSession.mockResolvedValueOnce({
            row: makeRow({ status: 'ACTIVE', position_ms: 90_000 }),
            created: false,
        });

        await harness.manager.ingestExternal(
            makeExternalParams({ status: 'ACTIVE', positionMs: 90_000 }),
        );

        expect(watchStateEvents.emit).not.toHaveBeenCalled();
    });

    it('ingestExternal does NOT emit on no-op poll (refresh-only path)', async () => {
        harness.queries.refreshExternalSessionPresence.mockResolvedValueOnce(1);
        harness.queries.getSessionBySourceKey.mockResolvedValueOnce(makeRow());

        // Sub-threshold position drift, identical fields otherwise.
        await harness.manager.ingestExternal(makeExternalParams({ positionMs: 61_000 }));

        expect(watchStateEvents.emit).not.toHaveBeenCalled();
    });

    it('ingestExternal in race-recreate path emits unconditionally using row.user_id', async () => {
        // The race-recreate branch must emit regardless of created flag and must
        // use row.user_id (not params.username) for consistency with the external
        // markStop path.
        harness.queries.refreshExternalSessionPresence.mockResolvedValueOnce(1);
        harness.queries.getSessionBySourceKey.mockResolvedValueOnce(null);
        harness.queries.upsertExternalSession.mockResolvedValueOnce({
            row: makeRow({
                id: 'row-recreated',
                status: 'ACTIVE',
                user_id: ALICE,
            }),
            created: true,
        });

        await harness.manager.ingestExternal(makeExternalParams());

        expect(watchStateEvents.emit).toHaveBeenCalledWith(ALICE, {
            type: 'session_changed',
            sessionId: 'row-recreated',
            status: 'ACTIVE',
            mediaId: 'media-uuid-1',
        });
    });

    it('ingestExternal race-recreate emits even when created=false', async () => {
        harness.queries.refreshExternalSessionPresence.mockResolvedValueOnce(1);
        harness.queries.getSessionBySourceKey.mockResolvedValueOnce(null);
        harness.queries.upsertExternalSession.mockResolvedValueOnce({
            row: makeRow({
                id: 'row-recreated-noncreated',
                status: 'ACTIVE',
                user_id: ALICE,
            }),
            created: false,
        });

        await harness.manager.ingestExternal(makeExternalParams());

        expect(watchStateEvents.emit).toHaveBeenCalledWith(ALICE, {
            type: 'session_changed',
            sessionId: 'row-recreated-noncreated',
            status: 'ACTIVE',
            mediaId: 'media-uuid-1',
        });
    });

    it('markStop emits session_changed for external transitions', async () => {
        harness.queries.stopExternalSession.mockResolvedValueOnce(
            makeRow({ id: 'row-stopped', status: 'CRASHED', user_id: ALICE }),
        );

        await harness.manager.markStop({
            source: 'jellyfin',
            sourceSessionId: 'jf-session-1',
            reason: 'crashed',
            detail: 'vanished from poll',
        });

        expect(watchStateEvents.emit).toHaveBeenCalledWith(ALICE, {
            type: 'session_changed',
            sessionId: 'row-stopped',
            status: 'CRASHED',
            mediaId: 'media-uuid-1',
        });
    });

    it('markStop does NOT emit when external row was already terminal (null returned)', async () => {
        harness.queries.stopExternalSession.mockResolvedValueOnce(null);

        await harness.manager.markStop({
            source: 'jellyfin',
            sourceSessionId: 'jf-session-1',
            reason: 'crashed',
        });

        expect(watchStateEvents.emit).not.toHaveBeenCalled();
    });

    it('markStop emits session_changed for Lumastra COMPLETED stop', async () => {
        harness.queries.stopSession.mockResolvedValueOnce(
            makeRow({
                id: 'lumastra-session-1',
                status: 'COMPLETED',
                user_id: ALICE,
                source: 'lumastra',
            }),
        );

        await harness.manager.markStop({
            sessionId: 'lumastra-session-1',
            reason: 'completed',
            finalPositionMs: 120_000,
        });

        expect(watchStateEvents.emit).toHaveBeenCalledWith(ALICE, {
            type: 'session_changed',
            sessionId: 'lumastra-session-1',
            status: 'COMPLETED',
            mediaId: 'media-uuid-1',
        });
    });

    it('markStop does NOT emit for Lumastra COMPLETED when row already terminal (null returned)', async () => {
        harness.queries.stopSession.mockResolvedValueOnce(null);

        await harness.manager.markStop({
            sessionId: 'lumastra-session-1',
            reason: 'completed',
            finalPositionMs: 120_000,
        });

        expect(watchStateEvents.emit).not.toHaveBeenCalled();
    });

    it('markStop emits session_changed for Lumastra CRASHED stop', async () => {
        harness.queries.stopLumastraSession.mockResolvedValueOnce(
            makeRow({
                id: 'lumastra-session-2',
                status: 'CRASHED',
                user_id: ALICE,
                source: 'lumastra',
            }),
        );

        await harness.manager.markStop({
            sessionId: 'lumastra-session-2',
            reason: 'crashed',
            finalPositionMs: 90_000,
        });

        expect(watchStateEvents.emit).toHaveBeenCalledWith(ALICE, {
            type: 'session_changed',
            sessionId: 'lumastra-session-2',
            status: 'CRASHED',
            mediaId: 'media-uuid-1',
        });
    });

    it('markStop does NOT emit for Lumastra CRASHED when row already terminal (null returned)', async () => {
        harness.queries.stopLumastraSession.mockResolvedValueOnce(null);

        await harness.manager.markStop({
            sessionId: 'lumastra-session-2',
            reason: 'crashed',
        });

        expect(watchStateEvents.emit).not.toHaveBeenCalled();
    });
});
