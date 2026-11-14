// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// The TranscodingUrl PlaybackInfo hands out carries AudioStreamIndex,
// SubtitleStreamIndex + SubtitleMethod=Encode and TranscodingMaxAudioChannels.
// This pins that the HLS entry point forwards all of them to startHlsPlayback —
// the channel cap used to be dropped here, so a stereo client got 5.1.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';

const { mockStartHlsPlayback, mockValidatePlayToken, mockGetFilesForMediaItem } = vi.hoisted(
    () => ({
        mockStartHlsPlayback: vi.fn(),
        mockValidatePlayToken: vi.fn(),
        mockGetFilesForMediaItem: vi.fn(),
    }),
);

vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config')>();
    return {
        ...actual,
        features: { ...actual.features, ffmpegAvailable: true },
    };
});
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn().mockResolvedValue(true),
}));
vi.mock('$lib/server/database/queries/catalog-operations.queries', () => ({
    getMediaItemById: vi.fn().mockResolvedValue(null),
}));
vi.mock('$lib/server/services/session-kill.service', () => ({
    checkSessionKickCooldown: vi.fn().mockResolvedValue({ kicked: false }),
}));
vi.mock('$lib/server/utils/client-ip', () => ({ getClientIp: () => '127.0.0.1' }));
vi.mock('$lib/server/database/queries/media-files.queries', () => ({
    getOwnerItemForFile: vi.fn().mockResolvedValue(null),
    getFilesForMediaItem: mockGetFilesForMediaItem,
}));
vi.mock('$lib/server/jellyfin-compat/playback-utils', () => ({
    jellyfinCompatDeviceId: () => 'jellyfin-compat-device',
}));
vi.mock('$lib/server/services/hls/playback.service', () => ({
    startHlsPlayback: mockStartHlsPlayback,
    HlsPlaybackError: class HlsPlaybackError extends Error {
        statusCode = 500;
    },
}));
vi.mock('$lib/server/jellyfin-compat/play-token', () => ({
    validatePlayToken: mockValidatePlayToken,
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { GET } from './+server';

const ITEM_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';

async function callGet(query: string): Promise<Response> {
    const url = new URL(`https://example.test/j/Videos/${ITEM_ID}/master.m3u8?${query}`);
    const event = {
        params: { itemId: ITEM_ID },
        url,
        request: new Request(url),
        locals: { user: { userId: undefined, username: 'unknown' } },
        cookies: { get: vi.fn(), set: vi.fn() },
    } as unknown as RequestEvent;
    return (GET as unknown as (e: RequestEvent) => Promise<Response>)(event);
}

describe('/j/Videos/[itemId]/master.m3u8 — track parameters', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockStartHlsPlayback.mockResolvedValue({ playlistBody: '#EXTM3U\n#EXT-X-ENDLIST\n' });
        mockValidatePlayToken.mockResolvedValue(null);
    });

    it('forwards audio track, burn-in and the transcoding channel cap', async () => {
        const res = await callGet(
            'PlaySessionId=abc123&AudioStreamIndex=2&SubtitleStreamIndex=3&SubtitleMethod=Encode&TranscodingMaxAudioChannels=2&VideoCodec=h264&AudioCodec=aac',
        );
        expect(res.status).toBe(200);
        expect(mockStartHlsPlayback).toHaveBeenCalledWith(
            expect.objectContaining({
                audioStreamIndex: 2,
                subtitleBurnIn: { streamIndex: 3, method: 'Encode' },
                maxAudioChannels: 2,
            }),
        );
    });

    it('takes the tighter of TranscodingMaxAudioChannels and MaxAudioChannels', async () => {
        await callGet('PlaySessionId=abc123&TranscodingMaxAudioChannels=6&MaxAudioChannels=2');
        expect(mockStartHlsPlayback.mock.calls[0][0].maxAudioChannels).toBe(2);
    });

    it('sets no channel cap when none is given (or it is garbage)', async () => {
        await callGet('PlaySessionId=abc123&TranscodingMaxAudioChannels=zero');
        expect(mockStartHlsPlayback.mock.calls[0][0].maxAudioChannels).toBeUndefined();
    });

    // The picked version. Without it every /j transcode used the item's first
    // file: the 2160p pick of 2001 played the 1080p file, and the German PGS
    // track (index 4, 2160p only) was "missing" so its burn-in was skipped.
    describe('MediaSourceId → the version to transcode', () => {
        const FILE_ID = 'ba0faac2-2bc1-46d7-b87d-9e971d80b5e8';
        const OTHER_ID = '77da5c2c-d84e-44f5-a29e-82bcbe930a36';
        const file = (id: string, over: Record<string, unknown> = {}) => ({
            id,
            file_path: `/m/${id}.mkv`,
            edition: null,
            part_number: null,
            duration_seconds: 8929.28,
            ...over,
        });

        beforeEach(() => {
            // Two versions (1080p + 2160p), as "2001: A Space Odyssey" on prod.
            mockGetFilesForMediaItem.mockResolvedValue([file(OTHER_ID), file(FILE_ID)]);
        });

        it("transcodes the picked version for that file's own length", async () => {
            mockGetFilesForMediaItem.mockResolvedValue([
                file(OTHER_ID, { duration_seconds: 5400 }),
                file(FILE_ID, { edition: 'Extended', duration_seconds: 7020 }),
            ]);
            await callGet(`PlaySessionId=abc123&MediaSourceId=${FILE_ID}`);
            const opts = mockStartHlsPlayback.mock.calls[0][0];
            expect(opts.fileId).toBe(FILE_ID);
            expect(opts.durationOverride).toBe(7020);
        });

        // /j exposes the parts as Jellyfin does (PartCount + AdditionalParts): the
        // app queues part 2 itself, so a part's transcode is that part alone.
        it('one part of a multi-part item transcodes just that part, for its own length', async () => {
            mockGetFilesForMediaItem.mockResolvedValue([
                file(OTHER_ID, { part_number: 1, edition: 'Director', duration_seconds: 2700 }),
                file(FILE_ID, { part_number: 2, edition: 'Director', duration_seconds: 2400 }),
            ]);
            await callGet(`PlaySessionId=abc123&MediaSourceId=${FILE_ID}`);
            const opts = mockStartHlsPlayback.mock.calls[0][0];
            expect(opts.fileId).toBe(FILE_ID);
            expect(opts.edition).toBeUndefined();
            expect(opts.durationOverride).toBe(2400);
        });

        it('a lone "part" next to another version of the same number is a version', async () => {
            // "Distant Harbors Part 1": both copies carried part 1 from the title.
            mockGetFilesForMediaItem.mockResolvedValue([
                file(OTHER_ID, { part_number: 1 }),
                file(FILE_ID, { part_number: 1, duration_seconds: 8760 }),
            ]);
            await callGet(`PlaySessionId=abc123&MediaSourceId=${FILE_ID}`);
            const opts = mockStartHlsPlayback.mock.calls[0][0];
            expect(opts.fileId).toBe(FILE_ID);
            expect(opts.durationOverride).toBe(8760);
        });

        it('a single-file item passes no fileId (no forced probe per request)', async () => {
            mockGetFilesForMediaItem.mockResolvedValue([file(FILE_ID)]);
            await callGet(`PlaySessionId=abc123&MediaSourceId=${FILE_ID}`);
            expect(mockStartHlsPlayback.mock.calls[0][0].fileId).toBeUndefined();
        });

        it('passes the raw file id PlaybackInfo writes into the TranscodingUrl', async () => {
            await callGet(`PlaySessionId=abc123&MediaSourceId=${FILE_ID}`);
            expect(mockStartHlsPlayback.mock.calls[0][0].fileId).toBe(FILE_ID);
        });

        it('normalizes a dashless id', async () => {
            await callGet(`PlaySessionId=abc123&mediaSourceId=${FILE_ID.replace(/-/g, '')}`);
            expect(mockStartHlsPlayback.mock.calls[0][0].fileId).toBe(FILE_ID);
        });

        it('resolves the file token PlaybackInfo issues as MediaSource.Id', async () => {
            mockValidatePlayToken.mockResolvedValue({ fileId: FILE_ID });
            await callGet('PlaySessionId=abc123&MediaSourceId=tok_abc');
            expect(mockValidatePlayToken).toHaveBeenCalledWith('tok_abc');
            expect(mockStartHlsPlayback.mock.calls[0][0].fileId).toBe(FILE_ID);
        });

        // Real file tokens are randomUUID()s: a UUID shape must not short-circuit
        // the token lookup (main.m3u8 inherits this path).
        it('resolves a UUID-shaped file token before taking it as a file id', async () => {
            const token = '0d6f2c1e-1111-4222-8333-944445555666';
            mockValidatePlayToken.mockResolvedValue({ fileId: FILE_ID });
            await callGet(`PlaySessionId=abc123&MediaSourceId=${token}`);
            expect(mockValidatePlayToken).toHaveBeenCalledWith(token);
            expect(mockStartHlsPlayback.mock.calls[0][0].fileId).toBe(FILE_ID);
        });

        it('an unknown token or no MediaSourceId leaves the default file', async () => {
            await callGet('PlaySessionId=abc123&MediaSourceId=tok_unknown');
            await callGet('PlaySessionId=abc123');
            expect(mockStartHlsPlayback.mock.calls[0][0].fileId).toBeUndefined();
            expect(mockStartHlsPlayback.mock.calls[1][0].fileId).toBeUndefined();
        });
    });
});

describe('fallback playlist completion', () => {
    it('keeps an unfinished EVENT playlist open for subsequent segments', async () => {
        const body = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:6,\nsegment0.ts\n';
        mockStartHlsPlayback.mockResolvedValue({ playlistBody: body });
        const response = await callGet('PlaySessionId=abc123');
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(body);
    });

    it('upgrades a completed EVENT playlist to VOD and preserves its ENDLIST', async () => {
        mockStartHlsPlayback.mockResolvedValue({
            playlistBody: '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-ENDLIST\n',
        });
        const response = await callGet('PlaySessionId=abc123');
        expect(await response.text()).toBe('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-ENDLIST\n');
    });
});
