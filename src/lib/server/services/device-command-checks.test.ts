// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Simple-mode lock for a household helper: the lock is the OWNER's setting,
 * so it is read with the owner's id; Live TV and playback controls stay open.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserById: vi.fn(async () => ({ username: 'owner' })),
}));
vi.mock('$lib/server/auth/livetv-user-policy.js', () => ({
    userAllowsLiveTv: vi.fn(async () => true),
}));
const feature = vi.hoisted(() => ({ enabled: true }));
vi.mock('$lib/server/config.js', () => ({
    config: {
        get FEATURE_LIVETV() {
            return feature.enabled;
        },
    },
}));
vi.mock('$lib/server/services/livetv/channel-access.js', () => ({
    canStreamLiveTvChannel: vi.fn(
        async (_locals: unknown, id: string) => id === '11111111-1111-4111-8111-111111111111',
    ),
}));
vi.mock('$lib/server/services/livetv/station.service.js', () => ({
    resolveStation: vi.fn(async (id: string) => ({
        stationId: id,
        shownFeedId: id,
        groupId: null,
    })),
}));
vi.mock('$lib/server/services/watch-together.service.js', () => ({
    getSessionWithParticipant: vi.fn().mockResolvedValue({}),
    getSession: vi.fn().mockResolvedValue({}),
}));
vi.mock('$lib/server/services/livetv/simple-mode.service.js', () => ({
    getSimpleMode: vi.fn(),
}));
import { deviceCommandChecks } from './device-command-checks.js';
import { getSimpleMode } from '$lib/server/services/livetv/simple-mode.service.js';
import { canStreamLiveTvChannel } from '$lib/server/services/livetv/channel-access.js';
import { getSessionWithParticipant } from '$lib/server/services/watch-together.service.js';

const HELPER = toUserId('00000000-0000-0000-0000-000000000001');
const OWNER = toUserId('00000000-0000-0000-0000-000000000002');
const sql = {} as postgres.Sql;
const CHANNEL = '11111111-1111-4111-8111-111111111111';

function checks(ownerUserId?: typeof OWNER, hasLiveTvPermission = true) {
    const built = deviceCommandChecks({
        sql,
        userId: HELPER,
        ...(ownerUserId ? { ownerUserId } : {}),
        hasLiveTvPermission,
        locals: {} as never,
    });
    return {
        check: async (request: unknown) => (await built.check?.(request as never)) ?? null,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    feature.enabled = true;
    vi.mocked(getSimpleMode).mockImplementation((async (_sql: unknown, userId: unknown) =>
        userId === OWNER
            ? { enabled: true, locked: true }
            : { enabled: false, locked: false }) as never);
});

describe('deviceCommandChecks with a household helper', () => {
    it('refuses media.play and party.join when the OWNER is locked', async () => {
        const c = checks(OWNER);
        const play = await c.check({
            type: 'media.play',
            args: { kind: 'movie', itemId: 'x' },
        } as never);
        expect(play?.kind).toBe('simple_mode_locked');
        const party = await c.check({ type: 'party.join', args: { code: 'ABC' } } as never);
        expect(party?.kind).toBe('simple_mode_locked');
        expect(getSimpleMode).toHaveBeenCalledWith(sql, OWNER);
    });

    it('still allows Live TV and playback controls', async () => {
        const c = checks(OWNER);
        expect(await c.check({ type: 'livetv.channelUp' } as never)).toBeNull();
        expect(
            await c.check({ type: 'livetv.tune', args: { stationId: CHANNEL } } as never),
        ).toBeNull();
        expect(await c.check({ type: 'playback.pause' } as never)).toBeNull();
    });

    it('without an owner id the sender own setting applies (own devices)', async () => {
        const c = checks();
        expect(
            await c.check({ type: 'media.play', args: { kind: 'movie', itemId: 'x' } } as never),
        ).toBeNull();
        expect(getSimpleMode).toHaveBeenCalledWith(sql, HELPER);
    });

    it('a helper without Live TV of their own may tune the owner TV to a channel a viewer may stream', async () => {
        const c = checks(OWNER, false);
        expect(
            await c.check({ type: 'livetv.tune', args: { stationId: CHANNEL } } as never),
        ).toBeNull();
        expect(await c.check({ type: 'livetv.channelDown' } as never)).toBeNull();
        // The viewer rule without the helper's (or anyone's) admin standing.
        expect(canStreamLiveTvChannel).toHaveBeenCalledWith({}, CHANNEL);
        const unknown = await c.check({
            type: 'livetv.tune',
            args: { stationId: '22222222-2222-4222-8222-222222222222' },
        } as never);
        expect(unknown?.kind).toBe('not_found');
    });

    it('on their own devices the sender still needs Live TV permission', async () => {
        const c = checks(undefined, false);
        expect((await c.check({ type: 'livetv.channelUp' } as never))?.kind).toBe(
            'feature_unavailable',
        );
    });
});

describe('party.join for a household helper', () => {
    const join = { type: 'party.join', args: { code: 'ABC' } };

    it('needs the OWNER in the party, not the helper', async () => {
        vi.mocked(getSimpleMode).mockResolvedValue({ enabled: false, locked: false } as never);
        vi.mocked(getSessionWithParticipant).mockImplementation((async (
            _code: string,
            userId: string,
        ) => (userId === String(HELPER) ? {} : null)) as never);
        const refused = await checks(OWNER).check(join);
        expect(refused?.kind).toBe('forbidden');
        expect(getSessionWithParticipant).toHaveBeenCalledWith('ABC', String(OWNER));

        vi.mocked(getSessionWithParticipant).mockResolvedValue({} as never);
        expect(await checks(OWNER).check(join)).toBeNull();
    });

    it('on the sender own device the sender must be in the party', async () => {
        vi.mocked(getSimpleMode).mockResolvedValue({ enabled: false, locked: false } as never);
        vi.mocked(getSessionWithParticipant).mockResolvedValue({} as never);
        await checks().check(join);
        expect(getSessionWithParticipant).toHaveBeenCalledWith('ABC', String(HELPER));
    });
});

it.each(['livetv.tune', 'livetv.channelUp', 'livetv.channelDown'])(
    '%s returns the same unavailable denial as an unconfigured feature',
    async (type) => {
        const request = { type, args: { stationId: CHANNEL } };
        const denied = await checks(undefined, false).check(request);
        feature.enabled = false;
        const absent = await checks(undefined, true).check(request);
        feature.enabled = true;
        expect(denied).toEqual(absent);
        expect(denied?.kind).toBe('feature_unavailable');
        expect(denied?.message).not.toMatch(/permission|requires/i);
    },
);

it.each(['livetv.tune', 'livetv.channelUp', 'livetv.channelDown'])(
    '%s checks the helper target owner switch and returns the unconfigured response',
    async (type) => {
        const { userAllowsLiveTv } = await import('$lib/server/auth/livetv-user-policy.js');
        vi.mocked(userAllowsLiveTv).mockResolvedValueOnce(false);
        const result = await checks(OWNER, true).check({ type, args: { stationId: CHANNEL } });
        expect(result?.kind).toBe('feature_unavailable');
        expect(result).toEqual({ kind: 'feature_unavailable', message: '' });
    },
);
