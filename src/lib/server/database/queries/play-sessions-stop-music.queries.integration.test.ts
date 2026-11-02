// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for stopOtherActiveMusicSessions
 *
 * Verifies that starting a new Subsonic track closes all other ACTIVE/PAUSED
 * music sessions for the same user without touching video sessions or sessions
 * belonging to other users.
 *
 * Run locally:
 *   npm run test:integration src/lib/server/database/queries/play-sessions-stop-music.queries.integration.test.ts
 *
 * Run against preprod:
 *   npm run test:integration -- src/lib/server/database/queries/play-sessions-stop-music.queries.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/user.fixtures.js';
import type { UserId } from '$lib/shared/user-id.js';
import { stopOtherActiveMusicSessions, upsertExternalSession } from './play-sessions.queries.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Insert a minimal media_items row (track). Returns the UUID. */
async function insertTrack(sql: postgres.Sql): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, created_at, updated_at)
        VALUES (${id}::uuid, 'Test Track', 'track', NOW(), NOW())
    `;
    return id;
}

/** Fetch a play_session row's status + stop_reason by id. */
async function fetchSession(
    sql: postgres.Sql,
    id: string,
): Promise<{ status: string; stop_reason: string | null } | null> {
    const [row] = await sql<{ status: string; stop_reason: string | null }[]>`
        SELECT status, stop_reason FROM play_sessions WHERE id = ${id}
    `;
    return row ?? null;
}

/** Seed an ACTIVE subsonic/direct session for a user+track. Returns row id. */
async function seedMusicSession(
    sql: postgres.Sql,
    userId: UserId,
    trackId: string,
    sessionKey: string,
    playMethod: 'direct' | 'audio_transcode' = 'direct',
): Promise<string> {
    const { row } = await upsertExternalSession(sql, {
        surface: 'subsonic',
        source: 'subsonic',
        source_session_id: sessionKey,
        media_id: trackId,
        user_id: userId,
        device_id: `subsonic-${userId.slice(0, 8)}`,
        client_name: 'TestClient',
        status: 'ACTIVE',
        position_ms: 10_000,
        play_method: playMethod,
    });
    return row.id;
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('stopOtherActiveMusicSessions', () => {
    let sql: postgres.Sql;
    // play_sessions.user_id is uuid REFERENCES users(id) since mig 16.46.0
    let testUserId: UserId;
    let otherUserId: UserId;
    let trackA: string;
    let trackB: string;
    let trackC: string;

    beforeAll(async () => {
        sql = getTestDb();
        testUserId = generateTestUserId('music_session_user');
        otherUserId = generateTestUserId('music_session_other');
        await ensureTestUser(sql, testUserId);
        await ensureTestUser(sql, otherUserId);
        trackA = await insertTrack(sql);
        trackB = await insertTrack(sql);
        trackC = await insertTrack(sql);
    });

    afterAll(async () => {
        // Clean up sessions and media we created
        await sql`DELETE FROM play_sessions WHERE user_id IN (${testUserId}::uuid, ${otherUserId}::uuid)`;
        await sql`DELETE FROM media_items WHERE id = ANY(${sql.array([trackA, trackB, trackC])}::uuid[])`;
        await closeTestDb();
    });

    beforeEach(async () => {
        // Remove any sessions from previous test cases for these users
        await sql`DELETE FROM play_sessions WHERE user_id IN (${testUserId}::uuid, ${otherUserId}::uuid)`;
    });

    it('closes the previous ACTIVE session and leaves the kept session untouched', async () => {
        // Seed two sessions: A (prior track) and B (new track)
        const keyA = `${testUserId.slice(0, 8)}:${trackA}`;
        const keyB = `${testUserId.slice(0, 8)}:${trackB}`;
        const idA = await seedMusicSession(sql, testUserId, trackA, keyA);
        const idB = await seedMusicSession(sql, testUserId, trackB, keyB);

        // Start track B — should close A, leave B alone
        const closed = await stopOtherActiveMusicSessions(sql, testUserId, 'subsonic', keyB);

        expect(closed).toHaveLength(1);
        expect(closed[0].id).toBe(idA);
        expect(closed[0].source_session_id).toBe(keyA);

        const sessionA = await fetchSession(sql, idA);
        expect(sessionA?.status).toBe('COMPLETED');
        expect(sessionA?.stop_reason).toBe('superseded');

        const sessionB = await fetchSession(sql, idB);
        expect(sessionB?.status).toBe('ACTIVE');
    });

    it('closes multiple stale sessions when user has skipped several tracks', async () => {
        const keyA = `${testUserId.slice(0, 8)}:${trackA}`;
        const keyB = `${testUserId.slice(0, 8)}:${trackB}`;
        const keyC = `${testUserId.slice(0, 8)}:${trackC}`;
        const idA = await seedMusicSession(sql, testUserId, trackA, keyA);
        const idB = await seedMusicSession(sql, testUserId, trackB, keyB);
        const idC = await seedMusicSession(sql, testUserId, trackC, keyC);

        const closed = await stopOtherActiveMusicSessions(sql, testUserId, 'subsonic', keyC);

        expect(closed).toHaveLength(2);
        const closedIds = closed.map((c) => c.id).sort();
        expect(closedIds).toEqual([idA, idB].sort());

        for (const id of [idA, idB]) {
            const s = await fetchSession(sql, id);
            expect(s?.status).toBe('COMPLETED');
            expect(s?.stop_reason).toBe('superseded');
        }
        const sC = await fetchSession(sql, idC);
        expect(sC?.status).toBe('ACTIVE');
    });

    it('does not touch sessions belonging to another user', async () => {
        const keyA = `${testUserId.slice(0, 8)}:${trackA}`;
        const keyB = `${testUserId.slice(0, 8)}:${trackB}`;
        const keyOther = `${otherUserId.slice(0, 8)}:${trackA}`;

        const idA = await seedMusicSession(sql, testUserId, trackA, keyA);
        const idB = await seedMusicSession(sql, testUserId, trackB, keyB);
        const idOther = await seedMusicSession(sql, otherUserId, trackA, keyOther);

        await stopOtherActiveMusicSessions(sql, testUserId, 'subsonic', keyB);

        // Other user's session must be untouched
        const sOther = await fetchSession(sql, idOther);
        expect(sOther?.status).toBe('ACTIVE');

        // Just verify our fixture clean-up is correct
        const sA = await fetchSession(sql, idA);
        expect(sA?.status).toBe('COMPLETED');
        const sB = await fetchSession(sql, idB);
        expect(sB?.status).toBe('ACTIVE');
    });

    it('returns an empty array when there are no other active sessions', async () => {
        const keyA = `${testUserId.slice(0, 8)}:${trackA}`;
        await seedMusicSession(sql, testUserId, trackA, keyA);

        const closed = await stopOtherActiveMusicSessions(sql, testUserId, 'subsonic', keyA);
        expect(closed).toHaveLength(0);
    });

    it('works with audio_transcode play_method', async () => {
        const keyA = `${testUserId.slice(0, 8)}:${trackA}`;
        const keyB = `${testUserId.slice(0, 8)}:${trackB}`;
        const idA = await seedMusicSession(sql, testUserId, trackA, keyA, 'audio_transcode');
        await seedMusicSession(sql, testUserId, trackB, keyB, 'audio_transcode');

        const closed = await stopOtherActiveMusicSessions(sql, testUserId, 'subsonic', keyB);

        expect(closed.some((c) => c.id === idA)).toBe(true);
        const sA = await fetchSession(sql, idA);
        expect(sA?.status).toBe('COMPLETED');
    });
});
