// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// getUser / getUsers report downloadRole from canDownload, not a constant true.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const m = vi.hoisted(() => ({ canDownload: vi.fn() }));
vi.mock('$lib/server/services/download-access.service.js', () => ({
    canDownload: (...a: unknown[]) => m.canDownload(...a),
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserAdminStatus: async () => false,
    getUserByUsername: async (_s: unknown, name: string) => ({ id: `id-${name}` }),
}));

const { handleGetUser, handleGetUsers } = await import('./user.js');

const auth = {
    userId: 'u1',
    username: 'alice',
    ownerIsAdmin: false,
    displayName: null,
    clientName: 'DSub',
    format: 'json',
    userGroups: [],
    maxAgeRating: null,
    isAgeRestricted: false,
} as never;

function ev(username: string): RequestEvent {
    const url = new URL(`http://localhost/rest/getUser.view?username=${username}`);
    return {
        url,
        request: new Request(url),
        locals: { subsonicBodyParams: new URLSearchParams() },
    } as unknown as RequestEvent;
}

beforeEach(() => vi.clearAllMocks());

describe('downloadRole', () => {
    it('is false when the user may not download', async () => {
        m.canDownload.mockResolvedValue(false);
        const body = await (await handleGetUser(ev('alice'), auth, {} as never)).json();
        expect(body['subsonic-response'].user.downloadRole).toBe(false);
        expect(m.canDownload).toHaveBeenCalledWith({
            userId: 'u1',
            username: 'alice',
            isAdmin: false,
        });
    });

    it('is true when allowed, and getUsers agrees', async () => {
        m.canDownload.mockResolvedValue(true);
        const one = await (await handleGetUser(ev('alice'), auth, {} as never)).json();
        expect(one['subsonic-response'].user.downloadRole).toBe(true);
        const many = await (await handleGetUsers(ev('alice'), auth, {} as never)).json();
        expect(many['subsonic-response'].users.user[0].downloadRole).toBe(true);
    });

    it('an admin looking up another user judges that user, not themselves', async () => {
        m.canDownload.mockResolvedValue(false);
        const adminAuth = { ...(auth as object), ownerIsAdmin: true } as never;
        await handleGetUser(ev('bob'), adminAuth, {} as never);
        expect(m.canDownload).toHaveBeenCalledWith({
            userId: 'id-bob',
            username: 'bob',
            isAdmin: false,
        });
    });
});
