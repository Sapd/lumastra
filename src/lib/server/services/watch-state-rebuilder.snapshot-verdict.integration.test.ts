// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A compaction snapshot must not invent a watched verdict.
 *
 * Prod 2026-09-30: an episode the user stopped at 92 % in the Lumastra player
 * was compacted twice. The first snapshot correctly stored
 * `is_watched=false, is_watched_source=null` (no decisive event existed). The
 * second compute read that explicit null through the legacy
 * `last_event_source` fallback, replayed it as a `mark_unwatched` FROM
 * `lumastra-player` (priority 90) and stored that source on every later
 * snapshot. From then on each `jellyfin-sync` mark_watched (priority 10) lost
 * arbitration, the item never became watched, and the pull re-appended the
 * mark every 5 minutes — 17 items, ~166k rows, watch_count in the thousands.
 *
 * Runs the real rebuild + compaction path against a live Postgres.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    generateTestUserId,
    ensureTestUser,
} from '../../../../tests/integration/fixtures/index.js';
import {
    appendEventAndRebuild,
    rebuildStateFromEvents,
    COMPACTION_THRESHOLD,
} from './watch-state-rebuilder.service.js';
import {
    insertEvent,
    type NewUserMediaEvent,
    type SnapshotState,
} from '../database/queries/user-media-events.queries.js';
import type { UserId } from '$lib/shared/user-id.js';

const SKIP_TESTS = !process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL;

const RUNTIME_MS = 2_940_000;

function jellyfinMarkWatched(userId: UserId, mediaId: string): NewUserMediaEvent {
    return {
        user_id: userId,
        media_id: mediaId,
        event_type: 'mark_watched',
        source: 'jellyfin-sync',
        position_ms: null,
        runtime_ms: RUNTIME_MS,
        source_event_id: null,
        session_id: null,
        event_seq: null,
        occurred_at: new Date().toISOString(),
    };
}

async function stateOf(
    sql: postgres.Sql,
    userId: UserId,
    mediaId: string,
): Promise<{ is_watched: boolean; watch_count: number }> {
    const [row] = await sql<Array<{ is_watched: boolean; watch_count: number }>>`
        SELECT is_watched, watch_count FROM user_media_state
        WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid
    `;
    return row;
}

/** Writes a snapshot row directly, in the exact shape prod carries. */
async function insertSnapshot(
    sql: postgres.Sql,
    userId: UserId,
    mediaId: string,
    state: SnapshotState,
): Promise<void> {
    await insertEvent.execute(sql, {
        event: {
            user_id: userId,
            media_id: mediaId,
            event_type: 'state_snapshot',
            source: 'compaction',
            position_ms: null,
            runtime_ms: null,
            source_event_id: null,
            session_id: null,
            event_seq: null,
            occurred_at: new Date(Date.now() - 60_000).toISOString(),
            snapshot_state: state,
        },
    });
}

const UNWATCHED_SNAPSHOT: Omit<SnapshotState, 'is_watched_source'> = {
    is_watched: false,
    resume_position_ms: 2_717_103,
    runtime_ms: RUNTIME_MS,
    watch_count: 0,
    first_watched_at: null,
    last_watched_at: null,
    last_event_at: new Date(Date.now() - 120_000).toISOString(),
    last_event_source: 'lumastra-player',
    highest_session_elapsed_ms: 2_717_103,
};

describe.skipIf(SKIP_TESTS)('watch-state rebuilder — snapshot verdict source', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'user_media_events',
            'user_media_state',
            'user_media_flags',
            'media_items',
            'external_ids',
            'user_profiles',
        ]);
    });

    it('a twice-compacted player-only item still accepts a later sync mark_watched', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const { id: mediaId } = await createAndInsertTestMovie(sql, { title: 'Stopped at 92%' });

        // Two compaction rounds of player heartbeats, ending at ~92 %.
        const sessionId = randomUUID();
        const heartbeats = COMPACTION_THRESHOLD * 2;
        const startMs = Date.now() - 3 * 3_600_000;
        for (let i = 0; i < heartbeats; i++) {
            expect(
                await appendEventAndRebuild(sql, {
                    user_id: userId,
                    media_id: mediaId,
                    event_type: 'progress',
                    source: 'lumastra-player',
                    position_ms: Math.round(((i + 1) / heartbeats) * 0.92 * RUNTIME_MS),
                    runtime_ms: RUNTIME_MS,
                    source_event_id: null,
                    session_id: sessionId,
                    event_seq: i + 1,
                    occurred_at: new Date(startMs + i * 30_000).toISOString(),
                }),
            ).toBe(true);
        }

        const snapshots = await sql<Array<{ s: SnapshotState }>>`
            SELECT snapshot_state AS s FROM user_media_events
            WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid
              AND event_type = 'state_snapshot'
            ORDER BY recorded_at
        `;
        // The second one is the snapshot that used to be poisoned.
        expect(snapshots.length).toBeGreaterThanOrEqual(2);
        for (const { s } of snapshots) {
            expect(s.is_watched).toBe(false);
            expect(s.is_watched_source).toBeNull();
        }

        await appendEventAndRebuild(sql, jellyfinMarkWatched(userId, mediaId));

        expect(await stateOf(sql, userId, mediaId)).toEqual({ is_watched: true, watch_count: 1 });
    });

    it('heals a snapshot already poisoned with a negative verdict from lumastra-player', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const { id: mediaId } = await createAndInsertTestMovie(sql, { title: 'Poisoned' });

        await insertSnapshot(sql, userId, mediaId, {
            ...UNWATCHED_SNAPSHOT,
            is_watched_source: 'lumastra-player',
        });
        await insertEvent.execute(sql, { event: jellyfinMarkWatched(userId, mediaId) });

        const computed = await rebuildStateFromEvents(sql, { userId, mediaId });

        expect(computed?.is_watched).toBe(true);
        expect(computed?.is_watched_source).toBe('jellyfin-sync');
        expect(await stateOf(sql, userId, mediaId)).toEqual({ is_watched: true, watch_count: 1 });
    });

    it('still lets a real user-mark negative in a snapshot outrank a sync mark_watched', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const { id: mediaId } = await createAndInsertTestMovie(sql, { title: 'Unmarked by user' });

        await insertSnapshot(sql, userId, mediaId, {
            ...UNWATCHED_SNAPSHOT,
            is_watched_source: 'lumastra-user-mark',
            last_event_source: 'lumastra-user-mark',
        });
        await insertEvent.execute(sql, { event: jellyfinMarkWatched(userId, mediaId) });

        const computed = await rebuildStateFromEvents(sql, { userId, mediaId });

        expect(computed?.is_watched).toBe(false);
        expect(computed?.is_watched_source).toBe('lumastra-user-mark');
    });
});
