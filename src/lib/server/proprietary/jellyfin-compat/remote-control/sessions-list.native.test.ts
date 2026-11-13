// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * buildSessionList with native Lumastra devices: an idle native device is its
 * own controllable session; a playing one is merged into its play session
 * (same Id, remote-control overlay); visibility follows owner-or-admin.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSessionWithMedia } from '$lib/server/database/queries/play-sessions.queries';
import { toUserId } from '$lib/shared/user-id';
import type { NativeDeviceView } from './native-devices';

const h = vi.hoisted(() => ({
    active: [] as unknown[],
    ended: [] as unknown[],
    native: [] as unknown[],
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
vi.mock('./native-devices', async (orig) => {
    const actual = await orig<typeof import('./native-devices')>();
    return { ...actual, listNativeDevices: vi.fn(async () => h.native) };
});

const { buildSessionList } = await import('./sessions-list');

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const TV = '99999999-9999-4999-8999-999999999999';
const hex = (id: string): string => id.replace(/-/g, '');
const sql = {} as never;
const viewers = {
    alice: { userId: toUserId(ALICE), ownerIsAdmin: false },
    admin: { userId: toUserId(ADMIN), ownerIsAdmin: true },
};

function native(
    ownerUserId: string,
    over: { deviceId?: string | null; commands?: string[]; nowPlaying?: boolean } = {},
): NativeDeviceView {
    return {
        target: {
            deviceSessionId: TV,
            ownerUserId,
            ownerUsername: 'owner',
            ownerDisplayName: null,
            deviceId: over.deviceId === undefined ? 'atv-1' : over.deviceId,
            deviceName: 'Living Room',
        },
        commands: (over.commands ?? ['playback.pause', 'ui.message', 'media.play']) as never,
        state: {
            deviceSessionId: TV,
            deviceName: 'Living Room',
            deviceType: 'tv',
            online: true,
            lastSeen: new Date().toISOString(),
            reachable: true,
            capabilities: { commands: {} },
            nowPlaying: over.nowPlaying
                ? {
                      kind: 'video',
                      sessionId: 'ps',
                      title: 'The Film',
                      positionSeconds: 5,
                      paused: false,
                      rate: 1,
                      availableCommands: [],
                  }
                : null,
            textInput: null,
            party: null,
            revision: 1,
        },
    } as unknown as NativeDeviceView;
}

function playSession(id: string, userId: string, deviceId: string): ActiveSessionWithMedia {
    const seen = new Date(Date.now() - 1000).toISOString();
    return {
        id,
        user_id: userId,
        owner_username: 'owner',
        owner_display_name: null,
        device_id: deviceId,
        client_name: 'Lumastra tvOS',
        client_version: '1.0.1',
        user_agent: 'Apple TV',
        source: 'lumastra',
        status: 'ACTIVE',
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

beforeEach(() => {
    h.active = [];
    h.ended = [];
    h.native = [];
    h.devices = [];
    h.online = new Set();
});

describe('buildSessionList with native Lumastra devices', () => {
    it('lists an idle native device as a controllable session with mapped commands', async () => {
        h.native = [native(ALICE)];
        const list = await buildSessionList(sql, viewers.alice);
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
            Id: hex(TV),
            UserId: hex(ALICE),
            DeviceName: 'Living Room',
            SupportsRemoteControl: true,
            SupportsMediaControl: true,
            PlayableMediaTypes: ['Video', 'Audio'],
            SupportedCommands: ['DisplayMessage', 'Play', 'PlayMediaSource', 'DisplayContent'],
        });
    });

    it('shows what the device reports as NowPlayingItem / PlayState', async () => {
        h.native = [native(ALICE, { nowPlaying: true })];
        const [s] = await buildSessionList(sql, viewers.alice);
        expect(s.NowPlayingItem).toMatchObject({ Name: 'The Film' });
        expect(s.PlayState.IsPaused).toBe(false);
    });

    it('merges into the play session of the same device: one entry, the native Id', async () => {
        h.native = [native(ALICE)];
        h.active = [playSession('aaaaaaaa-0000-4000-8000-000000000001', ALICE, 'atv-1')];
        const list = await buildSessionList(sql, viewers.alice);
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
            Id: hex(TV),
            SupportsRemoteControl: true,
            SupportedCommands: expect.arrayContaining(['DisplayMessage']),
        });
    });

    it('a play session of another device does not swallow the native device', async () => {
        h.native = [native(ALICE)];
        h.active = [playSession('aaaaaaaa-0000-4000-8000-000000000001', ALICE, 'someone-else')];
        const list = await buildSessionList(sql, viewers.alice);
        expect(list.map((s) => s.SupportsRemoteControl).sort()).toEqual([false, true]);
    });

    it('is filtered by controllableByUserId like the others', async () => {
        h.native = [native(ALICE)];
        h.active = [playSession('aaaaaaaa-0000-4000-8000-000000000001', ALICE, 'someone-else')];
        const list = await buildSessionList(sql, viewers.alice, { controllableByUserId: ALICE });
        expect(list.map((s) => s.Id)).toEqual([hex(TV)]);
    });

    it('an admin sees another user’s device, restricted to the admin commands (already narrowed by the list)', async () => {
        h.native = [native(BOB, { commands: ['ui.message', 'playback.stop'] })];
        const list = await buildSessionList(sql, viewers.admin);
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
            UserId: hex(BOB),
            SupportedCommands: ['DisplayMessage'],
            PlayableMediaTypes: [],
        });
    });

    it('a device with a null client device id still lists on its own', async () => {
        h.native = [native(ALICE, { deviceId: null })];
        h.active = [playSession('aaaaaaaa-0000-4000-8000-000000000001', ALICE, 'atv-1')];
        expect(await buildSessionList(sql, viewers.alice)).toHaveLength(2);
    });

    describe('a device that is both a /j registry record and a native session', () => {
        const REGISTRY_ID = 'c'.repeat(32);
        const record = {
            id: REGISTRY_ID,
            userId: ALICE,
            username: 'alice',
            displayName: null,
            deviceId: 'atv-1',
            deviceName: 'Living Room',
            client: 'Lumastra tvOS',
            clientVersion: '1.0.1',
            playableMediaTypes: ['Video'],
            supportedCommands: ['DisplayMessage'],
            supportsMediaControl: true,
            lastActivityAt: Date.now(),
        };

        it('idle: the registry entry is listed once, without a second native entry', async () => {
            h.devices = [record];
            h.online = new Set([REGISTRY_ID]);
            h.native = [native(ALICE)];
            const list = await buildSessionList(sql, viewers.alice);
            expect(list.map((s) => s.Id)).toEqual([REGISTRY_ID]);
        });

        it('playing: the play session carries the registry overlay, no native duplicate', async () => {
            h.devices = [record];
            h.online = new Set([REGISTRY_ID]);
            h.native = [native(ALICE)];
            h.active = [playSession('aaaaaaaa-0000-4000-8000-000000000001', ALICE, 'atv-1')];
            const list = await buildSessionList(sql, viewers.alice);
            expect(list).toHaveLength(1);
            expect(list[0].Id).toBe(REGISTRY_ID);
        });

        it('a registry record that is no longer listed (idle too long) does not hide the native view', async () => {
            h.devices = [{ ...record, lastActivityAt: Date.now() - 3_600_000 }];
            h.native = [native(ALICE)];
            const list = await buildSessionList(sql, viewers.alice);
            expect(list.map((s) => s.Id)).toEqual([hex(TV)]);
        });
    });
});
