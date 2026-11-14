// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Live TV "stream limit reached" notice ids. Valkey is an in-memory map; the
 * clip render is stubbed (stream-limit-clip.test.ts renders a real one).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
    store: new Map<string, string>(),
    cacheSetOk: true,
    clipDir: '',
    clipFails: false,
    clipCalls: [] as unknown[][],
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
    __test,
} from './stream-limit-notice';
import type { UserId } from '$lib/shared/user-id';

const ME = 'me-uuid' as UserId;

beforeEach(async () => {
    h.store.clear();
    h.cacheSetOk = true;
    h.clipFails = false;
    h.clipCalls = [];
    h.clipDir = await fs.mkdtemp(join(tmpdir(), 'notice-test-'));
    await fs.writeFile(join(h.clipDir, 'clip.mp4'), Buffer.from('0123456789'));
    await fs.writeFile(join(h.clipDir, 'clip.m3u8'), '#EXTM3U\n#EXT-X-ENDLIST\n');
    await fs.writeFile(join(h.clipDir, 'seg-000.ts'), Buffer.from('ts'));
});

describe('notice ids', () => {
    it('build → a clip MediaSource whose id doubles as PlaySessionId', async () => {
        const res = await buildStreamLimitPlaybackInfo({
            kind: 'livetv_source',
            userId: ME,
            cap: 2,
            lang: 'en',
            itemId: 'item',
        });
        expect(res).not.toBeNull();
        const src = res!.MediaSources[0]!;
        expect(res!.PlaySessionId).toMatch(/^[0-9a-f]{32}$/);
        expect(src.Id).toBe(res!.PlaySessionId);
        expect(src.Name).toBe('All TV streams in use');
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
        // Serving it later renders/reads the same clip.
        await serveStreamLimitClipFile(res!.PlaySessionId, 'clip.mp4', new Request('http://x/'));
        expect(h.clipCalls.at(-1)).toEqual(['livetv_source', 'de', 3]);
        // Its reports are ignored like any notice.
        expect(await isStreamLimitNoticeReport({ playSessionId: res!.PlaySessionId })).toBe(true);
    });

    it('a notice minted for the removed /j cap clip is not a notice', async () => {
        h.store.set(
            __test.noticeKey('c'.repeat(32)),
            JSON.stringify({ userId: ME, kind: 'jellyfin_cap', lang: 'en', cap: 2 }),
        );
        h.store.set(
            __test.noticeKey('d'.repeat(32)),
            JSON.stringify({ userId: ME, lang: 'en', cap: 2 }),
        );
        expect(await isStreamLimitNoticeId('c'.repeat(32))).toBe(false);
        expect(await isStreamLimitNoticeId('d'.repeat(32))).toBe(false);
    });

    it('returns null (→ plain error) when the clip cannot be rendered', async () => {
        h.clipFails = true;
        expect(
            await buildStreamLimitPlaybackInfo({
                kind: 'livetv_source',
                userId: ME,
                cap: 2,
                lang: 'en',
                itemId: 'i',
            }),
        ).toBeNull();
    });

    it('returns null when the notice cannot be stored', async () => {
        h.cacheSetOk = false;
        expect(
            await buildStreamLimitPlaybackInfo({
                kind: 'livetv_source',
                userId: ME,
                cap: 2,
                lang: 'en',
                itemId: 'i',
            }),
        ).toBeNull();
    });

    it('an unknown or malformed id is never a notice', async () => {
        expect(await isStreamLimitNoticeId('0'.repeat(32))).toBe(false);
        expect(await isStreamLimitNoticeId('ea217dde-39e3-42c3-97b7-1e67249b99a1')).toBe(false);
        expect(await isStreamLimitNoticeId(undefined)).toBe(false);
    });

    it('a session report matches by PlaySessionId or MediaSourceId', async () => {
        const res = await buildStreamLimitPlaybackInfo({
            kind: 'livetv_source',
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
            kind: 'livetv_source',
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
        expect(await freshPlaySessionId('../assistant/x y')).toMatch(/^[0-9a-f]{32}$/);
        expect(await freshPlaySessionId('a'.repeat(65))).toMatch(/^[0-9a-f]{32}$/);
    });
});

describe('serveStreamLimitClipFile', () => {
    async function noticeId(): Promise<string> {
        const res = await buildStreamLimitPlaybackInfo({
            kind: 'livetv_source',
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
            await serveStreamLimitClipFile(id, '../assistant/settings.json', new Request('http://x/')),
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
