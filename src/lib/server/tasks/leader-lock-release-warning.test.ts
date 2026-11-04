// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('$lib/server/utils/logger.js', () => ({ Logger: { for: () => log } }));
// The real fence wraps every script in a hash-addressed EVALSHA; the fake speaks plain commands.
vi.mock('./lua/fenced.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./lua/fenced.js')>();
    return {
        ...actual,
        invokeFencedValkey: async (
            source: string,
            keys: string[],
            args: (string | number)[],
            client: ValkeyLike,
        ): Promise<unknown> => {
            const argv = args.map(String);
            if (source.includes("return redis.call('SET'"))
                return client.customCommand(['SET', keys[0], argv[0], 'NX', 'PX', argv[1]]);
            return client.customCommand(['EVAL', source, String(keys.length), ...keys, ...argv]);
        },
    };
});
vi.mock('./observability/audit-log.js', () => ({ appendAuditEvent: vi.fn() }));

import { LeaderLock, __resetLeaderLockReleaseWarningForTests } from './leader-lock.js';
import type { ValkeyLike } from './valkey-types.js';

/** A Valkey that took the lock and then went away. */
function goneValkey(): ValkeyLike & { up: boolean } {
    const client = {
        up: true,
        store: new Map<string, string>(),
        async customCommand(cmd: string[]): Promise<unknown> {
            if (!client.up) throw new Error('connect ECONNREFUSED 10.0.0.2:6379');
            if (cmd[0] === 'SET') {
                client.store.set(cmd[1], cmd[2]);
                return 'OK';
            }
            if (cmd[0] === 'EVAL') {
                client.store.delete(cmd[3]);
                return 1;
            }
            return null;
        },
    };
    return client as unknown as ValkeyLike & { up: boolean };
}

describe('LeaderLock release failures', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        __resetLeaderLockReleaseWarningForTests();
        log.warn.mockReset();
        log.debug.mockReset();
    });
    afterEach(() => vi.useRealTimers());

    const failedReleases = async (client: ReturnType<typeof goneValkey>, count: number) => {
        for (let i = 0; i < count; i++) {
            const lock = new LeaderLock(client, `lock:orch:c${i}`, `holder-${i}`, 5_000, 2_000);
            client.up = true;
            await lock.acquire();
            client.up = false;
            await lock.release();
        }
    };
    const releaseWarnings = (): unknown[][] =>
        log.warn.mock.calls.filter((c) => c[0] === 'LeaderLock release failed');

    it('warns once for the many locks one outage fails to release', async () => {
        await failedReleases(goneValkey(), 9);
        expect(releaseWarnings()).toHaveLength(1);
    });

    it('warns again for the next outage, once its window has passed', async () => {
        const client = goneValkey();
        await failedReleases(client, 3);
        await vi.advanceTimersByTimeAsync(31_000);
        await failedReleases(client, 3);
        expect(releaseWarnings()).toHaveLength(2);
    });

    it('warns again after a release worked in between', async () => {
        const client = goneValkey();
        await failedReleases(client, 2);
        const lock = new LeaderLock(client, 'lock:orch:ok', 'holder-ok', 5_000, 2_000);
        client.up = true;
        await lock.acquire();
        await lock.release();
        await failedReleases(client, 2);
        expect(releaseWarnings()).toHaveLength(2);
    });
});
