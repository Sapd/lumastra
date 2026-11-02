// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Watch Together Service
 *
 * Exercises the full watch-together service against real Valkey.
 * Requires CACHE_URL pointing to a live Valkey/Redis instance.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { resolveWatchTogetherEntryPosition } from './watch-together-entry-position.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import {
    connectValkey,
    getKeysByPattern,
    del,
    cacheGet,
    setEx,
    hGetAll,
    lRange,
    getKeyTtlSeconds,
    hSet,
    getCoordinationClient,
} from '../cache/valkey.js';
import type { WatchTogetherState } from '$lib/types/watch-together';
import type { StoredSession } from './watch-together.service';
import {
    createSession,
    getSession,
    getUserActiveSession,
    joinSession,
    isExistingParticipant,
    leaveSession,
    endSession,
    endSessionAsSystem,
    transferHost,
    disbandSession,
    setSessionVisibility,
    updatePlaybackState,
    broadcastSeek,
    broadcastNavigate,
    navigateParty,
    getAllSessions,
    initiateBufferCheck,
    signalReady,
    reportPosition,
    touchSSEConnection,
    updateSessionPosition,
    reportClientStall,
    reportClientStallReady,
    sweepAbsentHosts,
    sweepStaleGuests,
    registerSSEConnection,
} from './watch-together.service.js';

vi.mock('./watch-together-entry-position.js', () => ({
    resolveWatchTogetherEntryPosition: vi.fn(
        async (_item: string, _type: string, _file?: string, position = 0) => position,
    ),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        })),
    },
}));

/**
 * `joinSession` gates the session's item against the joiner's library groups and
 * age rating. This suite is Valkey-only — there is no database behind it — so
 * the gate is mocked and driven per-test via `mediaAccessAllowed`.
 *
 * It defaults to `true` so the pre-existing session-lifecycle tests below keep
 * asserting what they were written to assert; the tests that care about the gate
 * flip it explicitly and restore it.
 */
let mediaAccessAllowed = true;
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn(async () => mediaAccessAllowed),
}));

/**
 * A viewer with access to everything. The real shape is `UserContext`; these
 * tests only ever reach the mocked `checkMediaAccess`, so the fields it would
 * read are the only ones that need to be present.
 */
const VIEWER = {
    userId: 'test-viewer-id',
    username: 'test-viewer',
    groups: '',
    userGroups: [],
    isAdmin: false,
    maxAgeRating: null,
} as unknown as Parameters<typeof joinSession>[4];

beforeEach(() => {
    vi.mocked(resolveWatchTogetherEntryPosition)
        .mockReset()
        .mockImplementation(async (_item, _type, _file, position = 0) => position);
});

const SKIP = !process.env.CACHE_URL;

/** Poll `cond` until true or timeout — for asserting on fire-and-forget cleanup. */
async function waitFor(
    cond: () => Promise<boolean>,
    { timeoutMs = 2000, intervalMs = 25 } = {},
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await cond()) return;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error('waitFor: condition not met before timeout');
}

describe.skipIf(SKIP)('Watch Together Service — integration', () => {
    it('seeds a later combined-file episode and publishes its canonical navigation entry', async () => {
        vi.mocked(resolveWatchTogetherEntryPosition)
            .mockResolvedValueOnce(60)
            .mockResolvedValueOnce(120);
        const party = await createSession(
            'entry-host',
            'Host',
            'episode-two',
            'episode',
            'Part two',
            undefined,
            undefined,
            undefined,
            'entry-client',
        );
        expect(party?.currentTime).toBe(60);
        expect(await broadcastSeek(party!.code, 'entry-host', 0, 'entry-client', false)).toBe(true);
        expect((await getSession(party!.code))?.currentTime).toBe(0);
        expect(
            await navigateParty(party!.code, 'episode-three', 'Part three', {
                userId: 'entry-host',
                clientId: 'entry-client',
                mediaType: 'episode',
            }),
        ).toEqual({ ok: true, currentTime: 120 });
        expect((await getSession(party!.code))?.currentTime).toBe(120);
        const events = (await lRange(`watch:v2:replay:${party!.code}`, 0, -1)).map(
            (raw) => JSON.parse(raw) as { event: { type: string; currentTime?: number } },
        );
        expect(events.find((row) => row.event.type === 'navigate')?.event.currentTime).toBe(120);
    });

    it('delivers canonical sync confirmations to the sender as well as peers', async () => {
        const host = 'edbb12a5-5e59-54de-86a6-e1d678a722d4';
        const session = await createSession(
            host,
            'Host',
            'item-old',
            'movie',
            'Old',
            undefined,
            17,
            undefined,
            'host-client',
        );
        const code = session!.code;
        expect(
            await updatePlaybackState(
                code,
                host,
                { currentTime: 17, isPlaying: false, playbackRate: 1, timestamp: Date.now() },
                'host-client',
                undefined,
                undefined,
                'c4c90564-14a9-4f04-9d99-2f251ce41b4a',
            ),
        ).toBe(true);
        const frames = (await lRange(`watch:v2:replay:${code}`, 0, -1)).map(
            (raw) =>
                JSON.parse(raw) as {
                    excludeClientId?: string;
                    event: {
                        type: string;
                        clientId?: string;
                        syncId?: string;
                        state?: { isPlaying: boolean };
                    };
                },
        );
        const confirmation = frames.find((frame) => frame.event.type === 'sync');
        expect(confirmation?.event.clientId).toBe('host-client');
        expect(confirmation?.event.syncId).toBe('c4c90564-14a9-4f04-9d99-2f251ce41b4a');
        expect(confirmation?.event.state?.isPlaying).toBe(false);
        expect(confirmation).not.toHaveProperty('excludeClientId');
    });

    it.each([false, true])(
        'keeps delayed join barriers on their original timeline (rejoin=%s)',
        async (rejoin) => {
            const host = 'edbb12a5-5e59-54de-86a6-e1d678a722d4';
            const party = await createSession(
                host,
                'Host',
                'item-old',
                'movie',
                'Old',
                undefined,
                100,
                undefined,
                'host-client',
            );
            const code = party!.code;
            await updatePlaybackState(
                code,
                host,
                { currentTime: 100, isPlaying: true, playbackRate: 1, timestamp: Date.now() },
                'host-client',
            );
            await joinSession(
                code,
                rejoin ? host : '0879368a-187c-528a-9c33-c97f420fd52d',
                rejoin ? 'Host' : 'Guest',
                rejoin ? 'host-client' : 'guest-client',
                VIEWER,
            );
            const client = getCoordinationClient();
            if (!client) throw new Error('Valkey required');
            const original = client.set.bind(client);
            let intercepted = false;
            let claimed = false;
            let release!: () => void;
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            const key = `watch:v2:buffer-init-lock:${code}`;
            const spy = vi.spyOn(client, 'set').mockImplementation(async (...args) => {
                const capture = String(args[0]) === key && !intercepted;
                if (capture) {
                    intercepted = true;
                    await held;
                }
                const result = await original(...args);
                if (capture) claimed = true;
                return result;
            });
            try {
                await expect.poll(() => intercepted, { timeout: 5000 }).toBe(true);
                expect(
                    await broadcastNavigate(
                        code,
                        host,
                        'item-new',
                        'New',
                        'movie',
                        'host-client',
                        undefined,
                        'new-timeline',
                        party!.timelineId,
                    ),
                ).toBe(true);
                release();
                await expect
                    .poll(async () => claimed && (await cacheGet(key)) === null, { timeout: 5000 })
                    .toBe(true);
                expect((await getSession(code))!.timelineId).toBe('new-timeline');
                expect(
                    await cacheGet(`watch:v2:buffer:${code}`),
                    'An old join timer must not create a barrier on the new title',
                ).toBeNull();
            } finally {
                release();
                spy.mockRestore();
                await endSessionAsSystem(code);
            }
        },
    );

    beforeAll(async () => {
        await connectValkey();
    });

    beforeEach(async () => {
        const keys = await getKeysByPattern('watch:v2:*');
        if (keys.length > 0) {
            await del(keys);
        }
    });

    afterAll(async () => {
        const keys = await getKeysByPattern('watch:v2:*');
        if (keys.length > 0) {
            await del(keys);
        }
    });

    // =====================================================================
    // 1. Session create, host + multiple guests join
    // =====================================================================

    it('creates a session and lets host + multiple guests join', async () => {
        const session = await createSession(
            'e399d382-9e65-5246-8bae-a6591fd0d9f3',
            'Host',
            'item-123',
            'movie',
            'Test Movie',
        );
        expect(session).not.toBeNull();
        expect(session!.code).toHaveLength(6);
        expect(session!.hostUserId).toBe('e399d382-9e65-5246-8bae-a6591fd0d9f3');
        expect(session!.participants).toHaveLength(1);

        const fetched = await getSession(session!.code);
        expect(fetched).not.toBeNull();
        expect(fetched!.code).toBe(session!.code);

        const activeCode = await getUserActiveSession('e399d382-9e65-5246-8bae-a6591fd0d9f3');
        expect(activeCode).toBe(session!.code);

        const guest1 = await joinSession(
            session!.code,
            'a74d757c-b334-50c9-8135-9ae4d4fe50d0',
            'Guest1',
            'client-g1',
            VIEWER,
        );
        expect(guest1).not.toBeNull();
        expect(guest1!.participants).toHaveLength(2);
        expect(await getUserActiveSession('a74d757c-b334-50c9-8135-9ae4d4fe50d0')).toBe(
            session!.code,
        );

        const guest2 = await joinSession(
            session!.code,
            '6172b79f-3ef5-54a5-9624-45cda188317d',
            'Guest2',
            'client-g2',
            VIEWER,
        );
        expect(guest2).not.toBeNull();
        expect(guest2!.participants).toHaveLength(3);
        expect(await getUserActiveSession('6172b79f-3ef5-54a5-9624-45cda188317d')).toBe(
            session!.code,
        );

        // Idempotent join with same clientId
        const again = await joinSession(
            session!.code,
            'a74d757c-b334-50c9-8135-9ae4d4fe50d0',
            'Guest1',
            'client-g1',
            VIEWER,
        );
        expect(again).not.toBeNull();
        expect(again!.participants).toHaveLength(3);
    });

    // =====================================================================
    // 1b. Join is gated on media access
    //
    // A join code is the intended sharing mechanism, so holding one says
    // nothing about entitlement. Before this gate, joining disclosed itemId,
    // title, posterUrl and fileId to anyone authenticated — including accounts
    // outside the title's library group and under its age rating.
    // =====================================================================

    it('refuses a join when the viewer cannot access the session item', async () => {
        const session = await createSession(
            'e399d382-9e65-5246-8bae-a6591fd0d9f3',
            'Host',
            'item-123',
            'movie',
            'Test Movie',
        );
        expect(session).not.toBeNull();

        mediaAccessAllowed = false;
        try {
            const denied = await joinSession(
                session!.code,
                '11111111-1111-4111-8111-111111111119',
                'Nope',
                'client-nope',
                VIEWER,
            );
            // null, not a partial session — the caller maps this to 404 so a
            // denial is indistinguishable from "no such party".
            expect(denied).toBeNull();
        } finally {
            mediaAccessAllowed = true;
        }

        // The refused joiner must not have been recorded as a participant, and
        // must not have had an active-session pointer minted for them.
        const after = await getSession(session!.code);
        expect(after!.participants).toHaveLength(1);
        expect(await getUserActiveSession('11111111-1111-4111-8111-111111111119')).toBeNull();
    });

    it('refuses a join when no viewer context is supplied', async () => {
        // checkMediaAccess returns TRUE for an undefined user (it defers to auth
        // middleware), so passing one through would silently disable the gate.
        // joinSession has to reject it before that point.
        const session = await createSession(
            'e399d382-9e65-5246-8bae-a6591fd0d9f3',
            'Host',
            'item-123',
            'movie',
            'Test Movie',
        );
        expect(session).not.toBeNull();

        const denied = await joinSession(
            session!.code,
            'e280efdd-d3ab-5102-b2de-25c1d6a7fedd',
            'X',
            'client-x',
            undefined,
        );
        expect(denied).toBeNull();

        const after = await getSession(session!.code);
        expect(after!.participants).toHaveLength(1);
    });

    // =====================================================================
    // 1c. isExistingParticipant — the join rate limit's rejoin exemption
    //
    // A flaky client re-POSTs join on every SSE reconnect. Those are no-ops
    // inside joinSession, but they were still charged against the 20/60s
    // budget, so ~20 reconnects in a minute locked a user out of rejoining
    // their own party. The exemption must be exact: same client AND same user.
    // =====================================================================

    it('recognises an exact rejoin, and nothing looser', async () => {
        const session = await createSession(
            'e399d382-9e65-5246-8bae-a6591fd0d9f3',
            'Host',
            'item-123',
            'movie',
            'Test Movie',
        );
        await joinSession(
            session!.code,
            'a74d757c-b334-50c9-8135-9ae4d4fe50d0',
            'Guest1',
            'client-g1',
            VIEWER,
        );

        expect(
            await isExistingParticipant(
                session!.code,
                'a74d757c-b334-50c9-8135-9ae4d4fe50d0',
                'client-g1',
            ),
        ).toBe(true);

        // Same user, different device — a genuine new join, must still be charged.
        expect(
            await isExistingParticipant(
                session!.code,
                'a74d757c-b334-50c9-8135-9ae4d4fe50d0',
                'client-other',
            ),
        ).toBe(false);
        // Someone else reusing a known clientId must not inherit the exemption.
        expect(
            await isExistingParticipant(
                session!.code,
                '6172b79f-3ef5-54a5-9624-45cda188317d',
                'client-g1',
            ),
        ).toBe(false);
        // No clientId, unknown session — both fall through to the limit.
        expect(
            await isExistingParticipant(
                session!.code,
                'a74d757c-b334-50c9-8135-9ae4d4fe50d0',
                undefined,
            ),
        ).toBe(false);
        expect(
            await isExistingParticipant(
                'ZZZZZZ',
                'a74d757c-b334-50c9-8135-9ae4d4fe50d0',
                'client-g1',
            ),
        ).toBe(false);
    });

    // =====================================================================
    // 2. Host play / pause / seek — state version bumps + propagation
    // =====================================================================

    it('host play/pause/seek updates state and ignores guest position', async () => {
        const session = await createSession(
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'Host',
            'item-123',
            'movie',
            'Test Movie',
            undefined,
            0,
            undefined,
            'host-client',
        );
        expect(session).not.toBeNull();

        const code = session!.code;

        await joinSession(
            code,
            '0879368a-187c-528a-9c33-c97f420fd52d',
            'Guest',
            'guest-client',
            VIEWER,
        );

        // Host plays at position 60
        const hostState: WatchTogetherState = {
            currentTime: 60,
            isPlaying: true,
            playbackRate: 1,
            timestamp: Date.now(),
        };
        const hostUpdate = await updatePlaybackState(
            code,
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            hostState,
            'host-client',
        );
        expect(hostUpdate).toBe(true);

        const afterHost = await getSession(code);
        expect(afterHost).not.toBeNull();
        expect(afterHost!.isPlaying).toBe(true);
        expect(afterHost!.currentTime).toBe(60);
        expect(afterHost!.lastSync).toBeGreaterThanOrEqual(session!.lastSync);

        const lastSyncAfterHost = afterHost!.lastSync;

        // Guest pauses — guest currentTime should be ignored
        const guestState: WatchTogetherState = {
            currentTime: 999,
            isPlaying: false,
            playbackRate: 1,
            timestamp: Date.now(),
        };
        const guestUpdate = await updatePlaybackState(
            code,
            '0879368a-187c-528a-9c33-c97f420fd52d',
            guestState,
            'guest-client',
        );
        expect(guestUpdate).toBe(true);

        const afterGuest = await getSession(code);
        expect(afterGuest).not.toBeNull();
        expect(afterGuest!.isPlaying).toBe(false);
        expect(afterGuest!.currentTime).toBe(60); // host value preserved
        expect(afterGuest!.lastSync).toBeGreaterThanOrEqual(lastSyncAfterHost);

        // Host seeks to 120
        const seekResult = await broadcastSeek(
            code,
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            120,
            'host-client',
            true,
        );
        expect(seekResult).toBe(true);

        const afterSeek = await getSession(code);
        expect(afterSeek).not.toBeNull();
        expect(afterSeek!.currentTime).toBe(120);

        // Buffer check should have been triggered
        const bufferKeys = await getKeysByPattern(`watch:v2:buffer:${code}`);
        expect(bufferKeys.length).toBeGreaterThan(0);
    });

    // =====================================================================
    // 2b. session.isPlaying self-heals to the host's true state
    // Regression guard: a stale-true isPlaying made the join/resume path tell a
    // guest to resume while the host was actually paused (tvOS "plays while host
    // paused"). The host's 5s heartbeat now carries + persists its real state.
    // =====================================================================

    it('host heartbeat persists isPlaying — self-heals a stale flag', async () => {
        const session = await createSession(
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'Host',
            'item-1',
            'movie',
            'Movie',
            undefined,
            0,
            undefined,
            'host-client',
        );
        expect(session).not.toBeNull();
        const code = session!.code;

        // Party is "playing" (stale flag we want to correct).
        await updatePlaybackState(
            code,
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            { currentTime: 5, isPlaying: true, playbackRate: 1, timestamp: Date.now() },
            'host-client',
        );
        expect((await getSession(code))!.isPlaying).toBe(true);

        // Host pauses, communicated via the heartbeat (not an explicit sync) — later
        // than the explicit play's grace window, which expires on its own.
        await del(`watch:v2:play-state:${code}`);
        const ok = await updateSessionPosition(
            code,
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            5,
            'host-client',
            false,
        );
        expect(ok).toBe(true);
        expect((await getSession(code))!.isPlaying).toBe(false);
    });

    it('a heartbeat sampled before an explicit Play does not undo it', async () => {
        // Browser <-> Apple TV e2e: the web host's heartbeat (sampled while still
        // paused) landed just after its own Play sync, flipped the session back to
        // paused and broadcast that as host_position — the TV guest paused itself.
        const session = await createSession(
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'Host',
            'item-1',
            'movie',
            'Movie',
            undefined,
            0,
            undefined,
            'host-client',
        );
        const code = session!.code;
        await updatePlaybackState(
            code,
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            { currentTime: 5, isPlaying: true, playbackRate: 1, timestamp: Date.now() },
            'host-client',
        );

        await updateSessionPosition(
            code,
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            5,
            'host-client',
            false,
        );
        expect((await getSession(code))!.isPlaying).toBe(true);

        // Once the grace window is over, the heartbeat is authoritative again.
        await del(`watch:v2:play-state:${code}`);
        await updateSessionPosition(
            code,
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            6,
            'host-client',
            false,
        );
        expect((await getSession(code))!.isPlaying).toBe(false);
    });

    it('a guest pausing a playing party pauses it where the guest is', async () => {
        // The stored host position is up to a heartbeat old; broadcasting the pause
        // with it seeked every player back (e2e: TV 4.9 s -> 1.5 s).
        const session = await createSession(
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'Host',
            'item-1',
            'movie',
            'Movie',
            undefined,
            0,
            undefined,
            'host-client',
        );
        const code = session!.code;
        await joinSession(
            code,
            '0879368a-187c-528a-9c33-c97f420fd52d',
            'Guest',
            'guest-client',
            VIEWER,
        );
        await updatePlaybackState(
            code,
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            { currentTime: 1.5, isPlaying: true, playbackRate: 1, timestamp: Date.now() },
            'host-client',
        );

        await updatePlaybackState(
            code,
            '0879368a-187c-528a-9c33-c97f420fd52d',
            { currentTime: 4.9, isPlaying: false, playbackRate: 1, timestamp: Date.now() },
            'guest-client',
        );
        const paused = (await getSession(code))!;
        expect(paused.isPlaying).toBe(false);
        expect(paused.currentTime).toBe(4.9);
    });

    it('a guest whose player sits at 0 still cannot rewind the party', async () => {
        const session = await createSession(
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'Host',
            'item-1',
            'movie',
            'Movie',
            undefined,
            0,
            undefined,
            'host-client',
        );
        const code = session!.code;
        await joinSession(
            code,
            '0879368a-187c-528a-9c33-c97f420fd52d',
            'Guest',
            'guest-client',
            VIEWER,
        );
        await updatePlaybackState(
            code,
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            { currentTime: 600, isPlaying: true, playbackRate: 1, timestamp: Date.now() },
            'host-client',
        );
        await updatePlaybackState(
            code,
            '0879368a-187c-528a-9c33-c97f420fd52d',
            { currentTime: 0, isPlaying: false, playbackRate: 1, timestamp: Date.now() },
            'guest-client',
        );
        expect((await getSession(code))!.currentTime).toBe(600);

        // Far ahead of the host is not believed either.
        await updatePlaybackState(
            code,
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            { currentTime: 600, isPlaying: true, playbackRate: 1, timestamp: Date.now() },
            'host-client',
        );
        await updatePlaybackState(
            code,
            '0879368a-187c-528a-9c33-c97f420fd52d',
            { currentTime: 900, isPlaying: false, playbackRate: 1, timestamp: Date.now() },
            'guest-client',
        );
        expect((await getSession(code))!.currentTime).toBe(600);
    });

    it('the pin also holds when the heartbeat read the session before the sync wrote it', async () => {
        // Concurrent heartbeat + Play: the heartbeat's copy of the session still says
        // paused, so it sees no contradiction — the pin must still win.
        const session = await createSession(
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'Host',
            'item-1',
            'movie',
            'Movie',
            undefined,
            0,
            undefined,
            'host-client',
        );
        const code = session!.code;
        // Stored session paused (as the racing heartbeat read it) while a Play pin exists.
        await setEx(`watch:v2:play-state:${code}`, 3, '1');
        await updateSessionPosition(
            code,
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            5,
            'host-client',
            false,
        );
        expect((await getSession(code))!.isPlaying).toBe(true);
    });

    it('guest heartbeat does NOT change session.isPlaying (host-only)', async () => {
        const session = await createSession(
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'Host',
            'item-1',
            'movie',
            'Movie',
            undefined,
            0,
            undefined,
            'host-client',
        );
        const code = session!.code;
        await joinSession(
            code,
            '0879368a-187c-528a-9c33-c97f420fd52d',
            'Guest',
            'guest-client',
            VIEWER,
        );
        await updatePlaybackState(
            code,
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            { currentTime: 5, isPlaying: true, playbackRate: 1, timestamp: Date.now() },
            'host-client',
        );

        // A guest heartbeat claiming paused must not flip the party's play state.
        await updateSessionPosition(
            code,
            '0879368a-187c-528a-9c33-c97f420fd52d',
            5,
            'guest-client',
            false,
        );
        expect((await getSession(code))!.isPlaying).toBe(true);
    });

    it('synchronized resume persists session.isPlaying', async () => {
        const session = await createSession(
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'Host',
            'item-1',
            'movie',
            'Movie',
            undefined,
            0,
            undefined,
            'host-client',
        );
        const code = session!.code;
        // Two participants; joinSession sets session.isPlaying = false.
        await joinSession(
            code,
            '0879368a-187c-528a-9c33-c97f420fd52d',
            'Guest',
            'guest-client',
            VIEWER,
        );
        expect((await getSession(code))!.isPlaying).toBe(false);

        // Buffer check intending to resume playback, then both clients signal ready.
        await initiateBufferCheck(code, 10, 'system', false, true);
        const checkId = JSON.parse((await cacheGet(`watch:v2:buffer:${code}`))!).checkId as string;
        await signalReady(code, 'host-client', checkId, 10);
        await signalReady(code, 'guest-client', checkId);

        // The resume broadcast must also persist the flag so late joiners /
        // reconnect snapshots see the party as playing.
        expect((await getSession(code))!.isPlaying).toBe(true);
    });

    it('a Play between two quick joins is not undone by the second join barrier', async () => {
        // Web e2e 2026-10-01: a guest reopened the party in a new tab (two joins ~1 s
        // apart) and the host pressed Play in between. Both joins share one join-resume
        // intent key; the first join's barrier consumed it, the Play found nothing
        // pending to update, and the second join's barrier fell back to its own
        // "paused" snapshot — the whole party went back to paused.
        const session = await createSession(
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'Host',
            'item-1',
            'movie',
            'Movie',
            undefined,
            0,
            undefined,
            'host-client',
        );
        const code = session!.code;
        await joinSession(code, '0879368a-187c-528a-9c33-c97f420fd52d', 'Guest', 'guest-a', VIEWER);
        await new Promise((r) => setTimeout(r, 500));
        await joinSession(code, '0879368a-187c-528a-9c33-c97f420fd52d', 'Guest', 'guest-b', VIEWER);
        // First join's barrier fires at ~1.0 s and consumes the shared intent. Wait for
        // that rather than for a fixed time: under load the timer fires late, and a
        // Play landing while the intent is still pending would pass without the fix.
        await expect
            .poll(() => cacheGet(`watch:v2:join-resume:${code}`), { timeout: 5_000, interval: 50 })
            .toBeNull();
        await del(`watch:v2:buffer:${code}`);
        await updatePlaybackState(
            code,
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            { currentTime: 0.3, isPlaying: true, playbackRate: 1, timestamp: Date.now() },
            'host-client',
        );
        // Second join's barrier fires ~1 s after the second join.
        await expect
            .poll(() => cacheGet(`watch:v2:buffer:${code}`), { timeout: 5_000, interval: 50 })
            .not.toBeNull();
        const barrier = await cacheGet(`watch:v2:buffer:${code}`);
        expect(JSON.parse(barrier!).isPlaying, 'second join barrier dropped the Play').toBe(true);
    });

    it('a guest who starts their own party leaves the old one, and the old one ending keeps the new pointer', async () => {
        // Web e2e 2026-10-01: uitest was a GUEST in party A and created party B.
        // createSession tried endSession(A) as uitest — refused, not the host — so
        // uitest stayed a participant of A. When A ended later, performEndSession
        // deleted every participant's active-session pointer unconditionally,
        // wiping uitest's pointer to B: GET /api/watch-together said "no party" for
        // the party uitest was hosting (and broke its catch-up and rejoin).
        const a = await createSession(
            'host-a',
            'Host A',
            'item-1',
            'movie',
            'Movie',
            undefined,
            0,
            undefined,
            'client-host-a',
        );
        await joinSession(
            a!.code,
            'e280efdd-d3ab-5102-b2de-25c1d6a7fedd',
            'X',
            'client-x-1',
            VIEWER,
        );
        const b = await createSession(
            'e280efdd-d3ab-5102-b2de-25c1d6a7fedd',
            'X',
            'item-2',
            'movie',
            'Movie',
            undefined,
            0,
            undefined,
            'client-x-2',
        );
        expect(await getUserActiveSession('e280efdd-d3ab-5102-b2de-25c1d6a7fedd')).toBe(b!.code);
        const stillInA = (await getSession(a!.code))!.participants.some(
            (p) => p.userId === 'e280efdd-d3ab-5102-b2de-25c1d6a7fedd',
        );
        expect(stillInA, 'X is still a participant of the party it left by starting another').toBe(
            false,
        );

        await endSession(a!.code, 'host-a');
        expect(await getUserActiveSession('e280efdd-d3ab-5102-b2de-25c1d6a7fedd')).toBe(b!.code);
    });

    it("ending or leaving an old party never clears a user's pointer to a newer one", async () => {
        const a = await createSession(
            'host-a',
            'Host A',
            'item-1',
            'movie',
            'Movie',
            undefined,
            0,
            undefined,
            'client-host-a',
        );
        await joinSession(
            a!.code,
            '10096d26-a502-5cf6-8270-803cfca43b33',
            'Y',
            'client-y-1',
            VIEWER,
        );
        // Simulate the pointer having moved on (another device created a party).
        await setEx(`watch:v2:user:10096d26-a502-5cf6-8270-803cfca43b33`, 3600, 'NEWER1');
        await leaveSession(a!.code, '10096d26-a502-5cf6-8270-803cfca43b33', 'client-y-1');
        expect(await getUserActiveSession('10096d26-a502-5cf6-8270-803cfca43b33')).toBe('NEWER1');
        await joinSession(
            a!.code,
            '10096d26-a502-5cf6-8270-803cfca43b33',
            'Y',
            'client-y-1',
            VIEWER,
        );
        await setEx(`watch:v2:user:10096d26-a502-5cf6-8270-803cfca43b33`, 3600, 'NEWER2');
        await endSession(a!.code, 'host-a');
        expect(await getUserActiveSession('10096d26-a502-5cf6-8270-803cfca43b33')).toBe('NEWER2');
    });

    it('resumes at the host-reported position even when a guest ready races it', async () => {
        // Web e2e 2026-10-01 (rejoin barrier): the guest's signalReady read the
        // barrier state BEFORE the host's call replaced its stale heartbeat position
        // (9.45 s) with the host's real one (10.55 s); both calls then counted 2/2 and
        // the guest's won the resume claim with its stale snapshot. Everyone resumed
        // 1.1 s behind the host, inside the drift compensator's tolerance, so the
        // guest never caught up. Raced here over many barriers.
        const session = await createSession(
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'Host',
            'item-1',
            'movie',
            'Movie',
            undefined,
            0,
            undefined,
            'host-client',
        );
        const code = session!.code;
        await joinSession(
            code,
            '0879368a-187c-528a-9c33-c97f420fd52d',
            'Guest',
            'guest-client',
            VIEWER,
        );
        // Let the join's own scheduled barrier fire and resolve first.
        await new Promise((r) => setTimeout(r, 1200));
        for (const key of await getKeysByPattern(`watch:v2:buffer:${code}`)) await del([key]);

        for (let i = 0; i < 15; i++) {
            const stale = 100 + i * 10;
            const real = stale + 1.1;
            expect(await initiateBufferCheck(code, stale, 'system', false, true)).toBe(true);
            const checkId = JSON.parse((await cacheGet(`watch:v2:buffer:${code}`))!)
                .checkId as string;
            await Promise.all([
                signalReady(code, 'guest-client', checkId),
                signalReady(code, 'host-client', checkId, real),
            ]);
            expect((await getSession(code))!.currentTime, `barrier ${i}`).toBeCloseTo(real, 5);
        }
    });

    // =====================================================================
    // 3. Version-conflict / out-of-order events — reconciliation
    // =====================================================================

    it('rejects playback updates from non-participants and returns latest state', async () => {
        const session = await createSession(
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'Host',
            'item-123',
            'movie',
            'Test Movie',
        );
        expect(session).not.toBeNull();

        const code = session!.code;

        const state: WatchTogetherState = {
            currentTime: 30,
            isPlaying: true,
            playbackRate: 1,
            timestamp: Date.now(),
        };

        const result = await updatePlaybackState(code, 'stranger-id', state);
        expect(result).toBe(false);

        const latest = await getSession(code);
        expect(latest).not.toBeNull();
        expect(latest!.isPlaying).toBe(false);
        expect(latest!.currentTime).toBe(0);
    });

    // =====================================================================
    // 4. Stall: buffer check convergence
    // =====================================================================

    it('buffer check resolves when all participants signal ready', async () => {
        const session = await createSession(
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'Host',
            'item-123',
            'movie',
            'Test Movie',
            undefined,
            0,
            undefined,
            'host-client',
        );
        expect(session).not.toBeNull();

        const code = session!.code;

        await joinSession(
            code,
            '0879368a-187c-528a-9c33-c97f420fd52d',
            'Guest',
            'guest-client',
            VIEWER,
        );

        // joinSession schedules its own buffer check ~1s after the join. On a
        // slow Valkey link (SSH tunnel) that timer fires mid-test and recreates
        // the buffer key AFTER the manual check below resolved — a flake, not a
        // regression. Let it fire, then clear its state before the manual check.
        await new Promise((r) => setTimeout(r, 1200));
        const joinCheckKeys = await getKeysByPattern(`watch:v2:buffer:${code}`);
        if (joinCheckKeys.length > 0) {
            await del(joinCheckKeys);
        }

        // Initiate buffer check manually
        const initiated = await initiateBufferCheck(
            code,
            45,
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            false,
            true,
        );
        expect(initiated).toBe(true);

        const beforeKeys = await getKeysByPattern(`watch:v2:buffer:${code}`);
        expect(beforeKeys.length).toBeGreaterThan(0);
        const checkId = JSON.parse((await cacheGet(`watch:v2:buffer:${code}`))!).checkId as string;

        // Guest signals ready first — only 1 of 2 ready
        await signalReady(code, 'guest-client', checkId);
        await new Promise((r) => setTimeout(r, 50));

        const midKeys = await getKeysByPattern(`watch:v2:buffer:${code}`);
        expect(midKeys.length).toBeGreaterThan(0);

        // Host signals ready — all ready now
        await signalReady(code, 'host-client', checkId);
        await new Promise((r) => setTimeout(r, 50));

        const afterKeys = await getKeysByPattern(`watch:v2:buffer:${code}`);
        expect(afterKeys.length).toBe(0);
    });

    it('clears old-title stalls and never resumes the new title for an old ready', async () => {
        const host = 'edbb12a5-5e59-54de-86a6-e1d678a722d4';
        const party = await createSession(
            host,
            'Host',
            'item-old',
            'movie',
            'Old',
            undefined,
            100,
            undefined,
            'host-client',
        );
        const code = party!.code;
        expect(await reportClientStall(code, host, 'host-client', 'old-stall')).toBe(true);
        expect(
            await broadcastNavigate(
                code,
                host,
                'item-new',
                'New',
                'movie',
                'host-client',
                undefined,
                'new-timeline',
                party!.timelineId,
            ),
        ).toBe(true);
        expect(await hGetAll(`watch:v2:stalled:${code}`)).toEqual({});
        expect(await reportClientStallReady(code, host, 'host-client', 'old-stall')).toBe(true);
        expect(
            await reportClientStall(
                code,
                host,
                'host-client',
                'delayed-old-stall',
                party!.timelineId,
            ),
        ).toBe(true);
        expect(await hGetAll(`watch:v2:stalled:${code}`)).toEqual({});
        const frames = (await lRange(`watch:v2:replay:${code}`, 0, -1)).map(
            (raw) => JSON.parse(raw).event,
        );
        expect(frames.find((frame) => frame.type === 'stall')).toMatchObject({
            timelineId: party!.timelineId,
        });
        expect(frames.filter((frame) => frame.type === 'resume')).toEqual([]);
        expect((await getSession(code))!).toMatchObject({
            itemId: 'item-new',
            timelineId: 'new-timeline',
            currentTime: 0,
            isPlaying: false,
        });
    });

    it('does not let an older recovery clear a newer stall generation', async () => {
        const session = await createSession(
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'Host',
            'item-123',
            'movie',
            'Test Movie',
            undefined,
            0,
            undefined,
            'host-client',
        );
        const code = session!.code;
        expect(
            await reportClientStall(
                code,
                'edbb12a5-5e59-54de-86a6-e1d678a722d4',
                'host-client',
                'stall-a',
            ),
        ).toBe(true);
        expect(
            await reportClientStall(
                code,
                'edbb12a5-5e59-54de-86a6-e1d678a722d4',
                'host-client',
                'stall-b',
            ),
        ).toBe(true);

        expect(
            await reportClientStallReady(
                code,
                'edbb12a5-5e59-54de-86a6-e1d678a722d4',
                'host-client',
                'stall-a',
            ),
        ).toBe(true);
        const stillStalled = await hGetAll(`watch:v2:stalled:${code}`);
        expect(JSON.parse(stillStalled['host-client']!)).toMatchObject({ stallId: 'stall-b' });

        expect(
            await reportClientStallReady(
                code,
                'edbb12a5-5e59-54de-86a6-e1d678a722d4',
                'host-client',
                'stall-b',
            ),
        ).toBe(true);
        expect(await hGetAll(`watch:v2:stalled:${code}`)).toEqual({});
    });

    it('ignores a stall generation whose recovery arrived first', async () => {
        const session = await createSession(
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'Host',
            'item-123',
            'movie',
            'Test Movie',
            undefined,
            0,
            undefined,
            'host-client',
        );
        const code = session!.code;

        expect(
            await reportClientStallReady(
                code,
                'edbb12a5-5e59-54de-86a6-e1d678a722d4',
                'host-client',
                'stall-late',
            ),
        ).toBe(true);
        expect(
            await reportClientStall(
                code,
                'edbb12a5-5e59-54de-86a6-e1d678a722d4',
                'host-client',
                'stall-late',
            ),
        ).toBe(true);
        expect(await hGetAll(`watch:v2:stalled:${code}`)).toEqual({});
    });

    // =====================================================================
    // 5. Transfer-host
    // =====================================================================

    it('transfers host authority correctly', async () => {
        const session = await createSession(
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'Host',
            'item-123',
            'movie',
            'Test Movie',
            undefined,
            0,
            undefined,
            'host-client',
        );
        expect(session).not.toBeNull();

        const code = session!.code;

        await joinSession(
            code,
            '0879368a-187c-528a-9c33-c97f420fd52d',
            'Guest',
            'guest-client',
            VIEWER,
        );

        // Transfer to guest
        const transferResult = await transferHost(
            code,
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            '0879368a-187c-528a-9c33-c97f420fd52d',
        );
        expect(transferResult).toBe(true);

        const after = await getSession(code);
        expect(after).not.toBeNull();
        expect(after!.hostUserId).toBe('0879368a-187c-528a-9c33-c97f420fd52d');
        expect(after!.hostDisplayName).toBe('Guest');
        expect(after!.hostClientId).toBe('guest-client');

        // Old host can no longer transfer
        const oldHostTransfer = await transferHost(
            code,
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
        );
        expect(oldHostTransfer).toBe(false);

        // New host can transfer back
        const transferBack = await transferHost(
            code,
            '0879368a-187c-528a-9c33-c97f420fd52d',
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
        );
        expect(transferBack).toBe(true);

        const backToHost = await getSession(code);
        expect(backToHost).not.toBeNull();
        expect(backToHost!.hostUserId).toBe('edbb12a5-5e59-54de-86a6-e1d678a722d4');

        // Self-transfer fails
        const selfTransfer = await transferHost(
            code,
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
        );
        expect(selfTransfer).toBe(false);

        // Transfer to non-participant fails
        const strangerTransfer = await transferHost(
            code,
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'stranger-id',
        );
        expect(strangerTransfer).toBe(false);
    });

    // =====================================================================
    // 6. Leave / disconnect → membership cleanup, host reassignment
    // =====================================================================

    it('handles leave, host reassignment, and session end', async () => {
        const session = await createSession(
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'Host',
            'item-123',
            'movie',
            'Test Movie',
            undefined,
            0,
            undefined,
            'host-client',
        );
        expect(session).not.toBeNull();

        const code = session!.code;

        await joinSession(
            code,
            'd8be6772-c11a-5af6-b9fe-23ff545b47e9',
            'Guest1',
            'guest1-client',
            VIEWER,
        );
        await joinSession(
            code,
            'da6c49fd-e926-5ef8-8155-2a47c5033278',
            'Guest2',
            'guest2-client',
            VIEWER,
        );

        // Host leaves — oldest remaining (Guest1) becomes host
        const hostLeft = await leaveSession(code, 'edbb12a5-5e59-54de-86a6-e1d678a722d4');
        expect(hostLeft).toBe(true);

        const afterHostLeave = await getSession(code);
        expect(afterHostLeave).not.toBeNull();
        expect(afterHostLeave!.participants).toHaveLength(2);
        expect(afterHostLeave!.hostUserId).toBe('d8be6772-c11a-5af6-b9fe-23ff545b47e9');
        expect(await getUserActiveSession('edbb12a5-5e59-54de-86a6-e1d678a722d4')).toBeNull();

        // Guest1 leaves with specific clientId
        const g1Left = await leaveSession(
            code,
            'd8be6772-c11a-5af6-b9fe-23ff545b47e9',
            'guest1-client',
        );
        expect(g1Left).toBe(true);

        const afterG1Leave = await getSession(code);
        expect(afterG1Leave).not.toBeNull();
        expect(afterG1Leave!.participants).toHaveLength(1);
        expect(afterG1Leave!.hostUserId).toBe('da6c49fd-e926-5ef8-8155-2a47c5033278');
        expect(await getUserActiveSession('d8be6772-c11a-5af6-b9fe-23ff545b47e9')).toBeNull();

        // Guest2 leaves — session ends
        const g2Left = await leaveSession(code, 'da6c49fd-e926-5ef8-8155-2a47c5033278');
        expect(g2Left).toBe(true);

        expect(await getSession(code)).toBeNull();
        expect(await getUserActiveSession('da6c49fd-e926-5ef8-8155-2a47c5033278')).toBeNull();
    });

    // =====================================================================
    // 7. Navigate (change media) propagation
    // =====================================================================

    it('navigation cancels the previous item barrier before late readiness', async () => {
        const host = 'edbb12a5-5e59-54de-86a6-e1d678a722d4';
        const session = await createSession(
            host,
            'Host',
            'item-old',
            'movie',
            'Old',
            undefined,
            120,
            undefined,
            'host-client',
        );
        const code = session!.code;
        await initiateBufferCheck(code, 120, host, true, true);
        const pending = JSON.parse((await cacheGet(`watch:v2:buffer:${code}`)) ?? 'null') as {
            checkId: string;
        } | null;
        expect(pending).not.toBeNull();
        expect(await broadcastNavigate(code, host, 'item-new', 'New', 'movie', 'host-client')).toBe(
            true,
        );
        await signalReady(code, 'host-client', pending!.checkId);
        const after = await getSession(code);
        expect(after?.itemId).toBe('item-new');
        expect(after?.currentTime).toBe(0);
        expect(after?.isPlaying).toBe(false);
        expect(await cacheGet(`watch:v2:buffer:${code}`)).toBeNull();
    });

    it.each(['navigate', 'pause', 'seek'] as const)(
        'orders %s after a resume already claimed on another request',
        async (operation) => {
            const host = 'edbb12a5-5e59-54de-86a6-e1d678a722d4';
            const session = await createSession(
                host,
                'Host',
                'item-old',
                'movie',
                'Old',
                undefined,
                120,
                undefined,
                'host-client',
            );
            const code = session!.code;
            await initiateBufferCheck(code, 120, host, true, true);
            const pending = JSON.parse((await cacheGet(`watch:v2:buffer:${code}`)) ?? 'null') as {
                checkId: string;
            };
            const client = getCoordinationClient();
            if (!client) throw new Error('Valkey required');
            const original = client.customCommand.bind(client);
            let release!: () => void;
            let claimed!: () => void;
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            const entered = new Promise<void>((resolve) => {
                claimed = resolve;
            });
            const spy = vi.spyOn(client, 'customCommand').mockImplementation(async (...args) => {
                if (
                    String(args[0][1]).includes('-- watch-together atomic timeline publication') &&
                    String(args[0].at(-4)) !== ''
                ) {
                    claimed();
                    await held;
                }
                return original(...args);
            });
            const resume = signalReady(code, 'host-client', pending.checkId);
            let change: Promise<boolean> | undefined;
            try {
                await entered;
                change =
                    operation === 'navigate'
                        ? broadcastNavigate(code, host, 'item-new', 'New', 'movie', 'host-client')
                        : operation === 'pause'
                          ? updatePlaybackState(
                                code,
                                host,
                                {
                                    currentTime: 120,
                                    isPlaying: false,
                                    playbackRate: 1,
                                    timestamp: Date.now(),
                                },
                                'host-client',
                            )
                          : broadcastSeek(code, host, 300, 'host-client', true);
                await new Promise((resolve) =>
                    setTimeout(resolve, operation === 'pause' ? 1200 : 40),
                );
                // The mutation must wait for the claimed resume's state AND event.
                expect((await getSession(code))?.currentTime).toBe(120);
                if (operation === 'navigate')
                    expect((await getSession(code))?.itemId).toBe('item-old');
            } finally {
                release();
                await resume;
                if (change) await change;
                spy.mockRestore();
            }
            const events = (await lRange(`watch:v2:replay:${code}`, 0, -1))
                .map((raw) => (JSON.parse(raw) as { event: { type: string } }).event.type)
                .reverse();
            const latest =
                operation === 'pause' ? 'sync' : operation === 'seek' ? 'buffer_check' : 'navigate';
            expect(events.indexOf('all_ready')).toBeGreaterThanOrEqual(0);
            expect(events.lastIndexOf(latest)).toBeGreaterThan(events.indexOf('all_ready'));
            const after = await getSession(code);
            if (operation === 'navigate') {
                expect(after?.itemId).toBe('item-new');
                expect(after?.currentTime).toBe(0);
                expect(after?.isPlaying).toBe(false);
            } else if (operation === 'pause') {
                expect(after?.isPlaying).toBe(false);
            } else {
                expect(after?.currentTime).toBe(300);
            }
        },
    );

    it('an expired owner cannot commit or publish over a newer navigation', async () => {
        const host = 'edbb12a5-5e59-54de-86a6-e1d678a722d4';
        const session = await createSession(
            host,
            'Host',
            'item-old',
            'movie',
            'Old',
            undefined,
            120,
            undefined,
            'host-client',
        );
        const code = session!.code;
        await initiateBufferCheck(code, 120, host, true, true);
        const pending = JSON.parse((await cacheGet(`watch:v2:buffer:${code}`))!) as {
            checkId: string;
        };
        const client = getCoordinationClient();
        if (!client) throw new Error('Valkey required');
        const original = client.customCommand.bind(client);
        let release!: () => void;
        let entered!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const spy = vi.spyOn(client, 'customCommand').mockImplementation(async (...args) => {
            if (
                String(args[0][1]).includes('-- watch-together atomic timeline publication') &&
                String(args[0].at(-4)) !== ''
            ) {
                entered();
                await held;
            }
            return original(...args);
        });
        const old = signalReady(code, 'host-client', pending.checkId);
        try {
            await blocked;
            await del(`watch:v2:buffer-init-lock:${code}`); // Same ownership loss as lease expiry.
            expect(
                await broadcastNavigate(code, host, 'item-new', 'New', 'movie', 'host-client'),
            ).toBe(true);
        } finally {
            release();
            await old;
            spy.mockRestore();
        }
        const after = await getSession(code);
        expect(after?.itemId).toBe('item-new');
        expect(after?.currentTime).toBe(0);
        expect(after?.isPlaying).toBe(false);
        const events = (await lRange(`watch:v2:replay:${code}`, 0, -1)).map(
            (raw) => (JSON.parse(raw) as { event: { type: string } }).event.type,
        );
        expect(events).not.toContain('all_ready');
        expect(events).toContain('navigate');
    });

    it('renews ownership and timestamps resume at publication after a slow transition', async () => {
        const host = 'edbb12a5-5e59-54de-86a6-e1d678a722d4';
        const session = await createSession(
            host,
            'Host',
            'item-old',
            'movie',
            'Old',
            undefined,
            120,
            undefined,
            'host-client',
        );
        const code = session!.code;
        await initiateBufferCheck(code, 120, host, true, true);
        const pending = JSON.parse((await cacheGet(`watch:v2:buffer:${code}`))!) as {
            checkId: string;
        };
        const client = getCoordinationClient();
        if (!client) throw new Error('Valkey required');
        const original = client.customCommand.bind(client);
        let release!: () => void;
        let entered!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const spy = vi.spyOn(client, 'customCommand').mockImplementation(async (...args) => {
            if (
                String(args[0][1]).includes('-- watch-together atomic timeline publication') &&
                String(args[0].at(-4)) !== ''
            ) {
                entered();
                await held;
            }
            return original(...args);
        });
        const resume = signalReady(code, 'host-client', pending.checkId);
        try {
            await blocked;
            await new Promise((resolve) => setTimeout(resolve, 3200));
            expect(
                await getKeyTtlSeconds(`watch:v2:buffer-init-lock:${code}`),
            ).toBeGreaterThanOrEqual(13);
        } finally {
            release();
            await resume;
            spy.mockRestore();
        }
        const frames = (await lRange(`watch:v2:replay:${code}`, 0, -1)).map(
            (raw) => (JSON.parse(raw) as { event: { type: string; resumeAt?: number } }).event,
        );
        expect(frames.find((frame) => frame.type === 'all_ready')?.resumeAt).toBeGreaterThan(
            Date.now() + 1000,
        );
    });

    it('retries departure-triggered completion in a fresh lease after a transient write failure', async () => {
        const host = 'edbb12a5-5e59-54de-86a6-e1d678a722d4';
        const guest = 'e280efdd-d3ab-5102-b2de-25c1d6a7fedd';
        const session = await createSession(
            host,
            'Host',
            'item-old',
            'movie',
            'Old',
            undefined,
            120,
            undefined,
            'host-client',
        );
        const code = session!.code;
        await joinSession(code, guest, 'Guest', 'guest-client', VIEWER);
        await initiateBufferCheck(code, 120, host, true, true);
        const pending = JSON.parse((await cacheGet(`watch:v2:buffer:${code}`))!) as {
            checkId: string;
        };
        await signalReady(code, 'host-client', pending.checkId);
        const client = getCoordinationClient()!;
        const original = client.customCommand.bind(client);
        let failed = false;
        const spy = vi.spyOn(client, 'customCommand').mockImplementation(async (...args) => {
            if (
                !failed &&
                String(args[0][1]).includes('-- watch-together atomic timeline publication') &&
                String(args[0].at(-4)) === pending.checkId
            ) {
                failed = true;
                throw new Error('transient coordination failure');
            }
            return original(...args);
        });
        try {
            await expect(leaveSession(code, guest, 'guest-client')).rejects.toThrow();
            await waitFor(async () => (await cacheGet(`watch:v2:buffer:${code}`)) === null, {
                timeoutMs: 1000,
            });
            expect(failed).toBe(true);
            expect((await getSession(code))?.isPlaying).toBe(true);
        } finally {
            spy.mockRestore();
        }
    });

    it('fences a delayed heartbeat after its transition lease is replaced', async () => {
        const host = 'edbb12a5-5e59-54de-86a6-e1d678a722d4';
        const session = await createSession(
            host,
            'Host',
            'item-old',
            'movie',
            'Old',
            undefined,
            120,
            undefined,
            'host-client',
        );
        const code = session!.code;
        const client = getCoordinationClient()!;
        const original = client.customCommand.bind(client);
        let release!: () => void;
        let entered!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const waiting = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const spy = vi.spyOn(client, 'customCommand').mockImplementation(async (...args) => {
            if (String(args[0][1]).includes('local host = string.lower(session.hostUserId)')) {
                entered();
                await held;
            }
            return original(...args);
        });
        const heartbeat = updateSessionPosition(code, host, 125, 'host-client', true, 'item-old');
        const outcome = heartbeat.catch((error) => error);
        try {
            await waiting;
            await del(`watch:v2:buffer-init-lock:${code}`);
            await broadcastSeek(code, host, 300, 'host-client', false);
            release();
            await outcome;
            expect((await getSession(code))?.currentTime).toBe(300);
            expect((await getSession(code))?.isPlaying).toBe(false);
        } finally {
            release();
            await outcome;
            spy.mockRestore();
        }
    });

    it('a non-member heartbeat is refused without contending for the party lock', async () => {
        const host = 'edbb12a5-5e59-54de-86a6-e1d678a722d4';
        const session = await createSession(
            host,
            'Host',
            'item-old',
            'movie',
            'Old',
            undefined,
            120,
            undefined,
            'host-client',
        );
        const code = session!.code;
        // Another transition holds the lock; a non-member must not queue behind it
        // (heartbeats are unthrottled, so a spinning outsider would starve the party).
        await setEx(`watch:v2:buffer-init-lock:${code}`, 15, 'other-transition');
        try {
            const started = Date.now();
            expect(
                await updateSessionPosition(
                    code,
                    'b6a3c0de-1111-5222-8333-944455556666',
                    999,
                    'outsider-client',
                    true,
                    'item-old',
                ),
            ).toBe(false);
            expect(Date.now() - started).toBeLessThan(1000);
            expect(await cacheGet(`watch:v2:buffer-init-lock:${code}`)).toBe('other-transition');
            expect((await getSession(code))?.currentTime).toBe(120);
        } finally {
            await del(`watch:v2:buffer-init-lock:${code}`);
        }
    });

    it('ignores a late host heartbeat sampled for the previous item', async () => {
        const host = 'edbb12a5-5e59-54de-86a6-e1d678a722d4';
        const session = await createSession(
            host,
            'Host',
            'item-old',
            'movie',
            'Old',
            undefined,
            120,
            undefined,
            'host-client',
        );
        const code = session!.code;
        await broadcastNavigate(code, host, 'item-new', 'New', 'movie', 'host-client');
        expect(await updateSessionPosition(code, host, 125, 'host-client', true, 'item-old')).toBe(
            true,
        );
        expect((await getSession(code))?.currentTime).toBe(0);
        expect((await getSession(code))?.isPlaying).toBe(false);
        expect(await updateSessionPosition(code, host, 3, 'host-client', true, 'item-new')).toBe(
            true,
        );
        expect((await getSession(code))?.currentTime).toBe(3);
        const frames = (await lRange(`watch:v2:replay:${code}`, 0, -1)).map(
            (entry) =>
                (
                    JSON.parse(entry) as {
                        event: { type: string; position?: number; timelineId?: string };
                    }
                ).event,
        );
        expect(
            frames.filter((frame) => frame.type === 'host_position').map((frame) => frame.position),
        ).toEqual([3]);
        expect(frames.find((frame) => frame.type === 'host_position')?.timelineId).toBe(
            (await getSession(code))!.timelineId,
        );
    });

    it('orders navigation after an in-flight join without restoring the old item', async () => {
        const host = 'edbb12a5-5e59-54de-86a6-e1d678a722d4';
        const session = await createSession(
            host,
            'Host',
            'item-old',
            'movie',
            'Old',
            undefined,
            120,
            undefined,
            'host-client',
        );
        const code = session!.code;
        let release!: () => void;
        let entered!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const gated = new Promise<void>((resolve) => {
            entered = resolve;
        });
        vi.mocked(checkMediaAccess).mockImplementationOnce(async () => {
            entered();
            await held;
            return true;
        });
        const joining = joinSession(
            code,
            'e280efdd-d3ab-5102-b2de-25c1d6a7fedd',
            'Guest',
            'guest-client',
            VIEWER,
        );
        let navigated = false;
        await gated;
        const navigation = broadcastNavigate(
            code,
            host,
            'item-new',
            'New',
            'movie',
            'host-client',
        ).then((result) => {
            navigated = true;
            return result;
        });
        try {
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(navigated).toBe(false);
        } finally {
            release();
            await joining;
            await navigation;
        }
        expect((await getSession(code))?.itemId).toBe('item-new');
        expect((await getSession(code))?.currentTime).toBe(0);
    });

    it('retries mandatory completion after a contended transition acquisition', async () => {
        const host = 'edbb12a5-5e59-54de-86a6-e1d678a722d4';
        const session = await createSession(
            host,
            'Host',
            'item-old',
            'movie',
            'Old',
            undefined,
            120,
            undefined,
            'host-client',
        );
        const code = session!.code;
        await initiateBufferCheck(code, 120, host, true, true);
        const raw = (await cacheGet(`watch:v2:buffer:${code}`))!;
        const pending = JSON.parse(raw) as { checkId: string };
        await setEx(`watch:v2:buffer-init-lock:${code}`, 15, 'other-transition');
        const release = new Promise<void>((resolve) => {
            setTimeout(() => {
                void del(`watch:v2:buffer-init-lock:${code}`).then(() => resolve());
            }, 10500);
        });
        await Promise.all([signalReady(code, 'host-client', pending.checkId), release]);
        expect(await cacheGet(`watch:v2:buffer:${code}`)).toBeNull();
        expect((await getSession(code))?.isPlaying).toBe(true);
        const frames = (await lRange(`watch:v2:replay:${code}`, 0, -1)).map(
            (entry) => (JSON.parse(entry) as { event: { type: string } }).event.type,
        );
        expect(frames).toContain('all_ready');
    }, 20000);

    it('retries a failed navigation atomically and never rewinds an acknowledged command', async () => {
        const host = 'edbb12a5-5e59-54de-86a6-e1d678a722d4';
        const session = await createSession(
            host,
            'Host',
            'item-old',
            'movie',
            'Old',
            undefined,
            120,
            undefined,
            'host-client',
        );
        const code = session!.code;
        const timelineId = crypto.randomUUID();
        const client = getCoordinationClient();
        if (!client) throw new Error('Valkey required');
        const original = client.customCommand.bind(client);
        let fail = true;
        const spy = vi.spyOn(client, 'customCommand').mockImplementation(async (...args) => {
            if (
                fail &&
                String(args[0][1]).includes('-- watch-together atomic timeline publication')
            ) {
                fail = false;
                throw new Error('publication unavailable');
            }
            return original(...args);
        });
        try {
            await expect(
                broadcastNavigate(
                    code,
                    host,
                    'item-new',
                    'New',
                    'movie',
                    'host-client',
                    undefined,
                    timelineId,
                ),
            ).rejects.toThrow();
            expect((await getSession(code))?.itemId).toBe('item-old');
            expect((await getSession(code))?.timelineId).toBe(session!.timelineId);
            expect(
                await broadcastNavigate(
                    code,
                    host,
                    'item-new',
                    'New',
                    'movie',
                    'host-client',
                    undefined,
                    timelineId,
                ),
            ).toBe(true);
            expect((await getSession(code))?.timelineId).toBe(timelineId);
            await updateSessionPosition(
                code,
                host,
                45,
                'host-client',
                true,
                'item-new',
                timelineId,
            );
            expect(
                await broadcastNavigate(
                    code,
                    host,
                    'item-new',
                    'New',
                    'movie',
                    'host-client',
                    undefined,
                    timelineId,
                ),
            ).toBe(true);
            expect((await getSession(code))?.currentTime).toBe(45);
            const frames = (await lRange(`watch:v2:replay:${code}`, 0, -1)).map(
                (entry) => JSON.parse(entry) as { event: { type: string } },
            );
            expect(frames.filter((frame) => frame.event.type === 'navigate')).toHaveLength(1);
            const newer = crypto.randomUUID();
            expect(
                await broadcastNavigate(
                    code,
                    host,
                    'item-latest',
                    'Latest',
                    'movie',
                    'host-client',
                    undefined,
                    newer,
                ),
            ).toBe(true);
            expect(
                await broadcastNavigate(
                    code,
                    host,
                    'item-new',
                    'New',
                    'movie',
                    'host-client',
                    undefined,
                    timelineId,
                ),
            ).toBe(false);
            expect((await getSession(code))?.itemId).toBe('item-latest');
            expect((await getSession(code))?.timelineId).toBe(newer);
            expect(
                await broadcastNavigate(
                    code,
                    host,
                    'item-delayed',
                    'Delayed',
                    'movie',
                    'host-client',
                    undefined,
                    crypto.randomUUID(),
                    timelineId,
                ),
            ).toBe(false);
            expect((await getSession(code))?.timelineId).toBe(newer);
        } finally {
            spy.mockRestore();
        }
    });

    it('navigate changes media and resets playback state', async () => {
        const session = await createSession(
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'Host',
            'item-123',
            'movie',
            'Test Movie',
            undefined,
            120,
            undefined,
            'host-client',
        );
        expect(session).not.toBeNull();

        const code = session!.code;

        const result = await broadcastNavigate(
            code,
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'item-456',
            'New Movie',
            'movie',
            'host-client',
        );
        expect(result).toBe(true);

        const after = await getSession(code);
        expect(after).not.toBeNull();
        expect(after!.itemId).toBe('item-456');
        expect(after!.title).toBe('New Movie');
        expect(after!.currentTime).toBe(0);
        expect(after!.isPlaying).toBe(false);
    });

    // =====================================================================
    // 8. Multi-device: same user joins from multiple devices
    // =====================================================================

    it('supports same user on multiple devices', async () => {
        const session = await createSession(
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'Host',
            'item-123',
            'movie',
            'Test Movie',
        );
        expect(session).not.toBeNull();

        const code = session!.code;

        await joinSession(
            code,
            'd97c9016-7a1a-51b7-97b7-c90cb92b6071',
            'MultiDevice',
            'device-a',
            VIEWER,
        );
        await joinSession(
            code,
            'd97c9016-7a1a-51b7-97b7-c90cb92b6071',
            'MultiDevice',
            'device-b',
            VIEWER,
        );

        const afterJoins = await getSession(code);
        expect(afterJoins).not.toBeNull();
        expect(afterJoins!.participants).toHaveLength(3);
        expect(
            afterJoins!.participants.filter(
                (p) => p.userId === 'd97c9016-7a1a-51b7-97b7-c90cb92b6071',
            ),
        ).toHaveLength(2);
        expect(await getUserActiveSession('d97c9016-7a1a-51b7-97b7-c90cb92b6071')).toBe(code);

        // Leave specific device
        const leftA = await leaveSession(code, 'd97c9016-7a1a-51b7-97b7-c90cb92b6071', 'device-a');
        expect(leftA).toBe(true);

        const afterLeaveA = await getSession(code);
        expect(afterLeaveA).not.toBeNull();
        expect(
            afterLeaveA!.participants.filter(
                (p) => p.userId === 'd97c9016-7a1a-51b7-97b7-c90cb92b6071',
            ),
        ).toHaveLength(1);
        // User still tracked since device-b remains
        expect(await getUserActiveSession('d97c9016-7a1a-51b7-97b7-c90cb92b6071')).toBe(code);

        // Leave all for user (no clientId)
        const leftAll = await leaveSession(code, 'd97c9016-7a1a-51b7-97b7-c90cb92b6071');
        expect(leftAll).toBe(true);

        const afterLeaveAll = await getSession(code);
        expect(afterLeaveAll).not.toBeNull();
        expect(
            afterLeaveAll!.participants.filter(
                (p) => p.userId === 'd97c9016-7a1a-51b7-97b7-c90cb92b6071',
            ),
        ).toHaveLength(0);
        expect(afterLeaveAll!.participants).toHaveLength(1); // only host
        expect(await getUserActiveSession('d97c9016-7a1a-51b7-97b7-c90cb92b6071')).toBeNull();
    });

    // =====================================================================
    // 9. Session visibility
    // =====================================================================

    it('toggles session visibility and filters in getAllSessions', async () => {
        const session1 = await createSession(
            'b9e0e6c2-01f1-5a85-a955-8d83fe14a14e',
            'UserA',
            'item-1',
            'movie',
            'Movie 1',
        );
        expect(session1).not.toBeNull();

        const session2 = await createSession(
            'c15fcb8b-687b-5677-93fb-60223849476c',
            'UserB',
            'item-2',
            'movie',
            'Movie 2',
        );
        expect(session2).not.toBeNull();

        // Creation is unlisted unless explicitly published.
        expect(session1!.visibility).toBe('unlisted');
        expect(session2!.visibility).toBe('unlisted');
        expect(await getAllSessions(true)).toEqual([]);
        await setSessionVisibility(session1!.code, session1!.hostUserId, 'listed');
        await setSessionVisibility(session2!.code, session2!.hostUserId, 'listed');
        const allPublic = await getAllSessions(true);
        expect(allPublic.some((s) => s.code === session1!.code)).toBe(true);
        expect(allPublic.some((s) => s.code === session2!.code)).toBe(true);

        // Host toggles session1 to private
        const visResult = await setSessionVisibility(
            session1!.code,
            'b9e0e6c2-01f1-5a85-a955-8d83fe14a14e',
            'unlisted',
        );
        expect(visResult).toBe(true);

        // Non-host cannot change visibility
        const nonHostVis = await setSessionVisibility(
            session1!.code,
            'c15fcb8b-687b-5677-93fb-60223849476c',
            'listed',
        );
        expect(nonHostVis).toBe(false);

        const publicOnly = await getAllSessions(true);
        expect(publicOnly.some((s) => s.code === session1!.code)).toBe(false);
        expect(publicOnly.some((s) => s.code === session2!.code)).toBe(true);

        const allSessions = await getAllSessions(false);
        expect(allSessions.some((s) => s.code === session1!.code)).toBe(true);
        expect(allSessions.some((s) => s.code === session2!.code)).toBe(true);
    });

    // A stale session (lastSync older than 5 min) that STILL has a live SSE
    // connection is a paused-but-connected party, not an abandoned one — it must
    // NOT be reaped. Regression guard for the tvOS "paused Safari tab closes the
    // party after ~10 min" report.
    it('does NOT reap a stale-but-connected session (live SSE keepalive)', async () => {
        const session = await createSession(
            'paused-host',
            'PausedHost',
            'item-p',
            'movie',
            'Paused',
        );
        expect(session).not.toBeNull();
        const code = session!.code;

        // Force lastSync 6 minutes into the past (past the 5-min stale threshold),
        // simulating a party paused with no playback events.
        const raw = await cacheGet(`watch:v2:session:${code}`);
        expect(raw).not.toBeNull();
        const stored = JSON.parse(raw!) as StoredSession;
        stored.lastSync = Date.now() - 6 * 60 * 1000;
        await setEx(`watch:v2:session:${code}`, 4 * 60 * 60, JSON.stringify(stored));

        // But a viewer is still connected — keepalive just refreshed liveness.
        await touchSSEConnection(code, session!.hostClientId ?? 'paused-host-client');

        const sessions = await getAllSessions(false);
        expect(sessions.some((s) => s.code === code)).toBe(true);
        // Session must still exist in Valkey (not torn down by endSession).
        expect(await getSession(code)).not.toBeNull();
    });

    // The complement: a stale session with NO live connection is genuinely
    // abandoned and must still be reaped (no infinite-life leak).
    it('still reaps a stale session with no live connection', async () => {
        const session = await createSession(
            '436057f9-01eb-534b-9882-2ab26cee8c84',
            'DeadHost',
            'item-d',
            'movie',
            'Dead',
        );
        expect(session).not.toBeNull();
        const code = session!.code;

        const raw = await cacheGet(`watch:v2:session:${code}`);
        const stored = JSON.parse(raw!) as StoredSession;
        stored.lastSync = Date.now() - 6 * 60 * 1000;
        await setEx(`watch:v2:session:${code}`, 4 * 60 * 60, JSON.stringify(stored));
        // No touchSSEConnection → CONNECTIONS empty → getLiveConnectionCount → null.

        const sessions = await getAllSessions(false);
        expect(sessions.some((s) => s.code === code)).toBe(false);
        // Reaping is fire-and-forget (cleanupStaleSessions runs detached), so poll
        // for the eventual teardown rather than asserting synchronously.
        await waitFor(async () => (await getSession(code)) === null);
        expect(await getSession(code)).toBeNull();
        expect(await getUserActiveSession('436057f9-01eb-534b-9882-2ab26cee8c84')).toBeNull();
    });

    // A client relaunching (app foreground / SSE reconnect) rejoins with the same
    // clientId. Even though it hits the idempotent rejoin path, the per-user
    // active-session pointer must be (re)established so launch-restore via
    // getUserActiveSession works. Regression guard for tvOS "reopen mid-party
    // shows not in a party".
    it('re-establishes the active-session pointer on rejoin with same clientId', async () => {
        const session = await createSession(
            '4c37b184-6358-57bd-9c92-f4fa9c70fc09',
            'HostR',
            'item-r',
            'movie',
            'Rejoin',
        );
        const code = session!.code;
        const joined = await joinSession(
            code,
            'afabc0bf-daec-5fa9-9ce5-a16623710fb1',
            'GuestR',
            'client-r',
            VIEWER,
        );
        expect(joined).not.toBeNull();
        expect(await getUserActiveSession('afabc0bf-daec-5fa9-9ce5-a16623710fb1')).toBe(code);

        // Simulate the pointer being lost (TTL/eviction/prior teardown) while the
        // participant remains in the session.
        await del(`watch:v2:user:afabc0bf-daec-5fa9-9ce5-a16623710fb1`);
        expect(await getUserActiveSession('afabc0bf-daec-5fa9-9ce5-a16623710fb1')).toBeNull();

        // Rejoin with the SAME clientId → idempotent path, participant count unchanged.
        const rejoined = await joinSession(
            code,
            'afabc0bf-daec-5fa9-9ce5-a16623710fb1',
            'GuestR',
            'client-r',
            VIEWER,
        );
        expect(rejoined).not.toBeNull();
        expect(
            rejoined!.participants.filter(
                (p) => p.userId === 'afabc0bf-daec-5fa9-9ce5-a16623710fb1',
            ),
        ).toHaveLength(1);
        // Pointer restored.
        expect(await getUserActiveSession('afabc0bf-daec-5fa9-9ce5-a16623710fb1')).toBe(code);
    });

    // =====================================================================
    // 10. Disband / end session
    // =====================================================================

    it('disbands and ends sessions with proper authorization', async () => {
        const session = await createSession(
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'Host',
            'item-123',
            'movie',
            'Test Movie',
        );
        expect(session).not.toBeNull();

        const code = session!.code;

        await joinSession(
            code,
            '0879368a-187c-528a-9c33-c97f420fd52d',
            'Guest',
            'guest-client',
            VIEWER,
        );

        // Non-host disband fails
        const guestDisband = await disbandSession(code, '0879368a-187c-528a-9c33-c97f420fd52d');
        expect(guestDisband).toBe(false);

        // Host disband succeeds
        const hostDisband = await disbandSession(code, 'edbb12a5-5e59-54de-86a6-e1d678a722d4');
        expect(hostDisband).toBe(true);

        expect(await getSession(code)).toBeNull();
        expect(await getUserActiveSession('edbb12a5-5e59-54de-86a6-e1d678a722d4')).toBeNull();
        expect(await getUserActiveSession('0879368a-187c-528a-9c33-c97f420fd52d')).toBeNull();

        // New session for endSession test
        const session2 = await createSession(
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'Host',
            'item-456',
            'movie',
            'Movie 2',
        );
        expect(session2).not.toBeNull();

        const code2 = session2!.code;

        // C8 fix: the public endSession() signature no longer accepts the
        // literal 'system' as an in-band escape from the host-only check — a
        // real account named 'system' must never be able to end someone
        // else's party this way. The session must be left fully intact.
        const spoofedSystemEnd = await endSession(code2, 'system');
        expect(spoofedSystemEnd).toBe(false);
        expect(await getSession(code2)).not.toBeNull();

        // The internal stale-session-sweep path (endSessionAsSystem) is the
        // only thing that may end a session with no host check.
        const systemEnd = await endSessionAsSystem(code2);
        expect(systemEnd).toBe(true);

        expect(await getSession(code2)).toBeNull();
    });

    // =====================================================================
    // 11. Position reporting / drift detection
    // =====================================================================

    it('reports persistent large drift without pausing the group', async () => {
        const session = await createSession(
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'Host',
            'item-123',
            'movie',
            'Test Movie',
            undefined,
            0,
            undefined,
            'host-client',
        );
        expect(session).not.toBeNull();

        const code = session!.code;

        await joinSession(
            code,
            '0879368a-187c-528a-9c33-c97f420fd52d',
            'Guest',
            'guest-client',
            VIEWER,
        );

        // Drift correction is intentionally disabled while paused. Put the
        // session into its normal playing state before reporting positions.
        await updatePlaybackState(
            code,
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            { currentTime: 60, isPlaying: true, playbackRate: 1, timestamp: Date.now() },
            'host-client',
        );

        // Host reports position 60
        const hostReport = await reportPosition(
            code,
            'host-client',
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            60,
        );
        expect(hostReport.success).toBe(true);
        expect(hostReport.resyncing).toBe(false);

        // One excessive sample is treated as noise; persistent drift confirms it.
        const firstGuestReport = await reportPosition(
            code,
            'guest-client',
            '0879368a-187c-528a-9c33-c97f420fd52d',
            100,
        );
        expect(firstGuestReport.success).toBe(true);
        expect(firstGuestReport.resyncing).toBe(false);

        const confirmedGuestReport = await reportPosition(
            code,
            'guest-client',
            '0879368a-187c-528a-9c33-c97f420fd52d',
            100,
        );
        expect(confirmedGuestReport.success).toBe(true);
        expect(confirmedGuestReport.resyncing).toBe(false);

        // Periodic drift correction is client-local (rate adjustment / seek),
        // so the detector must never create a group-wide buffer check.
        const bufferKeys = await getKeysByPattern(`watch:v2:buffer:${code}`);
        expect(bufferKeys).toHaveLength(0);
    });

    it('does not collect drift evidence while the party is paused', async () => {
        const session = await createSession(
            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
            'Host',
            'item-123',
            'movie',
            'Test Movie',
            undefined,
            0,
            undefined,
            'host-client',
        );
        expect(session).not.toBeNull();

        const code = session!.code;
        await joinSession(
            code,
            '0879368a-187c-528a-9c33-c97f420fd52d',
            'Guest',
            'guest-client',
            VIEWER,
        );

        await reportPosition(code, 'host-client', 'edbb12a5-5e59-54de-86a6-e1d678a722d4', 10);
        const guestReport = await reportPosition(
            code,
            'guest-client',
            '0879368a-187c-528a-9c33-c97f420fd52d',
            100,
        );

        expect(guestReport).toEqual({ success: true, resyncing: false });
        expect(await getKeysByPattern('watch:v2:positions:*')).toHaveLength(0);
        expect(await getKeysByPattern('watch:v2:drift-breach:*')).toHaveLength(0);
        expect(await getKeysByPattern(`watch:v2:buffer:${code}`)).toHaveLength(0);
    });

    // =====================================================================
    // Absent-host sweep: a party whose host is gone ends for everyone
    // =====================================================================

    describe('automatic stale guest cleanup', () => {
        async function staleParty(): Promise<{
            code: string;
            session: StoredSession;
            now: number;
        }> {
            const created = await createSession(
                'edbb12a5-5e59-54de-86a6-e1d678a722d4',
                'Host',
                'item-1',
                'movie',
                'Movie',
                undefined,
                0,
                undefined,
                'host-client',
            );
            const code = created!.code;
            await joinSession(
                code,
                '0879368a-187c-528a-9c33-c97f420fd52d',
                'Guest',
                'guest-client',
                VIEWER,
            );
            await joinSession(
                code,
                '0879368a-187c-528a-9c33-c97f420fd52d',
                'Guest second device',
                'guest-device',
                VIEWER,
            );
            const now = Date.now();
            const session = (await getSession(code))!;
            session.participants = session.participants.map((p) => ({
                ...p,
                joinedAt: now - 180000,
            }));
            await setEx(`watch:v2:session:${code}`, 3600, JSON.stringify(session));
            await hSet(`watch:v2:conn:${code}`, 'host-client', String(now));
            await hSet(`watch:v2:conn:${code}`, 'guest-client', String(now - 100000));
            await hSet(`watch:v2:conn:${code}`, 'guest-device', String(now));
            return { code, session, now };
        }

        it('removes only the stale client without another join and announces departure', async () => {
            const { code, now } = await staleParty();
            const events: unknown[] = [];
            const unregister = await registerSSEConnection(code, 'host-client', (event) =>
                events.push(event),
            );
            const barrier = await initiateBufferCheck(
                code,
                25,
                'edbb12a5-5e59-54de-86a6-e1d678a722d4',
                true,
                true,
            );
            expect(barrier).toBeTruthy();
            expect(await sweepStaleGuests(now)).toContain('guest-client');
            const session = (await getSession(code))!;
            expect(session.participants.map((p) => p.clientId)).toEqual([
                'host-client',
                'guest-device',
            ]);
            expect(session.hostClientId).toBe('host-client');
            expect(await getUserActiveSession('0879368a-187c-528a-9c33-c97f420fd52d')).toBe(code);
            await waitFor(async () =>
                events.some(
                    (event) =>
                        (event as { type: string; clientId: string }).type === 'participant_left' &&
                        (event as { clientId: string }).clientId === 'guest-client',
                ),
            );
            const pending = JSON.parse((await cacheGet(`watch:v2:buffer:${code}`))!) as {
                expectedClientIds?: string[];
                expectedCount: number;
            };
            expect(pending.expectedClientIds).toEqual(['host-client', 'guest-device']);
            expect(pending.expectedCount).toBe(2);
            const checkId = (pending as unknown as { checkId: string }).checkId;
            await signalReady(code, 'host-client', checkId);
            expect(await cacheGet(`watch:v2:buffer:${code}`)).not.toBeNull();
            await signalReady(code, 'guest-device', checkId);
            expect(await cacheGet(`watch:v2:buffer:${code}`)).toBeNull();
            unregister();
        });

        it('releases an expected guest that goes stale while a barrier is waiting', async () => {
            const { code, now } = await staleParty();
            await hSet(`watch:v2:conn:${code}`, 'guest-client', String(now));
            await initiateBufferCheck(code, 25, 'edbb12a5-5e59-54de-86a6-e1d678a722d4', true, true);
            const pending = JSON.parse((await cacheGet(`watch:v2:buffer:${code}`))!) as {
                checkId: string;
                expectedCount: number;
            };
            expect(pending.expectedCount).toBe(3);
            await signalReady(code, 'host-client', pending.checkId);
            await signalReady(code, 'guest-device', pending.checkId);
            await hSet(`watch:v2:conn:${code}`, 'guest-client', String(now - 100000));
            expect(await sweepStaleGuests(now)).toContain('guest-client');
            expect(await cacheGet(`watch:v2:buffer:${code}`)).toBeNull();
        });

        it('a ready signal racing departure cannot reinsert the departed identity', async () => {
            const { code, now } = await staleParty();
            await hSet(`watch:v2:conn:${code}`, 'guest-client', String(now));
            await initiateBufferCheck(code, 25, 'edbb12a5-5e59-54de-86a6-e1d678a722d4', true, true);
            const pending = JSON.parse((await cacheGet(`watch:v2:buffer:${code}`))!) as {
                checkId: string;
            };
            await signalReady(code, 'host-client', pending.checkId);
            const client = getCoordinationClient()!;
            const command = client.customCommand.bind(client);
            const spy = vi
                .spyOn(client, 'customCommand')
                .mockImplementation(async (args, options) => {
                    if (
                        args[0] === 'EVAL' &&
                        String(args[1]).includes("redis.call('SADD', KEYS[2]")
                    ) {
                        spy.mockRestore();
                        await leaveSession(
                            code,
                            '0879368a-187c-528a-9c33-c97f420fd52d',
                            'guest-client',
                        );
                    }
                    return command(args, options);
                });
            await signalReady(code, 'guest-client', pending.checkId);
            spy.mockRestore();
            const after = JSON.parse((await cacheGet(`watch:v2:buffer:${code}`))!) as {
                expectedCount: number;
            };
            expect(after.expectedCount).toBe(2);
            const ready = await command(['SMEMBERS', `watch:v2:ready:${code}:${pending.checkId}`]);
            expect(ready).toEqual(['host-client']);
            await signalReady(code, 'guest-device', pending.checkId);
            expect(await cacheGet(`watch:v2:buffer:${code}`)).toBeNull();
        });

        it('an in-flight heartbeat cannot restore removed membership or old host ownership', async () => {
            const { code, now } = await staleParty();
            const client = getCoordinationClient()!;
            const command = client.customCommand.bind(client);
            let raceInjected = false;
            const spy = vi
                .spyOn(client, 'customCommand')
                .mockImplementation(async (args, options) => {
                    if (
                        args[0] === 'EVAL' &&
                        String(args[1]).includes(
                            'return cjson.encode({session = session, isHost = host})',
                        )
                    ) {
                        raceInjected = true;
                        spy.mockRestore();
                        await sweepStaleGuests(now);
                        await transferHost(
                            code,
                            'edbb12a5-5e59-54de-86a6-e1d678a722d4',
                            '0879368a-187c-528a-9c33-c97f420fd52d',
                        );
                    }
                    return command(args, options);
                });
            await updateSessionPosition(
                code,
                'edbb12a5-5e59-54de-86a6-e1d678a722d4',
                55,
                'host-client',
                true,
            );
            spy.mockRestore();
            expect(raceInjected).toBe(true);
            const after = (await getSession(code))!;
            expect(after.participants.map((p) => p.clientId)).toEqual([
                'host-client',
                'guest-device',
            ]);
            expect(after.hostClientId).toBe('guest-device');
            expect(after.currentTime).not.toBe(55);
            expect(
                await updateSessionPosition(
                    code,
                    '0879368a-187c-528a-9c33-c97f420fd52d',
                    40,
                    'guest-client',
                    true,
                ),
            ).toBe(false);
        });

        it('continues past malformed entries and visits sessions beyond the former 500 cap', async () => {
            const { session, now } = await staleParty();
            await setEx('watch:v2:session:MALFORMED', 3600, '{');
            const codes = Array.from({ length: 501 }, (_, i) => `BULK${i}`);
            for (const code of codes) {
                await setEx(`watch:v2:session:${code}`, 3600, JSON.stringify({ ...session, code }));
                await hSet(`watch:v2:conn:${code}`, 'guest-client', String(now - 100000));
            }
            const removed = await sweepStaleGuests(now);
            expect(removed.filter((id) => id === 'guest-client')).toHaveLength(502);
            for (const code of codes)
                expect(
                    (await getSession(code))!.participants.some(
                        (p) => p.clientId === 'guest-client',
                    ),
                ).toBe(false);
        });

        it('retains a reconnect within grace and a new membership generation', async () => {
            const { code, session, now } = await staleParty();
            await touchSSEConnection(code, 'guest-client');
            expect(await sweepStaleGuests(now)).not.toContain('guest-client');
            await hSet(`watch:v2:conn:${code}`, 'guest-client', String(now - 100000));
            session.participants.find((p) => p.clientId === 'guest-client')!.joinedAt = now - 1000;
            await setEx(`watch:v2:session:${code}`, 3600, JSON.stringify(session));
            expect(await sweepStaleGuests(now)).not.toContain('guest-client');
        });

        it('fails open on absent or invalid liveness evidence', async () => {
            const { code, now } = await staleParty();
            await del(`watch:v2:conn:${code}`);
            expect(await sweepStaleGuests(now)).toEqual([]);
            await hSet(`watch:v2:conn:${code}`, 'guest-client', 'unavailable');
            expect(await sweepStaleGuests(now)).toEqual([]);
            expect((await getSession(code))!.participants).toHaveLength(3);
        });

        it('an old unregister retains a newer cross-replica marker', async () => {
            const { code } = await staleParty();
            const unregister = await registerSSEConnection(code, 'guest-client', () => {});
            const fresh = String(Date.now() + 1000);
            await hSet(`watch:v2:conn:${code}`, 'guest-client', fresh);
            unregister();
            await new Promise((resolve) => setTimeout(resolve, 25));
            expect((await hGetAll(`watch:v2:conn:${code}`))['guest-client']).toBe(fresh);
        });

        it.each(['reconnect', 'membership update'])(
            'atomic removal preserves a concurrent %s',
            async (race) => {
                const { code, now } = await staleParty();
                const client = getCoordinationClient()!;
                const command = client.customCommand.bind(client);
                const spy = vi
                    .spyOn(client, 'customCommand')
                    .mockImplementation(async (args, options) => {
                        if (
                            args[0] === 'EVAL' &&
                            String(args[1]).includes('-- watch-together stale membership removal')
                        ) {
                            spy.mockRestore();
                            if (race === 'reconnect')
                                await touchSSEConnection(code, 'guest-client');
                            else {
                                const current = (await getSession(code))!;
                                current.currentTime = 55;
                                await setEx(
                                    `watch:v2:session:${code}`,
                                    3600,
                                    JSON.stringify(current),
                                );
                            }
                        }
                        return command(args, options);
                    });
                expect(await sweepStaleGuests(now)).not.toContain('guest-client');
                spy.mockRestore();
                expect((await getSession(code))!.participants).toHaveLength(3);
                if (race === 'membership update')
                    expect((await getSession(code))!.currentTime).toBe(55);
            },
        );
    });

    describe('sweepAbsentHosts', () => {
        const TEN_MIN = 10 * 60_000;

        async function partyWithGuest(): Promise<string> {
            const session = await createSession(
                'edbb12a5-5e59-54de-86a6-e1d678a722d4',
                'Host',
                'item-1',
                'movie',
                'Movie',
                undefined,
                0,
                undefined,
                'host-client',
            );
            const code = session!.code;
            await joinSession(
                code,
                '0879368a-187c-528a-9c33-c97f420fd52d',
                'Guest',
                'guest-client',
                VIEWER,
            );
            // The guest stays connected the whole time: the old lazy reap never ended
            // a party with a connected participant, so this is the case to cover.
            await touchSSEConnection(code, 'guest-client');
            return code;
        }

        it('ends a party whose host has been gone longer than the limit', async () => {
            const code = await partyWithGuest();
            await setEx(`watch:v2:host-seen:${code}`, 3600, String(Date.now() - TEN_MIN - 1000));

            const ended = await sweepAbsentHosts(TEN_MIN);
            expect(ended).toContain(code);
            expect(await getSession(code)).toBeNull();
        });

        it('keeps a party whose host sent a heartbeat recently', async () => {
            const code = await partyWithGuest();
            await setEx(`watch:v2:host-seen:${code}`, 3600, String(Date.now() - TEN_MIN - 1000));
            await updateSessionPosition(
                code,
                'edbb12a5-5e59-54de-86a6-e1d678a722d4',
                12,
                'host-client',
                true,
            );

            expect(await sweepAbsentHosts(TEN_MIN)).not.toContain(code);
            expect(await getSession(code)).not.toBeNull();
        });

        it('keeps a party whose host is connected, however old its last heartbeat', async () => {
            const code = await partyWithGuest();
            await setEx(`watch:v2:host-seen:${code}`, 3600, String(Date.now() - 3 * TEN_MIN));
            await touchSSEConnection(code, 'host-client');

            expect(await sweepAbsentHosts(TEN_MIN)).not.toContain(code);
        });

        it('starts the clock at the first sweep when no sighting is recorded', async () => {
            const code = await partyWithGuest();
            await del(`watch:v2:host-seen:${code}`);

            const now = Date.now();
            expect(await sweepAbsentHosts(TEN_MIN, now)).not.toContain(code);
            expect(await sweepAbsentHosts(TEN_MIN, now + TEN_MIN - 1000)).not.toContain(code);
            expect(await sweepAbsentHosts(TEN_MIN, now + TEN_MIN + 1000)).toContain(code);
        });

        it('keeps the host sighting longer than the longest absence limit', async () => {
            // With the session's 4 h TTL a limit above 240 min never ended a party: the
            // sighting expired and the sweep restarted the clock.
            const code = await partyWithGuest();
            expect(await getKeyTtlSeconds(`watch:v2:host-seen:${code}`)).toBeGreaterThan(24 * 3600);
        });

        it('gives a host promoted after the old host left a fresh clock', async () => {
            const code = await partyWithGuest();
            await setEx(`watch:v2:host-seen:${code}`, 3600, String(Date.now() - TEN_MIN - 1000));
            await leaveSession(code, 'edbb12a5-5e59-54de-86a6-e1d678a722d4', 'host-client');

            const session = await getSession(code);
            expect(session?.hostClientId).toBe('guest-client');
            expect(await sweepAbsentHosts(TEN_MIN)).not.toContain(code);
        });
    });
});
