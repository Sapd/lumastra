// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A viewer who has hidden their own streams must still see their OWN sessions.
 *
 * `hide_streams` means "don't show my streams to other people". It is not a
 * self-blind: the whole point of a caller reading their own sessions is to see
 * and stop their own stream, and Settings offers exactly that.
 *
 * The regression this pins is not in the privacy filter — that filter has always
 * exempted own rows — but in WHAT the caller hands the service. `isOwnSession`
 * short-circuits on `session.userId`:
 *
 *     if (session.userId) return viewerUserId != null && session.userId === viewerUserId;
 *
 * so a viewer object built without `userId` does NOT fall back to a username
 * compare for any row that carries one. It returns false, the own-row exemption
 * never fires, and a viewer with `hide_streams` set loses their own session. On
 * prod this made `GET /sessions?scope=mine` return `[]` for the `test` user
 * (hide_streams = true) while `scope=visible` — the one branch that did pass
 * `userId` — rendered the very same session.
 *
 * Sibling coverage: active-sessions-view.ownscope.test.ts covers the
 * `restrictToOwn` path (sessions not public), whose rows carry no `userId` and
 * therefore take the username fallback — which is why it could not see this.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StreamSession } from '../types.js';

// Sessions ARE public here, so `restrictToOwn` is false and the per-user
// privacy filter is the only thing that can drop a row. That isolates the
// exemption under test. FEATURE_PER_TASK_QUEUES is required by the import
// chain, not by this service — see ownscope.test.ts for why.
vi.mock('../config.js', () => ({
    features: {
        sessionsPublic: true,
        sessionsDeviceInfoPublic: false,
    },
    FEATURE_PER_TASK_QUEUES: true,
}));

vi.mock('../auth.js', () => ({ isUserAdmin: () => false }));

// Bypass the single-flight cache: run the compute and return its payload.
vi.mock('../cache/single-flight.js', () => ({
    getOrComputeSingleFlight: async (opts: { compute: () => Promise<string> }) => opts.compute(),
}));

vi.mock('./play-session-device.service.js', () => ({
    prefetchAllDeviceSessions: vi.fn().mockResolvedValue({
        byPlaySessionId: new Map(),
        byDeviceUser: new Map(),
    }),
}));

vi.mock('./audiobookshelf-direct-sessions.service.js', () => ({
    mergeDirectAudiobookshelfSessions: async (sessions: StreamSession[]) => sessions,
}));

// The privacy read is the ONLY query this suite needs to answer: alice has
// hidden her streams. Everything else the service might ask for is either
// gated off (denied library groups → null) or skipped (no local DB handle for
// artwork).
const sqlTag = vi.fn(async () => [{ username: 'alice', hide_streams: true }]);
vi.mock('./database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => sqlTag) },
}));

vi.mock('../cache/library-group-permissions-cache.js', () => ({
    getDeniedLibraryGroups: vi.fn().mockResolvedValue(null),
}));

vi.mock('../database/connection.js', () => ({ getDb: () => null }));

const getActiveSessions = vi.fn();
vi.mock('./media-aggregation.service.js', () => ({
    MediaAggregationService: {
        getActiveSessions: (...args: unknown[]) => getActiveSessions(...args),
    },
}));

import { getVisibleActiveSessions } from './active-sessions-view.service.js';

const ALICE_ID = '11111111-1111-1111-1111-111111111111';
const BOB_ID = '22222222-2222-2222-2222-222222222222';

/** A session row as the read model produces it — carrying `userId`. */
function makeSession(username: string, userId: string): StreamSession {
    return {
        mediaItemId: `media-${username}`,
        userId,
        username,
        clientname: 'TestClient',
        browsername: 'TestBrowser',
        playSessionId: `play-${username}`,
        deviceId: `device-${username}`,
    } as unknown as StreamSession;
}

beforeEach(() => {
    getActiveSessions.mockReset();
    getActiveSessions.mockResolvedValue({
        sessions: [makeSession('alice', ALICE_ID), makeSession('bob', BOB_ID)],
        cacheTimestamp: 123,
    });
});

describe('getVisibleActiveSessions — a viewer with hide_streams sees their own session', () => {
    it('keeps the viewer’s own hidden session when the viewer userId is supplied', async () => {
        const result = await getVisibleActiveSessions({
            userId: ALICE_ID,
            username: 'alice',
            userGroups: [],
            hasWatchPermission: false,
            hasLiveTvPermission: false,
        });

        expect(result.sessions.map((s) => s.username)).toContain('alice');
    });

    it('drops the own session when userId is omitted — the shape of the prod bug', async () => {
        // Documents the failure mode rather than blessing it: this is what
        // `scope=mine` did, and it is why omitting `userId` must be treated as
        // a bug at every call site and not as an optional convenience.
        const result = await getVisibleActiveSessions({
            username: 'alice',
            userGroups: [],
            hasWatchPermission: false,
            hasLiveTvPermission: false,
        });

        expect(result.sessions.map((s) => s.username)).not.toContain('alice');
    });

    it('still hides ANOTHER hidden user’s session from the viewer', async () => {
        // The exemption must be own-rows-only. Bob is not hidden here; make him
        // hidden and confirm alice cannot see him even though she can see
        // herself.
        sqlTag.mockResolvedValueOnce([
            { username: 'alice', hide_streams: true },
            { username: 'bob', hide_streams: true },
        ]);

        const result = await getVisibleActiveSessions({
            userId: ALICE_ID,
            username: 'alice',
            userGroups: [],
            hasWatchPermission: false,
            hasLiveTvPermission: false,
        });

        const names = result.sessions.map((s) => s.username);
        expect(names).toContain('alice');
        expect(names).not.toContain('bob');
    });
});

describe('getVisibleActiveSessions — privacy settings unreadable', () => {
    const viewer = {
        userId: ALICE_ID,
        username: 'alice',
        userGroups: [],
        hasWatchPermission: false,
        hasLiveTvPermission: false,
    };

    it('withholds other users’ sessions when the privacy query throws', async () => {
        sqlTag.mockRejectedValueOnce(new Error('pool exhausted'));
        const result = await getVisibleActiveSessions(viewer);
        expect(result.sessions.map((s) => s.username)).toEqual(['alice']);
    });

    it('withholds other users’ sessions when no DB handle is available', async () => {
        const { aiDbService } = await import('./database.service.js');
        vi.mocked(aiDbService.getSql).mockResolvedValueOnce(null as never);
        const result = await getVisibleActiveSessions(viewer);
        expect(result.sessions.map((s) => s.username)).toEqual(['alice']);
    });
});
