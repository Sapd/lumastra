// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Route tests for the /j/Sessions/{sessionId}/… remote-control commands:
 * parameter validation, authorization (own device / someone else's / admin),
 * item access, and the exact message handed to the fan-out.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteDeviceRecord } from '$lib/server/proprietary/jellyfin-compat/remote-control/device-registry';

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: unknown) => handler,
}));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) }));

const devices = new Map<string, RemoteDeviceRecord>();
vi.mock('$lib/server/proprietary/jellyfin-compat/remote-control/device-registry', async (orig) => {
    const actual =
        await orig<
            typeof import('$lib/server/proprietary/jellyfin-compat/remote-control/device-registry')
        >();
    return {
        ...actual,
        getDevice: vi.fn(async (id: string) => devices.get(id) ?? null),
    };
});

const playSessions = new Map<string, { user_id: string; device_id: string }>();
vi.mock('$lib/server/database/queries/play-sessions.queries', () => ({
    getSessionById: vi.fn(async (_sql: unknown, id: string) => playSessions.get(id) ?? null),
}));

const sent: { sessionId: string; message: Record<string, unknown> }[] = [];
vi.mock('$lib/server/proprietary/jellyfin-compat/remote-control/fanout', () => ({
    sendToSession: vi.fn(async (sessionId: string, message: Record<string, unknown>) => {
        sent.push({ sessionId, message });
        return 1;
    }),
    ensureFanoutSubscription: vi.fn(async () => true),
}));

const hiddenItems = new Set<string>();
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn(
        async (_sql: unknown, id: string, user: { userId: string }) =>
            !hiddenItems.has(`${user.userId}:${id}`) && !hiddenItems.has(`*:${id}`),
    ),
}));
vi.mock('$lib/server/auth/resolve-token-user-access', () => ({
    resolveTokenUserAccess: vi.fn(async () => ({
        userGroups: [],
        permissions: { ownerIsAdmin: false },
        disabled: false,
        deleted: false,
    })),
}));

const { remoteSessionId } =
    await import('$lib/server/proprietary/jellyfin-compat/remote-control/device-registry');
const { POST: playPost } = await import('./Playing/+server.js');
const { POST: playstatePost } = await import('./Playing/[command]/+server.js');
const { POST: commandPost } = await import('./Command/+server.js');
const { POST: namedCommandPost } = await import('./Command/[command]/+server.js');
const { POST: systemPost } = await import('./System/[command]/+server.js');
const { POST: messagePost } = await import('./Message/+server.js');
const { POST: viewingPost } = await import('./Viewing/+server.js');
const { POST: addUserPost, DELETE: removeUserDelete } = await import('./User/[userId]/+server.js');

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const ITEM = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
const ITEM_DASHED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const aliceTv = remoteSessionId(ALICE, 'alice-tv');
const bobTv = remoteSessionId(BOB, 'bob-tv');

function record(
    id: string,
    userId: string,
    username: string,
    deviceId: string,
): RemoteDeviceRecord {
    return {
        id,
        userId,
        username,
        displayName: null,
        deviceId,
        deviceName: 'TV',
        client: 'Jellyfin Android TV',
        clientVersion: '0.19.10',
        playableMediaTypes: ['Video'],
        supportedCommands: ['DisplayMessage'],
        supportsMediaControl: true,
        lastActivityAt: Date.now(),
    };
}

const users = {
    alice: { userId: ALICE, username: 'alice', ownerIsAdmin: false },
    bob: { userId: BOB, username: 'bob', ownerIsAdmin: false },
    admin: { userId: ADMIN, username: 'root', ownerIsAdmin: true },
    quickConnectAdmin: { userId: ADMIN, username: 'root', ownerIsAdmin: true },
};

function ev(
    as: keyof typeof users,
    path: string,
    params: Record<string, string>,
    body?: unknown,
): never {
    const url = new URL(`https://app.example/j/Sessions/${params.sessionId}${path}`);
    return {
        request: new Request(url, {
            method: 'POST',
            body: body === undefined ? undefined : JSON.stringify(body),
        }),
        url,
        params,
        locals: {
            user: users[as],
            principal: { isAdmin: as === 'admin' },
            jfDevice: { deviceId: `${as}-phone` },
        },
    } as never;
}

beforeEach(() => {
    sent.length = 0;
    devices.clear();
    playSessions.clear();
    hiddenItems.clear();
    devices.set(aliceTv, record(aliceTv, ALICE, 'alice', 'alice-tv'));
    devices.set(bobTv, record(bobTv, BOB, 'bob', 'bob-tv'));
});

describe('POST /Sessions/{id}/Playing/{command}', () => {
    it('sends a Playstate message to the caller’s own device', async () => {
        const res = await playstatePost(
            ev('alice', '/Playing/Seek?seekPositionTicks=600000000', {
                sessionId: aliceTv,
                command: 'seek',
            }),
        );
        expect(res.status).toBe(204);
        expect(sent).toHaveLength(1);
        expect(sent[0].sessionId).toBe(aliceTv);
        expect(sent[0].message).toMatchObject({
            MessageType: 'Playstate',
            Data: {
                Command: 'Seek',
                SeekPositionTicks: 600000000,
                ControllingUserId: ALICE.replace(/-/g, ''),
            },
        });
    });

    it('answers 404 for someone else’s device and sends nothing', async () => {
        const res = await playstatePost(
            ev('alice', '/Playing/Pause', { sessionId: bobTv, command: 'Pause' }),
        );
        expect(res.status).toBe(404);
        expect(sent).toHaveLength(0);
    });

    it('lets an admin control any device', async () => {
        const res = await playstatePost(
            ev('admin', '/Playing/Pause', { sessionId: bobTv, command: 'Pause' }),
        );
        expect(res.status).toBe(204);
        expect(sent[0].sessionId).toBe(bobTv);
    });

    it('answers 404 for an unknown session id', async () => {
        const res = await playstatePost(
            ev('admin', '/Playing/Pause', { sessionId: 'f'.repeat(32), command: 'Pause' }),
        );
        expect(res.status).toBe(404);
    });

    it('rejects an unknown command and a malformed seek position with 400', async () => {
        expect(
            (
                await playstatePost(
                    ev('alice', '/Playing/Explode', { sessionId: aliceTv, command: 'Explode' }),
                )
            ).status,
        ).toBe(400);
        expect(
            (
                await playstatePost(
                    ev('alice', '/Playing/Seek?seekPositionTicks=soon', {
                        sessionId: aliceTv,
                        command: 'Seek',
                    }),
                )
            ).status,
        ).toBe(400);
        expect(sent).toHaveLength(0);
    });

    it('resolves a play-session id to the device that is playing', async () => {
        const playSessionId = '44444444-4444-4444-8444-444444444444';
        playSessions.set(playSessionId, { user_id: ALICE, device_id: 'alice-tv' });
        const res = await playstatePost(
            ev('alice', '/Playing/Stop', {
                sessionId: playSessionId.replace(/-/g, ''),
                command: 'Stop',
            }),
        );
        expect(res.status).toBe(204);
        expect(sent[0].sessionId).toBe(aliceTv);
    });

    it('does not let a play-session id reach someone else’s device', async () => {
        const playSessionId = '55555555-5555-4555-8555-555555555555';
        playSessions.set(playSessionId, { user_id: BOB, device_id: 'bob-tv' });
        const res = await playstatePost(
            ev('alice', '/Playing/Stop', { sessionId: playSessionId, command: 'Stop' }),
        );
        expect(res.status).toBe(404);
    });
});

describe('POST /Sessions/{id}/Playing', () => {
    it('sends a Play message with every PlayRequest field', async () => {
        const res = await playPost(
            ev(
                'alice',
                `/Playing?playCommand=playnext&itemIds=${ITEM}&startPositionTicks=10&audioStreamIndex=2&subtitleStreamIndex=-1&mediaSourceId=ms1&startIndex=0`,
                { sessionId: aliceTv },
            ),
        );
        expect(res.status).toBe(204);
        expect(sent[0].message).toMatchObject({
            MessageType: 'Play',
            Data: {
                ItemIds: [ITEM],
                PlayCommand: 'PlayNext',
                StartPositionTicks: 10,
                AudioStreamIndex: 2,
                SubtitleStreamIndex: -1,
                MediaSourceId: 'ms1',
                StartIndex: 0,
                ControllingUserId: ALICE.replace(/-/g, ''),
            },
        });
    });

    it('sends PlayShuffle and PlayInstantMix as PlayNow, as Jellyfin does', async () => {
        await playPost(
            ev('alice', `/Playing?playCommand=PlayShuffle&itemIds=${ITEM}`, { sessionId: aliceTv }),
        );
        await playPost(
            ev('alice', `/Playing?playCommand=PlayInstantMix&itemIds=${ITEM}`, {
                sessionId: aliceTv,
            }),
        );
        expect(sent.map((s) => (s.message.Data as { PlayCommand: string }).PlayCommand)).toEqual([
            'PlayNow',
            'PlayNow',
        ]);
    });

    it('validates playCommand, itemIds and integer params', async () => {
        for (const q of [
            `?itemIds=${ITEM}`,
            `?playCommand=Teleport&itemIds=${ITEM}`,
            '?playCommand=PlayNow',
            '?playCommand=PlayNow&itemIds=not-a-guid',
            `?playCommand=PlayNow&itemIds=${ITEM}&startIndex=first`,
        ]) {
            const res = await playPost(ev('alice', `/Playing${q}`, { sessionId: aliceTv }));
            expect(res.status, q).toBe(400);
        }
        expect(sent).toHaveLength(0);
    });

    it('rejects more than 500 itemIds with 400 and sends nothing', async () => {
        const ids = Array.from({ length: 501 }, (_, i) => i.toString(16).padStart(32, '0'));
        const res = await playPost(
            ev('alice', `/Playing?playCommand=PlayNow&itemIds=${ids.join(',')}`, {
                sessionId: aliceTv,
            }),
        );
        expect(res.status).toBe(400);
        expect(sent).toHaveLength(0);
    });

    it('answers 404 when the caller cannot see an item', async () => {
        hiddenItems.add(`${ALICE}:${ITEM_DASHED}`);
        const res = await playPost(
            ev('alice', `/Playing?playCommand=PlayNow&itemIds=${ITEM}`, { sessionId: aliceTv }),
        );
        expect(res.status).toBe(404);
        expect(sent).toHaveLength(0);
    });

    it('answers 404 when an admin casts an item the target’s owner cannot see', async () => {
        hiddenItems.add(`${BOB}:${ITEM_DASHED}`);
        const res = await playPost(
            ev('admin', `/Playing?playCommand=PlayNow&itemIds=${ITEM}`, { sessionId: bobTv }),
        );
        expect(res.status).toBe(404);
        expect(sent).toHaveLength(0);
    });
});

describe('GeneralCommand routes', () => {
    it('/Command/{command} and /System/{command} send a bare GeneralCommand', async () => {
        expect(
            (
                await namedCommandPost(
                    ev('alice', '/Command/GoHome', { sessionId: aliceTv, command: 'gohome' }),
                )
            ).status,
        ).toBe(204);
        expect(
            (
                await systemPost(
                    ev('alice', '/System/ToggleMute', {
                        sessionId: aliceTv,
                        command: 'ToggleMute',
                    }),
                )
            ).status,
        ).toBe(204);
        expect(sent.map((s) => s.message.Data)).toEqual([
            { Name: 'GoHome', ControllingUserId: ALICE.replace(/-/g, ''), Arguments: {} },
            { Name: 'ToggleMute', ControllingUserId: ALICE.replace(/-/g, ''), Arguments: {} },
        ]);
    });

    it('/Command takes a GeneralCommand body and overwrites ControllingUserId', async () => {
        const res = await commandPost(
            ev(
                'alice',
                '/Command',
                { sessionId: aliceTv },
                {
                    Name: 'SetVolume',
                    ControllingUserId: BOB,
                    Arguments: { Volume: '30' },
                },
            ),
        );
        expect(res.status).toBe(204);
        expect(sent[0].message.Data).toEqual({
            Name: 'SetVolume',
            ControllingUserId: ALICE.replace(/-/g, ''),
            Arguments: { Volume: '30' },
        });
    });

    it('rejects unknown command names and bodies with 400', async () => {
        expect(
            (
                await namedCommandPost(
                    ev('alice', '/Command/Reboot', { sessionId: aliceTv, command: 'Reboot' }),
                )
            ).status,
        ).toBe(400);
        expect(
            (await commandPost(ev('alice', '/Command', { sessionId: aliceTv }, {}))).status,
        ).toBe(400);
    });

    it('/Command DisplayContent with an item the target’s owner cannot see is 404, nothing sent', async () => {
        hiddenItems.add(`${BOB}:${ITEM_DASHED}`);
        const res = await commandPost(
            ev(
                'admin',
                '/Command',
                { sessionId: bobTv },
                { Name: 'DisplayContent', Arguments: { ItemId: ITEM, ItemType: 'Movie' } },
            ),
        );
        expect(res.status).toBe(404);
        expect(sent).toHaveLength(0);
    });

    it('/Command checks every item-carrying command, ItemIds lists and key case', async () => {
        hiddenItems.add(`${ALICE}:${ITEM_DASHED}`);
        const other = 'ffffffffffffffffffffffffffffffff';
        for (const body of [
            { Name: 'PlayMediaSource', Arguments: { ItemId: ITEM } },
            { Name: 'PlayTrailers', Arguments: { itemid: ITEM } },
            { Name: 'PlayNext', Arguments: { ItemIds: `${other},${ITEM}` } },
            { Name: 'SetShuffleQueue', Arguments: { ItemIds: ITEM } },
            { Name: 'Play', Arguments: { ItemIds: ITEM } },
        ]) {
            const res = await commandPost(ev('alice', '/Command', { sessionId: aliceTv }, body));
            expect(res.status, body.Name).toBe(404);
        }
        const bad = await commandPost(
            ev(
                'alice',
                '/Command',
                { sessionId: aliceTv },
                { Name: 'DisplayContent', Arguments: { ItemId: 'nope' } },
            ),
        );
        expect(bad.status).toBe(400);
        expect(sent).toHaveLength(0);

        // A visible item goes through.
        const ok = await commandPost(
            ev(
                'alice',
                '/Command',
                { sessionId: aliceTv },
                { Name: 'DisplayContent', Arguments: { ItemId: other } },
            ),
        );
        expect(ok.status).toBe(204);
        expect(sent).toHaveLength(1);
    });

    it('/Command SetShuffleQueue takes 400 comma-joined ItemIds (still access-checked); 501 is 400', async () => {
        const ids = (n: number): string[] =>
            Array.from({ length: n }, (_, i) => `1${i.toString(16).padStart(31, '0')}`);
        const ok = await commandPost(
            ev(
                'alice',
                '/Command',
                { sessionId: aliceTv },
                { Name: 'SetShuffleQueue', Arguments: { ItemIds: ids(400).join(',') } },
            ),
        );
        expect(ok.status).toBe(204);
        expect(sent).toHaveLength(1);

        // One hidden id among the 400 refuses the whole queue.
        const hidden = ids(400)[123];
        hiddenItems.add(
            `${ALICE}:${hidden.slice(0, 8)}-${hidden.slice(8, 12)}-${hidden.slice(12, 16)}-${hidden.slice(16, 20)}-${hidden.slice(20)}`,
        );
        const denied = await commandPost(
            ev(
                'alice',
                '/Command',
                { sessionId: aliceTv },
                { Name: 'SetShuffleQueue', Arguments: { ItemIds: ids(400).join(',') } },
            ),
        );
        expect(denied.status).toBe(404);

        const tooMany = await commandPost(
            ev(
                'alice',
                '/Command',
                { sessionId: aliceTv },
                { Name: 'SetShuffleQueue', Arguments: { ItemIds: ids(501).join(',') } },
            ),
        );
        expect(tooMany.status).toBe(400);
        expect(sent).toHaveLength(1);
    });

    it('rejects oversized /Command Arguments and /Message Text with 400', async () => {
        const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v']));
        const big = 'x'.repeat(4097);
        for (const body of [
            { Name: 'GoHome', Arguments: many },
            { Name: 'SendString', Arguments: { String: big } },
        ]) {
            const res = await commandPost(ev('alice', '/Command', { sessionId: aliceTv }, body));
            expect(res.status).toBe(400);
        }
        for (const body of [{ Text: big }, { Text: 'x', Header: big }]) {
            const res = await messagePost(ev('alice', '/Message', { sessionId: aliceTv }, body));
            expect(res.status).toBe(400);
        }
        expect(sent).toHaveLength(0);
    });

    it('/Message sends DisplayMessage; someone else’s device is 404', async () => {
        const ok = await messagePost(
            ev('alice', '/Message', { sessionId: aliceTv }, { Text: 'Dinner', TimeoutMs: 3000 }),
        );
        expect(ok.status).toBe(204);
        expect(sent[0].message.Data).toMatchObject({
            Name: 'DisplayMessage',
            Arguments: { Header: 'Message from Server', Text: 'Dinner', TimeoutMs: '3000' },
        });
        const denied = await messagePost(
            ev('alice', '/Message', { sessionId: bobTv }, { Text: 'x' }),
        );
        expect(denied.status).toBe(404);
        expect(
            (await messagePost(ev('alice', '/Message', { sessionId: aliceTv }, {}))).status,
        ).toBe(400);
    });

    it('/Viewing sends DisplayContent with ItemId, ItemName, ItemType', async () => {
        const res = await viewingPost(
            ev('alice', `/Viewing?itemType=movie&itemId=${ITEM}&itemName=Alien`, {
                sessionId: aliceTv,
            }),
        );
        expect(res.status).toBe(204);
        expect(sent[0].message.Data).toMatchObject({
            Name: 'DisplayContent',
            Arguments: { ItemId: ITEM, ItemName: 'Alien', ItemType: 'Movie' },
        });
        expect(
            (
                await viewingPost(
                    ev('alice', `/Viewing?itemType=Rocket&itemId=${ITEM}&itemName=x`, {
                        sessionId: aliceTv,
                    }),
                )
            ).status,
        ).toBe(400);
    });
});

describe('/Sessions/{id}/User/{userId}', () => {
    it('is a 204 no-op on a controllable session, 404 otherwise', async () => {
        const params = { sessionId: aliceTv, userId: BOB.replace(/-/g, '') };
        expect((await addUserPost(ev('alice', '/User', params))).status).toBe(204);
        expect((await removeUserDelete(ev('alice', '/User', params))).status).toBe(204);
        expect(
            (await addUserPost(ev('alice', '/User', { sessionId: bobTv, userId: ALICE }))).status,
        ).toBe(404);
        expect(
            (await addUserPost(ev('alice', '/User', { sessionId: aliceTv, userId: 'nope' })))
                .status,
        ).toBe(400);
        expect(sent).toHaveLength(0);
    });
});

it('a Quick Connect admin cannot control another owner Jellyfin device', async () => {
    expect(
        (
            await messagePost(
                ev('quickConnectAdmin', '/Message', { sessionId: bobTv }, { Text: 'foreign' }),
            )
        ).status,
    ).toBe(404);
    expect(sent).toEqual([]);
});
