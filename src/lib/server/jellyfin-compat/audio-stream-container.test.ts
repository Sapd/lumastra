// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /j/Audio/{itemId}/stream.{container} (route file; and the Static / token paths it
 * shares with /Audio/{itemId}/stream) — the playback gates: kick cooldown, the
 * music transcode switch, codec-implied direct matches, the bitrate cap, and
 * that the judged file is the one served. The real-file paths run in
 * audio-streaming.integration.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';

vi.mock('./middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

const fakeSql = {};
const mockGetDb = vi.fn();
vi.mock('$lib/server/database', () => ({ getDb: () => mockGetDb() }));
vi.mock('$lib/server/cache/valkey.js', () => ({
    publishMessage: vi.fn(async () => true),
    subscribeToChannel: vi.fn(async () => undefined),
}));

const mockCheckMediaAccess = vi.fn();
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...a: unknown[]) => mockCheckMediaAccess(...a),
}));

const mockKick = vi.fn();
vi.mock('$lib/server/services/session-kill.service', () => ({
    checkSessionKickCooldown: (...a: unknown[]) => mockKick(...a),
}));

vi.mock('./silent-start', () => ({ disarmSilentStart: vi.fn(async () => undefined) }));

const mockHandleStreamFile = vi.fn();
vi.mock('./stream-file-handler', () => ({
    handleStreamFile: (...a: unknown[]) => mockHandleStreamFile(...a),
}));

const mockStreamProgressive = vi.fn();
vi.mock('./music-progressive', () => ({
    streamMusicProgressive: (...a: unknown[]) => mockStreamProgressive(...a),
}));

const mockValidatePlayToken = vi.fn();
vi.mock('./play-token', () => ({
    validatePlayToken: (...a: unknown[]) => mockValidatePlayToken(...a),
    renewPlayTokenBySession: vi.fn(async () => undefined),
}));

const mockPlayUser = vi.fn();
vi.mock('./play-token-user', () => ({
    buildPlayTokenUserContext: (...args: unknown[]) => mockPlayUser(...args),
}));

const mockResolvePlaybackSelection = vi.fn();
vi.mock('$lib/server/database/queries/media-file-resolution.queries', () => ({
    resolvePlaybackSelection: (...a: unknown[]) => mockResolvePlaybackSelection(...a),
}));

const mockGetStreamsForFile = vi.fn();
vi.mock('$lib/server/database/queries/media-streams.queries', () => ({
    getStreamsForFile: (...a: unknown[]) => mockGetStreamsForFile(...a),
}));

vi.mock('$lib/server/utils/media-path-resolver', () => ({
    resolveMediaPath: async (p: string) => ({ isAccessible: true, containerPath: p, fileSize: 10 }),
}));

const cfg = { FEATURE_MUSIC_TRANSCODE: true };
vi.mock('$lib/server/config', () => ({ config: cfg, features: { ffmpegAvailable: true } }));

vi.mock('$lib/server/services/music-transcode/index', () => ({
    clampBitrate: (_c: string, kbps: number) => Math.min(kbps, 320),
    defaultBitrateFor: () => 192,
    containerFor: (c: string) => (c === 'opus' ? 'ogg' : c),
}));

// Through the route file: it composes the play-token branch, the
// withJellyfinAuth-wrapped session handlers and the container branches.
const { GET: streamByContainerRoute } =
    await import('../../../routes/(modules)/j/Audio/[itemId]/stream.[container]/+server');
const handleAudioStreamByContainer = (event: RequestEvent): Promise<Response> =>
    (streamByContainerRoute as unknown as (e: RequestEvent) => Promise<Response>)(event);

const ITEM_ID = '00000000-0000-4000-a000-000000000001';
const FILE_A = '00000000-0000-4000-a000-0000000000fa';
const FILE_B = '00000000-0000-4000-a000-0000000000fb';
const USER = { userId: 'uid-alice', username: 'alice', ownerIsAdmin: false };

interface FakeFile {
    id: string;
    file_path: string;
    total_bitrate: number | null;
    codec: string | null;
}
let files: Record<string, FakeFile>;

function makeEvent(container: string, query = '') {
    const url = new URL(`https://app.example/j/Audio/${ITEM_ID}/stream.${container}${query}`);
    return {
        request: new Request(url),
        url,
        params: { itemId: ITEM_ID, container },
        locals: { user: USER, jfDevice: { deviceId: 'dev-1' } },
    } as unknown as RequestEvent;
}

function servedFileId(): string | null {
    const ev = mockHandleStreamFile.mock.calls[0][0] as { url: URL };
    return ev.url.searchParams.get('mediaSourceId');
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue(fakeSql);
    mockPlayUser.mockImplementation(async (username: string) => ({
        userId: `uid-${username}`,
        username,
        ownerIsAdmin: false,
    }));
    cfg.FEATURE_MUSIC_TRANSCODE = true;
    files = {
        [FILE_A]: { id: FILE_A, file_path: '/music/a.mp3', total_bitrate: 320_000, codec: 'mp3' },
        [FILE_B]: { id: FILE_B, file_path: '/music/b.flac', total_bitrate: 900_000, codec: 'flac' },
    };
    mockCheckMediaAccess.mockResolvedValue(true);
    mockKick.mockResolvedValue({ kicked: false });
    mockValidatePlayToken.mockResolvedValue(null);
    mockResolvePlaybackSelection.mockImplementation(
        async (_sql: unknown, _id: string, opts?: { fileId?: string }) => {
            const id = opts?.fileId ?? FILE_A;
            const f = files[id];
            return f ? { files: [f], fileId: id } : { files: [], fileId: null };
        },
    );
    mockGetStreamsForFile.mockImplementation(async (_sql: unknown, fileId: string) => [
        {
            stream_type: 'audio',
            is_external: false,
            is_default: true,
            codec: files[fileId]?.codec ?? null,
            bitrate: null,
            sample_rate: 44_100,
            channels: 2,
            bit_depth: null,
        },
    ]);
    mockHandleStreamFile.mockResolvedValue(new Response('bytes', { status: 206 }));
    mockStreamProgressive.mockResolvedValue(new Response('encoded', { status: 200 }));
});

describe('stream.{container}: direct or transcode', () => {
    it('serves a clean match as-is, pinned to the judged file', async () => {
        const res = await handleAudioStreamByContainer(makeEvent('mp3'));
        expect(res.status).toBe(206);
        expect(servedFileId()).toBe(FILE_A);
        expect(mockStreamProgressive).not.toHaveBeenCalled();
    });

    it('judges and serves the file MediaSourceId names, not the default one', async () => {
        await handleAudioStreamByContainer(makeEvent('flac', `?MediaSourceId=${FILE_B}`));
        expect(servedFileId()).toBe(FILE_B);

        vi.clearAllMocks();
        mockGetDb.mockReturnValue(fakeSql);
        mockPlayUser.mockImplementation(async (username: string) => ({
            userId: `uid-${username}`,
            username,
            ownerIsAdmin: false,
        }));
        mockHandleStreamFile.mockResolvedValue(new Response('bytes', { status: 206 }));
        mockStreamProgressive.mockResolvedValue(new Response('encoded', { status: 200 }));
        // The default (mp3) would be a clean match; the named FLAC version is not.
        await handleAudioStreamByContainer(makeEvent('mp3', `?MediaSourceId=${FILE_B}`));
        expect(mockHandleStreamFile).not.toHaveBeenCalled();
        expect(mockStreamProgressive.mock.calls[0][2]).toMatchObject({
            sourcePath: '/music/b.flac',
            codec: 'mp3',
        });
    });

    it('transcodes a Vorbis .ogg for stream.opus and an ALAC .m4a for stream.m4a', async () => {
        files[FILE_A] = {
            id: FILE_A,
            file_path: '/music/a.ogg',
            total_bitrate: 200_000,
            codec: 'vorbis',
        };
        await handleAudioStreamByContainer(makeEvent('opus'));
        expect(mockHandleStreamFile).not.toHaveBeenCalled();
        expect(mockStreamProgressive.mock.calls[0][2]).toMatchObject({ codec: 'opus' });

        files[FILE_A] = {
            id: FILE_A,
            file_path: '/music/a.m4a',
            total_bitrate: 900_000,
            codec: 'alac',
        };
        await handleAudioStreamByContainer(makeEvent('m4a'));
        expect(mockHandleStreamFile).not.toHaveBeenCalled();
        expect(mockStreamProgressive.mock.calls[1][2]).toMatchObject({ codec: 'm4a' });
    });

    it('ignores a bitrate cap at or above the source, transcodes below it', async () => {
        await handleAudioStreamByContainer(makeEvent('mp3', '?MaxStreamingBitrate=140000000'));
        expect(mockHandleStreamFile).toHaveBeenCalledTimes(1);
        expect(mockStreamProgressive).not.toHaveBeenCalled();

        await handleAudioStreamByContainer(makeEvent('mp3', '?AudioBitRate=128000'));
        expect(mockHandleStreamFile).toHaveBeenCalledTimes(1);
        expect(mockStreamProgressive.mock.calls[0][2]).toMatchObject({
            codec: 'mp3',
            bitrateKbps: 128,
        });
    });

    it('serves a clean flac/wav match with a start offset as-is (no encoder for it)', async () => {
        const res = await handleAudioStreamByContainer(
            makeEvent('flac', `?MediaSourceId=${FILE_B}&StartTimeTicks=300000000`),
        );
        expect(res.status).toBe(206);
        expect(servedFileId()).toBe(FILE_B);
        expect(mockStreamProgressive).not.toHaveBeenCalled();

        vi.clearAllMocks();
        mockGetDb.mockReturnValue(fakeSql);
        mockPlayUser.mockImplementation(async (username: string) => ({
            userId: `uid-${username}`,
            username,
            ownerIsAdmin: false,
        }));
        mockHandleStreamFile.mockResolvedValue(new Response('bytes', { status: 206 }));
        files[FILE_A] = {
            id: FILE_A,
            file_path: '/music/a.wav',
            total_bitrate: 1_411_000,
            codec: 'pcm_s16le',
        };
        const wav = await handleAudioStreamByContainer(
            makeEvent('wav', '?StartTimeTicks=300000000'),
        );
        expect(wav.status).toBe(206);
        expect(mockStreamProgressive).not.toHaveBeenCalled();
    });

    it('still encodes a clean mp3 match with a start offset (the encoder seeks)', async () => {
        await handleAudioStreamByContainer(makeEvent('mp3', '?StartTimeTicks=300000000'));
        expect(mockHandleStreamFile).not.toHaveBeenCalled();
        expect(mockStreamProgressive.mock.calls[0][2]).toMatchObject({
            codec: 'mp3',
            timeOffset: 30,
        });
    });

    it('is a 415 for a container the transcoder cannot produce', async () => {
        const res = await handleAudioStreamByContainer(makeEvent('wav'));
        expect(res.status).toBe(415);
        expect(mockHandleStreamFile).not.toHaveBeenCalled();
        expect(mockStreamProgressive).not.toHaveBeenCalled();
    });

    it('is a 404 for an item the user cannot see', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);
        const res = await handleAudioStreamByContainer(makeEvent('mp3'));
        expect(res.status).toBe(404);
        expect(mockHandleStreamFile).not.toHaveBeenCalled();
    });
});

describe('stream.{container} with music transcoding off', () => {
    beforeEach(() => {
        cfg.FEATURE_MUSIC_TRANSCODE = false;
    });

    it('still serves a clean match (a start offset is the player’s to seek)', async () => {
        const res = await handleAudioStreamByContainer(
            makeEvent('mp3', '?StartTimeTicks=300000000'),
        );
        expect(res.status).toBe(206);
        expect(mockStreamProgressive).not.toHaveBeenCalled();
    });

    it('is a 415, never an encode, for anything that is not a clean match', async () => {
        for (const [container, query] of [
            ['aac', ''],
            ['mp3', '?AudioBitRate=128000'],
        ]) {
            const res = await handleAudioStreamByContainer(makeEvent(container, query));
            expect(res.status).toBe(415);
        }
        files[FILE_A] = {
            id: FILE_A,
            file_path: '/music/a.ogg',
            total_bitrate: 200_000,
            codec: 'vorbis',
        };
        expect((await handleAudioStreamByContainer(makeEvent('opus'))).status).toBe(415);
        expect(mockStreamProgressive).not.toHaveBeenCalled();
        expect(mockHandleStreamFile).not.toHaveBeenCalled();
    });
});

describe('kick cooldown', () => {
    beforeEach(() => {
        mockKick.mockResolvedValue({ kicked: true, remainingSeconds: 30 });
    });

    it('refuses the direct and the transcode branch', async () => {
        expect((await handleAudioStreamByContainer(makeEvent('mp3'))).status).toBe(403);
        expect((await handleAudioStreamByContainer(makeEvent('aac'))).status).toBe(403);
        expect(mockHandleStreamFile).not.toHaveBeenCalled();
        expect(mockStreamProgressive).not.toHaveBeenCalled();
        expect(mockKick).toHaveBeenCalledWith('alice');
    });

    it('refuses Static=true for a signed-in user', async () => {
        const res = await handleAudioStreamByContainer(makeEvent('mp3', '?Static=true'));
        expect(res.status).toBe(403);
        expect(mockHandleStreamFile).not.toHaveBeenCalled();
    });

    it('refuses the play-token paths, checked against the token’s user', async () => {
        mockValidatePlayToken.mockImplementation(async (t: string) =>
            t === 'tok-1' ? { fileId: FILE_A, itemId: ITEM_ID, userId: 'bob' } : null,
        );
        for (const query of ['?Static=true&mediaSourceId=tok-1', '?Static=true&play_token=tok-1']) {
            const res = await handleAudioStreamByContainer(makeEvent('mp3', query));
            expect(res.status).toBe(403);
        }
        expect(mockHandleStreamFile).not.toHaveBeenCalled();
        expect(mockKick).toHaveBeenCalledWith('bob');
        expect(mockKick).not.toHaveBeenCalledWith('alice');
    });

    it('lets the stream through once the cooldown is over', async () => {
        mockKick.mockResolvedValue({ kicked: false });
        expect((await handleAudioStreamByContainer(makeEvent('mp3', '?Static=true'))).status).toBe(
            206,
        );
    });
});

describe('audio play-token database unavailability', () => {
    it('blocks an admin-owned scoped play token before streaming bytes', async () => {
        mockGetDb.mockReturnValue(null);
        mockPlayUser.mockResolvedValue({
            username: 'admin',
            ownerIsAdmin: true,
            mediaAccessIsAdmin: false,
        });
        mockValidatePlayToken.mockResolvedValue({
            userId: 'admin',
            itemId: ITEM_ID,
            fileId: FILE_A,
        });
        const event = makeEvent('mp3', '?mediaSourceId=play-token&Static=true');
        expect((await handleAudioStreamByContainer(event)).status).toBe(500);
        expect(mockHandleStreamFile).not.toHaveBeenCalled();
    });

    it('keeps admin password-session streaming available with no database', async () => {
        const { serveAuthenticatedAudioStream } = await import('./audio-stream');
        mockGetDb.mockReturnValue(null);
        const event = makeEvent('mp3');
        event.locals.user = { ...USER, ownerIsAdmin: true } as unknown as typeof event.locals.user;
        expect((await serveAuthenticatedAudioStream(event)).status).toBe(206);
    });
});
