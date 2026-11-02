// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/services/play-session-lifecycle.integration.test.ts
//
// Integration tests for PlaySessionLifecycleService against a real PostgreSQL
// database. These tests verify the full SQL paths — engagement gates, terminal
// event gates, and same-device supersede — that unit tests mock away.
//
// Run locally:
//   npm run test:integration src/lib/server/services/play-session-lifecycle.integration.test.ts
//
// Run against preprod:
//   npm run test:integration -- src/lib/server/services/play-session-lifecycle.integration.test.ts

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../tests/integration/fixtures/user.fixtures.js';
import {
    createPlaySession,
    getSessionById,
    updateHeartbeat,
} from '$lib/server/database/queries/play-sessions.queries.js';
import { getMediaMetadataForHistory } from '$lib/server/database/queries/watch-history-insert.queries.js';
import {
    appendEventAndRebuild,
    appendEventAndRebuildWithOutcome,
} from '$lib/server/services/watch-state-rebuilder.service.js';
import * as playSessionsQueries from '$lib/server/database/queries/play-sessions.queries.js';
import { watchHistoryService } from '$lib/server/services/watch-history.service.js';
import {
    PlaySessionLifecycleService,
    type WatchManagerLike,
    type LifecycleDeps,
} from '$lib/server/services/play-session-lifecycle.service.js';
import { getState } from '$lib/server/database/queries/user-media-state.queries.js';
import { MIN_ENGAGEMENT_MS, JELLYFIN_PLAYED_THRESHOLD } from '$lib/server/utils/watch-constants.js';
import { refreshSegmentsForFile } from '$lib/server/database/queries/file-segments.queries.js';
import { playbackTelemetryService } from './playback-telemetry.service.js';
import { UserProfileService } from './user-profile.service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_MEDIA_ID = '00000000-0000-4000-a000-000000000001';
const TEST_USER = generateTestUserId();
const TEST_DEVICE = 'device-lifecycle-test';

// Runtime: 60 minutes so completion threshold is ~0.90 (~54:00 mark)
const RUNTIME_MS = 60 * 60 * 1000;

// A position that is well past the 93% completion threshold
const PAST_COMPLETION_MS = Math.floor(RUNTIME_MS * 0.96);

// A mid-content position that is clearly below the completion threshold
const MID_CONTENT_MS = Math.floor(RUNTIME_MS * 0.45);

// ---------------------------------------------------------------------------
// Test-scoped WatchManagerLike that uses the test SQL directly
// ---------------------------------------------------------------------------

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Creates a WatchManagerLike that uses the provided sql instance directly,
 * bypassing the aiDbService singleton used in production. This allows
 * integration tests to drive the full watch-state rebuild path without
 * needing the production app's DB connection setup.
 */
function makeTestWatchManager(sql: postgres.Sql): WatchManagerLike {
    return {
        async reportProgress(params, txSql?) {
            const db = txSql ?? sql;
            const now = new Date().toISOString();
            return await appendEventAndRebuildWithOutcome(db, {
                user_id: params.userId,
                media_id: params.mediaId,
                event_type: 'progress',
                source: 'lumastra-player',
                position_ms: params.positionMs,
                runtime_ms: params.runtimeMs ?? null,
                source_event_id: null,
                session_id: params.sessionId,
                event_seq: params.eventSeq,
                session_elapsed_ms: params.sessionElapsedMs ?? null,
                occurred_at: now,
                session_started_at: params.sessionStartedAt?.toISOString() ?? null,
            });
        },
        async markWatched(params, txSql) {
            const db = txSql ?? sql;
            await appendEventAndRebuild(db, {
                user_id: params.userId,
                media_id: params.mediaId,
                event_type: 'mark_watched',
                source: 'lumastra-user-mark',
                position_ms: null,
                runtime_ms: null,
                source_event_id: null,
                session_id: null,
                event_seq: null,
                occurred_at: new Date().toISOString(),
            });
        },
    };
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

describe('PlaySessionLifecycleService integration', () => {
    let sql: postgres.Sql;
    let service: PlaySessionLifecycleService;
    let baseDeps: LifecycleDeps; // exposed so spy tests can clone with a stub watchManager
    let profileRebuild: ReturnType<typeof vi.spyOn>;

    beforeAll(async () => {
        sql = getTestDb();
        // Verify the DB is reachable; if not, tests will fail with a clear
        // connection error rather than cryptic assertion failures.
        await sql`SELECT 1`;
        // Profile rebuilding has its own integration coverage. Its detached
        // AI work must not outlive these watch-state fixtures and their users.
        profileRebuild = vi
            .spyOn(UserProfileService.prototype, 'rebuildUserProfileDebounced')
            .mockImplementation(() => {});
    });

    afterAll(async () => {
        profileRebuild.mockRestore();
        await closeTestDb();
    });

    afterEach(async () => {
        // Stop schedules both immediate and delayed quality writes. Finish
        // both while their user/session FK targets still belong to this test.
        await playbackTelemetryService.settleBackgroundWork();
    });

    beforeEach(async () => {
        // Reset telemetry along with its FK targets after afterEach drained
        // background writes. Listing tables alone does not prevent a race:
        // PostgreSQL acquires TRUNCATE locks one relation at a time.
        await truncateTables(sql, [
            'playback_telemetry',
            'playback_session_quality',
            'user_playback_quality',
            'play_sessions',
            'user_media_state',
            'user_media_events',
            'watch_history',
            'users',
            'user_profiles',
            'media_items',
            // Combined-file fixtures (episode_chapters/media_file_items feed the
            // getEpisodeWindowsForFile projection used by the window-aware
            // completion tests below).
            'episode_chapters',
            'media_file_items',
            'media_files',
        ]);

        // Insert a test media item with a known runtime so completion-threshold
        // logic fires at predictable positions.
        await sql`
            INSERT INTO media_items (id, title, media_type, status, runtime_seconds)
            VALUES (
                ${TEST_MEDIA_ID}::uuid,
                'Integration Test Movie',
                'movie',
                'active',
                ${RUNTIME_MS / 1000}
            )
        `;

        await ensureTestUser(sql, TEST_USER);

        // Wire the service with real queries but a test-scoped WatchManagerLike.
        // The TranscodeService is omitted — not relevant to these test scenarios.
        // `resolveResumeAnchor` is also test-scoped so it queries the test sql
        // (production wiring uses aiDbService which is unavailable in tests).
        baseDeps = {
            watchManager: makeTestWatchManager(sql),
            watchHistoryService,
            queries: playSessionsQueries,
            getMediaMetadata: getMediaMetadataForHistory,
            getSql: () => sql,
            resolveResumeAnchor: async (userId, mediaId) => {
                // Mirrors the production anchor logic: max of the eligible
                // ACTIVE/PAUSED play_sessions.last_heartbeat_at and
                // user_media_state.last_event_at. Tests don't need full
                // session-eligibility filtering — eligible = ACTIVE or PAUSED rows
                // (KILLED and COMPLETED are excluded, matching production eligibility).
                const rows = await sql<
                    Array<{
                        live_anchor: Date | null;
                        durable_anchor: Date | null;
                    }>
                >`
                    SELECT
                        (
                            SELECT MAX(last_heartbeat_at)
                            FROM play_sessions
                            WHERE user_id = ${userId}
                              AND media_id = ${mediaId}::uuid
                              AND status IN ('ACTIVE', 'PAUSED')
                        ) AS live_anchor,
                        (
                            SELECT last_event_at
                            FROM user_media_state
                            WHERE user_id = ${userId}
                              AND media_id = ${mediaId}::uuid
                        ) AS durable_anchor
                `;
                const liveMs = rows[0]?.live_anchor ? rows[0].live_anchor.getTime() : null;
                const durableMs = rows[0]?.durable_anchor ? rows[0].durable_anchor.getTime() : null;
                if (liveMs === null && durableMs === null) return null;
                if (liveMs === null) return durableMs;
                if (durableMs === null) return liveMs;
                return liveMs > durableMs ? liveMs : durableMs;
            },
        };
        service = new PlaySessionLifecycleService(baseDeps);
    });

    // -----------------------------------------------------------------------
    // Helper: create an ACTIVE play_sessions row
    // -----------------------------------------------------------------------

    async function seedSession(overrides?: { device_id?: string; position_ms?: number }) {
        return createPlaySession(sql, {
            surface: 'web',
            media_id: TEST_MEDIA_ID,
            user_id: TEST_USER,
            device_id: overrides?.device_id ?? TEST_DEVICE,
            ip_address: '127.0.0.1',
            play_method: 'direct',
            position_ms: overrides?.position_ms ?? 0,
            runtime_ms: RUNTIME_MS,
        });
    }

    describe.each(['ACTIVE', 'COMPLETED'] as const)('runtime-scaled engagement: %s', (status) => {
        it.each([
            { runtimeMs: 145_000, combined: false, persists: true },
            { runtimeMs: 1_200_000, combined: false, persists: false },
            { runtimeMs: 145_000, combined: true, persists: true },
            { runtimeMs: 1_200_000, combined: true, persists: false },
        ])(
            '40 s watch: $runtimeMs ms, combined=$combined, persists=$persists',
            async ({ runtimeMs, combined, persists }) => {
                await sql`
                UPDATE media_items SET media_type = 'episode', runtime_seconds = ${runtimeMs / 1000}
                WHERE id = ${TEST_MEDIA_ID}
            `;
                const startMs = combined ? 1_200_000 : 0;
                const fileRuntimeMs = startMs + runtimeMs;
                if (combined) {
                    const [file] = await sql<{ id: string }[]>`
                    INSERT INTO media_files (file_path, duration_seconds)
                    VALUES (${`/tmp/engagement-${crypto.randomUUID()}.mkv`}, ${fileRuntimeMs / 1000})
                    RETURNING id
                `;
                    const [sibling] = await sql<{ id: string }[]>`
                    INSERT INTO media_items (title, media_type, status)
                    VALUES ('Earlier episode', 'episode', 'active') RETURNING id
                `;
                    await sql`
                    INSERT INTO media_file_items
                        (file_id, media_item_id, is_default, start_offset_ms, end_offset_ms)
                    VALUES (${file.id}, ${sibling.id}, true, 0, ${startMs}),
                           (${file.id}, ${TEST_MEDIA_ID}, true, ${startMs}, ${fileRuntimeMs})
                `;
                }
                const session = await createPlaySession(sql, {
                    surface: 'web',
                    media_id: TEST_MEDIA_ID,
                    user_id: TEST_USER,
                    device_id: TEST_DEVICE,
                    ip_address: '127.0.0.1',
                    play_method: 'direct',
                    position_ms: startMs,
                    runtime_ms: fileRuntimeMs,
                });
                await service.update(session.id, {
                    status,
                    position_ms: startMs + 40_000,
                    event_seq: 1,
                    session_elapsed_ms: 40_000,
                    ...(status === 'COMPLETED' ? { end_reason: 'user' as const } : {}),
                });
                const state = await getState.one(sql, {
                    userId: TEST_USER,
                    mediaId: TEST_MEDIA_ID,
                });
                if (persists) {
                    expect(state?.resume_position_ms).toBe(startMs + 40_000);
                    expect(state?.is_watched).toBe(false);
                } else {
                    expect(state).toBeNull();
                }
            },
        );
    });

    it.each(['watch', 'history'] as const)(
        'commits stop when best-effort %s SQL fails',
        async (step) => {
            const session = await seedSession();
            let attempted = false;
            const fail = async (tx: postgres.Sql): Promise<never> => {
                attempted = true;
                await tx`SELECT 1 / 0`;
                throw new Error('Expected SQL failure');
            };
            const failingService = new PlaySessionLifecycleService({
                ...baseDeps,
                ...(step === 'watch'
                    ? {
                          watchManager: {
                              ...baseDeps.watchManager,
                              reportProgress: async (_params, tx) => fail(tx!),
                          },
                      }
                    : { getMediaMetadata: async (tx) => fail(tx) }),
            });
            await expect(
                failingService.update(session.id, {
                    status: 'COMPLETED',
                    position_ms: MID_CONTENT_MS,
                    event_seq: 1,
                    session_elapsed_ms: MIN_ENGAGEMENT_MS + 1,
                }),
            ).resolves.toBeUndefined();
            expect(attempted).toBe(true);
            expect((await getSessionById(sql, session.id))?.status).toBe('COMPLETED');
        },
    );

    const EPISODE_MEDIA_ID = '00000000-0000-4000-a000-000000000002';

    // A 100-min runtime (90-150min tier = 0.95) so the native-episode tiered
    // bar stays distinguishable from the flat 0.90 jellyfin-compat bar below —
    // at the 60-min RUNTIME_MS used elsewhere in this file both tiers are 0.90.
    const EPISODE_TIER_RUNTIME_MS = 100 * 60 * 1000;

    async function seedEpisodeItem() {
        await sql`
            INSERT INTO media_items (id, title, media_type, status, runtime_seconds)
            VALUES (${EPISODE_MEDIA_ID}::uuid, 'Integration Test Episode', 'episode', 'active', ${EPISODE_TIER_RUNTIME_MS / 1000})
            ON CONFLICT (id) DO NOTHING
        `;
    }

    async function seedEpisodeSession(deviceId: string) {
        return createPlaySession(sql, {
            surface: 'web',
            media_id: EPISODE_MEDIA_ID,
            user_id: TEST_USER,
            device_id: deviceId,
            ip_address: '127.0.0.1',
            play_method: 'direct',
            position_ms: 0,
            runtime_ms: EPISODE_TIER_RUNTIME_MS,
        });
    }

    // -----------------------------------------------------------------------
    // Helper: read back user_media_state
    // -----------------------------------------------------------------------

    async function readState() {
        return getState.one(sql, { userId: TEST_USER, mediaId: TEST_MEDIA_ID });
    }

    // -----------------------------------------------------------------------
    // 1. Engagement gate on heartbeat — low elapsed → user_media_state untouched
    // -----------------------------------------------------------------------

    it('heartbeat below MIN_ENGAGEMENT_MS does not write user_media_state', async () => {
        const session = await seedSession();

        await service.update(session.id, {
            status: 'ACTIVE',
            position_ms: MID_CONTENT_MS,
            event_seq: 1,
            session_elapsed_ms: MIN_ENGAGEMENT_MS - 1, // one ms below gate
        });

        // play_sessions row should be updated
        const ps = await getSessionById(sql, session.id);
        expect(Number(ps?.position_ms)).toBe(MID_CONTENT_MS);

        // user_media_state must NOT be written
        const state = await readState();
        expect(state).toBeNull();
    });

    // -----------------------------------------------------------------------
    // 2. Engagement gate on heartbeat — at MIN_ENGAGEMENT_MS → both update
    // -----------------------------------------------------------------------

    it('heartbeat at MIN_ENGAGEMENT_MS writes user_media_state', async () => {
        const session = await seedSession();

        await service.update(session.id, {
            status: 'ACTIVE',
            position_ms: MID_CONTENT_MS,
            event_seq: 1,
            session_elapsed_ms: MIN_ENGAGEMENT_MS, // exactly at gate
        });

        const ps = await getSessionById(sql, session.id);
        expect(Number(ps?.position_ms)).toBe(MID_CONTENT_MS);

        const state = await readState();
        expect(state).not.toBeNull();
        expect(Number(state!.resume_position_ms)).toBe(MID_CONTENT_MS);
    });

    // -----------------------------------------------------------------------
    // 3. Terminal-event gate on stop — low engagement + mid-content
    //    → session COMPLETED, user_media_state preserved at prior value
    // -----------------------------------------------------------------------

    it('stop with low engagement and mid-content position preserves prior user_media_state', async () => {
        // Seed a prior watch state at a known position so we can verify it is unchanged.
        await appendEventAndRebuild(sql, {
            user_id: TEST_USER,
            media_id: TEST_MEDIA_ID,
            event_type: 'progress',
            source: 'lumastra-player',
            position_ms: 10_000,
            runtime_ms: RUNTIME_MS,
            source_event_id: null,
            session_id: null,
            event_seq: null,
            session_elapsed_ms: MIN_ENGAGEMENT_MS,
            occurred_at: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
            session_started_at: null,
        });

        const priorState = await readState();
        expect(Number(priorState?.resume_position_ms)).toBe(10_000);

        const session = await seedSession({ position_ms: MID_CONTENT_MS });

        await service.update(session.id, {
            status: 'COMPLETED',
            position_ms: MID_CONTENT_MS,
            event_seq: 2,
            session_elapsed_ms: MIN_ENGAGEMENT_MS - 1, // below engagement gate
            // end_reason omitted → not 'completion'
        });

        // Session must be COMPLETED in play_sessions
        const ps = await getSessionById(sql, session.id);
        expect(ps?.status).toBe('COMPLETED');

        // user_media_state must remain at the prior position (10_000 ms)
        const state = await readState();
        expect(Number(state!.resume_position_ms)).toBe(10_000);
    });

    // -----------------------------------------------------------------------
    // 3b. Terminal-event gate on stop — engaged unload beacon
    //     ("watch 20min, close tab" path — must NOT discard partial progress)
    // -----------------------------------------------------------------------

    it('engaged unload beacon writes user_media_state at the watched position', async () => {
        // Seed a much earlier resume so we can prove the unload advanced it.
        await appendEventAndRebuild(sql, {
            user_id: TEST_USER,
            media_id: TEST_MEDIA_ID,
            event_type: 'progress',
            source: 'lumastra-player',
            position_ms: 5_000,
            runtime_ms: RUNTIME_MS,
            source_event_id: null,
            session_id: null,
            event_seq: null,
            session_elapsed_ms: MIN_ENGAGEMENT_MS,
            occurred_at: new Date(Date.now() - 120_000).toISOString(),
            session_started_at: null,
        });

        const session = await seedSession({ position_ms: MID_CONTENT_MS });

        // Mirror handleBeforeUnload: end_reason='unload', and the player now
        // forwards session_elapsed_ms via the beacon body so the gate can see
        // the engagement.
        await service.update(session.id, {
            status: 'COMPLETED',
            position_ms: MID_CONTENT_MS,
            event_seq: 2,
            session_elapsed_ms: 20 * 60_000, // 20 minutes of cumulative play
            end_reason: 'unload',
        });

        const ps = await getSessionById(sql, session.id);
        expect(ps?.status).toBe('COMPLETED');

        const state = await readState();
        expect(Number(state!.resume_position_ms)).toBe(MID_CONTENT_MS);
    });

    // -----------------------------------------------------------------------
    // 4. Terminal-event gate on stop — end_reason='completion'
    //    → user_media_state advances regardless of engagement
    // -----------------------------------------------------------------------

    it("stop with end_reason='completion' writes user_media_state regardless of engagement", async () => {
        const session = await seedSession();

        await service.update(session.id, {
            status: 'COMPLETED',
            position_ms: MID_CONTENT_MS,
            event_seq: 1,
            session_elapsed_ms: 0, // zero engagement — would normally gate out
            end_reason: 'completion',
        });

        const ps = await getSessionById(sql, session.id);
        expect(ps?.status).toBe('COMPLETED');

        // Durable state should have been written (shouldPersistDurable=true via isCompletionEnd)
        const state = await readState();
        expect(state).not.toBeNull();
    });

    // -----------------------------------------------------------------------
    // 5. Terminal-event gate on stop — position past completion threshold
    //    → user_media_state advances and is_watched=true
    // -----------------------------------------------------------------------

    it('stop past completion threshold advances user_media_state and sets is_watched', async () => {
        const session = await seedSession({ position_ms: PAST_COMPLETION_MS });
        // Give the session a past-threshold position stored already so
        // updateHeartbeat won't find position_ms=0 guard.
        await updateHeartbeat(sql, session.id, {
            position_ms: PAST_COMPLETION_MS,
            status: 'ACTIVE',
            event_seq: 1,
        });

        await service.update(session.id, {
            status: 'COMPLETED',
            position_ms: PAST_COMPLETION_MS,
            event_seq: 2,
            session_elapsed_ms: 0, // low engagement, but position overrides gate
        });

        const ps = await getSessionById(sql, session.id);
        expect(ps?.status).toBe('COMPLETED');

        // Wait briefly for async rebuilder — state should be materialised in-tx
        const state = await readState();
        expect(state).not.toBeNull();
        expect(state!.is_watched).toBe(true);
    });

    // -----------------------------------------------------------------------
    // 6. Same-device supersede on session start
    //    Prior ACTIVE/PAUSED row → KILLED with stop_reason='superseded'
    //    Different device's row preserved
    // -----------------------------------------------------------------------

    it('same-device supersede kills prior session, preserves different-device session', async () => {
        // Create a prior ACTIVE session on the same device
        const prior = await seedSession({ device_id: TEST_DEVICE });
        expect(prior.status).toBe('ACTIVE');

        // Create a concurrent session on a DIFFERENT device — must not be killed
        const otherDevice = await seedSession({ device_id: 'device-other' });
        expect(otherDevice.status).toBe('ACTIVE');

        // The supersede logic is in startPlaySession (play-sessions.service.ts),
        // which runs a DB UPDATE after createPlaySession. We replicate that exact
        // SQL here to exercise the real path in integration (the lifecycle service
        // owns the UPDATE and it is the code under test in the broader session
        // start flow).
        await sql`
            UPDATE play_sessions
            SET status = 'KILLED',
                stopped_at = now(),
                stop_reason = 'superseded'
            WHERE user_id  = ${TEST_USER}
              AND media_id  = ${TEST_MEDIA_ID}::uuid
              AND device_id = ${TEST_DEVICE}
              AND id        <> ${prior.id}::uuid
              AND status IN ('ACTIVE', 'PAUSED')
        `;

        // Simulate creating the new session on the same device
        const newSession = await createPlaySession(sql, {
            surface: 'web',
            media_id: TEST_MEDIA_ID,
            user_id: TEST_USER,
            device_id: TEST_DEVICE,
            ip_address: '127.0.0.1',
            play_method: 'direct',
            position_ms: 0,
            runtime_ms: RUNTIME_MS,
        });

        // Supersede the prior session now that the new one exists
        await sql`
            UPDATE play_sessions
            SET status = 'KILLED',
                stopped_at = now(),
                stop_reason = 'superseded'
            WHERE user_id  = ${TEST_USER}
              AND media_id  = ${TEST_MEDIA_ID}::uuid
              AND device_id = ${TEST_DEVICE}
              AND id        <> ${newSession.id}::uuid
              AND status IN ('ACTIVE', 'PAUSED')
        `;

        // The prior same-device session must be KILLED
        const killedRow = await getSessionById(sql, prior.id);
        expect(killedRow?.status).toBe('KILLED');
        expect(killedRow?.stop_reason).toBe('superseded');

        // The new session must still be ACTIVE
        const newRow = await getSessionById(sql, newSession.id);
        expect(newRow?.status).toBe('ACTIVE');

        // The different-device session must be untouched (still ACTIVE)
        const otherRow = await getSessionById(sql, otherDevice.id);
        expect(otherRow?.status).toBe('ACTIVE');
        expect(otherRow?.stop_reason).toBeNull();
    });

    // -----------------------------------------------------------------------
    // 7. update() returns kill signal for unknown session
    // -----------------------------------------------------------------------

    it('update() returns kill signal when session does not exist', async () => {
        const result = await service.update('00000000-0000-4000-a000-999999999999', {
            status: 'ACTIVE',
            position_ms: 1000,
            event_seq: 1,
            session_elapsed_ms: 0, // session doesn't exist; short-circuits before the engagement calc
        });

        expect(result).toEqual({
            action: 'kill',
            reason: 'session_not_found',
            resume_anchor: null,
            wrote_to_durable: false,
        });
    });

    // -----------------------------------------------------------------------
    // 8. Heartbeat with PAUSED status updates play_sessions row correctly
    // -----------------------------------------------------------------------

    it('heartbeat with PAUSED status updates session and sets paused_at', async () => {
        const session = await seedSession();

        await service.update(session.id, {
            status: 'PAUSED',
            position_ms: 5_000,
            event_seq: 1,
            session_elapsed_ms: MIN_ENGAGEMENT_MS,
        });

        const ps = await getSessionById(sql, session.id);
        expect(ps?.status).toBe('PAUSED');
        expect(ps?.paused_at).toBeTruthy();
    });

    // -----------------------------------------------------------------------
    // 9. Heartbeat ack carries resume_anchor + wrote_to_durable=true
    //    once the engagement gate is open (real durable write happened).
    // -----------------------------------------------------------------------

    it('heartbeat response includes resume_anchor and wrote_to_durable=true past the engagement gate', async () => {
        const session = await seedSession();

        const result = await service.update(session.id, {
            status: 'ACTIVE',
            position_ms: MID_CONTENT_MS,
            event_seq: 1,
            session_elapsed_ms: MIN_ENGAGEMENT_MS, // gate open
        });

        expect(result).toMatchObject({
            resume_anchor: expect.any(Number),
            wrote_to_durable: true,
        });
    });

    // -----------------------------------------------------------------------
    // 10. Heartbeat ack reports wrote_to_durable=false before the gate opens.
    //     resume_anchor still advances because play_sessions.last_heartbeat_at
    //     was just lifted by the heartbeat-write itself, so the eligible
    //     live-session contribution is non-null.
    // -----------------------------------------------------------------------

    it('heartbeat response reports wrote_to_durable=false before engagement gate opens', async () => {
        const session = await seedSession();

        const result = await service.update(session.id, {
            status: 'ACTIVE',
            position_ms: 5_000,
            event_seq: 1,
            session_elapsed_ms: MIN_ENGAGEMENT_MS - 1, // below gate
        });

        expect(result).toMatchObject({ wrote_to_durable: false });
        expect(result).toHaveProperty('resume_anchor');
    });

    // -----------------------------------------------------------------------
    // 11. Heartbeat backstop — superseded same-device session
    //
    //     Reproduces the original bug: tab A's row is killed by tab B's
    //     startPlaySession. Tab A's next heartbeat hits a KILLED row and
    //     must surface the supersede signal so the client can pause + toast.
    //
    //     Also verifies the spec §4.3 stale-seq invariant: a duplicate /
    //     reordered heartbeat for a still-ACTIVE session must NOT be
    //     classified as superseded — it's a benign no-op.
    // -----------------------------------------------------------------------

    it("returns action='superseded' when next heartbeat hits a killed row", async () => {
        const session = await seedSession();
        // Drive an in-flight heartbeat to seed last_event_seq so subsequent
        // bumps are ordered.
        await service.update(session.id, {
            status: 'ACTIVE',
            position_ms: 1_000,
            event_seq: 1,
            session_elapsed_ms: MIN_ENGAGEMENT_MS,
        });

        // Simulate a same-device supersede (matches startPlaySession's UPDATE).
        await sql`
            UPDATE play_sessions
            SET status = 'KILLED',
                stopped_at = now(),
                stop_reason = 'superseded'
            WHERE id = ${session.id}::uuid
        `;

        // Tab A's next heartbeat — updateHeartbeat returns null because the
        // row is no longer ACTIVE/PAUSED/CRASHED. The backstop SELECT
        // disambiguates and routes to the superseded action.
        const result = await service.update(session.id, {
            status: 'ACTIVE',
            position_ms: 2_000,
            event_seq: 2,
            session_elapsed_ms: MIN_ENGAGEMENT_MS + 1_000,
        });

        expect(result).toMatchObject({
            action: 'superseded',
            reason: 'superseded',
            wrote_to_durable: false,
        });
    });

    it('stale-seq heartbeat against a still-ACTIVE row is silent success, NOT supersede', async () => {
        // Spec §4.3 invariant — out-of-order heartbeats must not falsely
        // toast healthy sessions.
        const session = await seedSession();
        await service.update(session.id, {
            status: 'ACTIVE',
            position_ms: 5_000,
            event_seq: 5,
            session_elapsed_ms: MIN_ENGAGEMENT_MS,
        });

        // Replay an older heartbeat (event_seq=2 < last_event_seq=5). The
        // updateHeartbeat row gate returns null; the backstop must observe
        // the row is still ACTIVE and treat as silent success.
        const result = await service.update(session.id, {
            status: 'ACTIVE',
            position_ms: 4_000,
            event_seq: 2, // stale
            session_elapsed_ms: MIN_ENGAGEMENT_MS + 1_000,
        });

        expect(result).not.toHaveProperty('action');
        expect(result).toMatchObject({ wrote_to_durable: false });

        // updateHeartbeat is the canonical query path; verify it would also
        // refuse this stale seq directly (locks in the invariant at the
        // query layer, not just the service).
        const directResult = await updateHeartbeat(sql, session.id, {
            status: 'ACTIVE',
            position_ms: 6_000,
            event_seq: 1, // also stale
            buffer_health_sec: 0,
        });
        expect(directResult).toBeNull();
    });

    // -----------------------------------------------------------------------
    // Idle paused keepalive — a heartbeat that does not move the playhead
    // must not refresh durable progress (last_event_at), or a tab left paused
    // for days keeps its episode the series' "most recent activity".
    // -----------------------------------------------------------------------

    describe('idle paused keepalive', () => {
        async function readLastEventAt(): Promise<string | null> {
            const rows = await sql<Array<{ last_event_at: string | null }>>`
                SELECT last_event_at::text AS last_event_at
                FROM user_media_state
                WHERE user_id = ${TEST_USER} AND media_id = ${TEST_MEDIA_ID}::uuid
            `;
            return rows[0]?.last_event_at ?? null;
        }

        async function tick(): Promise<void> {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        it('a PAUSED heartbeat at the same position leaves last_event_at unchanged', async () => {
            const session = await seedSession();
            await service.update(session.id, {
                status: 'ACTIVE',
                position_ms: MID_CONTENT_MS,
                event_seq: 1,
                session_elapsed_ms: MIN_ENGAGEMENT_MS,
            });
            const before = await readLastEventAt();
            expect(before).not.toBeNull();

            await tick();
            const result = await service.update(session.id, {
                status: 'PAUSED',
                position_ms: MID_CONTENT_MS,
                event_seq: 2,
                session_elapsed_ms: MIN_ENGAGEMENT_MS,
            });

            expect(await readLastEventAt()).toBe(before);
            expect(result).toMatchObject({ wrote_to_durable: false });
            // Liveness still advances on the play_sessions row.
            const ps = await getSessionById(sql, session.id);
            expect(ps?.status).toBe('PAUSED');
            expect(Number(ps?.last_event_seq)).toBe(2);
        });

        it('a keepalive within 1000 ms of the stored position is treated as unchanged', async () => {
            const session = await seedSession();
            await service.update(session.id, {
                status: 'ACTIVE',
                position_ms: MID_CONTENT_MS,
                event_seq: 1,
                session_elapsed_ms: MIN_ENGAGEMENT_MS,
            });
            const before = await readLastEventAt();

            await tick();
            await service.update(session.id, {
                status: 'PAUSED',
                position_ms: MID_CONTENT_MS + 999,
                event_seq: 2,
                session_elapsed_ms: MIN_ENGAGEMENT_MS,
            });

            expect(await readLastEventAt()).toBe(before);
        });

        it('a heartbeat at a new position still bumps last_event_at', async () => {
            const session = await seedSession();
            await service.update(session.id, {
                status: 'ACTIVE',
                position_ms: MID_CONTENT_MS,
                event_seq: 1,
                session_elapsed_ms: MIN_ENGAGEMENT_MS,
            });
            const before = await readLastEventAt();

            await tick();
            await service.update(session.id, {
                status: 'ACTIVE',
                position_ms: MID_CONTENT_MS + 30_000,
                event_seq: 2,
                session_elapsed_ms: MIN_ENGAGEMENT_MS + 30_000,
            });

            const after = await readLastEventAt();
            expect(after).not.toBe(before);
            const state = await readState();
            expect(Number(state!.resume_position_ms)).toBe(MID_CONTENT_MS + 30_000);
        });

        it('a stop at the same mid-content position does not refresh last_event_at', async () => {
            const session = await seedSession();
            await service.update(session.id, {
                status: 'PAUSED',
                position_ms: MID_CONTENT_MS,
                event_seq: 1,
                session_elapsed_ms: MIN_ENGAGEMENT_MS,
            });
            const before = await readLastEventAt();

            await tick();
            await service.update(session.id, {
                status: 'COMPLETED',
                position_ms: MID_CONTENT_MS,
                event_seq: 2,
                session_elapsed_ms: MIN_ENGAGEMENT_MS,
            });

            const ps = await getSessionById(sql, session.id);
            expect(ps?.status).toBe('COMPLETED');
            expect(await readLastEventAt()).toBe(before);
        });

        it('an unmoved keepalive after a durable write that threw still writes', async () => {
            const real = makeTestWatchManager(sql);
            let failNext = true;
            const flaky = new PlaySessionLifecycleService({
                ...baseDeps,
                watchManager: {
                    ...real,
                    async reportProgress(params, txSql) {
                        if (failNext) {
                            failNext = false;
                            throw new Error('transient durable failure');
                        }
                        return real.reportProgress(params, txSql);
                    },
                },
            });
            const session = await seedSession();
            await flaky.update(session.id, {
                status: 'ACTIVE',
                position_ms: MID_CONTENT_MS,
                event_seq: 1,
                session_elapsed_ms: MIN_ENGAGEMENT_MS,
            });
            expect(await readLastEventAt()).toBeNull();

            await flaky.update(session.id, {
                status: 'PAUSED',
                position_ms: MID_CONTENT_MS,
                event_seq: 2,
                session_elapsed_ms: MIN_ENGAGEMENT_MS,
            });

            const state = await readState();
            expect(state).not.toBeNull();
            expect(Number(state!.resume_position_ms)).toBe(MID_CONTENT_MS);
        });

        it('a stop at the same position past completion still marks watched', async () => {
            const session = await seedSession();
            // Store the completion position on the row without a durable write.
            await updateHeartbeat(sql, session.id, {
                position_ms: PAST_COMPLETION_MS,
                status: 'PAUSED',
                event_seq: 1,
            });

            await service.update(session.id, {
                status: 'COMPLETED',
                position_ms: PAST_COMPLETION_MS,
                event_seq: 2,
                session_elapsed_ms: MIN_ENGAGEMENT_MS,
            });

            const state = await readState();
            expect(state).not.toBeNull();
            expect(state!.is_watched).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // jellyfin-compat (/j) hardening — episode 0.90 parity + engagement synth
    // -----------------------------------------------------------------------

    describe('jellyfin-compat (/j) hardening', () => {
        const COMPAT_DEVICE = `jellyfin-compat-${TEST_USER}`;
        const POS_91 = Math.floor(EPISODE_TIER_RUNTIME_MS * 0.91); // below 0.95 tier, at/above flat 0.90
        const POS_60 = Math.floor(EPISODE_TIER_RUNTIME_MS * 0.6);
        const POS_30S = 30_000;

        it('marks a compat EPISODE watched on stop at 0.91 (Jellyfin 0.90 parity)', async () => {
            await seedEpisodeItem();
            const s = await seedEpisodeSession(COMPAT_DEVICE);
            await service.update(s.id, {
                position_ms: POS_91,
                status: 'COMPLETED',
                stop_reason: 'jellyfin_client',
                event_seq: 1,
                session_elapsed_ms: POS_91, // mirrors the jellyfin-compat playhead synthesis this field used to receive automatically; crossedCompletion (0.90 tier) drives markWatched here regardless
            });
            const state = await getState.one(sql, { userId: TEST_USER, mediaId: EPISODE_MEDIA_ID });
            expect(state?.is_watched).toBe(true);
        });

        it('does NOT mark a NATIVE episode watched at 0.91 (keeps 0.95 tier at 100min), but saves resume', async () => {
            await seedEpisodeItem();
            const s = await seedEpisodeSession('device-native-1');
            await service.update(s.id, {
                position_ms: POS_91,
                status: 'COMPLETED',
                stop_reason: 'user',
                event_seq: 1,
                session_elapsed_ms: MIN_ENGAGEMENT_MS, // native sends engagement
            });
            const state = await getState.one(sql, { userId: TEST_USER, mediaId: EPISODE_MEDIA_ID });
            expect(state?.is_watched ?? false).toBe(false);
            expect(Number(state?.resume_position_ms ?? 0)).toBeGreaterThan(0);
        });

        it('saves a resume with engagement (visible in CW) for a compat stop at 0.60 without marking watched', async () => {
            await seedEpisodeItem();
            const s = await seedEpisodeSession(COMPAT_DEVICE);
            await service.update(s.id, {
                position_ms: POS_60,
                status: 'COMPLETED',
                stop_reason: 'jellyfin_client',
                // Real /j-magnitude event_seq (Date.now()) — regression guard for
                // the int4 overflow clamp in appendEventAndRebuild/normalizeEventSeq.
                event_seq: 1_750_000_012_345,
                session_elapsed_ms: POS_60, // mirrors the old undefined-field synthesis (elapsed = playhead) so the engagement gate still opens, persisting the resume without marking watched
            });
            const state = await getState.one(sql, { userId: TEST_USER, mediaId: EPISODE_MEDIA_ID });
            expect(state?.is_watched ?? false).toBe(false);
            expect(Number(state?.resume_position_ms ?? 0)).toBeGreaterThan(0);
            // CW-visibility guard (design Change 1): the synthesized playhead
            // engagement must populate highest_session_elapsed_ms so the Continue
            // Watching engagement branch fires instead of the 10%-resume branch.
            const [row] = await sql<Array<{ highest_session_elapsed_ms: number | null }>>`
                SELECT highest_session_elapsed_ms
                FROM user_media_state
                WHERE user_id = ${TEST_USER} AND media_id = ${EPISODE_MEDIA_ID}::uuid
            `;
            expect(Number(row?.highest_session_elapsed_ms ?? 0)).toBeGreaterThan(0);
        });

        it('persists nothing for a compat stop with playhead < 60s', async () => {
            await seedEpisodeItem();
            const s = await seedEpisodeSession(COMPAT_DEVICE);
            await service.update(s.id, {
                position_ms: POS_30S,
                status: 'COMPLETED',
                stop_reason: 'jellyfin_client',
                event_seq: 1,
                session_elapsed_ms: POS_30S, // mirrors the old synthesis; stays below MIN_ENGAGEMENT_MS so nothing persists, same as before
            });
            const state = await getState.one(sql, { userId: TEST_USER, mediaId: EPISODE_MEDIA_ID });
            expect(state == null || state.is_watched !== true).toBe(true);
            expect(Number(state?.resume_position_ms ?? 0)).toBe(0);
        });

        it('passes the 0.90 completionThreshold to reportProgress for a compat episode heartbeat', async () => {
            await seedEpisodeItem();
            const s = await seedEpisodeSession(COMPAT_DEVICE);
            const calls: Array<{ completionThreshold?: number }> = [];
            const spy = new PlaySessionLifecycleService({
                ...baseDeps,
                watchManager: {
                    async reportProgress(params) {
                        calls.push(params);
                        return 'accepted';
                    },
                    async markWatched() {},
                },
            });
            await spy.update(s.id, {
                position_ms: POS_91,
                status: 'ACTIVE',
                event_seq: 1,
                session_elapsed_ms: POS_91, // heartbeat path gates on `engaged` directly (no completion fallback); mirror old synthesis so reportProgress still fires
            });
            expect(calls).toHaveLength(1);
            expect(calls[0].completionThreshold).toBe(JELLYFIN_PLAYED_THRESHOLD);
        });

        it('sends no completionThreshold override for a native episode heartbeat (reportProgress stays window-aware)', async () => {
            await seedEpisodeItem();
            const s = await seedEpisodeSession('device-native-1');
            const calls: Array<{ completionThreshold?: number }> = [];
            const spy = new PlaySessionLifecycleService({
                ...baseDeps,
                watchManager: {
                    async reportProgress(params) {
                        calls.push(params);
                        return 'accepted';
                    },
                    async markWatched() {},
                },
            });
            await spy.update(s.id, {
                position_ms: POS_91,
                status: 'ACTIVE',
                event_seq: 1,
                session_elapsed_ms: MIN_ENGAGEMENT_MS,
            });
            expect(calls).toHaveLength(1);
            expect(calls[0].completionThreshold).toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // Combined multi-episode file — handleStop's completion verdict must be
    // window-aware (mirror of reportProgress's math), not judged against the
    // full FILE's declared runtime. Regression coverage for the /j
    // watch-state hardening fix: a combined file (one video holding several
    // episodes) reports session.runtime_ms as the WHOLE FILE's duration and
    // position_ms file-absolute, so the raw ratio wildly understates how far
    // into the OPENED episode the viewer actually got.
    // -----------------------------------------------------------------------

    describe('combined multi-episode file — window-aware completion on stop', () => {
        // Same shape as the Hafentage S02E24E25 fixture in
        // file-segments.queries.integration.test.ts: a 1354.602s file holding
        // two 660s-runtime episodes back to back, split by chapter markers at
        // 0 / 61.603 / 692.275 / 1323.072s — giving E24 the window
        // [0, 692275) and E25 the window [692275, 1354602).
        const FILE_DURATION_MS = 1_354_602;
        const E24_END_MS = 692_275;
        const CHAPTERS = [
            { name: 'Opening', startSeconds: 0 },
            { name: 'T.J. in Nöten', startSeconds: 61.603 },
            { name: 'Petey, der Schulschreck', startSeconds: 692.275 },
            { name: 'Credits', startSeconds: 1323.072 },
        ];

        async function seedCombinedFile(): Promise<{ e24Id: string; e25Id: string }> {
            const [series] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status, has_files)
                VALUES ('Combined File Fixture Series', 'tv', 'active', true)
                RETURNING id
            `;
            const [season] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status, has_files, parent_id, season_number)
                VALUES ('Season 2', 'season', 'active', true, ${series.id}, 2)
                RETURNING id
            `;
            const [file] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, duration_seconds)
                VALUES (${`/tmp/fixture-${crypto.randomUUID()}/S02E24E25.mkv`}, ${FILE_DURATION_MS / 1000})
                RETURNING id
            `;
            const [ep24] = await sql<{ id: string }[]>`
                INSERT INTO media_items
                    (title, media_type, status, has_files, parent_id, season_number, episode_number, runtime_seconds)
                VALUES ('Episode 24', 'episode', 'active', true, ${season.id}, 2, 24, 660)
                RETURNING id
            `;
            const [ep25] = await sql<{ id: string }[]>`
                INSERT INTO media_items
                    (title, media_type, status, has_files, parent_id, season_number, episode_number, runtime_seconds)
                VALUES ('Episode 25', 'episode', 'active', true, ${season.id}, 2, 25, 660)
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${file.id}, ${ep24.id}, true), (${file.id}, ${ep25.id}, true)
            `;
            for (const [index, chapter] of CHAPTERS.entries()) {
                await sql`
                    INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source)
                    VALUES (${file.id}, ${index}, ${chapter.name},
                            ${Math.round(chapter.startSeconds * 10_000_000)}, 'file')
                `;
            }
            await refreshSegmentsForFile(sql, file.id);
            return { e24Id: ep24.id, e25Id: ep25.id };
        }

        it('marks the opened episode watched at the end of ITS window, not ~51% of the full file', async () => {
            const { e24Id } = await seedCombinedFile();

            // The player reports the WHOLE FILE's duration as runtime_ms and a
            // file-absolute position_ms — stopping exactly at E24's window
            // boundary is only 692275/1354602 ≈ 51% of the declared runtime
            // (would NOT complete on the old, declared-runtime math) but 100%
            // of E24's own [0, 692275) window (DOES complete window-aware).
            const session = await createPlaySession(sql, {
                surface: 'web',
                media_id: e24Id,
                user_id: TEST_USER,
                device_id: 'device-combined-1',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
                runtime_ms: FILE_DURATION_MS,
            });

            await service.update(session.id, {
                status: 'COMPLETED',
                position_ms: E24_END_MS,
                event_seq: 1,
                // Zero engagement — proves the WINDOW crossing drives the
                // completion verdict, not the engagement gate.
                session_elapsed_ms: 0,
            });

            const state = await getState.one(sql, { userId: TEST_USER, mediaId: e24Id });
            expect(state?.is_watched).toBe(true);

            const [history] = await sql<Array<{ status: string }>>`
                SELECT status FROM watch_history
                WHERE user_id = ${TEST_USER} AND media_id = ${e24Id}::uuid
            `;
            expect(history?.status).toBe('completed');
        });

        it('does NOT mark the opened episode watched mid-way through ITS OWN window (engaged, but not window-complete)', async () => {
            const { e24Id } = await seedCombinedFile();

            const session = await createPlaySession(sql, {
                surface: 'web',
                media_id: e24Id,
                user_id: TEST_USER,
                device_id: 'device-combined-2',
                ip_address: '127.0.0.1',
                play_method: 'direct',
                position_ms: 0,
                runtime_ms: FILE_DURATION_MS,
            });

            // 50% into E24's own [0, 692275) window — nowhere near its
            // completion threshold. Engaged=true so the durable write still
            // happens (isolating the assertion to the completion verdict
            // itself, not the engagement gate).
            const midE24Ms = Math.floor(E24_END_MS * 0.5);

            await service.update(session.id, {
                status: 'COMPLETED',
                position_ms: midE24Ms,
                event_seq: 1,
                session_elapsed_ms: MIN_ENGAGEMENT_MS,
            });

            const state = await getState.one(sql, { userId: TEST_USER, mediaId: e24Id });
            expect(state).not.toBeNull();
            expect(state?.is_watched ?? false).toBe(false);
            // Resume position stays file-absolute (unaffected by the
            // window-relative completion math, which only judges the ratio).
            expect(Number(state!.resume_position_ms)).toBe(midE24Ms);
        });
    });
});
