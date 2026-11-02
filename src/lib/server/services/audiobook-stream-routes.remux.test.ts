// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The remux route: what it refuses, what it spawns, and what it records.
 *
 * Three of these cases guard things that fail SILENTLY rather than loudly:
 *
 *  - a `HEAD` that spawns ffmpeg. SvelteKit answers HEAD by running the GET
 *    handler and the node adapter then throws the body away, so an unguarded HEAD
 *    is a free way to start encoders whose output nobody reads.
 *  - `Content-Length` / `Accept-Ranges: bytes` on a piped encode. Clients decide
 *    whether to attempt range requests from exactly those headers; advertising
 *    them produces broken seeks instead of an honest restart.
 *  - the job row never being written, which costs nothing visible at playback and
 *    makes the remux invisible in every admin transcode surface — the thing this
 *    work exists to prevent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockProxy = vi.hoisted(() => vi.fn());
const mockSessionById = vi.hoisted(() => vi.fn());
vi.mock('../database/queries/play-sessions.queries.js', () => ({
    getSessionById: mockSessionById,
}));
const mockAuth = vi.hoisted(() => ({
    authenticateAudiobookStream: vi.fn(),
    extractStreamToken: vi.fn(() => 'stream_abc'),
}));
const mockRemux = vi.hoisted(() => ({
    startAudiobookRemux: vi.fn(),
    // Typed to include null so a case can drive the concurrency-cap refusal.
    acquireAudiobookRemuxSlot: vi.fn<(userId: string) => (() => void) | null>(() => () => {}),
    AUDIOBOOK_REMUX_CONTENT_TYPE: 'audio/aac',
}));
const mockPersistence = vi.hoisted(() => ({
    recordAudiobookRemuxJob: vi.fn().mockResolvedValue(undefined),
    finalizeAudiobookRemuxJob: vi.fn().mockResolvedValue(undefined),
}));
const mockQueries = vi.hoisted(() => ({
    getAudiobookFileCodec: vi.fn().mockResolvedValue('eac3'),
}));

vi.mock('./audiobook-stream-auth.js', () => mockAuth);
vi.mock('./audiobook-remux.service.js', () => mockRemux);
vi.mock('./transcode-job-persistence.service.js', async (importOriginal) => ({
    // The job-id helper is the REAL one: these cases assert the exact id the
    // route pins its terminal write to, and a stub would let the two sides of
    // that contract drift while the test still passed.
    ...(await importOriginal<typeof import('./transcode-job-persistence.service.js')>()),
    getTranscodeJobPersistenceService: () => mockPersistence,
}));
vi.mock('../database/queries/audiobooks.queries.js', () => mockQueries);
vi.mock('../database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('../utils/client-ip.js', () => ({ getClientIpStrictFromRequest: () => '10.0.0.1' }));
vi.mock('../config.js', () => ({ config: { AUDIOURL: 'http://abs.example/' } }));
vi.mock('../utils/logger.js', () => ({
    Logger: { for: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));
// Imported by the module under test for the two sibling handlers.
vi.mock('./audiobook-byte-proxy.service.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./audiobook-byte-proxy.service.js')>()),
    proxyAudiobookBytes: mockProxy,
}));

const { handleAudiobookRemux, handleAudiobookHls, handleAudiobookFile } =
    await import('./audiobook-stream-routes.js');

const OK_AUTH = {
    ok: true as const,
    userId: '33333333-3333-4333-8333-333333333333',
    username: 'denis',
    mediaId: '22222222-2222-4222-8222-222222222222',
    absItemId: 'abs-item-1',
    absApiKey: 'abs-key',
    playSessionId: '11111111-1111-4111-8111-111111111111',
    playSessionDeviceId: 'lumastra-web',
};

function makeEvent(
    query = `PlaySessionId=${OK_AUTH.playSessionId}`,
    method: 'GET' | 'HEAD' = 'GET',
    ino = '1',
): RequestEvent {
    const url = new URL(
        `http://lumastra.test/api/v1/audiobooks/${OK_AUTH.mediaId}/remux/${ino}?${query}`,
    );
    return {
        params: { mediaId: OK_AUTH.mediaId, trackIndex: ino },
        url,
        request: new Request(url, { method }),
        getClientAddress: () => '10.0.0.1',
    } as unknown as RequestEvent;
}

function fakeStream(): { body: ReadableStream<Uint8Array>; pid: number; stop: () => void } {
    return {
        body: new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array([0xff, 0xf1]));
                controller.close();
            },
        }),
        pid: 4242,
        stop: vi.fn(),
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockSessionById.mockResolvedValue({
        id: OK_AUTH.playSessionId,
        user_id: OK_AUTH.userId,
        media_id: OK_AUTH.mediaId,
        source: 'audiobookshelf',
        source_session_id: 'abs-sess-1',
        status: 'ACTIVE',
        device_capabilities: { audiobookTracks: [{ index: 1, ino: '9001' }] },
    });
    mockAuth.authenticateAudiobookStream.mockResolvedValue(OK_AUTH);
    mockAuth.extractStreamToken.mockReturnValue('stream_abc');
    mockRemux.acquireAudiobookRemuxSlot.mockReturnValue(vi.fn());
    mockRemux.startAudiobookRemux.mockImplementation(() => fakeStream());
    mockQueries.getAudiobookFileCodec.mockResolvedValue('eac3');
    // `clearAllMocks` clears CALLS, not implementations, so a case that makes the
    // insert reject would otherwise poison every case after it. Restated here
    // rather than relied on from the hoisted defaults.
    mockPersistence.recordAudiobookRemuxJob.mockReset().mockResolvedValue(undefined);
    mockPersistence.finalizeAudiobookRemuxJob.mockReset().mockResolvedValue(undefined);
});

describe('handleAudiobookRemux — refusals', () => {
    it('requires the Lumastra session id and spawns nothing without it', async () => {
        const res = await handleAudiobookRemux(makeEvent(''));
        expect(res.status).toBe(400);
        expect(mockRemux.startAudiobookRemux).not.toHaveBeenCalled();
    });

    it('rejects a start offset that is not a usable number', async () => {
        for (const t of ['abc', '-1', 'NaN', '999999999']) {
            const res = await handleAudiobookRemux(
                makeEvent(`PlaySessionId=${OK_AUTH.playSessionId}&startPositionSeconds=${t}`),
            );
            expect(res.status, `startPositionSeconds=${t}`).toBe(400);
        }
        expect(mockRemux.startAudiobookRemux).not.toHaveBeenCalled();
    });

    it('treats an absent offset as the head of the file, not as invalid', async () => {
        const res = await handleAudiobookRemux(makeEvent(`PlaySessionId=${OK_AUTH.playSessionId}`));
        expect(res.status).toBe(200);
        expect(mockRemux.startAudiobookRemux.mock.calls[0][0].startSeconds).toBe(0);
    });

    it('passes an auth failure straight through', async () => {
        mockAuth.authenticateAudiobookStream.mockResolvedValue({
            ok: false,
            status: 401,
            reason: 'invalid_token',
        });
        const res = await handleAudiobookRemux(makeEvent());
        expect(res.status).toBe(401);
        expect(mockRemux.startAudiobookRemux).not.toHaveBeenCalled();
    });

    it('checks the ABS session PIN, not just the token', async () => {
        // The stream token pins the media id, not the session. Without the session
        // check a valid token could start encoders for a book nobody is listening
        // to, and the job row would have no session to attach to.
        await handleAudiobookRemux(makeEvent(`PlaySessionId=${OK_AUTH.playSessionId}`));
        expect(mockAuth.authenticateAudiobookStream).toHaveBeenCalledWith(
            expect.objectContaining({ absSessionId: 'abs-sess-1' }),
        );
    });

    it('answers 503 with Retry-After when the listener is at the concurrency cap', async () => {
        mockRemux.acquireAudiobookRemuxSlot.mockReturnValue(null);
        const res = await handleAudiobookRemux(makeEvent());
        expect(res.status).toBe(503);
        expect(res.headers.get('Retry-After')).toBe('2');
        expect(mockRemux.startAudiobookRemux).not.toHaveBeenCalled();
    });

    it('answers a HEAD without spawning ffmpeg', async () => {
        const res = await handleAudiobookRemux(
            makeEvent(`PlaySessionId=${OK_AUTH.playSessionId}`, 'HEAD'),
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('audio/aac');
        expect(res.headers.get('Accept-Ranges')).toBe('none');
        expect(mockRemux.startAudiobookRemux).not.toHaveBeenCalled();
        expect(mockPersistence.recordAudiobookRemuxJob).not.toHaveBeenCalled();
    });
});

describe('handleAudiobookRemux — the stream', () => {
    it('answers 200 with honest streaming headers', async () => {
        const res = await handleAudiobookRemux(makeEvent());
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('audio/aac');
        // Both would be lies: the length is unknown until the encode finishes and
        // there is no byte↔time map to serve a range from.
        expect(res.headers.get('Accept-Ranges')).toBe('none');
        expect(res.headers.get('Content-Length')).toBeNull();
        expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('points ffmpeg at the ABS file URL with the listener’s own key', async () => {
        await handleAudiobookRemux(
            makeEvent(`PlaySessionId=${OK_AUTH.playSessionId}&startPositionSeconds=90.5`),
        );
        expect(mockRemux.startAudiobookRemux.mock.calls[0][0]).toEqual({
            url: 'http://abs.example/api/items/abs-item-1/file/9001',
            apiKey: 'abs-key',
            startSeconds: 90.5,
        });
    });

    it('encodes a server-mapped inode that needs escaping', async () => {
        mockSessionById.mockResolvedValue({
            user_id: OK_AUTH.userId,
            media_id: OK_AUTH.mediaId,
            source: 'audiobookshelf',
            source_session_id: 'abs-sess-1',
            status: 'ACTIVE',
            device_capabilities: { audiobookTracks: [{ index: 1, ino: 'a/b' }] },
        });
        await handleAudiobookRemux(makeEvent());
        expect(mockRemux.startAudiobookRemux.mock.calls[0][0].url).toBe(
            'http://abs.example/api/items/abs-item-1/file/a%2Fb',
        );
    });
});

describe('handleAudiobookRemux — admin visibility', () => {
    it('registers the job against the play session that passed the pin check', async () => {
        await handleAudiobookRemux(
            makeEvent(`PlaySessionId=${OK_AUTH.playSessionId}&startPositionSeconds=12`),
        );
        expect(mockPersistence.recordAudiobookRemuxJob).toHaveBeenCalledWith({
            playSessionId: OK_AUTH.playSessionId,
            mediaId: OK_AUTH.mediaId,
            userId: OK_AUTH.userId,
            deviceId: 'lumastra-web',
            ino: '9001',
            absItemId: 'abs-item-1',
            sourceCodec: 'eac3',
            startSeconds: 12,
            ffmpegPid: 4242,
        });
    });

    it('takes the source codec from the PERSISTED value, never from the query', async () => {
        // What is inside the container is a property of the file; a query
        // parameter is a property of whoever sent the request.
        mockQueries.getAudiobookFileCodec.mockResolvedValue('eac3');
        await handleAudiobookRemux(makeEvent(`PlaySessionId=${OK_AUTH.playSessionId}&codec=mp3`));
        expect(mockPersistence.recordAudiobookRemuxJob.mock.calls[0][0].sourceCodec).toBe('eac3');
        expect(mockQueries.getAudiobookFileCodec).toHaveBeenCalledWith(
            expect.anything(),
            OK_AUTH.mediaId,
            '9001',
        );
    });

    it("records 'unknown' rather than failing when the sweep has no codec for the file", async () => {
        mockQueries.getAudiobookFileCodec.mockResolvedValue(null);
        const res = await handleAudiobookRemux(makeEvent());
        expect(res.status).toBe(200);
        expect(mockPersistence.recordAudiobookRemuxJob.mock.calls[0][0].sourceCodec).toBe(
            'unknown',
        );
    });

    it('keeps streaming when the codec lookup throws', async () => {
        mockQueries.getAudiobookFileCodec.mockRejectedValue(new Error('db down'));
        const res = await handleAudiobookRemux(makeEvent());
        expect(res.status).toBe(200);
        expect(mockPersistence.recordAudiobookRemuxJob.mock.calls[0][0].sourceCodec).toBe(
            'unknown',
        );
    });

    it('marks the job stopped — not errored — when ffmpeg was killed for us', async () => {
        await handleAudiobookRemux(
            makeEvent(`PlaySessionId=${OK_AUTH.playSessionId}&startPositionSeconds=12`),
        );
        const onExit = mockRemux.startAudiobookRemux.mock.calls[0][1].onExit;
        onExit({ ok: true, code: 255 });
        expect(mockPersistence.finalizeAudiobookRemuxJob).toHaveBeenCalledWith(
            OK_AUTH.playSessionId,
            // The job id PINS the terminal write to this encoder. A seek has
            // already replaced the row by the time a superseded ffmpeg exits, so
            // without it the new stream is marked stopped while it is playing.
            { ok: true, code: 255, jobId: 'audiobook-remux-9001-t12' },
        );
    });

    it('marks the job errored on a real encode failure', async () => {
        await handleAudiobookRemux(makeEvent());
        const onExit = mockRemux.startAudiobookRemux.mock.calls[0][1].onExit;
        onExit({ ok: false, code: 1, error: 'boom' });
        expect(mockPersistence.finalizeAudiobookRemuxJob).toHaveBeenCalledWith(
            OK_AUTH.playSessionId,
            { ok: false, code: 1, error: 'boom', jobId: 'audiobook-remux-9001-t0' },
        );
    });

    it('releases the concurrency slot when the process ends', async () => {
        const release = vi.fn();
        mockRemux.acquireAudiobookRemuxSlot.mockReturnValue(release);
        await handleAudiobookRemux(makeEvent());
        mockRemux.startAudiobookRemux.mock.calls[0][1].onExit({ ok: true, code: 0 });
        expect(release).toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // The exit that arrives before the row it describes
    //
    // The spawn happens first and the INSERT is two awaits later, so a spawn
    // failure (ENOENT/EACCES on FFMPEG_PATH — `proc.on('error')` settles on the
    // NEXT TICK) or a fast upstream refusal lands in between. Finalising then hit
    // an UPDATE that matched nothing, the discarded row count hid it, and the
    // INSERT afterwards wrote `status: 'running'` with a live pid for a dead
    // process — a row only the expired-job sweep ever clears.
    // -----------------------------------------------------------------------

    /**
     * Records the ORDER of the two persistence writes. Order is the whole
     * defect: pre-fix, an exit delivered during the spawn finalized straight
     * away, so the UPDATE ran before the INSERT it was meant to update.
     * Asserting only "finalize was called" passes in both worlds and proves
     * nothing.
     */
    function trackWriteOrder(): string[] {
        const order: string[] = [];
        mockPersistence.recordAudiobookRemuxJob.mockImplementation(async () => {
            order.push('insert');
        });
        mockPersistence.finalizeAudiobookRemuxJob.mockImplementation(async () => {
            order.push('finalize');
        });
        return order;
    }

    /** ffmpeg dies inside the spawn call, i.e. strictly before the route's INSERT. */
    function exitDuringSpawn(result: { ok: boolean; code: number | null; error?: string }): void {
        mockRemux.startAudiobookRemux.mockImplementation(
            (_source: unknown, options: { onExit: (r: unknown) => void }) => {
                options.onExit(result);
                return fakeStream();
            },
        );
    }

    it('holds an exit that fired during the spawn until the row exists', async () => {
        const order = trackWriteOrder();
        // The measured spawn-failure shape: `proc.on('error')` for ENOENT/EACCES
        // on FFMPEG_PATH settles a tick after the call, with no exit code.
        exitDuringSpawn({ ok: false, code: null, error: 'spawn ENOENT' });

        await handleAudiobookRemux(
            makeEvent(`PlaySessionId=${OK_AUTH.playSessionId}&startPositionSeconds=12`),
        );

        expect(order).toEqual(['insert', 'finalize']);
        expect(mockPersistence.finalizeAudiobookRemuxJob).toHaveBeenCalledWith(
            OK_AUTH.playSessionId,
            {
                ok: false,
                code: null,
                error: 'spawn ENOENT',
                jobId: 'audiobook-remux-9001-t12',
            },
        );
    });

    it('holds a fast upstream failure the same way', async () => {
        // Same window, different cause: ABS answering 401 makes ffmpeg exit long
        // before `readPersistedCodec` + the INSERT have resolved.
        const order = trackWriteOrder();
        exitDuringSpawn({ ok: false, code: 1, error: 'Server returned 401 Unauthorized' });

        await handleAudiobookRemux(makeEvent());

        expect(order).toEqual(['insert', 'finalize']);
    });

    it('applies a held exit even when the insert itself failed', async () => {
        // The UPDATE then matches zero rows, which is the correct no-op. Dropping
        // the exit is how a `running` row outlives its process — and finalizing
        // BEFORE the failed insert is how the pre-fix code did it.
        const order: string[] = [];
        mockPersistence.recordAudiobookRemuxJob.mockImplementation(async () => {
            order.push('insert-attempt');
            throw new Error('insert failed');
        });
        mockPersistence.finalizeAudiobookRemuxJob.mockImplementation(async () => {
            order.push('finalize');
        });
        exitDuringSpawn({ ok: false, code: 1, error: 'boom' });

        await expect(handleAudiobookRemux(makeEvent())).rejects.toThrow('insert failed');

        expect(order).toEqual(['insert-attempt', 'finalize']);
        expect(mockPersistence.finalizeAudiobookRemuxJob).toHaveBeenCalledWith(
            OK_AUTH.playSessionId,
            { ok: false, code: 1, error: 'boom', jobId: 'audiobook-remux-9001-t0' },
        );
    });

    it('does not replay a held exit on top of a later one', async () => {
        // Guards the hold-and-replay mechanism itself (not the original bug): the
        // ordinary case must still finalize exactly once.
        await handleAudiobookRemux(makeEvent());
        mockRemux.startAudiobookRemux.mock.calls[0][1].onExit({ ok: true, code: 0 });
        expect(mockPersistence.finalizeAudiobookRemuxJob).toHaveBeenCalledTimes(1);
    });

    it('forwards the request abort signal so a closed tab kills the encoder', async () => {
        await handleAudiobookRemux(makeEvent());
        expect(mockRemux.startAudiobookRemux.mock.calls[0][1].signal).toBeDefined();
    });

    it('releases the slot and answers 500 when the spawn itself throws', async () => {
        const release = vi.fn();
        mockRemux.acquireAudiobookRemuxSlot.mockReturnValue(release);
        mockRemux.startAudiobookRemux.mockImplementation(() => {
            throw new Error('bad argv');
        });
        const res = await handleAudiobookRemux(makeEvent());
        expect(res.status).toBe(500);
        expect(release).toHaveBeenCalled();
        expect(mockPersistence.recordAudiobookRemuxJob).not.toHaveBeenCalled();
    });
});

describe('audiobook HLS grant propagation', () => {
    function hlsEvent(file = 'output.m3u8'): RequestEvent {
        const url = new URL(
            `http://lumastra.test/api/v1/audiobook/${OK_AUTH.mediaId}/hls/playback/${OK_AUTH.playSessionId}/${file}?grant=secret&PlaySessionId=${OK_AUTH.playSessionId}`,
        );
        return {
            params: {
                mediaId: OK_AUTH.mediaId,
                token: 'playback',
                sessionId: OK_AUTH.playSessionId,
                file,
            },
            url,
            request: new Request(url),
            locals: {},
            getClientAddress: () => '10.0.0.1',
        } as unknown as RequestEvent;
    }
    it('rewrites segment lines and init URI attributes with grant and playback binding', async () => {
        mockProxy.mockResolvedValue(
            new Response('#EXTM3U\n#EXT-X-MAP:URI="output-0.mp4"\n#EXTINF:6,\noutput-1.ts\n', {
                headers: {
                    'content-length': '100',
                    'content-type': 'application/vnd.apple.mpegurl',
                },
            }),
        );
        const response = await handleAudiobookHls(hlsEvent());
        expect(response.status).toBe(200);
        expect(response.headers.has('content-length')).toBe(false);
        const body = await response.text();
        const uris = [...body.matchAll(/URI="([^"]+)"/g)].map((match) => match[1]);
        uris.push(...body.split('\n').filter((line) => line && !line.startsWith('#')));
        expect(uris).toHaveLength(2);
        for (const uri of uris) {
            const child = new URL(uri, 'http://lumastra.test');
            expect(child.searchParams.get('grant')).toBe('secret');
            expect(child.searchParams.get('PlaySessionId')).toBe(OK_AUTH.playSessionId);
            expect(child.searchParams.has('api_key')).toBe(false);
            expect(child.searchParams.has('stream_token')).toBe(false);
        }
    });
    it('passes segment bytes through without rewriting', async () => {
        const bytes = new Response(new Uint8Array([1, 2, 3]));
        mockProxy.mockResolvedValue(bytes);
        expect(await handleAudiobookHls(hlsEvent('output-1.ts'))).toBe(bytes);
    });
    it('refuses to attach the grant to an external manifest URI', async () => {
        mockProxy.mockResolvedValue(new Response('#EXTM3U\nhttps://upstream.invalid/stolen.ts\n'));
        const response = await handleAudiobookHls(hlsEvent());
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('#EXTM3U\nhttps://upstream.invalid/stolen.ts\n');
    });
});

describe('audiobook public playback addresses', () => {
    beforeEach(() => {
        mockSessionById.mockResolvedValue({
            id: OK_AUTH.playSessionId,
            user_id: OK_AUTH.userId,
            media_id: OK_AUTH.mediaId,
            source: 'audiobookshelf',
            source_session_id: 'private-abs-session',
            status: 'ACTIVE',
            device_capabilities: { audiobookTracks: [{ index: 1, ino: 'private-inode' }] },
        });
    });

    it('resolves a public file index behind the authenticated playback session', async () => {
        const event = makeEvent(
            `PlaySessionId=${OK_AUTH.playSessionId}&grant=stream_abc`,
            'GET',
            '1',
        );
        event.url.pathname = `/api/v1/audiobooks/${OK_AUTH.mediaId}/files/1`;
        mockProxy.mockResolvedValue(new Response('bytes'));
        expect((await handleAudiobookFile(event)).status).toBe(200);
        expect(mockProxy).toHaveBeenCalledWith(
            expect.objectContaining({
                upstreamPath: `/api/items/${OK_AUTH.absItemId}/file/private-inode`,
            }),
            expect.anything(),
            expect.anything(),
        );
        expect(mockAuth.authenticateAudiobookStream).toHaveBeenCalledWith(
            expect.objectContaining({ absSessionId: 'private-abs-session' }),
        );
    });

    it('resolves a remux track without exposing the upstream session or inode', async () => {
        const response = await handleAudiobookRemux(
            makeEvent(`PlaySessionId=${OK_AUTH.playSessionId}&grant=stream_abc`, 'GET', '1'),
        );
        expect(response.status).toBe(200);
        expect(mockAuth.authenticateAudiobookStream).toHaveBeenCalledWith(
            expect.objectContaining({ absSessionId: 'private-abs-session' }),
        );
        expect(mockQueries.getAudiobookFileCodec).toHaveBeenCalledWith(
            expect.anything(),
            OK_AUTH.mediaId,
            'private-inode',
        );
    });

    it('rejects a playback row belonging to another listener before sending file bytes', async () => {
        mockSessionById.mockResolvedValue({
            user_id: 'other-user',
            media_id: OK_AUTH.mediaId,
            source: 'audiobookshelf',
            source_session_id: 'other-abs',
            status: 'ACTIVE',
            device_capabilities: { audiobookTracks: [{ index: 1, ino: 'secret' }] },
        });
        const response = await handleAudiobookFile(
            makeEvent(`PlaySessionId=${OK_AUTH.playSessionId}`, 'GET', '1'),
        );
        expect(response.status).toBe(404);
        expect(mockProxy).not.toHaveBeenCalled();
    });

    it('uses the public session id in HLS children and keeps the upstream id server-side', async () => {
        const url = new URL(
            `https://lumastra.test/api/v1/audiobook/${OK_AUTH.mediaId}/hls/playback/${OK_AUTH.playSessionId}/output.m3u8?grant=stream_abc&PlaySessionId=${OK_AUTH.playSessionId}`,
        );
        const event = {
            url,
            request: new Request(url),
            params: {
                mediaId: OK_AUTH.mediaId,
                token: 'playback',
                sessionId: OK_AUTH.playSessionId,
                file: 'output.m3u8',
            },
            getClientAddress: () => '10.0.0.1',
            locals: {},
        } as unknown as RequestEvent;
        mockProxy.mockResolvedValue(
            new Response('#EXTM3U\n/hls/private-abs-session/output-0.ts\noutput-1.ts\n'),
        );
        const response = await handleAudiobookHls(event);
        const playlist = await response.text();
        expect(response.status).toBe(200);
        expect(mockProxy).toHaveBeenCalledWith(
            expect.objectContaining({ upstreamPath: '/hls/private-abs-session/output.m3u8' }),
            expect.anything(),
            expect.anything(),
        );
        expect(playlist).not.toMatch(/private-abs-session|api_key|stream_token/);
        for (const line of playlist.split('\n').filter((line) => line && !line.startsWith('#'))) {
            const child = new URL(line, url);
            expect(child.pathname).toContain(`/hls/playback/${OK_AUTH.playSessionId}/`);
            expect(child.searchParams.get('grant')).toBe('stream_abc');
            expect(child.searchParams.get('PlaySessionId')).toBe(OK_AUTH.playSessionId);
        }
    });
});

it('does not fall back to a legacy ABS session when PlaySessionId is invalid', async () => {
    mockSessionById.mockResolvedValue(null);
    const response = await handleAudiobookRemux(
        makeEvent('PlaySessionId=missing&session=abs-sess-1'),
    );
    expect(response.status).toBe(400);
    expect(mockAuth.authenticateAudiobookStream).not.toHaveBeenCalled();
    expect(mockRemux.startAudiobookRemux).not.toHaveBeenCalled();
});

it.each(['missing', 'terminal', 'foreign'] as const)(
    'rejects a %s public session',
    async (state) => {
        mockSessionById.mockResolvedValue(
            state === 'missing'
                ? null
                : {
                      media_id: OK_AUTH.mediaId,
                      source: 'audiobookshelf',
                      source_session_id: 'abs-sess-1',
                      status: state === 'terminal' ? 'COMPLETED' : 'ACTIVE',
                      user_id: state === 'foreign' ? 'another-user' : OK_AUTH.userId,
                  },
        );
        const response = await handleAudiobookRemux(
            makeEvent(`PlaySessionId=${OK_AUTH.playSessionId}`),
        );
        expect(response.status).toBe(404);
        expect(mockRemux.startAudiobookRemux).not.toHaveBeenCalled();
    },
);

it('requires a media scope for authenticated audiobook accounts', async () => {
    const url = new URL(
        `https://app.test/api/v1/audiobooks/${OK_AUTH.mediaId}/files/1?PlaySessionId=${OK_AUTH.playSessionId}`,
    );
    const event = {
        url,
        request: new Request(url),
        params: { mediaId: OK_AUTH.mediaId, trackIndex: '1' },
        locals: {
            authMethod: 'pat',
            user: { userId: OK_AUTH.userId, username: 'listener' },
            principal: { scopes: ['profile:read'] },
        },
        getClientAddress: () => '10.0.0.1',
    } as unknown as RequestEvent;
    expect((await handleAudiobookFile(event)).status).toBe(403);
    expect(mockAuth.authenticateAudiobookStream).not.toHaveBeenCalled();
});

it('passes the forward-auth live user into audiobook grant validation', async () => {
    const url = new URL(
        `https://app.test/api/v1/audiobooks/${OK_AUTH.mediaId}/files/1?grant=stream_abc&PlaySessionId=${OK_AUTH.playSessionId}`,
    );
    const user = { userId: OK_AUTH.userId, username: 'listener', userGroups: ['current'] };
    const event = {
        url,
        request: new Request(url),
        params: { mediaId: OK_AUTH.mediaId, trackIndex: '1' },
        locals: { authMethod: 'stream_token', user },
        getClientAddress: () => '10.0.0.1',
    } as unknown as RequestEvent;
    mockProxy.mockResolvedValue(new Response('bytes'));
    await handleAudiobookFile(event);
    expect(mockAuth.authenticateAudiobookStream).toHaveBeenCalledWith(
        expect.objectContaining({
            liveUser: user,
            authenticatedUser: undefined,
            playbackSessionId: OK_AUTH.playSessionId,
        }),
    );
});

it('returns a problem when a database read fails before byte delivery', async () => {
    mockSessionById.mockRejectedValue(new Error('private database detail'));
    const response = await handleAudiobookFile(makeEvent());
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(await response.text()).not.toContain('private database detail');
});
