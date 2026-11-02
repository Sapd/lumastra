// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { UserContext } from '../types';
const mocks = vi.hoisted(() => ({ validate: vi.fn(), access: vi.fn(), resolve: vi.fn() }));
vi.mock('./playback-grant.js', () => ({
    validatePlaybackGrant: mocks.validate,
    playbackGrantUserContext: mocks.resolve,
}));
vi.mock('../middleware/media-access.js', () => ({ checkMediaAccess: mocks.access }));
import { authenticateAudiobookStream } from './audiobook-stream-auth';
const mediaId = '11111111-1111-4111-8111-111111111111';
const liveUser = {
    userId: 'owner',
    username: 'listener',
    userGroups: ['current'],
    maxAgeRating: 12,
} as unknown as UserContext;
const sql = vi.fn() as unknown as Sql;
beforeEach(() => {
    vi.clearAllMocks();
    mocks.validate.mockResolvedValue({ userId: 'owner', username: 'listener', isWildcard: false });
    mocks.access.mockResolvedValue(false);
});
it('checks grant requests against the forward-auth live UserContext', async () => {
    const result = await authenticateAudiobookStream({
        sql,
        mediaId,
        clientIp: '192.0.2.1',
        token: 'stream_secret',
        liveUser,
        playbackSessionId: 'public-session',
    });
    expect(result).toMatchObject({ ok: false, reason: 'not_an_audiobook' });
    expect(mocks.access).toHaveBeenCalledWith(sql, mediaId, liveUser);
    expect(mocks.validate).toHaveBeenCalledWith(
        'stream_secret',
        expect.objectContaining({
            route: expect.objectContaining({ playbackSessionId: 'public-session' }),
        }),
    );
    expect(mocks.resolve).not.toHaveBeenCalled();
});
it('fails closed on a grant denial before any upstream credential lookup', async () => {
    mocks.validate.mockResolvedValue({ reason: 'wrong_scope', grantId: 'grant' });
    expect(
        await authenticateAudiobookStream({
            sql,
            mediaId,
            clientIp: '192.0.2.1',
            token: 'stream_secret',
            liveUser,
        }),
    ).toMatchObject({ reason: 'invalid_token' });
    expect(mocks.access).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
});
