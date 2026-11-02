// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { connectValkey, getCoordinationClient } from '$lib/server/cache/valkey.js';
import {
    createLiveTvSessionService,
    listActiveLiveTvPlaybackSessions,
} from './livetv-session.service.js';

import { config } from '$lib/server/config.js';
import { cancelLiveTvPlaybackSession } from '../livetv-active-sessions.service.js';
import type { RequestEvent } from '@sveltejs/kit';
const leave = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true }));
vi.mock('./stream-proxy-client.js', () => ({
    getStreamProxyClient: () => ({ leaveChannel: leave }),
}));
vi.mock('$lib/server/utils/audit-log.js', () => ({ auditLog: vi.fn(), auditActor: () => ({}) }));
afterEach(() => vi.restoreAllMocks());
const keys: string[] = [];
beforeAll(async () => {
    expect(await connectValkey()).toBe(true);
});
afterAll(async () => {
    if (keys.length) await getCoordinationClient()!.del(keys);
});

it('reads real session inventory and removes superseded, preview and stale viewers without refreshing them', async () => {
    const service = createLiveTvSessionService();
    const prefix = randomUUID();
    const input = {
        username: prefix,
        viewerKey: `${prefix}:browser:a`,
        stationId: randomUUID(),
        feedId: randomUUID(),
        sourceId: randomUUID(),
        userId: randomUUID(),
        deviceId: 'stable-client-device',
        deviceSessionId: 'oauth-session',
        clientName: 'Lumastra TV',
        appliedMaxHeight: 720,
        appliedMaxBitrateBps: 4000000,
    };
    const first = await service.startPlaybackSession(input);
    const second = await service.startPlaybackSession(input);
    const preview = await service.startPlaybackSession({
        ...input,
        viewerKey: `${prefix}:preview`,
        kind: 'preview',
    });
    const stale = await service.startPlaybackSession({ ...input, viewerKey: `${prefix}:stale` });
    const all = [first, second, preview, stale];
    keys.push(
        ...all.flatMap((s) => [
            `livetv:v2:psess:${s.sessionId}`,
            `livetv:v2:viewer-psess:${s.viewerKey}`,
        ]),
    );
    await getCoordinationClient()!.expire(`livetv:v2:psess:${stale.sessionId}`, 1);
    const inventory = await listActiveLiveTvPlaybackSessions();
    expect(inventory.find((session) => session.sessionId === second.sessionId)).toMatchObject({
        userId: input.userId,
        deviceId: 'stable-client-device',
        deviceSessionId: 'oauth-session',
        clientName: 'Lumastra TV',
        appliedMaxHeight: 720,
        appliedMaxBitrateBps: 4000000,
    });
    expect(inventory.filter((s) => s.username === prefix).map((s) => s.sessionId)).toEqual([
        second.sessionId,
    ]);
    expect(
        await getCoordinationClient()!.ttl(`livetv:v2:psess:${stale.sessionId}`),
    ).toBeLessThanOrEqual(1);
});

it('a delayed stop cannot release the newer session for the same viewer and feed', async () => {
    vi.spyOn(config, 'LIVETV_SOURCE', 'get').mockReturnValue('standalone');
    vi.spyOn(config, 'STREAM_PROXY_URL', 'get').mockReturnValue('http://proxy.test');
    leave.mockClear();
    const service = createLiveTvSessionService();
    const input = {
        userId: randomUUID(),
        username: randomUUID(),
        viewerKey: randomUUID(),
        stationId: randomUUID(),
        feedId: randomUUID(),
        sourceId: randomUUID(),
    };
    const old = await service.startPlaybackSession(input);
    const replacement = await service.startPlaybackSession(input);
    keys.push(
        ...[old, replacement].flatMap((s) => [
            `livetv:v2:psess:${s.sessionId}`,
            `livetv:v2:viewer-psess:${s.viewerKey}`,
        ]),
    );
    const event = {
        locals: { user: { userId: input.userId, username: input.username } },
    } as RequestEvent;
    expect((await cancelLiveTvPlaybackSession(event, old.sessionId))?.status).toBe(204);
    expect(leave).not.toHaveBeenCalled();
    expect((await service.getViewerPlaybackSession(input.viewerKey))?.sessionId).toBe(
        replacement.sessionId,
    );
    expect((await cancelLiveTvPlaybackSession(event, replacement.sessionId))?.status).toBe(204);
    expect(leave).toHaveBeenCalledWith(input.feedId, input.viewerKey);
});
