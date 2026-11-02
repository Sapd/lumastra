// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    insertPlaybackIncidentEvent,
    resolveUnresolvedIncidentsByAttempt,
    listCorrelatedTranscodeFailures,
    prunePlaybackIncidentEvents,
    pruneLegacyPlaybackIncidentEvents,
    enforcePlaybackIncidentRowCap,
    listPlaybackIncidents,
    getPlaybackIncidentById,
    listRecentIncidentFailures,
} from './playback-incident-events.queries.js';
import type postgres from 'postgres';

/** Since Task 5, incidents live in client_diagnostics (kind = 'playback_incident'); the
 *  legacy table is frozen (no more writes) but still exists until a later migration drops
 *  it. Every seed below goes through insertPlaybackIncidentEvent (which now writes
 *  client_diagnostics), or — where a test needs a row shape the write path doesn't produce
 *  (e.g. an old received_at for pruning) — a direct INSERT INTO client_diagnostics. */
describe('playback-incident-events.queries', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await sql`DELETE FROM client_diagnostics WHERE kind = 'playback_incident' AND attempt_id LIKE 'test-%'`;
        await sql`DELETE FROM playback_incident_events WHERE attempt_id LIKE 'test-%'`;
        await sql`DELETE FROM transcode_failure_events WHERE job_id LIKE 'test-%'`;
        await sql`DELETE FROM users WHERE username LIKE 'test-playback-incident-%'`;
        await closeTestDb();
    });

    it('resolving an unresolved incident scoped to the wrong user is a no-op', async () => {
        const userId = '00000000-0000-0000-0000-000000000001';
        await sql`
            INSERT INTO users (id, username)
            VALUES (${userId}::uuid, 'test-playback-incident-noop-user')
            ON CONFLICT DO NOTHING
        `;
        const { id } = await insertPlaybackIncidentEvent(sql, {
            attemptId: 'test-attempt-1',
            playSessionId: 'test-session-1',
            incidentAt: new Date(),
            triggerType: 'reconnect',
            errorType: null,
            stage: null,
            httpStatus: null,
            serverDiagnosticCode: null,
            reconnectCause: 'network',
            message: null,
            userId,
            deviceId: null,
            mediaId: null,
            timeline: [],
            clientInfo: null,
        });
        expect(id).toBeGreaterThan(0);

        // A well-formed but different real user id — resolve scoped to it affects
        // nothing — confirms the query is properly scoped, not just "most recent by
        // attempt".
        const resolvedCount = await resolveUnresolvedIncidentsByAttempt(
            sql,
            '00000000-0000-0000-0000-000000000000',
            'test-attempt-1',
        );
        expect(resolvedCount).toBe(0);
        const [row] = await sql`SELECT resolved_at FROM client_diagnostics WHERE id = ${id}`;
        expect(row.resolved_at).toBeNull();
    });

    // The web player now reports mediaId. A well-formed uuid for an item that
    // was deleted (or never existed) must not trip media_id's FK (23503) —
    // that would 500 the ingest and lose the incident entirely.
    it('stores a NULL media_id instead of failing when the media item does not exist', async () => {
        const userId = '00000000-0000-0000-0000-000000000002';
        await sql`
            INSERT INTO users (id, username)
            VALUES (${userId}::uuid, 'test-playback-incident-missing-media')
            ON CONFLICT DO NOTHING
        `;
        const { id } = await insertPlaybackIncidentEvent(sql, {
            attemptId: 'test-attempt-missing-media',
            playSessionId: 'test-session-missing-media',
            incidentAt: new Date(),
            triggerType: 'terminal',
            errorType: null,
            stage: null,
            httpStatus: null,
            serverDiagnosticCode: null,
            reconnectCause: null,
            message: null,
            userId,
            deviceId: null,
            mediaId: '6b3d2a1e-0000-4000-8000-00000000dead',
            timeline: [],
            clientInfo: null,
        });
        const [row] = await sql`SELECT media_id FROM client_diagnostics WHERE id = ${id}`;
        expect(row.media_id).toBeNull();
    });

    it('throws when userId is null — playback incidents require an authenticated user', async () => {
        await expect(
            insertPlaybackIncidentEvent(sql, {
                attemptId: 'test-attempt-null-user',
                playSessionId: 'test-session-null-user',
                incidentAt: new Date(),
                triggerType: 'terminal',
                errorType: null,
                stage: null,
                httpStatus: null,
                serverDiagnosticCode: null,
                reconnectCause: null,
                message: null,
                userId: null,
                deviceId: null,
                mediaId: null,
                timeline: [],
                clientInfo: null,
            }),
        ).rejects.toThrow('playback incidents require an authenticated user');
    });

    it('resolves an incident by user+attempt', async () => {
        const userA = '00000000-0000-0000-0000-00000000000c';
        await sql`
            INSERT INTO users (id, username)
            VALUES (${userA}::uuid, 'test-playback-incident-resolve-a')
            ON CONFLICT DO NOTHING
        `;
        const { id } = await insertPlaybackIncidentEvent(sql, {
            attemptId: 'test-attempt-2',
            playSessionId: 'test-session-2',
            incidentAt: new Date(),
            triggerType: 'reconnect',
            errorType: null,
            stage: null,
            httpStatus: null,
            serverDiagnosticCode: null,
            reconnectCause: 'stall',
            message: null,
            userId: userA,
            deviceId: null,
            mediaId: null,
            timeline: [],
            clientInfo: null,
        });
        const resolvedCount = await resolveUnresolvedIncidentsByAttempt(
            sql,
            userA,
            'test-attempt-2',
        );
        expect(resolvedCount).toBe(1);
        const [row] = await sql`SELECT resolved_at FROM client_diagnostics WHERE id = ${id}`;
        expect(row.resolved_at).not.toBeNull();
    });

    it('resolves ALL unresolved rows for an attempt, not just the most recent', async () => {
        const userA = '00000000-0000-0000-0000-00000000000d';
        await sql`
            INSERT INTO users (id, username)
            VALUES (${userA}::uuid, 'test-playback-incident-resolve-multi')
            ON CONFLICT DO NOTHING
        `;
        const attemptId = 'test-attempt-multi';
        const { id: id1 } = await insertPlaybackIncidentEvent(sql, {
            attemptId,
            playSessionId: 'test-session-multi-1',
            incidentAt: new Date(),
            triggerType: 'error',
            errorType: 'network',
            stage: null,
            httpStatus: null,
            serverDiagnosticCode: null,
            reconnectCause: null,
            message: null,
            userId: userA,
            deviceId: null,
            mediaId: null,
            timeline: [],
            clientInfo: null,
        });
        const { id: id2 } = await insertPlaybackIncidentEvent(sql, {
            attemptId,
            playSessionId: 'test-session-multi-2',
            incidentAt: new Date(),
            triggerType: 'error',
            errorType: 'network',
            stage: null,
            httpStatus: null,
            serverDiagnosticCode: null,
            reconnectCause: null,
            message: null,
            userId: userA,
            deviceId: null,
            mediaId: null,
            timeline: [],
            clientInfo: null,
        });

        const resolvedCount = await resolveUnresolvedIncidentsByAttempt(sql, userA, attemptId);
        expect(resolvedCount).toBe(2);

        const rows = await sql`
            SELECT id, resolved_at FROM client_diagnostics WHERE id IN (${id1}, ${id2})
        `;
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.resolved_at).not.toBeNull();
        }
    });

    it('a row with user_id NULL (post-GDPR-erasure) is untouched by resolveUnresolvedIncidentsByAttempt for any real user', async () => {
        const realUser = '00000000-0000-0000-0000-00000000000e';
        await sql`
            INSERT INTO users (id, username)
            VALUES (${realUser}::uuid, 'test-playback-incident-erased-real-user')
            ON CONFLICT DO NOTHING
        `;
        const attemptId = 'test-attempt-erased';
        // Simulates a row whose user_id was nulled by GDPR erasure — direct INSERT since
        // insertPlaybackIncidentEvent now rejects a null userId outright (it requires an
        // authenticated user at write time; erasure is the only path that can leave a
        // playback_incident row with user_id NULL after the fact).
        const [{ id }] = await sql<{ id: number }[]>`
            INSERT INTO client_diagnostics
                (event_id, kind, user_id, platform, attempt_id, play_session_id,
                 occurred_at, received_at, occurrences, payload, payload_bytes)
            VALUES (${randomUUID()}::uuid, 'playback_incident', NULL, 'web', ${attemptId},
                    'test-session-erased', now(), now(), 1,
                    '{"triggerType":"terminal","timeline":[]}'::jsonb, 10)
            RETURNING id
        `;

        const resolvedCount = await resolveUnresolvedIncidentsByAttempt(sql, realUser, attemptId);
        expect(resolvedCount).toBe(0);

        const [row] = await sql`SELECT resolved_at FROM client_diagnostics WHERE id = ${id}`;
        expect(row.resolved_at).toBeNull();
    });

    describe('listCorrelatedTranscodeFailures', () => {
        const ownerId = '00000000-0000-0000-0000-00000000001a';
        const strangerId = '00000000-0000-0000-0000-00000000001b';
        // The SAME play_session_id value on both users' incident rows — the
        // collision an attacker would engineer by replaying a session id they
        // observed. attempt_id is client-generated and the ingest endpoint does
        // not verify that the reporter originated it, so attempt-only scoping would
        // surface the stranger's transcode failure here.
        const sharedSessionId = 'test-session-correlate-shared';

        beforeAll(async () => {
            await sql`
                INSERT INTO users (id, username)
                VALUES (${ownerId}::uuid, 'test-playback-incident-correlate-owner'),
                       (${strangerId}::uuid, 'test-playback-incident-correlate-stranger')
                ON CONFLICT DO NOTHING
            `;
            await insertPlaybackIncidentEvent(sql, {
                attemptId: 'test-attempt-correlate',
                playSessionId: 'test-session-correlate-owner',
                incidentAt: new Date(),
                triggerType: 'error',
                errorType: 'network',
                stage: null,
                httpStatus: null,
                serverDiagnosticCode: null,
                reconnectCause: null,
                message: null,
                userId: ownerId,
                deviceId: null,
                mediaId: null,
                timeline: [],
                clientInfo: null,
            });
            // The stranger's row: same attempt_id, colliding play_session_id.
            await insertPlaybackIncidentEvent(sql, {
                attemptId: 'test-attempt-correlate',
                playSessionId: sharedSessionId,
                incidentAt: new Date(),
                triggerType: 'error',
                errorType: 'network',
                stage: null,
                httpStatus: null,
                serverDiagnosticCode: null,
                reconnectCause: null,
                message: null,
                userId: strangerId,
                deviceId: null,
                mediaId: null,
                timeline: [],
                clientInfo: null,
            });

            await sql`
                INSERT INTO transcode_failure_events
                    (job_id, play_session_id, outcome, category, summary)
                VALUES ('test-job-owner', 'test-session-correlate-owner', 'failed', 'decode', 'owner failure'),
                       ('test-job-stranger', ${sharedSessionId}, 'failed', 'decode', 'stranger failure')
            `;
        });

        it("returns the caller's own correlated transcode failures", async () => {
            const rows = await listCorrelatedTranscodeFailures(
                sql,
                'test-attempt-correlate',
                ownerId,
            );
            expect(rows.map((r) => r.summary)).toEqual(['owner failure']);
        });

        it("excludes another user's failure even when the play_session_id collides", async () => {
            const rows = await listCorrelatedTranscodeFailures(
                sql,
                'test-attempt-correlate',
                ownerId,
            );
            // Without the user_id scoping on the subquery, the stranger's
            // incident row contributes its play_session_id and this leaks.
            expect(rows.map((r) => r.summary)).not.toContain('stranger failure');
        });

        it("still returns the stranger's own failure when scoped to them", async () => {
            const rows = await listCorrelatedTranscodeFailures(
                sql,
                'test-attempt-correlate',
                strangerId,
            );
            expect(rows.map((r) => r.summary)).toEqual(['stranger failure']);
        });
    });

    /**
     * The spec's whole naming trap is that legacy `incident_at` (client time) maps to
     * `cd.occurred_at`, while legacy `occurred_at` (server receipt) maps to
     * `cd.received_at` — the two column names are SWAPPED relative to their legacy
     * counterparts. Every row below is seeded with occurred_at and received_at
     * DELIBERATELY far apart and on OPPOSITE sides of any cutoff/window used, so a query
     * that reads the wrong column produces a different, wrong answer rather than
     * coincidentally passing.
     */
    describe('client time (occurred_at) vs server time (received_at) — the naming trap', () => {
        async function seedRow(
            userId: string,
            attemptId: string,
            occurredAt: Date,
            receivedAt: Date,
        ): Promise<void> {
            await sql`
                INSERT INTO client_diagnostics
                    (event_id, kind, user_id, platform, attempt_id, play_session_id,
                     occurred_at, received_at, occurrences, payload, payload_bytes)
                VALUES (${randomUUID()}::uuid, 'playback_incident', ${userId}::uuid, 'web',
                        ${attemptId}, ${'test-session-' + attemptId},
                        ${occurredAt}, ${receivedAt},
                        1, '{"triggerType":"terminal","timeline":[]}'::jsonb, 10)
            `;
        }

        it('prune deletes by received_at (server time), NOT occurred_at (client time)', async () => {
            const userId = randomUUID();
            await sql`
                INSERT INTO users (id, username)
                VALUES (${userId}::uuid, 'test-playback-incident-prune')
                ON CONFLICT DO NOTHING
            `;
            const cutoff = new Date(Date.now() - 30 * 86_400_000);
            // Client time is OLD (40 days) but the row was only just RECEIVED (1 day ago) —
            // if prune wrongly keyed off occurred_at this row would be deleted; keying off
            // received_at (correct) it must survive.
            await seedRow(
                userId,
                'test-prune-old-client-new-server',
                new Date(Date.now() - 40 * 86_400_000),
                new Date(Date.now() - 1 * 86_400_000),
            );
            // Client time is RECENT (1 day ago) but it was RECEIVED long ago (40 days) —
            // e.g. backfilled/delayed telemetry. If prune wrongly keyed off occurred_at
            // this row would survive; keying off received_at (correct) it must be deleted.
            await seedRow(
                userId,
                'test-prune-new-client-old-server',
                new Date(Date.now() - 1 * 86_400_000),
                new Date(Date.now() - 40 * 86_400_000),
            );

            await prunePlaybackIncidentEvents(sql, cutoff, 10_000);

            const [survivor] = await sql`
                SELECT id FROM client_diagnostics
                WHERE attempt_id = 'test-prune-old-client-new-server' AND kind = 'playback_incident'
            `;
            expect(survivor).toBeDefined();
            const [deleted] = await sql`
                SELECT id FROM client_diagnostics
                WHERE attempt_id = 'test-prune-new-client-old-server' AND kind = 'playback_incident'
            `;
            expect(deleted).toBeUndefined();
        });

        it('legacy prune deletes frozen playback_incident_events rows by occurred_at (server receipt), NOT incident_at', async () => {
            const cutoff = new Date(Date.now() - 30 * 86_400_000);
            const seedLegacy = async (attemptId: string, incidentAt: Date, occurredAt: Date) => {
                await sql`
                    INSERT INTO playback_incident_events
                        (attempt_id, play_session_id, incident_at, occurred_at, trigger_type, timeline)
                    VALUES (${attemptId}, ${'test-session-' + attemptId}, ${incidentAt}, ${occurredAt},
                            'terminal', '[]'::jsonb)
                `;
            };
            // Old client clock, recently received → survives.
            await seedLegacy(
                'test-legacy-prune-keep',
                new Date(Date.now() - 40 * 86_400_000),
                new Date(Date.now() - 1 * 86_400_000),
            );
            // Recent client clock, received long ago → pruned.
            await seedLegacy(
                'test-legacy-prune-drop',
                new Date(Date.now() - 1 * 86_400_000),
                new Date(Date.now() - 40 * 86_400_000),
            );

            const removed = await pruneLegacyPlaybackIncidentEvents(sql, cutoff, 10_000);
            expect(removed).toBeGreaterThanOrEqual(1);

            const rows = await sql<{ attempt_id: string }[]>`
                SELECT attempt_id FROM playback_incident_events
                WHERE attempt_id IN ('test-legacy-prune-keep', 'test-legacy-prune-drop')
            `;
            expect(rows.map((r) => r.attempt_id)).toEqual(['test-legacy-prune-keep']);
        });

        it('listPlaybackIncidents orders by received_at DESC and maps incident_at/occurred_at to the right columns', async () => {
            const userId = randomUUID();
            await sql`
                INSERT INTO users (id, username)
                VALUES (${userId}::uuid, 'test-playback-incident-time-mapping')
                ON CONFLICT DO NOTHING
            `;
            // Row A: old client time, but the MOST RECENTLY received of the two.
            const occurredA = new Date(Date.now() - 10 * 86_400_000);
            const receivedA = new Date(Date.now() - 1 * 60_000);
            // Row B: recent client time, but received long before A.
            const occurredB = new Date(Date.now() - 1 * 60_000);
            const receivedB = new Date(Date.now() - 10 * 86_400_000);
            await seedRow(userId, 'test-time-list-a', occurredA, receivedA);
            await seedRow(userId, 'test-time-list-b', occurredB, receivedB);

            const { rows } = await listPlaybackIncidents(sql, { userId, limit: 10, offset: 0 });
            // Ordering by received_at DESC puts A (received most recently) first, even
            // though B has the more recent CLIENT time — ordering by occurred_at instead
            // would put B first.
            expect(rows.map((r) => r.attempt_id)).toEqual(['test-time-list-a', 'test-time-list-b']);

            const rowA = rows.find((r) => r.attempt_id === 'test-time-list-a');
            // Legacy incident_at (client time) must come from cd.occurred_at.
            expect(rowA?.incident_at.getTime()).toBe(occurredA.getTime());
            // Legacy occurred_at (server receipt) must come from cd.received_at.
            expect(rowA?.occurred_at.getTime()).toBe(receivedA.getTime());
        });

        it("listPlaybackIncidents' from/to window filters on received_at, NOT occurred_at", async () => {
            const userId = randomUUID();
            await sql`
                INSERT INTO users (id, username)
                VALUES (${userId}::uuid, 'test-playback-incident-time-window')
                ON CONFLICT DO NOTHING
            `;
            // In-window row: received recently, but its CLIENT time is far outside the window.
            await seedRow(
                userId,
                'test-time-window-in',
                new Date(Date.now() - 20 * 86_400_000),
                new Date(Date.now() - 1 * 60_000),
            );
            // Out-of-window row: received long ago, but its CLIENT time is inside the window.
            await seedRow(
                userId,
                'test-time-window-out',
                new Date(Date.now() - 1 * 60_000),
                new Date(Date.now() - 20 * 86_400_000),
            );

            const { rows } = await listPlaybackIncidents(sql, {
                userId,
                from: new Date(Date.now() - 2 * 86_400_000),
                to: new Date(),
                limit: 10,
                offset: 0,
            });
            // Filtering on occurred_at instead would return 'test-time-window-out' (and miss
            // 'test-time-window-in') — the inverse of the correct result.
            expect(rows.map((r) => r.attempt_id)).toEqual(['test-time-window-in']);
        });
    });

    it('enforces a per-user row cap without touching other users', async () => {
        const userA = '00000000-0000-0000-0000-00000000000a';
        const userB = '00000000-0000-0000-0000-00000000000b';
        await sql`
            INSERT INTO users (id, username)
            VALUES (${userA}::uuid, 'test-playback-incident-cap-a'),
                   (${userB}::uuid, 'test-playback-incident-cap-b')
            ON CONFLICT DO NOTHING
        `;
        for (let i = 0; i < 5; i++) {
            await insertPlaybackIncidentEvent(sql, {
                attemptId: `test-cap-a-${i}`,
                playSessionId: `test-session-cap-a-${i}`,
                incidentAt: new Date(),
                triggerType: 'terminal',
                errorType: null,
                stage: null,
                httpStatus: null,
                serverDiagnosticCode: null,
                reconnectCause: null,
                message: null,
                userId: userA,
                deviceId: null,
                mediaId: null,
                timeline: [],
                clientInfo: null,
            });
        }
        await insertPlaybackIncidentEvent(sql, {
            attemptId: 'test-cap-b-0',
            playSessionId: 'test-session-cap-b-0',
            incidentAt: new Date(),
            triggerType: 'terminal',
            errorType: null,
            stage: null,
            httpStatus: null,
            serverDiagnosticCode: null,
            reconnectCause: null,
            message: null,
            userId: userB,
            deviceId: null,
            mediaId: null,
            timeline: [],
            clientInfo: null,
        });

        await enforcePlaybackIncidentRowCap(sql, 3, 10_000);

        const [{ count: countA }] = await sql`
            SELECT count(*)::int FROM client_diagnostics WHERE user_id = ${userA}::uuid AND kind = 'playback_incident'
        `;
        const [{ count: countB }] = await sql`
            SELECT count(*)::int FROM client_diagnostics WHERE user_id = ${userB}::uuid AND kind = 'playback_incident'
        `;
        expect(countA).toBe(3);
        expect(countB).toBe(1); // untouched — proves the cap is per-user, not global
    });

    describe('listPlaybackIncidents', () => {
        it('filters by userId and paginates', async () => {
            const userId = '00000000-0000-0000-0000-0000000000f1';
            await sql`
                INSERT INTO users (id, username)
                VALUES (${userId}::uuid, 'test-playback-incident-list-paginate')
                ON CONFLICT DO NOTHING
            `;
            for (let i = 0; i < 3; i++) {
                await sql`
                    INSERT INTO client_diagnostics
                        (event_id, kind, user_id, platform, attempt_id, play_session_id,
                         occurred_at, received_at, occurrences, payload, payload_bytes)
                    VALUES (${randomUUID()}::uuid, 'playback_incident', ${userId}::uuid, 'web',
                            ${'test-list-' + i}, ${'test-list-session-' + i},
                            now() - (${i} || ' minutes')::interval, now() - (${i} || ' minutes')::interval,
                            1, '{"triggerType":"terminal","timeline":[]}'::jsonb, 10)
                `;
            }
            const { rows, total } = await listPlaybackIncidents(sql, {
                userId,
                limit: 2,
                offset: 0,
            });
            expect(total).toBe(3);
            expect(rows).toHaveLength(2);
            // Most recent first.
            expect(rows[0].attempt_id).toBe('test-list-0');
        });

        it('filters by triggerType', async () => {
            const userId = '00000000-0000-0000-0000-0000000000f2';
            await sql`
                INSERT INTO users (id, username)
                VALUES (${userId}::uuid, 'test-playback-incident-list-trigger')
                ON CONFLICT DO NOTHING
            `;
            await insertPlaybackIncidentEvent(sql, {
                attemptId: 'test-trig-error',
                playSessionId: 'test-trig-session-1',
                incidentAt: new Date(),
                triggerType: 'error',
                errorType: 'network',
                stage: null,
                httpStatus: null,
                serverDiagnosticCode: null,
                reconnectCause: null,
                message: null,
                userId,
                deviceId: null,
                mediaId: null,
                timeline: [],
                clientInfo: null,
            });
            await insertPlaybackIncidentEvent(sql, {
                attemptId: 'test-trig-terminal',
                playSessionId: 'test-trig-session-2',
                incidentAt: new Date(),
                triggerType: 'terminal',
                errorType: null,
                stage: null,
                httpStatus: null,
                serverDiagnosticCode: null,
                reconnectCause: null,
                message: null,
                userId,
                deviceId: null,
                mediaId: null,
                timeline: [],
                clientInfo: null,
            });
            const { rows } = await listPlaybackIncidents(sql, {
                userId,
                triggerType: 'terminal',
                limit: 10,
                offset: 0,
            });
            expect(rows.map((r) => r.attempt_id)).toEqual(['test-trig-terminal']);
        });
    });

    it("list/detail never resolve another user's play session via a forged playSessionId", async () => {
        const reporter = randomUUID();
        const victim = randomUUID();
        await sql`
            INSERT INTO users (id, username)
            VALUES (${reporter}::uuid, ${'test-playback-incident-forge-r-' + reporter.slice(0, 8)}),
                   (${victim}::uuid, ${'test-playback-incident-forge-v-' + victim.slice(0, 8)})
        `;
        const [media] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type) VALUES ('Victim Private Incident Movie', 'movie') RETURNING id
        `;
        const victimSession = randomUUID();
        await sql`
            INSERT INTO play_sessions (id, media_id, user_id, device_id, ip_address, play_method)
            VALUES (${victimSession}::uuid, ${media.id}::uuid, ${victim}::uuid, 'dev-v', '0.0.0.0'::inet, 'direct')
        `;
        const { id } = await insertPlaybackIncidentEvent(sql, {
            attemptId: 'test-forge-attempt',
            playSessionId: victimSession.toUpperCase(),
            incidentAt: new Date(),
            triggerType: 'terminal',
            errorType: null,
            stage: null,
            httpStatus: null,
            serverDiagnosticCode: null,
            reconnectCause: null,
            message: null,
            userId: reporter,
            deviceId: null,
            mediaId: null,
            timeline: [],
            clientInfo: null,
        });
        try {
            const { rows } = await listPlaybackIncidents(sql, {
                userId: reporter,
                limit: 10,
                offset: 0,
            });
            expect(rows).toHaveLength(1);
            expect(rows[0]?.media_id).toBeNull();
            expect(rows[0]?.media_title).toBeNull();
            const detail = await getPlaybackIncidentById(sql, id);
            expect(detail?.media_id).toBeNull();
            expect(detail?.media_title).toBeNull();
        } finally {
            await sql`DELETE FROM play_sessions WHERE id = ${victimSession}::uuid`;
            await sql`DELETE FROM media_items WHERE id = ${media.id}::uuid`;
        }
    });

    describe('getPlaybackIncidentById', () => {
        it('returns the full row, or null if not found', async () => {
            const userId = '00000000-0000-0000-0000-0000000000f4';
            await sql`
                INSERT INTO users (id, username)
                VALUES (${userId}::uuid, 'test-playback-incident-detail')
                ON CONFLICT DO NOTHING
            `;
            const { id } = await insertPlaybackIncidentEvent(sql, {
                attemptId: 'test-detail-1',
                playSessionId: 'test-detail-session-1',
                incidentAt: new Date(),
                triggerType: 'terminal',
                errorType: null,
                stage: null,
                httpStatus: null,
                serverDiagnosticCode: null,
                reconnectCause: null,
                message: null,
                userId,
                deviceId: null,
                mediaId: null,
                timeline: [{ t: 0, kind: 'seek' }],
                clientInfo: null,
            });
            const row = await getPlaybackIncidentById(sql, id);
            expect(row?.attempt_id).toBe('test-detail-1');
            expect(row?.timeline).toEqual([{ t: 0, kind: 'seek' }]);

            const missing = await getPlaybackIncidentById(sql, 999_999_999);
            expect(missing).toBeNull();
        });
    });

    describe('listRecentIncidentFailures', () => {
        it('never includes user_id, device_id, or timeline', async () => {
            const userId = '00000000-0000-0000-0000-0000000000f3';
            await sql`
                INSERT INTO users (id, username)
                VALUES (${userId}::uuid, 'test-playback-incident-diag-summary')
                ON CONFLICT DO NOTHING
            `;
            await insertPlaybackIncidentEvent(sql, {
                attemptId: 'test-diag-1',
                playSessionId: 'test-diag-session-1',
                incidentAt: new Date(),
                triggerType: 'terminal',
                errorType: null,
                stage: null,
                httpStatus: null,
                serverDiagnosticCode: null,
                reconnectCause: null,
                message: null,
                userId,
                deviceId: 'device-x',
                mediaId: null,
                timeline: [{ t: 0, kind: 'seek' }],
                clientInfo: null,
            });
            const rows = await listRecentIncidentFailures(sql, 10);
            const row = rows.find((r) => r.error_type === null && r.reconnect_cause === null);
            expect(row).toBeDefined();
            expect(Object.keys(row ?? {})).not.toContain('user_id');
            expect(Object.keys(row ?? {})).not.toContain('device_id');
            expect(Object.keys(row ?? {})).not.toContain('timeline');
        });
    });
});
