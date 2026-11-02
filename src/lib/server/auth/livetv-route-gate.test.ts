// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { EndpointDef } from '$lib/server/api/define.js';
import type { RequestEvent } from '@sveltejs/kit';
import { ApiProblem } from '$lib/server/api/problem.js';
import { listRouteFiles, listRouteIds, withoutGroups } from './route-tree.test-helpers.js';

const { allowed } = vi.hoisted(() => ({ allowed: vi.fn() }));
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
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({ getUserLiveTvAllowed: allowed }));

const routes = listRouteIds()
    .filter((id) => !/\/admin\/livetv|\/livetv\/admin/.test(id))
    .filter((id) =>
        withoutGroups(id)
            .split('/')
            .some((part) => part.toLowerCase() === 'livetv'),
    );

describe('Live TV route policy coverage', () => {
    it('installs the per-user policy before resolving pages, API defs and compat handlers', () => {
        for (const file of [
            'src/lib/server/middleware/forward-auth.ts',
            'src/lib/server/proprietary/jellyfin-compat/middleware.ts',
        ]) {
            expect(readFileSync(file, 'utf8').includes('applyLiveTvUserPolicy'), file).toBe(true);
        }
        expect(readFileSync('src/hooks.server.ts', 'utf8')).toContain('liveTvRouteGate(event)');
    });

    it.each(routes)('%s denies a disallowed user before its handler', async (id) => {
        const { liveTvRouteGate, applyLiveTvUserPolicy } = await import('./livetv-user-policy.js');
        const user = { username: 'viewer', hasLiveTvPermission: true };
        allowed.mockResolvedValue(false);
        await applyLiveTvUserPolicy(user);
        const response = liveTvRouteGate({ route: { id }, locals: { user } });
        expect(response?.status).toBe(404);
        expect(await response?.text()).not.toMatch(/permission|forbidden/i);
        expect(
            liveTvRouteGate({ route: { id }, locals: { user: { hasLiveTvPermission: true } } }),
        ).toBeNull();
    });

    it('covers pages, apps, v1 and DVR routes', () => {
        for (const path of [
            '/livetv',
            '/api/livetv/stations',
            '/api/v1/livetv/stations',
            '/j/LiveTv/Recordings',
        ]) {
            expect(
                routes.some((id) => withoutGroups(id) === path),
                path,
            ).toBe(true);
        }
    });
});

describe('Live TV secondary entry points', () => {
    for (const route of listRouteFiles().filter((route) => route.name.endsWith('.ts'))) {
        const source = readFileSync(route.file, 'utf8');
        if (!source.includes('services/livetv/')) continue;
        it(`${route.id} uses authenticated Live TV permission or the token recheck`, () => {
            expect(
                routes.includes(route.id) ||
                    /hasLiveTvPermission|enforceTokenLiveTvAccess|liveTvRouteGate/.test(source),
            ).toBe(true);
        });
    }
    it('keeps fresh checks on grant delivery, renewal and Jellyfin play tokens', () => {
        for (const file of [
            'src/lib/server/services/playback-grant.ts',
            'src/lib/server/proprietary/jellyfin-compat/play-token-user.ts',
            'src/lib/server/proprietary/jellyfin-compat/livetv-token-access.ts',
        ]) {
            expect(readFileSync(file, 'utf8').includes('userAllowsLiveTv'), file).toBe(true);
        }
    });
});

const liveTvDefinitions = import.meta.glob<{ def?: EndpointDef }>([
    '/src/lib/server/api/defs/livetv/**/*.ts',
    '!/src/lib/server/api/defs/livetv/**/*.test.ts',
    '!/src/lib/server/api/defs/livetv/admin/**',
]);
for (const [file, load] of Object.entries(liveTvDefinitions)) {
    it(`${file}: every viewer handler enforces the switch before accessing data`, async () => {
        const { def } = await load();
        if (!def) return;
        for (const [method, handler] of Object.entries(def.handlers)) {
            if (!handler) continue;
            // Cleanup has its own owner check, and must remain usable after revocation.
            if (method === 'DELETE' && file.endsWith('/[playbackSessionId].ts')) continue;
            if (file.endsWith('/leave.ts')) continue;
            const event = {
                route: {
                    id: file.replace('/src/lib/server/api/defs', '/api').replace(/\.ts$/, ''),
                },
                locals: { user: { username: 'viewer', hasLiveTvPermission: false } },
                request: new Request('http://localhost/api/livetv', { method }),
                params: {},
                url: new URL('http://localhost/api/livetv'),
            } as unknown as RequestEvent;
            const response = await handler(event, { surface: 'v1' });
            expect(response.status, `${file} ${method}`).toBe(404);
            expect(await response.json(), `${file} ${method}`).toEqual(
                await ApiProblem.notFound().json(),
            );
        }
    });
}
