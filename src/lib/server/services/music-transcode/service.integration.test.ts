// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/services/music-transcode/service.integration.test.ts
//
// Integration tests for MusicTranscodeService against a real PostgreSQL
// database. These verify that recordJob / finalizeJob write rows correctly
// to active_transcode_jobs and that the lifecycle transitions (running ->
// stopped, ready -> stopped, error on abort) all reach the DB.
//
// Run locally:
//   npm run test:integration src/lib/server/services/music-transcode/service.integration.test.ts
//
// Run against preprod:
//   npm run test:integration -- src/lib/server/services/music-transcode/service.integration.test.ts

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';

import {
    connectValkey,
    disconnectValkey,
    getCoordinationClient,
} from '$lib/server/cache/valkey.js';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/user.fixtures.js';

import { createMusicTranscodeCache, type MusicTranscodeCache } from './cache.js';
import { computeCacheKey } from './cache-key.js';
import { expectedMp3Size } from './progressive.js';
import {
    MusicTranscodeService,
    _resetServiceForTests,
    clearDurationMismatchesForTests,
} from './service.js';
import type { TranscodeStreamRequest } from './types.js';

const CONCURRENT_KEY = 'music-transcode:concurrent';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

// play_sessions.user_id is uuid REFERENCES users(id) since mig 16.46.0.
// TEST_USER is the stable UUID for this test suite's user; the users row is
// created by ensureTestUser in beforeEach.
const TEST_USER = generateTestUserId('music_transcode_test_user');
const TEST_DEVICE = 'music-transcode-test-device';
const TEST_TRACK_ID = '00000000-0000-4000-a000-00000000a001';

const __dirname_local = dirname(fileURLToPath(import.meta.url));
const FLAC_FIXTURE = resolve(__dirname_local, '../../../../../tests/fixtures/music/sample.flac');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Drain a Web ReadableStream to a Buffer, with a hard timeout so a hung
 * stream fails the test instead of hanging vitest.
 */
async function readToEnd(body: ReadableStream<Uint8Array>, timeoutMs = 30_000): Promise<Buffer> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    const timer = setTimeout(() => {
        void reader.cancel('test timeout');
    }, timeoutMs);
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
        }
    } finally {
        clearTimeout(timer);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/**
 * Poll active_transcode_jobs until predicate(row) is true or timeout.
 * Returns the final row (or null when no row exists yet).
 */
async function waitForJobRow(
    sql: postgres.Sql,
    sessionId: string,
    predicate: (row: { status: string; stopped_at: Date | null } | null) => boolean,
    timeoutMs = 5_000,
): Promise<{
    status: string;
    stopped_at: Date | null;
    ffmpeg_pid: number | null;
    error_message: string | null;
    config: Record<string, unknown>;
    job_id: string;
} | null> {
    const start = Date.now();
    let lastRow: {
        status: string;
        stopped_at: Date | null;
        ffmpeg_pid: number | null;
        error_message: string | null;
        config: Record<string, unknown>;
        job_id: string;
    } | null = null;
    while (Date.now() - start < timeoutMs) {
        const rows = await sql<
            {
                status: string;
                stopped_at: Date | null;
                ffmpeg_pid: number | null;
                error_message: string | null;
                config: Record<string, unknown>;
                job_id: string;
            }[]
        >`
            SELECT status, stopped_at, ffmpeg_pid, error_message, config, job_id
            FROM active_transcode_jobs
            WHERE play_session_id = ${sessionId}
        `;
        lastRow = rows[0] ?? null;
        if (predicate(lastRow)) return lastRow;
        await new Promise((r) => setTimeout(r, 50));
    }
    return lastRow;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('MusicTranscodeService integration', () => {
    let sql: postgres.Sql;
    let cacheDir: string;
    let cache: MusicTranscodeCache;
    let service: MusicTranscodeService;

    beforeAll(async () => {
        sql = getTestDb();
        await sql`SELECT 1`;

        // FLAC fixture is required for any encode path.
        if (!existsSync(FLAC_FIXTURE)) {
            throw new Error(
                `Required FLAC fixture missing: ${FLAC_FIXTURE}. ` +
                    `Run Task 0.1 (Add 10s FLAC test fixture) first.`,
            );
        }
    });

    afterAll(async () => {
        await closeTestDb();
        // Tear down any Valkey connection opened by the concurrency-cap
        // test. Safe no-op if nothing was connected.
        await disconnectValkey();
        _resetServiceForTests();
        if (cacheDir) {
            rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    afterEach(async () => {
        // An encode whose readers left keeps running for the reader grace
        // period; it must not finish into the next test's tables or slots.
        await service?._drainProgressiveForTests();
    });

    beforeEach(async () => {
        clearDurationMismatchesForTests();
        // Each test gets a fresh on-disk cache so we can exercise cache miss
        // -> cache hit transitions without cross-test contamination.
        cacheDir = mkdtempSync(join(tmpdir(), 'music-transcode-int-'));

        // Truncate active_transcode_jobs first (dependent on play_sessions FK)
        // then play_sessions. We do not use truncateTables() because that
        // helper doesn't include these tables.
        await sql`TRUNCATE TABLE active_transcode_jobs RESTART IDENTITY CASCADE`;
        await sql`TRUNCATE TABLE play_sessions RESTART IDENTITY CASCADE`;
        await sql`DELETE FROM media_items WHERE id = ${TEST_TRACK_ID}::uuid`;

        // Seed media_items (FK target for play_sessions.media_id) and user.
        await ensureTestUser(sql, TEST_USER);
        await sql`
            INSERT INTO media_items (id, title, media_type, status)
            VALUES (
                ${TEST_TRACK_ID}::uuid,
                'Integration Test Track',
                'track',
                'active'
            )
            ON CONFLICT (id) DO NOTHING
        `;

        // Fresh service with an isolated cache.
        _resetServiceForTests();
        cache = createMusicTranscodeCache({ cacheDir });
        service = new MusicTranscodeService({
            sql,
            cache,
        });
    });

    // -----------------------------------------------------------------------
    // Helper: seed a play_sessions row and return its id (used as session id).
    // -----------------------------------------------------------------------

    async function seedPlaySession(): Promise<string> {
        const rows = await sql<{ id: string }[]>`
            INSERT INTO play_sessions (
                media_id, user_id, device_id,
                ip_address, play_method, position_ms
            ) VALUES (
                ${TEST_TRACK_ID}::uuid,
                ${TEST_USER},
                ${TEST_DEVICE},
                '127.0.0.1'::inet,
                'audio_transcode',
                0
            )
            RETURNING id
        `;
        return rows[0].id;
    }

    function makeReq(
        sessionId: string,
        overrides: Partial<TranscodeStreamRequest> = {},
    ): TranscodeStreamRequest {
        const st = statSync(FLAC_FIXTURE);
        return {
            trackUuid: TEST_TRACK_ID,
            sourcePath: FLAC_FIXTURE,
            sourceMtimeMs: st.mtimeMs,
            codec: 'mp3',
            bitrateKbps: 128,
            timeOffset: 0,
            session: {
                sessionId,
                userId: TEST_USER,
                deviceId: TEST_DEVICE,
                source: 'subsonic',
            },
            ...overrides,
        };
    }

    async function waitForCached(
        req: TranscodeStreamRequest,
        targetCache: MusicTranscodeCache = cache,
    ): Promise<void> {
        // Body EOF and the job's stopped row precede the independent disk
        // fork's flush/rename. Await cache publication before testing a hit.
        await targetCache.waitForKey(
            computeCacheKey({
                trackUuid: req.trackUuid,
                mtimeMs: req.sourceMtimeMs,
                codec: req.codec,
                bitrateKbps: req.bitrateKbps,
            }),
            req.codec,
        );
    }

    // -----------------------------------------------------------------------
    // 1. First encode: writes a 'running' row, body flows, transitions to 'stopped'
    // -----------------------------------------------------------------------

    it('encode path writes status=running then transitions to stopped on success', async () => {
        const sessionId = await seedPlaySession();
        const req = makeReq(sessionId);

        const result = await service.streamFor(req);

        // The row must exist immediately after streamFor returns (recordJob
        // is awaited before the function returns). Status is 'running' because
        // ffmpeg.pid is set.
        const initial = await sql<{ status: string; ffmpeg_pid: number | null; job_id: string }[]>`
            SELECT status, ffmpeg_pid, job_id
            FROM active_transcode_jobs
            WHERE play_session_id = ${sessionId}
        `;
        expect(initial).toHaveLength(1);
        expect(initial[0].status).toBe('running');
        expect(initial[0].ffmpeg_pid).toBeGreaterThan(0);

        // Drain the body — ffmpeg must finish writing before exit.
        const bytes = await readToEnd(result.body);
        expect(bytes.length).toBeGreaterThan(0);

        // After ffmpeg exits with code 0, finalizeJob must flip status.
        const final = await waitForJobRow(sql, sessionId, (r) => r?.status === 'stopped');
        expect(final).not.toBeNull();
        expect(final!.status).toBe('stopped');
        expect(final!.stopped_at).not.toBeNull();
        expect(final!.error_message).toBeNull();
    }, 60_000);

    // -----------------------------------------------------------------------
    // 2. Cache-hit (same key): status='ready' (no pid), then stopped on drain
    // -----------------------------------------------------------------------

    it('cache hit writes status=ready (no pid) then stopped on drain', async () => {
        // First request: populates the cache. Use one session id.
        const session1 = await seedPlaySession();
        const req1 = makeReq(session1);
        const first = await service.streamFor(req1);
        await readToEnd(first.body);
        await waitForCached(req1);
        await waitForJobRow(sql, session1, (r) => r?.status === 'stopped');

        // Verify cache file exists.
        const key = computeCacheKey({
            trackUuid: req1.trackUuid,
            mtimeMs: req1.sourceMtimeMs,
            codec: req1.codec,
            bitrateKbps: req1.bitrateKbps,
        });
        const cacheFile = join(cacheDir, key.slice(0, 2), `${key}.mp3`);
        expect(existsSync(cacheFile)).toBe(true);

        // Second request: identical params, fresh session — must take the
        // cached path.
        const session2 = await seedPlaySession();
        const req2 = makeReq(session2);
        const second = await service.streamFor(req2);
        expect(second.cacheState).toBe('cached');

        const initial = await sql<{ status: string; ffmpeg_pid: number | null }[]>`
            SELECT status, ffmpeg_pid
            FROM active_transcode_jobs
            WHERE play_session_id = ${session2}
        `;
        expect(initial[0].status).toBe('ready');
        expect(initial[0].ffmpeg_pid).toBeNull();

        // Drain — node.once('end') fires finalizeJob(ok=true).
        await readToEnd(second.body);
        const final = await waitForJobRow(sql, session2, (r) => r?.status === 'stopped');
        expect(final!.status).toBe('stopped');
        expect(final!.stopped_at).not.toBeNull();
        expect(final!.error_message).toBeNull();
    }, 60_000);

    // -----------------------------------------------------------------------
    // 2b. Range: a live encode can only answer `bytes=N-` from byte 0, which
    //     AVPlayer splices into the middle of the track (the song "restarts"
    //     while the clock keeps counting). Ranged requests are cut from a
    //     finished file instead.
    // -----------------------------------------------------------------------

    function cacheFileFor(req: TranscodeStreamRequest): string {
        const key = computeCacheKey({
            trackUuid: req.trackUuid,
            mtimeMs: req.sourceMtimeMs,
            expectedSize:
                req.codec === 'mp3'
                    ? expectedMp3Size(
                          req.durationSeconds,
                          req.bitrateKbps,
                          req.sourceSize,
                          req.sourceBitrate,
                      )
                    : null,
            codec: req.codec,
            bitrateKbps: req.bitrateKbps,
        });
        return join(cacheDir, key.slice(0, 2), `${key}.${req.codec}`);
    }

    it('serves a cold MP3 probe and open range before encoding finishes, sharing one slot', async () => {
        const source = join(cacheDir, 'Silver Meadow.flac');
        execFileSync(config.FFMPEG_PATH, [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=440:sample_rate=44100:duration=600',
            '-c:a',
            'flac',
            source,
        ]);
        const sessionId = await seedPlaySession();
        const req = makeReq(sessionId, {
            sourcePath: source,
            sourceMtimeMs: statSync(source).mtimeMs,
            durationSeconds: 600,
            rangeHeader: 'bytes=0-1',
        });
        const total = expectedMp3Size(600, req.bitrateKbps)!;
        const cap = vi.spyOn(config, 'MUSIC_TRANSCODE_MAX_CONCURRENT', 'get').mockReturnValue(1);
        const userCap = vi.spyOn(config, 'MUSIC_TRANSCODE_MAX_PER_USER', 'get').mockReturnValue(1);
        const noWait = vi.spyOn(config, 'MUSIC_TRANSCODE_QUEUE_WAIT_MS', 'get').mockReturnValue(0);
        try {
            const probe = await service.streamFor(req);
            expect(probe.status).toBe(206);
            expect(probe.contentRange).toBe(`bytes 0-1/${total}`);
            expect(probe.contentLength).toBe(2);
            const probeBytes = await readToEnd(probe.body);
            expect(probeBytes).toHaveLength(2);
            // A real 10-minute encode is still running after its first two
            // output bytes. This fails for the former encode-then-serve path.
            const running = await waitForJobRow(sql, sessionId, (row) => row?.status === 'running');
            expect(running?.status).toBe('running');
            expect(running?.ffmpeg_pid).toBeGreaterThan(0);
            expect(existsSync(cacheFileFor(req))).toBe(false);

            const full = await service.streamFor({ ...req, rangeHeader: 'bytes=0-' });
            expect(full.cacheState).toBe('dedup');
            expect(full.contentRange).toBe(`bytes 0-${total - 1}/${total}`);
            const sameJob = await sql<{ ffmpeg_pid: number }[]>`
                SELECT ffmpeg_pid FROM active_transcode_jobs WHERE play_session_id = ${sessionId}`;
            expect(sameJob[0].ffmpeg_pid).toBe(running?.ffmpeg_pid);
            const body = await readToEnd(full.body, 60_000);
            expect(body).toHaveLength(total);
            expect(body.subarray(0, 2)).toEqual(probeBytes);
            expect(statSync(cacheFileFor(req)).size).toBe(total);
            expect(body.equals(readFileSync(cacheFileFor(req)))).toBe(true);
            const cached = await service.streamFor({ ...req, rangeHeader: 'bytes=0-' });
            expect(cached.cacheState).toBe('cached');
            expect(cached.contentRange).toBe(full.contentRange);
            expect(await readToEnd(cached.body)).toEqual(body);
        } finally {
            service.cancel(sessionId);
            cap.mockRestore();
            userCap.mockRestore();
            noWait.mockRestore();
        }
    }, 90_000);

    it('keeps a shared progressive encoder alive when its initial reader aborts', async () => {
        const source = join(cacheDir, 'Amber Valley.flac');
        execFileSync(config.FFMPEG_PATH, [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=330:sample_rate=44100:duration=600',
            '-c:a',
            'flac',
            source,
        ]);
        const sessionId = await seedPlaySession();
        const initial = new AbortController();
        const req = makeReq(sessionId, {
            sourcePath: source,
            sourceMtimeMs: statSync(source).mtimeMs,
            durationSeconds: 600,
            rangeHeader: 'bytes=0-',
        });
        const first = await service.streamFor({ ...req, abortSignal: initial.signal });
        initial.abort();
        await expect(readToEnd(first.body)).rejects.toThrow('aborted');
        // Reopen only AFTER the old reader has detached: AVPlayer leaves a gap.
        const follower = await service.streamFor({ ...req, rangeHeader: 'bytes=1000-' });
        expect(follower.cacheState).toBe('dedup');
        expect(await readToEnd(follower.body, 60_000)).toHaveLength(
            expectedMp3Size(600, 128)! - 1000,
        );
        expect(statSync(cacheFileFor(req)).size).toBe(expectedMp3Size(600, 128));
    }, 90_000);

    it('normalizes a non-ranged encode before serving the same length to ranged cache readers', async () => {
        const sessionId = await seedPlaySession();
        // The generated fixture lasts 10s. Advertising 11s exercises padding
        // rather than the normal encoder-delay/frame-rounding truncation.
        const req = makeReq(sessionId, { durationSeconds: 11 });
        const response = await service.streamFor(req);
        const body = await readToEnd(response.body);
        expect(body).toHaveLength(expectedMp3Size(11, 128)!);
        expect(body.subarray(-16)).toEqual(Buffer.alloc(16));
        await waitForCached(req);
        expect(readFileSync(cacheFileFor(req))).toEqual(body);
        const cached = await service.streamFor({ ...req, rangeHeader: 'bytes=-16' });
        expect(cached.contentRange).toBe(
            `bytes ${body.length - 16}-${body.length - 1}/${body.length}`,
        );
        expect(await readToEnd(cached.body)).toEqual(body.subarray(-16));
    });

    it.each(['bytes=0-1', 'bytes=0-'])(
        'lets a short encode finish within grace after %s leaves',
        async (rangeHeader) => {
            const sessionId = await seedPlaySession();
            const req = makeReq(sessionId, { durationSeconds: 10, rangeHeader });
            const response = await service.streamFor(req);
            if (rangeHeader === 'bytes=0-1') expect(await readToEnd(response.body)).toHaveLength(2);
            else await response.body.cancel('reader left');
            const row = await waitForJobRow(sql, sessionId, (job) => job?.status === 'stopped');
            expect(row?.status).toBe('stopped');
            expect(statSync(cacheFileFor(req)).size).toBe(expectedMp3Size(10, 128));
        },
    );

    it.each([30_000, 10_000])(
        'falls back to finished-file ranges for implausible duration %s',
        async (durationSeconds) => {
            const sessionId = await seedPlaySession();
            const req = makeReq(sessionId, {
                durationSeconds,
                sourceSize: statSync(FLAC_FIXTURE).size,
                rangeHeader: 'bytes=0-1',
            });
            const response = await service.streamFor(req);
            expect(await readToEnd(response.body)).toHaveLength(2);
            const actual = statSync(cacheFileFor(req)).size;
            expect(response.contentRange).toBe(`bytes 0-1/${actual}`);
            expect(response.cacheState).toBe('live');
        },
    );

    it('keeps the promised length for a wrong duration, but never caches it', async () => {
        const sessionId = await seedPlaySession();
        const req = makeReq(sessionId, { durationSeconds: 14, rangeHeader: 'bytes=0-' });
        const warn = vi.spyOn(Logger.for('MusicTranscodeService'), 'warn');
        try {
            const response = await service.streamFor(req);
            expect(await readToEnd(response.body)).toHaveLength(expectedMp3Size(14, 128)!);
            expect(warn).toHaveBeenCalledWith(
                'Music MP3 duration estimate differs from encoded output',
                expect.objectContaining({ expectedSize: expectedMp3Size(14, 128) }),
            );
            await waitForJobRow(sql, sessionId, (job) => job?.status === 'stopped');
            // The next request for this source no longer trusts the duration
            // and gets the real length instead of the mis-sized cache entry.
            const again = await service.streamFor({ ...req, rangeHeader: 'bytes=0-1' });
            expect(await readToEnd(again.body)).toHaveLength(2);
            expect(again.contentRange).not.toBe(`bytes 0-1/${expectedMp3Size(14, 128)}`);
        } finally {
            warn.mockRestore();
        }
    });

    it('propagates a failed progressive encode and removes its partial', async () => {
        const sessionId = await seedPlaySession();
        const req = makeReq(sessionId, { durationSeconds: 10, rangeHeader: 'bytes=0-' });
        const args = vi
            .spyOn(
                service as unknown as {
                    buildEncodeArgs: () => Promise<string[]>;
                },
                'buildEncodeArgs',
            )
            .mockResolvedValue(['-invalid-silver-meadow-option']);
        try {
            const response = await service.streamFor(req);
            await expect(readToEnd(response.body)).rejects.toThrow('encode to file failed');
            expect(existsSync(cacheFileFor(req))).toBe(false);
            expect(existsSync(`${cacheFileFor(req)}.partial`)).toBe(false);
            const row = await waitForJobRow(sql, sessionId, (job) => job?.status === 'error');
            expect(row?.status).toBe('error');
        } finally {
            args.mockRestore();
        }
    });

    it('ranged request on a cache miss is 206 from the finished encode, never byte 0', async () => {
        const sessionId = await seedPlaySession();
        const req = makeReq(sessionId, { rangeHeader: 'bytes=1000-' });

        const result = await service.streamFor(req);
        const body = await readToEnd(result.body);

        const file = readFileSync(cacheFileFor(req));
        expect(result.status).toBe(206);
        expect(result.acceptRanges).toBe('bytes');
        expect(result.contentRange).toBe(`bytes 1000-${file.length - 1}/${file.length}`);
        expect(result.contentLength).toBe(file.length - 1000);
        expect(body.equals(file.subarray(1000))).toBe(true);

        // The cached bytes must match what a live encode streams, or a
        // client that started on the live stream and reconnects with a
        // range lands on shifted offsets (an mp3 muxer writing to a file
        // instead of a pipe adds a Xing frame).
        const liveDir = mkdtempSync(join(tmpdir(), 'music-transcode-live-'));
        try {
            const liveCache = createMusicTranscodeCache({ cacheDir: liveDir });
            const liveService = new MusicTranscodeService({
                sql,
                cache: liveCache,
            });
            const liveReq = makeReq(await seedPlaySession());
            const live = await liveService.streamFor(liveReq);
            expect(live.cacheState).toBe('live');
            const liveBytes = await readToEnd(live.body);
            await waitForCached(liveReq, liveCache);
            expect(liveBytes.equals(file)).toBe(true);
        } finally {
            rmSync(liveDir, { recursive: true, force: true });
        }
    }, 60_000);

    it('ranged request on a cache hit is sliced', async () => {
        // A live body can finish before the cache writer flushes and renames.
        // Seed with encode-to-file so the following filesystem read sees a final entry.
        const first = await service.streamFor(
            makeReq(await seedPlaySession(), { rangeHeader: 'bytes=0-' }),
        );
        await readToEnd(first.body);
        const req = makeReq(await seedPlaySession(), { rangeHeader: 'bytes=0-1' });
        const file = readFileSync(cacheFileFor(req));

        const result = await service.streamFor(req);
        const body = await readToEnd(result.body);

        expect(result.cacheState).toBe('cached');
        expect(result.status).toBe(206);
        expect(result.contentRange).toBe(`bytes 0-1/${file.length}`);
        expect(body.equals(file.subarray(0, 2))).toBe(true);
    }, 60_000);

    it('unsatisfiable range rejects with status 416 and the file size', async () => {
        // Force the slow-disk ordering seen in CI: the entire live body can
        // arrive while the final cache file is still unpublished.
        let releasePromotion!: () => void;
        const promotion = new Promise<void>((resolve) => {
            releasePromotion = resolve;
        });
        const beginWrite = cache.beginWrite;
        const writerSpy = vi.spyOn(cache, 'beginWrite').mockImplementation(async (...args) => {
            const writer = await beginWrite(...args);
            return {
                ...writer,
                promote: async () => {
                    await promotion;
                    await writer.promote();
                },
            };
        });
        try {
            const prime = makeReq(await seedPlaySession());
            const req = makeReq(await seedPlaySession(), { rangeHeader: 'bytes=999999999-' });
            const first = await service.streamFor(prime);
            await readToEnd(first.body);
            expect(existsSync(cacheFileFor(prime))).toBe(false);
            releasePromotion();
            await waitForCached(prime);
            const size = statSync(cacheFileFor(req)).size;

            await expect(service.streamFor(req)).rejects.toMatchObject({ status: 416, size });
        } finally {
            releasePromotion();
            writerSpy.mockRestore();
        }
    }, 60_000);

    it('416 after a fresh encode still closes the job row', async () => {
        const sessionId = await seedPlaySession();
        const req = makeReq(sessionId, { rangeHeader: 'bytes=999999999-' });

        await expect(service.streamFor(req)).rejects.toMatchObject({ status: 416 });

        const row = await waitForJobRow(sql, sessionId, (r) => r?.status === 'error');
        expect(row?.status).toBe('error');
        expect(row?.error_message).toBe('range not satisfiable');
    }, 60_000);

    it('ranged request with a timeOffset is cut from a finished seek, not streamed live', async () => {
        const prime = makeReq(await seedPlaySession());
        const first = await service.streamFor(prime);
        await readToEnd(first.body);
        await waitForCached(prime);

        // The seek's scratch file lives under the configured cache dir.
        const dirSpy = vi
            .spyOn(config, 'MUSIC_TRANSCODE_CACHE_DIR', 'get')
            .mockReturnValue(cacheDir);
        let result;
        let body: Buffer;
        try {
            result = await service.streamFor(
                makeReq(await seedPlaySession(), { timeOffset: 2, rangeHeader: 'bytes=100-' }),
            );
            body = await readToEnd(result.body);
        } finally {
            dirSpy.mockRestore();
        }

        expect(result.cacheState).toBe('seek');
        expect(result.status).toBe(206);
        expect(result.contentLength).toBe(body.length);
        expect(result.contentRange).toMatch(/^bytes 100-\d+\/\d+$/);
    }, 60_000);

    it('a caller that does not handle ranges is never told it can (Subsonic)', async () => {
        const prime = makeReq(await seedPlaySession());
        const first = await service.streamFor(prime);
        await readToEnd(first.body);
        await waitForCached(prime);

        const result = await service.streamFor(makeReq(await seedPlaySession()));
        await readToEnd(result.body);

        expect(result.cacheState).toBe('cached');
        expect(result.status).toBe(200);
        expect(result.acceptRanges).toBe('none');
        expect(result.contentRange).toBeUndefined();
    }, 60_000);

    // -----------------------------------------------------------------------
    // 3. Source mtime changes → different cache key (token fingerprint)
    // -----------------------------------------------------------------------

    it('different mtime produces a different cache key', () => {
        const baseReq = makeReq('ignore');
        const key1 = computeCacheKey({
            trackUuid: baseReq.trackUuid,
            mtimeMs: baseReq.sourceMtimeMs,
            codec: baseReq.codec,
            bitrateKbps: baseReq.bitrateKbps,
        });
        const key2 = computeCacheKey({
            trackUuid: baseReq.trackUuid,
            mtimeMs: baseReq.sourceMtimeMs + 1, // any change
            codec: baseReq.codec,
            bitrateKbps: baseReq.bitrateKbps,
        });
        expect(key1).not.toBe(key2);
    });

    // -----------------------------------------------------------------------
    // 4. Cancel during encode: abort propagates, job transitions to 'error'
    // -----------------------------------------------------------------------

    it('cancel() during encode terminates the stream and marks job error', async () => {
        // A source long enough that the encode is still running when cancel()
        // lands. The 10 s fixture encodes in ~65 ms; on a fast CI runner
        // ffmpeg finished before the SIGTERM, exited 0, and the job was
        // (correctly) recorded 'stopped' — the race, not the code, failed.
        // Ten minutes of FLAC takes seconds to encode.
        const longSource = join(cacheDir, 'long-source.flac');
        execFileSync('ffmpeg', [
            '-v',
            'error',
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=440:sample_rate=44100:duration=600',
            '-c:a',
            'flac',
            longSource,
        ]);
        const sessionId = await seedPlaySession();
        const req = makeReq(sessionId, {
            sourcePath: longSource,
            sourceMtimeMs: statSync(longSource).mtimeMs,
        });

        const result = await service.streamFor(req);

        // Cancel once the first encoded bytes arrive, so the encode is
        // provably running (not still starting up). The 600 s source cannot
        // finish: the body is unread beyond this chunk, so ffmpeg is held on a
        // full pipe. A cancel at start-up is covered deterministically in
        // service.shutdown.test.ts (ffmpeg may exit 0 there).
        const reader = result.body.getReader();
        const timer = setTimeout(() => void reader.cancel('test timeout'), 20_000);
        try {
            const first = await reader.read();
            expect(first.done).toBe(false);
            service.cancel(sessionId);

            // The body should terminate. We don't strictly care about the byte
            // count — just that it doesn't hang.
            for (;;) {
                const { done } = await reader.read();
                if (done) break;
            }
        } finally {
            clearTimeout(timer);
        }

        const final = await waitForJobRow(
            sql,
            sessionId,
            (r) => r?.status === 'stopped' || r?.status === 'error',
        );
        expect(final).not.toBeNull();
        // SIGTERM-killed ffmpeg yields a non-zero exit code -> 'error'.
        expect(final!.status).toBe('error');
        expect(final!.stopped_at).not.toBeNull();
        expect(final!.error_message).toBeTruthy();
    }, 60_000);

    // -----------------------------------------------------------------------
    // 5. Cancel during cached read: stream terminates and job goes to error
    //    (read aborted before clean 'end').
    // -----------------------------------------------------------------------

    it('cancel() during cached read marks job error (early termination)', async () => {
        // Prime the cache.
        const seed = await seedPlaySession();
        const seedReq = makeReq(seed);
        const seedResult = await service.streamFor(seedReq);
        await readToEnd(seedResult.body);
        await waitForCached(seedReq);
        await waitForJobRow(sql, seed, (r) => r?.status === 'stopped');

        // Second session — cache hit path.
        const sessionId = await seedPlaySession();
        const req = makeReq(sessionId);
        const result = await service.streamFor(req);
        expect(result.cacheState).toBe('cached');

        // Cancel before any reads — the read stream is destroyed and
        // emits 'error' (or 'close' without 'end') so finalizeJob fires
        // with ok=false.
        service.cancel(sessionId);

        // Drain whatever is left so we don't leak the stream.
        const reader = result.body.getReader();
        const timer = setTimeout(() => void reader.cancel('test timeout'), 5_000);
        try {
            for (;;) {
                const { done } = await reader.read();
                if (done) break;
            }
        } catch {
            // Reader can throw on abort — that's fine.
        } finally {
            clearTimeout(timer);
        }

        const final = await waitForJobRow(sql, sessionId, (r) => r?.stopped_at !== null);
        expect(final).not.toBeNull();
        // destroy() on the read stream fires the 'close' hook (no error arg)
        // which the service treats as an aborted stream → status='error'.
        expect(final!.status).toBe('error');
        expect(final!.stopped_at).not.toBeNull();
        expect(final!.error_message).toBeTruthy();
    }, 60_000);

    // -----------------------------------------------------------------------
    // 6. recordJob captures the music config payload shape
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // 7. Cluster-wide concurrency cap (Valkey) — over-cap requests throw 503
    // -----------------------------------------------------------------------

    it('throws status=503 error when over the cluster concurrency cap', async () => {
        // Try to connect to Valkey. If unavailable, the service falls back
        // to fail-open (per the watch list in Task 3.5), so the test cannot
        // verify the 503 path. Skip in that case rather than fail.
        const connected = await connectValkey();
        if (!connected) {
            console.warn(
                '[music-transcode test] Valkey unavailable — skipping concurrency cap test',
            );
            return;
        }

        const valkey = getCoordinationClient();
        if (!valkey) {
            console.warn('[music-transcode test] Valkey client null after connect — skipping');
            return;
        }

        // streamFor now WAITS up to MUSIC_TRANSCODE_QUEUE_WAIT_MS for a slot
        // before surfacing the 503. Disable that wait so this test still
        // asserts the over-cap branch itself rather than sitting out the
        // queue window; the waiting behaviour is covered by slot-wait.test.ts.
        const waitSpy = vi.spyOn(config, 'MUSIC_TRANSCODE_QUEUE_WAIT_MS', 'get').mockReturnValue(0);

        try {
            // Seed the counter at the cap so the very next acquire trips
            // the over-cap branch (INCR returns cap+1).
            const cap = config.MUSIC_TRANSCODE_MAX_CONCURRENT;
            await valkey.set(CONCURRENT_KEY, String(cap));

            const sessionId = await seedPlaySession();
            const req = makeReq(sessionId);

            await expect(service.streamFor(req)).rejects.toMatchObject({
                status: 503,
            });

            // After the throw, the service must have DECRed back so the
            // counter is restored to cap (so the next legitimate request
            // can still get in).
            const after = await valkey.get(CONCURRENT_KEY);
            const afterStr =
                typeof after === 'string'
                    ? after
                    : after instanceof Uint8Array
                      ? Buffer.from(after).toString('utf-8')
                      : null;
            expect(afterStr).toBe(String(cap));
        } finally {
            // Tidy up the counter so we don't leak state into other tests
            // or subsequent runs. Leave the connection open — afterAll
            // handles teardown.
            await valkey.del([CONCURRENT_KEY]).catch(() => {});
            waitSpy.mockRestore();
        }
    }, 30_000);

    it('recordJob serializes music config payload to JSONB', async () => {
        const sessionId = await seedPlaySession();
        const req = makeReq(sessionId, { codec: 'opus', bitrateKbps: 128 });

        const result = await service.streamFor(req);
        // We don't need the audio data — just ensure the row was written
        // and then drain to let ffmpeg finalize cleanly.
        const initial = await sql<{ config: Record<string, unknown>; job_id: string }[]>`
            SELECT config, job_id
            FROM active_transcode_jobs
            WHERE play_session_id = ${sessionId}
        `;
        expect(initial).toHaveLength(1);
        expect(initial[0].config).toMatchObject({
            type: 'music',
            target_codec: 'opus',
            target_bitrate: 128,
            source_path: FLAC_FIXTURE,
            time_offset: 0,
            transcode_mode: 'encode',
        });
        // Cache key (sha256 hex) is 64 chars; job_id is the cache key with
        // no seek suffix on startPositionSeconds==0.
        expect(initial[0].job_id).toMatch(/^[0-9a-f]{64}$/);

        // Drain to allow cleanup so afterAll doesn't trip on dangling pipes.
        await readToEnd(result.body);
    }, 60_000);

    // -----------------------------------------------------------------------
    // 8. play_sessions row stays ACTIVE after stream-bytes finish
    //
    // The unified scrobble+transcode row's lifecycle is owned by the
    // scrobble path (submission=true → COMPLETED) or the stale-session
    // reaper. finalizeJob only transitions the active_transcode_jobs row,
    // never the parent play_sessions row — otherwise the row would close
    // prematurely while the client is still playing the buffered audio.
    // -----------------------------------------------------------------------

    it('play_sessions row stays ACTIVE after stream bytes finish (scrobble owns close)', async () => {
        const sessionId = await seedPlaySession();

        // Confirm initial status is ACTIVE.
        const before = await sql<{ status: string }[]>`
            SELECT status FROM play_sessions WHERE id = ${sessionId}::uuid
        `;
        expect(before[0].status).toBe('ACTIVE');

        const req = makeReq(sessionId);
        const result = await service.streamFor(req);

        // Drain the stream — ffmpeg exits cleanly → finalizeJob(ok=true)
        // transitions active_transcode_jobs to 'stopped'. play_sessions
        // stays ACTIVE.
        await readToEnd(result.body);

        // Wait for the transcode job to reach stopped first.
        await waitForJobRow(sql, sessionId, (r) => r?.status === 'stopped');

        // Give any (incorrect) markStop call time to land if it were going
        // to. The row must remain ACTIVE.
        await new Promise((r) => setTimeout(r, 250));
        const after = await sql<{ status: string }[]>`
            SELECT status FROM play_sessions WHERE id = ${sessionId}::uuid
        `;
        expect(after[0].status).toBe('ACTIVE');
    }, 60_000);
});
