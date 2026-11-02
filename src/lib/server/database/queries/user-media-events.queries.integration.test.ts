// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for User Media Events Query Module
 *
 * Tests append-only event log operations: insert, read, repudiation,
 * compaction boundary queries, bulk-mark detection, and push tracking.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import type { UserId } from '$lib/shared/user-id.js';
import {
    createAndInsertTestMovie,
    generateTestUserId,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    insertEvent,
    repudiateEvents,
    getRepudiatedUnwatchedMediaIds,
    getPendingJellyfinUnmarkWindows,
    getEventsForMedia,
    countEventsSinceLastSnapshot,
    markEventsPushed,
    markEventsPushedBatch,
    requeueUserEventsForProvider,
    detectBulkMarkWindows,
    getUnpushedLumastraItems,
    getSourceSnapshotsForMedia,
    getLatestLumastraSessionInfo,
} from './user-media-events.queries.js';
import { insertAdminAuditEvent } from './admin-audit.queries.js';

describe('User Media Events Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'user_media_events',
            'user_media_state',
            'media_items',
            'external_ids',
        ]);
    });

    // ========================================================================
    // Helpers
    // ========================================================================

    async function insertTestEvent(params: {
        userId: UserId;
        mediaId: string;
        eventType: 'progress' | 'completed' | 'mark_watched' | 'mark_unwatched';
        source: 'lumastra-player' | 'lumastra-user-mark' | 'jellyfin-sync';
        positionMs?: number | null;
        runtimeMs?: number | null;
        sourceEventId?: string | null;
        sessionId?: string | null;
        eventSeq?: number | null;
        sessionElapsedMs?: number | null;
    }) {
        const now = new Date().toISOString();
        return insertEvent.execute(sql, {
            event: {
                user_id: params.userId,
                media_id: params.mediaId,
                event_type: params.eventType,
                source: params.source,
                position_ms: params.positionMs ?? null,
                runtime_ms: params.runtimeMs ?? null,
                source_event_id: params.sourceEventId ?? null,
                session_id: params.sessionId ?? null,
                event_seq: params.eventSeq ?? null,
                occurred_at: now,
                session_elapsed_ms: params.sessionElapsedMs ?? null,
            },
        });
    }

    // ========================================================================
    // insertEvent
    // ========================================================================

    describe('insertEvent', () => {
        it('inserts a new event and returns it', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const result = await insertTestEvent({
                userId,
                mediaId,
                eventType: 'mark_watched',
                source: 'lumastra-user-mark',
            });

            expect(result.length).toBe(1);
            expect(result[0].user_id).toBe(userId);
            expect(result[0].event_type).toBe('mark_watched');
            expect(result[0].repudiated_at).toBeNull();
        });

        it('is idempotent when source_event_id is provided', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const sourceEventId = 'evt-123';

            const first = await insertTestEvent({
                userId,
                mediaId,
                eventType: 'completed',
                source: 'jellyfin-sync',
                sourceEventId,
            });
            expect(first.length).toBe(1);

            const second = await insertTestEvent({
                userId,
                mediaId,
                eventType: 'completed',
                source: 'jellyfin-sync',
                sourceEventId,
            });
            // ON CONFLICT DO NOTHING returns no rows
            expect(second.length).toBe(0);
        });

        it('allows duplicate inserts when source_event_id is null', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const first = await insertTestEvent({
                userId,
                mediaId,
                eventType: 'progress',
                source: 'lumastra-player',
                sourceEventId: null,
            });
            expect(first.length).toBe(1);

            const second = await insertTestEvent({
                userId,
                mediaId,
                eventType: 'progress',
                source: 'lumastra-player',
                sourceEventId: null,
            });
            expect(second.length).toBe(1);
        });
    });

    // ========================================================================
    // getEventsForMedia
    // ========================================================================

    describe('getEventsForMedia', () => {
        it('returns events ordered newest first', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await insertTestEvent({
                userId,
                mediaId,
                eventType: 'mark_watched',
                source: 'lumastra-user-mark',
            });
            await new Promise((r) => setTimeout(r, 10));
            await insertTestEvent({
                userId,
                mediaId,
                eventType: 'progress',
                source: 'lumastra-player',
            });

            const result = await getEventsForMedia.all(sql, {
                userId,
                mediaId,
            });

            expect(result.length).toBe(2);
            expect(result[0].event_type).toBe('progress');
            expect(result[1].event_type).toBe('mark_watched');
        });

        it('excludes repudiated events', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await insertTestEvent({
                userId,
                mediaId,
                eventType: 'mark_watched',
                source: 'jellyfin-sync',
            });

            await repudiateEvents(sql, {
                userId,
                source: 'jellyfin-sync',
                fromTs: new Date(Date.now() - 60000).toISOString(),
                toTs: new Date(Date.now() + 60000).toISOString(),
            });

            const result = await getEventsForMedia.all(sql, {
                userId,
                mediaId,
            });
            expect(result.length).toBe(0);
        });
    });

    // ========================================================================
    // repudiateEvents
    // ========================================================================

    describe('repudiateEvents', () => {
        it('soft-deletes events in the time window', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await insertTestEvent({
                userId,
                mediaId,
                eventType: 'mark_watched',
                source: 'jellyfin-sync',
            });

            const result = await repudiateEvents(sql, {
                userId,
                source: 'jellyfin-sync',
                fromTs: new Date(Date.now() - 60000).toISOString(),
                toTs: new Date(Date.now() + 60000).toISOString(),
            });

            expect(result.count).toBe(1);
            expect(result.mediaIds).toContain(mediaId);
        });

        it('does not affect events outside the window', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await insertTestEvent({
                userId,
                mediaId,
                eventType: 'mark_watched',
                source: 'jellyfin-sync',
            });

            const result = await repudiateEvents(sql, {
                userId,
                source: 'jellyfin-sync',
                fromTs: new Date(Date.now() + 3600000).toISOString(),
                toTs: new Date(Date.now() + 7200000).toISOString(),
            });

            expect(result.count).toBe(0);
        });
    });

    describe('getRepudiatedUnwatchedMediaIds', () => {
        it('returns repudiated media again on a second call and skips watched media', async () => {
            const { id: gone } = await createAndInsertTestMovie(sql);
            const { id: rewatched } = await createAndInsertTestMovie(sql);
            const { id: live } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            for (const mediaId of [gone, rewatched]) {
                await insertTestEvent({
                    userId,
                    mediaId,
                    eventType: 'mark_watched',
                    source: 'jellyfin-sync',
                });
            }
            await insertTestEvent({
                userId,
                mediaId: live,
                eventType: 'mark_watched',
                source: 'lumastra-user-mark',
            });
            const window = {
                userId,
                source: 'jellyfin-sync' as const,
                fromTs: new Date(Date.now() - 60000).toISOString(),
                toTs: new Date(Date.now() + 60000).toISOString(),
            };
            expect(await getRepudiatedUnwatchedMediaIds(sql, window)).toEqual([]);

            await repudiateEvents(sql, window);
            await sql`INSERT INTO user_media_state (user_id, media_id, is_watched)
                VALUES (${userId}, ${rewatched}, true)`;

            // A retry repudiates nothing new but still sees the earlier media.
            expect((await repudiateEvents(sql, window)).count).toBe(0);
            expect(await getRepudiatedUnwatchedMediaIds(sql, window)).toEqual([gone]);
            // Other user / other window: nothing.
            expect(
                await getRepudiatedUnwatchedMediaIds(sql, {
                    ...window,
                    fromTs: new Date(Date.now() + 3600000).toISOString(),
                    toTs: new Date(Date.now() + 7200000).toISOString(),
                }),
            ).toEqual([]);
        });
    });

    describe('getPendingJellyfinUnmarkWindows', () => {
        const T0 = Date.parse('2026-10-01T12:00:00.000Z');
        const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

        /** One jellyfin-sync cascade of `count` movies at T0 + offsetMs, repudiated. */
        async function repudiatedCascade(
            userId: UserId,
            offsetMs: number,
            opts: { count?: number; jellyfinId?: boolean } = {},
        ): Promise<{ mediaIds: string[]; fromTs: string; toTs: string }> {
            const mediaIds: string[] = [];
            for (let i = 0; i < (opts.count ?? 2); i++) {
                const { id } = await createAndInsertTestMovie(sql);
                mediaIds.push(id);
                // The fixture gives every movie a Jellyfin id.
                if (opts.jellyfinId === false) {
                    await sql`DELETE FROM external_ids WHERE media_id = ${id} AND provider = 'jellyfin'`;
                }
                await insertEvent.execute(sql, {
                    event: {
                        user_id: userId,
                        media_id: id,
                        event_type: 'mark_watched',
                        source: 'jellyfin-sync',
                        position_ms: null,
                        runtime_ms: null,
                        source_event_id: `cascade-${offsetMs}-${i}`,
                        session_id: null,
                        event_seq: null,
                        occurred_at: iso(offsetMs + i),
                        session_elapsed_ms: null,
                    },
                });
            }
            const window = { fromTs: iso(offsetMs), toTs: iso(offsetMs + 1000) };
            await repudiateEvents(sql, { userId, source: 'jellyfin-sync', ...window });
            return { mediaIds, ...window };
        }

        async function audit(
            userId: UserId,
            window: { fromTs: string; toTs: string },
            jellyfinUnmark: Record<string, number> | null,
        ): Promise<void> {
            await insertAdminAuditEvent(sql, {
                instanceId: 'test',
                actor: 'root',
                action: 'watch_events.repudiate',
                target: userId,
                outcome: 'ok',
                detail: { source: 'jellyfin-sync', ...window, jellyfinUnmark },
            });
        }

        const stats = (failed: number, attempted = 2) => ({
            attempted,
            succeeded: attempted - failed,
            failed,
            skippedNoExternalId: 0,
        });

        it('lists windows whose last recorded unmark failed or is missing', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const failed = await repudiatedCascade(userId, 0);
            await audit(userId, failed, stats(2));
            const ok = await repudiatedCascade(userId, 60_000);
            await audit(userId, ok, stats(0));
            await repudiatedCascade(userId, 120_000); // no audit row
            const notAttempted = await repudiatedCascade(userId, 180_000);
            await audit(userId, notAttempted, null);
            const rewatched = await repudiatedCascade(userId, 240_000, { count: 1 });
            await sql`INSERT INTO user_media_state (user_id, media_id, is_watched)
                VALUES (${userId}, ${rewatched.mediaIds[0]}, true)`;
            await repudiatedCascade(userId, 300_000, { jellyfinId: false });

            const rows = await getPendingJellyfinUnmarkWindows(sql, {
                userId,
                lookbackDays: 90,
                limit: 10,
            });
            // Newest repudiation first.
            expect(rows.map((r) => r.from_ts)).toEqual([
                iso(180_000).replace('Z', '000Z'),
                iso(120_000).replace('Z', '000Z'),
                iso(0).replace('Z', '000Z'),
            ]);
            const [notAttemptedRow, unrecordedRow, failedRow] = rows;
            expect(failedRow).toMatchObject({
                to_ts: iso(1).replace('Z', '000Z'),
                event_count: 2,
                pending_media_count: 2,
                last_unmark: stats(2),
            });
            expect(failedRow.last_attempt_at).toMatch(/Z$/);
            expect(unrecordedRow).toMatchObject({ last_attempt_at: null, last_unmark: null });
            expect(notAttemptedRow.last_unmark).toBeNull();
            expect(notAttemptedRow.last_attempt_at).not.toBeNull();
        });

        it('a later successful retry over the window clears it; other users see nothing', async () => {
            const userId = generateTestUserId();
            const other = generateTestUserId();
            await ensureTestUser(sql, userId);
            await ensureTestUser(sql, other);
            const failed = await repudiatedCascade(userId, 0);
            await audit(userId, failed, stats(2));

            const opts = { lookbackDays: 90, limit: 10 };
            const [row] = await getPendingJellyfinUnmarkWindows(sql, { userId, ...opts });
            expect(await getPendingJellyfinUnmarkWindows(sql, { userId: other, ...opts })).toEqual(
                [],
            );

            // The page retries with the window's own bounds.
            await audit(userId, { fromTs: row.from_ts, toTs: row.to_ts }, stats(0));
            expect(await getPendingJellyfinUnmarkWindows(sql, { userId, ...opts })).toEqual([]);
        });

        it('respects the limit', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            for (const offset of [0, 60_000, 120_000]) await repudiatedCascade(userId, offset);
            const rows = await getPendingJellyfinUnmarkWindows(sql, {
                userId,
                lookbackDays: 90,
                limit: 2,
            });
            expect(rows.map((r) => r.from_ts)).toEqual([
                iso(120_000).replace('Z', '000Z'),
                iso(60_000).replace('Z', '000Z'),
            ]);
        });
    });

    // ========================================================================
    // countEventsSinceLastSnapshot
    // ========================================================================

    describe('countEventsSinceLastSnapshot', () => {
        it('counts events when no snapshot exists', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await insertTestEvent({
                userId,
                mediaId,
                eventType: 'progress',
                source: 'lumastra-player',
            });
            await insertTestEvent({
                userId,
                mediaId,
                eventType: 'completed',
                source: 'lumastra-player',
            });

            const result = await countEventsSinceLastSnapshot.one(sql, {
                userId,
                mediaId,
            });

            expect(result).not.toBeNull();
            expect(result!.count).toBe(2);
        });

        it('excludes snapshot events from the count', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await insertTestEvent({
                userId,
                mediaId,
                eventType: 'progress',
                source: 'lumastra-player',
            });

            const result = await countEventsSinceLastSnapshot.one(sql, {
                userId,
                mediaId,
            });
            expect(result!.count).toBe(1);
        });
    });

    // ========================================================================
    // markEventsPushed
    // ========================================================================

    describe('markEventsPushed', () => {
        it('adds provider to pushed_to_providers array', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const [event] = await insertTestEvent({
                userId,
                mediaId,
                eventType: 'mark_watched',
                source: 'lumastra-user-mark',
            });

            await markEventsPushed(sql, {
                userId,
                provider: 'jellyfin',
                eventIds: [event.id],
            });

            const events = await getEventsForMedia.all(sql, {
                userId,
                mediaId,
            });
            expect(events[0].pushed_to_providers).toContain('jellyfin');
        });

        it('is a no-op for empty eventIds', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            await expect(
                markEventsPushed(sql, {
                    userId,
                    provider: 'jellyfin',
                    eventIds: [],
                }),
            ).resolves.toBeUndefined();
        });
    });

    // ========================================================================
    // markEventsPushedBatch
    // ========================================================================

    describe('markEventsPushedBatch', () => {
        // Read pushed_to_providers directly: getEventsForMedia's row type does
        // not surface this column.
        async function pushedProviders(eventId: string): Promise<string[]> {
            const rows = await sql<Array<{ pushed_to_providers: string[] | null }>>`
                SELECT pushed_to_providers FROM user_media_events WHERE id = ${eventId}::uuid
            `;
            return rows[0]?.pushed_to_providers ?? [];
        }

        it('marks events across multiple users in a single call', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const alice = generateTestUserId();
            const bob = generateTestUserId();
            await ensureTestUser(sql, alice);
            await ensureTestUser(sql, bob);

            const [aliceEvent] = await insertTestEvent({
                userId: alice,
                mediaId,
                eventType: 'progress',
                source: 'lumastra-player',
            });
            const [bobEvent] = await insertTestEvent({
                userId: bob,
                mediaId,
                eventType: 'progress',
                source: 'lumastra-player',
            });

            await markEventsPushedBatch(sql, {
                provider: 'jellyfin',
                groups: [
                    { userId: alice, eventIds: [aliceEvent.id] },
                    { userId: bob, eventIds: [bobEvent.id] },
                ],
            });

            expect(await pushedProviders(aliceEvent.id)).toContain('jellyfin');
            expect(await pushedProviders(bobEvent.id)).toContain('jellyfin');
        });

        it('does not flip an event whose user_id does not match its group', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const alice = generateTestUserId();
            const bob = generateTestUserId();
            await ensureTestUser(sql, alice);
            await ensureTestUser(sql, bob);

            const [aliceEvent] = await insertTestEvent({
                userId: alice,
                mediaId,
                eventType: 'progress',
                source: 'lumastra-player',
            });

            // Alice's event ID is (incorrectly) supplied under bob's group.
            // The per-user scoping must leave it untouched.
            await markEventsPushedBatch(sql, {
                provider: 'jellyfin',
                groups: [{ userId: bob, eventIds: [aliceEvent.id] }],
            });

            expect(await pushedProviders(aliceEvent.id)).not.toContain('jellyfin');
        });

        it('does not append a duplicate provider entry on a re-mark', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const [event] = await insertTestEvent({
                userId,
                mediaId,
                eventType: 'progress',
                source: 'lumastra-player',
            });

            await markEventsPushedBatch(sql, {
                provider: 'jellyfin',
                groups: [{ userId, eventIds: [event.id] }],
            });
            await markEventsPushedBatch(sql, {
                provider: 'jellyfin',
                groups: [{ userId, eventIds: [event.id] }],
            });

            const jellyfinCount = (await pushedProviders(event.id)).filter(
                (p) => p === 'jellyfin',
            ).length;
            expect(jellyfinCount).toBe(1);
        });

        it('is a no-op for empty groups', async () => {
            await expect(
                markEventsPushedBatch(sql, { provider: 'jellyfin', groups: [] }),
            ).resolves.toBeUndefined();
        });
    });

    // ========================================================================
    // requeueUserEventsForProvider
    // ========================================================================

    describe('requeueUserEventsForProvider', () => {
        // Read pushed_to_providers directly (getEventsForMedia's row type does
        // not surface the column).
        async function pushedProviders(eventId: string): Promise<string[]> {
            const rows = await sql<Array<{ pushed_to_providers: string[] | null }>>`
                SELECT pushed_to_providers FROM user_media_events WHERE id = ${eventId}::uuid
            `;
            return rows[0]?.pushed_to_providers ?? [];
        }

        // Force an event's pushed_to_providers to a known array (insertEvent
        // always starts it empty).
        async function setPushed(eventId: string, providers: string[]): Promise<void> {
            await sql`
                UPDATE user_media_events
                SET pushed_to_providers = ${sql.array(providers)}::text[]
                WHERE id = ${eventId}::uuid
            `;
        }

        it('removes ONLY the given provider from pushed_to_providers', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const [event] = await insertTestEvent({
                userId,
                mediaId,
                eventType: 'mark_watched',
                source: 'lumastra-user-mark',
            });
            await setPushed(event.id, ['mal', 'trakt']);

            await requeueUserEventsForProvider(sql, userId, 'mal');

            // 'mal' gone, 'trakt' untouched.
            expect(await pushedProviders(event.id)).toEqual(['trakt']);
        });

        it('touches ONLY the given user — a second user with identical events is untouched', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const alice = generateTestUserId();
            const bob = generateTestUserId();
            await ensureTestUser(sql, alice);
            await ensureTestUser(sql, bob);

            const [aliceEvent] = await insertTestEvent({
                userId: alice,
                mediaId,
                eventType: 'completed',
                source: 'lumastra-user-mark',
            });
            const [bobEvent] = await insertTestEvent({
                userId: bob,
                mediaId,
                eventType: 'completed',
                source: 'lumastra-user-mark',
            });
            await setPushed(aliceEvent.id, ['mal', 'trakt']);
            await setPushed(bobEvent.id, ['mal', 'trakt']);

            await requeueUserEventsForProvider(sql, alice, 'mal');

            expect(await pushedProviders(aliceEvent.id)).toEqual(['trakt']);
            // Bob's identical event keeps 'mal'.
            expect(await pushedProviders(bobEvent.id)).toEqual(['mal', 'trakt']);
        });

        it('touches ONLY decisive event types — a progress event keeps the provider', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const [decisive] = await insertTestEvent({
                userId,
                mediaId,
                eventType: 'mark_unwatched',
                source: 'lumastra-user-mark',
            });
            const [progress] = await insertTestEvent({
                userId,
                mediaId,
                eventType: 'progress',
                source: 'lumastra-player',
            });
            await setPushed(decisive.id, ['mal']);
            await setPushed(progress.id, ['mal']);

            await requeueUserEventsForProvider(sql, userId, 'mal');

            // Decisive event re-queued (mal removed); progress event left as-is.
            expect(await pushedProviders(decisive.id)).toEqual([]);
            expect(await pushedProviders(progress.id)).toEqual(['mal']);
        });

        it('is a no-op for an event that does not contain the provider', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const [event] = await insertTestEvent({
                userId,
                mediaId,
                eventType: 'mark_watched',
                source: 'lumastra-user-mark',
            });
            await setPushed(event.id, ['trakt']);

            await requeueUserEventsForProvider(sql, userId, 'mal');

            // 'mal' was never present → array unchanged.
            expect(await pushedProviders(event.id)).toEqual(['trakt']);
        });
    });

    // ========================================================================
    // detectBulkMarkWindows
    // ========================================================================

    describe('detectBulkMarkWindows', () => {
        it('detects clusters of mark events within a window', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            // Insert 5 mark_watched events in rapid succession
            const now = new Date();
            for (let i = 0; i < 5; i++) {
                await insertEvent.execute(sql, {
                    event: {
                        user_id: userId,
                        media_id: mediaId,
                        event_type: 'mark_watched',
                        source: 'jellyfin-sync',
                        position_ms: null,
                        runtime_ms: null,
                        source_event_id: `bulk-${i}`,
                        session_id: null,
                        event_seq: null,
                        occurred_at: now.toISOString(),
                    },
                });
            }

            const result = await detectBulkMarkWindows.all(sql, {
                userId,
                windowMs: 60000,
                minEventCount: 3,
            });

            expect(result.length).toBeGreaterThan(0);
            const window = result[0];
            expect(window.event_count).toBe(5);
            expect(window.source).toBe('jellyfin-sync');
        });

        it('returns ISO UTC bounds that the repudiate endpoint accepts and that cover the whole window', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const stamps = [
                '2026-10-06T12:00:00.100Z',
                '2026-10-06T12:00:00.250Z',
                '2026-10-06T12:00:00.999Z',
            ];
            for (const at of stamps) {
                await sql`
                    INSERT INTO user_media_events
                        (user_id, media_id, event_type, source, occurred_at)
                    VALUES (${userId}, ${mediaId}, 'mark_watched', 'jellyfin-sync', ${at}::timestamptz)
                `;
            }

            const [window] = await detectBulkMarkWindows.all(sql, {
                userId,
                windowMs: 60000,
                minEventCount: 3,
            });
            // Not the Postgres ::text form ('2026-10-06 12:00:00.1+00'), which
            // z.string().datetime() rejects; microseconds keep the <= bound exact.
            expect(window.window_start).toBe('2026-10-06T12:00:00.100000Z');
            expect(window.window_end).toBe('2026-10-06T12:00:00.999000Z');

            const { count } = await repudiateEvents(sql, {
                userId,
                source: 'jellyfin-sync',
                fromTs: window.window_start,
                toTs: window.window_end,
            });
            expect(count).toBe(3);
        });

        it('excludes lumastra-user-mark and migration sources', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await insertTestEvent({
                userId,
                mediaId,
                eventType: 'mark_watched',
                source: 'lumastra-user-mark',
            });

            const result = await detectBulkMarkWindows.all(sql, {
                userId,
                windowMs: 60000,
                minEventCount: 1,
            });

            expect(result.length).toBe(0);
        });
    });

    // ========================================================================
    // getUnpushedLumastraItems
    // ========================================================================

    describe('getUnpushedLumastraItems', () => {
        it('without userScopes: returns items for every user (back-compat)', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userA = generateTestUserId();
            const userB = generateTestUserId();
            await ensureTestUser(sql, userA);
            await ensureTestUser(sql, userB);

            await insertTestEvent({
                userId: userA,
                mediaId,
                eventType: 'mark_watched',
                source: 'lumastra-user-mark',
            });
            await insertTestEvent({
                userId: userB,
                mediaId,
                eventType: 'mark_watched',
                source: 'lumastra-user-mark',
            });

            const unscoped = await getUnpushedLumastraItems.all(sql, {
                provider: 'mal',
                limit: 200,
            });

            const returnedUsers = unscoped.map((r) => r.user_id).sort();
            expect(returnedUsers).toEqual([userA, userB].sort());
        });

        it('with userScopes: only in-scope users at-or-after their watermark are returned', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userA = generateTestUserId();
            const userB = generateTestUserId();
            await ensureTestUser(sql, userA);
            await ensureTestUser(sql, userB);

            const t0 = new Date();
            const before = new Date(t0.getTime() - 60_000).toISOString();
            const after = new Date(t0.getTime() + 60_000).toISOString();

            // User A: one decisive event before the watermark (must be
            // excluded when scoped) and one after (must be included).
            await insertEvent.execute(sql, {
                event: {
                    user_id: userA,
                    media_id: mediaId,
                    event_type: 'mark_watched',
                    source: 'lumastra-user-mark',
                    position_ms: null,
                    runtime_ms: null,
                    source_event_id: 'a-before',
                    session_id: null,
                    event_seq: null,
                    occurred_at: before,
                },
            });
            const [aAfterEvent] = await insertEvent.execute(sql, {
                event: {
                    user_id: userA,
                    media_id: mediaId,
                    event_type: 'mark_watched',
                    source: 'lumastra-user-mark',
                    position_ms: null,
                    runtime_ms: null,
                    source_event_id: 'a-after',
                    session_id: null,
                    event_seq: null,
                    occurred_at: after,
                },
            });

            // User B: unlinked (not present in userScopes) — must never
            // return even though its event is well after the watermark.
            await insertEvent.execute(sql, {
                event: {
                    user_id: userB,
                    media_id: mediaId,
                    event_type: 'mark_watched',
                    source: 'lumastra-user-mark',
                    position_ms: null,
                    runtime_ms: null,
                    source_event_id: 'b-after',
                    session_id: null,
                    event_seq: null,
                    occurred_at: after,
                },
            });

            const gated = await getUnpushedLumastraItems.all(sql, {
                provider: 'mal',
                limit: 200,
                userScopes: [{ userId: userA, since: t0 }],
            });

            expect(gated.map((r) => r.user_id)).toEqual([userA]);
            expect(gated[0].event_ids).toEqual([aAfterEvent.id]);
            expect(gated[0].latest_decisive_event_type).toBe('mark_watched');

            // Without userScopes, both users' events return (back-compat).
            const unscoped = await getUnpushedLumastraItems.all(sql, {
                provider: 'mal',
                limit: 200,
            });
            expect(unscoped.map((r) => r.user_id).sort()).toEqual([userA, userB].sort());
        });

        it('with userScopes: inner mirror excludes a pre-watermark decisive event (latest_decisive_event_type is null)', async () => {
            // Guards the mirrored `scope` JOIN inside the correlated
            // latest_decisive_event_type subquery specifically. Setup:
            //   - one PRE-watermark decisive event (mark_watched < T0)
            //   - one POST-watermark PROGRESS-ONLY event (> T0)
            // for the SAME (user, media). The post-watermark progress event
            // keeps the outer group alive (outer query has no event_type
            // filter), but the ONLY decisive event is pre-watermark, so it
            // must be excluded by the inner mirror -> latest_decisive_event_type
            // is null. Without the inner mirror the pre-watermark mark_watched
            // would leak through the subquery's ORDER BY ... LIMIT 1.
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userA = generateTestUserId();
            await ensureTestUser(sql, userA);

            const t0 = new Date();
            const before = new Date(t0.getTime() - 60_000).toISOString();
            const after = new Date(t0.getTime() + 60_000).toISOString();

            // Pre-watermark decisive event (must be excluded when scoped).
            await insertEvent.execute(sql, {
                event: {
                    user_id: userA,
                    media_id: mediaId,
                    event_type: 'mark_watched',
                    source: 'lumastra-user-mark',
                    position_ms: null,
                    runtime_ms: null,
                    source_event_id: 'a-decisive-before',
                    session_id: null,
                    event_seq: null,
                    occurred_at: before,
                },
            });
            // Post-watermark progress-only event (keeps outer group alive,
            // but is non-decisive so it never sets latest_decisive_event_type).
            const [progressEvent] = await insertEvent.execute(sql, {
                event: {
                    user_id: userA,
                    media_id: mediaId,
                    event_type: 'progress',
                    source: 'lumastra-player',
                    position_ms: 1000,
                    runtime_ms: null,
                    source_event_id: 'a-progress-after',
                    session_id: null,
                    event_seq: null,
                    occurred_at: after,
                },
            });

            const gated = await getUnpushedLumastraItems.all(sql, {
                provider: 'mal',
                limit: 200,
                userScopes: [{ userId: userA, since: t0 }],
            });

            expect(gated.map((r) => r.user_id)).toEqual([userA]);
            // Only the post-watermark progress event is in scope for the outer
            // aggregate; the pre-watermark decisive event is filtered out.
            expect(gated[0].event_ids).toEqual([progressEvent.id]);
            // Critical assertion: the inner mirror must exclude the
            // pre-watermark mark_watched, leaving no in-scope decisive event.
            expect(gated[0].latest_decisive_event_type).toBeNull();
        });

        it('with userScopes: since = null means no lower bound for that user', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userA = generateTestUserId();
            await ensureTestUser(sql, userA);

            const longAgo = new Date(Date.now() - 3600_000).toISOString();
            const [oldEvent] = await insertEvent.execute(sql, {
                event: {
                    user_id: userA,
                    media_id: mediaId,
                    event_type: 'mark_watched',
                    source: 'lumastra-user-mark',
                    position_ms: null,
                    runtime_ms: null,
                    source_event_id: 'a-old',
                    session_id: null,
                    event_seq: null,
                    occurred_at: longAgo,
                },
            });

            const gated = await getUnpushedLumastraItems.all(sql, {
                provider: 'mal',
                limit: 200,
                userScopes: [{ userId: userA, since: null }],
            });

            expect(gated.map((r) => r.user_id)).toEqual([userA]);
            expect(gated[0].event_ids).toEqual([oldEvent.id]);
        });
    });

    describe('getLatestLumastraSessionInfo', () => {
        /**
         * The guard's first escape is `if (!current.session_id) return true`,
         * so a session-less row winning this ORDER BY switches stale-tab
         * protection off entirely for that (user, media). No live writer
         * produces such a row today — this pins the invariant so a future
         * back-dated/batch ingestion path can't silently disable the guard by
         * writing under 'lumastra-player'.
         */
        it('ignores session-less progress rows even when they are the newest', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const t0 = Date.now();
            const older = new Date(t0 - 60_000).toISOString();
            const newer = new Date(t0 + 60_000).toISOString();

            // The real live session.
            await insertEvent.execute(sql, {
                event: {
                    user_id: userId,
                    media_id: mediaId,
                    event_type: 'progress',
                    source: 'lumastra-player',
                    position_ms: 1000,
                    runtime_ms: null,
                    source_event_id: null,
                    session_id: 'live-session',
                    event_seq: 5,
                    occurred_at: older,
                },
            });

            // A newer row with no session_id — must not become "current".
            await insertEvent.execute(sql, {
                event: {
                    user_id: userId,
                    media_id: mediaId,
                    event_type: 'progress',
                    source: 'lumastra-player',
                    position_ms: 9000,
                    runtime_ms: null,
                    source_event_id: null,
                    session_id: null,
                    event_seq: null,
                    occurred_at: newer,
                },
            });

            const info = await getLatestLumastraSessionInfo.one(sql, { userId, mediaId });

            expect(info?.session_id).toBe('live-session');
            expect(info?.event_seq).toBe(5);
        });

        it('returns null when the only progress rows are session-less', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await insertTestEvent({
                userId,
                mediaId,
                eventType: 'progress',
                source: 'lumastra-player',
                positionMs: 4000,
                sessionId: null,
            });

            const info = await getLatestLumastraSessionInfo.one(sql, { userId, mediaId });

            // No tracked session → the guard's "no prior session" branch, which
            // is the correct accept-unconditionally case.
            expect(info).toBeNull();
        });
    });

    describe('getSourceSnapshotsForMedia — append-order (resync-loop regression)', () => {
        it('returns the most-recently-APPENDED decisive event, not the newest by occurred_at', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const movie = await createAndInsertTestMovie(sql);
            const mediaId = movie.id;

            // Reproduce the prod resync loop: Jellyfin stamps occurred_at with its
            // own play DATE. A stale mark_watched has a NEWER occurred_at but was
            // appended EARLIER (older recorded_at); the mark_unwatched was appended
            // most recently (newer recorded_at) but carries an OLDER occurred_at.
            // Ordering by occurred_at wrongly picks mark_watched → shouldEmitSourceUnwatch
            // keeps firing every cycle. Ordering by recorded_at (append order) converges.
            const [watched] = await insertTestEvent({
                userId,
                mediaId,
                eventType: 'mark_watched',
                source: 'jellyfin-sync',
            });
            const [unwatched] = await insertTestEvent({
                userId,
                mediaId,
                eventType: 'mark_unwatched',
                source: 'jellyfin-sync',
            });
            // The inversion: mark_watched has the NEWER occurred_at (play-date) but
            // the OLDER recorded_at (appended earlier); mark_unwatched has the OLDER
            // occurred_at but was appended most recently. occurred_at ordering wrongly
            // picks mark_watched; recorded_at (append order) correctly picks mark_unwatched.
            await sql`UPDATE user_media_events SET occurred_at = '2026-05-01T21:56:00Z', recorded_at = '2026-06-11T18:43:00Z' WHERE id = ${watched.id}`;
            await sql`UPDATE user_media_events SET occurred_at = '2026-04-24T22:02:00Z', recorded_at = '2026-07-12T22:03:00Z' WHERE id = ${unwatched.id}`;

            const [snapshot] = await getSourceSnapshotsForMedia(sql, {
                userId,
                mediaIds: [mediaId],
                source: 'jellyfin-sync',
            });

            expect(snapshot.last_decisive_event_type).toBe('mark_unwatched');
        });

        it('returns the last-appended progress position by append order (not occurred_at)', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const movie = await createAndInsertTestMovie(sql);
            const mediaId = movie.id;

            const [older] = await insertTestEvent({
                userId,
                mediaId,
                eventType: 'progress',
                source: 'jellyfin-sync',
                positionMs: 1385000,
            });
            const [newer] = await insertTestEvent({
                userId,
                mediaId,
                eventType: 'progress',
                source: 'jellyfin-sync',
                positionMs: 1387330,
            });
            // Newer append (recorded later) carries the OLDER occurred_at.
            await sql`UPDATE user_media_events SET occurred_at = '2026-07-01T00:00:00Z', recorded_at = '2026-06-01T00:00:00Z' WHERE id = ${older.id}`;
            await sql`UPDATE user_media_events SET occurred_at = '2026-05-01T00:00:00Z', recorded_at = '2026-07-01T00:00:00Z' WHERE id = ${newer.id}`;

            const [snapshot] = await getSourceSnapshotsForMedia(sql, {
                userId,
                mediaIds: [mediaId],
                source: 'jellyfin-sync',
            });

            expect(snapshot.last_progress_position_ms).toBe(1387330);
        });
    });

    // ========================================================================
    // lumastra-offline source
    // ========================================================================

    describe('lumastra-offline source', () => {
        it('is accepted by the source CHECK constraint', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const [row] = await insertEvent.execute(sql, {
                event: {
                    user_id: userId,
                    media_id: mediaId,
                    event_type: 'progress',
                    source: 'lumastra-offline',
                    position_ms: 5000,
                    runtime_ms: 100000,
                    source_event_id: 'offline:abc',
                    session_id: null,
                    event_seq: null,
                    occurred_at: new Date(Date.now() - 86_400_000).toISOString(),
                },
            });

            expect(row?.source).toBe('lumastra-offline');
        });

        it('is picked up by the provider push queue', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await insertEvent.execute(sql, {
                event: {
                    user_id: userId,
                    media_id: mediaId,
                    event_type: 'completed',
                    source: 'lumastra-offline',
                    position_ms: 99000,
                    runtime_ms: 100000,
                    source_event_id: 'offline:def:completed',
                    session_id: null,
                    event_seq: null,
                    occurred_at: new Date(Date.now() - 86_400_000).toISOString(),
                },
            });

            const unpushed = await getUnpushedLumastraItems.all(sql, {
                provider: 'jellyfin',
                limit: 200,
            });

            expect(unpushed.map((r) => r.media_id)).toContain(mediaId);
        });

        it('does not flag an offline flush as a bulk-mark window', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const at = new Date(Date.now() - 86_400_000).toISOString();

            for (let i = 0; i < 12; i++) {
                await insertEvent.execute(sql, {
                    event: {
                        user_id: userId,
                        media_id: mediaId,
                        event_type: 'completed',
                        source: 'lumastra-offline',
                        position_ms: 99000,
                        runtime_ms: 100000,
                        source_event_id: `offline:bulk:${i}`,
                        session_id: null,
                        event_seq: null,
                        occurred_at: at,
                    },
                });
            }

            const windows = await detectBulkMarkWindows.all(sql, {
                userId,
                windowMs: 60000,
                minEventCount: 5,
            });

            expect(windows).toHaveLength(0);
        });
    });
});
