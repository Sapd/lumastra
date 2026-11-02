// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { toUserId } from '$lib/shared/user-id.js';
import { config } from '../config.js';
import { aiDbService } from './database.service.js';
import { watchManager } from './watch-manager.service.js';
import { watchSyncEngine } from './watch-sync-engine.service.js';
import { appendEventAndRebuild } from './watch-state-rebuilder.service.js';
import { PluginSecrets } from '../tasks/secrets.js';
import { CatalogService } from './catalog.service.js';
import { audiobookshelfWatchSync } from '../tasks/builtin/native/watch-sync/audiobookshelf.js';

const { fetch } = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('$lib/server/utils/fetch-timeout.js', () => ({ fetchWithTimeout: fetch }));

// ABS 2.37.2 MediaProgress.applyProgressUpdate: a changed currentTime away
// from the end clears completion, even when the same PATCH sets isFinished.
// Explicit unfinish resets currentTime. A 200 alone cannot prove either flag.
// https://github.com/advplyr/audiobookshelf/blob/v2.37.2/server/models/MediaProgress.js
function progressServer(
    initiallyFinished: boolean,
    itemId: string,
): {
    isFinished: boolean;
    currentTime: number;
    duration: number;
    lastUpdate: number;
} {
    const state = {
        isFinished: initiallyFinished,
        currentTime: 1400,
        duration: 3600,
        lastUpdate: 0,
    };
    fetch.mockImplementation(async (url: string, init: RequestInit) => {
        if (!init.method || init.method === 'GET') {
            return Response.json({
                id: 'listener',
                username: 'listener',
                mediaProgress: [
                    {
                        ...state,
                        libraryItemId: url.includes('/progress/') ? url.split('/').at(-1) : itemId,
                        episodeId: null,
                    },
                ],
            });
        }
        const body = JSON.parse(String(init.body)) as {
            currentTime?: number;
            duration?: number;
            isFinished?: boolean;
        };
        const previousTime = state.currentTime;
        if (body.isFinished === false && state.isFinished) {
            state.currentTime = 0;
            delete body.currentTime;
        }
        Object.assign(state, body);
        const nearEnd = state.duration > 0 && state.duration - state.currentTime < 10;
        if (!state.isFinished && nearEnd) state.isFinished = true;
        else if (state.isFinished && state.currentTime !== previousTime && !nearEnd)
            state.isFinished = false;
        return new Response(null, { status: 200 });
    });
    return state;
}

describe('generic audiobook watched state through the normal push', () => {
    let sql: postgres.Sql;
    const userId = toUserId(crypto.randomUUID());
    const mediaId = crypto.randomUUID();
    const username = `finish-sync-${userId}`;
    beforeAll(async () => {
        sql = getTestDb();
        vi.spyOn(config, 'AUDIOURL', 'get').mockReturnValue('http://abs.test');
        vi.spyOn(config, 'AUDIOAPIKEY', 'get').mockReturnValue('operator');
        vi.spyOn(aiDbService, 'getSql').mockResolvedValue(sql);
        await sql`INSERT INTO users (id, username) VALUES (${userId}::uuid, ${username})`;
        await sql`INSERT INTO media_items (id, title, media_type, status, has_files)
            VALUES (${mediaId}::uuid, 'Completion test', 'audiobook', 'active', true)`;
        await new CatalogService(sql).upsertExternalId(mediaId, {
            provider: 'audiobookshelf',
            id: `book-${mediaId}`,
            mediaType: 'audiobook',
        });
        await new PluginSecrets(sql).setUser('audiobookshelf', userId, 'api_key', 'listener-key');
    });
    beforeEach(async () => {
        await sql`DELETE FROM user_media_events WHERE user_id = ${userId}::uuid`;
        await sql`DELETE FROM user_media_state WHERE user_id = ${userId}::uuid`;
        fetch.mockReset();
        await appendEventAndRebuild(sql, {
            user_id: userId,
            media_id: mediaId,
            event_type: 'progress',
            source: 'lumastra-player',
            position_ms: 1_400_000,
            runtime_ms: 3_600_000,
            source_event_id: null,
            session_id: null,
            event_seq: null,
            occurred_at: new Date().toISOString(),
        });
    });
    afterAll(async () => {
        vi.restoreAllMocks();
        await sql`DELETE FROM media_items WHERE id = ${mediaId}::uuid`;
        await sql`DELETE FROM users WHERE id = ${userId}::uuid`;
        await closeTestDb();
    });
    it.each([true, false])(
        'drains a stale queued watched:%s after another client updates ABS',
        async (watched) => {
            const upstream = progressServer(!watched, `book-${mediaId}`);
            if (watched) await watchManager.markWatched({ userId, mediaId });
            else await watchManager.markUnwatched({ userId, mediaId });
            // A newer progress heartbeat must not launder the old decisive timestamp.
            await sql`UPDATE user_media_events SET occurred_at = now() - INTERVAL '1 hour'
            WHERE user_id = ${userId} AND event_type IN ('mark_watched', 'mark_unwatched')`;
            upstream.lastUpdate = Date.now() - 60_000;
            const [result] = await watchSyncEngine.runPush(
                audiobookshelfWatchSync.id,
                undefined,
                sql,
            );
            expect(result).toMatchObject({ succeeded: 0, failed: 0, skipped: 1 });
            expect(upstream.isFinished).toBe(!watched);
            expect(fetch.mock.calls.some(([, init]) => init.method === 'PATCH')).toBe(false);
            fetch.mockClear();
            await watchSyncEngine.runPush(audiobookshelfWatchSync.id, undefined, sql);
            expect(fetch).not.toHaveBeenCalled();
        },
    );

    it.each([true, false])('propagates watched:%s to ABS', async (watched) => {
        const upstream = progressServer(!watched, `book-${mediaId}`);
        // These are the same service operations used by PATCH watch-state.
        if (watched) await watchManager.markWatched({ userId, mediaId });
        else await watchManager.markUnwatched({ userId, mediaId });
        const result = await watchSyncEngine.runPush(audiobookshelfWatchSync.id, undefined, sql);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ succeeded: 1, failed: 0 });
        expect(fetch).toHaveBeenCalled();
        expect(upstream.isFinished).toBe(watched);
        fetch.mockClear();
        await watchSyncEngine.runPush(audiobookshelfWatchSync.id, undefined, sql);
        expect(fetch).not.toHaveBeenCalled();
    });
});
