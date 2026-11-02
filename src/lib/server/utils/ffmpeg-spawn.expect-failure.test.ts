// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `options.expectFailure` is documented as moving the log level for a
 * *handled* FFmpeg failure from ERROR to DEBUG — "a handled probe failure is
 * a measurement, not an incident" (ffmpeg-spawn.ts:101-113). The only branch
 * that actually reads `options.expectFailure` is the non-zero-exit-code
 * branch; the timeout handler and the killed-by-signal branch log
 * unconditionally at ERROR regardless of the option. Both are plausible
 * outcomes of the trickplay hardware-decode probe (a 45s ceiling exists
 * specifically because a contended GPU is expected to be slow), so a caller
 * that opted into "don't alarm on this" still gets alarmed.
 *
 * These tests drive spawnFFmpegSafely() against a fake child process (no
 * real FFmpeg binary needed) to pin the log level on those two branches.
 */

import { withBackgroundCpu } from '../tasks/background-cpu-scope.js';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const loggerDebug = vi.fn();
const loggerError = vi.fn();
const loggerWarn = vi.fn();
const loggerInfo = vi.fn();

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            debug: (...args: unknown[]) => loggerDebug(...args),
            error: (...args: unknown[]) => loggerError(...args),
            warn: (...args: unknown[]) => loggerWarn(...args),
            info: (...args: unknown[]) => loggerInfo(...args),
        }),
    },
}));

vi.mock('$lib/server/config.js', () => ({
    config: { FFMPEG_PATH: '/usr/bin/ffmpeg' },
    // 0 skips the `-threads` injection so the fake argv isn't rewritten.
    LUMASTRA_FFMPEG_THREADS: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        existsSync: (path: unknown) =>
            path === '/usr/bin/ionice' || actual.existsSync(path as string),
    };
});

class FakeChildProcess extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    kill = vi.fn();
}

let fakeProcess: FakeChildProcess;
const spawnMock = vi.fn();

vi.mock('child_process', () => ({
    spawn: (...args: unknown[]) => spawnMock(...args),
}));

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    fakeProcess = new FakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('spawnFFmpegSafely — expectFailure on the timeout branch', () => {
    it('logs at debug, not error, when the caller expects the probe to time out', async () => {
        const { spawnFFmpegSafely, FFmpegTimeoutError } = await import('./ffmpeg-spawn.js');

        const resultPromise = spawnFFmpegSafely({
            args: ['-i', 'in.mp4'],
            timeout: 45_000,
            expectFailure: true,
        });
        const assertion = expect(resultPromise).rejects.toThrow(FFmpegTimeoutError);
        await vi.advanceTimersByTimeAsync(45_000);
        await assertion;

        expect(loggerDebug).toHaveBeenCalled();
        expect(loggerError).not.toHaveBeenCalled();
    });

    it('still logs at error when the caller did not opt out', async () => {
        const { spawnFFmpegSafely, FFmpegTimeoutError } = await import('./ffmpeg-spawn.js');

        const resultPromise = spawnFFmpegSafely({
            args: ['-i', 'in.mp4'],
            timeout: 45_000,
        });
        const assertion = expect(resultPromise).rejects.toThrow(FFmpegTimeoutError);
        await vi.advanceTimersByTimeAsync(45_000);
        await assertion;

        expect(loggerError).toHaveBeenCalled();
        expect(loggerDebug).not.toHaveBeenCalled();
    });
});

describe('spawnFFmpegSafely — expectFailure on the killed-by-signal branch', () => {
    it('logs at debug, not error, when the caller expects the process to be killed', async () => {
        const { spawnFFmpegSafely, FFmpegError } = await import('./ffmpeg-spawn.js');

        const resultPromise = spawnFFmpegSafely({
            args: ['-i', 'in.mp4'],
            expectFailure: true,
        });
        fakeProcess.emit('close', null, 'SIGKILL');
        await expect(resultPromise).rejects.toThrow(FFmpegError);

        expect(loggerDebug).toHaveBeenCalled();
        expect(loggerError).not.toHaveBeenCalled();
    });

    it('still logs at error when the caller did not opt out', async () => {
        const { spawnFFmpegSafely, FFmpegError } = await import('./ffmpeg-spawn.js');

        const resultPromise = spawnFFmpegSafely({
            args: ['-i', 'in.mp4'],
        });
        fakeProcess.emit('close', null, 'SIGKILL');
        await expect(resultPromise).rejects.toThrow(FFmpegError);

        expect(loggerError).toHaveBeenCalled();
        expect(loggerDebug).not.toHaveBeenCalled();
    });
});

describe('background FFmpeg scheduling priority', () => {
    it('waits at the checkpoint and launches with nice/ionice without wrapping playback', async () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        const { spawnFFmpegSafely } = await import('./ffmpeg-spawn.js');
        let resume!: () => void;
        const gate = new Promise<void>((resolve) => {
            resume = resolve;
        });
        const checkpoint = vi.fn(() => gate);
        const result = withBackgroundCpu(checkpoint, () =>
            spawnFFmpegSafely({ args: ['-version'] }),
        );
        expect(spawnMock).not.toHaveBeenCalled();
        resume();
        await vi.advanceTimersByTimeAsync(0);
        expect(spawnMock).toHaveBeenCalledOnce();
        try {
            expect(spawnMock.mock.calls[0][0]).toBe('/usr/bin/ionice');
            expect(spawnMock.mock.calls[0][1]).toEqual([
                '-t',
                '-c',
                '3',
                '/usr/bin/nice',
                '-n',
                '19',
                '/usr/bin/ffmpeg',
                '-version',
            ]);
        } finally {
            Object.defineProperty(process, 'platform', platform);
        }
        fakeProcess.emit('close', 0, null);
        await result;
        spawnMock.mockClear();
        const playback = spawnFFmpegSafely({ args: ['-version'] });
        expect(spawnMock.mock.calls[0][0]).toBe('/usr/bin/ffmpeg');
        fakeProcess.emit('close', 0, null);
        await playback;
    });
});
