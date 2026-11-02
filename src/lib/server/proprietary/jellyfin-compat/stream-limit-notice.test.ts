// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * The free-tier "stream limit reached" decision and notice ids. The session
 * query is mocked here (its live/stale filtering is covered against a real
 * database in playback-utils.freemium.integration.test.ts); Valkey is an
 * in-memory map; the clip render is stubbed (stream-limit-clip.test.ts renders
 * a real one).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
    cap: 2 as number | null,
    sessions: [] as { id: string; user_id: string; media_id: string; started_at: Date }[],
    store: new Map<string, string>(),
    cacheSetOk: true,
    clipDir: '',
    clipFails: false,
    queryThrows: false,
    clipCalls: [] as unknown[][],
}));

vi.mock('$lib/server/licensing/entitlements', () => ({
    getEffectiveEntitlements: async () => ({ jellyfinMaxConcurrentStreams: h.cap }),
}));
vi.mock('$lib/server/database/queries/play-sessions.queries', () => ({
    getLiveJellyfinCompatSessions: async () => {
        if (h.queryThrows) throw new Error('db down');
        return h.sessions;
    },
}));
vi.mock('$lib/server/cache/valkey', () => ({
    hGetAll: async () => ({}),
    cacheGet: async (k: string) => h.store.get(k) ?? null,
    cacheSet: async (k: string, v: string) => {
        if (!h.cacheSetOk) return false;
        h.store.set(k, v);
        return true;
    },
}));
vi.mock('./stream-limit-clip', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./stream-limit-clip')>();
    return {
        ...actual,
        ensureStreamLimitClip: async (...args: unknown[]) => {
            h.clipCalls.push(args);
            if (h.clipFails) throw new Error('ffmpeg missing');
            return {
                dir: h.clipDir,
                mp4Path: join(h.clipDir, 'clip.mp4'),
                playlistPath: join(h.clipDir, 'clip.m3u8'),
                mp4Bytes: 10,
            };
        },
    };
});
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
}));

import {
    buildStreamLimitPlaybackInfo,
    freshPlaySessionId,
    isStreamLimitNoticeId,
    isStreamLimitNoticeReport,
    noticeLanguage,
    serveStreamLimitClipFile,
    streamCapReachedByOthers,
} from './stream-limit-notice';
import type { UserId } from '$lib/shared/user-id';

const SQL = {} as never;
const ME = 'me-uuid' as UserId;
const OTHER = 'other-uuid';

function session(id: string, mediaId: string, userId: string = OTHER) {
    return { id, user_id: userId, media_id: mediaId, started_at: new Date() };
}

beforeEach(async () => {
    h.cap = 2;
    h.sessions = [];
    h.store.clear();
    h.cacheSetOk = true;
    h.clipFails = false;
    h.queryThrows = false;
    h.clipCalls = [];
    h.clipDir = await fs.mkdtemp(join(tmpdir(), 'notice-test-'));
    await fs.writeFile(join(h.clipDir, 'clip.mp4'), Buffer.from('0123456789'));
    await fs.writeFile(join(h.clipDir, 'clip.m3u8'), '#EXTM3U\n#EXT-X-ENDLIST\n');
    await fs.writeFile(join(h.clipDir, 'seg-000.ts'), Buffer.from('ts'));
});

describe('streamCapReachedByOthers', () => {
    it('is null when unlimited (licensed / enforcement off)', async () => {
        h.cap = null;
        h.sessions = [session('a', 'm1'), session('b', 'm2'), session('c', 'm3')];
        expect(await streamCapReachedByOthers(SQL, ME, 'new')).toBeNull();
    });

    it('is null while a slot is free', async () => {
        h.sessions = [session('a', 'm1')];
        expect(await streamCapReachedByOthers(SQL, ME, 'new')).toBeNull();
    });

    it('returns the cap once other live /j streams fill it', async () => {
        h.sessions = [session('a', 'm1'), session('b', 'm2', ME)];
        expect(await streamCapReachedByOthers(SQL, ME, 'new')).toBe(2);
    });

    it("excludes the caller's own session for the same item (seek / track switch)", async () => {
        h.sessions = [session('a', 'm1'), session('b', 'm2', ME)];
        expect(await streamCapReachedByOthers(SQL, ME, 'm2')).toBeNull();
    });

    it("does not treat another user's session on the same item as the caller's", async () => {
        h.sessions = [session('a', 'm1'), session('b', 'm2')];
        expect(await streamCapReachedByOthers(SQL, ME, 'm2')).toBe(2);
    });

    it('fails open (real media) when the query throws', async () => {
        h.queryThrows = true;
        expect(await streamCapReachedByOthers(SQL, ME, 'new')).toBeNull();
    });
});

describe('notice ids', () => {
    it('build → a clip MediaSource whose id doubles as PlaySessionId', async () => {
        const res = await buildStreamLimitPlaybackInfo({
            userId: ME,
            cap: 2,
            lang: 'en',
            itemId: 'item',
        });
        expect(res).not.toBeNull();
        const src = res!.MediaSources[0]!;
        expect(res!.PlaySessionId).toMatch(/^[0-9a-f]{32}$/);
        expect(src.Id).toBe(res!.PlaySessionId);
        expect(src.Name).toBe('Stream limit reached');
        expect(src.Container).toBe('mp4');
        expect(src.SupportsDirectPlay).toBe(true);
        expect(src.RunTimeTicks).toBe(15 * 10_000_000);
        expect(src.DirectStreamUrl).toContain(`/Videos/${src.Id}/stream?static=true`);
        expect(src.TranscodingUrl).toBe(`/LumastraNotice/${src.Id}/clip.m3u8`);
        expect(src.MediaStreams?.map((s) => s.Codec)).toEqual(['h264', 'aac']);
        expect(src.DefaultAudioStreamIndex).toBeUndefined();
        expect(await isStreamLimitNoticeId(src.Id)).toBe(true);
    });

    it('a Live TV provider notice carries its own title and serves its own clip', async () => {
        const res = await buildStreamLimitPlaybackInfo({
            kind: 'livetv_source',
            userId: ME,
            cap: 3,
            lang: 'de',
            itemId: 'channel',
        });
        expect(res!.MediaSources[0]!.Name).toBe('Alle TV-Streams belegt');
        expect(h.clipCalls.at(-1)).toEqual(['livetv_source', 'de', 3]);
        // Serving it later renders/reads the same clip, not the /j one.
        await serveStreamLimitClipFile(res!.PlaySessionId, 'clip.mp4', new Request('http://x/'));
        expect(h.clipCalls.at(-1)).toEqual(['livetv_source', 'de', 3]);
        // Its reports are ignored like any notice.
        expect(await isStreamLimitNoticeReport({ playSessionId: res!.PlaySessionId })).toBe(true);
    });

    it('defaults to the /j cap clip', async () => {
        await buildStreamLimitPlaybackInfo({ userId: ME, cap: 2, lang: 'en', itemId: 'i' });
        expect(h.clipCalls.at(-1)).toEqual(['jellyfin_cap', 'en', 2]);
    });

    it('returns null (→ plain error) when the clip cannot be rendered', async () => {
        h.clipFails = true;
        expect(
            await buildStreamLimitPlaybackInfo({ userId: ME, cap: 2, lang: 'en', itemId: 'i' }),
        ).toBeNull();
    });

    it('returns null when the notice cannot be stored', async () => {
        h.cacheSetOk = false;
        expect(
            await buildStreamLimitPlaybackInfo({ userId: ME, cap: 2, lang: 'en', itemId: 'i' }),
        ).toBeNull();
    });

    it('an unknown or malformed id is never a notice', async () => {
        expect(await isStreamLimitNoticeId('0'.repeat(32))).toBe(false);
        expect(await isStreamLimitNoticeId('ea217dde-39e3-42c3-97b7-1e67249b99a1')).toBe(false);
        expect(await isStreamLimitNoticeId(undefined)).toBe(false);
    });

    it('a session report matches by PlaySessionId or MediaSourceId', async () => {
        const res = await buildStreamLimitPlaybackInfo({
            userId: ME,
            cap: 2,
            lang: 'en',
            itemId: 'i',
        });
        const id = res!.PlaySessionId;
        expect(await isStreamLimitNoticeReport({ playSessionId: id })).toBe(true);
        expect(await isStreamLimitNoticeReport({ mediaSourceId: id })).toBe(true);
        expect(await isStreamLimitNoticeReport({ playSessionId: 'a'.repeat(32) })).toBe(false);
    });

    it('freshPlaySessionId keeps a client id but never reuses a notice id', async () => {
        expect(await freshPlaySessionId('client-session')).toBe('client-session');
        const res = await buildStreamLimitPlaybackInfo({
            userId: ME,
            cap: 2,
            lang: 'en',
            itemId: 'i',
        });
        const fresh = await freshPlaySessionId(res!.PlaySessionId);
        expect(fresh).not.toBe(res!.PlaySessionId);
        expect(fresh).toMatch(/^[0-9a-f]{32}$/);
        expect(await freshPlaySessionId(undefined)).toMatch(/^[0-9a-f]{32}$/);
    });

    it('freshPlaySessionId replaces an oversized or odd client id, keeps a normal one', async () => {
        const hex = 'f'.repeat(32);
        expect(await freshPlaySessionId(hex)).toBe(hex);
        const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
        expect(await freshPlaySessionId(uuid)).toBe(uuid);
        const huge = 'a'.repeat(10 * 1024);
        const fresh = await freshPlaySessionId(huge);
        expect(fresh).not.toBe(huge);
        expect(fresh).toMatch(/^[0-9a-f]{32}$/);
        expect(await freshPlaySessionId('../x y')).toMatch(/^[0-9a-f]{32}$/);
        expect(await freshPlaySessionId('a'.repeat(65))).toMatch(/^[0-9a-f]{32}$/);
    });
});

describe('serveStreamLimitClipFile', () => {
    async function noticeId(): Promise<string> {
        const res = await buildStreamLimitPlaybackInfo({
            userId: ME,
            cap: 2,
            lang: 'en',
            itemId: 'i',
        });
        return res!.PlaySessionId;
    }

    it('serves the MP4 with byte ranges', async () => {
        const id = await noticeId();
        const res = await serveStreamLimitClipFile(
            id,
            'clip.mp4',
            new Request('http://x/', { headers: { Range: 'bytes=2-5' } }),
        );
        expect(res!.status).toBe(206);
        expect(res!.headers.get('content-type')).toBe('video/mp4');
        expect(await res!.text()).toBe('2345');
    });

    it('serves the playlist and its segments', async () => {
        const id = await noticeId();
        const pl = await serveStreamLimitClipFile(id, 'clip.m3u8', new Request('http://x/'));
        expect(pl!.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
        const seg = await serveStreamLimitClipFile(id, 'seg-000.ts', new Request('http://x/'));
        expect(seg!.status).toBe(200);
    });

    it('refuses an unknown notice id and anything outside the clip', async () => {
        const id = await noticeId();
        expect(
            await serveStreamLimitClipFile('b'.repeat(32), 'clip.mp4', new Request('http://x/')),
        ).toBeNull();
        expect(
            await serveStreamLimitClipFile(id, '../settings.json', new Request('http://x/')),
        ).toBeNull();
        expect(
            await serveStreamLimitClipFile(id, 'frame.png', new Request('http://x/')),
        ).toBeNull();
    });
});

describe('noticeLanguage', () => {
    it('follows a German Accept-Language, else English', () => {
        expect(
            noticeLanguage(new Request('http://x/', { headers: { 'Accept-Language': 'de-DE' } })),
        ).toBe('de');
        expect(noticeLanguage(new Request('http://x/'))).toBe('en');
    });
});

it('replaces an id already mapped to a token while preserving unused client ids', async () => {
    h.store.set('directplay:session:occupied', 'foreign-token');
    expect(await freshPlaySessionId('occupied')).not.toBe('occupied');
    expect(await freshPlaySessionId('unused')).toBe('unused');
});
