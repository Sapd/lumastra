// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the `endSession` host-only fix (security review 2026-09-13,
 * C8).
 *
 * `endSession(code, userId)` used to accept the literal string `'system'` as
 * an in-band escape from its host-only check — meaning a REAL account named
 * `system` could end ANY party by hitting `DELETE /watch-together/{code}`.
 * The only legitimate caller of that escape (`cleanupStaleSessions`, the
 * stale-session sweep) now goes through the internal `endSessionAsSystem`
 * instead, and the public `endSession` no longer has any string that bypasses
 * the host check.
 *
 * Uses real coordination storage so authorization and terminal publication
 * exercise the same lease and Lua contracts as runtime. Noncritical reaction
 * replay failures are injected at the append/publish boundary.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as cache from '$lib/server/cache/valkey.js';

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

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => null }));

// Exercise the actual Redis Lua contracts; only inject the two failures the
// replay fallback tests need. A ready coordinator with no command client is an
// outage, so the old in-memory fixture no longer represents a healthy session.
vi.mock('$lib/server/cache/valkey.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/cache/valkey.js')>();
    return { ...actual, incr: vi.fn(actual.incr), publishMessage: vi.fn(actual.publishMessage) };
});

const RUN = Boolean(process.env.CACHE_URL);

beforeAll(async () => {
    if (!RUN) return;
    await cache.connectValkey();
});
beforeEach(async () => {
    if (!RUN) return;
    vi.clearAllMocks();
    const keys = await cache.getKeysByPattern('watch:v2:*');
    if (keys.length) await cache.del(keys);
});
afterAll(async () => {
    if (!RUN) return;
    const keys = await cache.getKeysByPattern('watch:v2:*');
    if (keys.length) await cache.del(keys);
    await cache.del('watch:session:OLD123');
});

const {
    createSession,
    getSession,
    endSession,
    endSessionAsSystem,
    broadcastReaction,
    setSessionVisibility,
    registerSSEConnection,
} = await import('./watch-together.service.js');

describe.runIf(RUN)('endSession — host-only, no "system" sentinel escape', () => {
    it('ignores sessions stored under the previous key version', async () => {
        await cache.setEx(
            'watch:session:OLD123',
            60,
            JSON.stringify({ code: 'OLD123', hostUsername: 'old' }),
        );
        expect(await getSession('OLD123')).toBeNull();
    });

    it('rejects the "system" sentinel via the public signature — false, session intact', async () => {
        const session = await createSession(
            '36783d59-df31-55eb-8c63-8ab7869a529a',
            'Bob',
            'item-1',
            'movie',
            'Session Title',
        );
        expect(session).not.toBeNull();
        const code = session!.code;

        const result = await endSession(code, 'system');
        expect(result).toBe(false);

        const stillThere = await getSession(code);
        expect(stillThere).not.toBeNull();
        expect(stillThere!.hostUserId).toBe('36783d59-df31-55eb-8c63-8ab7869a529a');
    });

    it('still lets the real host end their own session', async () => {
        const session = await createSession(
            '36783d59-df31-55eb-8c63-8ab7869a529a',
            'Bob',
            'item-2',
            'movie',
            'Session Title 2',
        );
        const code = session!.code;

        const result = await endSession(code, '36783d59-df31-55eb-8c63-8ab7869a529a');
        expect(result).toBe(true);
        expect(await getSession(code)).toBeNull();
    });

    it('rejects a non-host, non-"system" caller too (ordinary host-only behaviour unchanged)', async () => {
        const session = await createSession(
            '36783d59-df31-55eb-8c63-8ab7869a529a',
            'Bob',
            'item-3',
            'movie',
            'Session Title 3',
        );
        const code = session!.code;

        const result = await endSession(code, 'f9260e4f-89e7-5d9f-8652-6f2e6a2e6dfc');
        expect(result).toBe(false);
        expect(await getSession(code)).not.toBeNull();
    });

    it('endSessionAsSystem — the internal stale-session-sweep path — ends the session regardless of host', async () => {
        const session = await createSession(
            '36783d59-df31-55eb-8c63-8ab7869a529a',
            'Bob',
            'item-4',
            'movie',
            'Session Title 4',
        );
        const code = session!.code;

        const result = await endSessionAsSystem(code);
        expect(result).toBe(true);
        expect(await getSession(code)).toBeNull();
    });
});

describe.runIf(RUN)('timeline publication failure', () => {
    it('reports coordination failure and never sends an unsequenced timeline frame', async () => {
        const session = await createSession(
            '36783d59-df31-55eb-8c63-8ab7869a529a',
            'Bob',
            'item-1',
            'movie',
            'Title',
        );
        const client = cache.getCoordinationClient()!;
        const original = client.customCommand.bind(client);
        const local = vi.fn();
        const unregister = await registerSSEConnection(session!.code, 'guest', local);
        const spy = vi.spyOn(client, 'customCommand').mockImplementation(async (...args) => {
            if (String(args[0][1]).includes('-- watch-together atomic timeline publication'))
                throw new Error('atomic publication unavailable');
            return original(...args);
        });
        try {
            await expect(
                setSessionVisibility(session!.code, session!.hostUserId, 'listed'),
            ).rejects.toThrow();
            expect(cache.publishMessage).not.toHaveBeenCalled();
            expect(local).not.toHaveBeenCalled();
            expect(await cache.cacheGet(`watch:v2:buffer-init-lock:${session!.code}`)).toBeNull();
        } finally {
            spy.mockRestore();
            await unregister();
        }
    });
});

describe.runIf(RUN)('broadcast replay fail-soft', () => {
    it.each([true, false])(
        'delivers an unsequenced frame when append fails (pubsub=%s)',
        async (published) => {
            const { incr, publishMessage } = await import('$lib/server/cache/valkey.js');
            const session = await createSession(
                '36783d59-df31-55eb-8c63-8ab7869a529a',
                'Bob',
                'item-1',
                'movie',
                'Title',
            );
            expect(session).not.toBeNull();
            const local = vi.fn();
            const unregister = await registerSSEConnection(session!.code, 'guest', local);
            vi.mocked(incr).mockRejectedValueOnce(new Error('replay unavailable'));
            vi.mocked(publishMessage).mockResolvedValueOnce(published);
            expect(await broadcastReaction(session!.code, session!.hostUserId, '👏')).toBe(true);
            const sent = JSON.parse(vi.mocked(publishMessage).mock.lastCall![1]) as {
                event: unknown;
                seq?: number;
            };
            expect(sent.seq).toBeUndefined();
            expect(sent.event).toEqual(expect.objectContaining({ type: 'reaction', emoji: '👏' }));
            if (!published) expect(local).toHaveBeenCalledWith(sent.event, undefined);
            await unregister();
        },
    );
});
