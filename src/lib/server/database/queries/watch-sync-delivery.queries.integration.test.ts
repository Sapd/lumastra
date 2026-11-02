// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    ensureTestUser,
    generateTestUserId,
    createAndInsertTestMovie,
} from '../../../../../tests/integration/fixtures/index.js';
import {
    appendEventAndRebuild,
    computeStateFromEvents,
} from '../../services/watch-state-rebuilder.service.js';
import {
    getEventsForMedia,
    getUnpushedLumastraItems,
    markEventsPushed,
    insertEvent,
    type UserMediaEvent,
} from './user-media-events.queries.js';
import { deferSyncDelivery } from './watch-sync-delivery.queries.js';
import { getState } from './user-media-state.queries.js';
import { queryJellyfinDeliveryStatus } from './jellyfin-file-pairing.queries.js';

describe('durable watch-sync delivery (real PostgreSQL)', () => {
    let sql: postgres.Sql;
    let userId: ReturnType<typeof generateTestUserId>;
    let mediaId: string;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, [
            'jellyfin_file_inventory',
            'user_media_events',
            'user_media_state',
            'media_items',
        ]);
        userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        ({ id: mediaId } = await createAndInsertTestMovie(sql));
        await mark('mark_unwatched');
    });
    async function mark(event_type: 'mark_unwatched' | 'mark_watched'): Promise<void> {
        await appendEventAndRebuild(sql, {
            user_id: userId,
            media_id: mediaId,
            event_type,
            source: 'lumastra-user-mark',
            position_ms: null,
            runtime_ms: 60000,
            source_event_id: null,
            session_id: null,
            event_seq: null,
            occurred_at: new Date().toISOString(),
        });
    }
    async function ids(): Promise<string[]> {
        return (await getEventsForMedia.all(sql, { userId, mediaId })).map((e) => e.id);
    }

    it('backs off both queue scopes, doubles to one day, and reports a record only once', async () => {
        const eventIds = await ids();
        for (let n = 1; n <= 12; n++) {
            const result = await deferSyncDelivery(sql, 'jellyfin', userId, eventIds, 'HTTP 403');
            expect(result.firstReport).toBe(n === 1);
            const [row] = await sql<{ attempts: number; minutes: number; reason: string }[]>`
                SELECT (sync_delivery -> 'jellyfin' ->> 'attempts')::int AS attempts,
                    EXTRACT(EPOCH FROM ((sync_delivery -> 'jellyfin' ->> 'next_attempt_at')::timestamptz - now())) / 60 AS minutes,
                    sync_delivery -> 'jellyfin' ->> 'last_reason' AS reason
                FROM user_media_events WHERE id = ${eventIds[0]}
            `;
            expect(row.attempts).toBe(n);
            expect(Number(row.minutes)).toBeCloseTo(Math.min(1440, 10 * 2 ** (n - 1)), 1);
            expect(row.reason).toBe('HTTP 403');
        }
        for (const userScopes of [undefined, [{ userId, since: null }]]) {
            expect(
                await getUnpushedLumastraItems.all(sql, {
                    provider: 'jellyfin',
                    limit: 200,
                    userScopes,
                    respectBackoff: true,
                }),
            ).toHaveLength(0);
        }
        expect(
            await getUnpushedLumastraItems.all(sql, {
                provider: 'other',
                limit: 200,
                respectBackoff: true,
            }),
        ).toHaveLength(1);
        await sql`UPDATE user_media_events SET sync_delivery = jsonb_set(sync_delivery, '{jellyfin,next_attempt_at}', to_jsonb(now() - INTERVAL '1 minute'))`;
        expect(
            await getUnpushedLumastraItems.all(sql, {
                provider: 'jellyfin',
                limit: 200,
                respectBackoff: true,
            }),
        ).toHaveLength(1);
    });

    it('playback-only queue scopes exclude user marks and decisive exports', async () => {
        await sql`UPDATE media_items SET media_type = 'audiobook' WHERE id = ${mediaId}::uuid`;
        const oldIds = await ids();
        await appendEventAndRebuild(sql, {
            user_id: userId,
            media_id: mediaId,
            event_type: 'progress',
            source: 'lumastra-player',
            position_ms: 30000,
            runtime_ms: 60000,
            source_event_id: null,
            session_id: null,
            event_seq: null,
            occurred_at: new Date().toISOString(),
        });
        const [item] = await getUnpushedLumastraItems.all(sql, {
            provider: 'audiobookshelf',
            limit: 200,
            userScopes: [{ userId, since: null, playbackOnly: true }],
        });
        expect(item.latest_decisive_event_type).toBeNull();
        expect(item.event_ids).toHaveLength(1);
        expect(item.event_ids.some((id) => oldIds.includes(id))).toBe(false);
    });

    it('excludes videos and pre-link positions from audiobook playback-only scopes', async () => {
        const since = new Date(Date.now() - 60_000);
        await appendEventAndRebuild(sql, {
            user_id: userId,
            media_id: mediaId,
            event_type: 'progress',
            source: 'lumastra-player',
            position_ms: 1000,
            runtime_ms: 60000,
            source_event_id: null,
            session_id: null,
            event_seq: null,
            occurred_at: new Date().toISOString(),
        });
        const query = () =>
            getUnpushedLumastraItems.all(sql, {
                provider: 'audiobookshelf',
                limit: 200,
                userScopes: [{ userId, since, playbackOnly: true }],
            });
        expect(await query()).toEqual([]);
        await sql`UPDATE media_items SET media_type = 'audiobook' WHERE id = ${mediaId}::uuid`;
        expect(await query()).toHaveLength(1);
        await sql`UPDATE user_media_events SET occurred_at = ${new Date(since.getTime() - 1000)} WHERE user_id = ${userId}`;
        expect(await query()).toEqual([]);
    });

    it('bounds device event timestamps while retaining historical offline timestamps', async () => {
        const before = Date.now();
        const base = {
            user_id: userId,
            media_id: mediaId,
            event_type: 'progress' as const,
            source: 'lumastra-offline' as const,
            position_ms: 1000,
            runtime_ms: 60000,
            source_event_id: null,
            session_id: null,
            event_seq: null,
        };
        const future = await insertEvent.one(sql, {
            event: { ...base, occurred_at: new Date(before + 86400000).toISOString() },
        });
        expect(new Date(future!.occurred_at).getTime()).toBeLessThanOrEqual(Date.now() + 1500);
        const oldAt = new Date(before - 86400000).toISOString();
        const old = await insertEvent.one(sql, { event: { ...base, occurred_at: oldAt } });
        expect(new Date(old!.occurred_at).toISOString()).toBe(oldAt);
    });

    it('backs off audiobook recovery from 30 seconds to a capped five minutes', async () => {
        const eventIds = await ids();
        for (let attempt = 0; attempt < 7; attempt++) {
            await deferSyncDelivery(sql, 'audiobookshelf', userId, eventIds, 'ABS unavailable');
            const [row] = await sql<{ seconds: number }[]>`
                SELECT EXTRACT(EPOCH FROM ((sync_delivery -> 'audiobookshelf' ->> 'next_attempt_at')::timestamptz - now())) AS seconds
                FROM user_media_events WHERE id = ${eventIds[0]}
            `;
            expect(Number(row.seconds)).toBeCloseTo(Math.min(300, 30 * 2 ** attempt), 0);
            expect(
                await getUnpushedLumastraItems.all(sql, {
                    provider: 'audiobookshelf',
                    limit: 200,
                    respectBackoff: true,
                }),
            ).toEqual([]);
        }
    });

    it('a new local act bypasses old backoff without re-reporting the old act', async () => {
        await deferSyncDelivery(sql, 'jellyfin', userId, await ids(), 'HTTP 404');
        await mark('mark_watched');
        const queue = await getUnpushedLumastraItems.all(sql, {
            provider: 'jellyfin',
            limit: 200,
            respectBackoff: true,
        });
        expect(queue).toHaveLength(1);
        expect(queue[0].event_ids).toHaveLength(2);
        expect(
            (await deferSyncDelivery(sql, 'jellyfin', userId, queue[0].event_ids, 'HTTP 404'))
                .firstReport,
        ).toBe(true);
    });

    it('surfaces failures with reason, attempt and next retry only for eligible users', async () => {
        await deferSyncDelivery(sql, 'jellyfin', userId, await ids(), 'UserData HTTP 404');
        const visible = await queryJellyfinDeliveryStatus(
            sql,
            [{ user_id: userId, since: null }],
            [],
        );
        expect(visible.failed.count).toBe(1);
        expect(visible.failed.examples[0]).toMatch(/UserData HTTP 404.*attempt 1.*retry after/);
        expect((await queryJellyfinDeliveryStatus(sql, [], [])).failed.count).toBe(0);
    });

    it('keeps acknowledged unwatch policy through a state snapshot', async () => {
        await markEventsPushed(sql, {
            userId,
            provider: 'jellyfin',
            eventIds: await ids(),
            acknowledged: true,
        });
        const events = await getEventsForMedia.all(sql, { userId, mediaId });
        const state = computeStateFromEvents(events);
        expect(state?.jellyfin_unwatch_acknowledged_at).toBeTruthy();
        const snapshot: UserMediaEvent = {
            ...events[0],
            event_type: 'state_snapshot',
            source: 'compaction',
            snapshot_state: state,
            occurred_at: new Date().toISOString(),
        };
        const play: UserMediaEvent = {
            ...events[0],
            source: 'jellyfin-sync',
            event_type: 'mark_watched',
            sync_delivery: {},
            occurred_at: new Date(Date.now() + 1000).toISOString(),
        };
        expect(computeStateFromEvents([snapshot, play])?.is_watched).toBe(true);
        expect(
            computeStateFromEvents([snapshot, { ...play, occurred_at: events[0].occurred_at }])
                ?.is_watched,
        ).toBe(false);
    });
    it('acknowledges a reset that was compacted before its push completed', async () => {
        const eventIds = await ids();
        const state = computeStateFromEvents(await getEventsForMedia.all(sql, { userId, mediaId }));
        await insertEvent.execute(sql, {
            event: {
                user_id: userId,
                media_id: mediaId,
                event_type: 'state_snapshot',
                source: 'compaction',
                snapshot_state: state,
                position_ms: null,
                runtime_ms: null,
                source_event_id: null,
                session_id: null,
                event_seq: null,
                occurred_at: new Date().toISOString(),
            },
        });
        await markEventsPushed(sql, { userId, provider: 'jellyfin', eventIds, acknowledged: true });
        await appendEventAndRebuild(sql, {
            user_id: userId,
            media_id: mediaId,
            event_type: 'mark_watched',
            source: 'jellyfin-sync',
            position_ms: null,
            runtime_ms: 60000,
            source_event_id: null,
            session_id: null,
            event_seq: null,
            occurred_at: new Date(Date.now() + 1000).toISOString(),
        });
        expect((await getState.one(sql, { userId, mediaId }))?.is_watched).toBe(true);
    });
    it('reports the first actual failure even after earlier benign resolution misses', async () => {
        const eventIds = await ids();
        expect(
            (await deferSyncDelivery(sql, 'jellyfin', userId, eventIds, 'no provider id', false))
                .firstReport,
        ).toBe(false);
        expect(
            (await deferSyncDelivery(sql, 'jellyfin', userId, eventIds, 'HTTP 403')).firstReport,
        ).toBe(true);
        expect(
            (await deferSyncDelivery(sql, 'jellyfin', userId, eventIds, 'HTTP 403')).firstReport,
        ).toBe(false);
    });
});
