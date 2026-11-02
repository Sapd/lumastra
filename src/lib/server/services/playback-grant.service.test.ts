// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { config } from '../config';

const mocks = vi.hoisted(() => ({
    preview: vi.fn(),
    allowLiveTv: vi.fn(),
    liveSession: vi.fn(),
    livePeek: vi.fn(),
    txOpen: vi.fn(),
    liveRefresh: vi.fn(),
    access: vi.fn(),
    userAccess: vi.fn(),
    sql: vi.fn(),
    tombstoned: vi.fn(() => false),
}));
vi.mock('../auth/livetv-user-policy.js', () => ({ userAllowsLiveTv: mocks.allowLiveTv }));
// SQL fragment construction is covered against PostgreSQL in the integration suite.
vi.mock('../database/queries/play-sessions.queries.js', () => ({
    musicPrefetchUsable: () => true,
    playbackGrantSessionUsable: () => true,
}));
vi.mock('./livetv/livetv-session.service.js', () => ({
    getLiveTvSessionService: () => ({
        getPlaybackSession: mocks.liveSession,
        peekPlaybackSession: mocks.livePeek,
        refreshPlaybackSession: mocks.liveRefresh,
    }),
}));
vi.mock('./preview-session.service', () => ({ getPreviewSession: mocks.preview }));
vi.mock('../middleware/media-access', () => ({ checkMediaAccess: mocks.access }));
vi.mock('../auth/resolve-token-user-access', () => ({ resolveTokenUserAccess: mocks.userAccess }));
vi.mock('../database/connection', () => ({
    Database: class {
        getSql() {
            return mocks.sql;
        }
    },
}));
vi.mock('../config', () => ({
    config: {
        STREAMING_SESSION_ENFORCE_IP: true,
        get STREAM_TOKEN_WILDCARD_IP() {
            return true;
        },
    },
}));
vi.mock('../oauth/streaming-session.service', () => ({
    STREAM_TOKEN_PREFIX: 'stream_',
    WILDCARD_IP: '*',
}));
vi.mock('../oauth/device-session-liveness', () => ({
    isDeviceSessionTombstoned: mocks.tombstoned,
}));
import {
    playbackGrantUserContext,
    buildGrantedHref,
    invalidatePlaybackGrantCache,
    getPlaybackGrant,
    mintPlaybackGrant,
    renewPlaybackGrant,
    revokePlaybackGrant,
    revokeGrantsForPlaySession,
    PlaybackGrantStoreUnavailableError,
    validatePlaybackGrant,
    resolvePlaybackGrantRoute,
} from './playback-grant';

const id = '00000000-0000-4000-8000-000000000001';
const owner = '00000000-0000-4000-8000-000000000002';
const media = '00000000-0000-4000-8000-000000000003';
const session = '00000000-0000-4000-8000-000000000004';
const secret = 'stream_original';
function row() {
    return {
        id,
        user_id: owner,
        username: 'owner',
        media_item_id: media,
        play_session_id: session,
        grant_kind: 'music',
        grant_ttl_ms: 60_000,
        token_hash: createHash('sha256').update(secret).digest('hex'),
        client_ip: '192.0.2.1',
        device_session_id: null,
        is_active: true,
        is_wildcard: false,
        created_at: new Date(),
        last_used_at: new Date(),
        expires_at: new Date(Date.now() + 60_000),
        minted_by_admin: false,
    };
}
const validation = {
    clientIp: '192.0.2.1',
    route: { mediaId: media, playbackSessionId: session, kind: 'music' as const },
};

beforeEach(() => {
    vi.useRealTimers();
    mocks.allowLiveTv.mockReset().mockResolvedValue(true);
    invalidatePlaybackGrantCache();
    mocks.preview.mockReset();
    mocks.liveSession
        .mockReset()
        .mockResolvedValue({ sessionId: session, username: 'owner', state: 'active' });
    mocks.liveRefresh.mockReset().mockResolvedValue(undefined);
    mocks.txOpen.mockReset();
    mocks.livePeek
        .mockReset()
        .mockResolvedValue({ sessionId: session, username: 'owner', state: 'active' });
    mocks.access.mockReset().mockResolvedValue(true);
    mocks.userAccess.mockReset().mockResolvedValue({
        userGroups: ['library'],
        disabled: false,
        deleted: false,
        nonAdminMaxAgeRating: 12,
        permissions: {
            ownerIsAdmin: false,
            maxAgeRating: 12,
            isModerator: false,
            hasLiveTvPermission: true,
        },
    });
    mocks.sql.mockReset();
    mocks.tombstoned.mockReset().mockReturnValue(false);
    Object.assign(mocks.sql, {
        begin: async (fn: (sql: unknown) => unknown) => {
            mocks.txOpen(true);
            try {
                return await fn(mocks.sql);
            } finally {
                mocks.txOpen(false);
            }
        },
    });
});

describe('playback grant core', () => {
    it.each(['video', 'audiobook', 'music', 'live'] as const)(
        'clamps %s lifetime and mints an item-scoped opaque secret',
        async (kind) => {
            mocks.sql.mockResolvedValue([{ ...row(), grant_kind: kind }]);
            const before = Date.now();
            const grant = await mintPlaybackGrant({
                userId: owner,
                mediaId: media,
                playbackSessionId: session,
                kind,
                clientIp: '192.0.2.1',
                ttl: 100 * 60 * 60 * 1000,
            });
            expect(grant.id).toBe(id);
            expect(grant.token).toMatch(/^stream_[a-f0-9]{64}$/);
            expect(grant.token).not.toBe(grant.id);
            const values = mocks.sql.mock.calls[0].slice(1);
            const expiry = values.find((v) => v instanceof Date) as Date;
            const ceiling = (kind === 'video' || kind === 'audiobook' ? 24 : 6) * 60 * 60 * 1000;
            expect(expiry.getTime() - before).toBeGreaterThanOrEqual(ceiling);
            expect(expiry.getTime() - before).toBeLessThan(ceiling + 1000);
            expect(mocks.sql.mock.calls[0][0].join('')).toContain('false');
        },
    );

    it.each(['video', 'audiobook', 'music', 'live'] as const)(
        'defaults %s to its ceiling without ttl',
        async (kind) => {
            mocks.sql.mockResolvedValue([{ ...row(), grant_kind: kind }]);
            const before = Date.now();
            await mintPlaybackGrant({
                userId: owner,
                mediaId: media,
                playbackSessionId: session,
                kind,
                clientIp: '192.0.2.1',
            });
            const expiry = mocks.sql.mock.calls[0].find((value) => value instanceof Date) as Date;
            const hours = kind === 'video' || kind === 'audiobook' ? 24 : 6;
            expect(expiry.getTime() - before).toBeGreaterThanOrEqual(hours * 3_600_000);
            expect(expiry.getTime() - before).toBeLessThan(hours * 3_600_000 + 1000);
        },
    );

    it('mints cast grants with a wildcard IP while retaining item and session scope', async () => {
        mocks.sql.mockResolvedValue([row()]);
        await mintPlaybackGrant({
            userId: owner,
            mediaId: media,
            playbackSessionId: session,
            kind: 'video',
            clientIp: '192.0.2.1',
            castTarget: true,
        });
        expect(mocks.sql.mock.calls[0]).toContain('*');
        expect(mocks.sql.mock.calls[0]).toContain(media);
        expect(mocks.sql.mock.calls[0]).toContain(session);
    });

    it('keeps cast requests pinned when the admin policy is disabled', async () => {
        const policy = vi.spyOn(config, 'STREAM_TOKEN_WILDCARD_IP', 'get').mockReturnValue(false);
        try {
            mocks.sql.mockResolvedValue([row()]);
            await mintPlaybackGrant({
                userId: owner,
                mediaId: media,
                playbackSessionId: session,
                kind: 'video',
                clientIp: '192.0.2.1',
                castTarget: true,
            });
            expect(mocks.sql.mock.calls[0]).toContain('192.0.2.1');
            expect(mocks.sql.mock.calls[0].slice(1)).not.toContain('*');
        } finally {
            policy.mockRestore();
        }
    });

    it.each(['', '*', 'wildcard'])('rejects non-item scope %s before writing', async (mediaId) => {
        await expect(
            mintPlaybackGrant({
                userId: owner,
                mediaId,
                playbackSessionId: null,
                kind: 'music',
                clientIp: '*',
            }),
        ).rejects.toThrow('specific media item');
        expect(mocks.sql).not.toHaveBeenCalled();
    });

    it('does not disclose a secret in owner metadata', async () => {
        mocks.sql.mockResolvedValue([row()]);
        expect(await getPlaybackGrant(id, owner)).not.toHaveProperty('token');
        expect(mocks.sql.mock.calls[0]).toContain(owner);
        expect(await getPlaybackGrant('malformed', owner)).toBeNull();
    });

    it('extends expiry in place, preserving the secret, binding and pin', async () => {
        const original = { ...row(), grant_ttl_ms: 6 * 3_600_000 };
        mocks.sql.mockResolvedValue([original]);
        const renewed = await renewPlaybackGrant(id, owner, 'v1', secret);
        expect(renewed).toMatchObject({
            id,
            token: secret,
            ipPinned: true,
            playbackSessionId: session,
        });
        const update = mocks.sql.mock.calls[1];
        expect(update[0].join('')).toContain('SET expires_at =');
        expect(update[0].join('')).not.toMatch(
            /token_hash\s*=|client_ip\s*=|media_item_id\s*=|play_session_id\s*=/,
        );
        expect(mocks.userAccess).toHaveBeenCalledWith('owner', { freshGroups: true });
        expect(mocks.access).toHaveBeenCalledWith(
            mocks.sql,
            media,
            expect.objectContaining({ userGroups: ['library'], maxAgeRating: 12 }),
        );
    });

    it('caps renewal at seven days from creation and denies after the cap', async () => {
        const original = { ...row(), created_at: new Date(Date.now() - 7 * 86_400_000 + 1000) };
        mocks.sql.mockResolvedValue([original]);
        await renewPlaybackGrant(id, owner, 'v1', secret);
        const expiry = mocks.sql.mock.calls[1].find((value) => value instanceof Date) as Date;
        expect(expiry.getTime()).toBe(original.created_at.getTime() + 7 * 86_400_000);
        mocks.sql
            .mockClear()
            .mockResolvedValue([
                { ...original, created_at: new Date(Date.now() - 8 * 86_400_000) },
            ]);
        expect(await renewPlaybackGrant(id, owner, 'v1', secret)).toBeNull();
        expect(mocks.sql).toHaveBeenCalledTimes(1);
    });

    it('refuses renewal after loss of library or age access, and with another secret', async () => {
        mocks.sql.mockResolvedValue([row()]);
        mocks.access.mockResolvedValue(false);
        expect(await renewPlaybackGrant(id, owner, 'v1', secret)).toBeNull();
        expect(await renewPlaybackGrant(id, owner, 'v1', 'stream_other')).toBeNull();
        expect(mocks.sql).toHaveBeenCalledTimes(2);
    });

    it('denies renewal of a missing or foreign grant', async () => {
        mocks.sql.mockResolvedValue([]);
        expect(await renewPlaybackGrant(id, 'foreign')).toBeNull();
        expect(mocks.sql).toHaveBeenCalledTimes(1);
    });

    it('compares UUID media ids case-insensitively', async () => {
        const mediaId = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
        mocks.sql.mockResolvedValue([{ ...row(), media_item_id: mediaId }]);
        expect(
            await validatePlaybackGrant(secret, {
                ...validation,
                route: { ...validation.route, mediaId: mediaId.toUpperCase() },
            }),
        ).toHaveProperty('id', id);
    });

    it.each(['internal', 'v1'] as const)(
        'builds metadata renewal links for %s',
        async (surface) => {
            mocks.sql.mockResolvedValue([row()]);
            const grant = await getPlaybackGrant(id, owner, surface);
            expect(grant?.renewHref).toBe(
                `${surface === 'v1' ? '/api/v1' : '/api'}/playback/grants/${id}/renew`,
            );
        },
    );

    it('rechecks a prepared deck binding even when its positive grant result was cached', async () => {
        mocks.sql.mockResolvedValue([{ ...row(), is_music_prefetch: true }]);
        expect(await validatePlaybackGrant(secret, validation)).toHaveProperty('id', id);
        mocks.sql.mockResolvedValue([{ ...row(), failure_reason: 'session_ended' }]);
        expect(await validatePlaybackGrant(secret, validation)).toEqual({
            reason: 'session_ended',
            grantId: id,
        });
    });

    it('caches only positive validation for five seconds and throttles activity writes for fifteen', async () => {
        vi.useFakeTimers();
        mocks.sql.mockResolvedValue([row()]);
        expect(await validatePlaybackGrant(secret, validation)).toMatchObject({
            id,
            playbackSessionId: session,
        });
        expect(mocks.sql).toHaveBeenCalledTimes(2);
        expect(await validatePlaybackGrant(secret, validation)).toMatchObject({ id });
        expect(mocks.sql).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(5001);
        await validatePlaybackGrant(secret, validation);
        expect(mocks.sql).toHaveBeenCalledTimes(3);
        vi.advanceTimersByTime(10_000);
        await validatePlaybackGrant(secret, validation);
        expect(mocks.sql).toHaveBeenCalledTimes(5);
        mocks.sql.mockResolvedValue([]);
        vi.advanceTimersByTime(5001);
        expect(await validatePlaybackGrant(secret, validation)).toEqual({ reason: 'invalid' });
        await validatePlaybackGrant(secret, validation);
        expect(mocks.sql).toHaveBeenCalledTimes(7);
    });

    it.each([
        { ...validation, clientIp: '192.0.2.2' },
        { ...validation, route: { ...validation.route, mediaId: 'wrong' } },
        { ...validation, route: { ...validation.route, playbackSessionId: 'wrong' } },
        { ...validation, route: { ...validation.route, kind: 'video' as const } },
    ])('denies mismatched pin, item, session or kind', async (context) => {
        mocks.sql.mockResolvedValue([row()]);
        expect(await validatePlaybackGrant(secret, context)).toHaveProperty('reason');
        expect(mocks.sql).toHaveBeenCalledTimes(1);
    });

    it('allows an unbound item grant with a child playback id, but never a session-only route', async () => {
        mocks.sql.mockResolvedValue([{ ...row(), play_session_id: null }]);
        expect(await validatePlaybackGrant(secret, validation)).toHaveProperty('id', id);
        expect(
            await validatePlaybackGrant(secret, {
                ...validation,
                route: { playbackSessionId: session, kind: 'music' },
            }),
        ).toHaveProperty('reason', 'wrong_scope');
    });

    it('honours an explicitly unpinned grant', async () => {
        mocks.sql.mockResolvedValue([{ ...row(), client_ip: '*' }]);
        expect(await validatePlaybackGrant(secret, validation)).toHaveProperty('id', id);
    });

    it('revokes by owner and playback-session binding', async () => {
        mocks.sql.mockResolvedValue([{ id }]);
        expect(await revokePlaybackGrant(id, owner)).toBe(true);
        expect(mocks.sql.mock.calls[0]).toContain(owner);
        expect(await revokeGrantsForPlaySession(session)).toBe(1);
        expect(mocks.sql.mock.calls[1]).toContain(session);
    });

    it('builds ready base-relative hrefs and removes account credentials', () => {
        const href = buildGrantedHref(
            { token: 'stream_secret', playbackSessionId: session },
            '/api/v1/playback/id/hls?api_key=account&stream_token=old',
            { PlaySessionId: 'attacker', track: 2 },
        );
        expect(href).toBe(
            `/api/v1/playback/id/hls?PlaySessionId=${session}&track=2&grant=stream_secret`,
        );
        expect(() => buildGrantedHref({ token: secret }, 'https://other.invalid/a')).toThrow();
        expect(() => buildGrantedHref({ token: secret }, '//other.invalid/a')).toThrow();
    });
});

describe('round two grant boundaries', () => {
    it('requires a bound non-live session on every delivery request', async () => {
        mocks.sql.mockResolvedValue([row()]);
        expect(
            await validatePlaybackGrant(secret, {
                ...validation,
                route: { mediaId: media, kind: 'music' },
            }),
        ).toEqual({ reason: 'wrong_scope', grantId: id });
    });
    it('rejects pre-grant rows even with a correct item', async () => {
        mocks.sql.mockResolvedValue([{ ...row(), grant_kind: null }]);
        expect(await validatePlaybackGrant(secret, validation)).toMatchObject({
            reason: 'invalid',
        });
        expect(mocks.sql.mock.calls[0][0].join('')).toContain('t.grant_kind IS NOT NULL');
    });
    it('caps unpinned mint and renewal at six hours and keeps the pin state', async () => {
        const original = {
            ...row(),
            client_ip: '*',
            grant_kind: 'video',
            grant_ttl_ms: 86_400_000,
        };
        mocks.sql.mockResolvedValue([original]);
        const before = Date.now();
        const minted = await mintPlaybackGrant({
            userId: owner,
            mediaId: media,
            playbackSessionId: session,
            kind: 'video',
            clientIp: '192.0.2.1',
            castTarget: true,
        });
        expect(minted.ipPinned).toBe(false);
        const expiry = mocks.sql.mock.calls[0].find((value) => value instanceof Date) as Date;
        expect(expiry.getTime() - before).toBeLessThanOrEqual(6 * 3_600_000 + 1000);
        const renewed = await renewPlaybackGrant(id, owner, 'v1', secret);
        expect(renewed).toMatchObject({ token: secret, ipPinned: false });
        const update = mocks.sql.mock.calls.at(-1)!;
        expect(update[0].join('')).not.toContain('client_ip =');
        const extended = update.find((value) => value instanceof Date) as Date;
        expect(extended.getTime() - before).toBeLessThanOrEqual(6 * 3_600_000 + 1000);
    });
    it.each(['stopped', 'reaped', 'superseded', 'admin_kill'] as const)(
        'persists the %s lifecycle reason and evicts local validation',
        async (reason) => {
            mocks.sql.mockResolvedValue([row()]);
            await validatePlaybackGrant(secret, validation);
            await revokeGrantsForPlaySession(session, undefined, reason);
            expect(mocks.sql.mock.calls.at(-1)).toContain(reason);
            mocks.sql.mockResolvedValue([{ ...row(), is_active: false }]);
            expect(await validatePlaybackGrant(secret, validation)).toMatchObject({
                reason: 'revoked',
            });
        },
    );
    it.each(['revoke', 'renew'] as const)('invalidates a positive entry on %s', async (action) => {
        mocks.sql.mockResolvedValue([row()]);
        await validatePlaybackGrant(secret, validation);
        if (action === 'revoke') await revokePlaybackGrant(id, owner);
        else await renewPlaybackGrant(id, owner, 'v1', secret);
        mocks.sql.mockResolvedValue([]);
        expect(await validatePlaybackGrant(secret, validation)).toEqual({ reason: 'invalid' });
    });
    it.each(['expired', 'revoked', 'session_ended'] as const)(
        'returns the persisted %s denial',
        async (reason) => {
            mocks.sql.mockResolvedValue([{ ...row(), failure_reason: reason }]);
            expect(await validatePlaybackGrant(secret, validation)).toEqual({
                reason,
                grantId: id,
            });
            expect(mocks.sql).toHaveBeenCalledTimes(1);
        },
    );
    it('bounds the positive cache to 5000 token hashes', async () => {
        mocks.sql.mockResolvedValue([row()]);
        for (let i = 0; i < 5001; i++) await validatePlaybackGrant(`stream_${i}`, validation);
        const calls = mocks.sql.mock.calls.length;
        await validatePlaybackGrant('stream_5000', validation);
        expect(mocks.sql).toHaveBeenCalledTimes(calls);
        await validatePlaybackGrant('stream_0', validation);
        expect(mocks.sql).toHaveBeenCalledTimes(calls + 1);
    });
    it('accepts a legacy audiobook path session only when it maps to the bound public session', async () => {
        mocks.sql
            .mockResolvedValueOnce([{ ...row(), grant_kind: 'audiobook' }])
            .mockResolvedValueOnce([{ id: session }])
            .mockResolvedValue([]);
        expect(
            await validatePlaybackGrant(secret, {
                ...validation,
                route: {
                    kind: 'audiobook',
                    mediaId: media,
                    audiobookSessionId: 'abs-session',
                },
            }),
        ).toMatchObject({ id });
        expect(mocks.sql.mock.calls[1]).toContain('abs-session');
        expect(mocks.sql.mock.calls[1]).toContain(owner);
    });
});

it('never authorizes a preview with an unbound item grant', async () => {
    mocks.sql.mockResolvedValue([{ ...row(), grant_kind: 'video', play_session_id: null }]);
    expect(
        await validatePlaybackGrant(secret, {
            ...validation,
            route: {
                kind: 'video',
                mediaId: media,
                playbackSessionId: 'preview-item-123',
            },
        }),
    ).toMatchObject({ reason: 'wrong_scope' });
});

it('rejects an audiobook path session from another playback even with the correct query binding', async () => {
    mocks.sql
        .mockResolvedValueOnce([{ ...row(), grant_kind: 'audiobook' }])
        .mockResolvedValueOnce([]);
    expect(
        await validatePlaybackGrant(secret, {
            ...validation,
            route: {
                kind: 'audiobook',
                mediaId: media,
                playbackSessionId: session,
                audiobookSessionId: 'foreign-abs-session',
            },
        }),
    ).toMatchObject({ reason: 'wrong_scope' });
    expect(mocks.sql).toHaveBeenCalledTimes(2);
});

describe('Live TV grant renewal', () => {
    it('checks liveness read-only and outside the row lock', async () => {
        mocks.sql.mockResolvedValue([{ ...row(), grant_kind: 'live' }]);
        const events: string[] = [];
        mocks.livePeek.mockImplementation(async () => {
            events.push('peek');
            return { sessionId: session, username: 'owner', state: 'active' };
        });
        mocks.txOpen.mockImplementation((open: boolean) => events.push(open ? 'tx+' : 'tx-'));
        expect(await renewPlaybackGrant(id, owner, 'v1', secret)).toMatchObject({ id });
        expect(mocks.liveSession).not.toHaveBeenCalled();
        expect(events).toEqual(['tx+', 'tx-', 'peek', 'tx+', 'tx-']);
    });

    it('does not extend when the peeked Live session is ended', async () => {
        mocks.sql.mockResolvedValue([{ ...row(), grant_kind: 'live' }]);
        mocks.livePeek.mockResolvedValue({ sessionId: session, username: 'owner', state: 'ended' });
        expect(await renewPlaybackGrant(id, owner, 'v1', secret)).toBeNull();
        expect(mocks.liveSession).not.toHaveBeenCalled();
        expect(mocks.sql).toHaveBeenCalledTimes(1);
    });

    it('raises a typed store-unavailable error without holding a lock', async () => {
        mocks.sql.mockResolvedValue([{ ...row(), grant_kind: 'live' }]);
        mocks.livePeek.mockRejectedValue(new Error('Live TV session store unavailable'));
        await expect(renewPlaybackGrant(id, owner, 'v1', secret)).rejects.toBeInstanceOf(
            PlaybackGrantStoreUnavailableError,
        );
        expect(mocks.txOpen).toHaveBeenLastCalledWith(false);
    });
});

describe('Live TV grant delivery', () => {
    it('answers session_ended for its own ended session and wrong_scope for another session', async () => {
        mocks.sql.mockResolvedValue([{ ...row(), grant_kind: 'live' }]);
        expect(
            await validatePlaybackGrant(secret, {
                clientIp: validation.clientIp,
                route: { kind: 'live', playbackSessionId: session, sessionEnded: true },
            }),
        ).toMatchObject({ reason: 'session_ended' });
        expect(
            await validatePlaybackGrant(secret, {
                clientIp: validation.clientIp,
                route: { kind: 'live', playbackSessionId: 'another-session', sessionEnded: true },
            }),
        ).toMatchObject({ reason: 'wrong_scope' });
    });
    it('validates live bindings without touching play_sessions and heartbeats once per ten seconds', async () => {
        vi.useFakeTimers();
        mocks.sql.mockResolvedValue([{ ...row(), grant_kind: 'live' }]);
        const live = {
            clientIp: validation.clientIp,
            route: { kind: 'live' as const, playbackSessionId: session },
        };
        expect(await validatePlaybackGrant(secret, live)).toMatchObject({
            playbackSessionId: session,
        });
        await Promise.all([
            validatePlaybackGrant(secret, live),
            validatePlaybackGrant(secret, live),
        ]);
        expect(mocks.liveRefresh).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(9_999);
        await validatePlaybackGrant(secret, live);
        expect(mocks.liveRefresh).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await validatePlaybackGrant(secret, live);
        expect(mocks.liveRefresh).toHaveBeenCalledTimes(2);
        const queries = mocks.sql.mock.calls.map(([parts]) => parts.join('?'));
        expect(queries[0]).toContain("t.grant_kind NOT IN ('live', 'preview')");
        expect(queries.filter((q) => q.includes('UPDATE play_sessions'))).toEqual([]);
        vi.useRealTimers();
        mocks.allowLiveTv.mockReset().mockResolvedValue(true);
    });
    it('rejects an ended live session', async () => {
        mocks.sql.mockResolvedValue([{ ...row(), grant_kind: 'live' }]);
        mocks.liveSession.mockResolvedValue({ sessionId: session, state: 'ended' });
        expect(
            await validatePlaybackGrant(secret, {
                clientIp: validation.clientIp,
                route: { kind: 'live', playbackSessionId: session },
            }),
        ).toMatchObject({ reason: 'session_ended' });
        expect(mocks.liveRefresh).not.toHaveBeenCalled();
    });
    it.each([undefined, owner])(
        'rejects a missing or wrong live session binding (%s)',
        async (playbackSessionId) => {
            mocks.sql.mockResolvedValue([{ ...row(), grant_kind: 'live' }]);
            expect(
                await validatePlaybackGrant(secret, {
                    clientIp: validation.clientIp,
                    route: { kind: 'live', playbackSessionId },
                }),
            ).toMatchObject({ reason: 'wrong_scope' });
            expect(mocks.liveRefresh).not.toHaveBeenCalled();
        },
    );
});

it.each(['ended', 'missing'] as const)('never renews a %s Live session', async (state) => {
    mocks.sql.mockResolvedValue([{ ...row(), grant_kind: 'live' }]);
    mocks.livePeek.mockResolvedValue(
        state === 'missing' ? null : { sessionId: session, state: 'ended' },
    );
    expect(await renewPlaybackGrant(id, owner, 'v1', secret)).toBeNull();
    expect(mocks.sql).toHaveBeenCalledTimes(1);
    expect(mocks.liveRefresh).not.toHaveBeenCalled();
});

describe('restart denial still checks delivery boundaries', () => {
    it.each(['scope', 'ip', 'device'] as const)(
        'preserves %s enforcement before restart recovery',
        async (boundary) => {
            mocks.sql.mockResolvedValue([
                {
                    ...row(),
                    grant_kind: 'video',
                    is_active: false,
                    device_session_id: boundary === 'device' ? 'revoked-device' : null,
                    failure_reason: 'session_restarted',
                },
            ]);
            mocks.tombstoned.mockReturnValue(boundary === 'device');
            const result = await validatePlaybackGrant(secret, {
                clientIp: boundary === 'ip' ? '192.0.2.99' : validation.clientIp,
                route: {
                    kind: 'video',
                    playbackSessionId: session,
                    mediaId: boundary === 'scope' ? 'other-media' : media,
                },
            });
            expect(result).toEqual({
                reason:
                    boundary === 'scope'
                        ? 'wrong_scope'
                        : boundary === 'ip'
                          ? 'ip_mismatch'
                          : 'revoked',
                grantId: id,
            });
        },
    );
});

describe('preview delivery scope', () => {
    const previewId = 'preview-bound';
    const forbiddenPaths = [
        `/playback/${media}/file`,
        `/playback/${media}/stream`,
        `/Videos/${media}/stream`,
        `/Videos/${media}/stream.mp4`,
        `/media/${media}/download`,
        `/playback/${media}/avp/nonce/hls`,
        `/playback/subtitles/${media}/0`,
        `/playback/${media}/subtitles/external/subtitle`,
        `/playback/${media}/trickplay/320/0.jpg`,
        `/playback/${media}/hls/trickplay.m3u8`,
        `/playback/${media}/hls/iframe_00000.ts`,
        `/playback/${media}/hls/subs_0/index.m3u8`,
        `/Videos/${media}/hls/master.m3u8`,
    ];
    for (const prefix of ['/api', '/api/v1']) {
        for (const grantKind of ['video', 'preview']) {
            it.each(forbiddenPaths)(
                `${prefix} rejects ${grantKind} preview grant on %s`,
                async (path) => {
                    mocks.sql.mockResolvedValue([
                        { ...row(), grant_kind: grantKind, play_session_id: previewId },
                    ]);
                    mocks.preview.mockResolvedValue({ userId: owner, itemId: media });
                    const route = await resolvePlaybackGrantRoute(
                        new URL(`https://test${prefix}${path}?PlaySessionId=${previewId}`),
                    );
                    if (path === `/media/${media}/download`) {
                        expect(route).toBeNull();
                    } else {
                        expect(route).not.toBeNull();
                        expect(
                            await validatePlaybackGrant(secret, {
                                clientIp: validation.clientIp,
                                route: route!,
                            }),
                        ).toEqual({ reason: 'wrong_scope', grantId: id });
                    }
                },
            );
            it.each([
                'master.m3u8',
                'index.m3u8',
                'segment_00000.ts',
                'init_0.mp4',
                'stream_0/index.m3u8',
                'stream_0/segment_00000.m4s',
            ])(
                `${prefix} allows ${grantKind} preview HLS %s and rechecks scope from cache`,
                async (file) => {
                    mocks.sql.mockResolvedValue([
                        { ...row(), grant_kind: grantKind, play_session_id: previewId },
                    ]);
                    mocks.preview.mockResolvedValue({ userId: owner, itemId: media });
                    const route = await resolvePlaybackGrantRoute(
                        new URL(
                            `https://test${prefix}/playback/${media}/hls/${file}?PlaySessionId=${previewId}`,
                        ),
                    );
                    expect(route).not.toBeNull();
                    expect(
                        await validatePlaybackGrant(secret, {
                            clientIp: validation.clientIp,
                            route: route!,
                        }),
                    ).toHaveProperty('id', id);
                    const fileRoute = await resolvePlaybackGrantRoute(
                        new URL(
                            `https://test${prefix}/playback/${media}/file?PlaySessionId=${previewId}`,
                        ),
                    );
                    expect(
                        await validatePlaybackGrant(secret, {
                            clientIp: validation.clientIp,
                            route: fileRoute!,
                        }),
                    ).toEqual({ reason: 'wrong_scope', grantId: id });
                },
            );
        }
        it.each(['file', 'stream'])(
            `${prefix} preserves normal video delivery %s`,
            async (file) => {
                mocks.sql.mockResolvedValue([{ ...row(), grant_kind: 'video' }]);
                const route = await resolvePlaybackGrantRoute(
                    new URL(
                        `https://test${prefix}/playback/${media}/${file}?PlaySessionId=${session}`,
                    ),
                );
                expect(
                    await validatePlaybackGrant(secret, {
                        clientIp: validation.clientIp,
                        route: route!,
                    }),
                ).toHaveProperty('id', id);
            },
        );
    }
});

describe('Live TV switch on playback grants', () => {
    it('stops serving an already warmed grant on the next request', async () => {
        mocks.sql.mockResolvedValue([{ ...row(), grant_kind: 'live' }]);
        const live = {
            clientIp: validation.clientIp,
            route: { kind: 'live' as const, playbackSessionId: session },
        };
        const first = await validatePlaybackGrant(secret, live);
        expect(first).not.toHaveProperty('reason');
        mocks.allowLiveTv.mockResolvedValue(false);
        expect(await validatePlaybackGrant(secret, live)).toMatchObject({ reason: 'revoked' });
    });
    it('hides grant metadata and refuses renewal after Live TV is disabled', async () => {
        mocks.sql.mockResolvedValue([{ ...row(), grant_kind: 'live' }]);
        mocks.allowLiveTv.mockResolvedValue(false);
        expect(await getPlaybackGrant(id, owner)).toBeNull();
        expect(await renewPlaybackGrant(id, owner, 'v1', secret)).toBeNull();
    });
});

it('C-1: group revocation denies live grant delivery and renewal while preserving VOD', async () => {
    mocks.userAccess.mockResolvedValue({
        userGroups: [],
        disabled: false,
        deleted: false,
        nonAdminMaxAgeRating: null,
        permissions: { ownerIsAdmin: false, maxAgeRating: null, hasLiveTvPermission: false },
    });
    mocks.sql.mockResolvedValue([{ ...row(), grant_kind: 'live' }]);
    expect(
        (await playbackGrantUserContext({ ...row(), grant_kind: 'live' }))?.hasLiveTvPermission,
    ).toBe(false);
    expect(
        await validatePlaybackGrant(secret, {
            ...validation,
            route: { ...validation.route, kind: 'live' },
        }),
    ).toMatchObject({ reason: 'revoked' });
    expect(mocks.liveRefresh).not.toHaveBeenCalled();
    expect(await renewPlaybackGrant(id, owner, 'v1', secret)).toBeNull();
    expect(mocks.userAccess).toHaveBeenCalledWith('owner', { freshGroups: true });
    mocks.sql.mockResolvedValue([row()]);
    expect(await validatePlaybackGrant(secret, validation)).not.toHaveProperty('reason');
});

it.each(['video', 'music', 'audiobook', 'preview'] as const)(
    'C-1 follow-up: %s grant keeps its playback capability without the Live TV group',
    async (kind) => {
        mocks.userAccess.mockResolvedValue({
            userGroups: [],
            disabled: false,
            deleted: false,
            nonAdminMaxAgeRating: null,
            permissions: { ownerIsAdmin: false, maxAgeRating: null, hasLiveTvPermission: false },
        });
        const user = await playbackGrantUserContext({ ...row(), grant_kind: kind });
        expect(user?.hasLiveTvPermission).toBe(true);
    },
);
