// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The audiobook session lifecycle, against a real Postgres.
 *
 * The property under test is the ORDERING CONSTRAINT, and it is not something a
 * unit test with a mocked `sql` can establish: the claim is that by the time
 * `openAudiobookSession` resolves, a row exists that
 * `authenticateAudiobookStream` will accept. So this asserts it through THAT
 * function — the real consumer, running its real query — rather than by
 * re-stating the SELECT here and proving only that two copies of one query
 * agree.
 *
 * ABS itself is a double. What is real is the database, the credential store,
 * the stream-policy gate and the byte proxy's authorisation query.
 *
 * Requires TEST_DATABASE_URL (or DATABASE_URL).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { toUserId } from '$lib/shared/user-id.js';
import {
    openAudiobookSession,
    reportAudiobookPlaybackSession,
    type AudiobookReportInput,
    type AudiobookHeartbeatInput,
    retryPendingAudiobookSessionClose,
    toProgressAck,
    type AudiobookSessionDeps,
} from './audiobook-session.service.js';
import { authenticateAudiobookStream } from './audiobook-stream-auth.js';
import {
    getActiveSessionsView,
    claimStaleSessions,
} from '../database/queries/play-sessions.queries.js';
import { SessionReadModel } from './session-read-model.service.js';
import type { AudiobookPlaySession, AudiobookSessionSyncBody } from '../audiobookshelf.js';
import * as grants from './playback-grant.js';
import { watchSyncEngine } from './watch-sync-engine.service.js';
import { registry } from '../tasks/registry.js';
import type {
    WatchSyncDefinition,
    PluginContext,
    ResumePositionItem,
} from '@sapd/lumastra-plugin-sdk';
import { getUnpushedLumastraItems } from '../database/queries/user-media-events.queries.js';
import { getStreamingSessionService } from '../oauth/streaming-session.service.js';
import { config } from '../config.js';
import { enforceStreamPolicy } from './play-sessions.service.js';
import { cancellationDef } from '../api/defs/play-sessions/_cancellation.js';
import { playbackPolicyResponse } from '../api/defs/play-sessions/_policy-response.js';
import {
    claimBootOrphanSessions,
    claimStaleSessionsForUser,
    getActiveSessionsForUser,
    getAllActiveSessionsWithMedia,
} from '../database/queries/play-sessions.queries.js';

const SKIP = !process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL;

const ABS_USER_ID = 'abs-user-1';

/**
 * Unique per case: `external_ids` is UNIQUE on (provider, external_id,
 * media_type) globally, so a fixed id makes every case after the first fail on
 * insert — and a shared id across cases would let one case's session satisfy
 * another's ownership check.
 */
let ABS_ITEM_ID = 'abs-item-1';

/** The live server's own shape, trimmed. Seconds throughout. */
function absSession(overrides: Partial<AudiobookPlaySession> = {}): AudiobookPlaySession {
    return {
        id: 'abs-session-' + randomUUID().slice(0, 8),
        playMethod: 0,
        duration: 26128.86,
        startTime: 7200,
        currentTime: 7200,
        displayTitle: 'Operation Rainbow',
        audioTracks: [
            {
                index: 1,
                ino: '33153',
                startOffset: 0,
                duration: 9735.696,
                mimeType: 'audio/mpeg',
                codec: 'mp3',
                title: '01.mp3',
                contentUrl: `/api/items/${ABS_ITEM_ID}/file/33153`,
            },
            {
                index: 2,
                ino: '33154',
                startOffset: 9735.696,
                duration: 8000,
                mimeType: 'audio/mpeg',
                codec: 'mp3',
                title: '02.mp3',
                contentUrl: `/api/items/${ABS_ITEM_ID}/file/33154`,
            },
        ],
        chapters: [
            { id: 0, start: 0, end: 9735.696, title: 'CD1' },
            { id: 1, start: 9735.696, end: 17735.696, title: 'CD2' },
        ],
        ...overrides,
    };
}

describe.skipIf(SKIP)('audiobook session service', () => {
    let sql: postgres.Sql;
    let userId: string;
    let username: string;
    let mediaId: string;

    let opened: AudiobookPlaySession;
    let synced: Array<{ sessionId: string; currentTime: number; timeListened: number }>;
    let closed: string[];
    let closedWith: Array<AudiobookSessionSyncBody | null>;
    let finished: string[];
    let deps: AudiobookSessionDeps;

    /** Rows inserted by this file, for exact teardown. */
    const seededMediaIds: string[] = [];
    const seededUserIds: string[] = [];

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await cleanupSeeded();
        await closeTestDb();
    });

    /**
     * Remove the rows this file inserted.
     *
     * Without this each case leaves its book behind for the lifetime of the test
     * database, and `audiobook-browse.queries.integration.test.ts` asserts an
     * ABSOLUTE title list over the unscoped `media_items` table — so the residue
     * makes that suite fail whenever the file order puts it after this one, and
     * the failure reads as a broken visibility filter rather than as leftovers.
     * (Reproduced: forcing session → browse produced 18 stray "Operation Rainbow"
     * entries in that assertion.)
     */
    async function cleanupSeeded(): Promise<void> {
        if (seededMediaIds.length === 0) return;
        await sql`DELETE FROM media_items WHERE id = ANY(${seededMediaIds}::uuid[])`;
        await sql`DELETE FROM users WHERE id = ANY(${seededUserIds}::uuid[])`;
        seededMediaIds.length = 0;
        seededUserIds.length = 0;
    }

    beforeEach(async () => {
        await cleanupSeeded();
        await sql`DELETE FROM play_sessions`;

        userId = randomUUID();
        username = 'listener_' + userId.slice(0, 8);
        mediaId = randomUUID();
        ABS_ITEM_ID = 'abs-item-' + mediaId.slice(0, 8);

        seededUserIds.push(userId);
        seededMediaIds.push(mediaId);
        await sql`INSERT INTO users (id, username) VALUES (${userId}::uuid, ${username})`;
        await sql`
            INSERT INTO user_profiles (user_id) VALUES (${userId}::uuid)
            ON CONFLICT (user_id) DO NOTHING
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, is_dismissed,
                                     custom_metadata)
            VALUES (${mediaId}::uuid, 'Operation Rainbow', 'audiobook', 'active', true, false,
                    ${sql.json({
                        audiobookshelf: {
                            authors: ['Tom Clancy'],
                            narrators: ['Tom Clancy'],
                        },
                    })})
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type)
            VALUES (${mediaId}::uuid, 'audiobookshelf', ${ABS_ITEM_ID}, 'audiobook')
        `;

        opened = absSession();
        synced = [];
        closed = [];
        closedWith = [];
        finished = [];
        deps = {
            client: {
                startPlaybackSessionAs: vi.fn(async () => opened),
                getMeAs: vi.fn(async () => ({ id: ABS_USER_ID, username, mediaProgress: [] })),
                syncSessionAs: vi.fn(async (_key, sessionId, body) => {
                    synced.push({
                        sessionId,
                        currentTime: body.currentTime,
                        timeListened: body.timeListened,
                    });
                    return true;
                }),
                closeSessionAs: vi.fn(async (_key, sessionId, body) => {
                    closed.push(sessionId);
                    closedWith.push(body);
                    return true;
                }),
                patchProgressAs: vi.fn(async () => true),
                markFinishedAs: vi.fn(async (_key, itemId) => {
                    finished.push(itemId);
                    return true;
                }),
            },
            credentials: {
                listUsers: async () => [{ id: ABS_USER_ID, username }],
                createApiKey: async () => ({
                    id: 'key-1',
                    apiKey: 'abs_test_key',
                    isActive: true,
                }),
                deactivateApiKey: async () => {},
            },
        };
    });

    const sourceIds = new Map<string, string>();
    const sequences = new Map<string, number>();
    function sourceId(id: string): string {
        const value = sourceIds.get(id);
        if (!value) throw new Error('Missing internal source identity');
        return value;
    }
    async function unified(input: AudiobookReportInput, status: 'ACTIVE' | 'PAUSED' | 'COMPLETED') {
        const [row] = await input.sql<
            { id: string; media_id: string }[]
        >`SELECT id, media_id FROM play_sessions WHERE source = 'audiobookshelf' AND source_session_id = ${input.absSessionId}`;
        if (!row || row.media_id !== input.mediaId) return { ok: false, sessionLost: false };
        const seq = (sequences.get(row.id) ?? 0) + 1;
        sequences.set(row.id, seq);
        return reportAudiobookPlaybackSession({
            ...input,
            playbackSessionId: row.id,
            report: {
                position_ms: input.bookPositionMs,
                listened_ms: input.listenedMs,
                finished: input.isFinished,
                status,
                event_seq: seq,
                session_elapsed_ms: 0,
            },
        });
    }
    const reportAudiobookProgress = (input: AudiobookReportInput) => unified(input, 'ACTIVE');
    const closeAudiobookSession = (input: AudiobookReportInput) => unified(input, 'COMPLETED');
    async function heartbeatAudiobookSession(input: AudiobookHeartbeatInput) {
        const [row] = await input.sql<
            { position_ms: number }[]
        >`SELECT position_ms FROM play_sessions WHERE source = 'audiobookshelf' AND source_session_id = ${input.absSessionId}`;
        return unified(
            { ...input, bookPositionMs: Number(row?.position_ms ?? 0), listenedMs: 0 },
            input.status,
        );
    }

    async function open(overrides: Record<string, unknown> = {}) {
        const result = await openAudiobookSession({
            sql,
            surface: 'internal',
            // Distinct axis from `surface` above: that one is the API surface the
            // route was mounted on, this one is which protocol the CLIENT spoke.
            // 'unknown' is what deriveSurface() returns for a call with no
            // principal, which is exactly what these tests construct — naming a
            // real client here would assert attribution none of them exercise.
            // Overridable via the spread below, like every other field.
            playSurface: 'unknown' as const,
            userId: toUserId(userId),
            username,
            mediaId,
            deviceId: 'device-a',
            clientIp: '10.0.0.1',
            clientVersion: 'test',
            deps,
            ...overrides,
        });
        if (result.ok) {
            const [row] = await sql<
                { source_session_id: string }[]
            >`SELECT source_session_id FROM play_sessions WHERE id = ${result.payload.playbackSessionId}::uuid`;
            sourceIds.set(result.payload.playbackSessionId, row.source_session_id);
        }
        return result;
    }

    it('persists the listener app version and build on the minted audiobook row', async () => {
        const result = await open({
            clientName: 'Apple',
            clientVersion: '1.0.1 (2610140823)',
            userAgent: 'Apple test agent',
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('Expected audiobook start');
        const [row] = await sql`
            SELECT client_name, client_version, user_agent FROM play_sessions
            WHERE id = ${result.playbackSessionId}
        `;
        expect(row).toMatchObject({
            client_name: 'Apple',
            client_version: '1.0.1 (2610140823)',
            user_agent: 'Apple test agent',
        });
        const readModel = new SessionReadModel({ getSql: () => sql, query: getActiveSessionsView });
        const [view] = await readModel.getActiveSessionsForUser(toUserId(userId));
        expect(view.device).toMatchObject({
            client: 'Apple',
            version: '1.0.1 (2610140823)',
            name: 'Apple test agent',
        });
    });

    it('trims and caps metadata from direct audiobook minters', async () => {
        const result = await open({
            clientName: ` ${'c'.repeat(250)} `,
            clientVersion: ` ${'v'.repeat(250)} `,
            userAgent: ` ${'a'.repeat(250)} `,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('Expected audiobook start');
        const [row] = await sql`
            SELECT client_name, client_version, user_agent FROM play_sessions
            WHERE id = ${result.playbackSessionId}
        `;
        expect(row).toMatchObject({
            client_name: 'c'.repeat(200),
            client_version: 'v'.repeat(200),
            user_agent: 'a'.repeat(200),
        });
    });

    it('has committed the play_sessions row by the time it resolves', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const [row] = await sql<{ status: string; source: string; position_ms: number }[]>`
            SELECT status, source, position_ms
              FROM play_sessions
             WHERE source_session_id = ${sourceId(result.payload.playbackSessionId)}
        `;
        expect(row).toBeDefined();
        expect(row.source).toBe('audiobookshelf');
        expect(row.status).toBe('ACTIVE');
        // ABS's own saved progress, in ms — 7200 s.
        expect(row.position_ms).toBe(7_200_000);
    });

    it.each([false, true])(
        'preserves principal admin provenance in audiobook grants (%s)',
        async (mintedByAdmin) => {
            const result = await open({ mintedByAdmin });
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error('Expected audiobook start');
            const [row] =
                await sql`SELECT minted_by_admin FROM hls_playback_tokens WHERE id = ${result.grant.id}`;
            expect(row.minted_by_admin).toBe(mintedByAdmin);
            expect(result.grant.renewHref).toBe(`/api/playback/grants/${result.grant.id}/renew`);
        },
    );

    it('ends the committed audiobook row if grant minting fails', async () => {
        const mint = vi
            .spyOn(grants, 'mintPlaybackGrant')
            .mockRejectedValueOnce(new Error('grant unavailable'));
        try {
            await expect(open()).rejects.toThrow('grant unavailable');
            const rows =
                await sql`SELECT status, stop_reason FROM play_sessions WHERE user_id = ${userId}`;
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ status: 'COMPLETED', stop_reason: 'error' });
        } finally {
            mint.mockRestore();
        }
    });

    it('mints an audiobook grant bound to the committed playback session', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const [row] = await sql<{ id: string }[]>`
            SELECT id FROM play_sessions
             WHERE source_session_id = ${sourceId(result.playbackSessionId)}
        `;
        const grant = await getStreamingSessionService().validate(
            result.payload.streamToken,
            mediaId,
            '10.0.0.1',
        );
        expect(grant).not.toBeNull();
        expect(grant?.playbackSessionId).toBe(row.id);
        expect(grant?.mediaItemId).toBe(mediaId);
    });

    /**
     * The consumer's own query, not a restatement of it.
     *
     * `authenticateAudiobookStream` is the only gate on HLS segment bytes (ABS
     * serves `/hls/:sid/*` unauthenticated), and it checks the session id
     * against exactly the row `openAudiobookSession` writes. Asserting through
     * it is what makes "the row is committed first" mean something.
     */
    it('exposes the Lumastra id, ms offsets and server-built URLs without upstream id fields', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.payload.playbackSessionId).not.toBe(
            sourceId(result.payload.playbackSessionId),
        );
        expect(result.payload).not.toHaveProperty('absSessionId');
        expect(result.payload.tracks[0]).toHaveProperty('url');
        expect(result.payload.tracks[0]).toHaveProperty('startMs');
        expect(result.payload.tracks[0]).toHaveProperty('durationMs');
        expect(result.payload.tracks[0]).not.toHaveProperty('ino');
        expect(result.payload.tracks[0]).not.toHaveProperty('startOffset');
        expect(result.payload.chapters[0]).toHaveProperty('startMs');
        expect(result.payload.chapters[0]).toHaveProperty('durationMs');
        expect(result.payload.chapters[0]).not.toHaveProperty('start');
    });

    it('never returns negative chapter durations for malformed upstream bounds', async () => {
        opened.chapters = [{ id: 0, start: 20, end: 10, title: 'Malformed chapter' }];
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.payload.chapters.every((chapter) => chapter.durationMs >= 0)).toBe(true);
    });

    it('the byte proxy accepts the session immediately after open', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const auth = await authenticateAudiobookStream({
            sql,
            token: result.payload.streamToken,
            mediaId,
            absSessionId: sourceId(result.payload.playbackSessionId),
            clientIp: '10.0.0.1',
            credentialDeps: deps.credentials,
        });

        expect(auth.ok).toBe(true);
        if (auth.ok) expect(auth.absItemId).toBe(ABS_ITEM_ID);
    });

    it('the byte proxy rejects a session id belonging to nobody', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const auth = await authenticateAudiobookStream({
            sql,
            token: result.payload.streamToken,
            mediaId,
            absSessionId: 'not-a-session-we-opened',
            clientIp: '10.0.0.1',
            credentialDeps: deps.credentials,
        });

        expect(auth.ok).toBe(false);
        // Closing the session revokes its grant, so the secret is no longer recognised.
        if (!auth.ok) expect(['unknown_session', 'invalid_token']).toContain(auth.reason);
    });

    it('resolves the resume position from ABS progress, and honours an explicit one', async () => {
        const resumed = await open();
        expect(resumed.ok && resumed.payload.startPositionMs).toBe(7_200_000);

        await sql`DELETE FROM play_sessions`;
        opened = absSession();
        const explicit = await open({ positionMs: 500_000 });
        expect(explicit.ok && explicit.payload.startPositionMs).toBe(500_000);
    });

    it.each(['absent', 'older', 'newer', 'unavailable'] as const)(
        'resumes from the newest known bookmark when upstream is %s',
        async (upstream) => {
            opened = absSession({ startTime: 0, currentTime: 0 });
            const first = await open();
            if (!first.ok) throw new Error('Expected initial session');
            vi.mocked(deps.client.syncSessionAs).mockRejectedValue(new Error('ABS offline'));
            await reportAudiobookProgress({
                sql,
                userId: toUserId(userId),
                username,
                mediaId,
                absSessionId: sourceId(first.playbackSessionId),
                bookPositionMs: 30000,
                listenedMs: 30000,
                deps,
            });
            const [state] = await sql<{ at: Date }[]>`
                SELECT last_event_at AS at FROM user_media_state
                WHERE user_id = ${userId} AND media_id = ${mediaId}
            `;
            vi.mocked(deps.client.getMeAs).mockResolvedValue({
                id: ABS_USER_ID,
                username,
                mediaProgress:
                    upstream === 'absent'
                        ? []
                        : [
                              {
                                  id: 'progress',
                                  libraryItemId: ABS_ITEM_ID,
                                  episodeId: null,
                                  currentTime: upstream === 'older' ? 60 : 10,
                                  duration: 26128.86,
                                  progress: 0,
                                  isFinished: false,
                                  startedAt: null,
                                  finishedAt: null,
                                  lastUpdate:
                                      new Date(state.at).getTime() +
                                      (upstream === 'newer' ? 1000 : -1000),
                              },
                          ],
            });
            if (upstream === 'unavailable')
                vi.mocked(deps.client.getMeAs).mockRejectedValue(new Error('progress unavailable'));
            opened = absSession({
                startTime: upstream === 'absent' ? 0 : upstream === 'older' ? 60 : 10,
            });
            const resumed = await open({ deviceId: 'new-device' });
            expect(resumed.ok && resumed.payload.startPositionMs).toBe(
                upstream === 'newer' || upstream === 'unavailable' ? 10000 : 30000,
            );
            const explicit = await open({ positionMs: 0 });
            expect(explicit.ok && explicit.payload.startPositionMs).toBe(0);
        },
    );

    it.each(['upstream', 'local'] as const)(
        'starts a finished %s winner at zero unless explicitly seeking',
        async (winner) => {
            const { appendEventAndRebuild } = await import('./watch-state-rebuilder.service.js');
            await appendEventAndRebuild(sql, {
                user_id: toUserId(userId),
                media_id: mediaId,
                event_type: winner === 'local' ? 'mark_watched' : 'progress',
                source: 'lumastra-user-mark',
                position_ms: 20000,
                runtime_ms: 26128860,
                source_event_id: null,
                session_id: null,
                event_seq: null,
                occurred_at: new Date().toISOString(),
            });
            vi.mocked(deps.client.getMeAs).mockResolvedValue({
                id: ABS_USER_ID,
                username,
                mediaProgress: [
                    {
                        id: 'progress',
                        libraryItemId: ABS_ITEM_ID,
                        episodeId: null,
                        currentTime: 7200,
                        duration: 26128.86,
                        progress: 0.3,
                        isFinished: winner === 'upstream',
                        lastUpdate: Date.now() + (winner === 'upstream' ? 10000 : -10000),
                        startedAt: null,
                        finishedAt: null,
                    },
                ],
            });
            const result = await open();
            expect(result.ok && result.payload.startPositionMs).toBe(0);
            const explicit = await open({ positionMs: 5000 });
            expect(explicit.ok && explicit.payload.startPositionMs).toBe(5000);
        },
    );

    it('reads only this book progress on open when the item endpoint is available', async () => {
        const getProgressAs = vi.fn(async () => ({
            libraryItemId: ABS_ITEM_ID,
            episodeId: null,
            currentTime: 15,
            lastUpdate: Date.now(),
            isFinished: false,
        }));
        Object.assign(deps.client, { getProgressAs });
        const result = await open();
        expect(result.ok && result.payload.startPositionMs).toBe(15000);
        expect(getProgressAs).toHaveBeenCalledWith('abs_test_key', ABS_ITEM_ID, undefined);
        expect(deps.client.getMeAs).not.toHaveBeenCalled();
    });

    it.each(['patch throws', 'patch refuses', 'sync throws', 'session lost'] as const)(
        'retains live unfinish intent in the durable decisive lane when %s',
        async (failure) => {
            const result = await open();
            if (!result.ok) throw new Error('Expected session');
            const { appendEventAndRebuild } = await import('./watch-state-rebuilder.service.js');
            await appendEventAndRebuild(sql, {
                user_id: toUserId(userId),
                media_id: mediaId,
                event_type: 'mark_watched',
                source: 'lumastra-user-mark',
                position_ms: null,
                runtime_ms: 26128860,
                source_event_id: null,
                session_id: null,
                event_seq: null,
                occurred_at: new Date(Date.now() - 1000).toISOString(),
            });
            if (failure === 'patch throws')
                vi.mocked(deps.client.patchProgressAs).mockRejectedValue(new Error('outage'));
            if (failure === 'patch refuses')
                vi.mocked(deps.client.patchProgressAs).mockResolvedValue(false);
            if (failure === 'sync throws')
                vi.mocked(deps.client.syncSessionAs).mockRejectedValue(new Error('outage'));
            if (failure === 'session lost')
                vi.mocked(deps.client.syncSessionAs).mockResolvedValue(false);
            await reportAudiobookProgress({
                sql,
                userId: toUserId(userId),
                username,
                mediaId,
                absSessionId: sourceId(result.playbackSessionId),
                bookPositionMs: 25000,
                listenedMs: 0,
                isFinished: false,
                deps,
            });
            const [pending] = await getUnpushedLumastraItems.all(sql, {
                provider: 'audiobookshelf',
                limit: 200,
                userScopes: [{ userId, since: null }],
            });
            expect(pending.latest_decisive_event_type).toBe('mark_unwatched');
            const [state] = await sql<
                { resume_position_ms: number; is_watched: boolean }[]
            >`SELECT resume_position_ms, is_watched FROM user_media_state WHERE user_id = ${userId} AND media_id = ${mediaId}`;
            expect(state).toMatchObject({ resume_position_ms: 25000, is_watched: false });
            // Pull-only still recovers an explicit playback report, while ordinary
            // library marks remain outside that scope.
            const playbackOnly = await getUnpushedLumastraItems.all(sql, {
                provider: 'audiobookshelf',
                limit: 200,
                userScopes: [{ userId, since: null, playbackOnly: true }],
            });
            expect(playbackOnly[0].latest_decisive_event_type).toBe('mark_unwatched');
        },
    );

    it('lets a later finish replace the same session’s durable unfinish intent', async () => {
        const result = await open();
        if (!result.ok) throw new Error('Expected session');
        const base = {
            sql,
            userId: toUserId(userId),
            username,
            mediaId,
            absSessionId: sourceId(result.playbackSessionId),
            listenedMs: 0,
            deps,
        };
        await reportAudiobookProgress({ ...base, bookPositionMs: 25000, isFinished: false });
        await closeAudiobookSession({ ...base, bookPositionMs: 26128860, isFinished: true });
        const [state] = await sql<
            { is_watched: boolean }[]
        >`SELECT is_watched FROM user_media_state WHERE user_id = ${userId} AND media_id = ${mediaId}`;
        expect(state.is_watched).toBe(true);
    });

    it.each([true, false])(
        'does not replay an old close finished:%s over newer ABS activity',
        async (isFinished) => {
            const result = await open();
            if (!result.ok) throw new Error('Expected session');
            vi.mocked(deps.client.closeSessionAs).mockRejectedValueOnce(new Error('outage'));
            await closeAudiobookSession({
                sql,
                userId: toUserId(userId),
                username,
                mediaId,
                absSessionId: sourceId(result.playbackSessionId),
                bookPositionMs: 25000,
                listenedMs: 0,
                isFinished,
                deps,
            });
            vi.mocked(deps.client.getMeAs).mockResolvedValue({
                id: ABS_USER_ID,
                username,
                mediaProgress: [
                    {
                        id: 'progress',
                        libraryItemId: ABS_ITEM_ID,
                        episodeId: null,
                        currentTime: 12,
                        duration: 26128.86,
                        progress: 0,
                        isFinished: !isFinished,
                        lastUpdate: Date.now() + 10000,
                        startedAt: null,
                        finishedAt: null,
                    },
                ],
            });
            await retryPendingAudiobookSessionClose({
                sql,
                userId: toUserId(userId),
                username,
                absSessionId: sourceId(result.playbackSessionId),
                deps,
            });
            expect(deps.client.patchProgressAs).not.toHaveBeenCalled();
            expect(finished).toEqual([]);
            expect(closedWith.at(-1)).toBeNull();
        },
    );

    it.each(['backoff expiry', 'newer report', 'pull-only playback'] as const)(
        'recovers outage progress after %s and drains once',
        async (retryTrigger) => {
            opened = absSession({ startTime: 0, currentTime: 0 });
            const first = await open();
            if (!first.ok) throw new Error('Expected initial session');
            vi.mocked(deps.client.syncSessionAs).mockRejectedValue(new Error('ABS offline'));
            vi.mocked(deps.client.closeSessionAs).mockRejectedValue(new Error('ABS offline'));
            const base = {
                sql,
                userId: toUserId(userId),
                username,
                mediaId,
                absSessionId: sourceId(first.playbackSessionId),
                deps,
            };
            await reportAudiobookProgress({ ...base, bookPositionMs: 30000, listenedMs: 30000 });
            await closeAudiobookSession({ ...base, bookPositionMs: 30000, listenedMs: 0 });
            const queued = await getUnpushedLumastraItems.all(sql, {
                provider: 'audiobookshelf',
                limit: 200,
                userScopes: [{ userId, since: null }],
            });
            expect(queued).toHaveLength(1);
            let reachable = false;
            const pushes: number[] = [];
            const push = vi.fn(async (_ctx: PluginContext, items: ResumePositionItem[]) => {
                if (!reachable) throw new Error('ABS offline');
                pushes.push(...items.map((i: { resumePositionMs: number }) => i.resumePositionMs));
                return {
                    succeeded: items.length,
                    failed: 0,
                    skipped: 0,
                    errors: [],
                    staleIds: [],
                    successful: items.map((i: { username: string; mediaId: string }) => ({
                        username: i.username,
                        mediaId: i.mediaId,
                    })),
                    drainedAsSkipped: [],
                };
            });
            const plugin: WatchSyncDefinition = {
                id: 'abs-outage-' + retryTrigger.replaceAll(' ', '-'),
                name: 'ABS outage regression',
                version: '1.0.0',
                capabilities: { database: true },
                providerName: 'audiobookshelf',
                isAvailable: async () => true,
                listLinkedUsers: async () => [userId],
                resolveIds: async () => [],
                pushWatchState: vi.fn(),
                pushResumePosition: push,
            };
            if (retryTrigger === 'pull-only playback') {
                await sql`INSERT INTO watch_sync_preferences (user_id, provider, direction)
                VALUES (${userId}, 'audiobookshelf', 'pull')`;
            }
            registry.registerWatchSync(plugin);
            await watchSyncEngine.runPush(plugin.id, undefined, sql);
            expect(push).toHaveBeenCalledTimes(1);
            const [delivery] = await sql<{ attempts: number; delay: number }[]>`
            SELECT (sync_delivery -> 'audiobookshelf' ->> 'attempts')::int AS attempts,
                EXTRACT(EPOCH FROM ((sync_delivery -> 'audiobookshelf' ->> 'next_attempt_at')::timestamptz - now())) AS delay
            FROM user_media_events WHERE id = ${queued[0].event_ids[0]}
        `;
            expect(delivery.attempts).toBe(1);
            expect(Number(delivery.delay)).toBeGreaterThan(25);
            expect(Number(delivery.delay)).toBeLessThanOrEqual(30);
            await watchSyncEngine.runPush(plugin.id, undefined, sql);
            expect(push).toHaveBeenCalledTimes(1);
            if (retryTrigger === 'newer report') {
                opened = absSession({ startTime: 0 });
                const next = await open();
                if (!next.ok) throw new Error('Expected replacement session');
                await reportAudiobookProgress({
                    ...base,
                    absSessionId: sourceId(next.playbackSessionId),
                    bookPositionMs: 45000,
                    listenedMs: 15000,
                });
            } else {
                // Move only our fixture's retry clock; no wall-clock sleep and no
                // new listener activity is required to recover a closed session.
                await sql`UPDATE user_media_events SET sync_delivery = jsonb_set(sync_delivery,
                '{audiobookshelf,next_attempt_at}', to_jsonb(now() - INTERVAL '1 second'))
                WHERE user_id = ${userId} AND media_id = ${mediaId}`;
            }
            reachable = true;
            await watchSyncEngine.runPush(plugin.id, undefined, sql);
            expect(pushes).toEqual([retryTrigger === 'newer report' ? 45000 : 30000]);
            await watchSyncEngine.runPush(plugin.id, undefined, sql);
            expect(push).toHaveBeenCalledTimes(2);
            expect(
                await getUnpushedLumastraItems.all(sql, {
                    provider: 'audiobookshelf',
                    limit: 200,
                    userScopes: [{ userId, since: null }],
                }),
            ).toEqual([]);
        },
    );

    it('clamps a resume position that exceeds the book', async () => {
        // Measured on the live server: a finished book can report
        // currentTime 104747.898 against duration 104747.180.
        opened = absSession({ startTime: 26_200, currentTime: 26_200 });
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.payload.startPositionMs).toBe(26_128_860);
    });

    it('detects a transcode session from the HLS track even without playMethod', async () => {
        opened = absSession({
            playMethod: null,
            audioTracks: [
                {
                    index: 1,
                    startOffset: 0,
                    duration: 26128.86,
                    title: 'Operation Rainbow',
                    contentUrl: '/hls/abc/output.m3u8',
                    mimeType: 'application/vnd.apple.mpegurl',
                    codec: null,
                },
            ],
        });
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.payload.playMethod).toBe('transcode');
        // No inode on the synthetic track — emitting '' would look like a real
        // file the byte proxy could fetch.
        expect(result.payload.tracks[0]).not.toHaveProperty('ino');
        expect(result.payload.tracks[0].url).toContain('/hls/');
    });

    it('derives the cover URL from the calling surface', async () => {
        const internal = await open();
        expect(internal.ok && internal.payload.book.images.primary?.href).toBe(
            `/api/media/${mediaId}/images/poster?size=card&v=0`,
        );

        // The byte-proxy routes exist only under /api/v1, so the track URLs do not
        // follow the mount: /api/audiobook/... is a 404 the player reports as a
        // failed playback.
        expect(internal.ok && internal.payload.tracks[0].url).toContain(
            `/api/v1/audiobooks/${mediaId}/`,
        );

        await sql`DELETE FROM play_sessions`;
        opened = absSession();
        const v1 = await open({ surface: 'v1' });
        // A bearer-only client must not be handed the internal prefix — it
        // cannot authenticate against it.
        expect(v1.ok && v1.payload.book.images.primary?.href).toBe(
            `/api/v1/media/${mediaId}/images/poster?size=card&v=0`,
        );
    });

    it('refuses a book that is dismissed upstream', async () => {
        await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${mediaId}::uuid`;
        const result = await open();
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.kind).toBe('not_an_audiobook');
    });

    it('reports elapsed audio, not a position delta, and updates our own row', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const ack = await reportAudiobookProgress({
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sourceId(result.payload.playbackSessionId),
            mediaId,
            bookPositionMs: 9_000_000,
            listenedMs: 15_000,
            deps,
        });

        expect(ack.ok).toBe(true);
        expect(synced).toEqual([
            {
                sessionId: sourceId(result.payload.playbackSessionId),
                currentTime: 9000,
                timeListened: 15,
            },
        ]);

        const [row] = await sql<{ position_ms: number }[]>`
            SELECT position_ms FROM play_sessions
             WHERE source_session_id = ${sourceId(result.payload.playbackSessionId)}
        `;
        expect(row.position_ms).toBe(9_000_000);
    });

    it.each(['PAUSED', 'COMPLETED'] as const)(
        'persists a seek position to ABS and the resume mirror on %s with zero listening time',
        async (status) => {
            opened = absSession({ startTime: 30.735, currentTime: 30.735 });
            const result = await open();
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error('Expected audiobook start');

            const ack = await reportAudiobookPlaybackSession({
                sql,
                playbackSessionId: result.payload.playbackSessionId,
                userId: toUserId(userId),
                username,
                deps,
                report: {
                    position_ms: 120_735,
                    listened_ms: 0,
                    session_elapsed_ms: 0,
                    status,
                    event_seq: 2,
                },
            });
            expect(ack.ok).toBe(true);
            const upstream = status === 'PAUSED' ? synced.at(-1) : closedWith.at(-1);
            expect(upstream).toMatchObject({ currentTime: 120.735, timeListened: 0 });
            const [state] = await sql<{ resume_position_ms: number }[]>`
                SELECT resume_position_ms FROM user_media_state
                 WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid
            `;
            expect(state.resume_position_ms).toBe(120_735);
        },
    );

    it('forwards the growth of cumulative session_elapsed_ms when listened_ms is omitted', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const id = result.payload.playbackSessionId;
        for (const [seq, elapsed] of [
            [2, 30_000],
            [3, 60_000],
            [4, 90_000],
        ] as const) {
            await reportAudiobookPlaybackSession({
                sql,
                playbackSessionId: id,
                userId: toUserId(userId),
                username,
                deps,
                report: {
                    position_ms: 9_000_000 + elapsed,
                    session_elapsed_ms: elapsed,
                    status: 'ACTIVE',
                    event_seq: seq,
                },
            });
        }
        expect(synced.map((s) => s.timeListened)).toEqual([30, 30, 30]);
    });

    it('mirrors the cumulative listening time, never the position, as session_elapsed_ms', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const id = result.payload.playbackSessionId;
        for (const [seq, elapsed] of [
            [2, 30_000],
            [3, 60_000],
        ] as const) {
            await reportAudiobookPlaybackSession({
                sql,
                playbackSessionId: id,
                userId: toUserId(userId),
                username,
                deps,
                report: {
                    position_ms: 9_000_000 + elapsed,
                    session_elapsed_ms: elapsed,
                    status: 'ACTIVE',
                    event_seq: seq,
                },
            });
        }

        // The circle rail and the engagement gate read this column as playing
        // time. Copying the position (hour 2.5 of the book) into it made the rail
        // show thousands of hours for a week of ten-second heartbeats.
        const rows = await sql<{ session_elapsed_ms: number | null }[]>`
            SELECT session_elapsed_ms FROM user_media_events
             WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid
               AND source = 'lumastra-player' AND event_type = 'progress'
             ORDER BY recorded_at
        `;
        expect(rows.map((r) => r.session_elapsed_ms)).toEqual([30_000, 60_000]);
    });

    it('refuses to report against another user’s session', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const otherId = randomUUID();
        await sql`INSERT INTO users (id, username) VALUES (${otherId}::uuid, ${'other_' + otherId.slice(0, 8)})`;

        const ack = await reportAudiobookProgress({
            sql,
            userId: toUserId(otherId),
            username: 'other',
            absSessionId: sourceId(result.payload.playbackSessionId),
            mediaId,
            bookPositionMs: 1,
            listenedMs: 0,
            deps,
        });

        expect(ack.ok).toBe(false);
        expect(synced).toEqual([]);
    });

    it('close terminates our row, so the byte proxy stops serving it', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        await closeAudiobookSession({
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sourceId(result.payload.playbackSessionId),
            mediaId,
            bookPositionMs: 12_000_000,
            listenedMs: 0,
            deps,
        });

        expect(closed).toEqual([sourceId(result.payload.playbackSessionId)]);

        const auth = await authenticateAudiobookStream({
            sql,
            token: result.payload.streamToken,
            mediaId,
            absSessionId: sourceId(result.payload.playbackSessionId),
            clientIp: '10.0.0.1',
            credentialDeps: deps.credentials,
        });
        expect(auth.ok).toBe(false);
        // Closing the session revokes its grant, so the secret is no longer recognised.
        if (!auth.ok) expect(['unknown_session', 'invalid_token']).toContain(auth.reason);
    });

    /**
     * A report that lands after a close must not bring the session back.
     *
     * The client fires a forced report on pause and a close on stop as two
     * independent requests with no ordering guarantee, so this window is real.
     * An upsert-based update would set `status = 'ACTIVE'` and clear
     * `stopped_at` — and the byte proxy would start serving the session's
     * segments again, for a session the listener and AudiobookShelf both
     * consider over.
     */
    it('a report arriving after the close does not resurrect the session', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const sessionId = sourceId(result.payload.playbackSessionId);

        await closeAudiobookSession({
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sessionId,
            mediaId,
            bookPositionMs: 12_000_000,
            listenedMs: 0,
            deps,
        });

        synced.length = 0;
        const late = await reportAudiobookProgress({
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sessionId,
            mediaId,
            bookPositionMs: 999,
            listenedMs: 5_000,
            deps,
        });

        expect(late.ok).toBe(false);
        // Nothing pushed upstream either — ABS has also been told it is closed.
        expect(synced).toEqual([]);

        const [row] = await sql<{ status: string; position_ms: number; stopped_at: Date | null }[]>`
            SELECT status, position_ms, stopped_at FROM play_sessions
             WHERE source_session_id = ${sessionId}
        `;
        expect(row.status).toBe('COMPLETED');
        expect(row.stopped_at).not.toBeNull();
        // The close's position survives; the late report's does not.
        expect(row.position_ms).toBe(12_000_000);
    });

    it('a retried closing report forwards its explicit listened_ms to AudiobookShelf once', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const id = result.payload.playbackSessionId;
        const close = () =>
            reportAudiobookPlaybackSession({
                sql,
                playbackSessionId: id,
                userId: toUserId(userId),
                username,
                deps,
                report: {
                    position_ms: 500_000,
                    session_elapsed_ms: 5_000,
                    listened_ms: 5_000,
                    status: 'COMPLETED',
                    event_seq: 4,
                },
            });
        await close();
        await close();
        const forwarded = [
            ...synced.map((s) => s.timeListened),
            ...closedWith.map((c) => c?.timeListened ?? 0),
        ];
        expect(forwarded.reduce((a, b) => a + b, 0)).toBe(5);
    });

    it('a second close is a no-op rather than an error', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const args = {
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sourceId(result.payload.playbackSessionId),
            mediaId,
            bookPositionMs: 500_000,
            listenedMs: 0,
            deps,
        };
        const first = await closeAudiobookSession(args);
        const second = await closeAudiobookSession(args);

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        // Idempotency includes the upstream side: the duplicate must not push
        // progress or trigger completion against an already-terminal session.
        expect(closed).toEqual([sourceId(result.payload.playbackSessionId)]);
        expect(finished).toEqual([]);
        const [row] = await sql<{ position_ms: number }[]>`
            SELECT position_ms FROM play_sessions
             WHERE source_session_id = ${sourceId(result.payload.playbackSessionId)}
        `;
        expect(row.position_ms).toBe(500_000);
    });

    it('retries close cleanup without replaying stale progress or listening time', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const bodies: Array<AudiobookSessionSyncBody | null> = [];
        deps.client.closeSessionAs = vi.fn(async (_key, _sessionId, body) => {
            bodies.push(body);
            if (bodies.length === 1) throw new Error('ABS unavailable');
            return true;
        });

        await closeAudiobookSession({
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sourceId(result.payload.playbackSessionId),
            mediaId,
            bookPositionMs: 500_000,
            listenedMs: 12_000,
            deps,
        });
        await retryPendingAudiobookSessionClose({
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sourceId(result.payload.playbackSessionId),
            deps,
        });

        expect(bodies).toHaveLength(2);
        expect(bodies[1]).toBeNull();
        expect(bodies[0]).toMatchObject({ currentTime: 500, timeListened: 12 });
        const [row] = await sql<
            {
                position_ms: number;
                close_state: string | null;
            }[]
        >`
            SELECT position_ms,
                   external_payload #>> '{__lumastra_audiobook_close,state}' AS close_state
            FROM play_sessions
            WHERE source_session_id = ${sourceId(result.payload.playbackSessionId)}
        `;
        expect(row.position_ms).toBe(500_000);
        expect(row.close_state).toBe('done');
    });

    it('coalesces concurrent duplicate closes behind one durable claim', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        let enterClose!: () => void;
        const entered = new Promise<void>((resolve) => {
            enterClose = resolve;
        });
        let releaseClose!: () => void;
        const gate = new Promise<void>((resolve) => {
            releaseClose = resolve;
        });
        deps.client.closeSessionAs = vi.fn(async () => {
            enterClose();
            await gate;
            return true;
        });
        const args = {
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sourceId(result.payload.playbackSessionId),
            mediaId,
            bookPositionMs: 500_000,
            listenedMs: 12_000,
            deps,
        };

        const first = closeAudiobookSession(args);
        await entered;
        const duplicate = closeAudiobookSession({
            ...args,
            bookPositionMs: 900_000,
            listenedMs: 99_000,
        });

        try {
            // The duplicate can finish while ABS is still blocked: no local
            // transaction or advisory lock spans the upstream request.
            expect((await duplicate).ok).toBe(true);
            expect(deps.client.closeSessionAs).toHaveBeenCalledOnce();
        } finally {
            releaseClose();
            await first;
        }
        expect(deps.client.closeSessionAs).toHaveBeenCalledOnce();
    });

    it('projects a paused heartbeat as paused in the Active Streams read model', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const ack = await heartbeatAudiobookSession({
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sourceId(result.payload.playbackSessionId),
            mediaId,
            status: 'PAUSED',
            deps,
        });
        expect(ack.ok).toBe(true);

        const readModel = new SessionReadModel({
            getSql: () => sql,
            query: getActiveSessionsView,
        });
        const [view] = await readModel.getActiveSessionsForUser(toUserId(userId));
        expect(view.status).toBe('PAUSED');
        expect(view.isPlaying).toBe(false);
    });

    /**
     * The session `/sync` body has no finished field, so closing at
     * `currentTime ≈ duration` does NOT mark a book read upstream. Only the
     * progress row can, and `isFinished` used to reach no further than our own
     * `stop_reason` — a finished 20-hour book stayed 99.9% listened in
     * AudiobookShelf forever.
     */
    it('marks the book finished upstream, not just locally', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        await closeAudiobookSession({
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sourceId(result.payload.playbackSessionId),
            mediaId,
            bookPositionMs: 26_128_860,
            listenedMs: 0,
            isFinished: true,
            deps,
        });

        expect(finished).toEqual([ABS_ITEM_ID]);
        const [row] = await sql<{ stop_reason: string }[]>`
            SELECT stop_reason FROM play_sessions
             WHERE source_session_id = ${sourceId(result.payload.playbackSessionId)}
        `;
        expect(row.stop_reason).toBe('finished');
    });

    it.each(['ACTIVE', 'COMPLETED'] as const)(
        'propagates explicit live finished:false on a %s report',
        async (status) => {
            const result = await open();
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            await unified(
                {
                    sql,
                    userId: toUserId(userId),
                    username,
                    absSessionId: sourceId(result.payload.playbackSessionId),
                    mediaId,
                    bookPositionMs: 7_200_000,
                    listenedMs: 0,
                    isFinished: false,
                    deps,
                },
                status,
            );
            expect(deps.client.patchProgressAs).toHaveBeenCalledWith('abs_test_key', ABS_ITEM_ID, {
                isFinished: false,
            });
            expect(finished).toEqual([]);
        },
    );

    it('does NOT mark finished on an ordinary stop', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        await closeAudiobookSession({
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sourceId(result.payload.playbackSessionId),
            mediaId,
            bookPositionMs: 1_000,
            listenedMs: 0,
            deps,
        });

        expect(finished).toEqual([]);
    });

    /**
     * A paused book must survive the next stream the listener starts.
     *
     * `last_seen_at` is bumped by position reports — every 15 s while playing,
     * never while paused. The reaper inside `enforceStreamPolicy` used to crash
     * every `source <> 'lumastra'` row after 30 s of silence, which is a mirror's
     * cadence, not ours. So pausing a book for a minute and then starting
     * anything else marked it CRASHED, and because the byte proxy only serves
     * ACTIVE/PAUSED sessions, every further segment 404'd mid-book.
     */
    it('does not reap a paused session when the next stream starts', async () => {
        const first = await open();
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        // Paused for five minutes: no reports, so `last_seen_at` stands still.
        await sql`
            UPDATE play_sessions
               SET status = 'PAUSED',
                   paused_at = now() - INTERVAL '5 minutes',
                   last_seen_at = now() - INTERVAL '5 minutes',
                   last_heartbeat_at = now() - INTERVAL '5 minutes'
             WHERE source_session_id = ${sourceId(first.payload.playbackSessionId)}
        `;

        // Starting ANOTHER BOOK runs the policy gate, which runs the reaper.
        //
        // Deliberately a different book: minting a stream token deactivates any
        // existing active token for the same (user, media), so re-opening the
        // SAME book would retire the first token and the proxy assertion below
        // would fail for a reason that has nothing to do with the reaper.
        const otherMediaId = randomUUID();
        seededMediaIds.push(otherMediaId);
        const otherAbsId = 'abs-item-other-' + otherMediaId.slice(0, 8);
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, is_dismissed)
            VALUES (${otherMediaId}::uuid, 'Another Book', 'audiobook', 'active', true, false)
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type)
            VALUES (${otherMediaId}::uuid, 'audiobookshelf', ${otherAbsId}, 'audiobook')
        `;
        opened = absSession({ id: 'abs-session-other' });
        const second = await open({ mediaId: otherMediaId, deviceId: 'device-b' });
        expect(second.ok).toBe(true);

        const [row] = await sql<{ status: string }[]>`
            SELECT status FROM play_sessions
             WHERE source_session_id = ${sourceId(first.payload.playbackSessionId)}
        `;
        expect(row.status).toBe('PAUSED');

        // And the byte proxy still serves it.
        const auth = await authenticateAudiobookStream({
            sql,
            token: first.payload.streamToken,
            mediaId,
            absSessionId: sourceId(first.payload.playbackSessionId),
            clientIp: '10.0.0.1',
            credentialDeps: deps.credentials,
        });
        expect(auth.ok).toBe(true);
    });

    it('is eventually reaped once genuinely abandoned', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        await sql`
            UPDATE play_sessions
               SET last_seen_at = now() - INTERVAL '45 minutes',
                   last_heartbeat_at = now() - INTERVAL '45 minutes'
             WHERE source_session_id = ${sourceId(result.payload.playbackSessionId)}
        `;

        await sql`
            UPDATE hls_playback_tokens SET last_used_at = now() - INTERVAL '45 minutes'
             WHERE play_session_id IN (
                SELECT id::text FROM play_sessions WHERE source_session_id = ${sourceId(result.playbackSessionId)}
             )
        `;
        const reaped = (await claimStaleSessions(sql)).length;
        expect(reaped).toBeGreaterThanOrEqual(1);

        const [row] = await sql<{ status: string }[]>`
            SELECT status FROM play_sessions
             WHERE source_session_id = ${sourceId(result.payload.playbackSessionId)}
        `;
        // Without an 'audiobookshelf' branch in staleSessionCondition this stayed
        // ACTIVE forever, squatting on the listener's concurrent-stream budget.
        expect(row.status).toBe('CRASHED');
    });

    it('surfaces a sessionLost when ABS has forgotten the session', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        deps.client.syncSessionAs = vi.fn(async () => false);
        const ack = await reportAudiobookProgress({
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sourceId(result.payload.playbackSessionId),
            mediaId,
            bookPositionMs: 1_000,
            listenedMs: 0,
            deps,
        });

        // Still ok: the row is ours and was updated. Only the upstream lane is
        // gone, and that must never read as "stop playing".
        expect(ack.ok).toBe(true);
        expect(ack.sessionLost).toBe(true);
    });

    /**
     * The hand-off case: pause here, carry on somewhere else.
     *
     * A reaped session's position is 30+ minutes old by construction, and
     * AudiobookShelf's progress row is last-write-wins with no history — so a
     * close that carries `currentTime` rewinds whatever device has been
     * listening since. ABS treats an EMPTY close body as "just end the session"
     * (`closeSessionRequest` with `syncData = null` only saves the session), so
     * the reaper has a way to close cleanly without asserting a position.
     */
    it('a reaped session is closed upstream WITHOUT re-asserting its stale position', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        await reportAudiobookProgress({
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sourceId(result.payload.playbackSessionId),
            mediaId,
            bookPositionMs: 3_600_000,
            listenedMs: 60_000,
            deps,
        });

        // Paused, then abandoned — the tab is still open, the listener is not.
        await sql`
            UPDATE play_sessions
               SET status = 'PAUSED',
                   paused_at = now() - INTERVAL '45 minutes',
                   last_seen_at = now() - INTERVAL '45 minutes',
                   last_heartbeat_at = now() - INTERVAL '45 minutes'
             WHERE source_session_id = ${sourceId(result.payload.playbackSessionId)}
        `;
        await sql`
            UPDATE hls_playback_tokens SET last_used_at = now() - INTERVAL '45 minutes'
             WHERE play_session_id IN (
                SELECT id::text FROM play_sessions WHERE source_session_id = ${sourceId(result.playbackSessionId)}
             )
        `;
        expect((await claimStaleSessions(sql)).length).toBeGreaterThanOrEqual(1);

        await retryPendingAudiobookSessionClose({
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sourceId(result.payload.playbackSessionId),
            deps,
        });

        expect(closed).toEqual([sourceId(result.payload.playbackSessionId)]);
        expect(closedWith).toEqual([null]);
    });

    /**
     * The evidence a close carries is its position, and a position's evidence
     * value is however old the pause in front of it is.
     *
     * `listenedMs` looks like the right test and is not: a pause that landed
     * inside the seek dwell withholds its report but still counts the audio, so
     * an hour later the close arrives claiming eight seconds of listening
     * against a position from before the hand-off. What makes that position
     * worthless is the twenty minutes it has been sitting there, which is what
     * `paused_at` measures — and nothing is lost by declining it, because the
     * position it restates was already reported.
     */
    it('a close from a session left paused asserts no position, even with listening to report', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const shared = {
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sourceId(result.payload.playbackSessionId),
            mediaId,
            deps,
        };
        await reportAudiobookProgress({ ...shared, bookPositionMs: 3_600_000, listenedMs: 60_000 });

        // Paused, then left. Under the reap grace, so the row is still PAUSED
        // and this close is the client's own — not the reaper's.
        await sql`
            UPDATE play_sessions
               SET status = 'PAUSED', paused_at = now() - INTERVAL '20 minutes'
             WHERE source_session_id = ${sourceId(result.payload.playbackSessionId)}
        `;

        await closeAudiobookSession({ ...shared, bookPositionMs: 3_600_000, listenedMs: 8_000 });

        expect(closed).toEqual([sourceId(result.payload.playbackSessionId)]);
        expect(closedWith).toEqual([null]);

        const [state] = await sql<{ resume_position_ms: number }[]>`
            SELECT resume_position_ms
              FROM user_media_state
             WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid
        `;
        expect(state.resume_position_ms).toBe(3_600_000);
    });

    /**
     * The other half of the same rule: a client that reports no listening time
     * is not thereby disqualified. Only the age of the pause is.
     */
    it('a close moments after pausing records where the listener stopped', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        await sql`
            UPDATE play_sessions
               SET status = 'PAUSED', paused_at = now()
             WHERE source_session_id = ${sourceId(result.payload.playbackSessionId)}
        `;

        await closeAudiobookSession({
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sourceId(result.payload.playbackSessionId),
            mediaId,
            bookPositionMs: 3_600_000,
            listenedMs: 0,
            deps,
        });

        expect(closedWith[0]?.currentTime).toBe(3600);
    });

    it('a user-initiated close still asserts the position the listener stopped at', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        await closeAudiobookSession({
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sourceId(result.payload.playbackSessionId),
            mediaId,
            bookPositionMs: 3_600_000,
            listenedMs: 60_000,
            deps,
        });

        expect(closedWith[0]?.currentTime).toBe(3600);
    });

    /**
     * The same hand-off, declined. A download needs a real session — the track
     * list and the stream token have no other source — but the listener is not
     * moving to the downloading device, so ending the deck they left paused
     * elsewhere would evict the device they are actually using. Long downloads
     * refresh their token repeatedly, so it would do it more than once.
     */
    it('a download-purpose open leaves a paused deck alone', async () => {
        const first = await open();
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        await sql`
            UPDATE play_sessions
               SET status = 'PAUSED', paused_at = now()
             WHERE source_session_id = ${sourceId(first.payload.playbackSessionId)}
        `;

        opened = absSession();
        const second = await open({ deviceId: 'device-phone', purpose: 'download' });
        expect(second.ok).toBe(true);
        if (!second.ok) return;

        const [old] = await sql<{ status: string; stop_reason: string | null }[]>`
            SELECT status, stop_reason FROM play_sessions
             WHERE source_session_id = ${sourceId(first.payload.playbackSessionId)}
        `;
        expect(old.status).toBe('PAUSED');
        expect(old.stop_reason).toBeNull();
    });

    /**
     * The hand-off, from the other end: the phone opening the book is what
     * finishes the deck left paused at home.
     */
    it('starting the book elsewhere ends the paused session left behind', async () => {
        const first = await open();
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        await sql`
            UPDATE play_sessions
               SET status = 'PAUSED', paused_at = now()
             WHERE source_session_id = ${sourceId(first.payload.playbackSessionId)}
        `;

        opened = absSession();
        const second = await open({ deviceId: 'device-phone' });
        expect(second.ok).toBe(true);
        if (!second.ok) return;

        const [old] = await sql<{ status: string; stop_reason: string | null }[]>`
            SELECT status, stop_reason FROM play_sessions
             WHERE source_session_id = ${sourceId(first.payload.playbackSessionId)}
        `;
        expect(old.status).toBe('KILLED');
        expect(old.stop_reason).toBe('superseded');
        const [retiredGrant] = await sql<{ is_active: boolean; ended_reason: string }[]>`
            SELECT is_active, ended_reason FROM hls_playback_tokens
            WHERE id = ${first.grant.id}
        `;
        expect(retiredGrant).toMatchObject({ is_active: false, ended_reason: 'superseded' });

        // The phone's own session is untouched.
        const [live] = await sql<{ status: string }[]>`
            SELECT status FROM play_sessions
             WHERE source_session_id = ${sourceId(second.payload.playbackSessionId)}
        `;
        expect(live.status).toBe('ACTIVE');
    });

    /**
     * The hand-off has to be POSSIBLE for the listener it matters most to.
     *
     * An audiobook row counts against the concurrent-stream budget —
     * `UNMETERED_SOURCES` deliberately excludes 'audiobookshelf' — so at a
     * one-stream limit the deck left paused on the laptop is holding the only
     * slot. Superseding it after the policy gate means the takeover is refused
     * one line before the code that would have freed it.
     *
     * `enforceStreamPolicy` already establishes the rule this follows: it reaps
     * stale rows BEFORE counting, precisely so a session nobody is at cannot
     * block its own owner.
     */
    it('lets the listener take over at a one-stream limit', async () => {
        // Keyed by USERNAME, not the uuid — `enforceStreamPolicy`'s third
        // argument is the policy key and the callers pass `username`, while the
        // column is plain text. A uuid here inserts happily and is never read.
        await sql`
            INSERT INTO user_stream_policies (user_id, max_concurrent_streams, updated_at)
            VALUES (${username}, 1, now())
            ON CONFLICT (user_id) DO UPDATE SET max_concurrent_streams = 1
        `;

        const first = await open();
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        await sql`
            UPDATE play_sessions
               SET status = 'PAUSED', paused_at = now()
             WHERE source_session_id = ${sourceId(first.payload.playbackSessionId)}
        `;

        opened = absSession();
        const second = await open({ deviceId: 'device-phone' });
        expect(second.ok).toBe(true);
    });

    /**
     * The supersede runs inside the policy transaction, so a refusal for some
     * other reason (here: a disallowed play method) rolls it back. It used to
     * run before the transaction and leave the paused deck ended anyway, a cost
     * that was accepted while only paused decks were affected. Now that playing
     * sessions are superseded too, it would stop the listener's TV and give the
     * phone nothing.
     */
    it('a refused open ends nothing, paused or playing', async () => {
        const paused = await open();
        expect(paused.ok).toBe(true);
        if (!paused.ok) return;
        await sql`
            UPDATE play_sessions
               SET status = 'PAUSED', paused_at = now()
             WHERE source_session_id = ${sourceId(paused.payload.playbackSessionId)}
        `;
        opened = absSession();
        const playing = await open({ deviceId: 'device-tv' });
        expect(playing.ok).toBe(true);
        if (!playing.ok) return;
        // The TV's open superseded the paused deck on device-a — that is
        // correct and not what this case is about. Put it back.
        await sql`
            UPDATE play_sessions
               SET status = 'PAUSED', stopped_at = NULL, stop_reason = NULL
             WHERE source_session_id = ${sourceId(paused.payload.playbackSessionId)}
        `;

        // Applied only now, so the refusal lands on the phone's open.
        await sql`
            INSERT INTO user_stream_policies (user_id, allowed_play_methods, updated_at)
            VALUES (${username}, ARRAY['full_transcode'], now())
            ON CONFLICT (user_id) DO UPDATE SET allowed_play_methods = ARRAY['full_transcode']
        `;

        opened = absSession();
        const refused = await open({ deviceId: 'device-phone' });
        expect(refused.ok).toBe(false);

        const rows = await sql<{ source_session_id: string; status: string }[]>`
            SELECT source_session_id, status FROM play_sessions
             WHERE source_session_id IN (${sourceId(paused.payload.playbackSessionId)},
                                         ${sourceId(playing.payload.playbackSessionId)},
                                         ${opened.id})
        `;
        const status = Object.fromEntries(rows.map((r) => [r.source_session_id, r.status]));
        expect(status[sourceId(paused.payload.playbackSessionId)]).toBe('PAUSED');
        expect(status[sourceId(playing.payload.playbackSessionId)]).toBe('ACTIVE');
        // The refused open left no row of its own either.
        expect(status[opened.id]).toBeUndefined();
    });

    /**
     * Two opens of the same book on two devices at nearly the same moment.
     * Without serialisation each supersede runs before the other's row exists,
     * both see nothing to end, and both decks stay live and overwrite each
     * other's progress — the bug the supersede exists to prevent.
     */
    it('two simultaneous opens of the same book leave exactly one live session', async () => {
        deps.client.startPlaybackSessionAs = vi.fn(async () => absSession());

        const [tv, phone] = await Promise.all([
            open({ deviceId: 'device-tv' }),
            open({ deviceId: 'device-phone' }),
        ]);
        expect(tv.ok).toBe(true);
        expect(phone.ok).toBe(true);

        const live = await sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM play_sessions
             WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid
               AND status IN ('ACTIVE', 'PAUSED')
        `;
        expect(live[0].n).toBe(1);
    });

    /**
     * A download's row is what authorises the files a device is fetching for
     * offline use. Starting to listen — to another book on the same phone, or
     * to the same book on the TV — must not cut it off.
     */
    it('a playback open never ends a download, on the same device or the same book', async () => {
        // Three live sessions at once; the default limit is about something else.
        await sql`
            INSERT INTO user_stream_policies (user_id, max_concurrent_streams, updated_at)
            VALUES (${username}, 5, now())
            ON CONFLICT (user_id) DO UPDATE SET max_concurrent_streams = 5
        `;
        const download = await open({ deviceId: 'device-phone', purpose: 'download' });
        expect(download.ok).toBe(true);
        if (!download.ok) return;

        const otherMediaId = randomUUID();
        seededMediaIds.push(otherMediaId);
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, is_dismissed)
            VALUES (${otherMediaId}::uuid, 'Another Book', 'audiobook', 'active', true, false)
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type)
            VALUES (${otherMediaId}::uuid, 'audiobookshelf',
                    ${'abs-item-other-' + otherMediaId.slice(0, 8)}, 'audiobook')
        `;

        const downloadStatus = async (): Promise<string> => {
            const [row] = await sql<{ status: string }[]>`
                SELECT status FROM play_sessions
                 WHERE source_session_id = ${sourceId(download.payload.playbackSessionId)}
            `;
            return row.status;
        };

        // Another book on the same phone.
        opened = absSession();
        expect((await open({ mediaId: otherMediaId, deviceId: 'device-phone' })).ok).toBe(true);
        expect(await downloadStatus()).toBe('ACTIVE');
        // The byte proxy still serves the download.
        const auth = await authenticateAudiobookStream({
            sql,
            token: download.payload.streamToken,
            mediaId,
            absSessionId: sourceId(download.payload.playbackSessionId),
            clientIp: '10.0.0.1',
            credentialDeps: deps.credentials,
        });
        expect(auth.ok).toBe(true);

        // The same book on the TV. Only the ROW is asserted here: minting the
        // TV's stream token retires the phone's token for the same (user, book)
        // in the streaming-session service, which is a separate rule.
        opened = absSession();
        expect((await open({ deviceId: 'device-tv' })).ok).toBe(true);
        expect(await downloadStatus()).toBe('ACTIVE');
    });

    /**
     * A download sends no position reports, so the 5-minute silence that ends a
     * crashed deck would cut a long download off mid-file. It keeps the
     * 30-minute grace.
     */
    it('a download is not reaped by the short playing-deck grace', async () => {
        const download = await open({ deviceId: 'device-phone', purpose: 'download' });
        expect(download.ok).toBe(true);
        if (!download.ok) return;

        await sql`
            UPDATE play_sessions
               SET last_seen_at = now() - INTERVAL '10 minutes',
                   last_heartbeat_at = now() - INTERVAL '10 minutes'
             WHERE source_session_id = ${sourceId(download.payload.playbackSessionId)}
        `;
        await claimStaleSessions(sql);

        const [row] = await sql<{ status: string }[]>`
            SELECT status FROM play_sessions
             WHERE source_session_id = ${sourceId(download.payload.playbackSessionId)}
        `;
        expect(row.status).toBe('ACTIVE');
    });

    /**
     * The hand-off away from a deck that is STILL PLAYING — an Apple TV left
     * running while the listener carries on from the phone.
     *
     * AudiobookShelf keeps one last-write-wins progress row per (user, book),
     * so two live decks on the same book overwrite each other every reporting
     * interval. Measured on preprod before this: the phone reported 2:00:00, and
     * 45 s later the position was back at the TV's 54:00. The newest open wins,
     * and the TV learns from its next report.
     */
    it('starting the book elsewhere ends a session that is still playing', async () => {
        const first = await open();
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        opened = absSession();
        const second = await open({ deviceId: 'device-phone' });
        expect(second.ok).toBe(true);
        if (!second.ok) return;

        const [old] = await sql<{ status: string; stop_reason: string | null }[]>`
            SELECT status, stop_reason FROM play_sessions
             WHERE source_session_id = ${sourceId(first.payload.playbackSessionId)}
        `;
        expect(old.status).toBe('KILLED');
        expect(old.stop_reason).toBe('superseded');

        // The TV's next periodic report is refused as superseded, and its
        // position goes nowhere, upstream or local.
        const report = await reportAudiobookProgress({
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sourceId(first.payload.playbackSessionId),
            mediaId,
            bookPositionMs: 3_240_000,
            listenedMs: 20_000,
            deps,
        });
        expect(toProgressAck(report)).toEqual({
            synced: false,
            sessionLost: true,
            superseded: true,
        });
        expect(
            synced.some((sync) => sync.sessionId === sourceId(first.payload.playbackSessionId)),
        ).toBe(false);

        const [live] = await sql<{ status: string }[]>`
            SELECT status FROM play_sessions
             WHERE source_session_id = ${sourceId(second.payload.playbackSessionId)}
        `;
        expect(live.status).toBe('ACTIVE');
    });

    /**
     * The crashed-app case. A force-quit client never closes its session, so
     * when it comes back and opens anything, the row it left behind would
     * otherwise sit ACTIVE until the reaper reaches it — holding a stream slot
     * the whole time. AudiobookShelf already closes the older session for the
     * same (user, device); the slot accounting now follows.
     */
    it("a new open on the same device ends that device's older session, whatever the book", async () => {
        const first = await open({ deviceId: 'device-tv' });
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        const otherMediaId = randomUUID();
        seededMediaIds.push(otherMediaId);
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, is_dismissed)
            VALUES (${otherMediaId}::uuid, 'Another Book', 'audiobook', 'active', true, false)
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type)
            VALUES (${otherMediaId}::uuid, 'audiobookshelf',
                    ${'abs-item-other-' + otherMediaId.slice(0, 8)}, 'audiobook')
        `;

        opened = absSession();
        const second = await open({ mediaId: otherMediaId, deviceId: 'device-tv' });
        expect(second.ok).toBe(true);

        const [old] = await sql<{ status: string; stop_reason: string | null }[]>`
            SELECT status, stop_reason FROM play_sessions
             WHERE source_session_id = ${sourceId(first.payload.playbackSessionId)}
        `;
        expect(old.status).toBe('KILLED');
        expect(old.stop_reason).toBe('superseded');
    });

    /**
     * The reported 503: at a one-stream limit, the row a crashed Apple TV left
     * ACTIVE on the book held the only slot, and the phone opening the same
     * book was refused with `stream_limit`.
     */
    it('lets the phone take over from a crashed deck at a one-stream limit', async () => {
        await sql`
            INSERT INTO user_stream_policies (user_id, max_concurrent_streams, updated_at)
            VALUES (${username}, 1, now())
            ON CONFLICT (user_id) DO UPDATE SET max_concurrent_streams = 1
        `;

        const first = await open({ deviceId: 'device-tv' });
        expect(first.ok).toBe(true);

        opened = absSession();
        const second = await open({ deviceId: 'device-phone' });
        expect(second.ok).toBe(true);
    });

    /**
     * Neither the same book nor the same device: a second listener on the
     * account playing something else is not replaced by this open. The
     * concurrent-stream policy decides whether both may run.
     */
    it('leaves another device playing a different book alone', async () => {
        const first = await open();
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        const otherMediaId = randomUUID();
        seededMediaIds.push(otherMediaId);
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, is_dismissed)
            VALUES (${otherMediaId}::uuid, 'Another Book', 'audiobook', 'active', true, false)
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type)
            VALUES (${otherMediaId}::uuid, 'audiobookshelf',
                    ${'abs-item-other-' + otherMediaId.slice(0, 8)}, 'audiobook')
        `;

        opened = absSession();
        const second = await open({ mediaId: otherMediaId, deviceId: 'device-phone' });
        expect(second.ok).toBe(true);

        const [old] = await sql<{ status: string }[]>`
            SELECT status FROM play_sessions
             WHERE source_session_id = ${sourceId(first.payload.playbackSessionId)}
        `;
        expect(old.status).toBe('ACTIVE');
    });

    /** A download on another device must not stop the deck that is playing. */
    it('a download-purpose open leaves a playing deck alone', async () => {
        const first = await open();
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        opened = absSession();
        const second = await open({ deviceId: 'device-phone', purpose: 'download' });
        expect(second.ok).toBe(true);

        const [old] = await sql<{ status: string }[]>`
            SELECT status FROM play_sessions
             WHERE source_session_id = ${sourceId(first.payload.playbackSessionId)}
        `;
        expect(old.status).toBe('ACTIVE');
    });

    /**
     * What the displaced deck is told when it finally speaks up.
     *
     * A 404 would be read as "the session is gone, reopen one and keep playing"
     * — which for a paused deck means re-claiming a stream slot and re-anchoring
     * a position the other device has already moved past. `superseded` is the
     * signal that there is nothing here to keep playing.
     */
    it('answers the displaced session with superseded, not a bare not-found', async () => {
        const first = await open();
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        await sql`
            UPDATE play_sessions
               SET status = 'PAUSED', paused_at = now()
             WHERE source_session_id = ${sourceId(first.payload.playbackSessionId)}
        `;
        opened = absSession();
        await open({ deviceId: 'device-phone' });

        const beat = await heartbeatAudiobookSession({
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sourceId(first.payload.playbackSessionId),
            mediaId,
            status: 'PAUSED',
            deps,
        });
        expect(beat.ok).toBe(true);
        expect(beat.superseded).toBe(true);
        expect(toProgressAck(beat)).toEqual({ synced: false, sessionLost: true, superseded: true });

        const report = await reportAudiobookProgress({
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sourceId(first.payload.playbackSessionId),
            mediaId,
            bookPositionMs: 1_000_000,
            listenedMs: 5_000,
            deps,
        });
        expect(report.superseded).toBe(true);
        // And it did NOT push that stale position anywhere.
        expect(synced.some((sync) => sync.currentTime === 1000)).toBe(false);
    });

    /**
     * The close path's own liveness check, which the report path has had all
     * along (`advanceAudiobookSessionPosition` gates on ACTIVE/PAUSED inside the
     * same statement).
     *
     * Without it a close for an already-terminal session still reaches the
     * mirror: `prepareAudiobookSessionClose`'s UNION ALL branch returns the row
     * whatever its status, so `prepared` is truthy and the write goes ahead.
     * AudiobookShelf is safe either way — the frozen payload closes it
     * position-less — but `user_media_state` is what the iOS player resumes
     * from, and dragging THAT backwards is the whole bug.
     */
    it('a close arriving after the session was superseded moves nothing', async () => {
        const first = await open();
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        const shared = {
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sourceId(first.payload.playbackSessionId),
            mediaId,
            deps,
        };
        await reportAudiobookProgress({ ...shared, bookPositionMs: 3_600_000, listenedMs: 60_000 });
        await sql`
            UPDATE play_sessions
               SET status = 'PAUSED', paused_at = now()
             WHERE source_session_id = ${sourceId(first.payload.playbackSessionId)}
        `;

        opened = absSession();
        await open({ deviceId: 'device-phone' });

        // The laptop tab is still foregrounded, so it never saw the supersede.
        // The listener starts a different book, or music, or just clicks stop.
        const result = await closeAudiobookSession({
            ...shared,
            bookPositionMs: 1_000_000,
            listenedMs: 5_000,
        });
        expect(result.superseded).toBe(true);

        const [state] = await sql<{ resume_position_ms: number }[]>`
            SELECT resume_position_ms
              FROM user_media_state
             WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid
        `;
        expect(state.resume_position_ms).toBe(3_600_000);
    });

    /**
     * `paused_at` is the staleness signal, but it is only stamped if the pause
     * heartbeat lands. That request is fire-and-forget with no retry, and the
     * periodic ping stops in the same breath — so one dropped request leaves the
     * row ACTIVE with a NULL `paused_at` and the whole defence disengaged.
     * `last_seen_at` answers the same question for that row: it is the last time
     * we heard anything at all from this session.
     */
    it('a close from a session that went silent without pausing asserts nothing', async () => {
        const first = await open();
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        const shared = {
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sourceId(first.payload.playbackSessionId),
            mediaId,
            deps,
        };
        await reportAudiobookProgress({ ...shared, bookPositionMs: 3_600_000, listenedMs: 60_000 });

        // Paused, but the heartbeat that would have said so never arrived.
        await sql`
            UPDATE play_sessions
               SET status = 'ACTIVE', paused_at = NULL,
                   last_seen_at = now() - INTERVAL '20 minutes'
             WHERE source_session_id = ${sourceId(first.payload.playbackSessionId)}
        `;

        await closeAudiobookSession({ ...shared, bookPositionMs: 3_600_000, listenedMs: 8_000 });

        expect(closedWith).toEqual([null]);
    });

    /**
     * And the same row, when it finally does say PAUSED: the transition is being
     * recorded twenty minutes late, so stamping `now()` would reset the clock on
     * a position that has been stale the whole time. The last moment we heard
     * from the session is the honest answer.
     */
    it('stamps paused_at from when the listener was last heard, not from the ping', async () => {
        const first = await open();
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        await sql`
            UPDATE play_sessions
               SET status = 'ACTIVE', paused_at = NULL,
                   last_seen_at = now() - INTERVAL '20 minutes'
             WHERE source_session_id = ${sourceId(first.payload.playbackSessionId)}
        `;

        await heartbeatAudiobookSession({
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sourceId(first.payload.playbackSessionId),
            mediaId,
            status: 'PAUSED',
            deps,
        });

        const [row] = await sql<{ age_seconds: number }[]>`
            SELECT EXTRACT(EPOCH FROM (now() - paused_at))::int AS age_seconds
              FROM play_sessions
             WHERE source_session_id = ${sourceId(first.payload.playbackSessionId)}
        `;
        expect(row.age_seconds).toBeGreaterThan(600);
    });

    /**
     * `user_media_state` is what every Lumastra surface reads for "where did I
     * leave off" — including the iOS player, which prefers it over the
     * AudiobookShelf position the session payload carries. Left to the 5-minute
     * watch-sync pull, picking a book up on another device right after pausing
     * resumes up to a whole pull cycle behind.
     */
    it('materializes the local resume mirror as the report lands, not a pull cycle later', async () => {
        const result = await open();
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        await reportAudiobookProgress({
            sql,
            userId: toUserId(userId),
            username,
            absSessionId: sourceId(result.payload.playbackSessionId),
            mediaId,
            bookPositionMs: 3_600_000,
            listenedMs: 60_000,
            deps,
        });

        const [state] = await sql<{ resume_position_ms: number; is_watched: boolean }[]>`
            SELECT resume_position_ms, is_watched
              FROM user_media_state
             WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid
        `;
        expect(state?.resume_position_ms).toBe(3_600_000);
        // A position is not a completion. Only ABS's own isFinished marks a book
        // read, and inventing one here would flap against the pull.
        expect(state.is_watched).toBe(false);
    });

    /**
     * Offline downloads (the Apple Watch fetches the files in a background URLSession for
     * hours or days). The session is a real `purpose = 'download'` row: it holds no stream
     * slot, sends no reports, lives as long as its grants and writes no position.
     */
    describe('offline download sessions', () => {
        const OTHER_NETWORK = '203.0.113.9';
        const HOUR = 60 * 60 * 1000;

        const openDownload = (overrides: Record<string, unknown> = {}) => {
            opened = absSession();
            return open({
                deviceId: 'device-phone',
                purpose: 'download',
                castTarget: true,
                ...overrides,
            });
        };
        const openPlayback = (overrides: Record<string, unknown> = {}) => {
            opened = absSession();
            return open({ deviceId: 'device-tv', ...overrides });
        };
        const rowOf = async (playbackSessionId: string) => {
            const [row] = await sql<
                { status: string; purpose: string; stop_reason: string | null }[]
            >`SELECT status, purpose, stop_reason FROM play_sessions WHERE id = ${playbackSessionId}::uuid`;
            return row;
        };
        const deleteSession = (id: string) =>
            cancellationDef.handlers.DELETE!(
                {
                    locals: {
                        user: { userId, username },
                        principal: {
                            kind: 'session',
                            userId,
                            username,
                            isAdmin: false,
                            scopes: ['media:write'],
                        },
                    },
                    params: { id },
                } as never,
                { surface: 'v1', input: { params: { id } } } as never,
            );
        const validate = (
            result: Extract<Awaited<ReturnType<typeof open>>, { ok: true }>,
            clientIp = OTHER_NETWORK,
        ) =>
            grants.validatePlaybackGrant(result.payload.streamToken, {
                clientIp,
                route: {
                    kind: 'audiobook',
                    mediaId,
                    playbackSessionId: result.payload.playbackSessionId,
                    audiobookSessionId: sourceId(result.payload.playbackSessionId),
                },
            });
        const policyAt = async (limit: number) => {
            await sql`
                INSERT INTO user_stream_policies (user_id, max_concurrent_streams, updated_at)
                VALUES (${username}, ${limit}, now())
                ON CONFLICT (user_id) DO UPDATE SET max_concurrent_streams = ${limit}
            `;
        };
        const eventCount = async (): Promise<number> => {
            const [row] = await sql<{ n: number }[]>`
                SELECT count(*)::int AS n FROM user_media_events
                 WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid`;
            return row.n;
        };
        const anotherBook = async (): Promise<string> => {
            const id = randomUUID();
            seededMediaIds.push(id);
            await sql`
                INSERT INTO media_items (id, title, media_type, status, has_files, is_dismissed)
                VALUES (${id}::uuid, 'Another Book', 'audiobook', 'active', true, false)`;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${id}::uuid, 'audiobookshelf', ${'abs-item-other-' + id.slice(0, 8)}, 'audiobook')`;
            return id;
        };

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('is stored as a download and never listed as playing', async () => {
            const download = await openDownload();
            expect(download.ok).toBe(true);
            if (!download.ok) return;

            expect((await rowOf(download.payload.playbackSessionId)).purpose).toBe('download');
            expect(await getActiveSessionsForUser(sql, toUserId(userId))).toEqual([]);
            // Admin Active Sessions, the live overlay and "listening now" all read this view.
            expect(await getActiveSessionsView(sql)).toEqual([]);
            expect(await getAllActiveSessionsWithMedia(sql)).toEqual([]);
        });

        it('does not block playback on a second device at one concurrent stream', async () => {
            await policyAt(1);
            const download = await openDownload();
            expect(download.ok).toBe(true);

            const tv = await openPlayback();
            expect(tv.ok).toBe(true);
            if (!download.ok || !tv.ok) return;
            expect((await rowOf(download.payload.playbackSessionId)).status).toBe('ACTIVE');
            expect((await rowOf(tv.payload.playbackSessionId)).status).toBe('ACTIVE');

            // The limit still bites for streams: a second stream is refused...
            const second = await openPlayback({
                deviceId: 'device-car',
                mediaId: await anotherBook(),
            });
            expect(second.ok).toBe(false);
            // ...and a download is admitted while the stream holds the only slot.
            const another = await openDownload({ deviceId: 'device-watch' });
            expect(another.ok).toBe(true);
        });

        it('survives stream-policy admission, 30 minutes of silence and a restart reap', async () => {
            await policyAt(1);
            const download = await openDownload();
            expect(download.ok).toBe(true);
            if (!download.ok) return;
            await sql`
                UPDATE play_sessions
                   SET last_seen_at = now() - INTERVAL '31 minutes',
                       last_heartbeat_at = now() - INTERVAL '31 minutes',
                       started_at = now() - INTERVAL '3 hours'
                 WHERE id = ${download.payload.playbackSessionId}::uuid`;
            await sql`UPDATE hls_playback_tokens SET last_used_at = now() - INTERVAL '31 minutes'
                       WHERE play_session_id = ${download.payload.playbackSessionId}`;

            // Starting any stream runs the reap inside admission.
            const tv = await openPlayback();
            expect(tv.ok).toBe(true);
            await sql.begin(async (tx) => {
                const policy = await enforceStreamPolicy(
                    tx as unknown as postgres.Sql,
                    toUserId(userId),
                    username,
                    '10.0.0.1',
                    'direct',
                );
                // The stream above holds the only slot; the download is not why.
                expect(policy).toEqual({ kind: 'stream_limit_exceeded', active: 1, limit: 1 });
            });
            await claimStaleSessions(sql);
            await claimStaleSessionsForUser(sql, userId);
            await claimBootOrphanSessions(sql, 0);

            const row = await rowOf(download.payload.playbackSessionId);
            expect(row.status).toBe('ACTIVE');
            expect('reason' in (await validate(download))).toBe(false);
        });

        it('grants a lifetime past six hours, even unpinned, and keeps it through a renewal', async () => {
            const download = await openDownload();
            const stream = await openPlayback({ castTarget: true });
            expect(download.ok && stream.ok).toBe(true);
            if (!download.ok || !stream.ok) return;

            const downloadTtl = download.grant.expiresAt.getTime() - Date.now();
            const streamTtl = stream.grant.expiresAt.getTime() - Date.now();
            expect(download.grant.ipPinned).toBe(false);
            expect(streamTtl).toBeLessThanOrEqual(6 * HOUR);
            expect(downloadTtl).toBeGreaterThan(7 * 24 * HOUR - 5 * 60 * 1000);
            expect(downloadTtl).toBeLessThanOrEqual(7 * 24 * HOUR);

            // Seven hours in: still accepted from another network.
            await sql`UPDATE hls_playback_tokens
                         SET created_at = created_at - INTERVAL '7 hours',
                             expires_at = expires_at - INTERVAL '7 hours'
                       WHERE id = ${download.grant.id}`;
            await sql`UPDATE play_sessions SET started_at = started_at - INTERVAL '7 hours'
                       WHERE id = ${download.payload.playbackSessionId}::uuid`;
            grants.invalidatePlaybackGrantCache();
            expect('reason' in (await validate(download))).toBe(false);

            // A renewal never shortens it to the 24 h audiobook ceiling.
            const [before] = await sql<{ expires_at: Date }[]>`
                SELECT expires_at FROM hls_playback_tokens WHERE id = ${download.grant.id}`;
            const renewed = await grants.renewPlaybackGrant(
                download.grant.id,
                userId,
                'v1',
                download.payload.streamToken,
            );
            expect(renewed).not.toBeNull();
            expect(renewed!.expiresAt.getTime()).toBeGreaterThanOrEqual(
                new Date(before.expires_at).getTime(),
            );
            // ...and never goes beyond seven days from the mint.
            expect(renewed!.expiresAt.getTime()).toBeLessThanOrEqual(
                renewed!.createdAt.getTime() + 7 * 24 * HOUR,
            );
        });

        it('stays bound to its book, its session and its audiobook routes', async () => {
            const download = await openDownload();
            if (!download.ok) throw new Error('open failed');
            const base = {
                clientIp: OTHER_NETWORK,
                route: {
                    kind: 'audiobook' as const,
                    mediaId,
                    playbackSessionId: download.payload.playbackSessionId,
                    audiobookSessionId: sourceId(download.payload.playbackSessionId),
                },
            };
            const secret = download.payload.streamToken;
            expect('reason' in (await grants.validatePlaybackGrant(secret, base))).toBe(false);
            expect(
                await grants.validatePlaybackGrant(secret, {
                    ...base,
                    route: { ...base.route, mediaId: randomUUID() },
                }),
            ).toMatchObject({ reason: 'wrong_scope' });
            expect(
                await grants.validatePlaybackGrant(secret, {
                    ...base,
                    route: { ...base.route, kind: 'music' as never },
                }),
            ).toMatchObject({ reason: 'wrong_scope' });
            expect(
                await grants.validatePlaybackGrant(secret, {
                    ...base,
                    route: { ...base.route, audiobookSessionId: 'someone-elses-session' },
                }),
            ).toMatchObject({ reason: 'wrong_scope' });
        });

        it('is rejected after DELETE and after its expiry', async () => {
            const gone = await openDownload();
            const expiring = await openDownload({ deviceId: 'device-watch' });
            if (!gone.ok || !expiring.ok) throw new Error('open failed');
            expect('reason' in (await validate(gone))).toBe(false);

            const response = await deleteSession(gone.payload.playbackSessionId);
            expect(response.status).toBe(204);
            expect(await validate(gone)).toMatchObject({ reason: 'session_ended' });
            expect((await rowOf(gone.payload.playbackSessionId)).status).toBe('KILLED');

            // Past its expiry the grant is refused, and the session goes with it.
            await sql`UPDATE hls_playback_tokens SET expires_at = now() - INTERVAL '1 second'
                       WHERE id = ${expiring.grant.id}`;
            await sql`UPDATE play_sessions SET started_at = now() - INTERVAL '3 minutes'
                       WHERE id = ${expiring.payload.playbackSessionId}::uuid`;
            grants.invalidatePlaybackGrantCache();
            expect(await validate(expiring)).toMatchObject({ reason: 'expired' });
            await claimStaleSessionsForUser(sql, userId);
            expect((await rowOf(expiring.payload.playbackSessionId)).status).toBe('CRASHED');
        });

        it('ends at the hard cap even if a grant outlived it', async () => {
            const download = await openDownload();
            if (!download.ok) throw new Error('open failed');
            await sql`UPDATE play_sessions SET started_at = now() - INTERVAL '8 days 2 hours'
                       WHERE id = ${download.payload.playbackSessionId}::uuid`;
            await claimStaleSessionsForUser(sql, userId);
            expect((await rowOf(download.payload.playbackSessionId)).status).toBe('CRASHED');
        });

        it('still applies the age rating on every byte request', async () => {
            const download = await openDownload();
            if (!download.ok) throw new Error('open failed');
            const bytes = () =>
                authenticateAudiobookStream({
                    sql,
                    token: download.payload.streamToken,
                    mediaId,
                    absSessionId: sourceId(download.payload.playbackSessionId),
                    clientIp: OTHER_NETWORK,
                    credentialDeps: deps.credentials,
                });
            expect((await bytes()).ok).toBe(true);

            // The account becomes age-restricted below the book's rating mid-download.
            await sql`UPDATE media_items SET age_rating = 16 WHERE id = ${mediaId}::uuid`;
            await sql`UPDATE users SET max_age_rating = 6, age_rating_pinned = true
                       WHERE id = ${userId}::uuid`;
            const denied = await bytes();
            expect(denied.ok).toBe(false);
            if (!denied.ok) expect(denied.status).toBe(404);

            // A disabled account is refused too.
            await sql`UPDATE users SET max_age_rating = NULL, age_rating_pinned = false,
                             disabled_at = now() WHERE id = ${userId}::uuid`;
            expect((await bytes()).ok).toBe(false);
        });

        it('writes no listening position on DELETE or on a report', async () => {
            const download = await openDownload();
            if (!download.ok) throw new Error('open failed');
            const sourceSession = sourceId(download.payload.playbackSessionId);
            const before = await eventCount();

            // A client that reports anyway: nothing reaches ABS or the local progress.
            const ack = await reportAudiobookProgress({
                sql,
                userId: toUserId(userId),
                username,
                absSessionId: sourceSession,
                mediaId,
                bookPositionMs: 20_000_000,
                listenedMs: 60_000,
                deps,
            });
            expect(ack.ok).toBe(true);
            expect(synced).toEqual([]);

            const response = await deleteSession(download.payload.playbackSessionId);
            expect(response.status).toBe(204);
            await retryPendingAudiobookSessionClose({
                sql,
                userId: toUserId(userId),
                username,
                absSessionId: sourceSession,
                deps,
            });

            expect(closed).toEqual([sourceSession]);
            expect(closedWith).toEqual([null]);
            expect(finished).toEqual([]);
            expect(deps.client.patchProgressAs).not.toHaveBeenCalled();
            expect(await eventCount()).toBe(before);
            const [state] = await sql<{ n: number }[]>`
                SELECT count(*)::int AS n FROM user_media_state
                 WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid`;
            expect(state.n).toBe(0);
            const [row] = await sql<{ position_ms: number }[]>`
                SELECT position_ms FROM play_sessions
                 WHERE id = ${download.payload.playbackSessionId}::uuid`;
            expect(Number(row.position_ms)).toBe(download.payload.startPositionMs);
        });

        it('a closing report on a download finishes nothing and moves nothing', async () => {
            const download = await openDownload();
            if (!download.ok) throw new Error('open failed');
            const before = await eventCount();

            await closeAudiobookSession({
                sql,
                userId: toUserId(userId),
                username,
                absSessionId: sourceId(download.payload.playbackSessionId),
                mediaId,
                bookPositionMs: 26_000_000,
                listenedMs: 3_600_000,
                isFinished: true,
                deps,
            });

            expect(closedWith).toEqual([null]);
            expect(finished).toEqual([]);
            expect(await eventCount()).toBe(before);
            expect((await rowOf(download.payload.playbackSessionId)).stop_reason).toBe(
                'user_stopped',
            );
        });

        it('is never completed by the reaper, whatever position it was opened at', async () => {
            opened = absSession({ startTime: 26_000, currentTime: 26_000 });
            const download = await open({
                deviceId: 'device-phone',
                purpose: 'download',
                castTarget: true,
            });
            if (!download.ok) throw new Error('open failed');
            await sql`UPDATE hls_playback_tokens SET expires_at = now() - INTERVAL '1 second'
                       WHERE id = ${download.grant.id}`;
            await sql`UPDATE play_sessions SET started_at = now() - INTERVAL '3 minutes'
                       WHERE id = ${download.payload.playbackSessionId}::uuid`;
            const { reapStaleSessions } = await import('./play-sessions.service.js');
            const before = await eventCount();
            const reaped = await reapStaleSessions(sql);
            expect(reaped.completed).toBe(0);
            expect(await eventCount()).toBe(before);
            expect((await rowOf(download.payload.playbackSessionId)).status).toBe('CRASHED');
        });

        it('re-issuing for the same book and device ends the old download like DELETE', async () => {
            const first = await openDownload();
            const second = await openDownload();
            if (!first.ok || !second.ok) throw new Error('open failed');

            const [live] = await sql<{ n: number }[]>`
                SELECT count(*)::int AS n FROM play_sessions
                 WHERE user_id = ${userId}::uuid AND purpose = 'download'
                   AND status IN ('ACTIVE', 'PAUSED')`;
            expect(live.n).toBe(1);
            const old = await rowOf(first.payload.playbackSessionId);
            expect(old).toMatchObject({ status: 'KILLED', stop_reason: 'superseded' });
            expect(await validate(first)).toMatchObject({ reason: 'session_ended' });
            expect('reason' in (await validate(second))).toBe(false);

            // Upstream close carries no position.
            const before = await eventCount();
            await retryPendingAudiobookSessionClose({
                sql,
                userId: toUserId(userId),
                username,
                absSessionId: sourceId(first.payload.playbackSessionId),
                deps,
            });
            expect(closed).toEqual([sourceId(first.payload.playbackSessionId)]);
            expect(closedWith).toEqual([null]);
            expect(await eventCount()).toBe(before);
        });

        it('keeps downloads of the same book on another device, and of other books', async () => {
            const phone = await openDownload();
            const watch = await openDownload({ deviceId: 'device-watch' });
            const other = await openDownload({ mediaId: await anotherBook() });
            if (!phone.ok || !watch.ok || !other.ok) throw new Error('open failed');
            for (const d of [phone, watch, other]) {
                expect((await rowOf(d.payload.playbackSessionId)).status).toBe('ACTIVE');
            }
        });

        it('re-issuing still works at the cap', async () => {
            vi.spyOn(config, 'DOWNLOAD_SESSIONS_MAX_PER_USER', 'get').mockReturnValue(2);
            const a = await openDownload();
            const b = await openDownload({ deviceId: 'device-watch' });
            expect(a.ok && b.ok).toBe(true);
            const again = await openDownload();
            expect(again.ok).toBe(true);
            // A different device is still refused at the cap.
            const third = await openDownload({ deviceId: 'device-ipad' });
            expect(third.ok).toBe(false);
        });

        it('caps the downloads a user can hold at once, with a clear error', async () => {
            vi.spyOn(config, 'DOWNLOAD_SESSIONS_MAX_PER_USER', 'get').mockReturnValue(2);
            const first = await openDownload();
            const second = await openDownload({ deviceId: 'device-watch' });
            expect(first.ok && second.ok).toBe(true);
            if (!first.ok || !second.ok) return;

            const third = await openDownload({ deviceId: 'device-ipad' });
            expect(third).toMatchObject({
                ok: false,
                kind: 'stream_policy',
                error: { kind: 'download_limit_exceeded', active: 2, limit: 2 },
            });
            // The upstream session opened for the refused download is closed again.
            expect(closed).toHaveLength(1);
            if (!third.ok && third.kind === 'stream_policy') {
                const response = playbackPolicyResponse(third.error);
                expect(response.status).toBe(422);
                expect(await response.json()).toMatchObject({
                    code: 'quota_exceeded',
                    details: { bucket: 'audiobook_downloads', limit: 2, used: 2 },
                });
            }

            // Streams are unaffected by the cap, and ending one download frees a place.
            expect((await openPlayback()).ok).toBe(true);
            await deleteSession(first.payload.playbackSessionId);
            expect((await openDownload({ deviceId: 'device-ipad' })).ok).toBe(true);
        });
    });
});
