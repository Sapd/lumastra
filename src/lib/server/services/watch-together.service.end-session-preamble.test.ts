// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Characterisation tests for the `endSession` / `endSessionAsSystem` shared
 * preamble (deferred item 14, 2026-09-13 security review).
 *
 * `endSession` and `endSessionAsSystem` used to duplicate the identical
 * connect-Valkey / ready-check / `getSession` scaffolding. Extracting it into
 * one `loadSessionForEnd()` helper must NOT change either function's
 * observable behaviour — these tests pin the two failure modes that
 * scaffolding is responsible for (Valkey not ready; session not found) for
 * BOTH entry points, so a future edit to the shared helper cannot silently
 * change one of them. Written to pass against the code BEFORE the extraction
 * as well as after (verified manually during implementation — see the
 * group-D report), matching the brief's characterisation-test requirement.
 *
 * Mocks at the Valkey cache boundary (same approach as
 * watch-together.service.end-session.test.ts / navigate-party.test.ts) with a
 * simple in-memory store, so `createSession`/`getSession`/`endSession`/
 * `endSessionAsSystem` all run their real logic against it. `isCoordinationValkeyReady`
 * is toggled per-test (not fixed to `true`, unlike the sibling host-only
 * test) so the "Valkey not ready" failure mode can be exercised directly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

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

const store = new Map<string, string>();
let valkeyReady = true;

vi.mock('$lib/server/cache/valkey.js', () => ({
    connectValkey: vi.fn(async () => {}),
    isCoordinationValkeyReady: vi.fn(() => valkeyReady),
    cacheGet: vi.fn(async (key: string) => store.get(key) ?? null),
    cacheExists: vi.fn(async (key: string) => store.has(key)),
    setEx: vi.fn(async (key: string, _ttl: number, value: string) => {
        store.set(key, value);
    }),
    setIfNotExists: vi.fn(async (key: string, value: string) => {
        if (store.has(key)) return false;
        store.set(key, value);
        return true;
    }),
    expire: vi.fn(async () => {}),
    incr: vi.fn(async () => 1),
    lPush: vi.fn(async () => 1),
    lTrim: vi.fn(async () => {}),
    lRange: vi.fn(async () => []),
    sAdd: vi.fn(async () => 1),
    sCard: vi.fn(async () => 0),
    sRem: vi.fn(async () => 1),
    hSet: vi.fn(async () => {}),
    hGet: vi.fn(async () => null),
    hGetAll: vi.fn(async () => ({})),
    hDel: vi.fn(async () => {}),
    del: vi.fn(async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    }),
    getKeysByPattern: vi.fn(async () => []),
    getCoordinationClient: vi.fn(() => null),
    publishMessage: vi.fn(async () => false),
    subscribeToChannel: vi.fn(async () => {}),
}));

const { createSession, getSession, endSession, endSessionAsSystem } =
    await import('./watch-together.service.js');

describe('endSession / endSessionAsSystem — shared preamble failure modes (deferred item 14)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        store.clear();
        valkeyReady = true;
    });

    describe('Valkey not ready', () => {
        it('endSession returns false and leaves the session untouched', async () => {
            const session = await createSession(
                '36783d59-df31-55eb-8c63-8ab7869a529a',
                'Bob',
                'item-1',
                'movie',
                'Session 1',
            );
            const code = session!.code;

            valkeyReady = false;
            const result = await endSession(code, '36783d59-df31-55eb-8c63-8ab7869a529a');
            expect(result).toBe(false);

            // Prove nothing was mutated: flip Valkey back "ready" and confirm
            // the session is still exactly there.
            valkeyReady = true;
            expect(await getSession(code)).not.toBeNull();
        });

        it('endSessionAsSystem returns false the same way', async () => {
            const session = await createSession(
                '36783d59-df31-55eb-8c63-8ab7869a529a',
                'Bob',
                'item-2',
                'movie',
                'Session 2',
            );
            const code = session!.code;

            valkeyReady = false;
            const result = await endSessionAsSystem(code);
            expect(result).toBe(false);

            valkeyReady = true;
            expect(await getSession(code)).not.toBeNull();
        });
    });

    describe('session not found ("already gone")', () => {
        it('endSession returns true for a code with no session', async () => {
            const result = await endSession('NOSESH1', '36783d59-df31-55eb-8c63-8ab7869a529a');
            expect(result).toBe(true);
        });

        it('endSessionAsSystem returns true for a code with no session', async () => {
            const result = await endSessionAsSystem('NOSESH2');
            expect(result).toBe(true);
        });
    });
});
