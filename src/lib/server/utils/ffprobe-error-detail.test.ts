// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests asserting that ffprobe failures carry ffprobe's own diagnostic
 * text (not a generic "failed" message) through to the log/return value.
 *
 * Root cause fixed: every ffprobe invocation passed `-v quiet`, which
 * suppresses error-level output before it can ever reach stderr — so even
 * functions that correctly surfaced `error.message` had nothing real to show.
 * `probeKeyframes` additionally drained stderr to a no-op. This file is
 * separate from ffprobe.test.ts because it needs `vi.mock('child_process')`,
 * which would interfere with that file's real-ffprobe-free tests (see
 * ffprobe-plugin.test.ts for the same pattern).
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { promisify } from 'util';
import { EventEmitter } from 'events';

vi.mock('child_process', () => {
    const execFileFn = vi.fn() as ReturnType<typeof vi.fn> & {
        [promisify.custom]?: ReturnType<typeof vi.fn>;
    };
    execFileFn[promisify.custom] = vi.fn();
    const spawnFn = vi.fn();
    return { execFile: execFileFn, spawn: spawnFn };
});

vi.mock('$lib/server/config.js', () => ({
    config: { FFPROBE_PATH: '/usr/bin/ffprobe' },
}));

import { probeStreamCounts, probeKeyframes, probeStreamTails } from './ffprobe.js';
import { execFile, spawn } from 'child_process';

const mockExecFileAsync = vi.mocked(
    (execFile as unknown as Record<symbol, ReturnType<typeof vi.fn>>)[promisify.custom],
);
const mockSpawn = vi.mocked(spawn) as unknown as Mock;

beforeEach(() => {
    vi.clearAllMocks();
});

describe('probeStreamCounts — failure diagnostics', () => {
    it('logs the real ffprobe stderr text instead of swallowing it silently', async () => {
        // Node's promisified execFile rejects with
        // "Command failed: <cmd>\n<stderr>" once loglevel actually lets
        // ffprobe report the error (this used to be suppressed by -v quiet).
        const ffprobeStderr =
            'moov atom not found\n[mov,mp4,m4a,3gp,3g2,mj2 @ 0x5601a2b1c2c0] moov atom not found';
        const rejection = new Error(
            `Command failed: /usr/bin/ffprobe -v error ... /movies/broken.mp4\n${ffprobeStderr}`,
        );
        mockExecFileAsync.mockRejectedValue(rejection);

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const result = await probeStreamCounts('/movies/broken.mp4');

        expect(result).toBeNull();
        // The previous implementation was a bare `catch { return null; }` —
        // zero logging. Assert the real ffprobe error text actually reached
        // the log, not just that a call happened.
        expect(warnSpy).toHaveBeenCalled();
        const loggedText = warnSpy.mock.calls.flat().join(' ');
        expect(loggedText).toContain('moov atom not found');

        warnSpy.mockRestore();
    });
});

describe('probeKeyframes — failure diagnostics', () => {
    /** Minimal fake child_process.ChildProcess for spawn(). */
    function createFakeProc(): {
        proc: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: Mock };
    } {
        const proc = new EventEmitter() as EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
            kill: Mock;
        };
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.kill = vi.fn();
        return { proc };
    }

    it('captures the real ffprobe stderr tail instead of draining it to nothing', async () => {
        const { proc } = createFakeProc();
        mockSpawn.mockReturnValue(proc);

        // The probe awaits the format whitelist before it spawns.
        const resultPromise = probeKeyframes('/movies/corrupt.mkv');
        await new Promise((r) => setImmediate(r));

        // Simulate ffprobe writing a real diagnostic line to stderr, then
        // exiting non-zero — this is what -v quiet used to suppress, and
        // what the old no-op stderr handler used to discard even if it
        // arrived.
        proc.stderr.emit(
            'data',
            Buffer.from('[matroska,webm @ 0x1234] Read error\ninvalid data found\n'),
        );
        proc.emit('close', 1);

        const result = await resultPromise;

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(result.error).toContain('invalid data found');
    });

    it('redacts the absolute file path ffprobe echoes back in its own stderr', async () => {
        const { proc } = createFakeProc();
        mockSpawn.mockReturnValue(proc);

        const filePath = '/data/library/movies/Some Movie (2024)/movie.mkv';
        // The probe awaits the format whitelist before it spawns.
        const resultPromise = probeKeyframes(filePath);
        await new Promise((r) => setImmediate(r));

        // ffprobe prints the input path verbatim for open/format errors, e.g.
        // "<path>: Invalid data found when processing input" — that must not
        // leak into a field persisted/returned as diagnostic text.
        proc.stderr.emit('data', Buffer.from(`${filePath}: Invalid data found\n`));
        proc.emit('close', 1);

        const result = await resultPromise;

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(result.error).not.toContain(filePath);
        expect(result.error).not.toContain('/data/library/movies/Some Movie (2024)');
        expect(result.error).toContain('Invalid data found');
    });

    it('decodes stderr correctly when a multi-byte UTF-8 character is split across chunks', async () => {
        const { proc } = createFakeProc();
        mockSpawn.mockReturnValue(proc);

        // The probe awaits the format whitelist before it spawns.
        const resultPromise = probeKeyframes('/movies/corrupt.mkv');
        await new Promise((r) => setImmediate(r));

        // "é" (U+00E9) encodes to the two bytes 0xC3 0xA9 in UTF-8. Split the
        // stream so the two bytes of the same character arrive in separate
        // `data` events — a real possibility on a pipe — to catch
        // per-chunk `toString('utf8')` decoding that would corrupt it into
        // two replacement characters.
        const full = Buffer.from('café invalid data found\n', 'utf8');
        // "café " is 6 bytes in UTF-8 ('c','a','f',0xC3,0xA9,' ') — split
        // right between the two bytes of 'é'.
        const splitAt = 4;
        proc.stderr.emit('data', full.subarray(0, splitAt));
        proc.stderr.emit('data', full.subarray(splitAt));
        proc.emit('close', 1);

        const result = await resultPromise;

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(result.error).toContain('café invalid data found');
        expect(result.error).not.toContain('�');
    });
});

describe('probeStreamTails — failed subprocess evidence', () => {
    it('marks apparently healthy partial packet output from a nonzero exit unsuccessful', async () => {
        mockExecFileAsync.mockImplementation(async (_binary: string, args: string[]) => {
            throw Object.assign(new Error('ffprobe exited with code 1'), {
                code: 1,
                stdout:
                    args[args.indexOf('-select_streams') + 1] === 'a'
                        ? '1360.0\naudio\n'
                        : '1355.0\n',
                stderr: 'I/O error',
            });
        });
        const tails = await probeStreamTails('/media/partially-readable.mkv');
        expect(mockExecFileAsync).toHaveBeenCalledTimes(2);
        expect(
            mockExecFileAsync.mock.calls.map(
                ([, args]) => args[args.indexOf('-select_streams') + 1],
            ),
        ).toEqual(['v:0', 'a']);
        expect(tails).toEqual({
            success: false,
            videoEnd: 1355,
            audioEnd: 1360,
            hasAudio: true,
            endedPrematurely: false,
        });
    });
});
