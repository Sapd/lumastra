// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `probeMediaFile` classifies every failure into a `ProbeFailureKind`
 * (ruling T7-probe-outcomes, fix plan 6 Task 7 fix round 3). The scanner
 * records `container_unreadable` and commits a file's hash only for
 * `invalid-data`; a timeout, an I/O error or a missing ffprobe binary must
 * come back `transient` so nothing is written about the file.
 *
 * The errors here are the REAL ones `execFile` rejects with: `FFPROBE_PATH`
 * points at small shell scripts standing in for ffprobe (exit status and
 * stderr exactly as ffprobe 9.0.1 prints them for these cases), a script that
 * never exits, or a path that does not exist.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ffprobe = vi.hoisted(() => ({ path: 'ffprobe' }));

vi.mock('$lib/server/config.js', () => ({
    config: {
        get FFPROBE_PATH(): string {
            return ffprobe.path;
        },
    },
}));

import { classifyProbeFailure, probeMediaFile } from './ffprobe.js';

let dir: string;

async function script(name: string, body: string): Promise<string> {
    const p = join(dir, name);
    await writeFile(p, `#!/bin/sh\n${body}\n`);
    await chmod(p, 0o755);
    return p;
}

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lumastra-ffprobe-kind-'));
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('probeMediaFile — failureKind', () => {
    it('invalid-data: ffprobe exits 1 with "Invalid data found when processing input"', async () => {
        ffprobe.path = await script(
            'invalid.sh',
            `echo "[matroska,webm @ 0x1] EBML header parsing failed" >&2
echo "garbage.mkv: Invalid data found when processing input" >&2
exit 1`,
        );
        const r = await probeMediaFile('/data/garbage.mkv');
        expect(r.success).toBe(false);
        expect(r.failureKind).toBe('invalid-data');
    });

    // Control: the same exit status with an I/O error is NOT a verdict on
    // the file's bytes.
    it('transient: ffprobe exits 1 with an I/O error', async () => {
        ffprobe.path = await script(
            'eio.sh',
            `echo "movie.mkv: Input/output error" >&2
exit 1`,
        );
        const r = await probeMediaFile('/data/movie.mkv');
        expect(r.failureKind).toBe('transient');
    });

    it('transient: ffprobe exits 1 because the file does not exist', async () => {
        ffprobe.path = await script(
            'enoent.sh',
            `echo "nope.mkv: No such file or directory" >&2
exit 1`,
        );
        const r = await probeMediaFile('/data/nope.mkv');
        expect(r.failureKind).toBe('transient');
        // The scanner's new-file path still keys its stale-row cleanup off this text.
        expect(r.error).toContain('No such file');
    });

    it('transient: the probe timed out (killed with SIGKILL)', async () => {
        ffprobe.path = await script('hang.sh', 'exec sleep 30');
        const r = await probeMediaFile('/data/fifo.mkv', 200);
        expect(r.failureKind).toBe('transient');
    });

    it('transient: the ffprobe binary cannot be spawned (ENOENT)', async () => {
        ffprobe.path = join(dir, 'does-not-exist', 'ffprobe');
        const r = await probeMediaFile('/data/movie.mkv');
        expect(r.failureKind).toBe('transient');
    });

    it('aborted: the caller aborted mid-probe', async () => {
        ffprobe.path = await script('hang-abort.sh', 'exec sleep 30');
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);
        const r = await probeMediaFile('/data/fifo.mkv', 10_000, { signal: controller.signal });
        expect(r.failureKind).toBe('aborted');
    });

    // N2 (fix round 4): invalid-data is decided from the LAST stderr line,
    // anchored at its end — a folder named after the AVERROR text must not
    // turn a permission error into a verdict on the file.
    it('transient: EACCES under a folder named "Invalid data found when processing input (2020)"', async () => {
        ffprobe.path = await script(
            'eacces-folder.sh',
            `echo "/lib/Invalid data found when processing input (2020)/x.mkv: Permission denied" >&2
exit 1`,
        );
        const r = await probeMediaFile(
            '/lib/Invalid data found when processing input (2020)/x.mkv',
        );
        expect(r.failureKind).toBe('transient');
    });

    // N1 (fix round 4): "Invalid data" reported after a reference-following
    // demuxer failed describes the REFERENCED file, not this one.
    it.each(['concat', 'hls', 'dash', 'imf'])(
        'reference-demuxer: a [%s @ …] line before the final "Invalid data"',
        async (demuxer) => {
            ffprobe.path = await script(
                `ref-${demuxer}.sh`,
                `echo "[${demuxer} @ 0x7f8e1c004000] Impossible to open 'v.m3u8'" >&2
echo "A.mkv: Invalid data found when processing input" >&2
exit 1`,
            );
            const r = await probeMediaFile('/data/A.mkv');
            expect(r.failureKind).toBe('reference-demuxer');
        },
    );

    // Control: the demuxer tag must START a stderr line (ffmpeg's av_log
    // prefix); a path that merely contains "[concat @ " is not one.
    it('transient: a path containing "[concat @ " mid-line is not a demuxer line', async () => {
        ffprobe.path = await script(
            'path-bracket.sh',
            `echo "/lib/[concat @ 1]/x.mkv: Permission denied" >&2
exit 1`,
        );
        const r = await probeMediaFile('/lib/[concat @ 1]/x.mkv');
        expect(r.failureKind).toBe('transient');
    });

    // Control: a genuinely broken container is still invalid-data under the
    // anchored rule — including when earlier lines come from its own demuxer.
    it('invalid-data: a garbage file, anchored on the last line', async () => {
        ffprobe.path = await script(
            'garbage-anchored.sh',
            `echo "Truncating packet of size 11372 to 18" >&2
echo "[matroska,webm @ 0x1] EBML header parsing failed" >&2
echo "/data/garbage.mkv: Invalid data found when processing input" >&2
echo "" >&2
exit 1`,
        );
        const r = await probeMediaFile('/data/garbage.mkv');
        expect(r.failureKind).toBe('invalid-data');
    });

    // Control: a successful probe carries no failureKind.
    it('a successful probe has no failureKind', async () => {
        ffprobe.path = await script(
            'ok.sh',
            `echo '{"streams":[],"format":{"format_name":"matroska,webm"}}'`,
        );
        const r = await probeMediaFile('/data/movie.mkv');
        expect(r.success).toBe(true);
        expect(r.failureKind).toBeUndefined();
    });
});

describe('classifyProbeFailure — non-execFile inputs', () => {
    it('a non-Error rejection is transient', () => {
        expect(classifyProbeFailure('boom')).toBe('transient');
    });

    it('a JSON parse error on ffprobe output is transient', () => {
        expect(classifyProbeFailure(new SyntaxError('Unexpected token'))).toBe('transient');
    });
});
