// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';
import type { TrackDetailRow } from '$lib/server/database/queries/music.queries.js';

const {
    mockCheckRateLimit,
    mockGetSql,
    mockGetTrackDetail,
    mockCheckMediaAccess,
    mockResolveMediaPath,
    mockReadFile,
    mockOpen,
    mockStat,
} = vi.hoisted(() => ({
    mockCheckRateLimit: vi.fn(),
    mockGetSql: vi.fn(),
    mockGetTrackDetail: vi.fn(),
    mockCheckMediaAccess: vi.fn(),
    mockResolveMediaPath: vi.fn(),
    mockReadFile: vi.fn(),
    mockOpen: vi.fn(),
    mockStat: vi.fn(),
}));

// `checkDownloadRateLimit` is the download-only gate extracted from the GET
// handler (see route-handler.ts). Mocking just its one collaborator lets the
// four behavioural contracts below be tested without driving the DB lookups,
// media-access checks, and file-system resolution the full handler needs
// before it ever reaches this guard — none of which the guard itself cares
// about.
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

// The remaining mocks exist ONLY for the `createMusicStreamHandlers` describe
// block below, which drives the real GET handler end to end to prove the
// call site actually wires `checkDownloadRateLimit` in — deleting the call
// site (route-handler.ts:302-303) leaves every OTHER test in this file
// green, since they all exercise `checkDownloadRateLimit` directly rather
// than through the handler that is supposed to call it.
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));
vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getTrackStreamSource: (...args: unknown[]) => mockGetTrackDetail(...args),
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));
vi.mock('$lib/server/utils/media-path-resolver.js', () => ({
    resolveMediaPath: (...args: unknown[]) => mockResolveMediaPath(...args),
}));
const mockCreateReadStream = vi.fn();
vi.mock('node:fs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:fs')>()),
    createReadStream: (...args: unknown[]) => mockCreateReadStream(...args),
}));
vi.mock('node:fs/promises', () => ({
    readFile: (...args: unknown[]) => mockReadFile(...args),
    open: (...args: unknown[]) => mockOpen(...args),
    stat: (...args: unknown[]) => mockStat(...args),
}));

import {
    downloadRateLimitKey,
    DOWNLOAD_RATE_LIMIT_MAX,
    DOWNLOAD_RATE_LIMIT_WINDOW_S,
    checkDownloadRateLimit,
    createMusicStreamHandlers,
} from './route-handler.js';
import { clearStreamSourceCaches } from './stream-source.js';

const FAKE_TRACK: TrackDetailRow = {
    id: 'track-1',
    title: 'A Track',
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
    created_at: '2026-01-01T00:00:00Z',
    file_path: '/data/music/track-1.mp3',
};

/**
 * Minimal RequestEvent stand-in for driving the real GET handler. Only the
 * fields the handler chain (requireAuth → withErrorHandler → the handler
 * body) actually reads are populated.
 */
function makeEvent(url: string): RequestEvent {
    return {
        params: { id: 'track-1' },
        request: new Request(url),
        url: new URL(url),
        locals: {
            user: {
                userId: toUserId('11111111-1111-1111-1111-111111111111'),
                username: 'alice',
                groups: '',
                userGroups: [],
                hasWatchPermission: true,
                hasLiveTvPermission: false,
                hasRequestPermission: true,
                ownerIsAdmin: false,
                isModerator: false,
                maxAgeRating: null,
                isAgeRestricted: false,
            },
        },
        cookies: {},
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
        route: { id: '/api/music/tracks/[id]/stream' },
    } as unknown as RequestEvent;
}

describe('downloadRateLimitKey', () => {
    it('is scoped per user', () => {
        expect(downloadRateLimitKey('user-a')).not.toBe(downloadRateLimitKey('user-b'));
    });

    it('is distinct from the playback path, so a sweep cannot throttle listening', () => {
        expect(downloadRateLimitKey('user-a')).toContain('download');
    });
});

describe('DOWNLOAD_RATE_LIMIT_MAX', () => {
    it('sustains an hourly rate comfortably above a full first fill', () => {
        // A first fill is on the order of 1200 tracks (the rotation lane's
        // design target — see MAX_WANT in the candidates def); the sustained
        // rate must clear that comfortably, not just the raw MAX in isolation.
        const hourlyRate = (DOWNLOAD_RATE_LIMIT_MAX / DOWNLOAD_RATE_LIMIT_WINDOW_S) * 3600;
        expect(hourlyRate).toBeGreaterThanOrEqual(1800);
    });

    it('recovers within 10 minutes of being throttled, not up to an hour', () => {
        // A capacity-class 503 from the transcode cap still consumes a token
        // without moving bytes, so a naive 1-hour-aligned window could wall a
        // throttled client out for up to an hour. `checkRateLimit` buckets by
        // `floor(now / windowSeconds)` (see valkey-rate-limit.ts) — this is
        // itself a FIXED window too, not a rolling one, just a shorter one:
        // the bound this assertion protects is "at most one window's worth
        // of wait", which a fixed window satisfies regardless of where in it
        // a client gets throttled. The trade-off of a shorter fixed window is
        // a boundary burst: a client can spend its full budget right before
        // a bucket boundary and again right after, i.e. up to 2x the nominal
        // budget in a short span straddling the boundary.
        expect(DOWNLOAD_RATE_LIMIT_WINDOW_S).toBeLessThanOrEqual(600);
    });
});

describe('checkDownloadRateLimit', () => {
    beforeEach(() => {
        mockCheckRateLimit.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('never consults the limiter for a non-download request — the playback-throttling regression guard', async () => {
        const result = await checkDownloadRateLimit(false, 'user-a');

        expect(mockCheckRateLimit).not.toHaveBeenCalled();
        expect(result).toBeNull();
    });

    it('lets a download under the limit proceed', async () => {
        mockCheckRateLimit.mockResolvedValue({
            allowed: true,
            remaining: 10,
            resetAt: Math.floor(Date.now() / 1000) + 3600,
            total: DOWNLOAD_RATE_LIMIT_MAX,
        });

        const result = await checkDownloadRateLimit(true, 'user-a');

        expect(mockCheckRateLimit).toHaveBeenCalledWith(
            downloadRateLimitKey('user-a'),
            DOWNLOAD_RATE_LIMIT_MAX,
            DOWNLOAD_RATE_LIMIT_WINDOW_S,
        );
        // null means "continue" — the handler must not treat this as a 429.
        expect(result).toBeNull();
    });

    it('returns 429 with a Retry-After header for a download over the limit', async () => {
        mockCheckRateLimit.mockResolvedValue({
            allowed: false,
            remaining: 0,
            resetAt: Math.floor(Date.now() / 1000) + 120,
            total: DOWNLOAD_RATE_LIMIT_MAX,
        });

        const result = await checkDownloadRateLimit(true, 'user-a');

        expect(result).not.toBeNull();
        expect(result?.status).toBe(429);
        expect(result?.headers.get('Retry-After')).not.toBeNull();
    });

    it('computes Retry-After as a whole number of seconds from resetAt, not milliseconds', async () => {
        const nowMs = 1_700_000_000_000; // fixed, known epoch-ms instant
        vi.useFakeTimers();
        vi.setSystemTime(nowMs);

        const resetAtSeconds = Math.floor(nowMs / 1000) + 45; // 45s in the future
        mockCheckRateLimit.mockResolvedValue({
            allowed: false,
            remaining: 0,
            resetAt: resetAtSeconds,
            total: DOWNLOAD_RATE_LIMIT_MAX,
        });

        const result = await checkDownloadRateLimit(true, 'user-a');

        // Exactly 45, not 45000 (ms) and not <= 0.
        expect(result?.headers.get('Retry-After')).toBe('45');
    });
});

describe('createMusicStreamHandlers — download rate-limit call site', () => {
    // This is the mutation-tested contract from the review: deleting the
    // `checkDownloadRateLimit` call and its early return in the real GET
    // handler (route-handler.ts:302-303) must fail a test. Every test above
    // exercises `checkDownloadRateLimit` in isolation, so none of them would
    // notice if the handler stopped calling it — only driving the handler
    // itself closes that gap.
    beforeEach(() => {
        mockCheckRateLimit.mockReset();
        mockGetSql.mockReset().mockResolvedValue({});
        clearStreamSourceCaches();
        mockGetTrackDetail.mockReset().mockResolvedValue(FAKE_TRACK);
        mockCheckMediaAccess.mockReset().mockResolvedValue(true);
        mockResolveMediaPath.mockReset().mockResolvedValue({
            providerPath: FAKE_TRACK.file_path,
            containerPath: FAKE_TRACK.file_path,
            isAccessible: true,
            fileSize: 4_000_000,
        });
        mockStat.mockReset().mockResolvedValue({ size: 4_000_000, mtimeMs: 1 });
        mockReadFile.mockReset().mockResolvedValue(Buffer.from('audio-bytes'));
    });

    it('short-circuits a throttled download with 429 before any file work happens', async () => {
        mockCheckRateLimit.mockResolvedValue({
            allowed: false,
            remaining: 0,
            resetAt: Math.floor(Date.now() / 1000) + 60,
            total: DOWNLOAD_RATE_LIMIT_MAX,
        });

        const { GET } = createMusicStreamHandlers({
            source: 'api',
            deviceId: () => 'device-1',
            loggerName: 'test-music-stream',
        });

        const response = await GET(
            makeEvent('http://localhost/api/music/tracks/track-1/stream?download=1'),
        );

        expect(response.status).toBe(429);
        // Proves the short-circuit actually happens BEFORE the direct-play
        // file read — deleting the gate would let this reach readFile()
        // and come back 200, not 429.
        expect(mockReadFile).not.toHaveBeenCalled();
    });

    it('never consults the rate limiter for a non-download request', async () => {
        const { GET } = createMusicStreamHandlers({
            source: 'api',
            deviceId: () => 'device-1',
            loggerName: 'test-music-stream',
        });

        const response = await GET(makeEvent('http://localhost/api/music/tracks/track-1/stream'));

        expect(mockCheckRateLimit).not.toHaveBeenCalled();
        expect(response.status).toBe(200);
    });
});

describe('createMusicStreamHandlers — direct-play Range requests', () => {
    // AVFoundation opens every track with `bytes=0-1` and a few more ranged
    // reads before playback starts. Each used to readFile() the whole track;
    // a range must now read only its own bytes.
    const FILE = Buffer.from('0123456789abcdef');

    beforeEach(() => {
        mockCheckRateLimit.mockReset();
        mockGetSql.mockReset().mockResolvedValue({});
        clearStreamSourceCaches();
        mockGetTrackDetail.mockReset().mockResolvedValue(FAKE_TRACK);
        mockCheckMediaAccess.mockReset().mockResolvedValue(true);
        mockResolveMediaPath.mockReset().mockResolvedValue({
            providerPath: FAKE_TRACK.file_path,
            containerPath: FAKE_TRACK.file_path,
            isAccessible: true,
            fileSize: FILE.length,
        });
        mockStat.mockReset().mockResolvedValue({ size: FILE.length, mtimeMs: 1 });
        mockReadFile.mockReset().mockResolvedValue(FILE);
        mockCreateReadStream
            .mockReset()
            .mockImplementation((_path: string, opts: { start: number; end: number }) =>
                Readable.from([FILE.subarray(opts.start, opts.end + 1)]),
            );
        mockOpen.mockReset().mockResolvedValue({
            read: vi.fn(async (buf: Buffer, off: number, len: number, pos: number) => {
                const bytesRead = FILE.copy(buf, off, pos, Math.min(pos + len, FILE.length));
                return { bytesRead, buffer: buf };
            }),
            close: vi.fn(async () => {}),
        });
    });

    it('serves a 206 slice without reading the whole file', async () => {
        const { GET } = createMusicStreamHandlers({
            source: 'api',
            deviceId: () => 'device-1',
            loggerName: 'test-music-stream',
        });
        const url = 'http://localhost/api/music/tracks/track-1/stream';
        const event = makeEvent(url);
        event.request = new Request(url, { headers: { Range: 'bytes=2-5' } });

        const response = await GET(event);

        expect(response.status).toBe(206);
        expect(response.headers.get('Content-Range')).toBe(`bytes 2-5/${FILE.length}`);
        expect(response.headers.get('Content-Length')).toBe('4');
        expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('2345');
        expect(mockReadFile).not.toHaveBeenCalled();
    });
});
