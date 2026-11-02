// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Home's cluster tile as read by the status payload: the core and the unclean-exit
 * count race a timeout, a failing or silent read yields no tile rather than a calm
 * 0/0, and an unchanged core is not summarised twice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClusterCore } from './admin-cluster-core.service.js';

vi.mock('$lib/server/database/connection.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getAdminDb: () => ({}) as never,
}));

const { getClusterGlance, resetClusterGlanceForTests } =
    await import('./admin-status-payload.service');

const GiB = 1024 ** 3;
const GENERATED_AT = '2026-10-20T12:00:00.000Z';

function core(over: Partial<ClusterCore> = {}): ClusterCore {
    return {
        nodes: [
            {
                instanceId: 'gen-1',
                role: 'general',
                version: '0.1.0',
                hostname: 'gen-1-ctr',
                startedAt: '2026-10-20T11:00:00.000Z',
                uptimeSeconds: 3600,
                lastSeenAt: '2026-10-20T11:59:55.000Z',
                implementation: 'node',
                heartbeatAgeMs: 2_000,
                host: {
                    id: 'boot:a',
                    memTotalBytes: 16 * GiB,
                    memAvailableBytes: 8 * GiB,
                    cpuCount: 4,
                    load5: 0.5,
                },
            },
        ],
        sidecars: [],
        events: [],
        expected: { proxy: false },
        generatedAt: GENERATED_AT,
        totalOnline: 1,
        totalRegistered: 1,
        ...over,
    };
}

beforeEach(() => {
    resetClusterGlanceForTests();
});

describe('getClusterGlance', () => {
    it('a resolved core gives the glance, with unclean exits from the separate read', async () => {
        const glance = await getClusterGlance({
            readCore: async () => core(),
            readUncleanExits: async () => 3,
            timeoutMs: 1_000,
        });
        expect(glance).toBeDefined();
        expect(glance?.services).toEqual({ up: 1, expected: 1, late: 0 });
        expect(glance?.uncleanExits24h).toBe(3);
        expect(glance?.level).toBe('warn');
    });

    it('a core that never resolves gives undefined once the timeout passes', async () => {
        const glance = await getClusterGlance({
            readCore: () => new Promise<ClusterCore>(() => undefined),
            readUncleanExits: async () => 0,
            timeoutMs: 20,
        });
        expect(glance).toBeUndefined();
    });

    it('a core that rejects after the timeout gives undefined, with no unhandled rejection', async () => {
        const glance = await getClusterGlance({
            readCore: () =>
                new Promise<ClusterCore>((_resolve, reject) => {
                    setTimeout(() => reject(new Error('late failure')), 60);
                }),
            readUncleanExits: async () => 0,
            timeoutMs: 20,
        });
        expect(glance).toBeUndefined();
        // Let the late rejection happen inside this test; vitest fails a run that
        // leaves an unhandled rejection behind.
        await new Promise((resolve) => setTimeout(resolve, 120));
    });

    it('a core that rejects gives undefined, not a calm 0/0', async () => {
        const glance = await getClusterGlance({
            readCore: async () => {
                throw new Error('cache unreadable');
            },
            readUncleanExits: async () => 0,
            timeoutMs: 1_000,
        });
        expect(glance).toBeUndefined();
    });

    it('a core with no nodes gives undefined: "could not see the cluster", not 0/0', async () => {
        const glance = await getClusterGlance({
            readCore: async () => core({ nodes: [] }),
            readUncleanExits: async () => 0,
            timeoutMs: 1_000,
        });
        expect(glance).toBeUndefined();
    });

    it('the same core and unclean count give the identical object (memoised)', async () => {
        const deps = {
            readCore: async () => core(),
            readUncleanExits: async () => 1,
            timeoutMs: 1_000,
        };
        const first = await getClusterGlance(deps);
        const second = await getClusterGlance(deps);
        expect(first).toBeDefined();
        expect(second).toBe(first);
    });

    it('a new generatedAt recomputes the glance', async () => {
        const first = await getClusterGlance({
            readCore: async () => core(),
            readUncleanExits: async () => 0,
            timeoutMs: 1_000,
        });
        const second = await getClusterGlance({
            readCore: async () => core({ generatedAt: '2026-10-20T12:00:10.000Z' }),
            readUncleanExits: async () => 0,
            timeoutMs: 1_000,
        });
        expect(second).toBeDefined();
        expect(second).not.toBe(first);
    });

    it('the same core with a different unclean count recomputes the glance', async () => {
        const first = await getClusterGlance({
            readCore: async () => core(),
            readUncleanExits: async () => 0,
            timeoutMs: 1_000,
        });
        const second = await getClusterGlance({
            readCore: async () => core(),
            readUncleanExits: async () => 2,
            timeoutMs: 1_000,
        });
        expect(second).not.toBe(first);
        expect(second?.uncleanExits24h).toBe(2);
        expect(second?.level).toBe('warn');
    });
});
