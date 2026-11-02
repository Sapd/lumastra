// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for MediaAggregationService.
 *
 * External providers (Live TV, Audiobookshelf, Jellyseerr) and the Valkey
 * read model / cache are mocked so tests are deterministic and
 * network-independent. The REAL `lumastra_tests` database is used for the
 * session-enrichment path: `getActiveSessions` runs the real
 * `getAllActiveSessionsWithMedia` join against seeded `play_sessions` /
 * `media_items` rows and we assert the enriched output reflects DB state.
 *
 * Covered:
 *   searchAcrossServices:
 *     - all sources timeout/fail → returns empty results (not an error)
 *     - successful source results are aggregated (incl. a jellyseerr-origin item)
 *     - maxResults is respected
 *   sortAndDeduplicateResults (via searchAcrossServices):
 *     - duplicate title+year entries collapse to exactly one survivor
 *   getAggregationStats:
 *     - counts sources and totals correctly
 *   getActiveSessions (real DB enrichment):
 *     - empty play_sessions → zero sessions
 *     - seeded session is enriched with the real media_items title / metadata
 *     - a Various Artists compilation track names its own performer, not the marker
 *     - a non-track item with an 'artist' tag still reports no artist
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type { MediaItem } from '$lib/server/types.js';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import type { ActiveSessionView } from './session-read-model.service.js';

// ---------------------------------------------------------------------------
// Module-level mocks — must be hoisted before any service import.
// `getAllActive` is a hoisted vi.fn() so each test can control which read-model
// views are returned, while the DB enrichment query runs for real.
// ---------------------------------------------------------------------------

const { mockGetAllActive, mockGetSql } = vi.hoisted(() => ({
    mockGetAllActive: vi.fn(),
    mockGetSql: vi.fn(),
}));

vi.mock('$lib/server/audiobookshelf.js', () => ({
    audiobookshelfClient: {
        search: vi.fn().mockResolvedValue([]),
    },
}));

vi.mock('$lib/server/jellyseerr.js', () => ({
    jellyseerrClient: {
        search: vi.fn().mockResolvedValue([]),
    },
}));

const { mockSearchChannels } = vi.hoisted(() => ({
    mockSearchChannels: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/server/services/livetv/index.js', () => ({
    getLiveTvProvider: vi.fn().mockResolvedValue({
        searchChannels: mockSearchChannels,
    }),
}));

// Mock ONLY the Valkey-backed read model so getActiveSessions doesn't require
// Valkey. The DB enrichment query (getAllActiveSessionsWithMedia) is NOT mocked
// — it runs against the real test DB via the sql handle below.
vi.mock('$lib/server/services/session-read-model.service.js', () => ({
    getSessionReadModel: vi.fn().mockReturnValue({
        getAllActive: mockGetAllActive,
    }),
}));

// Pin aiDbService.getSql() to the harness test-DB connection. The web pool
// (getDb()) reads DATABASE_URL captured at connection.ts load, which the
// vitest setup mirror does not reliably redirect to lumastra_tests in time — so
// without this the enrichment query would hit the dev DB. Mocking getSql keeps
// the REAL getAllActiveSessionsWithMedia query running against the same
// lumastra_tests rows the test seeds.
vi.mock('./database.service.js', () => ({
    aiDbService: {
        getSql: mockGetSql,
    },
}));

// Mock cache manager to avoid Valkey dependency in the search + next-track
// cache paths. `for()` returns a stub that yields no cached entries.
vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: {
        for: vi.fn().mockReturnValue({
            get: vi.fn().mockResolvedValue(null),
            set: vi.fn().mockResolvedValue(undefined),
        }),
    },
    CACHE_NAMESPACES: {
        search: 'search',
        musicNextTrack: 'musicNextTrack',
    },
}));

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import {
    MediaAggregationService,
    type AggregatedSearchResults,
    type SessionAggregationResult,
} from './media-aggregation.service.js';
import { jellyseerrClient } from '$lib/server/jellyseerr.js';
import { unauthenticatedSearchAccessContext } from '$lib/server/utils/search-access-context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMediaItem(overrides: Partial<MediaItem>): MediaItem {
    return {
        id: crypto.randomUUID(),
        title: 'Test Film',
        mediaType: 'movie',
        externalIds: { internal: crypto.randomUUID() },
        ...overrides,
    };
}

/**
 * Build an ActiveSessionView (the Valkey read-model shape) referencing a
 * seeded play_sessions row. `getActiveSessions` maps over these views and
 * enriches each by sessionId from the real DB query.
 */
function makeView(
    overrides: Partial<ActiveSessionView> & {
        sessionId: string;
        mediaId: string;
    },
): ActiveSessionView {
    const now = new Date();
    return {
        source: 'lumastra',
        sourceSessionId: null,
        username: 'tester',
        seriesId: null,
        mediaType: 'movie',
        positionMs: 60_000,
        runtimeMs: 7_200_000,
        status: 'ACTIVE',
        isPlaying: true,
        startedAt: now,
        lastHeartbeatAt: now,
        lastSeenAt: now,
        heartbeatAgeMs: 0,
        isFresh: true,
        isBuffering: false,
        ...overrides,
    } as ActiveSessionView;
}

/**
 * Seed a movie media_items row and an ACTIVE play_sessions row pointing at it.
 * Returns { sessionId, mediaId }. Only NOT-NULL columns are populated.
 *
 * play_sessions.user_id is uuid REFERENCES users(id) since mig 16.46.0, so we
 * INSERT INTO users with an explicit id and use that id for play_sessions.
 */
async function seedActiveMovieSession(
    sql: postgres.Sql,
    opts: { title: string; year?: number; username?: string },
): Promise<{ sessionId: string; mediaId: string }> {
    const mediaId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const username = opts.username ?? 'tester';

    await sql`
        INSERT INTO users (id, username)
        VALUES (${userId}::uuid, ${username})
        ON CONFLICT (username) DO UPDATE SET id = users.id
    `;
    // Re-fetch the actual id in case of conflict (username already existed).
    const [{ id: resolvedUserId }] = await sql<{ id: string }[]>`
        SELECT id FROM users WHERE username = ${username}
    `;
    await sql`
        INSERT INTO user_profiles (user_id)
        VALUES (${resolvedUserId}::uuid)
        ON CONFLICT (user_id) DO NOTHING
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, year, runtime_seconds, status)
        VALUES (${mediaId}::uuid, ${opts.title}, 'movie', ${opts.year ?? null}, 7200, 'active')
    `;
    await sql`
        INSERT INTO play_sessions (
            id, media_id, user_id, device_id, ip_address, play_method,
            status, position_ms, runtime_ms, source
        ) VALUES (
            ${sessionId}::uuid, ${mediaId}::uuid, ${resolvedUserId}::uuid,
            'device-1', '127.0.0.1'::inet, 'direct',
            'ACTIVE', 60000, 7200000, 'lumastra'
        )
    `;
    return { sessionId, mediaId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Dependents first. media_files/media_file_items carry the probed-format
// fixtures the audio-bitrate cases attach; media_streams cascades from
// media_files.
const SESSION_CLEANUP_TABLES = [
    'play_sessions',
    'media_file_items',
    'media_files',
    'media_items',
    'users',
] as const;

describe('MediaAggregationService (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        vi.clearAllMocks();
        // Default: no active sessions from the read model.
        mockGetAllActive.mockResolvedValue([]);
        // Pin the service's DB handle to the harness test connection.
        mockGetSql.mockResolvedValue(sql);
        await truncateTables(sql, SESSION_CLEANUP_TABLES);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    // -----------------------------------------------------------------------
    // searchAcrossServices — all sources fail
    // -----------------------------------------------------------------------

    describe('searchAcrossServices – all sources return empty/fail', () => {
        it('returns an empty AggregatedSearchResults when all providers return []', async () => {
            // Providers already mock-return [] by default.
            const result = await MediaAggregationService.searchAcrossServices(
                'nonexistent-title-xyz',
                {
                    sources: ['livetv', 'jellyseerr'],
                    liveTvAllowed: true,
                    accessCtx: unauthenticatedSearchAccessContext(),
                },
            );

            expect(result.items).toHaveLength(0);
            expect(result.totalResults).toBe(0);
            expect(result.sources.livetv.count).toBe(0);
            expect(result.sources.jellyseerr.count).toBe(0);
        });

        it('handles provider timeout gracefully (returns empty, not an error)', async () => {
            // Make Live TV hang forever so the internal Promise.race triggers timeout.
            mockSearchChannels.mockImplementation(
                () => new Promise(() => {}), // never resolves
            );

            const result = await MediaAggregationService.searchAcrossServices(
                'hangtown',
                {
                    sources: ['livetv'],
                    timeout: 50,
                    liveTvAllowed: true,
                    accessCtx: unauthenticatedSearchAccessContext(),
                }, // 50ms timeout
            );

            expect(result.items).toHaveLength(0);
            expect(result.sources.livetv.count).toBe(0);
        });

        it('handles provider rejection gracefully (returns empty)', async () => {
            mockSearchChannels.mockRejectedValue(new Error('Live TV API error'));

            const result = await MediaAggregationService.searchAcrossServices('error-test', {
                sources: ['livetv'],
                liveTvAllowed: true,
                accessCtx: unauthenticatedSearchAccessContext(),
            });

            expect(result.items).toHaveLength(0);
        });
    });

    // -----------------------------------------------------------------------
    // searchAcrossServices — sources succeed
    // -----------------------------------------------------------------------

    describe('searchAcrossServices – sources return results', () => {
        it('aggregates results from Live TV and jellyseerr without searching Jellyfin items', async () => {
            mockSearchChannels.mockResolvedValue([
                {
                    id: 'channel-1',
                    name: 'Lumastra Live',
                    images: {
                        primary: {
                            href: 'https://example.test/logo.png',
                            revision: '0',
                            source: 'self',
                        },
                    },
                },
            ]);

            // Jellyseerr items (status != 5 to survive the filter).
            const jellyseerrItems = [
                {
                    id: 1,
                    title: 'Dawn',
                    mediaType: 'movie',
                    status: 1,
                    tmdbId: 438631,
                },
            ];
            vi.mocked(jellyseerrClient.search).mockResolvedValue(
                jellyseerrItems as unknown as Awaited<ReturnType<typeof jellyseerrClient.search>>,
            );

            const result = await MediaAggregationService.searchAcrossServices('daydream', {
                sources: ['livetv', 'jellyseerr'],
                liveTvAllowed: true,
                maxResults: 10,
                accessCtx: unauthenticatedSearchAccessContext(),
            });

            const titles = result.items.map((i) => i.title);
            expect(titles).toContain('Lumastra Live');
            // The jellyseerr item ('Dawn') must survive the status filter and
            // be aggregated — it is transformed to mediaType 'anfragen'.
            const dawn = result.items.find((i) => i.title === 'Dawn');
            expect(dawn).toBeDefined();
            expect(dawn?.mediaType).toBe('anfragen');

            // Source breakdown must reflect what each provider contributed.
            expect(result.sources.livetv.success).toBe(true);
            expect(result.sources.livetv.count).toBe(1);
            expect(result.sources.jellyseerr.success).toBe(true);
            expect(result.sources.jellyseerr.count).toBe(1);
        });

        it('respects maxResults', async () => {
            const many = Array.from({ length: 5 }, (_, i) => ({
                id: `channel-${i}`,
                name: `Film ${i}`,
                images: {},
            }));
            mockSearchChannels.mockResolvedValue(many);

            const result = await MediaAggregationService.searchAcrossServices('film', {
                sources: ['livetv'],
                liveTvAllowed: true,
                maxResults: 3,
                accessCtx: unauthenticatedSearchAccessContext(),
            });

            expect(result.items.length).toBeLessThanOrEqual(3);
        });

        it('deduplicates items from the same source with the same title and year', async () => {
            const channels = [
                {
                    id: 'channel-dup-1',
                    name: 'Duplicate Film',
                    images: {},
                },
                {
                    id: 'channel-dup-2',
                    name: 'Duplicate Film',
                    images: {},
                },
            ];
            mockSearchChannels.mockResolvedValue(channels);

            const result = await MediaAggregationService.searchAcrossServices('Duplicate Film', {
                sources: ['livetv'],
                liveTvAllowed: true,
                maxResults: 10,
                accessCtx: unauthenticatedSearchAccessContext(),
            });

            // Both inputs were valid, so the survivor count distinguishes
            // dedup (exactly 1) from a total drop (0). Dedup by title+year must
            // collapse the two identical rows to exactly one survivor.
            const duplicates = result.items.filter((item) => item.title === 'Duplicate Film');
            expect(duplicates).toHaveLength(1);
        });

        it('excludes jellyseerr items with status=5 (already available)', async () => {
            const available = {
                id: 99,
                title: 'Already Available',
                mediaType: 'movie',
                status: 5,
                tmdbId: 55555,
            };
            vi.mocked(jellyseerrClient.search).mockResolvedValue([available] as unknown as Awaited<
                ReturnType<typeof jellyseerrClient.search>
            >);

            const result = await MediaAggregationService.searchAcrossServices('already available', {
                sources: ['jellyseerr'],
                maxResults: 10,
                accessCtx: unauthenticatedSearchAccessContext(),
            });

            const found = result.items.find((i) => i.title === 'Already Available');
            expect(found).toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // getAggregationStats
    // -----------------------------------------------------------------------

    describe('getAggregationStats', () => {
        it('correctly counts total items and source breakdown for AggregatedSearchResults', () => {
            const mockResult: AggregatedSearchResults = {
                items: [makeMediaItem({ title: 'A' }), makeMediaItem({ title: 'B' })],
                totalResults: 2,
                sources: {
                    livetv: { count: 0, success: true },
                    jellyfin: { count: 2, success: true },
                    audiobookshelf: { count: 0, success: false },
                    jellyseerr: { count: 0, success: false },
                    sonarr: { count: 0, success: false },
                },
            };

            const stats = MediaAggregationService.getAggregationStats(mockResult);

            expect(stats.totalItems).toBe(2);
            // livetv + jellyfin succeeded; audiobookshelf + jellyseerr + sonarr failed.
            expect(stats.successfulSources).toBe(2);
            expect(stats.failedSources).toBe(3);
            expect(stats.sourceBreakdown.jellyfin).toBe(2);
            expect(stats.sourceBreakdown.audiobookshelf).toBe(0);
            // The invariant that actually drifted: EVERY declared source is
            // classified exactly once. Commit 699c29d79 added the `livetv` key
            // to satisfy a required type without touching the arithmetic, so
            // the hard-coded 1/3 stopped describing the fixture. Asserting the
            // partition means the next added source key fails loudly here
            // instead of quietly skewing the counts.
            expect(stats.successfulSources + stats.failedSources).toBe(
                Object.keys(mockResult.sources).length,
            );
        });

        it('counts totalSessions for SessionAggregationResult', () => {
            const mockSession: SessionAggregationResult = {
                sessions: [],
                totalSessions: 0,
                sources: {
                    jellyfin: { count: 0, success: true },
                },
            };

            const stats = MediaAggregationService.getAggregationStats(mockSession);
            expect(stats.totalItems).toBe(0);
            expect(stats.successfulSources).toBe(1);
        });

        it('handles all-failed sources', () => {
            const mockResult: AggregatedSearchResults = {
                items: [],
                totalResults: 0,
                sources: {
                    livetv: { count: 0, success: false },
                    jellyfin: { count: 0, success: false },
                    audiobookshelf: { count: 0, success: false },
                    jellyseerr: { count: 0, success: false },
                    sonarr: { count: 0, success: false },
                },
            };

            const stats = MediaAggregationService.getAggregationStats(mockResult);
            expect(stats.totalItems).toBe(0);
            expect(stats.successfulSources).toBe(0);
            // All five declared sources failed (see the partition note above).
            expect(stats.failedSources).toBe(5);
            expect(stats.failedSources).toBe(Object.keys(mockResult.sources).length);
        });
    });

    // -----------------------------------------------------------------------
    // getActiveSessions – DB path (real DB, mocked session read model)
    // -----------------------------------------------------------------------

    describe('getActiveSessions (real DB enrichment)', () => {
        // aiDbService.getSql() is mocked to return the harness `sql` handle, so
        // the REAL getAllActiveSessionsWithMedia enrichment query runs against
        // the same lumastra_tests rows we seed here. The outer beforeEach already
        // truncated play_sessions/media_items/users on `sql`.

        it('returns zero sessions when the read model reports none', async () => {
            mockGetAllActive.mockResolvedValue([]);

            const result = await MediaAggregationService.getActiveSessions([]);

            expect(result.sessions).toHaveLength(0);
            expect(result.totalSessions).toBe(0);
            expect(result.sources.jellyfin.success).toBe(true);
            expect(result.sources.jellyfin.count).toBe(0);
        });

        it('enriches a live session with the real media title from the DB join', async () => {
            // Seed a real movie + active play_sessions row, then have the read
            // model surface a view for that exact sessionId. The enrichment
            // query (getAllActiveSessionsWithMedia) runs against the real DB.
            const { sessionId, mediaId } = await seedActiveMovieSession(sql, {
                title: 'Cloud Runner 2049',
                year: 2017,
                username: 'alice',
            });
            await sql`UPDATE play_sessions SET client_name = 'Apple',
                client_version = '1.0.1 (2610140823)', user_agent = 'Apple test agent'
                WHERE id = ${sessionId}::uuid`;

            mockGetAllActive.mockResolvedValue([
                makeView({
                    sessionId,
                    mediaId,
                    hasFiles: true,
                    username: 'alice',
                    mediaType: 'movie',
                    positionMs: 120_000,
                    runtimeMs: 7_200_000,
                }),
            ]);

            const result = await MediaAggregationService.getActiveSessions(['alice']);

            expect(result.sessions).toHaveLength(1);
            expect(result.totalSessions).toBe(1);

            const session = result.sessions[0];
            // Title must come from the seeded media_items row (DB enrichment),
            // NOT fall back to the raw mediaId.
            expect(session.title).toBe('Cloud Runner 2049');
            expect(session.clientname).toBe('Apple');
            expect(session.clientVersion).toBe('1.0.1 (2610140823)');
            expect(session.userAgent).toBe('Apple test agent');
            expect(session.title).not.toBe(mediaId);
            expect(session.id).toBe(mediaId);
            expect(session.username).toBe('alice');
            // year is enriched from media_items.
            expect(session.year).toBe(2017);
            // runtime_seconds (7200) from media_items takes precedence as duration.
            expect(session.duration).toBe(7200);
            // position 120000ms → 120s.
            expect(session.playCurrentTime).toBe(120);
            expect(session.playIsPlaying).toBe(true);
            // Lumastra-source session maps to sessionSource 'lumastra'.
            expect(session.sessionSource).toBe('lumastra');
        });

        it('drops a read-model view whose session row was reaped from the DB (no enrichment)', async () => {
            // The read model surfaces a view, but there is NO matching
            // play_sessions row (e.g. reaped between the Valkey read and the DB
            // read). The enriched map has no entry, so title falls back to the
            // raw mediaId — proving enrichment is keyed on real DB rows, not the
            // view alone.
            const ghostSessionId = crypto.randomUUID();
            const ghostMediaId = crypto.randomUUID();

            mockGetAllActive.mockResolvedValue([
                makeView({
                    sessionId: ghostSessionId,
                    mediaId: ghostMediaId,
                    username: 'carol',
                    mediaType: 'movie',
                    positionMs: 0,
                    runtimeMs: null,
                }),
            ]);

            const result = await MediaAggregationService.getActiveSessions(['carol']);

            // The view is still emitted (getActiveSessions maps every view),
            // but with no DB enrichment its title falls back to the mediaId.
            expect(result.sessions).toHaveLength(1);
            expect(result.sessions[0].title).toBe(ghostMediaId);
            expect(result.sessions[0].year).toBeUndefined();
        });

        /**
         * Attach a probed file to a seeded session's media item: one audio
         * stream (optionally with no bitrate of its own, as FLAC and most
         * Matroska audio report) plus a whole-file bitrate.
         */
        async function attachProbedFile(
            mediaId: string,
            opts: {
                container: string;
                totalBitrate: number;
                codec: string;
                streamBitrate: number | null;
                sampleRate?: number;
            },
        ): Promise<void> {
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, container_format, total_bitrate)
                VALUES (${fileId}::uuid, ${`/data/${fileId}`},
                        ${opts.container}, ${opts.totalBitrate})
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${fileId}::uuid, ${mediaId}::uuid, true)
            `;
            await sql`
                INSERT INTO media_streams (
                    file_id, stream_type, stream_index, codec, bitrate, sample_rate, is_default
                ) VALUES (
                    ${fileId}::uuid, 'audio', 0, ${opts.codec}, ${opts.streamBitrate},
                    ${opts.sampleRate ?? null}, true
                )
            `;
        }

        it('never quotes a video file total as the audio bitrate', async () => {
            // ~12k library episodes have a default audio stream carrying no
            // bitrate of its own. Falling back to the file total there would
            // render the card's audio line as "EAC3 (8.0 Mbps)" — the video
            // bitrate, wearing an audio label.
            const { sessionId, mediaId } = await seedActiveMovieSession(sql, {
                title: 'Loud Movie',
                username: 'dave',
            });
            await attachProbedFile(mediaId, {
                container: 'matroska',
                totalBitrate: 8_000_000,
                codec: 'eac3',
                streamBitrate: null,
            });

            mockGetAllActive.mockResolvedValue([
                makeView({ sessionId, mediaId, username: 'dave', mediaType: 'movie' }),
            ]);

            const [session] = (await MediaAggregationService.getActiveSessions(['dave'])).sessions;
            expect(session.playOriginalAudioCodec).toBe('eac3');
            expect(session.playOriginalAudioBitrate).toBeUndefined();
        });

        it('uses the file total as the audio bitrate for audio-only media', async () => {
            // For a FLAC track the file total IS the audio bitrate, and is the
            // only figure available — lossless streams report none.
            const { sessionId, mediaId } = await seedActiveMovieSession(sql, {
                title: 'Lossless Track',
                username: 'erin',
            });
            await sql`UPDATE media_items SET media_type = 'track' WHERE id = ${mediaId}::uuid`;
            await attachProbedFile(mediaId, {
                container: 'flac',
                totalBitrate: 1_128_606,
                codec: 'flac',
                streamBitrate: null,
                sampleRate: 96_000,
            });

            mockGetAllActive.mockResolvedValue([
                makeView({ sessionId, mediaId, username: 'erin', mediaType: 'track' }),
            ]);

            const [session] = (await MediaAggregationService.getActiveSessions(['erin'])).sessions;
            expect(session.playOriginalAudioCodec).toBe('flac');
            expect(session.playOriginalAudioBitrate).toBe(1_128_606);
            expect(session.playAudioSampleRate).toBe(96_000);
        });

        it('treats the "unknown" codec sentinel as no codec at all', async () => {
            // media_streams.codec is NOT NULL DEFAULT 'unknown'; surfacing that
            // verbatim would render an "UNKNOWN" badge.
            const { sessionId, mediaId } = await seedActiveMovieSession(sql, {
                title: 'Unidentified Track',
                username: 'frank',
            });
            await sql`UPDATE media_items SET media_type = 'track' WHERE id = ${mediaId}::uuid`;
            await attachProbedFile(mediaId, {
                container: 'mp3',
                totalBitrate: 320_000,
                codec: 'unknown',
                streamBitrate: null,
            });

            mockGetAllActive.mockResolvedValue([
                makeView({ sessionId, mediaId, username: 'frank', mediaType: 'track' }),
            ]);

            const [session] = (await MediaAggregationService.getActiveSessions(['frank'])).sessions;
            expect(session.playOriginalAudioCodec).toBeUndefined();
        });

        it('names the track artist, not the compilation marker, on a VA album', async () => {
            // The album-artist row on a compilation is the "Various Artists"
            // marker, so the bare grandparent join made every session card on
            // a VA album read "Various Artists" while the track's own ARTIST
            // tag named the real performer. Name AND id move together: a card
            // reading "The Degrees" must not link to the marker's page.
            const { sessionId, mediaId } = await seedActiveMovieSession(sql, {
                title: 'Apologize (Ti-Mo vs. Stefan Rio Radio Edit)',
                username: 'grace',
            });
            const vaArtistId = crypto.randomUUID();
            const performerId = crypto.randomUUID();
            const albumId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, is_various_artists)
                VALUES (${vaArtistId}::uuid, 'Various Artists', 'artist', 'active', true),
                       (${performerId}::uuid, 'The Degrees', 'artist', 'active', false)
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id)
                VALUES (${albumId}::uuid, 'Hands Up Essentials, Vol. 1', 'album', 'active', ${vaArtistId}::uuid)
            `;
            await sql`
                UPDATE media_items
                   SET media_type = 'track',
                       parent_id = ${albumId}::uuid,
                       custom_metadata = ${sql.json({
                           artist: 'The Degrees',
                           album_artist: 'VA',
                           additional_artist_ids: [performerId],
                       })}
                 WHERE id = ${mediaId}::uuid
            `;

            mockGetAllActive.mockResolvedValue([
                makeView({ sessionId, mediaId, username: 'grace', mediaType: 'track' }),
            ]);

            const [session] = (await MediaAggregationService.getActiveSessions(['grace'])).sessions;
            expect(session.artistName).toBe('The Degrees');
            expect(session.artistId).toBe(performerId);
            expect(session.albumName).toBe('Hands Up Essentials, Vol. 1');
        });

        it('leaves artistName unset for a non-track item carrying an artist tag', async () => {
            // The resolver is gated on media_type: an audiobook or movie row
            // that ever grows an 'artist' tag must not start reporting one
            // here, because the session card prefers artistName over author.
            const { sessionId, mediaId } = await seedActiveMovieSession(sql, {
                title: 'Tagged Movie',
                username: 'heidi',
            });
            await sql`
                UPDATE media_items
                   SET custom_metadata = ${sql.json({ artist: 'Somebody' })}
                 WHERE id = ${mediaId}::uuid
            `;

            mockGetAllActive.mockResolvedValue([
                makeView({ sessionId, mediaId, username: 'heidi', mediaType: 'movie' }),
            ]);

            const [session] = (await MediaAggregationService.getActiveSessions(['heidi'])).sessions;
            expect(session.artistName).toBeUndefined();
            expect(session.artistId).toBeUndefined();
        });

        it('sets a cacheTimestamp close to now', async () => {
            mockGetAllActive.mockResolvedValue([]);
            const before = Date.now();
            const result = await MediaAggregationService.getActiveSessions([]);
            const after = Date.now();

            expect(result.cacheTimestamp).toBeGreaterThanOrEqual(before);
            expect(result.cacheTimestamp).toBeLessThanOrEqual(after + 50);
        });
    });
});
