// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Seam test for `createMusicStreamHandlers().GET` — pins the wiring that
 * security review C4 depends on: the route passes the FULL, live
 * `locals.user` (as `handleStreamToken` now builds it — see
 * forward-auth.test.ts's stream-token age-cap coverage) into
 * `checkMediaAccess`, and a denial there becomes a 404 before any file I/O.
 *
 * Before the C4 fix, a stream-token UserContext always carried
 * `isAgeRestricted:false`/`userGroups:[]`, so `checkMediaAccess` could never
 * deny an over-age track for a stream_token caller regardless of the
 * account's real age cap — this route would have served the 18-rated track
 * to a 13-capped account. `checkMediaAccess` itself (the age/library
 * comparison logic) has its own dedicated coverage in media-access.test.ts;
 * this test only pins that route-handler.ts forwards `locals.user` unmodified
 * and honors a `false` verdict with 404 (never leaking a 403 that would
 * confirm the track exists).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { UserContext } from '$lib/server/types.js';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';

vi.mock('node:fs', async (importOriginal) => {
    const fs = await importOriginal<typeof import('node:fs')>();
    return { ...fs, createReadStream: vi.fn(fs.createReadStream) };
});

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
}));

const mockGetSql = vi.fn(async () => ({}) as unknown);
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: () => mockGetSql() },
}));

const mockGetTrackDetail = vi.fn();
vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getTrackStreamSource: (sql: unknown, trackId: string) => mockGetTrackDetail(sql, trackId),
}));

const mockCheckMediaAccess = vi.fn();
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (sql: unknown, trackId: string, user: unknown) =>
        mockCheckMediaAccess(sql, trackId, user),
}));

// Not exercised on the denial path tested here — stubbed so the module import
// doesn't pull in real filesystem/transcode-service machinery.
vi.mock('$lib/server/utils/media-path-resolver.js', () => ({
    resolveMediaPath: vi.fn(),
}));
vi.mock('$lib/server/services/music-transcode/index.js', () => ({
    getMusicTranscodeService: vi.fn(),
    clampBitrate: vi.fn(),
    defaultBitrateFor: vi.fn(),
    probeAudioSource: vi.fn(),
    containerFor: vi.fn(),
}));
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({
    bandwidthTracker: { trackDirectPlay: vi.fn(), trackTranscode: vi.fn() },
}));
vi.mock('$lib/server/subsonic-compat/utils/transcode-session.js', () => ({
    upsertTranscodeSession: vi.fn(),
}));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: 0 })),
}));

const { createMusicStreamHandlers } = await import('./route-handler.js');
const { clearStreamSourceCaches } = await import('./stream-source.js');

const TRACK_ID = 'b2df0000-0000-4000-a000-000000000000';

/** A stream_token-derived UserContext, shaped as handleStreamToken (C4 fix)
 *  now builds it: real DB-derived group/age fields, not hardcoded. */
function streamTokenUser(overrides: Partial<UserContext> = {}): UserContext {
    return {
        userId: 'usr_00000000-0000-0000-0000-000000000001' as UserContext['userId'],
        username: 'kid-account',
        groups: '',
        userGroups: [],
        hasWatchPermission: true,
        hasLiveTvPermission: true,
        hasRequestPermission: true,
        ownerIsAdmin: false,
        maxAgeRating: 13,
        isAgeRestricted: true,
        isModerator: false,
        liveTvPriority: 'low',
        ...overrides,
    };
}

function makeEvent(user: UserContext): RequestEvent {
    const url = new URL(`http://localhost/api/v1/music/tracks/${TRACK_ID}/stream`);
    return {
        url,
        params: { id: TRACK_ID },
        route: { id: '/api/v1/music/tracks/[id]/stream' as const },
        request: new Request(url.toString()),
        locals: { user, authMethod: 'stream_token' },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    clearStreamSourceCaches();
    mockGetSql.mockResolvedValue({});
    mockGetTrackDetail.mockResolvedValue({
        id: TRACK_ID,
        title: 'Explicit Track',
        sort_order: null,
        runtime_seconds: 200,
        custom_poster_url: null,
        custom_metadata: {},
        parent_id: null,
        album_id: null,
        album_title: null,
        album_custom_poster_url: null,
        album_custom_metadata: null,
        album_year: null,
        artist_id: null,
        artist_title: null,
        track_artist_id: null,
        track_artist_title: null,
        track_artists: null,
        created_at: new Date().toISOString(),
        file_path: '/music/explicit-track.flac',
    });
});

describe('createMusicStreamHandlers GET — media-access seam (C4)', () => {
    it('passes the real, DB-derived stream-token user into checkMediaAccess', async () => {
        mockCheckMediaAccess.mockResolvedValue(true);
        const { GET } = createMusicStreamHandlers({
            source: 'public-api',
            deviceId: (u) => `music:${u}`,
            loggerName: 'test',
        });

        const user = streamTokenUser();
        await GET!(makeEvent(user));

        expect(mockCheckMediaAccess).toHaveBeenCalledTimes(1);
        const [, calledTrackId, calledUser] = mockCheckMediaAccess.mock.calls[0];
        expect(calledTrackId).toBe(TRACK_ID);
        // Not the old hardcoded stand-in: the real, age-restricted context.
        expect(calledUser).toMatchObject({ isAgeRestricted: true, maxAgeRating: 13 });
    });

    it('an 18-rated track denied by checkMediaAccess for a 13-capped stream_token user -> 404 (not 403)', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);
        const { GET } = createMusicStreamHandlers({
            source: 'public-api',
            deviceId: (u) => `music:${u}`,
            loggerName: 'test',
        });

        const res = await GET!(makeEvent(streamTokenUser()));

        expect(res.status).toBe(404);
        expect(mockCheckMediaAccess).toHaveBeenCalledWith(
            expect.anything(),
            TRACK_ID,
            expect.objectContaining({ isAgeRestricted: true, maxAgeRating: 13 }),
        );
    });

    it('an unrestricted account (maxAgeRating:null) is allowed through to file resolution', async () => {
        mockCheckMediaAccess.mockResolvedValue(true);
        const { GET } = createMusicStreamHandlers({
            source: 'public-api',
            deviceId: (u) => `music:${u}`,
            loggerName: 'test',
        });

        const res = await GET!(
            makeEvent(streamTokenUser({ maxAgeRating: null, isAgeRestricted: false })),
        );

        // Past the access gate — resolveMediaPath is mocked to return
        // undefined, so this now fails at the (unmocked-detail) file-resolve
        // step rather than at the 404 access gate. Any non-404 status proves
        // the access gate did not deny it.
        expect(res.status).not.toBe(404);
    });
});

describe('Original byte ranges', () => {
    it('streams the requested disk slice and passes the abort signal to the file stream', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'quiet-lake-raw-'));
        try {
            const path = join(dir, 'Quiet Lake.wav');
            // The probe is mocked, so any bytes do; a fixed pattern keeps the unit job ffmpeg-free.
            await writeFile(path, Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251)));
            const { resolveMediaPath } = await import('$lib/server/utils/media-path-resolver.js');
            const { probeAudioSource } = await import('./index.js');
            vi.mocked(resolveMediaPath).mockResolvedValue({
                containerPath: path,
                isAccessible: true,
                fileSize: (await stat(path)).size,
            } as Awaited<ReturnType<typeof resolveMediaPath>>);
            vi.mocked(probeAudioSource).mockResolvedValue({
                codec: 'pcm_s16le',
                container: 'wav',
                bitrate: 705600,
                sampleRate: 44100,
                channels: 1,
                bitDepth: 16,
            });
            mockCheckMediaAccess.mockResolvedValue(true);
            const bytes = await readFile(path);
            const handlers = createMusicStreamHandlers({
                source: 'public-api',
                deviceId: () => 'raw-range-test',
                loggerName: 'test',
            });
            for (const [start, end] of [
                [0, 1],
                [7, bytes.length - 1],
            ]) {
                const input = makeEvent(streamTokenUser());
                input.request = new Request(`${input.request.url}?format=raw`, {
                    headers: { Range: `bytes=${start}-${end}` },
                });
                const response = await handlers.serveTrack(input, TRACK_ID);
                expect(response.status).toBe(206);
                expect(response.body).toBeInstanceOf(ReadableStream);
                expect(createReadStream).toHaveBeenLastCalledWith(path, {
                    start,
                    end,
                    signal: input.request.signal,
                });
                expect(response.headers.get('Content-Range')).toBe(
                    `bytes ${start}-${end}/${bytes.length}`,
                );
                expect(response.headers.get('Content-Length')).toBe(String(end - start + 1));
                expect(Buffer.from(await response.arrayBuffer())).toEqual(
                    bytes.subarray(start, end + 1),
                );
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
