// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Characterises WHEN the "superseded" signal reaches a web tab today, for the
// cross-device scenario behind the implicit resume handoff
// (docs/superpowers/specs/2026-10-22-implicit-resume-handoff.md, step 1):
//
//   tab A plays episode A, pauses, stays open → the TV continues A (and maybe
//   autoplays into B) → tab A comes back.
//
// The supersede signal has two sources:
//   1. same (user, media, DEVICE) start → the old row is KILLED 'superseded'
//      and an SSE `session_terminated` goes out (play-sessions.service.ts).
//   2. cross-device: a heartbeat whose progress write loses to a NEWER session
//      of the same (user, media) gets `action: 'superseded'` back
//      (play-session-lifecycle.service.ts, handleHeartbeat).
// These tests pin path 2 for a paused tab and a playing tab.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../tests/integration/fixtures/user.fixtures.js';
import { createPlaySession } from '$lib/server/database/queries/play-sessions.queries.js';
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
} from '$lib/server/services/play-session-lifecycle.service.js';
import { MIN_ENGAGEMENT_MS } from '$lib/server/utils/watch-constants.js';

const SERIES_ID = '00000000-0000-4000-a000-0000000000a0';
const SEASON_ID = '00000000-0000-4000-a000-0000000000a1';
const EP_A = '00000000-0000-4000-a000-0000000000e1';
const EP_B = '00000000-0000-4000-a000-0000000000e2';
const USER = generateTestUserId();
const TAB = 'dashboard-tab-a';
const TV = 'appletv-living-room';
const RUNTIME_MS = 40 * 60 * 1000;

function watchManagerFor(sql: postgres.Sql): WatchManagerLike {
    return {
        async reportProgress(params, txSql?) {
            return appendEventAndRebuildWithOutcome(txSql ?? sql, {
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
                occurred_at: new Date().toISOString(),
                session_started_at: params.sessionStartedAt?.toISOString() ?? null,
            });
        },
        async markWatched(params, txSql) {
            await appendEventAndRebuild(txSql ?? sql, {
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

describe('cross-device supersede (characterisation)', () => {
    let sql: postgres.Sql;
    let service: PlaySessionLifecycleService;

    beforeAll(async () => {
        sql = getTestDb();
        await sql`SELECT 1`;
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
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
        ]);
        await sql`
            INSERT INTO media_items (id, title, media_type, status) VALUES
                (${SERIES_ID}::uuid, 'Harbour Lights', 'tv', 'active')
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, parent_id, season_number) VALUES
                (${SEASON_ID}::uuid, 'Season 1', 'season', 'active', ${SERIES_ID}::uuid, 1)
        `;
        await sql`
            INSERT INTO media_items
                (id, title, media_type, status, parent_id, season_number, episode_number, runtime_seconds)
            VALUES
                (${EP_A}::uuid, 'Low Tide', 'episode', 'active', ${SEASON_ID}::uuid, 1, 1, ${RUNTIME_MS / 1000}),
                (${EP_B}::uuid, 'High Tide', 'episode', 'active', ${SEASON_ID}::uuid, 1, 2, ${RUNTIME_MS / 1000})
        `;
        await ensureTestUser(sql, USER);
        service = new PlaySessionLifecycleService({
            watchManager: watchManagerFor(sql),
            watchHistoryService,
            queries: playSessionsQueries,
            getMediaMetadata: getMediaMetadataForHistory,
            getSql: () => sql,
        });
    });

    async function start(mediaId: string, deviceId: string) {
        return createPlaySession(sql, {
            surface: 'web',
            media_id: mediaId,
            user_id: USER,
            device_id: deviceId,
            ip_address: '127.0.0.1',
            play_method: 'direct',
            position_ms: 0,
            runtime_ms: RUNTIME_MS,
        });
    }

    async function beat(
        sessionId: string,
        status: 'ACTIVE' | 'PAUSED',
        positionMs: number,
        seq: number,
    ) {
        return service.update(sessionId, {
            status,
            position_ms: positionMs,
            event_seq: seq,
            session_elapsed_ms: MIN_ENGAGEMENT_MS + seq * 1000,
        });
    }

    /** Tab A watched 10 minutes of episode A and paused there. */
    async function tabPausedAtTenMinutes() {
        const tab = await start(EP_A, TAB);
        await beat(tab.id, 'ACTIVE', 10 * 60_000, 1);
        await beat(tab.id, 'PAUSED', 10 * 60_000, 2);
        // started_at decides "newer session"; keep the TV strictly later.
        await new Promise((r) => setTimeout(r, 20));
        return tab;
    }

    it('a PAUSED tab is never told: its keepalive is an idle no-op even after the TV took the same episode over', async () => {
        const tab = await tabPausedAtTenMinutes();
        const tv = await start(EP_A, TV);
        await beat(tv.id, 'ACTIVE', 25 * 60_000, 1);
        await beat(tv.id, 'PAUSED', 25 * 60_000, 2);

        // The tab's 30 s keepalive: same position as its own last durable write.
        const ack = await beat(tab.id, 'PAUSED', 10 * 60_000, 3);
        expect(ack).toBeDefined();
        expect(ack && 'action' in ack ? ack.action : undefined).toBeUndefined();

        // The tab's own row was not touched by the TV start (different device).
        const [row] = await sql<{ status: string }[]>`
            SELECT status FROM play_sessions WHERE id = ${tab.id}::uuid
        `;
        expect(row.status).toBe('PAUSED');
    });

    it('a PLAYING tab gets superseded (reason session_superseded) on its next moving heartbeat', async () => {
        const tab = await tabPausedAtTenMinutes();
        const tv = await start(EP_A, TV);
        await beat(tv.id, 'ACTIVE', 25 * 60_000, 1);

        // The user presses Play in tab A: the next heartbeat moves the playhead.
        const ack = await beat(tab.id, 'ACTIVE', 10 * 60_000 + 15_000, 3);
        expect(ack && 'action' in ack ? ack.action : undefined).toBe('superseded');
        expect(ack && 'reason' in ack ? ack.reason : undefined).toBe('session_superseded');
    });

    it('when the TV moved on to episode B, the playing tab is still superseded on A (the TV session on A is newer)', async () => {
        const tab = await tabPausedAtTenMinutes();
        const tvA = await start(EP_A, TV);
        await beat(tvA.id, 'ACTIVE', RUNTIME_MS - 30_000, 1);
        await service.update(tvA.id, {
            status: 'COMPLETED',
            position_ms: RUNTIME_MS - 30_000,
            event_seq: 2,
            session_elapsed_ms: MIN_ENGAGEMENT_MS + 60_000,
        });
        const tvB = await start(EP_B, TV);
        await beat(tvB.id, 'PAUSED', 7 * 60_000, 1);

        const paused = await beat(tab.id, 'PAUSED', 10 * 60_000, 3);
        expect(paused && 'action' in paused ? paused.action : undefined).toBeUndefined();

        const playing = await beat(tab.id, 'ACTIVE', 10 * 60_000 + 15_000, 4);
        expect(playing && 'action' in playing ? playing.action : undefined).toBe('superseded');
    });

    it('if the TV only ever played episode B, tab A on episode A is never superseded', async () => {
        const tab = await tabPausedAtTenMinutes();
        const tvB = await start(EP_B, TV);
        await beat(tvB.id, 'ACTIVE', 7 * 60_000, 1);

        const playing = await beat(tab.id, 'ACTIVE', 10 * 60_000 + 15_000, 3);
        expect(playing && 'action' in playing ? playing.action : undefined).toBeUndefined();
    });
});
