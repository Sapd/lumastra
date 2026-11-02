// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// /j/Items/[itemId]/PlaybackInfo under the free tier's /j stream cap.
//
// The decision module (stream-limit-notice.ts) runs for real; only its inputs
// are faked — the entitlement, the live /j session list, Valkey and the clip
// render — so this asserts what a Jellyfin client actually receives.

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

const ITEM = 'b1f6c3a0-0000-4000-8000-000000000001';
const FILE = 'f11e0000-0000-4000-8000-000000000001';
const ME = '00000000-0000-0000-0000-000000000001';

const h = vi.hoisted(() => ({
    cap: 2 as number | null,
    sessions: [] as { id: string; user_id: string; media_id: string; started_at: Date }[],
    store: new Map<string, string>(),
    mediaType: 'movie',
    clipFails: false,
    issuePlayToken: vi.fn(async () => 'stream-token'),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/database', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('$lib/server/database/queries/catalog-operations.queries', () => ({
    getMediaItemById: vi.fn(async () => ({
        id: ITEM,
        media_type: h.mediaType,
        runtime_seconds: 6000,
    })),
}));
vi.mock('$lib/server/database/queries/media-files.queries', () => ({
    getOwnerItemForFile: vi.fn().mockResolvedValue(null),
    getFilesForMediaItem: vi.fn(async () => [
        {
            id: FILE,
            file_path: '/data/movies/Film (2020)/Film.mkv',
            file_size_bytes: '1000',
            total_bitrate: '5000000',
        },
    ]),
}));
vi.mock('$lib/server/database/queries/media-streams.queries', () => ({
    getStreamsForMediaItem: vi.fn().mockResolvedValue([]),
    getStreamsForFile: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/server/database/queries/external-subtitles.queries', () => ({
    getExternalSubtitlesForFile: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/server/database/queries/play-sessions.queries', () => ({
    getLiveJellyfinCompatSessions: async () => h.sessions,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn().mockResolvedValue(true),
}));
vi.mock('$lib/server/services/livetv/index.js', () => ({
    getLiveTvProvider: vi.fn(),
}));
vi.mock('$lib/server/licensing/entitlements', () => ({
    getEffectiveEntitlements: async () => ({ jellyfinMaxConcurrentStreams: h.cap }),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/video-attachments', () => ({
    mediaAttachmentsForSource: async () => [],
}));
vi.mock('$lib/server/cache/valkey', () => ({
    hGetAll: async () => ({}),
    cacheGet: async (k: string) => h.store.get(k) ?? null,
    cacheSet: async (k: string, v: string) => {
        h.store.set(k, v);
        return true;
    },
    // The library-permissions cache (via play-token-user) subscribes on load.
    subscribeToChannel: async () => undefined,
    publishMessage: async () => true,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/stream-limit-clip', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('$lib/server/proprietary/jellyfin-compat/stream-limit-clip')
        >();
    return {
        ...actual,
        ensureStreamLimitClip: async () => {
            if (h.clipFails) throw new Error('no ffmpeg');
            return { dir: '/tmp/x', mp4Path: '/tmp/x/clip.mp4', playlistPath: '', mp4Bytes: 1 };
        },
    };
});
vi.mock('$lib/server/proprietary/jellyfin-compat/play-token', () => ({
    issuePlayToken: h.issuePlayToken,
    issueFileToken: vi.fn().mockResolvedValue('file-token'),
    validatePlayToken: vi.fn().mockResolvedValue(null),
    revokePlayTokenBySession: vi.fn(),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/utils', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/proprietary/jellyfin-compat/utils')>();
    return { ...actual, getJfToken: vi.fn(() => 'jf-token') };
});
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { POST } from './+server';

interface PlaybackInfo {
    PlaySessionId: string;
    ErrorCode?: string;
    MediaSources: { Id: string; Name?: string; Container: string; Path?: string }[];
}

async function playbackInfo(body: Record<string, unknown> = {}): Promise<PlaybackInfo> {
    const event = {
        params: { itemId: ITEM },
        url: new URL(`https://example.test/j/Items/${ITEM}/PlaybackInfo`),
        request: new Request(`https://example.test/j/Items/${ITEM}/PlaybackInfo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
        locals: { user: { userId: ME, username: 'me' } },
        cookies: { get: vi.fn(), set: vi.fn() },
    } as unknown as RequestEvent;
    const res = await (POST as unknown as (e: RequestEvent) => Promise<Response>)(event);
    expect(res.status).toBe(200);
    return (await res.json()) as PlaybackInfo;
}

function other(id: string, mediaId: string, userId = 'someone-else') {
    return { id, user_id: userId, media_id: mediaId, started_at: new Date() };
}

describe('PlaybackInfo — free-tier /j stream cap', () => {
    beforeEach(() => {
        h.cap = 2;
        h.sessions = [];
        h.store.clear();
        h.mediaType = 'movie';
        h.clipFails = false;
        h.issuePlayToken.mockClear();
    });

    it('cap not reached → the real media', async () => {
        h.sessions = [other('a', 'm1')];
        const res = await playbackInfo();
        expect(res.MediaSources[0]!.Path).toContain('Film.mkv');
        expect(h.issuePlayToken).toHaveBeenCalled();
    });

    it('cap reached by other live sessions → the limit clip, no real token', async () => {
        h.sessions = [other('a', 'm1'), other('b', 'm2')];
        const res = await playbackInfo();
        expect(res.MediaSources).toHaveLength(1);
        expect(res.MediaSources[0]!.Name).toBe('Stream limit reached');
        expect(res.MediaSources[0]!.Container).toBe('mp4');
        expect(res.MediaSources[0]!.Path).toBeUndefined();
        expect(res.PlaySessionId).toBe(res.MediaSources[0]!.Id);
        // Nothing real was authorised.
        expect(h.issuePlayToken).not.toHaveBeenCalled();
    });

    it('my own stream re-asking (seek / track switch) keeps its media', async () => {
        h.sessions = [other('a', 'm1'), other('b', ITEM, ME)];
        const res = await playbackInfo({ PlaySessionId: 'abc' });
        expect(res.MediaSources[0]!.Path).toContain('Film.mkv');
        expect(res.PlaySessionId).toBe('abc');
    });

    it('licensed (no cap) → the real media whatever is playing', async () => {
        h.cap = null;
        h.sessions = [other('a', 'm1'), other('b', 'm2'), other('c', 'm3')];
        const res = await playbackInfo();
        expect(res.MediaSources[0]!.Path).toContain('Film.mkv');
    });

    it('audio items get Jellyfin’s RateLimitExceeded instead of a video clip', async () => {
        h.mediaType = 'track';
        h.sessions = [other('a', 'm1'), other('b', 'm2')];
        const res = await playbackInfo();
        expect(res.ErrorCode).toBe('RateLimitExceeded');
        expect(res.MediaSources).toEqual([]);
    });

    it('falls back to RateLimitExceeded when the clip cannot be produced', async () => {
        h.clipFails = true;
        h.sessions = [other('a', 'm1'), other('b', 'm2')];
        const res = await playbackInfo();
        expect(res.ErrorCode).toBe('RateLimitExceeded');
    });

    it('a retry that echoes the clip’s PlaySessionId gets a fresh one with real media', async () => {
        h.sessions = [other('a', 'm1'), other('b', 'm2')];
        const clip = await playbackInfo();
        h.sessions = [other('a', 'm1')]; // a slot freed up
        const real = await playbackInfo({ PlaySessionId: clip.PlaySessionId });
        expect(real.MediaSources[0]!.Path).toContain('Film.mkv');
        expect(real.PlaySessionId).not.toBe(clip.PlaySessionId);
    });
});
