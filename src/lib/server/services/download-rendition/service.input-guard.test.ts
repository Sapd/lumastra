// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The offline-download encode reads the library file named by the request and
 * hands the transcoded bytes to the user, so a file whose CONTENT became an
 * HLS/ffconcat/DASH/IMF playlist body after the last scan would have FFmpeg
 * follow its references into other libraries and deliver them. The encode
 * must refuse such a source before spawning anything (fix plan 6 follow-up to
 * the final-wave M1 guard, `transcoding/input-guard.ts`).
 *
 * The sniff is the REAL one over real temp files; only the ffmpeg spawn, the
 * hardware plan and the row queries are mocked.
 */

import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile, access, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    cfg: {
        FEATURE_DOWNLOAD_RENDITIONS: true,
        FFMPEG_PATH: '/usr/bin/ffmpeg',
        INSTANCE_ID: 'pod-1',
        DOWNLOAD_RENDITION_MAX_CONCURRENT: 4,
        DOWNLOAD_RENDITION_STALE_SECONDS: 180,
        DOWNLOAD_RENDITION_STALL_TIMEOUT_SECONDS: 600,
        DOWNLOAD_RENDITION_CACHE_DIR: '',
        DOWNLOAD_RENDITION_CACHE_MAX_GB: 10,
    },
    plan: vi.fn(),
    total: vi.fn(),
    candidates: vi.fn(),
    deleteRow: vi.fn(),
    getRow: vi.fn(),
    spawn: vi.fn(),
    elect: vi.fn(),
    reclaim: vi.fn(),
    progress: vi.fn(),
    markEncoding: vi.fn(),
    markFailed: vi.fn(),
    markReady: vi.fn(),
}));

vi.mock('$lib/server/config.js', () => ({ config: h.cfg }));

vi.mock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:child_process')>()),
    spawn: (...a: unknown[]) => h.spawn(...a),
}));

vi.mock('./hw-plan.js', () => ({ resolveRenditionHwPlan: (...a: unknown[]) => h.plan(...a) }));

vi.mock('$lib/server/database/queries/download-renditions.queries.js', () => ({
    electOrGetRendition: (...a: unknown[]) => h.elect(...a),
    getRendition: (...a: unknown[]) => h.getRow(...a),
    markEncoding: (...a: unknown[]) => h.markEncoding(...a),
    markFailed: (...a: unknown[]) => h.markFailed(...a),
    markReady: (...a: unknown[]) => h.markReady(...a),
    reclaimStaleEncode: (...a: unknown[]) => h.reclaim(...a),
    reopenFailed: async () => false,
    updateProgress: (...a: unknown[]) => h.progress(...a),
    evictionCandidates: (...a: unknown[]) => h.candidates(...a),
    totalCachedBytes: (...a: unknown[]) => h.total(...a),
    deleteRendition: (...a: unknown[]) => h.deleteRow(...a),
}));

const ROW = {
    id: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
    status: 'queued',
    owner_pod: 'pod-1',
};

const REAL_MEDIA = `${process.cwd()}/tests/fixtures/test-video.mp4`;
const HLS_BODY = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/other/library/secret.ts\n';

/** A child that writes the output file (the last argv entry) and exits 0. */
function fakeFfmpeg(_bin: string, args: string[]) {
    const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
    });
    void writeFile(args[args.length - 1], Buffer.from('mp4')).then(() => child.emit('close', 0));
    return child;
}

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lumastra-rendition-guard-'));
    h.cfg.FEATURE_DOWNLOAD_RENDITIONS = true;
    h.cfg.DOWNLOAD_RENDITION_STALL_TIMEOUT_SECONDS = 600;
    h.cfg.DOWNLOAD_RENDITION_STALE_SECONDS = 180;
    h.cfg.DOWNLOAD_RENDITION_CACHE_DIR = join(dir, 'cache');
    h.plan.mockReset().mockResolvedValue(null);
    h.total.mockReset().mockResolvedValue(0);
    h.candidates.mockReset().mockResolvedValue([]);
    h.deleteRow.mockReset().mockResolvedValue(undefined);
    h.spawn.mockReset().mockImplementation(fakeFfmpeg);
    h.elect.mockReset().mockImplementation(async (_sql, params) => ({
        row: { ...ROW, owner_pod: params.podId },
        elected: true,
    }));
    h.getRow.mockReset().mockResolvedValue(ROW);
    h.reclaim.mockReset().mockResolvedValue(true);
    h.progress.mockReset().mockResolvedValue(true);
    h.markEncoding.mockReset().mockResolvedValue(true);
    h.markFailed.mockReset().mockResolvedValue(undefined);
    h.markReady.mockReset().mockResolvedValue(true);
});

afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
});

async function request(inputPath: string): Promise<void> {
    const { requestRendition } = await import('./service.js');
    await requestRendition({
        sql: {} as never,
        fileId: 'file-1',
        mediaItemId: 'item-1',
        rungId: '720p',
        audioIndex: null,
        inputPath,
        durationMs: 5000,
        isHdr: false,
    });
    // runEncode is fire-and-forget; wait for it to reach a terminal row state.
    // The default 1 s budget is too short on a loaded runner: the first encode
    // in this file also runs the real `ffmpeg -demuxers` / `-version` probe
    // (media-format-whitelist, capped at 10 s) before it spawns. The wait is
    // still on the terminal row state, not a fixed sleep.
    await vi.waitFor(
        () => {
            expect(h.markFailed.mock.calls.length + h.markReady.mock.calls.length).toBe(1);
        },
        { timeout: 20_000 },
    );
}

describe('download rendition — playlist-body source guard', () => {
    it('refuses a source whose content is a playlist body: no ffmpeg, row failed', async () => {
        const input = join(dir, 'movie.mkv');
        await writeFile(input, HLS_BODY);

        await request(input);

        expect(h.spawn).not.toHaveBeenCalled();
        expect(h.markFailed).toHaveBeenCalledWith(
            expect.anything(),
            ROW.id,
            'encode_failed',
            expect.stringMatching(/^pod-1:/),
        );
        expect(h.markReady).not.toHaveBeenCalled();
    });

    it('control: real media spawns ffmpeg on that path and the row goes ready', async () => {
        await request(REAL_MEDIA);

        expect(h.spawn).toHaveBeenCalledTimes(1);
        expect(h.spawn.mock.calls[0][1]).toContain(REAL_MEDIA);
        expect(h.markReady).toHaveBeenCalledTimes(1);
        expect(h.markFailed).not.toHaveBeenCalled();
    });
});

describe('live rendition ownership', () => {
    it.each([null, 36000000])(
        'heartbeats an encoder with duration %s even without changing percent, and never reclaims it locally',
        async (durationMs) => {
            const child = Object.assign(new EventEmitter(), {
                stdout: new EventEmitter(),
                stderr: new EventEmitter(),
            });
            h.spawn.mockReturnValue(child);
            const { requestRendition } = await import('./service.js');
            const params = {
                sql: {} as never,
                fileId: 'file-1',
                mediaItemId: 'item-1',
                rungId: '720p',
                audioIndex: null,
                inputPath: REAL_MEDIA,
                durationMs,
                isHdr: false,
            };
            vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
            await requestRendition(params);
            await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(1));
            child.stdout.emit('data', Buffer.from('out_time_ms=1000000\n'));
            for (let tick = 0; tick < 13; tick++) {
                child.stdout.emit('data', Buffer.from(`out_time_ms=${1000000 + tick}\n`));
                await vi.advanceTimersByTimeAsync(15000);
                await vi.waitFor(() => expect(h.progress).toHaveBeenCalledTimes(tick + 1));
            }
            // All these progress samples round to the same integer (or null).
            child.stdout.emit('data', Buffer.from('out_time_ms=1000001\n'));
            h.elect.mockResolvedValue({ row: { ...ROW, status: 'encoding' }, elected: false });
            await requestRendition(params);
            const heartbeatCount = h.progress.mock.calls.length;
            const reclaims = h.reclaim.mock.calls.length;
            const spawns = h.spawn.mock.calls.length;
            // Settle the child before assertions, including on the unfixed path.
            child.emit('close', 1);
            const countAtExit = h.progress.mock.calls.length;
            await vi.advanceTimersByTimeAsync(30000);
            const countAfterExit = h.progress.mock.calls.length;
            vi.useRealTimers();
            await vi.waitFor(() => expect(h.markFailed).toHaveBeenCalled());
            expect(heartbeatCount).toBeGreaterThanOrEqual(13);
            expect(reclaims).toBe(0);
            expect(spawns).toBe(1);
            expect(countAfterExit).toBe(countAtExit);
        },
    );
});

describe('rendition stall and abandoned artifacts', () => {
    it.each(['stall', 'superseded'])('kills a %s child and fences its failure', async (reason) => {
        const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            kill: vi.fn(() => {
                child.emit('close', null);
                return true;
            }),
        });
        h.spawn.mockReturnValue(child);
        if (reason === 'superseded') h.progress.mockResolvedValue(false);
        const { requestRendition } = await import('./service.js');
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
        await requestRendition({
            sql: {} as never,
            fileId: 'file-1',
            mediaItemId: 'item-1',
            rungId: '720p',
            audioIndex: null,
            inputPath: REAL_MEDIA,
            durationMs: null,
            isHdr: false,
        });
        await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(1));
        if (reason === 'superseded')
            child.stdout.emit('data', Buffer.from('out_time_ms=1000000\n'));
        await vi.advanceTimersByTimeAsync(reason === 'stall' ? 615000 : 15000);
        try {
            await vi.waitFor(() => expect(child.kill).toHaveBeenCalledTimes(1));
            if (reason === 'stall') expect(h.progress).not.toHaveBeenCalled();
        } finally {
            child.emit('close', 1); // settle even on the red path
            vi.useRealTimers();
            await vi.waitFor(() => expect(h.markFailed).toHaveBeenCalled());
        }
        expect(h.markFailed).toHaveBeenCalledWith(
            expect.anything(),
            ROW.id,
            reason === 'stall' ? 'encode_stalled' : 'encode_failed',
            expect.stringMatching(/^pod-1:/),
        );
    });

    it('still kills a stalled child while a progress heartbeat is blocked on the database', async () => {
        const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            kill: vi.fn(() => {
                child.emit('close', null);
                return true;
            }),
        });
        h.spawn.mockReturnValue(child);
        h.progress.mockImplementation(() => new Promise(() => {}));
        const { requestRendition } = await import('./service.js');
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
        await requestRendition({
            sql: {} as never,
            fileId: 'file-1',
            mediaItemId: 'item-1',
            rungId: '720p',
            audioIndex: null,
            inputPath: REAL_MEDIA,
            durationMs: null,
            isHdr: false,
        });
        await vi.waitFor(() => expect(h.spawn).toHaveBeenCalled());
        try {
            child.stdout.emit('data', Buffer.from('out_time_us=1000000\n'));
            await vi.advanceTimersByTimeAsync(15000);
            await vi.waitFor(() => expect(h.progress).toHaveBeenCalled());
            await vi.advanceTimersByTimeAsync(615000);
            await vi.waitFor(() => expect(child.kill).toHaveBeenCalledTimes(1));
        } finally {
            child.emit('close', 1);
            vi.useRealTimers();
            await vi.waitFor(() => expect(h.markFailed).toHaveBeenCalled());
        }
    });

    it('heartbeats unknown-duration encodes when only the partial file grows or its mtime advances', async () => {
        const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
        });
        h.spawn.mockReturnValue(child);
        const { requestRendition } = await import('./service.js');
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
        await requestRendition({
            sql: {} as never,
            fileId: 'file-1',
            mediaItemId: 'item-1',
            rungId: '720p',
            audioIndex: null,
            inputPath: REAL_MEDIA,
            durationMs: null,
            isHdr: false,
        });
        await vi.waitFor(() => expect(h.spawn).toHaveBeenCalled());
        const args = h.spawn.mock.calls[0][1];
        const partial = args[args.length - 1];
        try {
            await writeFile(partial, 'first bytes');
            await vi.advanceTimersByTimeAsync(15000);
            await vi.waitFor(() => expect(h.progress).toHaveBeenCalledTimes(1));
            await utimes(partial, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
            await vi.advanceTimersByTimeAsync(15000);
            await vi.waitFor(() => expect(h.progress).toHaveBeenCalledTimes(2));
        } finally {
            child.emit('close', 1);
            vi.useRealTimers();
            await vi.waitFor(() => expect(h.markFailed).toHaveBeenCalled());
        }
    });

    it('names the attempt from its owner token and removes takeover artifacts', async () => {
        const { artifactNameFor } = await import('./service.js');
        const oldToken = 'old-pod:dddddddd-dddd-4ddd-8ddd-dddddddddddd';
        await mkdir(h.cfg.DOWNLOAD_RENDITION_CACHE_DIR);
        const oldFinal = join(
            h.cfg.DOWNLOAD_RENDITION_CACHE_DIR,
            artifactNameFor(ROW.id, oldToken),
        );
        await writeFile(oldFinal, 'old');
        await writeFile(oldFinal + '.partial', 'old-partial');
        h.elect.mockResolvedValue({
            row: { ...ROW, status: 'encoding', owner_pod: oldToken },
            elected: false,
        });
        await request(REAL_MEDIA);
        const token = h.markEncoding.mock.calls[0][2];
        expect(h.markReady.mock.calls[0][2]).toBe(artifactNameFor(ROW.id, token));
        await expect(access(oldFinal)).rejects.toThrow();
        await expect(access(oldFinal + '.partial')).rejects.toThrow();
    });

    it('sweeps old unreferenced cache files below the byte cap, preserving ready, fresh and young files', async () => {
        const { artifactNameFor, reapToCap } = await import('./service.js');
        await mkdir(h.cfg.DOWNLOAD_RENDITION_CACHE_DIR);
        const names = [
            `${ROW.id}.mp4.partial`,
            'young.mp4.partial',
            artifactNameFor(ROW.id, 'ready'),
            artifactNameFor(ROW.id, 'old-attempt'),
            artifactNameFor('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'live') + '.partial',
        ];
        const paths = names.map((n) => join(h.cfg.DOWNLOAD_RENDITION_CACHE_DIR, n));
        for (let i = 0; i < paths.length; i++) {
            await writeFile(paths[i], 'bytes');
            if (i !== 1) await utimes(paths[i], new Date(0), new Date(0));
        }
        h.getRow.mockImplementation(async (_sql, id) =>
            id === ROW.id
                ? { ...ROW, status: 'ready', artifact_name: names[2] }
                : { ...ROW, id, status: 'encoding', heartbeat_at: new Date() },
        );
        await reapToCap({} as never);
        for (const i of [0, 3]) await expect(access(paths[i])).rejects.toThrow();
        for (const i of [1, 2, 4]) await expect(access(paths[i])).resolves.toBeUndefined();
    });
});

const HARDWARE = {
    encoder: 'h264_qsv',
    initArgs: [],
    needsHwUpload: false,
    preset: 'veryfast',
    pixFmt: 'nv12',
};
const PARAMS = {
    sql: {} as never,
    fileId: 'file-1',
    mediaItemId: 'item-1',
    rungId: '720p',
    audioIndex: null,
    inputPath: REAL_MEDIA,
    durationMs: null,
    isHdr: false,
};
function stalledChild() {
    const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(() => {
            child.emit('close', null);
            return true;
        }),
    });
    return child;
}

describe('cleanup ownership and encoder recovery', () => {
    it('leaves old unrelated files alone while collecting all owned filename generations', async () => {
        const { artifactNameFor, reapToCap } = await import('./service.js');
        await mkdir(h.cfg.DOWNLOAD_RENDITION_CACHE_DIR);
        const owned = [
            artifactNameFor(ROW.id, 'orphan'),
            `${ROW.id}.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4`,
            `${ROW.id}.mp4`,
        ];
        const unrelated = [
            'backup.mp4',
            `${ROW.id}.notes`,
            `${ROW.id}.${'a'.repeat(63)}.mp4`,
            `${ROW.id}.${'g'.repeat(64)}.mp4`,
            `${ROW.id}.mp4.bak`,
        ];
        h.getRow.mockResolvedValue(null);
        for (const name of [...owned.flatMap((n) => [n, n + '.partial']), ...unrelated]) {
            const path = join(h.cfg.DOWNLOAD_RENDITION_CACHE_DIR, name);
            await writeFile(path, 'old');
            await utimes(path, new Date(0), new Date(0));
        }
        await reapToCap({} as never);
        for (const name of unrelated)
            await expect(
                access(join(h.cfg.DOWNLOAD_RENDITION_CACHE_DIR, name)),
            ).resolves.toBeUndefined();
        for (const name of owned.flatMap((n) => [n, n + '.partial']))
            await expect(access(join(h.cfg.DOWNLOAD_RENDITION_CACHE_DIR, name))).rejects.toThrow();
    });

    it('does not sweep a custom directory when renditions are disabled', async () => {
        const { artifactNameFor, reapToCap } = await import('./service.js');
        await mkdir(h.cfg.DOWNLOAD_RENDITION_CACHE_DIR);
        const path = join(h.cfg.DOWNLOAD_RENDITION_CACHE_DIR, artifactNameFor(ROW.id, 'orphan'));
        await writeFile(path, 'old');
        await utimes(path, new Date(0), new Date(0));
        h.getRow.mockResolvedValue(null);
        h.cfg.FEATURE_DOWNLOAD_RENDITIONS = false;
        await reapToCap({} as never);
        await expect(access(path)).resolves.toBeUndefined();
    });

    it('still sweeps the dedicated default cache when renditions are disabled', async () => {
        const { artifactNameFor, reapToCap } = await import('./service.js');
        h.cfg.FEATURE_DOWNLOAD_RENDITIONS = false;
        h.cfg.DOWNLOAD_RENDITION_CACHE_DIR = '/config/cache/download-renditions';
        const name = artifactNameFor(ROW.id, 'orphan');
        vi.spyOn(fs, 'readdir').mockResolvedValue([{ name, isFile: () => true }] as never);
        vi.spyOn(fs, 'lstat').mockResolvedValue({ isFile: () => true, mtimeMs: 0 } as never);
        const remove = vi.spyOn(fs, 'rm').mockResolvedValue(undefined);
        h.getRow.mockResolvedValue(null);
        await reapToCap({} as never);
        expect(remove).toHaveBeenCalledWith(join(h.cfg.DOWNLOAD_RENDITION_CACHE_DIR, name), {
            force: true,
        });
    });

    it('keeps cap eviction running when the orphan sweep fails', async () => {
        const { artifactNameFor, reapToCap } = await import('./service.js');
        await mkdir(h.cfg.DOWNLOAD_RENDITION_CACHE_DIR);
        const path = join(h.cfg.DOWNLOAD_RENDITION_CACHE_DIR, artifactNameFor(ROW.id, 'orphan'));
        await writeFile(path, 'old');
        await utimes(path, new Date(0), new Date(0));
        h.getRow.mockRejectedValue(new Error('orphan lookup unavailable'));
        h.total.mockResolvedValue(20 * 1024 ** 3);
        h.candidates.mockResolvedValue([
            { id: ROW.id, artifact_name: null, size_bytes: String(20 * 1024 ** 3) },
        ]);
        await reapToCap({} as never);
        expect(h.deleteRow).toHaveBeenCalledWith(expect.anything(), ROW.id);
    });

    it.each([600, 1200])(
        'defers stale takeover until watchdog %s plus margin, even with an old stale setting',
        async (stallSeconds) => {
            h.cfg.DOWNLOAD_RENDITION_STALL_TIMEOUT_SECONDS = stallSeconds;
            const { requestRendition } = await import('./service.js');
            h.elect.mockResolvedValue({ row: { ...ROW, status: 'encoding' }, elected: false });
            h.reclaim.mockResolvedValue(false);
            await requestRendition(PARAMS);
            expect(h.reclaim.mock.calls[0][3]).toBeGreaterThanOrEqual(stallSeconds + 60);
        },
    );

    it('retries a stalled hardware encoder once on software', async () => {
        const child = stalledChild();
        h.plan.mockResolvedValue(HARDWARE);
        h.spawn.mockReturnValueOnce(child).mockImplementation(fakeFfmpeg);
        const { requestRendition } = await import('./service.js');
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
        await requestRendition(PARAMS);
        await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(1));
        try {
            await vi.advanceTimersByTimeAsync(615000);
            await vi.waitFor(() => expect(h.markReady).toHaveBeenCalled());
            expect(child.kill).toHaveBeenCalledTimes(1);
            expect(h.spawn).toHaveBeenCalledTimes(2);
            expect(h.spawn.mock.calls[1][1]).toContain('libx264');
            expect(h.markFailed).not.toHaveBeenCalled();
        } finally {
            child.emit('close', 1);
            vi.useRealTimers();
            await vi.waitFor(() =>
                expect(h.markReady.mock.calls.length + h.markFailed.mock.calls.length).toBe(1),
            );
        }
    });

    it('does not retry a superseded hardware encoder on software', async () => {
        const child = stalledChild();
        h.plan.mockResolvedValue(HARDWARE);
        h.spawn.mockReturnValue(child);
        h.progress.mockResolvedValue(false);
        const { requestRendition } = await import('./service.js');
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
        await requestRendition(PARAMS);
        await vi.waitFor(() => expect(h.spawn).toHaveBeenCalled());
        try {
            child.stdout.emit('data', Buffer.from('out_time_us=1000000\n'));
            await vi.advanceTimersByTimeAsync(15000);
            await vi.waitFor(() => expect(h.markFailed).toHaveBeenCalled());
            expect(h.spawn).toHaveBeenCalledTimes(1);
        } finally {
            child.emit('close', 1);
            vi.useRealTimers();
        }
    });

    it('continues software fallback through a failed progress reset', async () => {
        h.plan.mockResolvedValue(HARDWARE);
        h.spawn
            .mockImplementationOnce(() => {
                const child = stalledChild();
                setTimeout(() => child.emit('close', 1), 0);
                return child;
            })
            .mockImplementation(fakeFfmpeg);
        h.progress.mockRejectedValueOnce(new Error('temporary database outage'));
        await request(REAL_MEDIA);
        expect(h.markReady).toHaveBeenCalled();
        expect(h.spawn).toHaveBeenCalledTimes(2);
    });

    it('kills a stalled child even when stat on the cache mount never resolves', async () => {
        const child = stalledChild();
        h.spawn.mockReturnValue(child);
        const stat = fs.stat.bind(fs);
        vi.spyOn(fs, 'stat').mockImplementation((...args: Parameters<typeof fs.stat>) =>
            String(args[0]).endsWith('.partial')
                ? new Promise<Awaited<ReturnType<typeof fs.stat>>>(() => {})
                : stat(...args),
        );
        const { requestRendition } = await import('./service.js');
        vi.useFakeTimers({
            toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
        });
        await requestRendition(PARAMS);
        await vi.waitFor(() => expect(h.spawn).toHaveBeenCalled());
        try {
            await vi.advanceTimersByTimeAsync(660000);
            await vi.waitFor(() => expect(child.kill).toHaveBeenCalledTimes(1));
        } finally {
            child.emit('close', 1);
            vi.useRealTimers();
            await vi.waitFor(() => expect(h.markFailed).toHaveBeenCalled());
        }
    });
});
