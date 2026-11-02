// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Device remote control end to end against real Postgres and Valkey: a phone
 * sends, the TV's event stream receives (and only the TV's), the TV reads its
 * inbox, reports results and state, the phone follows the command and reads
 * the state; cancel, idempotency and revoke on the way.
 *
 * Mounts the real defs; only config is mocked (feature flags).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: new Proxy(actual.config, {
            get(target, prop) {
                if (prop === 'FEATURE_DEVICE_AUTH' || prop === 'FEATURE_LIVETV') return true;
                return Reflect.get(target, prop);
            },
        }),
    };
});

import { mount } from '$lib/server/api/mount.js';
import { def as commandsDef } from './[id]/commands/index.js';
import { def as commandDef } from './[id]/commands/[commandId]/index.js';
import { def as resultDef } from './[id]/commands/[commandId]/result.js';
import { def as stateDef } from './[id]/state.js';
import { def as heartbeatDef } from './[id]/heartbeat.js';
import { userEventsHub } from '$lib/server/services/notification-events.service.js';
import { markDeviceStreamOpen } from '$lib/server/services/device-presence.service.js';
import { connectValkey } from '$lib/server/cache/valkey.js';
import { forgetDevice } from '$lib/server/services/device-commands.service.js';
import type postgres from 'postgres';

let sql: postgres.Sql;
const CTX = { surface: 'v1' as const };
const PREFIX = 'itest_devcmd';

interface Principal {
    userId: UserId;
    username: string;
    deviceSessionId: string;
}

async function makeUserWithDevices(suffix: string, sessions: string[]): Promise<Principal[]> {
    const username = `${PREFIX}_${suffix}`;
    const [row] = await sql<
        { id: string }[]
    >`INSERT INTO users (username) VALUES (${username}) RETURNING id`;
    const userId = toUserId(row.id);
    const out: Principal[] = [];
    for (const s of sessions) {
        const deviceSessionId = `itest-${suffix}-${s}`;
        await sql`
            INSERT INTO oauth_refresh_tokens (user_id, client_id, token_hash, device_id, device_session_id, created_at, expires_at)
            VALUES (${userId}, 'itest-client', ${`itest-hash-${suffix}-${s}`}, ${`dev-${suffix}-${s}`},
                    ${deviceSessionId}, NOW(), NOW() + INTERVAL '30 days')
        `;
        out.push({ userId, username, deviceSessionId });
    }
    return out;
}

function event(
    as: Principal,
    opts: {
        params: Record<string, string>;
        method?: string;
        body?: unknown;
        headers?: Record<string, string>;
    },
): RequestEvent {
    const url = 'http://localhost/api/v1/devices/x';
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : null;
    return {
        url: new URL(url),
        request: new Request(url, {
            method: opts.method ?? 'GET',
            body,
            headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...opts.headers },
        }),
        params: opts.params,
        route: { id: '/api/v1/devices/[id]/commands' as const },
        locals: {
            user: {
                userId: as.userId,
                username: as.username,
                groups: '',
                userGroups: [] as string[],
                hasWatchPermission: true,
                hasLiveTvPermission: true,
                hasRequestPermission: false,
                isAdmin: false,
                isModerator: false,
                maxAgeRating: null,
                isAgeRestricted: false,
                liveTvPriority: 'low' as const,
            },
            deviceSessionId: as.deviceSessionId,
            authMethod: 'bearer',
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

/** Opens a device's event stream on the real hub and collects frame text. */
async function openStream(
    as: Principal,
): Promise<{ text: () => string; close: () => Promise<void> }> {
    const res = await userEventsHub.streamResponse(event(as, { params: {} }) as RequestEvent, {
        targetUserId: String(as.userId),
        targetUsername: as.username,
        targetDeviceSessionId: as.deviceSessionId,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let open = true;
    void (async () => {
        while (open) {
            const next = await reader.read().catch(() => ({ done: true, value: undefined }));
            if (next.done) break;
            buffer += decoder.decode(next.value);
        }
    })();
    return {
        text: () => buffer,
        close: async () => {
            open = false;
            await reader.cancel().catch(() => {});
        },
    };
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const json = async <T>(res: Response): Promise<T> => (await res.clone().json()) as T;

beforeAll(async () => {
    sql = getTestDb();
    await connectValkey();
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    await sql`DELETE FROM oauth_refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE username LIKE ${PREFIX + '_%'})`;
    await sql`DELETE FROM users WHERE username LIKE ${PREFIX + '_%'}`;
});

describe('device remote control end to end', () => {
    it('phone → TV: delivery, inbox, result, status, state; other devices never see the command', async () => {
        const [phone, tv, ipad] = await makeUserWithDevices('a', ['phone', 'tv', 'ipad']);
        const [stranger] = await makeUserWithDevices('b', ['phone']);

        // The TV announces what it can do and holds its event stream.
        const hb = await mount(heartbeatDef, CTX).POST!(
            event(tv, {
                params: { id: tv.deviceSessionId },
                method: 'POST',
                body: {
                    deviceName: 'Living Room',
                    deviceType: 'tv',
                    capabilities: {
                        commands: {
                            'playback.pause': {},
                            'media.play': {},
                            'ui.message': { actions: 3 },
                        },
                    },
                },
            }),
        );
        expect(hb.status).toBe(200);
        const tvStream = await openStream(tv);
        const ipadStream = await openStream(ipad);
        await markDeviceStreamOpen(tv.deviceSessionId, 'itest-stream');
        await settle(100);

        // A stranger cannot command the TV (404, like an unknown device).
        const foreign = await mount(commandsDef, CTX).POST!(
            event(stranger, {
                params: { id: tv.deviceSessionId },
                method: 'POST',
                body: { type: 'playback.pause' },
            }),
        );
        expect(foreign.status).toBe(404);

        // The phone pauses the TV.
        const sent = await mount(commandsDef, CTX).POST!(
            event(phone, {
                params: { id: tv.deviceSessionId },
                method: 'POST',
                body: { type: 'playback.pause' },
                headers: { 'Idempotency-Key': 'tap-1' },
            }),
        );
        expect(sent.status).toBe(202);
        const { command } = await json<{
            command: { id: string; status: string; sender: { deviceSessionId?: string } };
        }>(sent);
        expect(command.status).toBe('pending');
        expect(command.sender.deviceSessionId).toBe(phone.deviceSessionId);

        await settle();
        expect(tvStream.text()).toContain('event: device.command');
        expect(tvStream.text()).toContain(command.id);
        expect(ipadStream.text()).not.toContain(command.id);

        // Same Idempotency-Key: the same command, nothing new.
        const again = await mount(commandsDef, CTX).POST!(
            event(phone, {
                params: { id: tv.deviceSessionId },
                method: 'POST',
                body: { type: 'playback.pause' },
                headers: { 'Idempotency-Key': 'tap-1' },
            }),
        );
        expect(again.status).toBe(200);
        expect((await json<{ command: { id: string } }>(again)).command.id).toBe(command.id);

        // The TV reads its inbox and reports.
        const inbox = await mount(commandsDef, CTX).GET!(
            event(tv, { params: { id: tv.deviceSessionId } }),
        );
        expect((await json<{ items: { id: string }[] }>(inbox)).items.map((c) => c.id)).toContain(
            command.id,
        );
        for (const status of ['delivered', 'applied']) {
            const r = await mount(resultDef, CTX).POST!(
                event(tv, {
                    params: { id: tv.deviceSessionId, commandId: command.id },
                    method: 'POST',
                    body: { status },
                }),
            );
            expect(r.status).toBe(200);
        }

        // The phone sees it applied; the inbox is empty; the iPad cannot report for the TV.
        const followed = await mount(commandDef, CTX).GET!(
            event(phone, { params: { id: tv.deviceSessionId, commandId: command.id } }),
        );
        expect((await json<{ status: string }>(followed)).status).toBe('applied');
        const forged = await mount(resultDef, CTX).POST!(
            event(ipad, {
                params: { id: tv.deviceSessionId, commandId: command.id },
                method: 'POST',
                body: { status: 'rejected' },
            }),
        );
        expect(forged.status).toBe(403);

        // The TV reports its state; the phone reads it.
        const put = await mount(stateDef, CTX).PUT!(
            event(tv, {
                params: { id: tv.deviceSessionId },
                method: 'PUT',
                body: {
                    nowPlaying: {
                        kind: 'video',
                        sessionId: 'play-1',
                        title: 'A Film',
                        positionSeconds: 120,
                        durationSeconds: 5400,
                        paused: true,
                        rate: 1,
                        availableCommands: ['playback.resume'],
                        video: { itemId: 'item-1' },
                    },
                },
            }),
        );
        expect(put.status).toBe(204);
        const state = await json<{
            nowPlaying: { title: string; reported: boolean };
            reachable: boolean;
            online: boolean;
        }>(await mount(stateDef, CTX).GET!(event(phone, { params: { id: tv.deviceSessionId } })));
        expect(state).toMatchObject({
            online: true,
            reachable: true,
            nowPlaying: { title: 'A Film', reported: true },
        });

        // A command the TV does not announce is refused up front.
        const unsupported = await mount(commandsDef, CTX).POST!(
            event(phone, {
                params: { id: tv.deviceSessionId },
                method: 'POST',
                body: { type: 'playback.setRate', args: { rate: 2 } },
            }),
        );
        expect(unsupported.status).toBe(409);

        await tvStream.close();
        await ipadStream.close();
    });

    it('a scheduled stop can be cancelled; a revoked TV loses its queue', async () => {
        const [phone, tv] = await makeUserWithDevices('c', ['phone', 'tv']);
        await mount(heartbeatDef, CTX).POST!(
            event(tv, {
                params: { id: tv.deviceSessionId },
                method: 'POST',
                body: {
                    deviceType: 'tv',
                    capabilities: { commands: { 'playback.stop': {}, 'media.play': {} } },
                },
            }),
        );
        const later = new Date(Date.now() + 30 * 60_000).toISOString();
        const sent = await mount(commandsDef, CTX).POST!(
            event(phone, {
                params: { id: tv.deviceSessionId },
                method: 'POST',
                body: { type: 'playback.stop', notBefore: later },
            }),
        );
        expect(sent.status).toBe(202);
        const { command } = await json<{ command: { id: string; delivery: string } }>(sent);
        expect(command.delivery).toBe('queued');

        const cancelled = await mount(commandDef, CTX).DELETE!(
            event(phone, {
                params: { id: tv.deviceSessionId, commandId: command.id },
                method: 'DELETE',
            }),
        );
        expect((await json<{ status: string }>(cancelled)).status).toBe('cancelled');

        const play = await mount(commandsDef, CTX).POST!(
            event(phone, {
                params: { id: tv.deviceSessionId },
                method: 'POST',
                body: { type: 'media.play', args: { kind: 'movie', itemId: 'm-1' } },
            }),
        );
        const queued = (await json<{ command: { id: string } }>(play)).command;
        await forgetDevice(tv.deviceSessionId);
        const after = await mount(commandDef, CTX).GET!(
            event(phone, { params: { id: tv.deviceSessionId, commandId: queued.id } }),
        );
        expect((await json<{ status: string }>(after)).status).toBe('expired');
    });
});
