// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toPublicParties, toPublicFrame, toPublicFramesForSurface } from './watch-together-public';
import type { StoredSession } from './watch-together.service';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserDisplayInfoByIds: lookup,
}));
vi.mock('$lib/server/services/image-descriptor/avatars.js', () => ({
    userImageSets: async (_sql: unknown, surface: 'v1' | 'internal', ids: string[]) => {
        const { userAvatarSet } = await import('$lib/shared/image-descriptor');
        return new Map(ids.map((id) => [id, userAvatarSet(surface, { userId: id, version: '3' })]));
    },
}));
vi.mock('$app/paths', () => ({ base: '' }));
const HOST = '11111111-1111-4111-8111-111111111111';
const GUEST = '11111111-1111-4111-8111-111111111112';

beforeEach(() => {
    lookup.mockReset();
    lookup.mockResolvedValue([
        { id: HOST, display_name: null },
        { id: GUEST, display_name: 'Guest Display' },
    ]);
});

describe('public party projection', () => {
    it('batches authors across parties, excludes stored names, and uses the receiving surface', async () => {
        const session = {
            code: 'ABC123',
            hostUserId: HOST,
            hostDisplayName: 'private-login',
            participants: [
                { userId: GUEST, displayName: 'guest-login', clientId: 'guest', joinedAt: 1 },
            ],
        } as StoredSession;
        const parties = await toPublicParties([session, session], 'v1');
        expect(lookup).toHaveBeenCalledOnce();
        expect(lookup).toHaveBeenCalledWith(expect.anything(), [HOST, GUEST]);
        expect(parties[0].host).toMatchObject({
            userId: HOST,
            displayName: null,
            images: {
                primary: {
                    href: `/api/v1/users/${HOST}/images/avatar?size=card&v=3`,
                    revision: '3',
                    source: 'self',
                },
            },
        });
        expect(parties[0].participants[0]).toMatchObject({
            userId: GUEST,
            displayName: 'Guest Display',
            clientId: 'guest',
            joinedAt: 1,
        });
        expect(parties[0]).not.toHaveProperty('hostUserId');
        expect(JSON.stringify(parties)).not.toContain('login');
    });

    it('publishes named actors under author and remaps replay avatar links', async () => {
        const frame = await toPublicFrame({
            type: 'participant_left',
            userId: HOST,
            displayName: 'private-login',
            clientId: 'host',
        });
        expect(frame).toMatchObject({
            type: 'participant_left',
            author: { userId: HOST, displayName: null },
        });
        expect(frame).not.toHaveProperty('userId');
        expect(toPublicFramesForSurface(frame, 'internal')).toMatchObject({
            author: {
                images: {
                    primary: {
                        href: `/api/users/${HOST}/images/avatar?size=card&v=3`,
                        revision: '3',
                        source: 'self',
                    },
                },
            },
        });
    });
});
