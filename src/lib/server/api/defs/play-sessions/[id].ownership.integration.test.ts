// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 7, G1 (pin, not a fix): `PlaySessionLifecycleService.update()`
 * loads a play session by id alone and its `cleanupAfterStop` step calls
 * `stopJob(sessionId, 'session_stop')` — neither is scoped to the caller. The
 * only protection is the caller-side ownership check in the route defs
 * themselves (`getSessionById` -> `if (session.user_id !== userId) return
 * ApiResponses.unauthorized()`), present in both `[id].ts` (PUT) and the
 * `[id]/beacon.ts` POST mirror, before `service.update()` is ever reached.
 *
 * This test drives the REAL def handlers against a real PostgreSQL database
 * (not mocks) so "the row is unchanged" and "the transcode job was not
 * stopped" are genuine observations, not assumptions about what a mock
 * wasn't called with. `stopJob` is spied on the real
 * `getFFmpegTranscodeService()` singleton — the same singleton
 * `PlaySessionLifecycleService.cleanupAfterStop` dynamically imports and
 * calls — rather than mocked away, since a same-user COMPLETED request must
 * still reach it for the control case to be meaningful.
 *
 * Each attack case is paired with a same-user control on a SEPARATE session,
 * proving the 404 is the ownership check and not a broken harness that would
 * 404/no-op regardless of caller.
 *
 * Run locally:
 *   npm run test:integration src/lib/server/api/defs/play-sessions/[id].ownership.integration.test.ts
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../../../tests/integration/fixtures/user.fixtures.js';
import {
    createPlaySession,
    getSessionById,
    type SessionRow,
} from '$lib/server/database/queries/play-sessions.queries.js';
import { getFFmpegTranscodeService } from '$lib/server/services/ffmpeg-transcode.service.js';
import { def as putDef } from './[id].js';
import { def as beaconDef } from './[id]/beacon.js';

const MEDIA_ID = randomUUID();
const RUNTIME_MS = 60 * 60 * 1000;

describe('play-sessions/{id} ownership scoping (security review 7, G1 pin)', () => {
    let sql: postgres.Sql;
    const userA = generateTestUserId();
    const userB = generateTestUserId();

    beforeAll(async () => {
        sql = getTestDb();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, runtime_seconds)
            VALUES (${MEDIA_ID}::uuid, 'G1 Ownership Fixture', 'movie', 'active', ${RUNTIME_MS / 1000})
        `;
        await ensureTestUser(sql, userA);
        await ensureTestUser(sql, userB);
    });

    afterAll(async () => {
        await sql`DELETE FROM play_sessions WHERE media_id = ${MEDIA_ID}::uuid`;
        await sql`DELETE FROM media_items WHERE id = ${MEDIA_ID}::uuid`;
        await sql`DELETE FROM user_profiles WHERE user_id IN (${userA}::uuid, ${userB}::uuid)`;
        await sql`DELETE FROM users WHERE id IN (${userA}::uuid, ${userB}::uuid)`;
    });

    async function seedSession(deviceSuffix: string): Promise<SessionRow> {
        return createPlaySession(sql, {
            surface: 'web',
            media_id: MEDIA_ID,
            user_id: userA,
            device_id: `g1-ownership-${deviceSuffix}`,
            ip_address: '127.0.0.1',
            play_method: 'direct',
            position_ms: 1000,
            runtime_ms: RUNTIME_MS,
        });
    }

    function eventFor(userId: string) {
        return { locals: { user: { userId } } } as never;
    }

    function ctxFor(sessionId: string) {
        return {
            input: {
                params: { id: sessionId },
                body: {
                    positionMs: 5000,
                    status: 'COMPLETED' as const,
                    eventSeq: 1,
                    sessionElapsedMs: 5000,
                },
            },
        } as never;
    }

    it("B PUTting COMPLETED on A's session gets 404, A's row is unchanged, and A's transcode job is not stopped", async () => {
        const session = await seedSession('put-attack');
        expect(session.status).toBe('ACTIVE');

        const stopJobSpy = vi.spyOn(getFFmpegTranscodeService(), 'stopJob');

        const res = await putDef.handlers.PUT!(eventFor(userB), ctxFor(session.id));
        expect(res.status).toBe(404);

        const row = await getSessionById(sql, session.id);
        expect(row?.status).toBe('ACTIVE');
        expect(stopJobSpy).not.toHaveBeenCalledWith(session.id, expect.anything());

        stopJobSpy.mockRestore();
    });

    it('control: A PUTting COMPLETED on their OWN session gets 2xx, the row transitions, and the transcode job stop is attempted', async () => {
        const session = await seedSession('put-control');
        expect(session.status).toBe('ACTIVE');

        const stopJobSpy = vi.spyOn(getFFmpegTranscodeService(), 'stopJob');

        const res = await putDef.handlers.PUT!(eventFor(userA), ctxFor(session.id));
        expect(res.status).toBeGreaterThanOrEqual(200);
        expect(res.status).toBeLessThan(300);

        const row = await getSessionById(sql, session.id);
        expect(row?.status).toBe('COMPLETED');
        expect(stopJobSpy).toHaveBeenCalledWith(session.id, 'session_stop');

        stopJobSpy.mockRestore();
    });

    it("B POSTing COMPLETED to A's session beacon gets 404, A's row is unchanged, and A's transcode job is not stopped", async () => {
        const session = await seedSession('beacon-attack');
        expect(session.status).toBe('ACTIVE');

        const stopJobSpy = vi.spyOn(getFFmpegTranscodeService(), 'stopJob');

        const res = await beaconDef.handlers.POST!(eventFor(userB), ctxFor(session.id));
        expect(res.status).toBe(404);

        const row = await getSessionById(sql, session.id);
        expect(row?.status).toBe('ACTIVE');
        expect(stopJobSpy).not.toHaveBeenCalledWith(session.id, expect.anything());

        stopJobSpy.mockRestore();
    });

    it('control: A POSTing COMPLETED to their OWN session beacon gets 204, and the row transitions', async () => {
        const session = await seedSession('beacon-control');
        expect(session.status).toBe('ACTIVE');

        const stopJobSpy = vi.spyOn(getFFmpegTranscodeService(), 'stopJob');

        const res = await beaconDef.handlers.POST!(eventFor(userA), ctxFor(session.id));
        expect(res.status).toBe(204);

        const row = await getSessionById(sql, session.id);
        expect(row?.status).toBe('COMPLETED');
        expect(stopJobSpy).toHaveBeenCalledWith(session.id, 'session_stop');

        stopJobSpy.mockRestore();
    });
});
