// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/database/queries/play-sessions.queries.integration.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/user.fixtures.js';
import type { UserId } from '$lib/shared/user-id.js';
import {
    createPlaySession,
    getActiveSessionsForUser,
    updateHeartbeat,
    stopSession,
    killSession,
    getSessionById,
    getEffectivePolicy,
    upsertStreamPolicy,
    claimStaleSessions,
    getPendingStaleSessions,
    markStaleSessionProcessed,
    claimBootOrphanSessions,
    getAudiobookClosePayload,
    getRetryableAudiobookSessionCloses,
    recordStaleSessionAttempt,
    releaseAudiobookSessionClose,
    claimAudiobookSessionClose,
    MAX_REAP_ATTEMPTS,
    createMusicSession,
    updateMusicSession,
    countLiveSessionsAnnouncing,
    upsertExternalSession,
    getSessionBySourceKey,
    hasLivePlayerMusicSession,
} from './play-sessions.queries.js';

describe('Play Sessions Queries', () => {
    let sql: postgres.Sql;
    let testUserId: UserId;

    beforeAll(async () => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, ['play_sessions', 'user_stream_policies']);
        // Insert a media item to satisfy the FK constraint on play_sessions.media_id
        await sql`
            INSERT INTO media_items (id, title, media_type, status)
            VALUES ('00000000-0000-0000-0000-000000000001'::uuid, 'Test Movie', 'movie', 'active')
            ON CONFLICT (id) DO NOTHING
        `;
        // Ensure test user exists to satisfy FK constraint on play_sessions.user_id
        // (play_sessions.user_id is uuid REFERENCES users(id) since mig 16.46.0)
        testUserId = generateTestUserId('testuser');
        await ensureTestUser(sql, testUserId);
    });

    // =====================================================================
    // client_features (migration 16.247.0)
    //
    // Against real Postgres because every failure mode here is a Postgres
    // one: a bound array is not a text[] until the driver says so, and
    // `= ANY(NULL)` is NULL rather than false — neither shows up in a mock.
    // =====================================================================
    describe('client_features', () => {
        it('round-trips an announced feature list', async () => {
            const row = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-features',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
                client_features: ['admin_message', 'maintenance_notice'],
            });
            expect(row.client_features).toEqual(['admin_message', 'maintenance_notice']);

            const reread = await getSessionById(sql, row.id);
            expect(reread?.client_features).toEqual(['admin_message', 'maintenance_notice']);
        });

        it('stores NULL — not an empty array — when nothing was announced', async () => {
            // NULL ("no client ever told us") and [] ("the client announced an
            // empty list") are different facts. A DEFAULT '{}' or a bound `[]`
            // would erase the distinction permanently.
            const row = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-silent',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });
            expect(row.client_features).toBeNull();
        });

        it('stores {} — distinct from NULL — for a client that announced nothing', async () => {
            const row = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-empty',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
                client_features: [],
            });
            // Not null: the client DID answer, and the answer was "nothing".
            expect(row.client_features).toEqual([]);
        });

        it('keeps the stored list when a revive omits it', async () => {
            const id = '00000000-0000-0000-0000-0000000000f1';
            await createPlaySession(sql, {
                surface: 'web',
                id,
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-revive',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
                client_features: ['admin_message'],
            });
            // Same id again with no features → the ON CONFLICT COALESCE must
            // not blank the column out from under the admin surface.
            const revived = await createPlaySession(sql, {
                surface: 'web',
                id,
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-revive',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });
            expect(revived.client_features).toEqual(['admin_message']);
        });

        it('stores the list on a music session too', async () => {
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES ('00000000-0000-0000-0000-0000000000a1'::uuid, 'Test Track', 'track', 'active')
                ON CONFLICT (id) DO NOTHING
            `;
            const created = await createMusicSession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-0000000000a1',
                user_id: testUserId,
                device_id: 'device-music',
                ip_address: '127.0.0.1',
                client_features: ['admin_message'],
            });
            expect(created).not.toBeNull();
            const row = await getSessionById(sql, created!.id);
            expect(row?.client_features).toEqual(['admin_message']);
        });
    });

    describe('countLiveSessionsAnnouncing', () => {
        it('counts live sessions and how many announced the feature', async () => {
            const mk = async (device: string, features?: string[]) =>
                createPlaySession(sql, {
                    surface: 'web',
                    media_id: '00000000-0000-0000-0000-000000000001',
                    user_id: testUserId,
                    device_id: device,
                    ip_address: '127.0.0.1',
                    play_method: 'direct',
                    position_ms: 0,
                    ...(features ? { client_features: features } : {}),
                });

            await mk('d-yes-1', ['maintenance_notice']);
            await mk('d-yes-2', ['admin_message', 'maintenance_notice']);
            await mk('d-no-token', ['admin_message']);
            // NULL client_features: `'x' = ANY(NULL)` is NULL, not false, so a
            // COUNT FILTER without the COALESCE would silently skip this row
            // from the denominator's complement and the numbers would not add up.
            await mk('d-null');

            const stopped = await mk('d-stopped', ['maintenance_notice']);
            await stopSession(sql, stopped.id, 0, 'user_stop');

            const reach = await countLiveSessionsAnnouncing(sql, 'maintenance_notice');
            expect(reach).toEqual({ total: 4, supporting: 2 });
        });

        it('returns zeroes rather than NaN when nothing is live', async () => {
            expect(await countLiveSessionsAnnouncing(sql, 'maintenance_notice')).toEqual({
                total: 0,
                supporting: 0,
            });
        });
    });

    describe('createPlaySession', () => {
        it('creates a session and returns it with ACTIVE status', async () => {
            const result = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });
            expect(result.status).toBe('ACTIVE');
            expect(result.user_id).toBe(testUserId);
            expect(result.id).toBeTruthy();
        });

        it('revives a heartbeat-timed-out client-provided session id', async () => {
            const session = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });
            await sql`
                UPDATE play_sessions
                SET status = 'CRASHED',
                    stopped_at = now(),
                    stop_reason = 'heartbeat_timeout',
                    last_event_seq = 52
                WHERE id = ${session.id}
            `;

            const revived = await createPlaySession(sql, {
                surface: 'web',
                id: session.id,
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });

            expect(revived.status).toBe('ACTIVE');
            expect(revived.stopped_at).toBeNull();
            expect(revived.stop_reason).toBeNull();
            expect(Number(revived.last_event_seq)).toBe(0);
        });

        it('does NOT revive a KILLED session — mints a fresh row instead', async () => {
            const session = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });
            await killSession(sql, session.id, 'admin');

            // A stale client (e.g. an idle-keepalive tab left open) resends the
            // same client-persisted session_id after the kill.
            const resent = await createPlaySession(sql, {
                surface: 'web',
                id: session.id,
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });

            // The killed row stays killed...
            const killedRow = await getSessionById(sql, session.id);
            expect(killedRow?.status).toBe('KILLED');
            // ...and the caller gets a brand-new, active session instead of a
            // resurrected one.
            expect(resent.id).not.toBe(session.id);
            expect(resent.status).toBe('ACTIVE');
        });
    });

    describe('upsertExternalSession', () => {
        it('does NOT revive a KILLED external (jellyfin/subsonic) mirror row', async () => {
            const { row: created } = await upsertExternalSession(sql, {
                surface: 'subsonic',
                source: 'subsonic',
                source_session_id: 'subsonic-session-1',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'car-head-unit',
                status: 'ACTIVE',
                position_ms: 0,
            });
            await killSession(sql, created.id, 'admin');

            // The upstream (Subsonic) keeps streaming and the poller keeps
            // reporting the same source_session_id as still ACTIVE.
            const { row: reIngested, created: wasCreated } = await upsertExternalSession(sql, {
                surface: 'subsonic',
                source: 'subsonic',
                source_session_id: 'subsonic-session-1',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'car-head-unit',
                status: 'ACTIVE',
                position_ms: 5000,
            });

            expect(wasCreated).toBe(false);
            expect(reIngested.id).toBe(created.id);
            expect(reIngested.status).toBe('KILLED');
            const row = await getSessionBySourceKey(sql, 'subsonic', 'subsonic-session-1');
            expect(row?.status).toBe('KILLED');
        });
    });

    describe('claimStaleSessions — subsonic track-length-aware grace', () => {
        const SHORT_TRACK_ID = '00000000-0000-0000-0000-0000000000dd';

        beforeEach(async () => {
            // 3-minute track — grace should be 3 min + 1 min = 4 min.
            await sql`
                INSERT INTO media_items (id, title, media_type, status, runtime_seconds)
                VALUES (${SHORT_TRACK_ID}::uuid, 'Test Track', 'track', 'active', 180)
                ON CONFLICT (id) DO UPDATE SET runtime_seconds = 180
            `;
        });

        async function seedSubsonicSession(mediaId: string, sourceSessionId: string, idle: string) {
            const { row } = await upsertExternalSession(sql, {
                surface: 'subsonic',
                source: 'subsonic',
                source_session_id: sourceSessionId,
                media_id: mediaId,
                user_id: testUserId,
                device_id: 'car-head-unit',
                status: 'ACTIVE',
                position_ms: 0,
            });
            await sql`
                UPDATE play_sessions SET last_seen_at = now() - ${idle}::interval WHERE id = ${row.id}
            `;
            return row.id;
        }

        it('keeps a 3-minute track alive within its 4-minute grace', async () => {
            const id = await seedSubsonicSession(
                SHORT_TRACK_ID,
                'subsonic-short-1',
                '3 minutes 30 seconds',
            );

            await claimStaleSessions(sql);

            expect((await getSessionById(sql, id))?.status).toBe('ACTIVE');
        });

        it('reaps a 3-minute track once its 4-minute grace elapses', async () => {
            const id = await seedSubsonicSession(
                SHORT_TRACK_ID,
                'subsonic-short-2',
                '4 minutes 30 seconds',
            );

            await claimStaleSessions(sql);

            expect((await getSessionById(sql, id))?.status).toBe('CRASHED');
        });

        it('falls back to a flat 10 minutes when the track runtime is unknown', async () => {
            // '00000000-0000-0000-0000-000000000001' is the suite's default seed
            // media item — inserted without a runtime_seconds value (NULL).
            const id = await seedSubsonicSession(
                '00000000-0000-0000-0000-000000000001',
                'subsonic-unknown-1',
                '9 minutes',
            );

            await claimStaleSessions(sql);

            expect((await getSessionById(sql, id))?.status).toBe('ACTIVE');

            await sql`UPDATE play_sessions SET last_seen_at = now() - interval '11 minutes' WHERE id = ${id}`;
            await claimStaleSessions(sql);

            expect((await getSessionById(sql, id))?.status).toBe('CRASHED');
        });
    });

    describe('stopSession', () => {
        it('completes an ACTIVE session', async () => {
            const session = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });
            const stopped = await stopSession(sql, session.id, 5000, 'user');
            expect(stopped?.status).toBe('COMPLETED');
            expect(Number(stopped?.position_ms)).toBe(5000);
        });

        it('revives a CRASHED (heartbeat-timed-out) session to COMPLETED — mirrors updateHeartbeat revival', async () => {
            const session = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });
            await sql`
                UPDATE play_sessions
                SET status = 'CRASHED', stopped_at = now(), stop_reason = 'heartbeat_timeout'
                WHERE id = ${session.id}
            `;

            const stopped = await stopSession(sql, session.id, 1_400_000, 'completion');

            expect(stopped).not.toBeNull();
            expect(stopped?.status).toBe('COMPLETED');
            expect(stopped?.stop_reason).toBe('completion');
            expect(Number(stopped?.position_ms)).toBe(1_400_000);
        });

        it('does NOT revive a KILLED session (admin-terminated, not a reap)', async () => {
            const session = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });
            await killSession(sql, session.id, 'admin');

            const stopped = await stopSession(sql, session.id, 1_400_000, 'completion');

            expect(stopped).toBeNull();
            const row = await getSessionById(sql, session.id);
            expect(row?.status).toBe('KILLED');
        });

        it('is a no-op on an already-COMPLETED session (idempotent double-stop)', async () => {
            const session = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });
            const first = await stopSession(sql, session.id, 1_000_000, 'user');
            expect(first?.status).toBe('COMPLETED');

            const second = await stopSession(sql, session.id, 1_400_000, 'completion');
            expect(second).toBeNull();

            const row = await getSessionById(sql, session.id);
            expect(row?.stop_reason).toBe('user');
            expect(Number(row?.position_ms)).toBe(1_000_000);
        });
    });

    describe('getActiveSessionsForUser', () => {
        it('returns only active/paused sessions for user', async () => {
            await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });
            const sessions = await getActiveSessionsForUser(sql, testUserId);
            expect(sessions).toHaveLength(1);
        });

        it('excludes completed sessions', async () => {
            const session = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });
            await stopSession(sql, session.id, 0, 'user');
            const sessions = await getActiveSessionsForUser(sql, testUserId);
            expect(sessions).toHaveLength(0);
        });
    });

    describe('updateHeartbeat', () => {
        it('updates position and last_heartbeat_at', async () => {
            const session = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });
            await updateHeartbeat(sql, session.id, {
                position_ms: 5000,
                status: 'ACTIVE',
                event_seq: 1,
            });
            const updated = await getSessionById(sql, session.id);
            expect(Number(updated?.position_ms)).toBe(5000);
        });

        it('sets paused_at when transitioning to PAUSED', async () => {
            const session = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });
            await updateHeartbeat(sql, session.id, {
                position_ms: 1000,
                status: 'PAUSED',
                event_seq: 1,
            });
            const updated = await getSessionById(sql, session.id);
            expect(updated?.paused_at).toBeTruthy();
        });

        // A paused web tab keepalives every 30 s forever. If a PAUSED report
        // could revive the row the reaper just CRASHED, it would come back with
        // its ORIGINAL paused_at (the CASE only stamps paused_at when NULL), so
        // the next reap cycle crashes it again — a CRASHED↔PAUSED ping-pong that
        // keeps consuming a concurrent-stream slot indefinitely.
        it('a PAUSED heartbeat does not revive a CRASHED session', async () => {
            const session = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });
            await sql`
                UPDATE play_sessions
                SET status = 'CRASHED', paused_at = now() - INTERVAL '31 minutes'
                WHERE id = ${session.id}
            `;

            const revived = await updateHeartbeat(sql, session.id, {
                position_ms: 1000,
                status: 'PAUSED',
                event_seq: 5,
            });

            expect(revived).toBeNull();
            const after = await getSessionById(sql, session.id);
            expect(after?.status).toBe('CRASHED');
        });

        // The revive path exists for clients that resume after a heartbeat
        // timeout (container restart mid-playback, brief network loss). Both
        // report ACTIVE, so that case must keep working.
        it('an ACTIVE heartbeat still revives a CRASHED session and clears paused_at', async () => {
            const session = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });
            await sql`
                UPDATE play_sessions
                SET status = 'CRASHED', paused_at = now() - INTERVAL '31 minutes'
                WHERE id = ${session.id}
            `;

            const revived = await updateHeartbeat(sql, session.id, {
                position_ms: 2000,
                status: 'ACTIVE',
                event_seq: 5,
            });

            expect(revived).not.toBeNull();
            const after = await getSessionById(sql, session.id);
            expect(after?.status).toBe('ACTIVE');
            expect(after?.paused_at).toBeNull();
        });

        it('reap → PAUSED keepalive → reap leaves the row CRASHED (no ping-pong)', async () => {
            const session = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });
            // A tab paused overnight: paused_at well past the grace, heartbeat fresh.
            await sql`
                UPDATE play_sessions
                SET status = 'PAUSED',
                    paused_at = now() - INTERVAL '6 hours',
                    last_heartbeat_at = now()
                WHERE id = ${session.id}
            `;

            expect((await claimStaleSessions(sql)).map((row) => row.id)).toContain(session.id);
            await updateHeartbeat(sql, session.id, {
                position_ms: 1000,
                status: 'PAUSED',
                event_seq: 9,
            });
            expect((await getSessionById(sql, session.id))?.status).toBe('CRASHED');
            // Second cycle has nothing left to claim for this row.
            expect((await claimStaleSessions(sql)).map((row) => row.id)).not.toContain(session.id);
        });
    });

    describe('getEffectivePolicy', () => {
        // user_stream_policies.user_id is TEXT (intentional exception per mig 16.46.0)
        // so these tests legitimately use string values — no UUID needed here.
        it('returns default policy when no user-specific policy exists', async () => {
            await upsertStreamPolicy(sql, '__default__', { max_concurrent_streams: 2 }, 'system');
            const policy = await getEffectivePolicy(sql, 'newuser');
            expect(policy.max_concurrent_streams).toBe(2);
        });

        it('returns user-specific policy over default', async () => {
            await upsertStreamPolicy(sql, '__default__', { max_concurrent_streams: 2 }, 'system');
            await upsertStreamPolicy(sql, 'vip', { max_concurrent_streams: 5 }, 'admin');
            const policy = await getEffectivePolicy(sql, 'vip');
            expect(policy.max_concurrent_streams).toBe(5);
        });

        it('uses fallbackDefaults.max_concurrent_streams for the synthetic fallback when neither row exists', async () => {
            // No '__default__' or per-user row upserted — exercises the
            // in-module synthetic fallback (admin-configurable DEFAULT_MAX_CONCURRENT_STREAMS
            // is injected by the play-sessions.service wrapper in production).
            const policy = await getEffectivePolicy(sql, 'nobody', { max_concurrent_streams: 7 });
            expect(policy.max_concurrent_streams).toBe(7);
        });

        it('falls back to unlimited (-1) when neither a row nor fallbackDefaults are provided', async () => {
            const policy = await getEffectivePolicy(sql, 'nobody');
            expect(policy.max_concurrent_streams).toBe(-1);
        });
    });

    describe('killSession', () => {
        it('marks an active session as KILLED and sets stopped_at', async () => {
            const session = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });
            const killed = await killSession(sql, session.id, 'admin');
            expect(killed?.status).toBe('KILLED');
            expect(killed?.stopped_at).toBeTruthy();
            expect(killed?.stop_reason).toBe('admin:admin');
        });

        it('returns null for a non-existent session', async () => {
            const result = await killSession(sql, '00000000-0000-0000-0000-000000999999', 'admin');
            expect(result).toBeNull();
        });
    });

    describe('claimStaleSessions', () => {
        it('marks sessions with old heartbeats as CRASHED', async () => {
            const session = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });
            // Force heartbeat to 10 minutes ago
            await sql`
                UPDATE play_sessions
                SET last_heartbeat_at = now() - interval '10 minutes'
                WHERE id = ${session.id}
            `;
            const count = (await claimStaleSessions(sql)).length;
            expect(count).toBe(1);
            const updated = await getSessionById(sql, session.id);
            expect(updated?.status).toBe('CRASHED');
        });

        // The 30-minute PAUSED grace exists so a paused MOVIE survives a coffee break.
        // A live channel cannot be meaningfully paused, so a paused tvchannel row is an
        // abandoned tuner — it must fall back to the 5-minute ACTIVE window instead.
        // Before this was fixed, an abandoned Live TV session sat in the admin "active
        // streams" list for 30 minutes after the stream-proxy had already reaped its
        // encoders, and looked like an occupied slot on capped upstream providers.
        describe('paused-session grace by media type', () => {
            const LIVE_CHANNEL_ID = '00000000-0000-0000-0000-0000000000cc';

            async function seedPausedSession(mediaId: string, idle: string) {
                const session = await createPlaySession(sql, {
                    surface: 'web',
                    media_id: mediaId,
                    user_id: testUserId,
                    device_id: 'device-paused',
                    ip_address: '127.0.0.1',
                    play_method: 'direct',
                    position_ms: 0,
                });
                await sql`
                    UPDATE play_sessions
                    SET status = 'PAUSED',
                        paused_at = now() - ${idle}::interval,
                        last_heartbeat_at = now() - ${idle}::interval
                    WHERE id = ${session.id}
                `;
                return session.id;
            }

            beforeEach(async () => {
                await sql`
                    INSERT INTO media_items (id, title, media_type, status)
                    VALUES (${LIVE_CHANNEL_ID}::uuid, 'Test Channel', 'tvchannel', 'active')
                    ON CONFLICT (id) DO NOTHING
                `;
            });

            it('reaps a paused LIVE channel after the 5-minute window', async () => {
                const id = await seedPausedSession(LIVE_CHANNEL_ID, '10 minutes');

                await claimStaleSessions(sql);

                expect((await getSessionById(sql, id))?.status).toBe('CRASHED');
            });

            it('still grants a paused MOVIE the full 30-minute grace', async () => {
                // Same idle time as the live-channel case above — only the media type
                // differs, so a regression that drops the CASE would fail here.
                const id = await seedPausedSession(
                    '00000000-0000-0000-0000-000000000001',
                    '10 minutes',
                );

                await claimStaleSessions(sql);

                expect((await getSessionById(sql, id))?.status).toBe('PAUSED');
            });

            it('reaps a paused MOVIE once it passes 30 minutes', async () => {
                const id = await seedPausedSession(
                    '00000000-0000-0000-0000-000000000001',
                    '31 minutes',
                );

                await claimStaleSessions(sql);

                expect((await getSessionById(sql, id))?.status).toBe('CRASHED');
            });

            it('reaps a paused MOVIE past 30 min even with a fresh last_heartbeat_at from the idle keepalive', async () => {
                // Reproduces the reported bug: a tab left open on a paused player
                // sends a 30s idle keepalive that refreshes last_heartbeat_at
                // forever, while paused_at (set once, on the ACTIVE→PAUSED
                // transition) correctly stays old. Grace must be measured from
                // paused_at, or a paused-and-abandoned session never expires.
                const session = await createPlaySession(sql, {
                    surface: 'web',
                    media_id: '00000000-0000-0000-0000-000000000001',
                    user_id: testUserId,
                    device_id: 'device-keepalive',
                    ip_address: '127.0.0.1',
                    play_method: 'direct',
                    position_ms: 0,
                });
                await sql`
                    UPDATE play_sessions
                    SET status = 'PAUSED',
                        paused_at = now() - interval '31 minutes',
                        last_heartbeat_at = now() - interval '10 seconds'
                    WHERE id = ${session.id}
                `;

                await claimStaleSessions(sql);

                expect((await getSessionById(sql, session.id))?.status).toBe('CRASHED');
            });

            // Prod: an audiobook paused overnight with the tab open squatted on
            // the listener's concurrent-stream slot indefinitely — the player's
            // 10s heartbeat kept refreshing last_seen_at forever, and the
            // audiobookshelf branch measured its grace from last_seen_at rather
            // than paused_at (unlike every other paused source above). Mirrors
            // the Lumastra keepalive case: paused_at stays fixed at the pause
            // moment even while last_seen_at keeps moving.
            it('reaps a paused audiobook past 30 min even with a fresh last_seen_at', async () => {
                const session = await createPlaySession(sql, {
                    surface: 'web',
                    media_id: '00000000-0000-0000-0000-000000000001',
                    user_id: testUserId,
                    device_id: 'device-audiobook',
                    ip_address: '127.0.0.1',
                    play_method: 'direct',
                    position_ms: 0,
                });
                await sql`
                    UPDATE play_sessions
                    SET status = 'PAUSED',
                        source = 'audiobookshelf',
                        source_session_id = 'abs-sess-stale',
                        paused_at = now() - INTERVAL '31 minutes',
                        last_seen_at = now() - INTERVAL '5 seconds'
                    WHERE id = ${session.id}
                `;

                await claimStaleSessions(sql);

                expect((await getSessionById(sql, session.id))?.status).toBe('CRASHED');
            });

            it('still grants a paused audiobook the full 30-minute grace', async () => {
                const session = await createPlaySession(sql, {
                    surface: 'web',
                    media_id: '00000000-0000-0000-0000-000000000001',
                    user_id: testUserId,
                    device_id: 'device-audiobook-fresh',
                    ip_address: '127.0.0.1',
                    play_method: 'direct',
                    position_ms: 0,
                });
                await sql`
                    UPDATE play_sessions
                    SET status = 'PAUSED',
                        source = 'audiobookshelf',
                        source_session_id = 'abs-sess-fresh',
                        paused_at = now() - INTERVAL '10 minutes',
                        last_seen_at = now() - INTERVAL '10 minutes'
                    WHERE id = ${session.id}
                `;

                await claimStaleSessions(sql);

                expect((await getSessionById(sql, session.id))?.status).toBe('PAUSED');
            });

            // An ACTIVE (still playing) audiobook is unaffected by the paused_at
            // switch — it keeps measuring from last_seen_at, over 5 minutes: a
            // playing client reports every 15-20 s, so that much silence is a
            // killed app. It was 30 minutes, and a force-quit Apple TV app held
            // the listener's stream slot for all of it.
            it('reaps a still-ACTIVE audiobook silent for more than 5 minutes', async () => {
                const session = await createPlaySession(sql, {
                    surface: 'web',
                    media_id: '00000000-0000-0000-0000-000000000001',
                    user_id: testUserId,
                    device_id: 'device-audiobook-active',
                    ip_address: '127.0.0.1',
                    play_method: 'direct',
                    position_ms: 0,
                });
                await sql`
                    UPDATE play_sessions
                    SET status = 'ACTIVE',
                        source = 'audiobookshelf',
                        source_session_id = 'abs-sess-active',
                        last_seen_at = now() - INTERVAL '6 minutes'
                    WHERE id = ${session.id}
                `;

                await claimStaleSessions(sql);

                expect((await getSessionById(sql, session.id))?.status).toBe('CRASHED');
            });

            it('keeps an ACTIVE audiobook that was heard from within 5 minutes', async () => {
                const session = await createPlaySession(sql, {
                    surface: 'web',
                    media_id: '00000000-0000-0000-0000-000000000001',
                    user_id: testUserId,
                    device_id: 'device-audiobook-active-fresh',
                    ip_address: '127.0.0.1',
                    play_method: 'direct',
                    position_ms: 0,
                });
                await sql`
                    UPDATE play_sessions
                    SET status = 'ACTIVE',
                        source = 'audiobookshelf',
                        source_session_id = 'abs-sess-active-fresh',
                        last_seen_at = now() - INTERVAL '4 minutes'
                    WHERE id = ${session.id}
                `;

                await claimStaleSessions(sql);

                expect((await getSessionById(sql, session.id))?.status).toBe('ACTIVE');
            });
        });

        it('claims only rows that are still stale at the atomic update', async () => {
            const session = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });
            await sql`
                UPDATE play_sessions
                SET last_heartbeat_at = now() - interval '10 minutes'
                WHERE id = ${session.id}
            `;

            // Models a heartbeat landing after an earlier stale snapshot but
            // before the reaper's destructive claim.
            await sql`
                UPDATE play_sessions
                SET last_heartbeat_at = now(), last_seen_at = now()
                WHERE id = ${session.id}
            `;

            const claimed = await claimStaleSessions(sql);
            expect(claimed).toEqual([]);
            expect((await getSessionById(sql, session.id))?.status).toBe('ACTIVE');
        });

        it('keeps a claimed row pending across reaper process interruption', async () => {
            const session = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });
            await sql`
                UPDATE play_sessions
                SET last_heartbeat_at = now() - interval '10 minutes'
                WHERE id = ${session.id}
            `;

            expect(await claimStaleSessions(sql)).toHaveLength(1);
            expect(await claimStaleSessions(sql)).toHaveLength(0);
            expect((await getPendingStaleSessions(sql)).map((row) => row.id)).toContain(session.id);

            await markStaleSessionProcessed(sql, session.id);
            expect(await getPendingStaleSessions(sql)).toEqual([]);
        });
    });

    describe('reap claim bounding + upstream stamp', () => {
        const ABS_BOOK_ID = '00000000-0000-0000-0000-0000000000b1';

        async function seedAudiobookSession(absSessionId: string) {
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${ABS_BOOK_ID}::uuid, 'Test Book', 'audiobook', 'active')
                ON CONFLICT (id) DO NOTHING
            `;
            const session = await createPlaySession(sql, {
                surface: 'web',
                media_id: ABS_BOOK_ID,
                user_id: testUserId,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 120_000,
            });
            await sql`
                UPDATE play_sessions
                SET source = 'audiobookshelf',
                    source_session_id = ${absSessionId},
                    runtime_ms = 3_600_000
                WHERE id = ${session.id}
            `;
            return session.id;
        }

        /**
         * The regression: a restart used to crash the row WITHOUT this stamp,
         * so no retry path could ever find it to close the ABS session.
         */
        it('claimBootOrphanSessions stamps the audiobook close payload', async () => {
            const sessionId = await seedAudiobookSession('abs-boot-1');

            const claimed = await claimBootOrphanSessions(sql, 0);

            expect(claimed.map((row) => row.id)).toContain(sessionId);
            const row = await getSessionById(sql, sessionId);
            expect(row?.status).toBe('CRASHED');
            expect(row?.stop_reason).toBe('server_restart');
            const payload = getAudiobookClosePayload(row!);
            expect(payload).toMatchObject({
                state: 'pending',
                positionMs: 120_000,
                runtimeMs: 3_600_000,
                isFinished: false,
            });
            // And it is now visible to BOTH retry paths.
            expect((await getPendingStaleSessions(sql)).map((r) => r.id)).toContain(sessionId);
            expect((await getRetryableAudiobookSessionCloses(sql)).map((r) => r.id)).toContain(
                sessionId,
            );
        });

        /**
         * The same regression on the kill path: a killed audiobook row (admin
         * kick, or a listener freeing their own stuck slot) never closed its
         * ABS session, because nothing stamped the close payload.
         */
        it('killSession stamps a position-less audiobook close', async () => {
            const sessionId = await seedAudiobookSession('abs-kill-1');

            const killed = await killSession(sql, sessionId, 'listener');

            expect(killed?.status).toBe('KILLED');
            const payload = getAudiobookClosePayload((await getSessionById(sql, sessionId))!);
            expect(payload).toMatchObject({ state: 'pending', syncPosition: false });
            expect((await getRetryableAudiobookSessionCloses(sql)).map((r) => r.id)).toContain(
                sessionId,
            );
        });

        it('killSession leaves a non-audiobook payload alone', async () => {
            const session = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-kill-plain',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });

            await killSession(sql, session.id, 'admin');

            const row = await getSessionById(sql, session.id);
            expect(row?.external_payload ?? null).toBeNull();
        });

        it('retires a stale claim after MAX_REAP_ATTEMPTS instead of retrying forever', async () => {
            const session = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });
            await sql`
                UPDATE play_sessions
                SET last_heartbeat_at = now() - interval '10 minutes'
                WHERE id = ${session.id}
            `;
            await claimStaleSessions(sql);

            for (let i = 1; i < MAX_REAP_ATTEMPTS; i++) {
                expect(await recordStaleSessionAttempt(sql, session.id)).toBe(false);
                expect((await getPendingStaleSessions(sql)).map((r) => r.id)).toContain(session.id);
            }

            expect(await recordStaleSessionAttempt(sql, session.id)).toBe(true);
            expect(await getPendingStaleSessions(sql)).toEqual([]);
            // Retiring is terminal — a further attempt must not resurrect it.
            expect(await recordStaleSessionAttempt(sql, session.id)).toBe(false);
        });

        it('retires an audiobook close after MAX_REAP_ATTEMPTS and remembers the upstream close', async () => {
            const sessionId = await seedAudiobookSession('abs-give-up');
            await claimBootOrphanSessions(sql, 0);

            for (let i = 1; i < MAX_REAP_ATTEMPTS; i++) {
                const claimed = await claimAudiobookSessionClose(sql, 'abs-give-up', `claim-${i}`);
                expect(claimed).not.toBeNull();
                // First attempt reports that closeSessionAs already landed; the
                // flag must survive every later release so a retry never
                // re-closes an already-closed upstream session.
                const retired = await releaseAudiobookSessionClose(
                    sql,
                    'abs-give-up',
                    `claim-${i}`,
                    {
                        upstreamClosed: i === 1,
                    },
                );
                expect(retired).toBe(false);
                const row = await getSessionById(sql, sessionId);
                expect(getAudiobookClosePayload(row!)?.upstreamClosed).toBe(true);
            }

            const last = await claimAudiobookSessionClose(sql, 'abs-give-up', 'claim-final');
            expect(last).not.toBeNull();
            expect(await releaseAudiobookSessionClose(sql, 'abs-give-up', 'claim-final')).toBe(
                true,
            );

            expect(await getRetryableAudiobookSessionCloses(sql)).toEqual([]);
            expect(getAudiobookClosePayload((await getSessionById(sql, sessionId))!)?.state).toBe(
                'failed',
            );
        });
    });

    describe('createMusicSession (source format capture)', () => {
        const TRACK_ID = '00000000-0000-0000-0000-0000000000a1';
        const FILE_ID = '00000000-0000-0000-0000-0000000000f1';

        // The outer beforeEach truncates only play_sessions, so the seeded
        // track/file must be torn down here or the fixed ids collide.
        beforeEach(async () => {
            await sql`DELETE FROM media_files WHERE id = ${FILE_ID}::uuid`;
            await sql`DELETE FROM media_items WHERE id = ${TRACK_ID}::uuid`;
        });

        async function seedTrack(opts: {
            container: string;
            totalBitrate: number;
            codec: string;
            streamBitrate: number | null;
        }) {
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${TRACK_ID}::uuid, 'Test Track', 'track', 'active')
                ON CONFLICT (id) DO NOTHING
            `;
            await sql`
                INSERT INTO media_files (id, file_path, container_format, total_bitrate)
                VALUES (${FILE_ID}::uuid, '/music/test-track.audio',
                        ${opts.container}, ${opts.totalBitrate})
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${FILE_ID}::uuid, ${TRACK_ID}::uuid, true)
            `;
            await sql`
                INSERT INTO media_streams (file_id, stream_type, stream_index, codec, bitrate, is_default)
                VALUES (${FILE_ID}::uuid, 'audio', 0, ${opts.codec}, ${opts.streamBitrate}, true)
            `;
        }

        async function startAndRead() {
            const created = await createMusicSession(sql, {
                surface: 'web',
                media_id: TRACK_ID,
                user_id: testUserId,
                device_id: 'music-device',
                ip_address: '127.0.0.1',
            });
            expect(created).not.toBeNull();
            const [row] = await sql<
                {
                    file_id: string | null;
                    container: string | null;
                    audio_codec: string | null;
                    bitrate_kbps: number | null;
                }[]
            >`
                SELECT file_id, container, audio_codec, bitrate_kbps
                FROM play_sessions WHERE id = ${created!.id}
            `;
            return row;
        }

        it('records the lossy codec and its own stream bitrate', async () => {
            await seedTrack({
                container: 'mp3',
                totalBitrate: 325_939,
                codec: 'mp3',
                streamBitrate: 320_000,
            });

            const row = await startAndRead();
            expect(row.file_id).toBe(FILE_ID);
            expect(row.container).toBe('mp3');
            expect(row.audio_codec).toBe('mp3');
            expect(row.bitrate_kbps).toBe(320);
        });

        it('falls back to the file bitrate for lossless streams that report none', async () => {
            // FLAC/ALAC carry no per-stream bitrate — without the fallback the
            // session would record a codec but no figure at all.
            await seedTrack({
                container: 'flac',
                totalBitrate: 1_128_606,
                codec: 'flac',
                streamBitrate: null,
            });

            const row = await startAndRead();
            expect(row.audio_codec).toBe('flac');
            expect(row.bitrate_kbps).toBe(1128);
        });

        it('still creates the session when the track has no probed file', async () => {
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${TRACK_ID}::uuid, 'Unprobed Track', 'track', 'active')
                ON CONFLICT (id) DO NOTHING
            `;

            const row = await startAndRead();
            expect(row.file_id).toBeNull();
            expect(row.audio_codec).toBeNull();
            expect(row.bitrate_kbps).toBeNull();
        });
    });

    describe('updateMusicSession (music heartbeat)', () => {
        async function freshMusicSession() {
            const created = await createMusicSession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'music-device',
                ip_address: '127.0.0.1',
            });
            expect(created).not.toBeNull();
            return created!.id;
        }

        it('sets paused_at on PAUSED so the reaper applies the 30-min grace, not the 5-min active window', async () => {
            const id = await freshMusicSession();

            // Client pauses → a single PAUSED heartbeat fires, then the client
            // sends no more heartbeats while paused.
            const ok = await updateMusicSession(sql, id, testUserId, 30_000, 'PAUSED');
            expect(ok).toBe(true);

            const paused = await getSessionById(sql, id);
            expect(paused?.status).toBe('PAUSED');
            expect(paused?.paused_at).toBeTruthy();

            // User walked away ~10 minutes while paused (no heartbeats).
            await sql`
                UPDATE play_sessions
                SET last_heartbeat_at = now() - interval '10 minutes',
                    paused_at         = now() - interval '10 minutes'
                WHERE id = ${id}
            `;

            // The reaper must NOT crash it — paused sessions get 30 min.
            const crashed = (await claimStaleSessions(sql)).length;
            expect(crashed).toBe(0);
            const after = await getSessionById(sql, id);
            expect(after?.status).toBe('PAUSED');
        });

        it('clears paused_at on resume (ACTIVE)', async () => {
            const id = await freshMusicSession();
            await updateMusicSession(sql, id, testUserId, 30_000, 'PAUSED');
            await updateMusicSession(sql, id, testUserId, 31_000, 'ACTIVE');
            const resumed = await getSessionById(sql, id);
            expect(resumed?.status).toBe('ACTIVE');
            expect(resumed?.paused_at).toBeNull();
        });

        it('revives a CRASHED (heartbeat-timed-out) music session on the next heartbeat — no player-killing 404', async () => {
            const id = await freshMusicSession();
            // The reaper (or a server restart) flipped a still-buffered paused
            // session to CRASHED while the user was away or briefly offline.
            await sql`
                UPDATE play_sessions
                SET status = 'CRASHED', stopped_at = now(), stop_reason = 'heartbeat_timeout'
                WHERE id = ${id}
            `;

            // Resume/reconnect heartbeat: previously returned false → route 404 →
            // the miniplayer was torn down. Now it revives the row.
            const ok = await updateMusicSession(sql, id, testUserId, 45_000, 'ACTIVE');
            expect(ok).toBe(true);

            const revived = await getSessionById(sql, id);
            expect(revived?.status).toBe('ACTIVE');
            expect(revived?.stopped_at).toBeNull();
            expect(revived?.stop_reason).toBeNull();
            expect(Number(revived?.position_ms)).toBe(45_000);
        });

        it('does NOT touch a non-music (video) session even for the owner (surface isolation)', async () => {
            // A video session for the same user, on the same device id, that the
            // reaper crashed. The music PUT surface must not revive it — the GET
            // path already scopes to client_name='Lumastra Music' for this reason.
            const video = await createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: 'music-device',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
                client_name: 'Lumastra',
            });
            await sql`
                UPDATE play_sessions
                SET status = 'CRASHED', stopped_at = now(), stop_reason = 'heartbeat_timeout'
                WHERE id = ${video.id}
            `;

            const ok = await updateMusicSession(sql, video.id, testUserId, 45_000, 'ACTIVE');
            expect(ok).toBe(false);
            const row = await getSessionById(sql, video.id);
            expect(row?.status).toBe('CRASHED');
        });

        it('createMusicSession closes a prior CRASHED session on the same device (no revivable orphan)', async () => {
            const first = await freshMusicSession();
            // First session reaped while the user was away.
            await sql`
                UPDATE play_sessions
                SET status = 'CRASHED', stopped_at = now(), stop_reason = 'heartbeat_timeout'
                WHERE id = ${first}
            `;

            // User starts a new track on the same device.
            const second = await freshMusicSession();
            expect(second).not.toBe(first);

            // The old CRASHED row must be closed so a late/in-flight heartbeat for
            // it can't revive it into a second live row competing with the new one.
            const old = await getSessionById(sql, first);
            expect(old?.status).toBe('COMPLETED');
        });

        // The stream route's transcode row for OUR player's fetch (iOS
        // preload): the very first fetch of a listen can land before the
        // player session exists, and must not stay up as a second stream.
        async function transcodeRow(surface: 'native_app' | 'web' | 'unknown' | 'third_party_api') {
            const { row } = await upsertExternalSession(sql, {
                source: 'music',
                surface,
                source_session_id: `${testUserId}:${surface}`,
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: testUserId,
                device_id: `music-${testUserId}`,
                client_name: 'Subsonic',
                status: 'ACTIVE',
                position_ms: 0,
                play_method: 'audio_transcode',
            });
            return row.id;
        }

        it('createMusicSession closes the leftover transcode rows of our player but keeps third-party ones', async () => {
            const ours = await transcodeRow('native_app');
            const viaToken = await transcodeRow('unknown');
            const thirdParty = await transcodeRow('third_party_api');
            // A reaped one must close too, or a later upsert could revive it.
            const legacy = await transcodeRow('web');
            await sql`UPDATE play_sessions SET status = 'CRASHED' WHERE id = ${legacy}`;

            await freshMusicSession();

            expect((await getSessionById(sql, legacy))?.status).toBe('COMPLETED');

            expect((await getSessionById(sql, ours))?.status).toBe('COMPLETED');
            expect((await getSessionById(sql, ours))?.stop_reason).toBe('superseded');
            expect((await getSessionById(sql, viaToken))?.status).toBe('COMPLETED');
            expect((await getSessionById(sql, thirdParty))?.status).toBe('ACTIVE');
        });

        it('hasLivePlayerMusicSession: true only for a live, recently heartbeating player row', async () => {
            expect(await hasLivePlayerMusicSession(sql, testUserId)).toBe(false);

            // A transcode row is not a player session.
            await transcodeRow('native_app');
            expect(await hasLivePlayerMusicSession(sql, testUserId)).toBe(false);

            const id = await freshMusicSession();
            expect(await hasLivePlayerMusicSession(sql, testUserId)).toBe(true);

            await updateMusicSession(sql, id, testUserId, 1_000, 'PAUSED');
            expect(await hasLivePlayerMusicSession(sql, testUserId)).toBe(true);

            await sql`
                UPDATE play_sessions SET last_heartbeat_at = now() - interval '6 minutes'
                WHERE id = ${id}
            `;
            expect(await hasLivePlayerMusicSession(sql, testUserId)).toBe(false);

            await sql`UPDATE play_sessions SET last_heartbeat_at = now() WHERE id = ${id}`;
            await updateMusicSession(sql, id, testUserId, 2_000, 'COMPLETED');
            expect(await hasLivePlayerMusicSession(sql, testUserId)).toBe(false);
        });

        it('does NOT revive a KILLED music session (admin / stream-limit kill stays terminal)', async () => {
            const id = await freshMusicSession();
            await sql`
                UPDATE play_sessions
                SET status = 'KILLED', stopped_at = now(), stop_reason = 'admin:admin'
                WHERE id = ${id}
            `;

            const ok = await updateMusicSession(sql, id, testUserId, 45_000, 'ACTIVE');
            expect(ok).toBe(false);
            const row = await getSessionById(sql, id);
            expect(row?.status).toBe('KILLED');
        });
    });

    describe('claimBootOrphanSessions', () => {
        async function freshSession(uid: UserId) {
            return createPlaySession(sql, {
                surface: 'web',
                media_id: '00000000-0000-0000-0000-000000000001',
                user_id: uid,
                device_id: 'device-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
            });
        }

        it('single-node (graceSeconds=0): crashes every active session regardless of heartbeat age', async () => {
            const session = await freshSession(testUserId);
            const count = (await claimBootOrphanSessions(sql, 0)).length;
            expect(count).toBe(1);
            const updated = await getSessionById(sql, session.id);
            expect(updated?.status).toBe('CRASHED');
            expect(updated?.stop_reason).toBe('server_restart');
        });

        it('multi-replica (graceSeconds>0): leaves sessions a sibling is still heartbeating', async () => {
            // Recent heartbeat = still live on another replica during a rolling deploy.
            const live = await freshSession(testUserId);
            await sql`
                UPDATE play_sessions
                SET last_heartbeat_at = now()
                WHERE id = ${live.id}
            `;
            const count = (await claimBootOrphanSessions(sql, 90)).length;
            expect(count).toBe(0);
            const updated = await getSessionById(sql, live.id);
            expect(updated?.status).toBe('ACTIVE');
        });

        it('multi-replica (graceSeconds>0): still crashes sessions with no recent heartbeat', async () => {
            const stale = await freshSession(testUserId);
            await sql`
                UPDATE play_sessions
                SET last_heartbeat_at = now() - interval '5 minutes',
                    last_seen_at = now() - interval '5 minutes'
                WHERE id = ${stale.id}
            `;
            const count = (await claimBootOrphanSessions(sql, 90)).length;
            expect(count).toBe(1);
            const updated = await getSessionById(sql, stale.id);
            expect(updated?.status).toBe('CRASHED');
        });

        it('multi-replica: uses the most recent of last_heartbeat_at / last_seen_at', async () => {
            // Stale heartbeat but a fresh poll signal (external source) → still live.
            const session = await freshSession(testUserId);
            await sql`
                UPDATE play_sessions
                SET last_heartbeat_at = now() - interval '5 minutes',
                    last_seen_at = now()
                WHERE id = ${session.id}
            `;
            const count = (await claimBootOrphanSessions(sql, 90)).length;
            expect(count).toBe(0);
            const updated = await getSessionById(sql, session.id);
            expect(updated?.status).toBe('ACTIVE');
        });
    });
});
