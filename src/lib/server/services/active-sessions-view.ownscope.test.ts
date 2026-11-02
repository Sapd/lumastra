// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression tests for the "own sessions are always visible" invariant of
 * {@link getVisibleActiveSessions}.
 *
 * When FEATURE_SESSIONS_PUBLIC is OFF and the viewer is neither admin nor
 * watch-permissioned, they must STILL see their OWN active sessions (so they can
 * stop their own stream) — but NEVER another user's session. Privileged viewers
 * (admin / watch permission / sessions public) are unchanged: own + visible others.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StreamSession } from '../types.js';

// features.sessionsPublic drives the privacy gate. Keep it OFF for the whole
// suite; the per-call hasWatchPermission flag distinguishes restricted vs
// privileged viewers.
//
// FEATURE_PER_TASK_QUEUES is not used by this service — it is read at module
// scope by tasks/registry.ts's `new TaskRegistry()` singleton, which this suite
// drags in through the import chain
// active-sessions-view.service -> database/connection -> catalog.service ->
// tasks/plugin-context -> tasks/registry. A mocked module with the key missing
// is a hard vitest error, not `undefined`, so the whole suite fails to load
// without it. Mirror config.ts's own default (true).
vi.mock('../config.js', () => ({
    features: {
        sessionsPublic: false,
        sessionsDeviceInfoPublic: false,
    },
    FEATURE_PER_TASK_QUEUES: true,
}));

// Both viewers under test are non-admin.
vi.mock('../auth.js', () => ({
    isUserAdmin: () => false,
}));

// Bypass the single-flight cache: just run the compute and return its payload.
vi.mock('../cache/single-flight.js', () => ({
    getOrComputeSingleFlight: async (opts: { compute: () => Promise<string> }) => opts.compute(),
}));

// No device-client enrichment needed for these assertions.
vi.mock('./play-session-device.service.js', () => ({
    prefetchAllDeviceSessions: vi.fn().mockResolvedValue({
        byPlaySessionId: new Map(),
        byDeviceUser: new Map(),
    }),
}));

// The privacy read answers "nobody is hidden", so bob is a non-hidden other
// user. (A null handle would now fail closed and withhold bob.)
vi.mock('./database.service.js', () => ({
    aiDbService: {
        getSql: vi.fn().mockResolvedValue(vi.fn(async () => [])),
    },
}));

const getActiveSessions = vi.fn();
vi.mock('./media-aggregation.service.js', () => ({
    MediaAggregationService: {
        getActiveSessions: (...args: unknown[]) => getActiveSessions(...args),
    },
}));

import { getVisibleActiveSessions } from './active-sessions-view.service.js';
import { unrestrictedAccess } from '../database/queries/builders/media-access-boundary.js';

function makeSession(username: string, playSessionId: string): StreamSession {
    return {
        mediaItemId: `media-${username}`,
        username,
        clientname: 'TestClient',
        browsername: 'TestBrowser',
        playSessionId,
        deviceId: `device-${username}`,
    } as unknown as StreamSession;
}

describe('getVisibleActiveSessions — own-sessions always visible', () => {
    beforeEach(() => {
        getActiveSessions.mockReset();
        getActiveSessions.mockResolvedValue({
            sessions: [makeSession('alice', 'play-alice'), makeSession('bob', 'play-bob')],
            cacheTimestamp: 123,
        });
    });

    it('restricted viewer (non-admin, no watch, sessions not public) sees ONLY their own session', async () => {
        const result = await getVisibleActiveSessions({
            username: 'alice',
            userGroups: [],
            hasWatchPermission: false,
            hasLiveTvPermission: false,
            access: unrestrictedAccess(),
        });

        expect(result.visible).toBe(true);
        const names = result.sessions.map((s) => s.username.toLowerCase());
        expect(names).toContain('alice');
        expect(names).not.toContain('bob');
    });

    it('watch-permission viewer sees own AND other non-hidden sessions', async () => {
        const result = await getVisibleActiveSessions({
            username: 'alice',
            userGroups: [],
            hasWatchPermission: true,
            hasLiveTvPermission: false,
            access: unrestrictedAccess(),
        });

        expect(result.visible).toBe(true);
        const names = result.sessions.map((s) => s.username.toLowerCase());
        expect(names).toContain('alice');
        expect(names).toContain('bob');
    });
});
