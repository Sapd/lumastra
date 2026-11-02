// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.
/**
 * /Sessions with remote-controllable devices in it, against the
 * jellyfin-sdk-kotlin contract: an idle device holding a socket, and the
 * `controllableByUserId` / `deviceId` filtered lists remote-control UIs use.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../integration/setup/test-database.js';
import { cacheDel, connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { ensureTestUser } from '../integration/fixtures/user.fixtures.js';
import {
    DEVICE_KEYS,
    refreshPresence,
    remoteSessionId,
    upsertDevice,
} from '$lib/server/proprietary/jellyfin-compat/remote-control/device-registry';
import { callAndCheck, jfEvent, mintJfSession } from './harness';
import { GET as sessionsGet } from '../../src/routes/(proprietary)/j/Sessions/+server';

const USER_ID = '00000000-0000-4000-8000-00000000c0de';
let sql: postgres.Sql;
let token: string;
let username: string;

beforeAll(async () => {
    sql = getTestDb();
    if (!(await connectValkey())) throw new Error('Valkey not reachable (CACHE_URL)');
});
afterAll(async () => {
    await disconnectValkey();
    await closeTestDb();
});
beforeEach(async () => {
    await cacheDel(DEVICE_KEYS);
    await ensureTestUser(sql, USER_ID);
    [{ username }] = await sql<
        { username: string }[]
    >`SELECT username FROM users WHERE id = ${USER_ID}`;
    token = await mintJfSession(sql, { userId: USER_ID, username });
    // A TV that reported capabilities and holds a socket.
    await upsertDevice(
        {
            userId: USER_ID,
            username,
            displayName: null,
            deviceId: 'living-room-tv',
            deviceName: 'Living Room',
            client: 'Jellyfin Android TV',
            clientVersion: '0.19.10',
        },
        {
            playableMediaTypes: ['Video', 'Audio'],
            supportedCommands: ['DisplayMessage', 'SetVolume', 'PlayState'],
            supportsMediaControl: true,
        },
    );
    await refreshPresence([
        { sessionId: remoteSessionId(USER_ID, 'living-room-tv'), connectionId: 'c1' },
    ]);
});

const get = (name: string, path: string): Promise<unknown> =>
    callAndCheck(
        name,
        'List<SessionInfoDto>',
        sessionsGet,
        jfEvent({ method: 'GET', path, token, params: {} }),
    );

describe('/Sessions with remote control (SDK contract)', () => {
    it('lists an idle controllable device', async () => {
        const body = (await get('sessions-remote', '/j/Sessions')) as {
            Id: string;
            SupportsRemoteControl: boolean;
        }[];
        const tv = body.find((s) => s.Id === remoteSessionId(USER_ID, 'living-room-tv'));
        expect(tv?.SupportsRemoteControl).toBe(true);
    });

    it('controllableByUserId', async () => {
        const body = (await get(
            'sessions-controllable',
            `/j/Sessions?controllableByUserId=${USER_ID.replace(/-/g, '')}`,
        )) as unknown[];
        expect(body).toHaveLength(1);
    });

    it('deviceId + activeWithinSeconds', async () => {
        const body = (await get(
            'sessions-device',
            '/j/Sessions?deviceId=LIVING-ROOM-TV&activeWithinSeconds=600',
        )) as unknown[];
        expect(body).toHaveLength(1);
    });
});
