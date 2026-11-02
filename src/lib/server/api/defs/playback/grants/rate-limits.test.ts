// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const limiter = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/middleware/valkey-rate-limit.js', async (original) => ({
    ...(await original<typeof import('$lib/server/middleware/valkey-rate-limit.js')>()),
    checkRateLimit: limiter,
}));
vi.mock('$lib/server/services/playback-grant.js', () => ({
    renewPlaybackGrant: vi.fn(),
    getPlaybackGrant: vi.fn(),
    revokePlaybackGrant: vi.fn(),
}));
vi.mock('$lib/server/services/play-sessions.service.js', () => ({
    startPlaySession: vi.fn(),
    isPolicyError: vi.fn(),
}));
vi.mock('$lib/server/services/session-kill.service.js', () => ({
    checkSessionKickCooldown: vi.fn(),
}));
vi.mock('$lib/server/services/database.service.js', () => ({ aiDbService: {} }));
vi.mock('$lib/server/services/play-session-lifecycle.service.js', () => ({
    getPlaySessionLifecycleService: vi.fn(),
}));
import { mount } from '$lib/server/api/mount.js';
import { def as startDef } from '../../play-sessions/index.js';
import { def as renewDef } from './[id]/renew.js';
import { def as ownerDef } from './[id].js';

function event(
    path: string,
    body: unknown,
    userId = 'user-1',
    scopes = ['media:write'],
): RequestEvent {
    const url = new URL(path, 'https://app.test');
    return {
        url,
        request: new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
        params: { id: '11111111-1111-4111-8111-111111111111' },
        route: { id: path },
        locals: {
            principal: { userId, username: userId, scopes, isAdmin: false },
            user: { userId, username: userId },
        },
        getClientAddress: () => '192.0.2.1',
        cookies: {},
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}
beforeEach(() => {
    const counts = new Map<string, number>();
    limiter.mockReset().mockImplementation(async (key: string, limit: number) => {
        const total = (counts.get(key) ?? 0) + 1;
        counts.set(key, total);
        return {
            allowed: total <= limit,
            remaining: Math.max(0, limit - total),
            resetAt: Date.now() / 1000 + 60,
            total,
        };
    });
});
const startBody = {
    mediaId: '11111111-1111-4111-8111-111111111111',
    deviceId: 'device',
    capabilities: {
        containers: [],
        videoCodecs: [],
        audioCodecs: [],
        subtitleFormats: [],
        hdr: [],
    },
};
describe.each(['internal', 'v1'] as const)('playback limits on %s', (surface) => {
    it.each(['start', 'renew'] as const)(
        'enforces the per-user %s budget through mount',
        async (kind) => {
            const definition = kind === 'start' ? startDef : renewDef;
            const limit = kind === 'start' ? 60 : 30;
            const body = kind === 'start' ? startBody : { token: 'stream_secret' };
            const path =
                kind === 'start'
                    ? '/api/v1/play-sessions'
                    : '/api/v1/playback/grants/11111111-1111-4111-8111-111111111111/renew';
            const handler = vi.fn(async () => new Response(null, { status: 204 }));
            const mounted = mount({ ...definition, handlers: { POST: handler } }, { surface });
            for (let i = 0; i < limit; i++)
                expect((await mounted.POST!(event(path, body))).status).toBe(204);
            const denied = await mounted.POST!(event(path, body));
            expect(denied.status).toBe(429);
            expect(denied.headers.has('Retry-After')).toBe(true);
            expect(handler).toHaveBeenCalledTimes(limit);
            expect(limiter).toHaveBeenLastCalledWith(
                `${kind === 'start' ? 'playback-start' : 'playback-renew'}:user-1`,
                limit,
                60,
            );
            expect((await mounted.POST!(event(path, body, 'user-2'))).status).toBe(204);
        },
    );
    it.each(['GET', 'DELETE', 'POST'] as const)(
        'denies management %s to a media:read credential',
        async (method) => {
            const definition = method === 'POST' ? renewDef : ownerDef;
            const handler = vi.fn(async () => new Response(null, { status: 204 }));
            const mounted = mount({ ...definition, handlers: { [method]: handler } }, { surface });
            const request = event(
                '/api/v1/playback/grants/11111111-1111-4111-8111-111111111111',
                { token: 'stream_secret' },
                'user-1',
                ['media:read'],
            );
            expect((await mounted[method]!(request)).status).toBe(403);
            expect(handler).not.toHaveBeenCalled();
        },
    );
});
