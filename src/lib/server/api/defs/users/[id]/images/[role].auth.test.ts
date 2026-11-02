// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/users/{id}/images/{role}[/{index}] and GET .../images need a
 * principal. An uploaded avatar and the initials generated from a user's name
 * are personal data; an unauthenticated caller gets the same 401 for an
 * existing and an unknown id, with or without `?fallback=initials`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

import { userAvatarSet } from '$lib/shared/image-descriptor.js';

const getUserAvatar = vi.fn();
const userImageSets = vi.fn();
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({ bandwidthTracker: { trackImage: vi.fn() } }));
vi.mock('$lib/server/services/image-proxy/index.js', async () => ({
    ...(await import('$lib/server/services/image-proxy/response.js')),
    getImageProxyService: () => ({ getUserAvatar }),
}));
vi.mock('$lib/server/services/image-descriptor/avatars.js', () => ({
    userImageSets: (...args: unknown[]) => userImageSets(...args),
}));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));

const { mount } = await import('$lib/server/api/mount.js');
const { def } = await import('./[role].js');
const { def: indexed } = await import('./[role]/[index].js');
const { def: listing } = await import('./index.js');

const EXISTING = '11111111-1111-4111-8111-111111111111';
const UNKNOWN = '22222222-2222-4222-8222-222222222222';

function event(path: string, params: Record<string, string>, authed: boolean): RequestEvent {
    const request = new Request(`http://localhost${path}`);
    const locals = authed
        ? { principal: { username: 'viewer', userId: 'viewer-id' }, user: { username: 'viewer', userId: 'viewer-id' } }
        : {};
    return { request, url: new URL(request.url), params, locals } as unknown as RequestEvent;
}

const roleGet = mount(def, { surface: 'v1' }).GET!;
const indexGet = mount(indexed, { surface: 'v1' }).GET!;
const listGet = mount(listing, { surface: 'v1' }).GET!;

beforeEach(() => {
    getUserAvatar.mockReset().mockImplementation(async (id: string) =>
        id === EXISTING
            ? { buffer: Buffer.from('avatar'), contentType: 'image/webp', cacheControl: 'public, max-age=300' }
            : null,
    );
    userImageSets.mockReset().mockResolvedValue(
        new Map([[EXISTING, userAvatarSet('v1', { userId: EXISTING, version: '1' })]]),
    );
});

describe('unauthenticated user image requests', () => {
    const cases: [string, string][] = [
        ['existing id', EXISTING],
        ['unknown id', UNKNOWN],
        ['username', 'alice'],
    ];
    it.each(cases)('avatar %s -> 401 problem+json, with and without fallback', async (_n, id) => {
        for (const q of ['', '?fallback=initials', '?size=thumb&fallback=initials']) {
            const res = await roleGet(event(`/x${q}`, { id, role: 'avatar' }, false));
            expect(res.status).toBe(401);
            expect(res.headers.get('content-type')).toContain('application/problem+json');
            expect(res.headers.get('content-type')).not.toContain('svg');
        }
        expect(getUserAvatar).not.toHaveBeenCalled();
    });

    it.each(cases)('avatar/0 %s -> 401', async (_n, id) => {
        const res = await indexGet(event('/x?fallback=initials', { id, role: 'avatar', index: '0' }, false));
        expect(res.status).toBe(401);
        expect(getUserAvatar).not.toHaveBeenCalled();
    });

    it.each(cases)('images listing %s -> 401 (no existence oracle)', async (_n, id) => {
        const res = await listGet(event('/x', { id }, false));
        expect(res.status).toBe(401);
        expect(userImageSets).not.toHaveBeenCalled();
    });

    it('responses for existing and unknown ids are indistinguishable', async () => {
        const a = await roleGet(event('/x?fallback=initials', { id: EXISTING, role: 'avatar' }, false));
        const b = await roleGet(event('/x?fallback=initials', { id: UNKNOWN, role: 'avatar' }, false));
        expect(a.status).toBe(b.status);
        expect(await a.text()).toBe(await b.text());
    });

    it('a forged ?sig= is not a credential for user images', async () => {
        const res = await roleGet(event('/x?sig=abc&expires=9999999999&purpose=image', { id: EXISTING, role: 'avatar' }, false));
        expect(res.status).toBe(401);
    });
});

describe('authenticated user image requests', () => {
    it('serves the avatar with a private cache scope', async () => {
        const res = await roleGet(event('/x', { id: EXISTING, role: 'avatar' }, true));
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toMatch(/^private,/);
        expect(res.headers.get('vary')).toMatch(/Authorization/);
    });

    it('serves the initials fallback as private', async () => {
        const res = await roleGet(event('/x?fallback=initials', { id: UNKNOWN, role: 'avatar' }, true));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('image/svg+xml');
        expect(res.headers.get('cache-control')).toMatch(/^private,/);
    });

    it('unknown id without fallback is a 404 for an authenticated caller', async () => {
        const res = await roleGet(event('/x', { id: UNKNOWN, role: 'avatar' }, true));
        expect(res.status).toBe(404);
    });

    it('avatar/0 and the listing answer 200', async () => {
        expect((await indexGet(event('/x', { id: EXISTING, role: 'avatar', index: '0' }, true))).status).toBe(200);
        expect((await listGet(event('/x', { id: EXISTING }, true))).status).toBe(200);
    });
});
