// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const stores = vi.hoisted(() => ({
    'music-next-track-v1': new Map<string, unknown>(),
    'music-crossfade-v1': new Map<string, unknown>(),
}));
vi.mock('../cache/index.js', () => ({
    CACHE_NAMESPACES: {
        musicNextTrack: { name: 'music-next-track-v1' },
        musicCrossfade: { name: 'music-crossfade-v1' },
    },
    cacheManager: {
        for: (ns: { name: keyof typeof stores }) => {
            const map = stores[ns.name];
            return {
                get: async (k: string) => map.get(k) ?? null,
                set: async (k: string, v: unknown) => void map.set(k, v),
                delete: async (k: string) => void map.delete(k),
            };
        },
    },
}));
const access = vi.hoisted(() => ({ restricted: false, denied: new Set<string>() }));
vi.mock('../middleware/media-access.js', () => ({
    userNeedsMediaAccessCheck: async () => access.restricted,
    checkMediaAccess: async (_sql: unknown, id: string) => !access.denied.has(id),
}));
const getTracksByIds = vi.fn();
vi.mock('../database/queries/music.queries.js', () => ({
    getTracksByIds: (...a: unknown[]) => getTracksByIds(...a),
}));

const {
    applyMusicHeartbeatLiveInfo,
    recordMusicCrossfade,
    recordMusicNextTrack,
    clearMusicSessionLiveInfo,
    resolveMusicSessionLiveInfo,
} = await import('./music-session-live-info.js');

const sql = {} as postgres.Sql;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const row = (id: string, title: string) => ({
    id,
    title,
    artist_title: `${title} artist`,
    album_title: `${title} album`,
    custom_metadata: { album_artist: 'VA' },
});

beforeEach(() => {
    access.restricted = false;
    access.denied.clear();
    stores['music-next-track-v1'].clear();
    stores['music-crossfade-v1'].clear();
    getTracksByIds.mockReset();
    getTracksByIds.mockImplementation(async (_sql: unknown, ids: string[]) =>
        ids.map((id) => row(id, id === A ? 'Alpha' : 'Beta')),
    );
});

describe('resolveMusicSessionLiveInfo', () => {
    it('resolves the next track with the display artist, never the album-artist tag', async () => {
        await recordMusicNextTrack('s1', A);
        const info = await resolveMusicSessionLiveInfo(sql, ['s1']);
        expect(info.get('s1')).toEqual({
            nextTrack: {
                mediaId: A,
                title: 'Alpha',
                artistName: 'Alpha artist',
                albumName: 'Alpha album',
            },
        });
    });

    it('reports the fade time left on the SERVER clock, counted from receipt', async () => {
        await recordMusicCrossfade(
            's1',
            { otherTrackId: B, role: 'outgoing', remainingMs: 8_000, durationMs: 10_000 },
            1_000_000,
        );
        const info = await resolveMusicSessionLiveInfo(sql, ['s1'], 1_003_000);
        expect(info.get('s1')?.crossfade).toEqual({
            role: 'outgoing',
            otherTrack: expect.objectContaining({ mediaId: B, title: 'Beta' }),
            remainingMs: 5_000,
            durationMs: 10_000,
        });
    });

    it('drops a fade past its end time, whatever the cache TTL', async () => {
        await recordMusicCrossfade(
            's1',
            { otherTrackId: B, role: 'incoming', remainingMs: 2_000, durationMs: 6_000 },
            1_000_000,
        );
        const info = await resolveMusicSessionLiveInfo(sql, ['s1'], 1_002_000);
        expect(info.has('s1')).toBe(false);
        expect(getTracksByIds).not.toHaveBeenCalled();
    });

    it('a null report clears the fade', async () => {
        await recordMusicCrossfade('s1', {
            otherTrackId: B,
            role: 'incoming',
            remainingMs: 5_000,
            durationMs: 6_000,
        });
        await recordMusicCrossfade('s1', null);
        expect((await resolveMusicSessionLiveInfo(sql, ['s1'])).has('s1')).toBe(false);
    });

    it('clearMusicSessionLiveInfo removes both extras', async () => {
        await recordMusicNextTrack('s1', A);
        await recordMusicCrossfade('s1', {
            otherTrackId: B,
            role: 'incoming',
            remainingMs: 5_000,
            durationMs: 6_000,
        });
        await clearMusicSessionLiveInfo('s1');
        expect((await resolveMusicSessionLiveInfo(sql, ['s1'])).size).toBe(0);
    });

    it('resolves all tracks in one query and ignores malformed cache values', async () => {
        await recordMusicNextTrack('s1', A);
        await recordMusicCrossfade('s2', {
            otherTrackId: A,
            role: 'incoming',
            remainingMs: 5_000,
            durationMs: 6_000,
        });
        stores['music-crossfade-v1'].set('s3', { otherTrackId: B, role: 'sideways' });
        const info = await resolveMusicSessionLiveInfo(sql, ['s1', 's2', 's3']);
        expect(getTracksByIds).toHaveBeenCalledTimes(1);
        expect(getTracksByIds).toHaveBeenCalledWith(sql, [A]);
        expect([...info.keys()].sort()).toEqual(['s1', 's2']);
    });

    it('degrades to no extras when the track lookup fails', async () => {
        await recordMusicNextTrack('s1', A);
        getTracksByIds.mockRejectedValue(new Error('db down'));
        expect((await resolveMusicSessionLiveInfo(sql, ['s1'])).size).toBe(0);
    });
});

describe('applyMusicHeartbeatLiveInfo', () => {
    const user = undefined;
    const fade = {
        otherTrackId: B,
        role: 'outgoing' as const,
        remainingMs: 5_000,
        durationMs: 6_000,
    };
    const live = async () => (await resolveMusicSessionLiveInfo(sql, ['s1'])).get('s1');

    it('records the next track and the fade from an ACTIVE heartbeat', async () => {
        await applyMusicHeartbeatLiveInfo(sql, 's1', user, {
            status: 'ACTIVE',
            nextTrackId: A,
            crossfade: fade,
        });
        const info = await live();
        expect(info?.nextTrack?.mediaId).toBe(A);
        expect(info?.crossfade?.otherTrack.mediaId).toBe(B);
    });

    it('an omitted crossfade leaves the stored fade alone; null clears it', async () => {
        await applyMusicHeartbeatLiveInfo(sql, 's1', user, { status: 'ACTIVE', crossfade: fade });
        await applyMusicHeartbeatLiveInfo(sql, 's1', user, { status: 'ACTIVE' });
        expect((await live())?.crossfade).toBeDefined();
        await applyMusicHeartbeatLiveInfo(sql, 's1', user, { status: 'ACTIVE', crossfade: null });
        expect((await live())?.crossfade).toBeUndefined();
    });

    it('a fade sent with PAUSED counts as cleared', async () => {
        await applyMusicHeartbeatLiveInfo(sql, 's1', user, { status: 'ACTIVE', crossfade: fade });
        await applyMusicHeartbeatLiveInfo(sql, 's1', user, { status: 'PAUSED', crossfade: fade });
        expect((await live())?.crossfade).toBeUndefined();
    });

    it('PAUSED with no crossfade field clears a stored fade', async () => {
        await applyMusicHeartbeatLiveInfo(sql, 's1', user, { status: 'ACTIVE', crossfade: fade });
        await applyMusicHeartbeatLiveInfo(sql, 's1', user, { status: 'PAUSED' });
        expect((await live())?.crossfade).toBeUndefined();
    });

    it('COMPLETED clears both extras even when it carries a next track', async () => {
        await applyMusicHeartbeatLiveInfo(sql, 's1', user, {
            status: 'ACTIVE',
            nextTrackId: A,
            crossfade: fade,
        });
        await applyMusicHeartbeatLiveInfo(sql, 's1', user, { status: 'COMPLETED', nextTrackId: A });
        expect(await live()).toBeUndefined();
    });

    it('never stores a track the session owner may not access', async () => {
        access.restricted = true;
        access.denied.add(B);
        await applyMusicHeartbeatLiveInfo(sql, 's1', user, {
            status: 'ACTIVE',
            nextTrackId: B,
            crossfade: fade,
        });
        expect(stores['music-next-track-v1'].has('s1')).toBe(false);
        expect(stores['music-crossfade-v1'].has('s1')).toBe(false);
    });

    it('caps the time left at the fade length', async () => {
        await recordMusicCrossfade(
            's1',
            { otherTrackId: B, role: 'incoming', remainingMs: 60_000, durationMs: 4_000 },
            1_000_000,
        );
        const info = await resolveMusicSessionLiveInfo(sql, ['s1'], 1_000_000);
        expect(info.get('s1')?.crossfade?.remainingMs).toBe(4_000);
    });
});
