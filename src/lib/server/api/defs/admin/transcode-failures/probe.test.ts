// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/admin/transcode-failures/probe.ts.
 *
 * Covers the redaction regression caught in review: `saveProbeDump` redacts the
 * DB write, but the FIRST (uncached) probe's HTTP response used to carry the raw,
 * unstripped `probeDump` local variable instead of the sanitized value that was
 * actually persisted — a caller could observe a pre-redaction dump (tokens and
 * all) on the very first probe of a row, even though every subsequent cached
 * fetch of that same row was already clean. All DB/ffmpeg I/O mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { FailureEventRow } from '$lib/server/database/queries/transcode-failure-events.queries.js';

const mockGetDb = vi.fn();
const mockGetFailureEventById = vi.fn();
const mockGetFailureEventFilePath = vi.fn();
const mockSaveProbeDump = vi.fn();
const mockResolveMediaPath = vi.fn();
const mockSpawnFFmpegSafely = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock(
    '$lib/server/database/queries/transcode-failure-events.queries.js',
    async (importActual) => {
        const actual =
            await importActual<
                typeof import('$lib/server/database/queries/transcode-failure-events.queries.js')
            >();
        return {
            ...actual,
            // `sanitizeProbeDump` stays REAL — it is the exact function under test for
            // the divergence bug, so mocking it would hide a regression instead of
            // catching one.
            getFailureEventById: (...args: unknown[]) => mockGetFailureEventById(...args),
            getFailureEventFilePath: (...args: unknown[]) => mockGetFailureEventFilePath(...args),
            saveProbeDump: (...args: unknown[]) => mockSaveProbeDump(...args),
        };
    },
);

vi.mock('$lib/server/utils/media-path-resolver.js', () => ({
    resolveMediaPath: (...args: unknown[]) => mockResolveMediaPath(...args),
}));

vi.mock('$lib/server/utils/ffmpeg-spawn.js', async (importActual) => {
    const actual = await importActual<typeof import('$lib/server/utils/ffmpeg-spawn.js')>();
    return {
        ...actual,
        // `FFmpegError` stays REAL — probe.ts's `err instanceof FFmpegError` check
        // must see the same class reference it would in production.
        spawnFFmpegSafely: (...args: unknown[]) => mockSpawnFFmpegSafely(...args),
    };
});

const { def } = await import('./probe.js');
const { FFmpegError } = await import('$lib/server/utils/ffmpeg-spawn.js');

function makeRow(overrides: Partial<FailureEventRow> = {}): FailureEventRow {
    return {
        id: '1',
        job_id: 'job-1',
        play_session_id: 'sess-1',
        attempt: 1,
        occurred_at: new Date(),
        outcome: 'failed',
        exit_code: 218,
        signal: null,
        category: 'gpu-init',
        summary: 'boom',
        argv: ['-i', '/data/movies/x.mkv'],
        stderr_tail: 'stderr',
        encoder: 'h264_qsv',
        hwaccel: 'qsv',
        media_id: null,
        file_id: 'file-1',
        source: null,
        decision: null,
        env: null,
        transcode_speed: null,
        probe_dump: null,
        probed_at: null,
        ...overrides,
    };
}

function makeCtx() {
    return {
        surface: 'internal' as const,
        input: { params: { id: '1' }, query: undefined, body: undefined },
    };
}

function makeEvent(): Partial<RequestEvent> {
    const url = new URL('http://localhost/api/admin/transcode-failures/1/probe');
    return { url, params: { id: '1' }, request: new Request(url.toString(), { method: 'POST' }) };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
    mockSaveProbeDump.mockResolvedValue(undefined);
});

describe('POST /admin/transcode-failures/:id/probe — response redaction', () => {
    it('strips secrets from the RESPONSE on the first (uncached) probe, not just the stored row', async () => {
        mockGetFailureEventById.mockResolvedValue(makeRow());
        mockGetFailureEventFilePath.mockResolvedValue('/data/movies/x.mkv');
        mockResolveMediaPath.mockResolvedValue({
            providerPath: '/data/movies/x.mkv',
            containerPath: '/data/movies/x.mkv',
            isAccessible: true,
        });
        // ffmpeg -i with no output exits non-zero by design — spawnFFmpegSafely
        // rejects; the "Input #0" report (with the secret ffmpeg itself echoes in
        // its banner) lives on the rejected FFmpegError's stderr.
        mockSpawnFFmpegSafely.mockRejectedValue(
            new FFmpegError(
                'FFmpeg exited with code 1',
                1,
                "Input #0, matroska,webm, from 'http://jf/s?api_key=SUPERSECRET':\n  Duration: 00:10:00",
            ),
        );

        const res = (await def.handlers.POST!(makeEvent() as RequestEvent, makeCtx())) as Response;
        const body = (await res.json()) as { probeDump: string | null };

        expect(body.probeDump).not.toContain('SUPERSECRET');
        expect(body.probeDump).toContain('api_key=<redacted>');
        expect(body.probeDump).toContain('Input #0');

        // The persisted value must be the SAME sanitized string, not merely "also
        // sanitized" — this is what makes divergence structurally impossible.
        expect(mockSaveProbeDump).toHaveBeenCalledWith(expect.anything(), '1', body.probeDump);
    });

    it('returns the cached dump unchanged on a second (already-probed) call', async () => {
        mockGetFailureEventById.mockResolvedValue(
            makeRow({ probed_at: new Date(), probe_dump: 'Input #0 clean dump' }),
        );

        const res = (await def.handlers.POST!(makeEvent() as RequestEvent, makeCtx())) as Response;
        const body = (await res.json()) as { probeDump: string | null };

        expect(body.probeDump).toBe('Input #0 clean dump');
        expect(mockSpawnFFmpegSafely).not.toHaveBeenCalled();
        expect(mockSaveProbeDump).not.toHaveBeenCalled();
    });
});

describe('POST /admin/transcode-failures/:id/probe — negative-probe caching', () => {
    it('caches a null probe result (deleted file, unmounted volume) so probed_at is set', async () => {
        mockGetFailureEventById.mockResolvedValue(makeRow());
        mockGetFailureEventFilePath.mockResolvedValue('/data/movies/gone.mkv');
        // Resolved but not accessible — file deleted / volume unmounted. probeSource
        // is never invoked, so rawProbeDump falls straight through to null.
        mockResolveMediaPath.mockResolvedValue({
            providerPath: '/data/movies/gone.mkv',
            containerPath: '/data/movies/gone.mkv',
            isAccessible: false,
        });

        const res = (await def.handlers.POST!(makeEvent() as RequestEvent, makeCtx())) as Response;
        const body = (await res.json()) as { probeDump: string | null };

        expect(body.probeDump).toBeNull();
        // The null result must still be cached — this is what makes the next
        // detail view for the same row skip re-probing entirely.
        expect(mockSaveProbeDump).toHaveBeenCalledWith(expect.anything(), '1', null);
    });

    it('does not 500 when the cache write fails — the already-computed dump is still returned', async () => {
        mockGetFailureEventById.mockResolvedValue(makeRow());
        mockGetFailureEventFilePath.mockResolvedValue('/data/movies/x.mkv');
        mockResolveMediaPath.mockResolvedValue({
            providerPath: '/data/movies/x.mkv',
            containerPath: '/data/movies/x.mkv',
            isAccessible: true,
        });
        mockSpawnFFmpegSafely.mockRejectedValue(
            new FFmpegError(
                'FFmpeg exited with code 1',
                1,
                "Input #0, matroska,webm, from '/data/movies/x.mkv':\n  Duration: 00:10:00",
            ),
        );
        mockSaveProbeDump.mockRejectedValue(new Error('db unavailable'));

        const res = (await def.handlers.POST!(makeEvent() as RequestEvent, makeCtx())) as Response;
        const body = (await res.json()) as { probeDump: string | null };

        expect(res.status).toBe(200);
        expect(body.probeDump).toContain('Input #0');
    });
});
