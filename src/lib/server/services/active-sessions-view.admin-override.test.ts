// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression test: {@link getVisibleActiveSessions} must trust an
 * already-resolved `viewer.isAdmin` (e.g. from a DB admin_pinned/is_admin
 * override) rather than re-deriving admin status from `userGroups` alone.
 *
 * Before the fix, `isUserAdmin(userGroups)` was the ONLY admin signal this
 * service consulted. An admin whose status comes from the DB override (not
 * IdP/SSO group membership) has an empty/non-admin `userGroups`, so the
 * service treated them as a regular user and silently dropped every other
 * user's `hide_streams` session instead of showing it flagged `isPrivate`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StreamSession } from '../types.js';

vi.mock('./livetv-active-sessions.service.js', () => ({
    mergeLiveTvSessions: async (sessions: StreamSession[]) => sessions,
}));

vi.mock('../config.js', () => ({
    features: {
        sessionsPublic: true,
        sessionsDeviceInfoPublic: false,
    },
    FEATURE_PER_TASK_QUEUES: true,
}));

// Deliberately always false — an override-admin's userGroups never contains
// the configured admin group, so group-only determination must NOT be relied
// on for this test to be meaningful.
vi.mock('../auth.js', () => ({
    isUserAdmin: () => false,
}));

vi.mock('../cache/single-flight.js', () => ({
    getOrComputeSingleFlight: async (opts: { compute: () => Promise<string> }) => opts.compute(),
}));

vi.mock('./play-session-device.service.js', () => ({
    prefetchAllDeviceSessions: vi.fn().mockResolvedValue({
        byPlaySessionId: new Map(),
        byDeviceUser: new Map(),
    }),
}));

// bob has hide_streams = true. `sql` is called as a tagged template
// (`sql\`SELECT ...\``), which JS desugars to a plain function call — a bare
// async function stands in fine since this query takes no interpolations.
vi.mock('./database.service.js', () => ({
    aiDbService: {
        getSql: vi.fn().mockResolvedValue(async () => [{ username: 'bob', hide_streams: true }]),
    },
}));

const getActiveSessions = vi.fn();
vi.mock('./media-aggregation.service.js', () => ({
    MediaAggregationService: {
        getActiveSessions: (...args: unknown[]) => getActiveSessions(...args),
    },
}));

// No library-group restrictions configured — irrelevant to this test, and
// the real implementation would otherwise run a second, differently-shaped
// query against the same mocked `sql` used for privacy settings above.
vi.mock('../cache/library-group-permissions-cache.js', () => ({
    getDeniedLibraryGroups: vi.fn().mockResolvedValue(null),
}));

import { getDeniedLibraryGroups } from '../cache/library-group-permissions-cache.js';
import { getVisibleActiveSessions } from './active-sessions-view.service.js';

function makeSession(username: string, playSessionId: string): StreamSession {
    return {
        mediaItemId: `media-${username}`,
        username,
        clientname: 'TestClient',
        clientVersion: '1.0.1 (2610140823)',
        userAgent: 'TestAgent',
        browsername: 'TestBrowser',
        playSessionId,
        deviceId: `device-${username}`,
    } as unknown as StreamSession;
}

describe('getVisibleActiveSessions — admin override propagation', () => {
    beforeEach(() => {
        getActiveSessions.mockReset();
        getActiveSessions.mockResolvedValue({
            sessions: [makeSession('alice', 'play-alice'), makeSession('bob', 'play-bob')],
            cacheTimestamp: 123,
        });
    });

    it('viewer with isAdmin=true (override) sees a private session, flagged', async () => {
        const result = await getVisibleActiveSessions({
            username: 'alice',
            userGroups: [], // NOT in any admin group — status comes from the override alone.
            isAdmin: true,
            hasWatchPermission: false,
            hasLiveTvPermission: false,
        });

        expect(result.visible).toBe(true);
        const bob = result.sessions.find((s) => s.username.toLowerCase() === 'bob');
        expect(bob).toBeDefined();
        expect(bob?.isPrivate).toBe(true);
        expect(bob?.clientVersion).toBe('1.0.1 (2610140823)');
        expect(bob?.userAgent).toBe('TestAgent');
    });

    it('viewer without isAdmin (same empty groups) does NOT see the private session', async () => {
        const result = await getVisibleActiveSessions({
            username: 'alice',
            userGroups: [],
            hasWatchPermission: false,
            hasLiveTvPermission: false,
        });

        expect(result.visible).toBe(true);
        const names = result.sessions.map((s) => s.username.toLowerCase());
        expect(names).toContain('alice');
        expect(names).not.toContain('bob');
        expect(result.sessions[0]).not.toHaveProperty('clientVersion');
        expect(result.sessions[0]).not.toHaveProperty('userAgent');
    });
});

it('withholds build and raw User-Agent even from a non-admin with watch permission', async () => {
    getActiveSessions.mockResolvedValue({ sessions: [makeSession('alice', 'play-alice')] });
    const result = await getVisibleActiveSessions({
        username: 'alice',
        userGroups: [],
        isAdmin: false,
        hasWatchPermission: true,
        hasLiveTvPermission: false,
    });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].clientname).toBe('TestClient');
    expect(result.sessions[0]).not.toHaveProperty('clientVersion');
    expect(result.sessions[0]).not.toHaveProperty('userAgent');
});

it.each([false, true])(
    'requires Live TV permission even for the owner, admin=%s',
    async (isAdmin) => {
        getActiveSessions.mockResolvedValue({
            sessions: [
                { ...makeSession('alice', 'alice-live'), mediaType: 'tvchannel' },
                { ...makeSession('bob', 'bob-live'), mediaType: 'tvchannel' },
            ],
        });
        const viewer = {
            username: 'alice',
            userGroups: [],
            isAdmin,
            hasWatchPermission: true,
            hasLiveTvPermission: false,
        };
        const denied = await getVisibleActiveSessions(viewer);
        expect(denied.sessions).toEqual([]);
        const allowed = await getVisibleActiveSessions({ ...viewer, hasLiveTvPermission: true });
        // Bob is private in this fixture: privacy remains in force for non-admins.
        expect(allowed.sessions.map((s) => s.username)).toEqual(
            isAdmin ? ['alice', 'bob'] : ['alice'],
        );
    },
);

it('does not apply movie-library filters to a permitted Live TV station UUID', async () => {
    vi.mocked(getDeniedLibraryGroups).mockResolvedValueOnce(['restricted']);
    getActiveSessions.mockResolvedValue({
        sessions: [
            {
                ...makeSession('carol', 'live-carol'),
                mediaType: 'tvchannel',
                mediaItemId: '550e8400-e29b-41d4-a716-446655440000',
            },
        ],
    });
    const result = await getVisibleActiveSessions({
        username: 'alice',
        userGroups: [],
        hasWatchPermission: true,
        hasLiveTvPermission: true,
    });
    expect(result.sessions.map((s) => s.username)).toEqual(['carol']);
});
