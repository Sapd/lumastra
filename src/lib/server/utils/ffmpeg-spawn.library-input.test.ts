// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** `spawnFFmpegSafely({ libraryInput })` hands ffmpeg the per-input whitelist. */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('child_process', () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));
vi.mock('$lib/server/config.js', () => ({
    config: { FFMPEG_PATH: 'ffmpeg' },
    LUMASTRA_FFMPEG_THREADS: 0,
}));
vi.mock('./logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('./media-format-whitelist.js', () => ({
    getMediaFormatWhitelist: () => 'matroska,mov',
    prepareMediaFormatWhitelist: () => null,
}));

import { spawnFFmpegSafely } from './ffmpeg-spawn.js';

function fakeChild(): EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: () => void; write: () => void };
} {
    const child = new EventEmitter() as ReturnType<typeof fakeChild>;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {}, write: () => {} };
    setImmediate(() => child.emit('close', 0));
    return child;
}

beforeEach(() => {
    spawnMock.mockReset().mockImplementation(() => fakeChild());
});

describe('spawnFFmpegSafely libraryInput', () => {
    it('adds -format_whitelist before the library -i', async () => {
        await spawnFFmpegSafely({
            args: ['-i', '/lib/a.mkv', '-f', 'null', '-'],
            libraryInput: '/lib/a.mkv',
        });
        expect(spawnMock.mock.calls[0][1]).toEqual([
            '-format_whitelist',
            'matroska,mov',
            '-i',
            '/lib/a.mkv',
            '-f',
            'null',
            '-',
        ]);
    });

    it('leaves a spawn without libraryInput untouched', async () => {
        await spawnFFmpegSafely({ args: ['-f', 'lavfi', '-i', 'color=c=red', '-f', 'null', '-'] });
        expect(spawnMock.mock.calls[0][1]).toEqual([
            '-f',
            'lavfi',
            '-i',
            'color=c=red',
            '-f',
            'null',
            '-',
        ]);
    });
});
