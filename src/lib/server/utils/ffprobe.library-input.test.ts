// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every ffprobe that opens a library file gets `-format_whitelist` right before
 * the path, except `probeMediaFile`: the scanner needs ffprobe to NAME the
 * playlist demuxer it picked to classify a refusal. Separate file for the same
 * reason as ffprobe-protocol-whitelist.test.ts (it mocks child_process).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { promisify } from 'util';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('child_process', () => {
    const execFileFn = vi.fn() as ReturnType<typeof vi.fn> & {
        [promisify.custom]?: ReturnType<typeof vi.fn>;
    };
    execFileFn[promisify.custom] = vi.fn();
    return { execFile: execFileFn, spawn: (...a: unknown[]) => spawnMock(...a) };
});
vi.mock('$lib/server/config.js', () => ({
    config: { FFPROBE_PATH: '/usr/bin/ffprobe', FFMPEG_PATH: '/usr/bin/ffmpeg' },
}));
vi.mock('./media-format-whitelist.js', () => ({
    getMediaFormatWhitelist: () => 'matroska,mov',
    prepareMediaFormatWhitelist: () => null,
}));

import {
    probeMediaFile,
    probeStreamCounts,
    probeKeyframes,
    probeChapters,
    probeRaw,
    probeStreams,
    probeFormat,
} from './ffprobe.js';
import { execFile } from 'child_process';

const mockExecFileAsync = vi.mocked(
    (execFile as unknown as Record<symbol, ReturnType<typeof vi.fn>>)[promisify.custom],
);
const PATH = '/data/movies/Movie.mkv';

function expectGuardedBeforePath(args: string[]): void {
    const at = args.indexOf(PATH);
    expect(at).toBeGreaterThan(1);
    expect(args.slice(at - 2, at)).toEqual(['-format_whitelist', 'matroska,mov']);
}

beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileAsync.mockResolvedValue({
        stdout: JSON.stringify({
            format: { format_name: 'matroska,webm' },
            streams: [],
            chapters: [],
        }),
        stderr: '',
    });
    spawnMock.mockImplementation(() => {
        const proc = new EventEmitter() as EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
            kill: () => void;
        };
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.kill = () => {};
        setImmediate(() => proc.emit('close', 0, null));
        return proc;
    });
});

describe('ffprobe library probes carry -format_whitelist', () => {
    it.each([
        ['probeStreamCounts', () => probeStreamCounts(PATH)],
        ['probeChapters', () => probeChapters(PATH)],
        ['probeRaw', () => probeRaw(PATH)],
        ['probeStreams', () => probeStreams(PATH)],
        ['probeFormat', () => probeFormat(PATH)],
    ])('%s', async (_name, run) => {
        await run().catch(() => undefined);
        expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
        expectGuardedBeforePath(mockExecFileAsync.mock.calls[0]![1] as string[]);
    });

    it('probeKeyframes', async () => {
        await probeKeyframes(PATH);
        expect(spawnMock).toHaveBeenCalledTimes(1);
        expectGuardedBeforePath(spawnMock.mock.calls[0]![1] as string[]);
    });

    it('probeMediaFile (the scanner probe) does not, so it can name a playlist demuxer', async () => {
        await probeMediaFile(PATH);
        const args = mockExecFileAsync.mock.calls[0]![1] as string[];
        expect(args).not.toContain('-format_whitelist');
    });
});
