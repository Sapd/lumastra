// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * buildSessionList over mocked play sessions and registry devices:
 * visibility (own vs admin) for fresh and ghost sessions, and the merge of a
 * registry device into its play session.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSessionWithMedia } from '$lib/server/database/queries/play-sessions.queries';
import { toUserId } from '$lib/shared/user-id';
import type { RemoteDeviceRecord } from './device-registry';

const h = vi.hoisted(() => ({
    active: [] as unknown[],
    ended: [] as unknown[],
    devices: [] as unknown[],
    online: new Set<string>(),
}));

vi.mock('$lib/server/database/queries/play-sessions.queries', () => ({
    getAllActiveSessionsWithMedia: vi.fn(async () => h.active),
    getRecentlyEndedSessions: vi.fn(async () => h.ended),
}));
vi.mock('$lib/server/database/queries/jellyfin-item-detail.queries', () => ({
    getItemDetail: vi.fn(async () => null),
}));
vi.mock('../content-language', () => ({ applyJellyfinContentLanguage: vi.fn(async () => {}) }));
vi.mock('../provider-ids-enrichment', () => ({
    enrichItemsWithProviderIds: vi.fn(async () => {}),
}));
vi.mock('../music-artists-enrichment', () => ({
    enrichItemsWithMusicArtists: vi.fn(async () => {}),
}));
vi.mock('./device-registry', async (orig) => {
    const actual = await orig<typeof import('./device-registry')>();
    return {
        ...actual,
        listDevices: vi.fn(async () => h.devices),
        getOnlineSessionIds: vi.fn(async () => h.online),
    };
});

const { buildSessionList } = await import('./sessions-list');
const { remoteSessionId } = await import('./device-registry');

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '44444444-4444-4444-8444-444444444444';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const hex = (id: string): string => id.replace(/-/g, '');

const viewers = {
    alice: { userId: toUserId(ALICE), ownerIsAdmin: false },
    admin: { userId: toUserId(ADMIN), ownerIsAdmin: true },
};

function playSession(
    id: string,
    userId: string,
    deviceId: string,
    ageMs: number,
): ActiveSessionWithMedia {
    const seen = new Date(Date.now() - ageMs).toISOString();
    return {
        id,
        user_id: userId,
        owner_username: `user-${userId.slice(0, 4)}`,
        owner_display_name: null,
        device_id: deviceId,
        client_name: 'Jellyfin Android TV',
        client_version: '0.19.0',
        user_agent: 'TV',
        source: 'jellyfin',
        status: 'PLAYING',
        position_ms: 1000,
        play_method: 'direct',
        media_id: null,
        last_heartbeat_at: seen,
        last_seen_at: seen,
        album_name: null,
        album_id: null,
        artist_name: null,
        file_path: null,
    } as unknown as ActiveSessionWithMedia;
}

function device(userId: string, deviceId: string): RemoteDeviceRecord {
    return {
        id: remoteSessionId(userId, deviceId),
        userId,
        username: 'u',
        displayName: null,
        deviceId,
        deviceName: 'TV',
        client: 'Jellyfin Android TV',
        clientVersion: '0.19.0',
        playableMediaTypes: ['Video'],
        supportedCommands: ['DisplayMessage'],
        supportsMediaControl: true,
        lastActivityAt: Date.now(),
    };
}

const sql = {} as never;

beforeEach(() => {
    h.active = [];
    h.ended = [];
    h.devices = [];
    h.online = new Set();
});

describe('buildSessionList', () => {
    beforeEach(() => {
        h.active = [
            playSession('aaaaaaaa-0000-4000-8000-000000000001', ALICE, 'alice-tv', 1_000),
            playSession('bbbbbbbb-0000-4000-8000-000000000001', BOB, 'bob-tv', 1_000),
            // Stale (> 5 min): CAROL's ghost entry.
            playSession('cccccccc-0000-4000-8000-000000000001', CAROL, 'carol-tv', 600_000),
        ];
        // BOB also has a recently ended session; he has a fresh one, so no ghost.
        h.ended = [playSession('bbbbbbbb-0000-4000-8000-000000000002', BOB, 'bob-phone', 30_000)];
    });

    it('a non-admin sees only their own sessions: no one else’s fresh or ghost entry', async () => {
        const list = await buildSessionList(sql, viewers.alice);
        expect(list.map((s) => s.UserId)).toEqual([hex(ALICE)]);
    });

    it('an admin sees every user’s fresh session and the ghost of a user with none', async () => {
        const list = await buildSessionList(sql, viewers.admin);
        expect(list.map((s) => s.UserId).sort()).toEqual([hex(ALICE), hex(BOB), hex(CAROL)].sort());
        const carol = list.find((s) => s.UserId === hex(CAROL));
        expect(carol?.NowPlayingItem).toBeUndefined();
    });

    it('merges a registry device into its play session: one entry, the remote Id, controllable', async () => {
        const tv = device(ALICE, 'alice-tv');
        h.devices = [tv, device(BOB, 'bob-tv')];
        h.online = new Set([tv.id]);

        const first = await buildSessionList(sql, viewers.alice);
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({
            Id: tv.id,
            DeviceId: 'alice-tv',
            SupportsRemoteControl: true,
            PlayableMediaTypes: ['Video'],
        });

        // Playback stops: the idle device keeps the same Id.
        h.active = [];
        h.ended = [];
        const idle = await buildSessionList(sql, viewers.alice);
        expect(idle).toHaveLength(1);
        expect(idle[0]).toMatchObject({ Id: tv.id, SupportsRemoteControl: true });
    });

    it('does not list another user’s idle registry device to a non-admin', async () => {
        h.active = [];
        h.ended = [];
        const bobTv = device(BOB, 'bob-tv');
        h.devices = [bobTv];
        h.online = new Set([bobTv.id]);
        expect(await buildSessionList(sql, viewers.alice)).toEqual([]);
        expect((await buildSessionList(sql, viewers.admin)).map((s) => s.Id)).toEqual([bobTv.id]);
    });
});
