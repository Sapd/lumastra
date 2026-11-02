// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Watch Together join page obeys the same rules as the join endpoints: the
 * feature flag, the viewer's access to the party's item, and the per-user join
 * budget for misses. It used to answer any signed-in user with the party's
 * title, item id and host for any live code, with no limit on guessing.
 * Found in the 2026-10-07 entry-point review.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    features: { watchTogether: true },
    getSession: vi.fn(),
    checkMediaAccess: vi.fn(),
    checkRateLimit: vi.fn(),
}));

vi.mock('$lib/server/config', () => ({ features: mocks.features }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserDisplayInfoByIds: vi.fn(async () => [
        { id: '11111111-1111-4111-8111-111111111111', display_name: 'Host Display' },
    ]),
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: mocks.checkMediaAccess,
}));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: mocks.checkRateLimit,
}));
vi.mock('$lib/server/services/watch-together.service', () => ({
    getSession: mocks.getSession,
}));

import { load } from './+page.server';

type LoadEvent = Parameters<typeof load>[0];

const USER = { userId: '11111111-1111-4111-8111-111111111112', username: 'guest', isAdmin: false };
const SESSION = {
    code: 'ABC123',
    title: 'Garden diary',
    mediaType: 'movie',
    itemId: 'item-1',
    fileId: 'file-1',
    hostUserId: '11111111-1111-4111-8111-111111111111',
    hostDisplayName: 'host',
    participants: [{ userId: '11111111-1111-4111-8111-111111111111', displayName: 'host' }],
    visibility: 'unlisted',
};

function run(code = 'ABC123'): ReturnType<typeof load> {
    return load({ params: { code }, locals: { user: USER } } as unknown as LoadEvent);
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.features.watchTogether = true;
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.checkMediaAccess.mockResolvedValue(true);
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });
});

describe('/party/[code] load', () => {
    it('shows a live party whose item the viewer may see, without charging the join budget', async () => {
        const data = (await run()) as { party: { title: string } };
        expect(data.party.title).toBe('Garden diary');
        expect(data).toMatchObject({
            userId: USER.userId,
            party: { host: { displayName: 'Host Display' }, visibility: 'unlisted' },
        });
        expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    });

    it('a party for an item the viewer may not see is indistinguishable from a missing one', async () => {
        mocks.checkMediaAccess.mockResolvedValue(false);
        await expect(run()).rejects.toMatchObject({ status: 404 });
    });

    it('a failing access check fails closed', async () => {
        mocks.checkMediaAccess.mockRejectedValue(new Error('db down'));
        await expect(run()).rejects.toMatchObject({ status: 404 });
    });

    it('misses spend the shared per-user join budget, and an exhausted budget answers 429', async () => {
        mocks.getSession.mockResolvedValue(null);
        await expect(run('ZZZ999')).rejects.toMatchObject({ status: 404 });
        expect(mocks.checkRateLimit).toHaveBeenCalledWith(`wt-join:${USER.userId}`, 20, 60);

        mocks.checkRateLimit.mockResolvedValue({ allowed: false, resetAt: 0 });
        await expect(run('ZZZ998')).rejects.toMatchObject({ status: 429 });
    });

    it('is a 404 when Watch Together is off', async () => {
        mocks.features.watchTogether = false;
        await expect(run()).rejects.toMatchObject({ status: 404 });
        expect(mocks.getSession).not.toHaveBeenCalled();
    });
});
