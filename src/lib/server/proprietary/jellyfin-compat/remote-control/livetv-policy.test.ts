// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { ApiProblem } from '$lib/server/api/problem.js';
const { send, allowed, access } = vi.hoisted(() => ({
    send: vi.fn(),
    allowed: vi.fn(),
    access: vi.fn(),
}));
vi.mock('$lib/server/auth/resolve-token-user-access', () => ({ resolveTokenUserAccess: access }));
vi.mock('$lib/server/auth/livetv-user-policy.js', () => ({ userAllowsLiveTv: allowed }));
vi.mock('$lib/server/config.js', async (original) => {
    const actual = await original<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: new Proxy(actual.config, {
            get(target, key, receiver) {
                return key === 'FEATURE_LIVETV' ? true : Reflect.get(target, key, receiver);
            },
        }),
    };
});
vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: unknown) => handler,
}));
vi.mock('./fanout', () => ({ sendToSession: send }));
vi.mock('./native-devices', () => ({ nativeGeneralCommand: vi.fn() }));
vi.mock('./route-helpers', () => ({
    readJsonBody: (request: Request) => request.json(),
    noContent: () => new Response(null, { status: 204 }),
    badRequest: () => new Response(null, { status: 400 }),
    withControllableTarget: (event: RequestEvent, action: (ctx: unknown) => Promise<Response>) =>
        action({ target: { id: 'target', username: 'alice' }, caller: event.locals.user, sql: {} }),
}));
beforeEach(() => {
    send.mockClear();
    allowed.mockResolvedValue(false);
    access.mockResolvedValue({
        disabled: false,
        deleted: false,
        permissions: { hasLiveTvPermission: false },
    });
});
it.each([
    ['full', false],
    ['named', false],
    ['full', true],
    ['named', true],
])(
    '%s Jellyfin ChannelUp refuses a disallowed target owner without delivering',
    async (kind, switchAllowed) => {
        allowed.mockResolvedValue(switchAllowed);
        const route =
            kind === 'full'
                ? await import('../../../../../routes/(proprietary)/j/Sessions/[sessionId]/Command/+server.js')
                : await import('../../../../../routes/(proprietary)/j/Sessions/[sessionId]/Command/[command]/+server.js');
        const event = {
            params: { command: 'ChannelUp', sessionId: 'target' },
            locals: {
                user: {
                    userId: '00000000-0000-4000-8000-000000000001',
                    username: 'alice',
                    hasLiveTvPermission: false,
                },
            },
            request: new Request('http://localhost', {
                method: 'POST',
                body: JSON.stringify({ Name: 'ChannelUp', Arguments: {} }),
            }),
        } as unknown as RequestEvent;
        const response = await route.POST(event as never);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual(await ApiProblem.notFound().json());
        expect(send).not.toHaveBeenCalled();
    },
);

it.each(['ChannelUp', 'ChannelDown'])(
    'C-4: %s needs both owner permissions and retains allowed controls',
    async (name) => {
        const { liveTvCommandDenial } = await import('./commands');
        allowed.mockResolvedValue(true);
        access.mockResolvedValue({
            disabled: false,
            deleted: false,
            permissions: { hasLiveTvPermission: false },
        });
        expect((await liveTvCommandDenial(name, 'alice'))?.status).toBe(404);
        access.mockResolvedValue({
            disabled: false,
            deleted: false,
            permissions: { hasLiveTvPermission: true },
        });
        expect(await liveTvCommandDenial(name, 'alice')).toBeNull();
        allowed.mockResolvedValue(false);
        expect((await liveTvCommandDenial(name, 'alice'))?.status).toBe(404);
        expect(await liveTvCommandDenial('Stop', 'alice')).toBeNull();
    },
);
