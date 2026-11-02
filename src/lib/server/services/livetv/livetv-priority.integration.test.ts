// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Live TV priority eviction, end to end on the app side.
 *
 * Real: Valkey (sessions, kicked flags, the priority lock), the session and priority
 * services, the mounted /stream, /keepalive and /leave endpoints, a bounded slot-accounting test double, and
 * the permission resolution that decides a viewer's priority (admin, IdP group,
 * in-app access group from PostgreSQL).
 *
 * Faked: the HTTP hop to the proxy (an adapter calls the multiplexer directly) and the
 * provider's channel lookup (every channel belongs to one test source allowing ONE
 * concurrent stream, like a single-connection IPTV account).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import type { LiveTvStreamInfo } from '$lib/schemas/livetv.js';

const { SOURCE_ID, HIGH_GROUP } = vi.hoisted(() => ({
    SOURCE_ID: `src-prio-${Math.random().toString(36).slice(2)}`,
    HIGH_GROUP: 'tv-family',
}));

vi.mock('$lib/server/config', async (importOriginal) => {
    const real = await importOriginal<typeof import('$lib/server/config')>();
    const overrides: Record<string, unknown> = {
        FEATURE_LIVETV: true,
        LIVETV_ADAPTIVE_LADDER_ENABLED: false,
        LIVETV_KICK_POLICY: 'shortest',
        LIVETV_HIGH_PRIORITY_GROUPS: [HIGH_GROUP],
        ADMIN_GROUPS: ['admin'],
        LIVETV_GROUPS: [HIGH_GROUP],
    };
    return {
        ...real,
        config: new Proxy(real.config, {
            get: (target, key, receiver) =>
                typeof key === 'string' && key in overrides
                    ? overrides[key]
                    : Reflect.get(target, key, receiver),
        }),
    };
});

const mux = vi.hoisted(() => ({
    current: null as
        null | import('../../../../../tests/helpers/proxy-slot-double.js').ProxySlotDouble,
    maxStreams: 1,
}));

vi.mock('$lib/server/services/livetv/stream-proxy-client.js', () => {
    const client = {
        joinChannel: async (channelId: string, request: Record<string, unknown>) =>
            (await mux.current!.join(channelId, request as never)).body,
        leaveChannel: async (channelId: string, viewerId: string) =>
            mux.current!.leave(channelId, viewerId),
        heartbeat: async (channelId: string, viewerId: string) =>
            mux.current!.heartbeat(channelId, viewerId),
        getProxyStatus: async () => ({ channels: mux.current!.getStatusData().channels }),
    };
    return { getStreamProxyClient: () => client };
});

vi.mock('$lib/server/services/livetv/index.js', async () => {
    const { StreamLimitError } =
        await import('$lib/server/services/livetv/standalone-livetv-provider.js');
    const { getStreamProxyClient } =
        await import('$lib/server/services/livetv/stream-proxy-client.js');
    const provider = {
        async getStreamInfo(channelId: string, viewerId: string): Promise<LiveTvStreamInfo> {
            const result = (await getStreamProxyClient().joinChannel(channelId, {
                viewerId,
                streamUrls: ['http://iptv.example.invalid/live.ts'],
                sourceId: SOURCE_ID,
                maxStreams: mux.maxStreams,
                channelName: `Channel ${channelId.slice(0, 4)}`,
            })) as { error?: string; limit?: number; active?: never[] };
            if (result.error === 'stream_limit_reached') {
                throw new StreamLimitError(result.limit!, result.active!, SOURCE_ID);
            }
            if (result.error) throw new Error(result.error);
            return {
                streamUrl: `/api/livetv/channels/${channelId}/stream/master.m3u8`,
                requiresProxy: true,
                sourceId: SOURCE_ID,
                maxStreams: mux.maxStreams,
                rungId: null,
                requestedMaxBitrateBps: null,
                appliedMaxBitrateBps: null,
                appliedMaxHeight: null,
                reason: null,
            };
        },
    };
    return { getLiveTvProvider: async () => provider };
});

// The lineup gate is tested on its own; here every channel is in the viewer's lineup.
// The lineup gate is not what this suite tests: every channel is streamable.
vi.mock('$lib/server/services/livetv/station.service.js', async (original) => ({
    ...(await original<typeof import('$lib/server/services/livetv/station.service.js')>()),
    resolveStation: async (stationId: string) => ({
        stationId,
        shownFeedId: stationId,
        groupId: null,
    }),
}));
vi.mock('$lib/server/services/livetv/channel-access.js', () => ({
    canStreamLiveTvChannel: async () => true,
    canReadLiveTvChannelStream: async () => true,
    clearLiveTvStreamReadCache: () => {},
}));

import { connectValkey, disconnectValkey, getCoordinationClient } from '$lib/server/cache/valkey';
import { mount } from '$lib/server/api/mount.js';
import { def as streamDef } from '$lib/server/api/defs/livetv/playback-sessions/index.js';
import { def as keepaliveDef } from '$lib/server/api/defs/livetv/playback-sessions/[playbackSessionId]/keepalive.js';
import { def as stateDef } from '$lib/server/api/defs/livetv/playback-sessions/[playbackSessionId].js';
import { def as leaveDef } from '$lib/server/api/defs/livetv/playback-sessions/[playbackSessionId]/leave.js';
import { getLiveTvSessionService } from './livetv-session.service';
import { getLiveTvPriorityService } from './livetv-priority.service';
import { buildUserPermissions } from '$lib/server/auth';
import { resolveEffectiveAccess } from '$lib/server/services/access-control.service';
import {
    addAccessGroupMember,
    insertAccessGroup,
    insertAccessGroupCapabilities,
} from '$lib/server/database/queries/access-groups.queries.js';
import {
    ProxySlotDouble,
    createMockFfmpegManager,
} from '../../../../../tests/helpers/proxy-slot-double.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/user.fixtures.js';
import { createTestUser } from '../../../../../tests/integration/helpers/users.js';
import type { UserPermissions } from '$lib/server/auth';

const state = mount(stateDef, { surface: 'v1' });
const stream = mount(streamDef, { surface: 'v1' });
const keepalive = mount(keepaliveDef, { surface: 'v1' });
const leave = mount(leaveDef, { surface: 'v1' });

interface Viewer {
    username: string;
    credential: string;
    permissions: UserPermissions;
    /** users.id of the viewer: the playback grant is minted for a real user row. */
    userId: string;
}

function viewerKey(v: Viewer): string {
    return `${v.username}:${v.credential}`;
}

function event(v: Viewer, channelId: string, method: 'GET' | 'POST', path: string): RequestEvent {
    const url = `http://localhost/api/v1/livetv/channels/${channelId}/${path}`;
    return {
        url: new URL(url),
        request: new Request(
            url,
            path === 'stream'
                ? {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ stationId: channelId }),
                  }
                : { method },
        ),
        params: { playbackSessionId: handles.get(`${viewerKey(v)}:${channelId}`) ?? randomUUID() },
        route: { id: `/api/v1/livetv/channels/[id]/${path}` },
        locals: {
            user: {
                userId: v.userId,
                username: v.username,
                groups: '',
                userGroups: [],
                ...v.permissions,
            },
            liveTvCredentialId: v.credential,
        },
        cookies: { get: () => undefined, set: () => undefined },
        fetch,
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
    } as unknown as RequestEvent;
}

const handles = new Map<string, string>();
const sessionHandles = new Set<string>();

async function join(v: Viewer, channelId: string): Promise<Response> {
    await ensureTestUser(getTestDb(), v.userId);
    const response = await stream.POST!(event(v, channelId, 'POST', 'stream') as never);
    if (response.status === 201)
        handles.set(
            `${viewerKey(v)}:${channelId}`,
            (await response.clone().json()).playbackSessionId,
        );
    if (response.status === 201) sessionHandles.add(handles.get(`${viewerKey(v)}:${channelId}`)!);
    return response;
}
async function ping(v: Viewer, channelId: string): Promise<Response> {
    return keepalive.POST!(event(v, channelId, 'POST', 'keepalive') as never);
}
async function part(v: Viewer, channelId: string): Promise<Response> {
    return leave.POST!(event(v, channelId, 'POST', 'leave') as never);
}
async function problemOf(res: Response): Promise<{ code?: string; error?: string }> {
    return (await res.clone().json()) as { code?: string; error?: string };
}

/** Channel → viewer count on the proxy, for this test's source. */
function slots(): Record<string, number> {
    return Object.fromEntries(
        mux
            .current!.getStatusData()
            .channels.filter((c) => c.sourceId === SOURCE_ID)
            .map((c) => [c.channelId, c.viewers]),
    );
}

// A member of no configured group whose Live TV access comes from elsewhere.
const lowPerms: UserPermissions = { ...buildUserPermissions([]), hasLiveTvPermission: true };

function person(name: string, permissions: UserPermissions): Viewer {
    return {
        username: `${name}-${randomUUID().slice(0, 6)}`,
        credential: `pat:${randomUUID()}`,
        permissions,
        userId: randomUUID(),
    };
}

describe('Live TV priority eviction (one-stream source)', () => {
    let sql: postgres.Sql;
    let ffmpeg: ReturnType<typeof createMockFfmpegManager>;
    let inAppHigh: UserPermissions;
    let inAppLow: UserPermissions;
    const created: Viewer[] = [];

    beforeAll(async () => {
        expect(await connectValkey()).toBe(true);
        sql = getTestDb();

        // In-app access groups, as an admin creates them in the UI.
        const tag = randomUUID().slice(0, 8);
        const highGroup = await insertAccessGroup(sql, {
            name: `night-owls-${tag}`,
            displayName: 'Night Owls',
            description: null,
        });
        await insertAccessGroupCapabilities(sql, highGroup.id, [
            { capability: 'livetv', value: null },
            { capability: 'livetv_high_priority', value: null },
        ]);
        const lowGroup = await insertAccessGroup(sql, {
            name: `lodgers-${tag}`,
            displayName: 'Lodgers',
            description: null,
        });
        await insertAccessGroupCapabilities(sql, lowGroup.id, [
            { capability: 'livetv', value: null },
        ]);
        const highUser = await createTestUser(sql);
        const lowUser = await createTestUser(sql);
        await addAccessGroupMember(sql, highGroup.id, highUser.id, null);
        await addAccessGroupMember(sql, lowGroup.id, lowUser.id, null);

        const highAccess = await resolveEffectiveAccess(sql, highUser.id, []);
        inAppHigh = buildUserPermissions(highAccess.effectiveGroups, {
            extraCapabilities: highAccess.capabilities,
        });
        const lowAccess = await resolveEffectiveAccess(sql, lowUser.id, []);
        inAppLow = buildUserPermissions(lowAccess.effectiveGroups, {
            extraCapabilities: lowAccess.capabilities,
        });
    });

    afterEach(async () => {
        await mux.current?.stopAll();
        mux.current?.stopOrphanCleanup();
        const client = getCoordinationClient();
        if (client) {
            const keys = [
                `livetv:v2:source:${SOURCE_ID}:sessions`,
                `livetv:v1:priority-lock:${SOURCE_ID}`,
                ...[...sessionHandles].map((id) => `livetv:v2:psess:${id}`),
                ...created.flatMap((v) => [
                    `livetv:v2:session:${viewerKey(v)}`,
                    `livetv:v2:kicked:${viewerKey(v)}`,
                    `livetv:v2:viewer-psess:${viewerKey(v)}`,
                    `livetv:v2:psess-lock:${viewerKey(v)}`,
                ]),
            ];
            await client.del(keys);
        }
        created.length = 0;
        handles.clear();
        sessionHandles.clear();
    });

    afterAll(async () => {
        await disconnectValkey();
        await closeTestDb();
    });

    function fresh(): void {
        ffmpeg = createMockFfmpegManager();
        mux.current = new ProxySlotDouble(ffmpeg);
        mux.maxStreams = 1;
    }
    function viewer(name: string, permissions: UserPermissions): Viewer {
        const v = person(name, permissions);
        created.push(v);
        return v;
    }

    describe('who is high priority', () => {
        it('an admin is high priority', () => {
            const p = buildUserPermissions(['admin']);
            expect(p.ownerIsAdmin).toBe(true);
            expect(p.liveTvPriority).toBe('high');
        });

        it('a member of a configured high-priority IdP group is high priority', () => {
            const p = buildUserPermissions([HIGH_GROUP]);
            expect(p.ownerIsAdmin).toBe(false);
            expect(p.hasLiveTvPermission).toBe(true);
            expect(p.liveTvPriority).toBe('high');
        });

        it('the in-app livetv_high_priority capability works like the IdP group', () => {
            expect(inAppHigh.ownerIsAdmin).toBe(false);
            expect(inAppHigh.hasLiveTvPermission).toBe(true);
            expect(inAppHigh.liveTvPriority).toBe('high');
        });

        it('an in-app group with only the livetv capability stays low priority', () => {
            expect(inAppLow.hasLiveTvPermission).toBe(true);
            expect(inAppLow.liveTvPriority).toBe('low');
            expect(lowPerms.liveTvPriority).toBe('low');
        });
    });

    it('a high-priority viewer takes the slot from a low-priority one, who sees viewer_kicked', async () => {
        fresh();
        const [news, sport] = [randomUUID(), randomUUID()];
        const lodger = viewer('lodger', inAppLow);
        const owner = viewer('owner', inAppHigh);

        expect((await join(lodger, news)).status).toBe(201);
        expect(slots()).toEqual({ [news]: 1 });

        expect((await join(owner, sport)).status).toBe(201);
        // The evicted channel left the proxy and its ingest stopped; the slot is the owner's.
        expect(slots()).toEqual({ [sport]: 1 });
        expect(ffmpeg.stop).toHaveBeenCalledWith(news);

        // No zombie: the lodger's session is gone, only the kicked marker remains.
        const sessions = getLiveTvSessionService();
        expect(await sessions.getSession(viewerKey(lodger))).toBeNull();
        expect((await sessions.getSourceViewers(SOURCE_ID)).map((s) => s.username)).toEqual([
            owner.username,
        ]);
        const ttl = await getCoordinationClient()!.ttl(`livetv:v2:kicked:${viewerKey(lodger)}`);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(120);

        // Eviction itself persists the terminal state, without needing a heartbeat.
        const evictedState = await state.GET!(event(lodger, news, 'GET', 'state'));
        expect(evictedState.status).toBe(200);
        expect(await evictedState.json()).toMatchObject({
            playbackSessionId: handles.get(`${viewerKey(lodger)}:${news}`),
            state: 'ended',
            endReason: 'evicted',
        });

        // The evicted player's reconnect is refused with the "taken over" answer...
        const rejoin = await join(lodger, news);
        expect(rejoin.status).toBe(410);
        expect(await problemOf(rejoin)).toMatchObject({
            error: 'playback_session_ended',
            reason: 'evicted',
        });
        // ...and so is its keepalive, once; after that the session is simply gone.
        const beat = await ping(lodger, news);
        expect(beat.status).toBe(410);
        expect(await problemOf(beat)).toMatchObject({
            error: 'playback_session_ended',
            reason: 'evicted',
        });
        expect((await ping(lodger, news)).status).toBe(410);

        // Once the marker is cleared it cannot steal the slot back: low never evicts.
        const steal = await join(lodger, news);
        expect(steal.status).toBe(503);
        expect(await problemOf(steal)).toMatchObject({ code: 'stream_limit' });
        expect(slots()).toEqual({ [sport]: 1 });
        expect((await ping(owner, sport)).status).toBe(204);
    });

    it('a low-priority viewer never evicts anyone', async () => {
        fresh();
        const [news, sport] = [randomUUID(), randomUUID()];
        const first = viewer('first', inAppLow);
        const second = viewer('second', lowPerms);
        expect((await join(first, news)).status).toBe(201);
        const res = await join(second, sport);
        expect(res.status).toBe(503);
        expect(await problemOf(res)).toMatchObject({ code: 'stream_limit' });
        expect(slots()).toEqual({ [news]: 1 });
        expect((await ping(first, news)).status).toBe(204);
    });

    it('a high-priority viewer never evicts another high-priority viewer', async () => {
        fresh();
        const [news, sport] = [randomUUID(), randomUUID()];
        const admin = viewer('admin', buildUserPermissions(['admin']));
        const family = viewer('family', buildUserPermissions([HIGH_GROUP]));
        expect((await join(admin, news)).status).toBe(201);
        const res = await join(family, sport);
        expect(res.status).toBe(503);
        expect(await problemOf(res)).toMatchObject({ code: 'stream_limit' });
        expect(slots()).toEqual({ [news]: 1 });
        expect((await ping(admin, news)).status).toBe(204);
        // And the other way round, via the in-app capability.
        expect((await part(admin, news)).status).toBe(204);
        const owner = viewer('owner', inAppHigh);
        expect((await join(owner, news)).status).toBe(201);
        expect((await join(admin, sport)).status).toBe(503);
    });

    it.each([
        ['low', () => lowPerms],
        ['high', () => buildUserPermissions(['admin'])],
    ] as const)(
        'a %s-priority viewer switches channel on the one slot without leaving first',
        async (_level, perms) => {
            fresh();
            const [news, sport] = [randomUUID(), randomUUID()];
            const zapper = viewer('zapper', perms());
            expect((await join(zapper, news)).status).toBe(201);
            // No leave for `news` arrives before the switch (a lost or late beacon).
            const res = await join(zapper, sport);
            expect(res.status).toBe(201);
            expect(slots()).toEqual({ [sport]: 1 });
            expect(
                await (await state.GET!(event(zapper, news, 'GET', 'state'))).json(),
            ).toMatchObject({ state: 'ended', endReason: 'superseded' });
            expect((await ping(zapper, sport)).status).toBe(204);
            expect(await getLiveTvSessionService().getSession(viewerKey(zapper))).toMatchObject({
                channelId: sport,
                sourceId: SOURCE_ID,
            });
        },
    );

    it('a switch keeps the old stream when someone else still watches that channel', async () => {
        fresh();
        const [news, sport] = [randomUUID(), randomUUID()];
        const zapper = viewer('zapper', lowPerms);
        const friend = viewer('friend', lowPerms);
        expect((await join(zapper, news)).status).toBe(201);
        expect((await join(friend, news)).status).toBe(201);
        // Leaving `news` would free no slot, so the viewer keeps watching it.
        const res = await join(zapper, sport);
        expect(res.status).toBe(503);
        expect(await problemOf(res)).toMatchObject({ code: 'stream_limit' });
        expect(slots()).toEqual({ [news]: 2 });
        expect((await ping(zapper, news)).status).toBe(204);
    });

    it('viewers of the same channel share one slot and one upstream', async () => {
        fresh();
        const news = randomUUID();
        const admin = viewer('admin', buildUserPermissions(['admin']));
        const lodger = viewer('lodger', inAppLow);
        const guest = viewer('guest', lowPerms);
        expect((await join(admin, news)).status).toBe(201);
        expect((await join(lodger, news)).status).toBe(201);
        expect((await join(guest, news)).status).toBe(201);
        expect(slots()).toEqual({ [news]: 3 });
        expect(ffmpeg.spawn).toHaveBeenCalledTimes(1);
        // A repeated join by the same viewer is idempotent.
        expect((await join(admin, news)).status).toBe(201);
        expect(slots()).toEqual({ [news]: 3 });
    });

    it('takes the whole channel when several low-priority viewers share it', async () => {
        fresh();
        const [news, sport] = [randomUUID(), randomUUID()];
        const lodger = viewer('lodger', inAppLow);
        const guest = viewer('guest', lowPerms);
        const owner = viewer('owner', inAppHigh);
        expect((await join(lodger, news)).status).toBe(201);
        expect((await join(guest, news)).status).toBe(201);

        expect((await join(owner, sport)).status).toBe(201);
        expect(slots()).toEqual({ [sport]: 1 });
        expect((await join(lodger, news)).status).toBe(410);
        expect((await join(guest, news)).status).toBe(410);
    });

    it('does not evict a low-priority viewer who shares the channel with a high-priority one', async () => {
        fresh();
        const [news, sport] = [randomUUID(), randomUUID()];
        const admin = viewer('admin', buildUserPermissions(['admin']));
        const lodger = viewer('lodger', inAppLow);
        const owner = viewer('owner', inAppHigh);
        expect((await join(admin, news)).status).toBe(201);
        expect((await join(lodger, news)).status).toBe(201);

        // Evicting the lodger would not free news (the admin stays), so nobody goes.
        const res = await join(owner, sport);
        expect(res.status).toBe(503);
        expect(slots()).toEqual({ [news]: 2 });
        expect((await ping(lodger, news)).status).toBe(204);
    });

    it('shortest policy evicts the channel watched for the shortest time', async () => {
        fresh();
        mux.maxStreams = 2;
        const [news, docs, sport] = [randomUUID(), randomUUID(), randomUUID()];
        const early = viewer('early', inAppLow);
        const late = viewer('late', lowPerms);
        const owner = viewer('owner', inAppHigh);
        const sessions = getLiveTvSessionService();
        expect((await join(early, news)).status).toBe(201);
        const startedAt = (await sessions.getSession(viewerKey(early)))!.startedAt;
        await new Promise((r) => setTimeout(r, 20));
        expect((await join(late, docs)).status).toBe(201);
        // Re-registering (the master playlist, a reload) keeps how long it has been on,
        // so a long-time viewer does not look like the newest one.
        await new Promise((r) => setTimeout(r, 20));
        expect((await join(early, news)).status).toBe(201);
        expect((await sessions.getSession(viewerKey(early)))!.startedAt).toBe(startedAt);

        expect((await join(owner, sport)).status).toBe(201);
        expect(slots()).toEqual({ [news]: 1, [sport]: 1 });
        expect((await join(late, docs)).status).toBe(410);
        expect((await ping(early, news)).status).toBe(204);
    });

    it('the evicted viewer can watch again once the slot is free', async () => {
        fresh();
        const [news, sport] = [randomUUID(), randomUUID()];
        const lodger = viewer('lodger', inAppLow);
        const owner = viewer('owner', inAppHigh);
        expect((await join(lodger, news)).status).toBe(201);
        expect((await join(owner, sport)).status).toBe(201);
        expect((await join(lodger, news)).status).toBe(410);

        expect((await part(owner, sport)).status).toBe(204);
        // The kicked marker lapses after its TTL (simulated) — the slot is free again, and
        // the owner's channel, now in its grace period, is reclaimed for the lodger.
        await getCoordinationClient()!.del([`livetv:v2:kicked:${viewerKey(lodger)}`]);
        expect((await join(lodger, news)).status).toBe(201);
        expect(slots()).toEqual({ [news]: 1 });
        expect((await ping(lodger, news)).status).toBe(204);
    });

    it('does not evict, kick or unregister anyone when the proxy leave fails', async () => {
        fresh();
        const [news, sport] = [randomUUID(), randomUUID()];
        const lodger = viewer('lodger', inAppLow);
        const owner = viewer('owner', inAppHigh);
        expect((await join(lodger, news)).status).toBe(201);

        vi.spyOn(mux.current!, 'leave').mockRejectedValueOnce(new Error('Proxy 502'));
        const res = await join(owner, sport);
        // The slot is still held by the lodger, so the owner is refused like any newcomer.
        expect(res.status).toBe(503);
        expect(await problemOf(res)).toMatchObject({ code: 'stream_limit' });
        expect(slots()).toEqual({ [news]: 1 });
        const sessions = getLiveTvSessionService();
        expect((await sessions.getSession(viewerKey(lodger)))?.channelId).toBe(news);
        expect((await sessions.checkKicked(viewerKey(lodger), news)).kicked).toBe(false);
        expect((await ping(lodger, news)).status).toBe(204);
    });

    it('flags nobody kicked when the evicting viewer fails to join after the eviction', async () => {
        fresh();
        const [news, sport] = [randomUUID(), randomUUID()];
        const lodger = viewer('lodger', inAppLow);
        const owner = viewer('owner', inAppHigh);
        expect((await join(lodger, news)).status).toBe(201);

        const realJoin = mux.current!.join.bind(mux.current!);
        let calls = 0;
        vi.spyOn(mux.current!, 'join').mockImplementation(async (channelId, request) =>
            ++calls === 2
                ? ({ status: 500, body: { error: 'spawn_failed' } } as never)
                : realJoin(channelId, request),
        );
        const res = await join(owner, sport);
        expect(res.status).toBe(502);

        // The lodger was cut off from the proxy but is not locked out: it may rejoin.
        const sessions = getLiveTvSessionService();
        expect((await sessions.checkKicked(viewerKey(lodger), news)).kicked).toBe(false);
        expect((await join(lodger, news)).status).toBe(201);
        expect(slots()).toEqual({ [news]: 1 });
    });

    it('the kicked flag blocks only the channel the viewer was evicted from', async () => {
        fresh();
        const [news, sport, docs] = [randomUUID(), randomUUID(), randomUUID()];
        const lodger = viewer('lodger', inAppLow);
        const owner = viewer('owner', inAppHigh);
        expect((await join(lodger, news)).status).toBe(201);
        expect((await join(owner, sport)).status).toBe(201);

        // Another channel is not "taken over": it just meets the stream limit.
        const other = await join(lodger, docs);
        expect(other.status).toBe(503);
        expect(await problemOf(other)).toMatchObject({ code: 'stream_limit' });
        // The flag for the lost channel is still there.
        expect((await join(lodger, news)).status).toBe(410);
        // A keepalive for another channel leaves it untouched, too.
        expect((await ping(lodger, docs)).status).not.toBe(410);
        expect((await join(lodger, news)).status).toBe(410);
    });

    it('confirmation of a captured eviction preserves a replacement started by the victim', async () => {
        fresh();
        const [news, sport] = [randomUUID(), randomUUID()];
        const victim = viewer('eviction-race', inAppLow);
        const owner = viewer('eviction-owner', inAppHigh);
        expect((await join(victim, news)).status).toBe(201);
        const oldId = handles.get(`${viewerKey(victim)}:${news}`)!;
        const priority = getLiveTvPriorityService();
        const decision = await priority.checkAndEnforcePriority(
            viewerKey(owner),
            'high',
            sport,
            SOURCE_ID,
            1,
        );
        expect(decision.allowed).toBe(true);
        if (!decision.allowed) throw new Error('Expected eviction to free the slot');
        expect(decision.evicted).toEqual([
            { sessionId: oldId, viewerKey: viewerKey(victim), channelId: news },
        ]);

        // The victim starts a newer handle after selection but before confirmation.
        const sessions = getLiveTvSessionService();
        const replacement = await sessions.startPlaybackSession({
            viewerKey: viewerKey(victim),
            username: victim.username,
            stationId: news,
            feedId: news,
            sourceId: SOURCE_ID,
        });
        sessionHandles.add(replacement.sessionId);
        await priority.confirmEviction(decision.evicted!);

        expect(await sessions.getPlaybackSession(oldId)).toMatchObject({
            state: 'ended',
            endReason: 'superseded',
        });
        expect(await sessions.getPlaybackSession(replacement.sessionId)).toMatchObject({
            state: 'active',
            sessionId: replacement.sessionId,
        });
        expect((await sessions.getViewerPlaybackSession(viewerKey(victim)))?.sessionId).toBe(
            replacement.sessionId,
        );
        expect(
            String(
                await getCoordinationClient()!.get(`livetv:v2:viewer-psess:${viewerKey(victim)}`),
            ),
        ).toBe(replacement.sessionId);
    });

    it('only one concurrent consumeKicked call takes a flag from real Valkey', async () => {
        const victim = viewer('consume-race', lowPerms);
        const feed = randomUUID();
        const sessions = getLiveTvSessionService();
        await sessions.markKicked(viewerKey(victim), 'higher_priority_viewer', feed);

        const results = await Promise.all(
            Array.from({ length: 12 }, () => sessions.consumeKicked(viewerKey(victim), feed)),
        );
        expect(results.filter((result) => result.kicked)).toEqual([
            { kicked: true, reason: 'higher_priority_viewer' },
        ]);
        expect(results.filter((result) => !result.kicked)).toHaveLength(11);
        expect(await sessions.checkKicked(viewerKey(victim), feed)).toEqual({ kicked: false });
    });

    it('a leave loaded while active cannot release a replacement on the same feed', async () => {
        const watcher = viewer('release-race', lowPerms);
        const feed = randomUUID();
        const sessions = getLiveTvSessionService();
        const input = {
            viewerKey: viewerKey(watcher),
            username: watcher.username,
            stationId: feed,
            feedId: feed,
            sourceId: SOURCE_ID,
        };
        const old = await sessions.startPlaybackSession(input);
        sessionHandles.add(old.sessionId);
        // Keep the entry the leave loaded before the replacement, not a reloaded ended record.
        const oldEntry = await sessions.getPlaybackSession(old.sessionId);
        expect(oldEntry?.state).toBe('active');
        if (!oldEntry) throw new Error('Missing old playback session');
        const replacement = await sessions.startPlaybackSession(input);
        sessionHandles.add(replacement.sessionId);

        expect(await sessions.releasePlaybackSession(oldEntry)).toBe(false);
        expect(oldEntry.state).toBe('active');
        expect(
            String(
                await getCoordinationClient()!.get(`livetv:v2:viewer-psess:${viewerKey(watcher)}`),
            ),
        ).toBe(replacement.sessionId);
        expect(await sessions.getViewerPlaybackSession(viewerKey(watcher))).toMatchObject({
            sessionId: replacement.sessionId,
            state: 'active',
        });
    });

    it('ending a session preserves an empty adaptive rung array through the real Lua script', async () => {
        const watcher = viewer('empty-rungs', lowPerms);
        const feed = randomUUID();
        const sessions = getLiveTvSessionService();
        const entry = await sessions.startPlaybackSession({
            viewerKey: viewerKey(watcher),
            username: watcher.username,
            stationId: feed,
            feedId: feed,
            sourceId: SOURCE_ID,
            adaptive: { rungs: [], includesOriginal: true },
        });
        sessionHandles.add(entry.sessionId);
        await sessions.endPlaybackSession(entry.sessionId, 'left');
        expect(await sessions.getPlaybackSession(entry.sessionId)).toMatchObject({
            state: 'ended',
            endReason: 'left',
            adaptive: { rungs: [], includesOriginal: true },
        });
        const raw = await getCoordinationClient()!.get(`livetv:v2:psess:${entry.sessionId}`);
        expect(JSON.parse(String(raw)).adaptive.rungs).toEqual([]);
    });

    it('of concurrent keepalives only one takes the kicked flag', async () => {
        fresh();
        const [news, sport] = [randomUUID(), randomUUID()];
        const lodger = viewer('lodger', inAppLow);
        const owner = viewer('owner', inAppHigh);
        expect((await join(lodger, news)).status).toBe(201);
        expect((await join(owner, sport)).status).toBe(201);

        const beats = await Promise.all(Array.from({ length: 5 }, () => ping(lodger, news)));
        expect(beats.filter((r) => r.status === 410)).toHaveLength(5);
        expect((await getLiveTvSessionService().checkKicked(viewerKey(lodger), news)).kicked).toBe(
            false,
        );
    });

    it('a delayed leave for one channel keeps the session the viewer has for another', async () => {
        fresh();
        mux.maxStreams = 2;
        const [news, docs] = [randomUUID(), randomUUID()];
        const lodger = viewer('lodger', inAppLow);
        const sessions = getLiveTvSessionService();
        expect((await join(lodger, news)).status).toBe(201);
        expect((await join(lodger, docs)).status).toBe(201);
        expect((await sessions.getSession(viewerKey(lodger)))?.channelId).toBe(docs);

        expect((await part(lodger, news)).status).toBe(204);
        expect((await sessions.getSession(viewerKey(lodger)))?.channelId).toBe(docs);
        expect((await sessions.getSourceViewers(SOURCE_ID)).map((s) => s.channelId)).toEqual([
            docs,
        ]);

        // Leaving the channel the session is for removes it, and the source index entry.
        expect((await part(lodger, docs)).status).toBe(204);
        expect(await sessions.getSession(viewerKey(lodger))).toBeNull();
        expect(await sessions.getSourceViewers(SOURCE_ID)).toEqual([]);
        expect(
            await getCoordinationClient()!.sismember(
                `livetv:v2:source:${SOURCE_ID}:sessions`,
                viewerKey(lodger),
            ),
        ).toBe(false);
    });
    it('a replacement on the same feed supersedes its handle, and delayed leave preserves the newer session', async () => {
        fresh();
        const stationId = randomUUID();
        const watcher = viewer('replacement', lowPerms);
        expect((await join(watcher, stationId)).status).toBe(201);
        const oldEvent = event(watcher, stationId, 'POST', 'leave');
        const oldId = oldEvent.params.playbackSessionId!;
        expect((await join(watcher, stationId)).status).toBe(201);
        const oldState = await state.GET!(oldEvent);
        expect(await oldState.json()).toMatchObject({
            playbackSessionId: oldId,
            stationId,
            feedId: stationId,
            state: 'ended',
            endReason: 'superseded',
        });
        expect((await keepalive.POST!(oldEvent)).status).toBe(410);
        expect((await leave.POST!(oldEvent)).status).toBe(204);
        expect((await ping(watcher, stationId)).status).toBe(204);
        expect(slots()).toEqual({ [stationId]: 1 });
        await getCoordinationClient()!.del([`livetv:v2:psess:${oldId}`]);
    });

    it('ownership survives credential rotation, foreign users cannot heartbeat or leave, and leave is idempotent', async () => {
        fresh();
        const stationId = randomUUID();
        const watcher = viewer('ownership', lowPerms);
        expect((await join(watcher, stationId)).status).toBe(201);
        const rotated = event(watcher, stationId, 'POST', 'keepalive');
        rotated.locals.liveTvCredentialId = `pat:${randomUUID()}`;
        expect((await keepalive.POST!(rotated)).status).toBe(204);
        const foreign = event(watcher, stationId, 'POST', 'keepalive');
        foreign.locals.user = { ...foreign.locals.user!, username: 'foreign' };
        expect((await keepalive.POST!(foreign)).status).toBe(404);
        expect((await leave.POST!(foreign)).status).toBe(204);
        expect((await state.GET!(foreign)).status).toBe(404);
        expect((await ping(watcher, stationId)).status).toBe(204);
        expect((await part(watcher, stationId)).status).toBe(204);
        expect((await part(watcher, stationId)).status).toBe(204);
        const ended = await state.GET!(event(watcher, stationId, 'GET', 'state'));
        expect(await ended.json()).toMatchObject({ state: 'ended', endReason: 'left' });
        expect(await getLiveTvSessionService().getSession(viewerKey(watcher))).toBeNull();
    });
});
