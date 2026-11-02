// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const { allowed, handler } = vi.hoisted(() => ({ allowed: vi.fn(), handler: vi.fn() }));
vi.mock('$lib/server/auth/livetv-user-policy.js', async (original) => ({
    ...(await original<typeof import('$lib/server/auth/livetv-user-policy.js')>()),
    userAllowsLiveTv: allowed,
}));
import { defineEndpoint } from './define.js';
import { mount } from './mount.js';

beforeEach(() => {
    allowed.mockReset().mockResolvedValue(false);
    handler.mockReset().mockResolvedValue(new Response('should not be read'));
});

const def = defineEndpoint({ auth: { kind: 'user' }, handlers: { GET: handler } });
const paths = ['/api/livetv/stations', '/api/v1/livetv/stations'];
function event(path: string): RequestEvent {
    return {
        route: { id: path },
        locals: { principal: { username: 'viewer' } },
        request: new Request(`http://localhost${path}`),
        url: new URL(`http://localhost${path}`),
    } as unknown as RequestEvent;
}

describe('Live TV policy after API authentication', () => {
    it.each(paths)(
        '%s checks a token identity acquired after hooks before calling its handler',
        async (path) => {
            const GET = mount(def, { surface: 'v1' }).GET!;
            const response = await GET(event(path));
            expect(response.status).toBe(404);
            expect(await response.text()).not.toMatch(/permission|forbidden/i);
            expect(allowed).toHaveBeenCalledWith('viewer');
            expect(handler).not.toHaveBeenCalled();
        },
    );
    it.each(paths)('%s allows an enabled account (positive control)', async (path) => {
        allowed.mockResolvedValue(true);
        const response = await mount(def, { surface: 'v1' }).GET!(event(path));
        expect(response.status).toBe(200);
        expect(handler).toHaveBeenCalledTimes(1);
    });
});

it.each(['/api/admin/livetv/sources', '/api/v1/livetv/admin/sources'])(
    '%s configures sources independently of personal viewing permission',
    async (path) => {
        expect((await mount(def, { surface: 'v1' }).GET!(event(path))).status).toBe(200);
        expect(allowed).not.toHaveBeenCalled();
    },
);

it('disabled Live TV and a disallowed user return the exact same unconfigured problem', async () => {
    const { config } = await import('$lib/server/config.js');
    const feature = vi.spyOn(config, 'FEATURE_LIVETV', 'get');
    const endpoint = defineEndpoint({
        auth: { kind: 'feature', flag: 'FEATURE_LIVETV', then: { kind: 'user' } },
        handlers: { GET: handler },
    });
    const request = event('/api/v1/livetv/stations');
    request.locals.user = { hasLiveTvPermission: false } as App.Locals['user'];
    try {
        feature.mockReturnValue(false);
        const absent = await mount(endpoint, { surface: 'v1' }).GET!(request);
        feature.mockReturnValue(true);
        const denied = await mount(endpoint, { surface: 'v1' }).GET!(request);
        expect(denied.status).toBe(absent.status);
        expect(await denied.json()).toEqual(await absent.json());
        expect(handler).not.toHaveBeenCalled();
    } finally {
        feature.mockRestore();
    }
});
