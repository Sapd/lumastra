// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The argv is asserted POSITIONALLY, not by "contains".
 *
 * Every mistake available in this argv is invisible to a test that only checks
 * that bytes arrived, and two of them are silent rather than loud:
 *
 *  - `-ss` after `-i` still works — it just decodes and discards from byte 0.
 *    Measured on a real 266 MB file: 8.56 s wall / 2.74 s CPU per seek instead of
 *    0.85 s / 0.19 s, and the whole file pulled from AudiobookShelf every time.
 *  - a dropped `-vn` hands the ADTS muxer an embedded cover-art video stream.
 *
 * The exit-classification tests exist because a client that stops listening makes
 * us SIGTERM ffmpeg, which then exits **255** (`Immediate exit requested`,
 * measured) — recording that as an error would paint every pause red in the admin
 * transcode surface.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const mockConfig = vi.hoisted(() => ({
    FFMPEG_PATH: '/usr/bin/ffmpeg',
    AUDIOBOOK_REMUX_MAX_PER_USER: 2,
}));
vi.mock('../config.js', () => ({ config: mockConfig }));
const mockGetMediaFormatWhitelist = vi.hoisted(() =>
    vi.fn<(ffmpegPath?: string) => string | null>(),
);
vi.mock('../utils/media-format-whitelist.js', () => ({
    getMediaFormatWhitelist: (ffmpegPath?: string) => mockGetMediaFormatWhitelist(ffmpegPath),
}));
vi.mock('../utils/logger.js', () => ({
    Logger: { for: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

const {
    acquireAudiobookRemuxSlot,
    AUDIOBOOK_REMUX_CONTENT_TYPE,
    AUDIOBOOK_REMUX_OUTPUT_DIR,
    buildAudiobookRemuxArgs,
    startAudiobookRemux,
    _resetAudiobookRemuxSlots,
} = await import('./audiobook-remux.service.js');

const SOURCE = {
    url: 'http://abs.example/api/items/item-1/file/9001',
    apiKey: 'abs-key',
    startSeconds: 0,
};

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

describe('buildAudiobookRemuxArgs', () => {
    it('puts -ss BEFORE -i so ffmpeg seeks the input over HTTP Range', () => {
        const args = buildAudiobookRemuxArgs({ ...SOURCE, startSeconds: 1800 });
        const ss = args.indexOf('-ss');
        const i = args.indexOf('-i');
        expect(ss).toBeGreaterThan(-1);
        expect(args[ss + 1]).toBe('1800');
        expect(ss).toBeLessThan(i);
    });

    it('omits -ss entirely at the head of a file', () => {
        expect(buildAudiobookRemuxArgs({ ...SOURCE, startSeconds: 0 })).not.toContain('-ss');
    });

    it('sends the credential as a CRLF-terminated Authorization header', () => {
        const args = buildAudiobookRemuxArgs(SOURCE);
        const at = args.indexOf('-headers');
        expect(at).toBeGreaterThan(-1);
        // A bare \n is tolerated by some ffmpeg builds and not others.
        expect(args[at + 1]).toBe('Authorization: Bearer abs-key\r\n');
        expect(at).toBeLessThan(args.indexOf('-i'));
    });

    it('drops video and maps exactly the first audio stream', () => {
        const args = buildAudiobookRemuxArgs(SOURCE);
        expect(args).toContain('-vn');
        const map = args.indexOf('-map');
        expect(args[map + 1]).toBe('0:a:0');
    });

    it('encodes to stereo AAC in ADTS on stdout', () => {
        const args = buildAudiobookRemuxArgs(SOURCE);
        const codec = args.indexOf('-c:a');
        // Never libfdk_aac: jellyfin-ffmpeg (the production binary) has no fdk.
        expect(args[codec + 1]).toBe('aac');
        expect(args[args.indexOf('-b:a') + 1]).toBe('128k');
        expect(args[args.indexOf('-ac') + 1]).toBe('2');
        expect(args[args.indexOf('-f') + 1]).toBe('adts');
        expect(args[args.length - 1]).toBe('pipe:1');
    });

    it('asks the http reader to reconnect, because a book is a long read', () => {
        const args = buildAudiobookRemuxArgs(SOURCE);
        expect(args[args.indexOf('-reconnect') + 1]).toBe('1');
        expect(args.indexOf('-reconnect')).toBeLessThan(args.indexOf('-i'));
    });

    it('restricts the INPUT demuxer to audio containers, so no manifest demuxer is ever chosen', () => {
        // A manifest body (DASH/IMF are detected by content alone) would have
        // ffmpeg fetch its segments from any host with the listener's
        // Authorization header — see audiobook-remux.format-whitelist.integration.test.ts.
        const args = buildAudiobookRemuxArgs(SOURCE);
        const at = args.indexOf('-format_whitelist');
        expect(at).toBeGreaterThan(-1);
        expect(at).toBeLessThan(args.indexOf('-i'));
        const allowed = args[at + 1].split(',');
        expect(allowed).toEqual(expect.arrayContaining(['mov', 'matroska', 'mp3', 'asf', 'amr']));
        for (const manifest of ['hls', 'dash', 'imf', 'concat']) {
            expect(allowed).not.toContain(manifest);
        }
    });

    it('rejects a start offset that is not a usable number', () => {
        for (const startSeconds of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => buildAudiobookRemuxArgs({ ...SOURCE, startSeconds })).toThrow(
                /Invalid remux startSeconds/,
            );
        }
    });

    it('serves audio/aac, the type both engines measured as playable', () => {
        expect(AUDIOBOOK_REMUX_CONTENT_TYPE).toBe('audio/aac');
    });
});

describe('startAudiobookRemux — input demuxer list', () => {
    function spawnedArgs(options: Parameters<typeof startAudiobookRemux>[1] = {}): {
        binary: string;
        args: string[];
    } {
        let captured: { binary: string; args: string[] } | undefined;
        startAudiobookRemux(SOURCE, {
            ...options,
            spawnImpl: ((binary: string, args: string[]) => {
                captured = { binary, args };
                return fakeProc();
            }) as unknown as NonNullable<Parameters<typeof startAudiobookRemux>[1]>['spawnImpl'],
        });
        return captured!;
    }

    function whitelistOf(args: string[]): string {
        const at = args.indexOf('-format_whitelist');
        expect(at).toBeGreaterThan(-1);
        expect(at).toBeLessThan(args.indexOf('-i'));
        return args[at + 1];
    }

    beforeEach(() => mockGetMediaFormatWhitelist.mockReset());

    it("uses the RUNNING binary's enumerated demuxers (minus the reference-following ones)", () => {
        mockGetMediaFormatWhitelist.mockReturnValue('mov,mp3,wv');

        const { binary, args } = spawnedArgs({ ffmpegPath: '/opt/ffmpeg/bin/ffmpeg' });

        expect(binary).toBe('/opt/ffmpeg/bin/ffmpeg');
        // Enumerated for the binary that will actually run, not config's.
        expect(mockGetMediaFormatWhitelist).toHaveBeenCalledWith('/opt/ffmpeg/bin/ffmpeg');
        expect(whitelistOf(args)).toBe('mov,mp3,wv');
    });

    it('falls back to the static audio-container list, never to NO list, when enumeration fails', () => {
        // No list would reopen the key leak; the static list is measured safe.
        mockGetMediaFormatWhitelist.mockReturnValue(null);

        const allowed = whitelistOf(spawnedArgs().args).split(',');

        expect(mockGetMediaFormatWhitelist).toHaveBeenCalledWith('/usr/bin/ffmpeg');
        expect(allowed).toEqual(expect.arrayContaining(['mov', 'matroska', 'mp3', 'asf', 'amr']));
        for (const manifest of ['hls', 'dash', 'imf', 'concat', 'sdp', 'sap']) {
            expect(allowed).not.toContain(manifest);
        }
    });
});

describe('AUDIOBOOK_REMUX_OUTPUT_DIR', () => {
    it('cannot be mistaken for a directory under the transcode root', () => {
        // The expired-job sweep recursively deletes output_dir for rows it reaps,
        // guarded ONLY by "is it inside FFMPEG_TRANSCODE_DIR". A sentinel that
        // resolved inside that root would be rm -rf'd; one that looked like a
        // real path would mislead the admin UI, which prints it verbatim.
        expect(AUDIOBOOK_REMUX_OUTPUT_DIR).toBe('(pipe)');
        expect(AUDIOBOOK_REMUX_OUTPUT_DIR.startsWith('/')).toBe(false);
        expect(AUDIOBOOK_REMUX_OUTPUT_DIR).not.toContain('/');
    });
});

// ---------------------------------------------------------------------------
// process lifecycle
// ---------------------------------------------------------------------------

interface FakeProc extends EventEmitter {
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    killed: boolean;
    kill: (signal?: string) => boolean;
}

function fakeProc(): FakeProc {
    const proc = new EventEmitter() as FakeProc;
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.pid = 4242;
    proc.killed = false;
    proc.kill = vi.fn(() => {
        proc.killed = true;
        return true;
    });
    return proc;
}

function startWithFake(options: Parameters<typeof startAudiobookRemux>[1] = {}): {
    proc: FakeProc;
    stream: ReturnType<typeof startAudiobookRemux>;
} {
    const proc = fakeProc();
    const stream = startAudiobookRemux(SOURCE, {
        ...options,
        spawnImpl: (() => proc) as unknown as NonNullable<
            Parameters<typeof startAudiobookRemux>[1]
        >['spawnImpl'],
    });
    return { proc, stream };
}

/**
 * Read the body to completion, as the HTTP layer does.
 *
 * NOT optional in these tests: a Node Readable nobody reads never emits `end`,
 * so a test that ends the fake stdout without draining leaves the service unable
 * to tell EOF from a cancellation — and then passes for the wrong reason. This
 * makes the tests exercise the same event order production does.
 */
function drain(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const pump = async (): Promise<void> => {
        for (;;) {
            const { done } = await reader.read();
            if (done) return;
        }
    };
    return pump();
}

/** Let queued microtasks and stream events settle. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('startAudiobookRemux — exit classification', () => {
    it('reports a clean exit as ok', async () => {
        const onExit = vi.fn();
        const { proc, stream } = startWithFake({ onExit });
        const drained = drain(stream.body);
        proc.stdout.end();
        await drained;
        proc.emit('close', 0);
        expect(onExit).toHaveBeenCalledWith({ ok: true, code: 0 });
        expect(proc.kill).not.toHaveBeenCalled();
    });

    it('reports a NON-ZERO exit as a failure — the pipe closing must not mask it', async () => {
        // ffmpeg closes stdout (EOF, so `end` fires) and THEN exits non-zero. An
        // implementation that treats "the pipe closed" as "we asked it to stop"
        // records every genuine encode failure as a clean stop.
        const onExit = vi.fn();
        const { proc, stream } = startWithFake({ onExit });
        proc.stderr.write('Invalid data found when processing input');
        const drained = drain(stream.body);
        proc.stdout.end();
        await drained;
        await settle();
        proc.emit('close', 1);
        expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: 1 }));
        expect(onExit.mock.calls[0][0].error).toContain('Invalid data');
    });

    it('reports OUR OWN kill as ok even though ffmpeg exits 255', () => {
        // Measured: SIGTERM produces exit 255 "Immediate exit requested". This is
        // the most ordinary event in the player's life (a pause, a seek, a closed
        // tab) and must not be an error row.
        const controller = new AbortController();
        const onExit = vi.fn();
        const { proc } = startWithFake({ onExit, signal: controller.signal });
        controller.abort();
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
        proc.emit('close', 255);
        expect(onExit).toHaveBeenCalledWith({ ok: true, code: 255 });
    });

    it('reports a spawn failure as a failure', () => {
        const onExit = vi.fn();
        const { proc } = startWithFake({ onExit });
        proc.emit('error', new Error('spawn ENOENT'));
        expect(onExit).toHaveBeenCalledWith(
            expect.objectContaining({ ok: false, code: null, error: 'spawn ENOENT' }),
        );
    });

    it('settles exactly once', async () => {
        const onExit = vi.fn();
        const { proc, stream } = startWithFake({ onExit });
        const drained = drain(stream.body);
        proc.stdout.end();
        await drained;
        proc.emit('close', 0);
        proc.emit('close', 0);
        proc.emit('error', new Error('late'));
        expect(onExit).toHaveBeenCalledTimes(1);
    });
});

describe('startAudiobookRemux — teardown', () => {
    it('kills ffmpeg when the consumer cancels the body', async () => {
        // A listener closing the tab mid-chapter. Without the kill, ffmpeg keeps
        // encoding into a pipe nobody drains for the rest of the book.
        const { proc, stream } = startWithFake();
        await stream.body.cancel();
        await settle();
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('kills ffmpeg when stdout is destroyed WITHOUT an error', async () => {
        // Cancelling a web stream destroys the Readable WITH an AbortError
        // (measured), so the error handler alone would appear to cover
        // cancellation. A destroy with no error — any other layer tearing the
        // response down — emits `close` and nothing else, and that is the case
        // this hook exists for. Without it ffmpeg keeps encoding into a pipe
        // nobody drains.
        const { proc } = startWithFake();
        proc.stdout.destroy();
        await settle();
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('does NOT kill on a normal end-of-stream', async () => {
        // `end` before `close` is EOF, not a cancellation — and it is the ONLY
        // thing separating "the tab went away" from "ffmpeg finished or failed on
        // its own", which is what the exit classification hangs on.
        const { proc, stream } = startWithFake();
        const drained = drain(stream.body);
        proc.stdout.end();
        await drained;
        await settle();
        expect(proc.kill).not.toHaveBeenCalled();
    });

    it('kills immediately when the request was already aborted', () => {
        const controller = new AbortController();
        controller.abort();
        const { proc } = startWithFake({ signal: controller.signal });
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('reports the pid so the job row can carry it', () => {
        const { stream } = startWithFake();
        expect(stream.pid).toBe(4242);
    });

    it('is idempotent on stop', () => {
        const { proc, stream } = startWithFake();
        stream.stop();
        stream.stop();
        expect(proc.kill).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// concurrency
// ---------------------------------------------------------------------------

describe('acquireAudiobookRemuxSlot', () => {
    beforeEach(() => {
        _resetAudiobookRemuxSlots();
        mockConfig.AUDIOBOOK_REMUX_MAX_PER_USER = 2;
    });
    afterEach(() => {
        _resetAudiobookRemuxSlots();
    });

    it('admits up to the cap and refuses beyond it', () => {
        expect(acquireAudiobookRemuxSlot('u1')).not.toBeNull();
        expect(acquireAudiobookRemuxSlot('u1')).not.toBeNull();
        expect(acquireAudiobookRemuxSlot('u1')).toBeNull();
    });

    it('caps per user, not globally', () => {
        acquireAudiobookRemuxSlot('u1');
        acquireAudiobookRemuxSlot('u1');
        expect(acquireAudiobookRemuxSlot('u2')).not.toBeNull();
    });

    it('frees a slot on release', () => {
        const a = acquireAudiobookRemuxSlot('u1');
        acquireAudiobookRemuxSlot('u1');
        expect(acquireAudiobookRemuxSlot('u1')).toBeNull();
        a?.();
        expect(acquireAudiobookRemuxSlot('u1')).not.toBeNull();
    });

    it('releases at most once, however many terminal events fire', () => {
        // ffmpeg close, body cancel and abort are all wired to the same release;
        // a double decrement would let the cap drift upward forever.
        const a = acquireAudiobookRemuxSlot('u1');
        acquireAudiobookRemuxSlot('u1');
        a?.();
        a?.();
        a?.();
        expect(acquireAudiobookRemuxSlot('u1')).not.toBeNull();
        expect(acquireAudiobookRemuxSlot('u1')).toBeNull();
    });

    it('disables the cap at 0', () => {
        mockConfig.AUDIOBOOK_REMUX_MAX_PER_USER = 0;
        for (let i = 0; i < 10; i++) expect(acquireAudiobookRemuxSlot('u1')).not.toBeNull();
    });
});
