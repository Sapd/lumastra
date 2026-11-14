// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A client that cancels a progressive transcode must not make the next chunk
 * ffmpeg had already written throw. Prod (2026-10-07 22:12 UTC) logged three
 * `TypeError: Invalid state: Controller is already closed` from the stdout
 * 'data' listener when a Moonfin client dropped mid-download. The process guard
 * suppressed them, but each one is an uncaught exception from the event emitter.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockConfig, spawnMock } = vi.hoisted(() => ({
    mockConfig: {
        FFMPEG_PATH: 'ffmpeg',
        JELLYFIN_PROGRESSIVE_TRANSCODE_MAX_CONCURRENT: 4,
        FFMPEG_MAX_JOBS_PER_USER: 4,
        LUMASTRA_TRANSCODE_LOAD_SHED_RATIO: 0,
        VAAPI_DEVICE: '',
        QSV_DEVICE: '',
    },
    spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('$lib/server/config', () => ({ config: mockConfig }));
vi.mock('$lib/server/config.js', () => ({ config: mockConfig }));
vi.mock('$lib/server/services/transcoding/hardware-detection', () => ({
    hardwareDetection: { getBestEncoder: vi.fn(async () => null) },
}));
vi.mock('$lib/server/services/preview-admission.service', () => ({
    checkRealTranscodeLoadShed: () => ({ shed: false, loadRatio: 0, threshold: 0 }),
}));
vi.mock('$lib/server/services/music-transcode/source-guard', () => ({
    assertTranscodeSourceIsMedia: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/services/music-transcode/slot-wait', () => ({
    acquireWithWait: async (acquire: () => Promise<() => void>) => ({
        value: await acquire(),
        waitedMs: 0,
    }),
}));
vi.mock('$lib/server/utils/library-input-guard', () => ({
    guardLibraryInput: (args: string[]) => args,
}));
vi.mock('$lib/server/utils/media-format-whitelist', () => ({
    prepareMediaFormatWhitelist: () => undefined,
}));

const { activeProgressiveTranscodes, serveProgressiveTranscode } =
    await import('./progressive-transcode-runner');

class FakeFfmpeg extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = 4242;
    kill = vi.fn(() => true);
}

let child: FakeFfmpeg | undefined;

spawnMock.mockImplementation(() => {
    child = new FakeFfmpeg();
    return child;
});

afterEach(() => {
    // Finish the fake process so the slot the runner holds is released.
    child?.emit('close', null, 'SIGKILL');
    child = undefined;
    spawnMock.mockClear();
});

async function startStream() {
    const responsePromise = serveProgressiveTranscode({
        plan: {
            kind: 'transcode',
            container: 'mp4',
            video: { mode: 'copy', codec: 'h264' },
            audio: { mode: 'copy', index: 1, codec: 'aac' },
            startSeconds: 0,
        },
        inputPath: '/data/movies/Example (2020)/Example.mkv',
        request: new Request('http://localhost/j/Videos/x/stream'),
        itemId: 'item-1',
        username: 'leon',
        userId: 'user-1',
    });
    await vi.waitFor(() => expect(child).toBeDefined());
    const ffmpeg = child!;
    ffmpeg.stdout.write(Buffer.from('first-chunk'));
    const response = await responsePromise;
    const reader = response.body!.getReader();
    await reader.read();
    return { ffmpeg, reader };
}

describe('progressive transcode: client cancels mid-stream', () => {
    it('does not throw when ffmpeg emits a chunk after the client cancelled', async () => {
        const responsePromise = serveProgressiveTranscode({
            plan: {
                kind: 'transcode',
                container: 'mp4',
                video: { mode: 'copy', codec: 'h264' },
                audio: { mode: 'copy', index: 1, codec: 'aac' },
                startSeconds: 0,
            },
            inputPath: '/data/movies/Example (2020)/Example.mkv',
            request: new Request('http://localhost/j/Videos/x/stream'),
            itemId: 'item-1',
            username: 'leon',
            userId: 'user-1',
        });

        await vi.waitFor(() => expect(child).toBeDefined());
        const ffmpeg = child!;
        ffmpeg.stdout.write(Buffer.from('first-chunk'));

        const response = await responsePromise;
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();
        const first = await reader.read();
        expect(Buffer.from(first.value!).toString()).toBe('first-chunk');

        await reader.cancel();
        expect(ffmpeg.kill).toHaveBeenCalled();

        // Chunks already buffered on ffmpeg's stdout still arrive after cancel.
        expect(() => ffmpeg.stdout.emit('data', Buffer.from('late-chunk'))).not.toThrow();

        // ffmpeg exits after the SIGKILL; the slot must be released exactly here.
        expect(activeProgressiveTranscodes()).toBe(1);
        ffmpeg.emit('close', null, 'SIGKILL');
        expect(activeProgressiveTranscodes()).toBe(0);
    });

    it('destroys ffmpeg stdout on cancel so buffered chunks stop being emitted', async () => {
        const { ffmpeg, reader } = await startStream();
        await reader.cancel();
        expect(ffmpeg.stdout.destroyed).toBe(true);
        expect(ffmpeg.kill).toHaveBeenCalled();
    });

    it('survives stdout data after the controller was closed by a code-0 close', async () => {
        const uncaught = vi.fn();
        process.on('uncaughtException', uncaught);
        try {
            const { ffmpeg, reader } = await startStream();
            ffmpeg.emit('close', 0, null);
            expect(await reader.read()).toMatchObject({ done: true });
            expect(() => ffmpeg.stdout.emit('data', Buffer.from('late-chunk'))).not.toThrow();
            ffmpeg.stdout.write(Buffer.from('another'));
            await new Promise((resolve) => setImmediate(resolve));
            expect(uncaught).not.toHaveBeenCalled();
            // A guarded enqueue failure stops ffmpeg and detaches the pipe.
            expect(ffmpeg.kill).toHaveBeenCalled();
            expect(ffmpeg.stdout.destroyed).toBe(true);
        } finally {
            process.off('uncaughtException', uncaught);
        }
    });

    it('does not surface an uncaught exception when the PassThrough keeps writing after cancel', async () => {
        const uncaught = vi.fn();
        process.on('uncaughtException', uncaught);
        try {
            const { ffmpeg, reader } = await startStream();
            await reader.cancel();
            ffmpeg.stdout.write(Buffer.from('late-1'));
            ffmpeg.stdout.write(Buffer.from('late-2'));
            await new Promise((resolve) => setImmediate(resolve));
            expect(uncaught).not.toHaveBeenCalled();
        } finally {
            process.off('uncaughtException', uncaught);
        }
    });
});
