// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import type postgres from 'postgres';
import { ShutdownInterruptedError } from '$lib/server/lifecycle/shutdown-interrupted.js';
import * as shutdown from '$lib/server/lifecycle/web-shutdown.js';
import { updateTranscodeJobStatus } from '$lib/server/database/queries/transcode-jobs.queries.js';
import { MusicTranscodeService } from './service.js';
import type { TranscodeStreamRequest } from './types.js';
import type { MusicTranscodeCache } from './cache.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('./source-guard.js', () => ({ assertTranscodeSourceIsMedia: vi.fn() }));
vi.mock('./fdk-aac-detection.js', () => ({ hasLibFdkAac: async () => false }));
vi.mock('$lib/server/utils/media-format-whitelist.js', () => ({
    prepareMediaFormatWhitelist: () => undefined,
}));
vi.mock('$lib/server/utils/library-input-guard.js', () => ({
    guardLibraryInput: (args: string[]) => args,
}));
vi.mock('$lib/server/cache/valkey.js', () => ({
    getCoordinationClient: () => null,
    subscribeToChannel: async () => () => {},
}));
vi.mock('$lib/server/database/queries/transcode-jobs.queries.js', () => ({
    insertActiveTranscodeJob: vi.fn(),
    updateTranscodeJobStatus: vi.fn(),
    JobStatus: { Stopped: 'stopped', Error: 'error', Running: 'running' },
}));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('$lib/server/utils/logger.js', () => ({ Logger: { for: () => log } }));

const req: TranscodeStreamRequest = {
    trackUuid: '00000000-0000-4000-a000-00000000a001',
    sourcePath: '/music/track.flac',
    sourceMtimeMs: 1,
    codec: 'm4a',
    bitrateKbps: 128,
    timeOffset: 0,
    session: {
        sessionId: '00000000-0000-4000-a000-00000000a002',
        userId: 'usr_test' as TranscodeStreamRequest['session']['userId'],
        deviceId: 'test-device',
        source: 'public-api',
    },
};

afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

describe('music encode interrupted by shutdown', () => {
    it.each([false, true])('records a non-zero exit with draining=%s', async (draining) => {
        const phase = vi.spyOn(shutdown, 'isShuttingDown').mockReturnValue(false);
        const proc = Object.assign(new EventEmitter(), {
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            pid: 123,
            kill: vi.fn(),
        });
        vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
        const writer = {
            isPrimary: true,
            partialPath: '/tmp/music-test.partial',
            finalPath: '/tmp/music-test.m4a',
            waitForPrimary: async () => {},
            promote: vi.fn(async () => {}),
            abort: vi.fn(async () => {}),
        };
        const cache: MusicTranscodeCache = {
            getCachedFinalPath: async () => null,
            beginWrite: async () => writer,
            peekInFlight: () => false,
            waitForKey: async () => {},
            reapToCap: async () => {},
        };
        const svc = new MusicTranscodeService({ sql: vi.fn(() => Promise.resolve([{ id: req.session.sessionId }])) as unknown as postgres.Sql, cache });
        const pending = svc.streamFor(req);
        // Wait until the real service is listening for the encode's completion.
        await vi.waitFor(() => expect(proc.listenerCount('close')).toBe(2));
        phase.mockReturnValue(draining);
        const rejected = expect(pending).rejects.toMatchObject({
            message: expect.stringContaining('encode to file failed'),
        });
        proc.emit('close', 255);
        await rejected;
        expect(updateTranscodeJobStatus).toHaveBeenCalledWith(
            expect.anything(),
            req.session.sessionId,
            expect.objectContaining({
                status: 'error',
                error_message: 'ffmpeg exit 255',
            }),
        );
        expect(writer.abort).toHaveBeenCalledOnce();
        expect(writer.promote).not.toHaveBeenCalled();
        expect(spawn).toHaveBeenCalledOnce();
        expect(log.warn).toHaveBeenCalledWith('ffmpeg non-zero exit', expect.anything());
    });
    it('releases the primary pipe writer when shutdown refuses the spawn', async () => {
        const phase = vi.spyOn(shutdown, 'isShuttingDown').mockReturnValue(false);
        let followerReleased = false;
        let releaseFollower: () => void = () => {};
        const follower = new Promise<void>((resolve) => {
            releaseFollower = resolve;
        }).then(() => {
            followerReleased = true;
        });
        const writer = {
            isPrimary: true,
            partialPath: '/tmp/pipe.partial',
            finalPath: '/tmp/pipe.mp3',
            waitForPrimary: () => follower,
            promote: vi.fn(async () => {}),
            abort: vi.fn(async () => {
                releaseFollower();
            }),
        };
        const cache: MusicTranscodeCache = {
            getCachedFinalPath: async () => null,
            beginWrite: async () => {
                phase.mockReturnValue(true);
                return writer;
            },
            peekInFlight: () => false,
            waitForKey: async () => {},
            reapToCap: async () => {},
        };
        const svc = new MusicTranscodeService({ sql: vi.fn(() => Promise.resolve([{ id: req.session.sessionId }])) as unknown as postgres.Sql, cache });
        await expect(svc.streamFor({ ...req, codec: 'mp3' })).rejects.toMatchObject({
            status: 503,
        });
        expect(writer.abort).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(followerReleased).toBe(true));
        expect(spawn).not.toHaveBeenCalled();
    });

    it('records stopped and returns a retry only after our kill during closing', async () => {
        vi.spyOn(shutdown, 'isShuttingDown').mockReturnValue(false);
        const phase = vi.spyOn(shutdown, 'getWebShutdownPhase').mockReturnValue('serving');
        const proc = Object.assign(new EventEmitter(), {
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            pid: 123,
            exitCode: null,
            signalCode: null,
            kill: vi.fn(),
        });
        vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
        const writer = {
            isPrimary: true,
            partialPath: '/tmp/music-test.partial',
            finalPath: '/tmp/music-test.m4a',
            waitForPrimary: async () => {},
            promote: vi.fn(async () => {}),
            abort: vi.fn(async () => {}),
        };
        const cache: MusicTranscodeCache = {
            getCachedFinalPath: async () => null,
            beginWrite: async () => writer,
            peekInFlight: () => false,
            waitForKey: async () => {},
            reapToCap: async () => {},
        };
        const abort = new AbortController();
        const svc = new MusicTranscodeService({ sql: vi.fn(() => Promise.resolve([{ id: req.session.sessionId }])) as unknown as postgres.Sql, cache });
        const pending = svc.streamFor({ ...req, abortSignal: abort.signal });
        await vi.waitFor(() => expect(proc.listenerCount('close')).toBe(2));
        phase.mockReturnValue('closing');
        abort.abort();
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
        const rejected = expect(pending).rejects.toBeInstanceOf(ShutdownInterruptedError);
        proc.emit('close', 255);
        await rejected;
        expect(updateTranscodeJobStatus).toHaveBeenCalledWith(
            expect.anything(),
            req.session.sessionId,
            expect.objectContaining({ status: 'stopped', error_message: null }),
        );
        expect(writer.abort).toHaveBeenCalledOnce();
        expect(log.warn).not.toHaveBeenCalledWith('ffmpeg non-zero exit', expect.anything());
        expect(log.info).toHaveBeenCalledWith('ffmpeg terminated during shutdown', { code: 255 });
    });
    // ffmpeg exits 0 without output when SIGTERM lands while it is starting
    // (measured ~1 in 8 at a 3-4 ms delay). A cancelled stream must not be
    // recorded as finished, nor its empty output promoted into the cache.
    describe.each([
        ['m4a (encode to file)', 'm4a' as const],
        ['mp3 (live pipe)', 'mp3' as const],
    ])('cancel racing ffmpeg start-up, %s', (_label, codec) => {
        it('records error and never promotes when ffmpeg exits 0 after our SIGTERM', async () => {
            vi.spyOn(shutdown, 'isShuttingDown').mockReturnValue(false);
            vi.spyOn(shutdown, 'getWebShutdownPhase').mockReturnValue('serving');
            const proc = Object.assign(new EventEmitter(), {
                stdout: new PassThrough(),
                stderr: new PassThrough(),
                pid: 123,
                exitCode: null,
                signalCode: null,
                kill: vi.fn(),
            });
            vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
            const writer = {
                isPrimary: true,
                partialPath: `/tmp/music-cancel-${codec}-${process.pid}.partial`,
                finalPath: `/tmp/music-cancel-${codec}-${process.pid}.final`,
                waitForPrimary: async () => {},
                promote: vi.fn(async () => {}),
                abort: vi.fn(async () => {}),
            };
            const cache: MusicTranscodeCache = {
                getCachedFinalPath: async () => null,
                beginWrite: async () => writer,
                peekInFlight: () => false,
                waitForKey: async () => {},
                reapToCap: async () => {},
            };
            const abort = new AbortController();
            const svc = new MusicTranscodeService({
                sql: vi.fn(() =>
                    Promise.resolve([{ id: req.session.sessionId }]),
                ) as unknown as postgres.Sql,
                cache,
            });
            const pending = svc.streamFor({ ...req, codec, abortSignal: abort.signal });
            await vi.waitFor(() => expect(proc.listenerCount('close')).toBeGreaterThan(0));
            if (codec === 'mp3') await pending;
            else pending.catch(() => {});
            abort.abort();
            expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
            proc.emit('close', 0);
            proc.stdout.end();
            await vi.waitFor(() => expect(writer.abort).toHaveBeenCalledOnce());
            expect(updateTranscodeJobStatus).toHaveBeenCalledWith(
                expect.anything(),
                req.session.sessionId,
                expect.objectContaining({ status: 'error' }),
            );
            expect(updateTranscodeJobStatus).not.toHaveBeenCalledWith(
                expect.anything(),
                req.session.sessionId,
                expect.objectContaining({ status: 'stopped' }),
            );
            expect(writer.promote).not.toHaveBeenCalled();
        });
    });
});
