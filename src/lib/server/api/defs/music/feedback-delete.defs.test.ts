// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';
const clear = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/services/music-interaction-manager.service.js', () => ({
    musicInteractionManager: { clearFeedback: clear },
}));
import { mount } from '$lib/server/api/mount.js';
import { def } from '../user/music/tracks/[id]/feedback.js';
import * as route from '../../../../../routes/api/me/music/tracks/[id]/feedback/+server.js';
const id = '11111111-2222-4333-a444-555555555555';
function event(authenticated = true): RequestEvent {
    const url = new URL(`http://localhost/api/me/music/tracks/${id}/feedback`);
    return {
        url,
        request: new Request(url, { method: 'DELETE' }),
        params: { id },
        route: { id: '/api/me/music/tracks/[id]/feedback' },
        locals: {
            principal: authenticated
                ? {
                      kind: 'session',
                      userId: toUserId('00000000-0000-4000-a000-000000000001'),
                      username: 'alice',
                      userGroups: [],
                      scopes: ['media:write'],
                      isAdmin: false,
                  }
                : undefined,
            user: authenticated
                ? {
                      userId: toUserId('00000000-0000-4000-a000-000000000001'),
                      username: 'alice',
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
                  }
                : null,
        },
        cookies: {},
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}
beforeEach(() => {
    vi.clearAllMocks();
    clear.mockResolvedValue(undefined);
});
describe('unified feedback DELETE replaces body-based queue aliases', () => {
    it('is mounted and accepts a body-less DELETE twice', async () => {
        const { DELETE } = mount(def, { surface: 'internal' });
        expect((await DELETE!(event())).status).toBe(204);
        expect((await route.DELETE!(event())).status).toBe(204);
        expect(clear).toHaveBeenCalledTimes(2);
        expect(clear.mock.calls[0][1]).toBe(id);
        for (const call of clear.mock.calls) {
            expect(call).toEqual([
                toUserId('00000000-0000-4000-a000-000000000001'),
                id,
                event().locals.user,
            ]);
        }
        expect(route.DELETE).toBeTypeOf('function');
    });
    it('rejects unauthenticated deletes before any mutation', async () => {
        const { DELETE } = mount(def, { surface: 'internal' });
        expect((await DELETE!(event(false))).status).toBe(401);
        expect(clear).not.toHaveBeenCalled();
    });
});
