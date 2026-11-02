// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Watch-State Rebuilder Service
 *
 * Exercises the full event-driven write path against a real Postgres
 * instance: appendEventAndRebuild → user_media_events INSERT →
 * user_media_state UPSERT. Assertions query both tables directly.
 *
 * Requires TEST_DATABASE_URL (or DATABASE_URL) pointing to a live
 * PostgreSQL with the lumastra schema applied.
 *
 * Run with:
 *   DATABASE_URL="..." TEST_DATABASE_URL="..." npx vitest run src/lib/server/services/watch-state-rebuilder.service.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    generateTestUserId,
    ensureTestUser,
} from '../../../../tests/integration/fixtures/index.js';
import { appendEventAndRebuild, rebuildAllStatesForUser } from './watch-state-rebuilder.service.js';
import {
    getEventsSinceLastSnapshot,
    getEventsSinceLastSnapshotForUser,
} from '../database/queries/user-media-events.queries.js';
import type {
    NewUserMediaEvent,
    UserMediaEvent,
} from '../database/queries/user-media-events.queries.js';
import type { UserMediaStateRow } from '../database/queries/user-media-state.queries.js';
import { setFlag, hasFlag } from '../database/queries/user-media-flags.queries.js';
import type { UserId } from '$lib/shared/user-id.js';

// =============================================================================
// Skip guard — mirrors the pattern in recommendations.integration.test.ts
// =============================================================================

const SKIP_TESTS = !process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL;

// =============================================================================
// Helpers
// =============================================================================

/** Tables that must be wiped between tests. */
const EVENT_TABLES = ['user_media_events', 'user_media_state', 'user_media_flags'] as const;

/**
 * Query all live (non-repudiated) events for (user, media).
 */
async function queryEvents(
    sql: postgres.Sql,
    userId: string,
    mediaId: string,
): Promise<
    {
        id: string;
        event_type: string;
        position_ms: number | null;
        runtime_ms: number | null;
        session_id: string | null;
        event_seq: number | null;
    }[]
> {
    return sql`
        SELECT id, event_type, position_ms, runtime_ms, session_id, event_seq
        FROM user_media_events
        WHERE user_id = ${userId}
          AND media_id = ${mediaId}
          AND repudiated_at IS NULL
        ORDER BY occurred_at ASC, recorded_at ASC
    `;
}

/**
 * Query the derived state row for (user, media).
 */
async function queryState(
    sql: postgres.Sql,
    userId: string,
    mediaId: string,
): Promise<UserMediaStateRow | null> {
    const rows = await sql<UserMediaStateRow[]>`
        SELECT *
        FROM user_media_state
        WHERE user_id = ${userId}
          AND media_id = ${mediaId}
    `;
    return rows[0] ?? null;
}

/**
 * Returns an ISO string for (base + offsetMinutes).
 */
function isoAt(base: Date, offsetMinutes: number): string {
    return new Date(base.getTime() + offsetMinutes * 60_000).toISOString();
}

// =============================================================================
// Test suite
// =============================================================================

describe.skipIf(SKIP_TESTS)('Watch-State Rebuilder — integration', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        // Truncate in dependency order. user_media_flags and user_media_state
        // reference user_media_events only indirectly (no FK), so order here
        // is for clarity. CASCADE handles any implicit dependencies.
        const tablesToClear: string[] = [
            ...EVENT_TABLES,
            'user_profiles',
            'media_items',
            'external_ids',
        ];
        await truncateTables(sql, tablesToClear);
    });

    // =========================================================================
    // Test 0 — Offline blind-spot guard, end to end through the real INSERT
    // =========================================================================

    it('an offline report written to the DB cannot lower a resume point set while it was offline', async () => {
        // The unit tests cover `computeStateFromEvents` in isolation; this
        // covers the half they cannot — that `knowledge_as_of` survives the
        // INSERT and is read back by the rebuilder. Dropping the column from
        // either statement is silent: the record still ingests, the state
        // still updates, and the guard just quietly never fires.
        const userId = generateTestUserId();
        const { id: mediaId } = await createAndInsertTestMovie(sql);
        await ensureTestUser(sql, userId);

        // Keep the whole timeline historical: device timestamps are bounded at ingest.
        const now = new Date(Date.now() - 3 * 60 * 60_000);

        // The phone last read the server here, then went offline.
        const knownAsOf = isoAt(now, 0);

        // Another device listened on past it while the phone was away.
        const elsewhere: NewUserMediaEvent = {
            user_id: userId,
            media_id: mediaId,
            event_type: 'progress',
            source: 'audiobookshelf-sync',
            position_ms: 9_626_337,
            runtime_ms: 75_423_791,
            source_event_id: null,
            session_id: null,
            event_seq: null,
            occurred_at: isoAt(now, 60),
        };
        expect(await appendEventAndRebuild(sql, elsewhere)).toBe(true);
        expect(Number((await queryState(sql, userId, mediaId))!.resume_position_ms)).toBe(
            9_626_337,
        );

        // The phone flushes later, from a position it resolved before any of
        // that happened. Latest-occurred_at-wins would hand it the resume
        // point and — for an audiobook — push it to AudiobookShelf.
        const fromThePhone: NewUserMediaEvent = {
            user_id: userId,
            media_id: mediaId,
            event_type: 'progress',
            source: 'lumastra-offline',
            position_ms: 8_400_000,
            runtime_ms: 75_423_791,
            source_event_id: 'offline:blind-spot-1',
            session_id: null,
            event_seq: null,
            session_elapsed_ms: 600_000,
            knowledge_as_of: knownAsOf,
            occurred_at: isoAt(now, 120),
        };
        expect(await appendEventAndRebuild(sql, fromThePhone)).toBe(true);

        // Read the column back explicitly rather than through `queryEvents`,
        // which projects a fixed subset. This assertion is the point of the
        // test: the guard cannot fire on a value the INSERT dropped.
        const [offlineRow] = await sql<{ knowledge_as_of: Date | null }[]>`
            SELECT knowledge_as_of
            FROM user_media_events
            WHERE user_id = ${userId}
              AND media_id = ${mediaId}
              AND source = 'lumastra-offline'
        `;
        expect(offlineRow).toBeDefined();
        expect(offlineRow.knowledge_as_of).not.toBeNull();
        expect(new Date(offlineRow.knowledge_as_of!).toISOString()).toBe(knownAsOf);

        const state = await queryState(sql, userId, mediaId);
        expect(Number(state!.resume_position_ms)).toBe(9_626_337);
    });

    it('an offline report still advances the resume point past the position it could not see', async () => {
        // The other half of the guard, on the same path: raising only. A
        // guard that also blocked this would silently discard every offline
        // listen that ran past another device.
        const userId = generateTestUserId();
        const { id: mediaId } = await createAndInsertTestMovie(sql);
        await ensureTestUser(sql, userId);

        // Keep the whole timeline historical: device timestamps are bounded at ingest.
        const now = new Date(Date.now() - 3 * 60 * 60_000);

        await appendEventAndRebuild(sql, {
            user_id: userId,
            media_id: mediaId,
            event_type: 'progress',
            source: 'audiobookshelf-sync',
            position_ms: 9_626_337,
            runtime_ms: 75_423_791,
            source_event_id: null,
            session_id: null,
            event_seq: null,
            occurred_at: isoAt(now, 60),
        });

        await appendEventAndRebuild(sql, {
            user_id: userId,
            media_id: mediaId,
            event_type: 'progress',
            source: 'lumastra-offline',
            position_ms: 11_557_085,
            runtime_ms: 75_423_791,
            source_event_id: 'offline:blind-spot-2',
            session_id: null,
            event_seq: null,
            session_elapsed_ms: 1_486_144,
            knowledge_as_of: isoAt(now, 0),
            occurred_at: isoAt(now, 120),
        });

        const state = await queryState(sql, userId, mediaId);
        expect(Number(state!.resume_position_ms)).toBe(11_557_085);
    });

    // =========================================================================
    // Test 1 — Progress event path
    // =========================================================================

    it('progress events accumulate in user_media_events and update user_media_state', async () => {
        const userId = generateTestUserId();
        const { id: mediaId } = await createAndInsertTestMovie(sql);
        await ensureTestUser(sql, userId);

        const now = new Date();

        const event1: NewUserMediaEvent = {
            user_id: userId,
            media_id: mediaId,
            event_type: 'progress',
            source: 'lumastra-player',
            position_ms: 30_000,
            runtime_ms: 5_400_000,
            source_event_id: null,
            session_id: 'sess-1',
            event_seq: 1,
            occurred_at: isoAt(now, 0),
        };

        const accepted1 = await appendEventAndRebuild(sql, event1);
        expect(accepted1).toBe(true);

        // After first event: exactly one event row
        const eventsAfter1 = await queryEvents(sql, userId, mediaId);
        expect(eventsAfter1).toHaveLength(1);
        expect(eventsAfter1[0].event_type).toBe('progress');
        expect(eventsAfter1[0].session_id).toBe('sess-1');
        expect(eventsAfter1[0].event_seq).toBe(1);

        // State row: not watched, position at 30 000, runtime set, watch_count 0
        const state1 = await queryState(sql, userId, mediaId);
        expect(state1).not.toBeNull();
        expect(state1!.is_watched).toBe(false);
        expect(Number(state1!.resume_position_ms)).toBe(30_000);
        expect(Number(state1!.runtime_ms)).toBe(5_400_000);
        expect(Number(state1!.watch_count)).toBe(0);

        // Second event — same session, higher seq
        const event2: NewUserMediaEvent = {
            ...event1,
            position_ms: 120_000,
            event_seq: 2,
            occurred_at: isoAt(now, 1),
        };

        const accepted2 = await appendEventAndRebuild(sql, event2);
        expect(accepted2).toBe(true);

        // Two events now
        const eventsAfter2 = await queryEvents(sql, userId, mediaId);
        expect(eventsAfter2).toHaveLength(2);

        // State row updated: position advances to 120 000
        const state2 = await queryState(sql, userId, mediaId);
        expect(state2).not.toBeNull();
        expect(Number(state2!.resume_position_ms)).toBe(120_000);
    });

    // =========================================================================
    // Test 2 — mark_watched event path
    // =========================================================================

    it('mark_watched event sets is_watched=true and populates watched timestamps', async () => {
        const userId = generateTestUserId();
        const { id: mediaId } = await createAndInsertTestMovie(sql);
        await ensureTestUser(sql, userId);

        const now = new Date();

        const event: NewUserMediaEvent = {
            user_id: userId,
            media_id: mediaId,
            event_type: 'mark_watched',
            source: 'lumastra-user-mark',
            position_ms: null,
            runtime_ms: 5_400_000,
            source_event_id: null,
            session_id: null,
            event_seq: null,
            occurred_at: isoAt(now, 0),
        };

        const accepted = await appendEventAndRebuild(sql, event);
        expect(accepted).toBe(true);

        // Event row exists
        const events = await queryEvents(sql, userId, mediaId);
        expect(events).toHaveLength(1);
        expect(events[0].event_type).toBe('mark_watched');

        // State row: watched, position zeroed, count 1, timestamps set
        const state = await queryState(sql, userId, mediaId);
        expect(state).not.toBeNull();
        expect(state!.is_watched).toBe(true);
        expect(Number(state!.resume_position_ms)).toBe(0);
        expect(Number(state!.watch_count)).toBe(1);
        expect(state!.first_watched_at).not.toBeNull();
        expect(state!.last_watched_at).not.toBeNull();
    });

    // =========================================================================
    // Test 3 — Stale-tab rejection
    // =========================================================================

    it('rejects a stale-session event and leaves state reflecting the fresh session', async () => {
        const userId = generateTestUserId();
        const { id: mediaId } = await createAndInsertTestMovie(sql);
        await ensureTestUser(sql, userId);

        const base = new Date();

        // t(N) helper: N minutes from base
        const t = (n: number) => isoAt(base, n);

        // Seed: fresh session started at t(20), event at t(30), seq 5
        const freshEvent: NewUserMediaEvent = {
            user_id: userId,
            media_id: mediaId,
            event_type: 'progress',
            source: 'lumastra-player',
            position_ms: 60_000,
            runtime_ms: 5_400_000,
            source_event_id: null,
            session_id: 'new-session',
            event_seq: 5,
            session_started_at: t(20),
            occurred_at: t(30),
        };

        const seedAccepted = await appendEventAndRebuild(sql, freshEvent);
        expect(seedAccepted).toBe(true);

        // Verify seed is in DB
        const eventsBeforeStale = await queryEvents(sql, userId, mediaId);
        expect(eventsBeforeStale).toHaveLength(1);

        // Stale tab: older session (started at t(0)), higher seq but stale
        const staleEvent: NewUserMediaEvent = {
            user_id: userId,
            media_id: mediaId,
            event_type: 'progress',
            source: 'lumastra-player',
            position_ms: 9_000_000, // absurd position that must not win
            runtime_ms: 5_400_000,
            source_event_id: null,
            session_id: 'old-session',
            event_seq: 99,
            session_started_at: t(0),
            occurred_at: t(35),
        };

        const staleAccepted = await appendEventAndRebuild(sql, staleEvent);

        // Guard must have rejected it
        expect(staleAccepted).toBe(false);

        // Still only one event row — stale event was NOT inserted
        const eventsAfterStale = await queryEvents(sql, userId, mediaId);
        expect(eventsAfterStale).toHaveLength(1);
        expect(eventsAfterStale[0].session_id).toBe('new-session');

        // State still reflects the fresh session's position
        const state = await queryState(sql, userId, mediaId);
        expect(state).not.toBeNull();
        expect(Number(state!.resume_position_ms)).toBe(60_000);
    });

    // =========================================================================
    // H18 — batched rebuildAllStatesForUser
    // =========================================================================

    /** Minimal progress event for a (user, media) at a given minute offset. */
    function progressEvent(
        userId: UserId,
        mediaId: string,
        base: Date,
        positionMs: number,
        offsetMin: number,
        seq: number,
    ): NewUserMediaEvent {
        return {
            user_id: userId,
            media_id: mediaId,
            event_type: 'progress',
            source: 'lumastra-player',
            position_ms: positionMs,
            runtime_ms: 5_400_000,
            source_event_id: null,
            session_id: `sess-${mediaId}`,
            event_seq: seq,
            occurred_at: isoAt(base, offsetMin),
        };
    }

    it('rebuildAllStatesForUser rebuilds every media from one batched read (H18)', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const { id: m1 } = await createAndInsertTestMovie(sql);
        const { id: m2 } = await createAndInsertTestMovie(sql);
        const { id: m3 } = await createAndInsertTestMovie(sql);
        const now = new Date();

        await appendEventAndRebuild(sql, progressEvent(userId, m1, now, 45_000, 0, 1));
        await appendEventAndRebuild(sql, progressEvent(userId, m2, now, 60_000, 1, 1));
        await appendEventAndRebuild(sql, progressEvent(userId, m3, now, 90_000, 2, 1));

        // Corrupt m1's materialised state so the rebuild has something to correct.
        await sql`
            UPDATE user_media_state SET resume_position_ms = 999
            WHERE user_id = ${userId} AND media_id = ${m1}
        `;

        // Batched rebuild inside a transaction (mirrors the repudiate caller).
        const count = await sql.begin((tx) =>
            rebuildAllStatesForUser(tx as unknown as postgres.Sql, userId),
        );
        expect(count).toBe(3);

        const [s1, s2, s3] = await Promise.all([
            queryState(sql, userId, m1),
            queryState(sql, userId, m2),
            queryState(sql, userId, m3),
        ]);
        // m1 rebuilt back from its events (corruption overwritten).
        expect(Number(s1!.resume_position_ms)).toBe(45_000);
        expect(Number(s2!.resume_position_ms)).toBe(60_000);
        expect(Number(s3!.resume_position_ms)).toBe(90_000);
    });

    it('batch getEventsSinceLastSnapshotForUser matches the single-media query per media (H18)', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const { id: m1 } = await createAndInsertTestMovie(sql);
        const { id: m2 } = await createAndInsertTestMovie(sql);
        const now = new Date();

        await appendEventAndRebuild(sql, progressEvent(userId, m1, now, 10_000, 0, 1));
        await appendEventAndRebuild(sql, progressEvent(userId, m1, now, 20_000, 1, 2));
        await appendEventAndRebuild(sql, progressEvent(userId, m2, now, 30_000, 2, 1));

        const batch = await getEventsSinceLastSnapshotForUser(sql, userId, [m1, m2]);
        const byMedia = new Map<string, UserMediaEvent[]>();
        for (const e of batch) {
            const arr = byMedia.get(e.media_id);
            if (arr) arr.push(e);
            else byMedia.set(e.media_id, [e]);
        }

        // For each media the batched slice must equal the single-media query —
        // same events, same order (proves the shared per-media snapshot boundary).
        for (const mediaId of [m1, m2]) {
            const single = await getEventsSinceLastSnapshot.all(sql, { userId, mediaId });
            const batched = byMedia.get(mediaId) ?? [];
            expect(batched.map((e) => e.id)).toEqual(single.map((e) => e.id));
        }
    });

    // =========================================================================
    // Auto-clear dismissal on engagement — jellyfin-sync must NOT resurrect
    // a Continue-Watching dismissal (regression, reported 2026-07-13: a
    // dismissed item reappeared in CW after an untouched background sync).
    // =========================================================================

    it('a jellyfin-sync progress event does not clear a Continue-Watching dismissal', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const { id: mediaId } = await createAndInsertTestMovie(sql);

        await setFlag.execute(sql, {
            userId,
            targetId: mediaId,
            targetType: 'movie',
            flagType: 'dismissed_cw',
        });
        expect(await hasFlag(sql, { userId, targetId: mediaId, flagType: 'dismissed_cw' })).toBe(
            true,
        );

        const now = new Date();
        // Background sync, minutes after the dismissal, with a position that
        // has drifted — exactly the shape of an unrequested resync catching
        // up with Jellyfin's own resume list.
        await appendEventAndRebuild(sql, {
            user_id: userId,
            media_id: mediaId,
            event_type: 'progress',
            source: 'jellyfin-sync',
            position_ms: 45_000,
            runtime_ms: 5_400_000,
            source_event_id: null,
            session_id: null,
            event_seq: null,
            occurred_at: isoAt(now, 5),
        });

        expect(await hasFlag(sql, { userId, targetId: mediaId, flagType: 'dismissed_cw' })).toBe(
            true,
        );
    });

    it('a lumastra-player progress event still clears a Continue-Watching dismissal', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const { id: mediaId } = await createAndInsertTestMovie(sql);

        await setFlag.execute(sql, {
            userId,
            targetId: mediaId,
            targetType: 'movie',
            flagType: 'dismissed_cw',
        });

        const now = new Date();
        await appendEventAndRebuild(sql, {
            user_id: userId,
            media_id: mediaId,
            event_type: 'progress',
            source: 'lumastra-player',
            position_ms: 45_000,
            runtime_ms: 5_400_000,
            source_event_id: null,
            session_id: 'sess-reengage',
            event_seq: 1,
            occurred_at: isoAt(now, 5),
        });

        expect(await hasFlag(sql, { userId, targetId: mediaId, flagType: 'dismissed_cw' })).toBe(
            false,
        );
    });
});
