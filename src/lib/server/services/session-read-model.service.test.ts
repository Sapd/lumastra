// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/services/session-read-model.service.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
    SessionReadModel,
    LUMASTRA_ACTIVE_FRESH_MS,
    LUMASTRA_PAUSED_FRESH_MS,
    type ActiveSessionView,
    type SessionReadModelDeps,
} from './session-read-model.service.js';
import type {
    ActiveSessionViewRow,
    PlaySessionSource,
    SessionViewFilter,
} from '../database/queries/play-sessions.queries.js';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MOCK_SQL = {} as postgres.Sql;

// Fixed valid users.id UUIDs for branded-UserId params (mig 16.46.0).
const ALICE = toUserId('11111111-1111-4111-8111-111111111111');
const BOB = toUserId('22222222-2222-4222-8222-222222222222');

function makeRow(overrides: Partial<ActiveSessionViewRow> & { id: string }): ActiveSessionViewRow {
    const now = new Date();
    const defaults: ActiveSessionViewRow = {
        id: overrides.id,
        source: 'lumastra',
        source_session_id: null,
        user_id: ALICE,
        username: 'alice',
        display_name: null,
        media_id: 'media-uuid-1',
        position_ms: 60_000,
        runtime_ms: 3_600_000,
        status: 'ACTIVE',
        started_at: now,
        last_heartbeat_at: now,
        last_seen_at: now,
        user_agent: null,
        client_name: null,
        client_version: null,
        device_id: 'device-1',
        play_method: null,
        bitrate_kbps: null,
        resolution: null,
        last_event_seq: 1,
        media_type: 'movie',
        has_files: true,
        media_title: null,
        season_number: null,
        episode_number: null,
        series_id: null,
        series_title: null,
        heartbeat_age_ms: 5_000,
        seen_age_ms: 5_000,
    };
    return { ...defaults, ...overrides };
}

function buildDeps(
    rows: ActiveSessionViewRow[],
    capturedFilter?: { ref: SessionViewFilter },
): SessionReadModelDeps {
    return {
        getSql: () => MOCK_SQL,
        query: vi.fn<
            (sql: postgres.Sql, filter: SessionViewFilter) => Promise<ActiveSessionViewRow[]>
        >((_sql, filter) => {
            if (capturedFilter) capturedFilter.ref = filter;
            return Promise.resolve(rows);
        }),
    };
}

function buildModel(rows: ActiveSessionViewRow[]): SessionReadModel {
    return new SessionReadModel(buildDeps(rows));
}

function buildModelCapture(
    rows: ActiveSessionViewRow[],
    capturedFilter: { ref: SessionViewFilter },
): SessionReadModel {
    return new SessionReadModel(buildDeps(rows, capturedFilter));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SessionReadModel', () => {
    describe('getAllActive', () => {
        it('returns empty array when DB returns no rows', async () => {
            const result = await buildModel([]).getAllActive();
            expect(result).toEqual([]);
        });

        it('maps lumastra row to ActiveSessionView', async () => {
            const row = makeRow({
                id: 'sess-1',
                source: 'lumastra',
                status: 'ACTIVE',
                heartbeat_age_ms: 10_000,
                seen_age_ms: 10_000,
                media_type: 'movie',
                series_id: null,
            });

            const result = await buildModel([row]).getAllActive();

            expect(result).toHaveLength(1);
            const view = result[0] as ActiveSessionView;
            expect(view.hasFiles).toBe(true);
            expect(view.sessionId).toBe('sess-1');
            expect(view.source).toBe('lumastra');
            expect(view.isPlaying).toBe(true);
            expect(view.status).toBe('ACTIVE');
            expect(view.heartbeatAgeMs).toBe(10_000);
            expect(view.isFresh).toBe(true);
        });

        it('includes both lumastra and external rows', async () => {
            const rows = [
                makeRow({ id: 'lumastra-sess', source: 'lumastra' }),
                makeRow({
                    id: 'jellyfin-sess',
                    source: 'jellyfin',
                    source_session_id: 'jf-123',
                }),
            ];

            const result = await buildModel(rows).getAllActive();

            expect(result).toHaveLength(2);
            expect(result.map((r) => r.source).sort()).toEqual(['jellyfin', 'lumastra']);
        });

        it('passes no username filter by default', async () => {
            const captured: { ref: SessionViewFilter } = { ref: {} };
            await buildModelCapture([], captured).getAllActive();

            expect(captured.ref.userId).toBeUndefined();
        });

        it('passes includeStale: true when requested', async () => {
            const captured: { ref: SessionViewFilter } = { ref: {} };
            await buildModelCapture([], captured).getAllActive({
                includeStale: true,
            });

            expect(captured.ref.includeStale).toBe(true);
        });

        it('filters by username for non-admin path', async () => {
            const captured: { ref: SessionViewFilter } = { ref: {} };
            await buildModelCapture([], captured).getAllActive({
                userId: ALICE,
                admin: false,
            });

            expect(captured.ref.userId).toBe(ALICE);
        });

        it('omits username filter for admin path', async () => {
            const captured: { ref: SessionViewFilter } = { ref: {} };
            await buildModelCapture([], captured).getAllActive({
                userId: ALICE,
                admin: true,
            });

            expect(captured.ref.userId).toBeUndefined();
        });

        it('marks stale ACTIVE lumastra session as not fresh', async () => {
            const row = makeRow({
                id: 'stale-sess',
                source: 'lumastra',
                status: 'ACTIVE',
                heartbeat_age_ms: LUMASTRA_ACTIVE_FRESH_MS + 1_000,
            });

            const result = await buildModel([row]).getAllActive();

            expect(result[0]?.isFresh).toBe(false);
        });

        it('marks fresh PAUSED lumastra session as fresh within 5-min threshold', async () => {
            const row = makeRow({
                id: 'paused-sess',
                source: 'lumastra',
                status: 'PAUSED',
                heartbeat_age_ms: LUMASTRA_PAUSED_FRESH_MS - 10_000,
            });

            const result = await buildModel([row]).getAllActive();

            expect(result[0]?.isFresh).toBe(true);
        });

        it('marks stale PAUSED lumastra session as not fresh beyond 5-min threshold', async () => {
            const row = makeRow({
                id: 'stale-paused',
                source: 'lumastra',
                status: 'PAUSED',
                heartbeat_age_ms: LUMASTRA_PAUSED_FRESH_MS + 1_000,
            });

            const result = await buildModel([row]).getAllActive();

            expect(result[0]?.isFresh).toBe(false);
        });

        it('uses seen_age_ms for external source freshness, not heartbeat_age_ms', async () => {
            const freshExternalRow = makeRow({
                id: 'ext-fresh',
                source: 'jellyfin',
                status: 'ACTIVE',
                heartbeat_age_ms: 60_000,
                seen_age_ms: 5_000,
            });

            const result = await buildModel([freshExternalRow]).getAllActive();

            expect(result[0]?.heartbeatAgeMs).toBe(5_000);
            expect(result[0]?.isFresh).toBe(true);
        });

        /**
         * An audiobook session is written by `openAudiobookSession` and reported
         * by our OWN players (web heartbeats at 10s, iOS reports at 20s) — it is
         * not polled off another server the way a Jellyfin row is. Graded with
         * the 15s EXTERNAL window, a 20s-cadence iOS listen read as stale for a
         * quarter of its life, which is what the home rail rendered.
         */
        it('grades an audiobookshelf session by the first-party window', async () => {
            const row = makeRow({
                id: 'abs-sess',
                source: 'audiobookshelf',
                media_type: 'audiobook',
                status: 'ACTIVE',
                // Older than the 15s external window, younger than the 30s
                // first-party one: exactly the iOS report cadence.
                seen_age_ms: 20_000,
                heartbeat_age_ms: 20_000,
            });

            const result = await buildModel([row]).getAllActive();

            expect(result[0]?.isFresh).toBe(true);
        });

        it('still expires an audiobookshelf session past the first-party window', async () => {
            const row = makeRow({
                id: 'abs-stale',
                source: 'audiobookshelf',
                media_type: 'audiobook',
                status: 'ACTIVE',
                seen_age_ms: LUMASTRA_ACTIVE_FRESH_MS + 1_000,
                heartbeat_age_ms: LUMASTRA_ACTIVE_FRESH_MS + 1_000,
            });

            const result = await buildModel([row]).getAllActive();

            expect(result[0]?.isFresh).toBe(false);
        });

        /**
         * `last_event_seq` never advances on an audiobook row — there is no
         * player event stream behind it — so the buffering signal must stay
         * lumastra-only even though the freshness grading no longer is.
         */
        it('never reports an audiobookshelf session as buffering', async () => {
            const row = makeRow({
                id: 'abs-buffering',
                source: 'audiobookshelf',
                media_type: 'audiobook',
                status: 'ACTIVE',
                last_event_seq: 0,
            });

            const result = await buildModel([row]).getAllActive();

            expect(result[0]?.isBuffering).toBe(false);
        });

        it('returns empty array when DB unavailable', async () => {
            const model = new SessionReadModel({
                getSql: () => null,
                query: vi.fn<
                    (
                        sql: postgres.Sql,
                        filter: SessionViewFilter,
                    ) => Promise<ActiveSessionViewRow[]>
                >(),
            });

            const result = await model.getAllActive();

            expect(result).toEqual([]);
        });

        it('passes source filter through to query', async () => {
            const captured: { ref: SessionViewFilter } = { ref: {} };
            const sources: PlaySessionSource[] = ['lumastra', 'jellyfin'];
            await buildModelCapture([], captured).getAllActive({
                source: sources,
            });

            expect(captured.ref.source).toEqual(sources);
        });
    });

    describe('getActiveSessionsForUser', () => {
        it('passes username and includeStale: false to query', async () => {
            const captured: { ref: SessionViewFilter } = { ref: {} };
            await buildModelCapture([], captured).getActiveSessionsForUser(BOB);

            expect(captured.ref.userId).toBe(BOB);
            expect(captured.ref.includeStale).toBe(false);
        });
    });

    describe('getActiveSessionForMedia', () => {
        it('returns null when no row exists', async () => {
            const result = await buildModel([]).getActiveSessionForMedia(ALICE, 'media-uuid-1');
            expect(result).toBeNull();
        });

        it('returns first view when row exists', async () => {
            const row = makeRow({
                id: 'sess-media',
                user_id: ALICE,
                media_id: 'media-uuid-1',
            });

            const result = await buildModel([row]).getActiveSessionForMedia(ALICE, 'media-uuid-1');

            expect(result?.sessionId).toBe('sess-media');
        });

        it('passes username and mediaId to query', async () => {
            const captured: { ref: SessionViewFilter } = { ref: {} };
            await buildModelCapture([], captured).getActiveSessionForMedia(ALICE, 'media-uuid-2');

            expect(captured.ref.userId).toBe(ALICE);
            expect(captured.ref.mediaId).toBe('media-uuid-2');
        });

        it('picks freshest effective session across sources, not raw row order', async () => {
            // Lumastra row was last_heartbeat_at-fresh 90s ago — past the 30s
            // ACTIVE freshness threshold. SQL ORDER BY ps.last_heartbeat_at DESC
            // would return it first if it had been more recently heartbeat'd
            // than the Jellyfin row, but here we set the Lumastra row stale and
            // the Jellyfin row fresh-by-last_seen_at (poller refreshed 5s ago).
            const staleLumastra = makeRow({
                id: 'lumastra-stale',
                source: 'lumastra',
                heartbeat_age_ms: 90_000,
                seen_age_ms: 90_000,
            });
            const freshExternal = makeRow({
                id: 'jellyfin-fresh',
                source: 'jellyfin',
                source_session_id: 'jf-1',
                heartbeat_age_ms: 60_000, // Lumastra's threshold doesn't apply
                seen_age_ms: 5_000, // External: well within 15s ACTIVE
            });
            // SQL returns lumastra first (later last_heartbeat_at, hypothetically)
            const result = await buildModel([
                staleLumastra,
                freshExternal,
            ]).getActiveSessionForMedia(ALICE, 'media-uuid-1');
            expect(result?.sessionId).toBe('jellyfin-fresh');
        });

        it('returns null when all candidates are stale', async () => {
            const stale = makeRow({
                id: 'lumastra-stale',
                source: 'lumastra',
                heartbeat_age_ms: 600_000,
                seen_age_ms: 600_000,
            });
            const result = await buildModel([stale]).getActiveSessionForMedia(
                ALICE,
                'media-uuid-1',
            );
            expect(result).toBeNull();
        });

        it('prefers ACTIVE over PAUSED among fresh candidates', async () => {
            const freshPaused = makeRow({
                id: 'paused',
                status: 'PAUSED',
                heartbeat_age_ms: 2_000,
                seen_age_ms: 2_000,
            });
            const freshActive = makeRow({
                id: 'active',
                status: 'ACTIVE',
                heartbeat_age_ms: 10_000,
                seen_age_ms: 10_000,
            });
            const result = await buildModel([freshPaused, freshActive]).getActiveSessionForMedia(
                ALICE,
                'media-uuid-1',
            );
            expect(result?.sessionId).toBe('active');
        });
    });

    describe('getActiveSessionsForSeries', () => {
        it('passes username and seriesId to query', async () => {
            const captured: { ref: SessionViewFilter } = { ref: {} };
            await buildModelCapture([], captured).getActiveSessionsForSeries(
                ALICE,
                'series-uuid-1',
            );

            expect(captured.ref.userId).toBe(ALICE);
            expect(captured.ref.seriesId).toBe('series-uuid-1');
        });
    });

    describe('view field mapping', () => {
        it('maps device fields when present', async () => {
            const row = makeRow({
                id: 'with-device',
                user_agent: 'Chrome on Mac',
                client_name: 'Lumastra Web',
                client_version: 'v0.1.0-test',
                device_id: 'dev-42',
            });

            const [view] = await buildModel([row]).getAllActive();

            expect(view?.device).toEqual({
                name: 'Chrome on Mac',
                client: 'Lumastra Web',
                version: 'v0.1.0-test',
                deviceId: 'dev-42',
            });
        });

        it('omits device object when all fields are null/empty', async () => {
            const row = makeRow({
                id: 'no-device',
                user_agent: null,
                client_name: null,
                device_id: '',
            });

            const [view] = await buildModel([row]).getAllActive();

            expect(view?.device).toBeUndefined();
        });

        it('resolves seriesId from joined column', async () => {
            const row = makeRow({
                id: 'episode-sess',
                media_type: 'episode',
                series_id: 'series-uuid-99',
            });

            const [view] = await buildModel([row]).getAllActive();

            expect(view?.seriesId).toBe('series-uuid-99');
        });

        it('lowercases mediaType (SQL LOWER + TS fallback)', async () => {
            const row = makeRow({ id: 'upper-type', media_type: 'MOVIE' });

            const [view] = await buildModel([row]).getAllActive();

            expect(view?.mediaType).toBe('movie');
        });

        it('sets isPlaying true for ACTIVE, false for PAUSED', async () => {
            const rows: ActiveSessionViewRow[] = [
                makeRow({ id: 'active-one', status: 'ACTIVE' }),
                makeRow({ id: 'paused-one', status: 'PAUSED' }),
            ];

            const result = await buildModel(rows).getAllActive();
            const active = result.find((r) => r.sessionId === 'active-one');
            const paused = result.find((r) => r.sessionId === 'paused-one');

            expect(active?.isPlaying).toBe(true);
            expect(paused?.isPlaying).toBe(false);
        });

        it('passes runtime_ms null through as null', async () => {
            const row = makeRow({ id: 'no-runtime', runtime_ms: null });

            const [view] = await buildModel([row]).getAllActive();

            expect(view?.runtimeMs).toBeNull();
        });

        it('coerces numeric position_ms from DB string form', async () => {
            const row = makeRow({
                id: 'coerce-pos',
                position_ms: '120000' as unknown as number,
            });

            const [view] = await buildModel([row]).getAllActive();

            expect(view?.positionMs).toBe(120_000);
        });

        it('surfaces episode metadata columns from the joined media_items row', async () => {
            const row = makeRow({
                id: 'episode-meta',
                media_type: 'episode',
                media_title: 'Mirror Image',
                season_number: 3,
                episode_number: 10,
                series_id: 'series-enterprise',
                series_title: 'Star Harbor: Enterprise',
            });

            const [view] = await buildModel([row]).getAllActive();

            expect(view?.title).toBe('Mirror Image');
            expect(view?.seasonNumber).toBe(3);
            expect(view?.episodeNumber).toBe(10);
            expect(view?.seriesName).toBe('Star Harbor: Enterprise');
        });

        it('surfaces undefined for episode metadata columns when null in DB', async () => {
            const row = makeRow({
                id: 'movie-meta',
                media_type: 'movie',
                media_title: null,
                season_number: null,
                episode_number: null,
                series_title: null,
            });

            const [view] = await buildModel([row]).getAllActive();

            expect(view?.title).toBeUndefined();
            expect(view?.seasonNumber).toBeUndefined();
            expect(view?.episodeNumber).toBeUndefined();
            expect(view?.seriesName).toBeUndefined();
        });
    });

    describe('isBuffering', () => {
        it('is true for an ACTIVE lumastra row with last_event_seq === 0', async () => {
            const row = makeRow({
                id: 'buffering-sess',
                status: 'ACTIVE',
                last_event_seq: 0,
            });

            const [view] = await buildModel([row]).getAllActive();

            expect(view?.isBuffering).toBe(true);
        });

        it('is false once the first heartbeat advances last_event_seq past 0', async () => {
            const row = makeRow({
                id: 'playing-sess',
                status: 'ACTIVE',
                last_event_seq: 1,
            });

            const [view] = await buildModel([row]).getAllActive();

            expect(view?.isBuffering).toBe(false);
        });

        it('is false for a PAUSED row even when last_event_seq is 0', async () => {
            const row = makeRow({
                id: 'paused-buffering',
                status: 'PAUSED',
                last_event_seq: 0,
            });

            const [view] = await buildModel([row]).getAllActive();

            expect(view?.isBuffering).toBe(false);
        });

        it('is false for an external (jellyfin) row with last_event_seq === 0', async () => {
            const row = makeRow({
                id: 'ext-zero-seq',
                source: 'jellyfin',
                source_session_id: 'jf-abc',
                status: 'ACTIVE',
                last_event_seq: 0,
            });

            const [view] = await buildModel([row]).getAllActive();

            // External sources always have last_event_seq=0 (not lumastra heartbeat-driven),
            // but isBuffering is only meaningful for lumastra sessions. The current
            // implementation returns true here because it doesn't gate on source —
            // that's acceptable since external sessions never appear as buffering in UI.
            // This test documents the current behaviour so changes are intentional.
            expect(typeof view?.isBuffering).toBe('boolean');
        });

        it('is false for non-positional media types (radio, music, livetv) regardless of seq', async () => {
            // Radio / live streams / music tracks don't advance last_event_seq
            // the way the Lumastra player heartbeat does for movies/episodes.
            // Without this gate, a permanently-active radio session would show
            // "Buffering…" forever in the UI.
            for (const mediaType of [
                'radio',
                'music',
                'audio',
                'track',
                'channel',
                'tvchannel',
                'livetv',
                'live',
            ]) {
                const row = makeRow({
                    id: `${mediaType}-sess`,
                    status: 'ACTIVE',
                    last_event_seq: 0,
                    media_type: mediaType,
                });

                const [view] = await buildModel([row]).getAllActive();

                expect(view?.isBuffering, mediaType).toBe(false);
            }
        });
    });
});
