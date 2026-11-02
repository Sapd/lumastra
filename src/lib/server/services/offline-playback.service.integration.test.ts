// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    generateTestUserId,
    ensureTestUser,
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../tests/integration/fixtures/index.js';
import { getEventsForMedia, insertEvent } from '../database/queries/user-media-events.queries.js';
import { getState } from '../database/queries/user-media-state.queries.js';
import { COMPACTION_THRESHOLD } from './watch-state-rebuilder.service.js';
import { refreshSegmentsForFile } from '../database/queries/file-segments.queries.js';
import { AUDIOBOOK_MEDIA_TYPE } from '../database/queries/audiobooks.queries.js';
import { ingestOfflineSessions } from './offline-playback.service.js';

describe('ingestOfflineSessions', () => {
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
            'watch_history',
            'media_items',
            'external_ids',
            // Combined-file fixtures (episode_chapters/media_file_items feed the
            // getEpisodeWindowsForFile projection the sibling-completion test
            // below exercises).
            'episode_chapters',
            'media_file_items',
            'media_files',
        ]);
    });

    function record(over: Partial<Parameters<typeof ingestOfflineSessions>[1]['records'][0]>) {
        const ended = new Date(Date.now() - 3 * 86_400_000);
        const started = new Date(ended.getTime() - 45 * 60_000);
        return {
            eventId: crypto.randomUUID(),
            mediaId: '',
            startedAt: started.toISOString(),
            endedAt: ended.toISOString(),
            positionMs: 1_400_000,
            runtimeMs: 5_400_000,
            sessionElapsedMs: 1_200_000,
            endReason: 'stopped' as const,
            ...over,
        };
    }

    it.each([
        { runtimeMs: 145_000, combined: false, persists: true },
        { runtimeMs: 1_200_000, combined: false, persists: false },
        { runtimeMs: 145_000, combined: true, persists: true },
        { runtimeMs: 1_200_000, combined: true, persists: false },
    ])(
        '40 s offline watch: $runtimeMs ms, combined=$combined, persists=$persists',
        async ({ runtimeMs, combined, persists }) => {
            const [media] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status, runtime_seconds)
                VALUES ('Engagement episode', 'episode', 'active', ${runtimeMs / 1000}) RETURNING id
            `;
            const mediaId = media.id;
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
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
                           (${file.id}, ${mediaId}, true, ${startMs}, ${fileRuntimeMs})
                `;
            }
            const results = await ingestOfflineSessions(sql, {
                userId,
                user: undefined,
                records: [
                    record({
                        mediaId,
                        positionMs: startMs + 40_000,
                        runtimeMs: fileRuntimeMs,
                        sessionElapsedMs: 40_000,
                    }),
                ],
            });
            expect(results[0].status).toBe('accepted');
            const state = await getState.one(sql, { userId, mediaId });
            if (persists) {
                expect(state?.resume_position_ms).toBe(startMs + 40_000);
                expect(state?.is_watched).toBe(false);
            } else {
                expect(state).toBeNull();
            }
        },
    );

    it('applies an offline record to resume state', async () => {
        const { id: mediaId } = await createAndInsertTestMovie(sql);
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        const results = await ingestOfflineSessions(sql, {
            userId,
            user: undefined,
            records: [record({ mediaId })],
        });

        expect(results[0].status).toBe('accepted');
        const state = await getState.one(sql, { userId, mediaId });
        expect(state?.resume_position_ms).toBe(1_400_000);
    });

    it('is idempotent: replaying the batch does not inflate watch_count', async () => {
        const { id: mediaId } = await createAndInsertTestMovie(sql);
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        const batch = [
            record({ mediaId, positionMs: 5_300_000, endReason: 'completion' as const }),
        ];

        await ingestOfflineSessions(sql, { userId, user: undefined, records: batch });
        const first = await getState.one(sql, { userId, mediaId });

        const second = await ingestOfflineSessions(sql, {
            userId,
            user: undefined,
            records: batch,
        });

        expect(second[0].status).toBe('duplicate');
        const after = await getState.one(sql, { userId, mediaId });
        expect(after?.watch_count).toBe(first?.watch_count);
    });

    it('a newer live position is not rewound by an older offline record', async () => {
        const { id: mediaId } = await createAndInsertTestMovie(sql);
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        // Live playback "now" via the offline path with a recent timestamp is
        // not equivalent — write the live event directly so the source differs.
        const { appendEventAndRebuild } = await import('./watch-state-rebuilder.service.js');
        await appendEventAndRebuild(sql, {
            user_id: userId,
            media_id: mediaId,
            event_type: 'progress',
            source: 'lumastra-player',
            position_ms: 4_000_000,
            runtime_ms: 5_400_000,
            source_event_id: null,
            session_id: 'live-1',
            event_seq: 1,
            session_elapsed_ms: 4_000_000,
            occurred_at: new Date().toISOString(),
        });

        await ingestOfflineSessions(sql, {
            userId,
            user: undefined,
            records: [record({ mediaId, positionMs: 600_000 })],
        });

        const state = await getState.one(sql, { userId, mediaId });
        expect(state?.resume_position_ms).toBe(4_000_000);
    });

    it('a stale offline record does not rewind a live position it never saw, even though it ended later', async () => {
        // The gap the "older offline record" test above does NOT cover, and
        // the one that actually bit on prod (2026-08-22). Here the offline
        // record is the NEWEST event by occurrence — the device kept
        // listening after the other one stopped — so latest-wins hands it the
        // resume point. What disqualifies it is that its position was
        // resolved before the live event existed.
        const { id: mediaId } = await createAndInsertTestMovie(sql);
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        const wentOffline = new Date(Date.now() - 12 * 3_600_000);
        const liveAt = new Date(Date.now() - 6 * 3_600_000);
        const offlineStart = new Date(Date.now() - 2 * 3_600_000);
        const offlineEnd = new Date(Date.now() - 3_600_000);

        const { appendEventAndRebuild } = await import('./watch-state-rebuilder.service.js');
        await appendEventAndRebuild(sql, {
            user_id: userId,
            media_id: mediaId,
            event_type: 'progress',
            source: 'lumastra-player',
            position_ms: 4_000_000,
            runtime_ms: 5_400_000,
            source_event_id: null,
            session_id: 'live-1',
            event_seq: 1,
            session_elapsed_ms: 4_000_000,
            occurred_at: liveAt.toISOString(),
        });

        await ingestOfflineSessions(sql, {
            userId,
            user: undefined,
            records: [
                record({
                    mediaId,
                    positionMs: 600_000,
                    startedAt: offlineStart.toISOString(),
                    endedAt: offlineEnd.toISOString(),
                    sessionElapsedMs: 1_200_000,
                    knownAsOf: wentOffline.toISOString(),
                }),
            ],
        });

        const state = await getState.one(sql, { userId, mediaId });
        expect(state?.resume_position_ms).toBe(4_000_000);
    });

    it('a stale offline record still advances a position it overtook', async () => {
        // Same shape, opposite outcome — the guard raises only. Without this
        // the first test above is satisfied by a service that simply ignores
        // every offline record.
        const { id: mediaId } = await createAndInsertTestMovie(sql);
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        const wentOffline = new Date(Date.now() - 12 * 3_600_000);
        const offlineStart = new Date(Date.now() - 2 * 3_600_000);
        const offlineEnd = new Date(Date.now() - 3_600_000);

        const { appendEventAndRebuild } = await import('./watch-state-rebuilder.service.js');
        await appendEventAndRebuild(sql, {
            user_id: userId,
            media_id: mediaId,
            event_type: 'progress',
            source: 'lumastra-player',
            position_ms: 600_000,
            runtime_ms: 5_400_000,
            source_event_id: null,
            session_id: 'live-2',
            event_seq: 1,
            session_elapsed_ms: 600_000,
            occurred_at: new Date(Date.now() - 6 * 3_600_000).toISOString(),
        });

        await ingestOfflineSessions(sql, {
            userId,
            user: undefined,
            records: [
                record({
                    mediaId,
                    positionMs: 4_000_000,
                    startedAt: offlineStart.toISOString(),
                    endedAt: offlineEnd.toISOString(),
                    sessionElapsedMs: 1_200_000,
                    knownAsOf: wentOffline.toISOString(),
                }),
            ],
        });

        const state = await getState.one(sql, { userId, mediaId });
        expect(state?.resume_position_ms).toBe(4_000_000);
    });

    describe('applied — reporting whether the record actually took effect', () => {
        // The endpoint was unverifiable from outside: on prod 2026-08-27 two
        // audiobook records came back `{status: 'accepted'}` and both
        // watch-state rows still read position 0, with nothing in the
        // response separating a stored position from a discarded one. These
        // tests assert at that seam — the RESULT a client reads — not at the
        // arbitration, which is unchanged.

        it('reports applied: false for a record that was accepted and then lost arbitration', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const wentOffline = new Date(Date.now() - 12 * 3_600_000);
            const liveAt = new Date(Date.now() - 6 * 3_600_000);

            const { appendEventAndRebuild } = await import('./watch-state-rebuilder.service.js');
            await appendEventAndRebuild(sql, {
                user_id: userId,
                media_id: mediaId,
                event_type: 'progress',
                source: 'lumastra-player',
                position_ms: 4_000_000,
                runtime_ms: 5_400_000,
                source_event_id: null,
                session_id: 'live-applied-1',
                event_seq: 1,
                session_elapsed_ms: 4_000_000,
                occurred_at: liveAt.toISOString(),
            });

            const results = await ingestOfflineSessions(sql, {
                userId,
                user: undefined,
                records: [
                    record({
                        mediaId,
                        positionMs: 600_000,
                        startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
                        endedAt: new Date(Date.now() - 3_600_000).toISOString(),
                        sessionElapsedMs: 1_200_000,
                        knownAsOf: wentOffline.toISOString(),
                    }),
                ],
            });

            // Still accepted — the event WAS written and replaying it is
            // pointless — but the position it reported is not the one in
            // effect, and the response now says so.
            expect(results[0].status).toBe('accepted');
            expect(results[0].applied).toBe(false);

            const state = await getState.one(sql, { userId, mediaId });
            expect(state?.resume_position_ms).toBe(4_000_000);
        });

        it('reports applied: true for the same shape of record when it DOES win', async () => {
            // Without this the test above is satisfied by hard-coding false.
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const { appendEventAndRebuild } = await import('./watch-state-rebuilder.service.js');
            await appendEventAndRebuild(sql, {
                user_id: userId,
                media_id: mediaId,
                event_type: 'progress',
                source: 'lumastra-player',
                position_ms: 600_000,
                runtime_ms: 5_400_000,
                source_event_id: null,
                session_id: 'live-applied-2',
                event_seq: 1,
                session_elapsed_ms: 600_000,
                occurred_at: new Date(Date.now() - 6 * 3_600_000).toISOString(),
            });

            const results = await ingestOfflineSessions(sql, {
                userId,
                user: undefined,
                records: [
                    record({
                        mediaId,
                        positionMs: 4_000_000,
                        startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
                        endedAt: new Date(Date.now() - 3_600_000).toISOString(),
                        sessionElapsedMs: 1_200_000,
                        knownAsOf: new Date(Date.now() - 12 * 3_600_000).toISOString(),
                    }),
                ],
            });

            expect(results[0].status).toBe('accepted');
            expect(results[0].applied).toBe(true);

            const state = await getState.one(sql, { userId, mediaId });
            expect(state?.resume_position_ms).toBe(4_000_000);
        });

        it('marks only the winner applied when several records in one batch cover the same item', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const first = record({
                mediaId,
                positionMs: 1_000_000,
                startedAt: new Date(Date.now() - 4 * 3_600_000).toISOString(),
                endedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
            });
            const second = record({
                mediaId,
                positionMs: 2_000_000,
                startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
                endedAt: new Date(Date.now() - 3_600_000).toISOString(),
            });

            const results = await ingestOfflineSessions(sql, {
                userId,
                user: undefined,
                records: [first, second],
            });

            const byId = new Map(results.map((r) => [r.eventId, r]));
            // Both landed; only the later one decides the resume point. That
            // is normal, not a failure — neither is retryable.
            expect(byId.get(first.eventId)?.status).toBe('accepted');
            expect(byId.get(first.eventId)?.applied).toBe(false);
            expect(byId.get(second.eventId)?.status).toBe('accepted');
            expect(byId.get(second.eventId)?.applied).toBe(true);

            const state = await getState.one(sql, { userId, mediaId });
            expect(state?.resume_position_ms).toBe(2_000_000);
        });

        it('reports applied: false for a record too short to be written at all', async () => {
            // Accepted without a write (the "accidental tap" filter). Nothing
            // was stored, so nothing was applied — reporting true here would
            // be the same lie in a quieter place.
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const results = await ingestOfflineSessions(sql, {
                userId,
                user: undefined,
                records: [
                    record({
                        mediaId,
                        positionMs: 3_000,
                        sessionElapsedMs: 3_000,
                        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
                        endedAt: new Date(Date.now() - 3_600_000 + 3_000).toISOString(),
                    }),
                ],
            });

            expect(results[0].status).toBe('accepted');
            // Never `true`. This service reports `applied` only for records
            // that actually reached arbitration; the endpoint stamps the
            // literal `false` for every other result, the same way it is the
            // single derivation site for `retryable` (covered by the def's
            // "stamps applied on every result" test).
            expect(results[0].applied).not.toBe(true);
            expect(await getState.one(sql, { userId, mediaId })).toBeNull();
        });

        it('still reports applied: true when a winning record is replayed as a duplicate', async () => {
            // A client retrying a record it never got an answer for must be
            // able to learn that its position is in effect. `duplicate` alone
            // cannot tell it that.
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const rec = record({ mediaId, positionMs: 1_400_000 });

            const first = await ingestOfflineSessions(sql, {
                userId,
                user: undefined,
                records: [rec],
            });
            expect(first[0]).toMatchObject({ status: 'accepted', applied: true });

            const replay = await ingestOfflineSessions(sql, {
                userId,
                user: undefined,
                records: [rec],
            });
            expect(replay[0]).toMatchObject({ status: 'duplicate', applied: true });
        });

        it('reports applied: false on a rejected record', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const results = await ingestOfflineSessions(sql, {
                userId,
                user: undefined,
                records: [record({ mediaId: crypto.randomUUID() })],
            });

            expect(results[0]).toMatchObject({ status: 'rejected', reason: 'not_found' });
            expect(results[0].applied).not.toBe(true);
        });
    });

    it('an offline record DOES override a position it had already seen — a deliberate offline rewind still works', async () => {
        // The case that distinguishes a real knownAsOf from a dropped one.
        // Both blocked and bounded behaviour agree on the two tests above,
        // because a MISSING stamp is read as an unbounded blind spot and
        // blocks the regression too. Only here do they diverge: the live
        // position predates what the client last read, so it is not a blind
        // spot at all and a rewind made offline has to take effect. Without
        // this, dropping `knownAsOf` anywhere between the wire and the INSERT
        // is invisible — it just silently downgrades every client to the
        // blunt rule.
        const { id: mediaId } = await createAndInsertTestMovie(sql);
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        const liveAt = new Date(Date.now() - 12 * 3_600_000);
        const lastRead = new Date(Date.now() - 6 * 3_600_000);
        const offlineStart = new Date(Date.now() - 2 * 3_600_000);
        const offlineEnd = new Date(Date.now() - 3_600_000);

        const { appendEventAndRebuild } = await import('./watch-state-rebuilder.service.js');
        await appendEventAndRebuild(sql, {
            user_id: userId,
            media_id: mediaId,
            event_type: 'progress',
            source: 'lumastra-player',
            position_ms: 4_000_000,
            runtime_ms: 5_400_000,
            source_event_id: null,
            session_id: 'live-3',
            event_seq: 1,
            session_elapsed_ms: 4_000_000,
            occurred_at: liveAt.toISOString(),
        });

        await ingestOfflineSessions(sql, {
            userId,
            user: undefined,
            records: [
                record({
                    mediaId,
                    positionMs: 600_000,
                    startedAt: offlineStart.toISOString(),
                    endedAt: offlineEnd.toISOString(),
                    sessionElapsedMs: 1_200_000,
                    knownAsOf: lastRead.toISOString(),
                }),
            ],
        });

        const state = await getState.one(sql, { userId, mediaId });
        expect(state?.resume_position_ms).toBe(600_000);
    });

    it('one invalid record does not discard the valid ones', async () => {
        const { id: mediaId } = await createAndInsertTestMovie(sql);
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        const results = await ingestOfflineSessions(sql, {
            userId,
            user: undefined,
            records: [
                record({ mediaId }),
                record({ mediaId: '00000000-0000-0000-0000-000000000000' }),
            ],
        });

        expect(results[0].status).toBe('accepted');
        expect(results[1].status).toBe('rejected');
        expect(results[1].reason).toBe('not_found');
    });

    it('rejects a record for soft-deleted media as not_found, the same as a nonexistent one', async () => {
        const { id: mediaId } = await createAndInsertTestMovie(sql);
        await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${mediaId}`;
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        const results = await ingestOfflineSessions(sql, {
            userId,
            user: undefined,
            records: [record({ mediaId })],
        });

        expect(results[0].status).toBe('rejected');
        expect(results[0].reason).toBe('not_found');
    });

    it('records the real offline window in watch_history, not upload time', async () => {
        const { id: mediaId } = await createAndInsertTestMovie(sql);
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const rec = record({ mediaId, positionMs: 5_300_000, endReason: 'completion' as const });

        await ingestOfflineSessions(sql, { userId, user: undefined, records: [rec] });

        const [row] = await sql<{ session_end_time: Date }[]>`
            SELECT session_end_time FROM watch_history
            WHERE user_id = ${userId} AND media_id = ${mediaId}
        `;
        expect(row).toBeDefined();
        expect(new Date(row.session_end_time).toISOString()).toBe(rec.endedAt);
    });

    it('applies every record in a multi-record group for one media', async () => {
        const { id: mediaId } = await createAndInsertTestMovie(sql);
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        const base = Date.now() - 10 * 86_400_000;
        const records = Array.from({ length: 12 }, (_, i) =>
            record({
                mediaId,
                startedAt: new Date(base + i * 86_400_000).toISOString(),
                endedAt: new Date(base + i * 86_400_000 + 3_600_000).toISOString(),
                positionMs: 100_000 * (i + 1),
            }),
        );

        const results = await ingestOfflineSessions(sql, { userId, user: undefined, records });

        expect(results.every((r) => r.status === 'accepted')).toBe(true);
        const state = await getState.one(sql, { userId, mediaId });
        // The newest record's position, not an intermediate one.
        expect(state?.resume_position_ms).toBe(1_200_000);
        const events = await getEventsForMedia.all(sql, { userId, mediaId });
        expect(events.filter((e) => e.source === 'lumastra-offline').length).toBeGreaterThanOrEqual(
            12,
        );
    });

    it('a batch that itself crosses the compaction threshold does not strand its own later records', async () => {
        const { id: mediaId } = await createAndInsertTestMovie(sql);
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        // Seed events for this media right up to (but under) the compaction
        // threshold via raw inserts — no rebuild, no snapshot. Under a
        // per-record-rebuild implementation, this batch's OWN inserts would
        // cross COMPACTION_THRESHOLD partway through, minting a
        // occurred_at=now() snapshot that outranks every back-dated record
        // still left in the batch (see module header). A correct
        // implementation never writes a snapshot during ingestion, so the
        // batch's own volume must not affect its outcome.
        const seedCount = COMPACTION_THRESHOLD - 5;
        for (let i = 0; i < seedCount; i++) {
            await insertEvent.execute(sql, {
                event: {
                    user_id: userId,
                    media_id: mediaId,
                    event_type: 'progress',
                    source: 'jellyfin-sync',
                    position_ms: 1000 * i,
                    runtime_ms: 5_400_000,
                    source_event_id: `seed-${i}`,
                    session_id: null,
                    event_seq: null,
                    session_elapsed_ms: null,
                    occurred_at: new Date(Date.now() - 30 * 86_400_000 + i * 1000).toISOString(),
                },
            });
        }

        const base = Date.now() - 5 * 86_400_000;
        const records = Array.from({ length: 10 }, (_, i) =>
            record({
                mediaId,
                startedAt: new Date(base + i * 3_600_000).toISOString(),
                endedAt: new Date(base + i * 3_600_000 + 1_800_000).toISOString(),
                positionMs: 200_000 * (i + 1),
            }),
        );

        const results = await ingestOfflineSessions(sql, { userId, user: undefined, records });

        expect(results.every((r) => r.status === 'accepted')).toBe(true);
        const state = await getState.one(sql, { userId, mediaId });
        // The last (newest by occurred_at) record's position — not frozen at
        // an intermediate one behind a mid-batch snapshot.
        expect(state?.resume_position_ms).toBe(2_000_000);

        const events = await getEventsForMedia.all(sql, { userId, mediaId });
        expect(events.some((e) => e.event_type === 'state_snapshot')).toBe(false);
    });

    it('a live heartbeat is still accepted after an offline record lands', async () => {
        const { id: mediaId } = await createAndInsertTestMovie(sql);
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        await ingestOfflineSessions(sql, {
            userId,
            user: undefined,
            records: [record({ mediaId, positionMs: 600_000 })],
        });

        const { appendEventAndRebuild } = await import('./watch-state-rebuilder.service.js');
        const accepted = await appendEventAndRebuild(sql, {
            user_id: userId,
            media_id: mediaId,
            event_type: 'progress',
            source: 'lumastra-player',
            position_ms: 2_000_000,
            runtime_ms: 5_400_000,
            source_event_id: null,
            session_id: 'live-after-offline',
            event_seq: 1,
            session_elapsed_ms: 2_000_000,
            occurred_at: new Date().toISOString(),
        });

        expect(accepted).toBe(true);
        const state = await getState.one(sql, { userId, mediaId });
        expect(state?.resume_position_ms).toBe(2_000_000);
    });

    describe('combined multi-episode file — sibling completion', () => {
        // Same shape as the Hafentage S02E24E25 fixture in
        // file-segments.queries.integration.test.ts and
        // play-session-lifecycle.integration.test.ts: a 1354.602s file holding
        // two 660s-runtime episodes back to back, split by chapter markers at
        // 0 / 61.603 / 692.275 / 1323.072s — giving E24 the window
        // [0, 692275) and E25 the window [692275, 1354602).
        const FILE_DURATION_MS = 1_354_602;
        const CHAPTERS = [
            { name: 'Opening', startSeconds: 0 },
            { name: 'T.J. in Nöten', startSeconds: 61.603 },
            { name: 'Petey, der Schulschreck', startSeconds: 692.275 },
            { name: 'Credits', startSeconds: 1323.072 },
        ];

        async function seedCombinedFile(): Promise<{ e24Id: string; e25Id: string }> {
            const [series] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status, has_files)
                VALUES ('Offline Combined File Fixture Series', 'tv', 'active', true)
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

        it('completes a forward sibling episode whose own window is also crossed, and rebuilds its state too', async () => {
            const { e24Id, e25Id } = await seedCombinedFile();
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            // The offline record reports E24 (the opened episode), file-absolute
            // position/runtime — exactly like the live player. 1,300,000ms is
            // past BOTH E24's own window end (692,275ms) AND far enough into
            // E25's window ([692275, 1354602)) to cross E25's own 90% threshold
            // (692275 + 662327*0.9 ≈ 1,288,369ms).
            const results = await ingestOfflineSessions(sql, {
                userId,
                user: undefined,
                records: [
                    record({
                        mediaId: e24Id,
                        positionMs: 1_300_000,
                        runtimeMs: FILE_DURATION_MS,
                        endReason: 'stopped' as const,
                    }),
                ],
            });
            expect(results[0].status).toBe('accepted');

            const e24State = await getState.one(sql, { userId, mediaId: e24Id });
            expect(e24State?.is_watched).toBe(true);

            // The sibling's own state row must be rebuilt too, not left stale —
            // its media id differs from the group's own mediaId (e24Id).
            const e25State = await getState.one(sql, { userId, mediaId: e25Id });
            expect(e25State?.is_watched).toBe(true);

            const e25Events = await getEventsForMedia.all(sql, { userId, mediaId: e25Id });
            const sibCompleted = e25Events.find(
                (e) => e.event_type === 'completed' && e.source === 'lumastra-offline',
            );
            expect(sibCompleted).toBeDefined();
            expect(sibCompleted?.source_event_id).toBe(
                `offline:${results[0].eventId}:sib:${e25Id}`,
            );
        });
    });

    describe('audiobooks', () => {
        it('an offline audiobook record writes progress only — no completed event, no completed watch_history row, even past the local threshold', async () => {
            const item = createTestMediaItem({ media_type: AUDIOBOOK_MEDIA_TYPE, has_files: true });
            await insertTestMediaItem(sql, item);
            const mediaId = item.id;
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            // endReason 'completion' AND a position past the local threshold —
            // either alone would be enough to trigger a 'completed' event for a
            // video item. Neither may for an audiobook: ABS owns completion.
            const rec = record({
                mediaId,
                positionMs: 5_300_000,
                endReason: 'completion' as const,
            });

            const results = await ingestOfflineSessions(sql, {
                userId,
                user: undefined,
                records: [rec],
            });
            expect(results[0].status).toBe('accepted');

            const events = await getEventsForMedia.all(sql, { userId, mediaId });
            expect(
                events.some((e) => e.event_type === 'progress' && e.source === 'lumastra-offline'),
            ).toBe(true);
            expect(events.some((e) => e.event_type === 'completed')).toBe(false);

            const state = await getState.one(sql, { userId, mediaId });
            expect(state?.is_watched).toBe(false);
            // Progress still lands — offline sync's job for an audiobook is
            // pushing resume position, not deciding completion.
            expect(state?.resume_position_ms).toBe(5_300_000);

            // recordCompletedSession (status: 'completed') is never called for
            // an audiobook at all — no row of any status should land, not just
            // no 'completed' one.
            const historyRows = await sql<{ status: string }[]>`
                SELECT status FROM watch_history
                WHERE user_id = ${userId} AND media_id = ${mediaId}
            `;
            expect(historyRows).toHaveLength(0);
        });
    });
});
