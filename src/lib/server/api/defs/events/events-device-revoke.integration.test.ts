// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Seam test: a device logout / revoke closes that device's open
 * `GET /api/v1/events` stream — on the revoking replica and, through the real
 * auth-cache bus on Valkey, on the others — and leaves the user's other
 * devices and cookie sessions streaming.
 *
 * Streams are opened through the real JWT branch of forward-auth
 * (`resolveAuth`) and the real events def; revokes go through
 * `device-session-revocation.ts` or a bus message from "another replica".
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { getTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { features } from '$lib/server/config.js';
import { resolveAuth } from '$lib/server/middleware/forward-auth.js';
import { mount } from '$lib/server/api/mount.js';
import { def as eventsDef } from '$lib/server/api/defs/events/index.js';
import { generateAccessToken } from '$lib/server/oauth/jwt.js';
import { getRefreshTokenService } from '$lib/server/oauth/refresh-token.service.js';
import { _resetDeviceSessionLivenessForTests } from '$lib/server/oauth/device-session-liveness.js';
import { revokeDeviceSession } from '$lib/server/oauth/device-session-revocation.js';
import {
    AUTH_CACHE_INVALIDATION_CHANNEL,
    startAuthCacheInvalidationSubscriber,
} from '$lib/server/cache/auth-cache-bus.js';
import { connectValkey, publishMessage } from '$lib/server/cache/valkey.js';

vi.mock('$app/environment', () => ({
    dev: false,
    building: false,
    browser: false,
    version: 'test',
}));

const EVENTS_URL = 'http://localhost/api/v1/events';
const noopMigration = async (): Promise<void> => undefined;
const createdUserIds: string[] = [];
const openAborts: AbortController[] = [];

interface Device {
    userId: UserId;
    username: string;
    deviceSessionId: string;
    jwt: string;
}

async function insertUser(): Promise<{ userId: UserId; username: string }> {
    const sql = getTestDb();
    const username = `itest_evr_${randomUUID().slice(0, 8)}`;
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO users (username) VALUES (${username}) RETURNING id
    `;
    createdUserIds.push(row.id);
    return { userId: toUserId(row.id), username };
}

async function loginDevice(user: { userId: UserId; username: string }): Promise<Device> {
    const deviceSessionId = randomUUID();
    await getRefreshTokenService().create({
        userId: user.userId,
        clientId: 'itest-client',
        groups: [],
        deviceSessionId,
    });
    const jwt = await generateAccessToken({
        username: user.username,
        clientId: 'itest-client',
        groups: [],
        deviceSessionId,
    });
    return { ...user, deviceSessionId, jwt };
}

function makeEvent(token: string | undefined, signal: AbortSignal): RequestEvent {
    const u = new URL(EVENTS_URL);
    const headers = new Headers();
    if (token) headers.set('authorization', `Bearer ${token}`);
    return {
        url: u,
        request: new Request(u, { method: 'GET', headers, signal }),
        route: { id: '/api/v1/events' },
        params: {},
        locals: {},
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: () => undefined,
            delete: () => undefined,
            serialize: () => '',
        },
        fetch: async () => new Response(null),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
    } as unknown as RequestEvent;
}

/** Authenticate with the device JWT (real forward-auth JWT branch). */
async function authenticate(jwt: string): Promise<RequestEvent> {
    const abort = new AbortController();
    openAborts.push(abort);
    const event = makeEvent(jwt, abort.signal);
    const res = await resolveAuth(event, noopMigration, true);
    expect(res).toBeUndefined();
    return event;
}

/** Open the stream on an authenticated event and read past the bootstrap frame. */
async function openStream(event: RequestEvent): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const res = await mount(eventsDef, { surface: 'v1' }).GET!(event);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    return reader;
}

/** A cookie-session stream: locals as hooks.server.ts sets them for a browser. */
function cookieEvent(user: { userId: UserId; username: string }): RequestEvent {
    const abort = new AbortController();
    openAborts.push(abort);
    const event = makeEvent(undefined, abort.signal);
    Object.assign(event.locals as unknown as Record<string, unknown>, {
        authMethod: 'session',
        user: {
            userId: user.userId,
            username: user.username,
            groups: '',
            userGroups: [],
            hasWatchPermission: true,
            hasLiveTvPermission: false,
            hasRequestPermission: false,
            isAdmin: false,
            isModerator: false,
            maxAgeRating: null,
            isAgeRestricted: false,
            liveTvPriority: 'low',
        },
    });
    return event;
}

/** Drain until the stream ends; false if it is still open after `ms`. */
async function closesWithin(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    ms: number,
): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const r = await Promise.race([
            reader.read(),
            new Promise<'pending'>((resolve) =>
                setTimeout(() => resolve('pending'), deadline - Date.now()),
            ),
        ]);
        if (r === 'pending') return false;
        if (r.done) return true;
    }
    return false;
}

describe('GET /api/v1/events closes on device revoke', () => {
    beforeAll(async () => {
        vi.spyOn(features, 'deviceAuth', 'get').mockReturnValue(true);
        await connectValkey();
        await startAuthCacheInvalidationSubscriber();
    });

    beforeEach(() => {
        _resetDeviceSessionLivenessForTests();
    });

    afterAll(async () => {
        for (const a of openAborts) a.abort();
        const sql = getTestDb();
        if (createdUserIds.length > 0) {
            await sql`DELETE FROM oauth_refresh_tokens WHERE user_id = ANY(${createdUserIds}::uuid[])`;
            await sql`DELETE FROM users WHERE id = ANY(${createdUserIds}::uuid[])`;
        }
        vi.restoreAllMocks();
    });

    it("a local revoke closes device A's stream; device B and a cookie stream stay open", async () => {
        const user = await insertUser();
        const a = await loginDevice(user);
        const b = await loginDevice(user);
        const streamA = await openStream(await authenticate(a.jwt));
        const streamB = await openStream(await authenticate(b.jwt));
        const streamCookie = await openStream(cookieEvent(user));

        await revokeDeviceSession(getTestDb(), a.deviceSessionId, { userId: user.userId });

        expect(await closesWithin(streamA, 2_000)).toBe(true);
        expect(await closesWithin(streamB, 300)).toBe(false);
        expect(await closesWithin(streamCookie, 300)).toBe(false);
    });

    it("a revoke on another replica (bus message) closes device A's stream here", async () => {
        const user = await insertUser();
        const a = await loginDevice(user);
        const b = await loginDevice(user);
        const streamA = await openStream(await authenticate(a.jwt));
        const streamB = await openStream(await authenticate(b.jwt));

        await publishMessage(
            AUTH_CACHE_INVALIDATION_CHANNEL,
            JSON.stringify({
                kind: 'device-session-revoked',
                deviceSessionIds: [a.deviceSessionId],
                _from: 'itest-other-replica',
            }),
        );

        expect(await closesWithin(streamA, 3_000)).toBe(true);
        expect(await closesWithin(streamB, 300)).toBe(false);
    });

    it('a revoke landing between auth and stream registration still closes the stream', async () => {
        const device = await loginDevice(await insertUser());
        const event = await authenticate(device.jwt); // auth passed while live
        await revokeDeviceSession(getTestDb(), device.deviceSessionId, {
            userId: device.userId,
        });
        const stream = await openStream(event);
        expect(await closesWithin(stream, 2_000)).toBe(true);
    });
});
