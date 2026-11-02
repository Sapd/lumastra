// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for GET /api/health/ready (H22).
 *
 * `leader` must be excluded from the readiness gate — a non-leader replica
 * (follower) never holds a leader lock for any resource class, so gating on
 * it would keep the replica permanently unready. `leader` must still be
 * present in the returned `checks` detail object for admin visibility.
 *
 * Run: npx vitest run src/routes/api/health/ready/server.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => null),
}));

vi.mock('$lib/server/cache/valkey.js', () => ({
    // The TASK (coordination) client gates readiness; the cache is informational.
    getCoordinationClient: vi.fn(() => null),
    isCacheValkeyConfigured: vi.fn(() => true),
    getValkeyClient: vi.fn(() => ({})),
    // The route calls this when the client is null, to drive the reconnect a
    // never-ready pod would otherwise never get (see the route's comment).
    connectValkey: vi.fn(async () => false),
}));

vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    getOrchestrator: vi.fn(async () => ({
        isHealthy: () => true,
        isLeaderForAnyClass: () => true,
    })),
}));

vi.mock('$lib/server/services/worker-presence.service.js', () => ({
    workerPresence: { get: vi.fn(() => ({ status: 'present', workers: 1, checkedAt: null })) },
}));

vi.mock('$lib/server/api/mount.js', () => ({
    enforce: vi.fn(async () => null),
}));

import { getDb } from '$lib/server/database/connection.js';
import {
    connectValkey,
    getCoordinationClient as getValkeyClient,
    isCacheValkeyConfigured,
    getValkeyClient as getCacheClient,
} from '$lib/server/cache/valkey.js';
import { workerPresence } from '$lib/server/services/worker-presence.service.js';
import { getOrchestrator } from '$lib/server/tasks/orchestrator.js';
import { _resetReadinessCache, GET } from './+server.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function healthySql(): Sql {
    const sqlFn = vi.fn().mockResolvedValue([{ '?column?': 1 }]);
    return sqlFn as unknown as Sql;
}

function healthyValkeyClient(): ReturnType<typeof getValkeyClient> {
    return {
        customCommand: vi.fn().mockResolvedValue('PONG'),
    } as unknown as ReturnType<typeof getValkeyClient>;
}

function adminEvent(): Parameters<typeof import('./+server.js').GET>[0] {
    return {
        locals: { user: { ownerIsAdmin: true } },
    } as unknown as Parameters<typeof import('./+server.js').GET>[0];
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/health/ready', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // The route memoizes its checks for 1s to blunt anonymous floods. These
        // cases run well inside that window with different mocks, so without a
        // reset each would read the previous case's verdict and pass or fail for
        // reasons that have nothing to do with what it set up.
        _resetReadinessCache();
    });

    it('a follower (isLeaderForAnyClass=false) with healthy db+valkey+orchestrator returns 200', async () => {
        vi.mocked(getDb).mockReturnValue(healthySql());
        vi.mocked(getValkeyClient).mockReturnValue(healthyValkeyClient());
        vi.mocked(getOrchestrator).mockResolvedValue({
            isHealthy: () => true,
            isLeaderForAnyClass: () => false,
        } as unknown as Awaited<ReturnType<typeof getOrchestrator>>);

        const { GET } = await import('./+server.js');
        const resp = await GET(adminEvent());

        expect(resp.status).toBe(200);
        const body = JSON.parse(await resp.text()) as {
            status: string;
            checks: Record<string, boolean>;
        };
        expect(body.status).toBe('pass');
        // leader stays visible in the detail object even though it's excluded
        // from the pass/fail gate.
        expect(body.checks.leader).toBe(false);
        expect(body.checks.orchestrator).toBe(true);
        expect(body.checks.database).toBe(true);
        expect(body.checks.valkey).toBe(true);
    });

    it('a node with unhealthy db returns 503 even when leader is true', async () => {
        vi.mocked(getDb).mockReturnValue(null);
        vi.mocked(getValkeyClient).mockReturnValue(healthyValkeyClient());
        vi.mocked(getOrchestrator).mockResolvedValue({
            isHealthy: () => true,
            isLeaderForAnyClass: () => true,
        } as unknown as Awaited<ReturnType<typeof getOrchestrator>>);

        const { GET } = await import('./+server.js');
        const resp = await GET(adminEvent());

        expect(resp.status).toBe(503);
        const body = JSON.parse(await resp.text()) as {
            status: string;
            checks: Record<string, boolean>;
        };
        expect(body.status).toBe('fail');
        expect(body.checks.database).toBe(false);
        expect(body.checks.leader).toBe(true);
    });
});

describe('GET /api/health/ready — Valkey reconnect', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _resetReadinessCache();
    });

    it('asks connectValkey() to reconnect when the client is null', async () => {
        // The latch this prevents: a pod that boots while Valkey is down holds a
        // null client. Every other connectValkey() caller runs while serving a
        // request, and an unready pod is sent none — so if the probe does not
        // retry, readiness never recovers while liveness stays green.
        vi.mocked(getDb).mockReturnValue(healthySql());
        vi.mocked(getValkeyClient).mockReturnValue(null);
        vi.mocked(connectValkey).mockResolvedValue(false);

        const { GET } = await import('./+server.js');
        const resp = await GET(adminEvent());

        expect(connectValkey).toHaveBeenCalledTimes(1);
        expect(resp.status).toBe(503);
    });

    it('passes once the reconnect yields a working client', async () => {
        vi.mocked(getDb).mockReturnValue(healthySql());
        // Null on the first look, connected after connectValkey() resolves.
        vi.mocked(getValkeyClient).mockReturnValueOnce(null).mockReturnValue(healthyValkeyClient());
        vi.mocked(connectValkey).mockResolvedValue(true);

        const { GET } = await import('./+server.js');
        const resp = await GET(adminEvent());

        expect(connectValkey).toHaveBeenCalledTimes(1);
        expect(resp.status).toBe(200);
        const body = JSON.parse(await resp.text()) as { checks: Record<string, boolean> };
        expect(body.checks.valkey).toBe(true);
    });

    it('does not call connectValkey() when a client is already present', async () => {
        vi.mocked(getDb).mockReturnValue(healthySql());
        vi.mocked(getValkeyClient).mockReturnValue(healthyValkeyClient());

        const { GET } = await import('./+server.js');
        await GET(adminEvent());

        expect(connectValkey).not.toHaveBeenCalled();
    });
});

describe('GET /api/health/ready — anonymous flood does not multiply backend work', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _resetReadinessCache();
    });

    it('collapses CONCURRENT requests onto one dependency check', async () => {
        // Pins the in-flight memo: three requests arriving while the first check
        // is still running share it. Without it, each unauthenticated request
        // takes its own slot from the 8-slot pool.
        const sql = healthySql();
        vi.mocked(getDb).mockReturnValue(sql);
        vi.mocked(getValkeyClient).mockReturnValue(healthyValkeyClient());

        const { GET } = await import('./+server.js');
        const responses = await Promise.all([
            GET(adminEvent()),
            GET(adminEvent()),
            GET(adminEvent()),
        ]);

        for (const resp of responses) expect(resp.status).toBe(200);
        expect(sql).toHaveBeenCalledTimes(1);
    });

    it('reuses the result for a SEQUENTIAL request inside the TTL window', async () => {
        // Pins the time-based half, which the concurrent case above cannot: these
        // calls are awaited one after the other, so the in-flight memo is already
        // cleared and only the TTL can prevent a second round-trip.
        const sql = healthySql();
        vi.mocked(getDb).mockReturnValue(sql);
        vi.mocked(getValkeyClient).mockReturnValue(healthyValkeyClient());

        const { GET } = await import('./+server.js');
        await GET(adminEvent());
        await GET(adminEvent());

        expect(sql).toHaveBeenCalledTimes(1);
    });

    describe('two Valkeys: the cache never gates readiness', () => {
        async function readiness(): Promise<{ status: number; body: Record<string, unknown> }> {
            const res = await GET(adminEvent());
            return { status: res.status, body: (await res.json()) as Record<string, unknown> };
        }

        beforeEach(() => {
            vi.mocked(getDb).mockReturnValue(healthySql());
            vi.mocked(getValkeyClient).mockReturnValue(healthyValkeyClient());
            vi.mocked(isCacheValkeyConfigured).mockReturnValue(true);
            vi.mocked(getCacheClient).mockReturnValue(
                {} as unknown as ReturnType<typeof getCacheClient>,
            );
        });

        it('both Valkeys up: 200, cache ok', async () => {
            const { status, body } = await readiness();
            expect(status).toBe(200);
            expect(body.checks).toMatchObject({ valkey: true, cache: 'ok' });
        });

        it('cache down: still 200, cache reported down', async () => {
            vi.mocked(getCacheClient).mockReturnValue(null);
            const { status, body } = await readiness();
            expect(status).toBe(200);
            expect(body.checks).toMatchObject({ valkey: true, cache: 'down' });
        });

        it('CACHE_URL unset: 200 (not permanently 503), cache disabled', async () => {
            vi.mocked(isCacheValkeyConfigured).mockReturnValue(false);
            const { status, body } = await readiness();
            expect(status).toBe(200);
            expect(body.checks).toMatchObject({ valkey: true, cache: 'disabled' });
            expect(getCacheClient).not.toHaveBeenCalled();
        });

        it('task Valkey down: 503 even with a healthy cache', async () => {
            vi.mocked(getValkeyClient).mockReturnValue(null);
            vi.mocked(connectValkey).mockResolvedValue(false);
            const { status, body } = await readiness();
            expect(status).toBe(503);
            expect(body.checks).toMatchObject({ valkey: false, cache: 'ok' });
        });

        it('no worker heartbeat: reported in the detail, does not gate', async () => {
            vi.mocked(workerPresence.get).mockReturnValueOnce({
                status: 'missing',
                workers: 0,
                checkedAt: null,
            });
            const { status, body } = await readiness();
            expect(status).toBe(200);
            expect(body.checks).toMatchObject({ worker: 'missing' });
        });
    });
});

describe('GET /api/health/ready — shutdown', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _resetReadinessCache();
    });

    it('answers 503 as soon as shutdown began, without running a check', async () => {
        vi.mocked(getDb).mockReturnValue(healthySql());
        vi.mocked(getValkeyClient).mockReturnValue(healthyValkeyClient());
        const shutdown = await import('$lib/server/lifecycle/web-shutdown.js');
        const begin = shutdown.createWebShutdown({
            drainTimeoutMs: 60_000,
            services: [],
            pools: [],
            exit: () => undefined,
            log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        });
        // An in-flight request keeps the drain open, so the phase stays 'draining'.
        const gate = shutdown.createShutdownGateHandle({});
        let finish: (r: Response) => void = () => undefined;
        const inFlight = gate({
            event: { url: new URL('http://x/api/play-sessions') },
            resolve: () => new Promise<Response>((r) => (finish = r)),
        } as unknown as Parameters<typeof gate>[0]);
        try {
            void begin('SIGTERM');
            const resp = await GET(adminEvent());
            expect(resp.status).toBe(503);
            expect(JSON.parse(await resp.text())).toEqual({
                status: 'fail',
                reason: 'shutting_down',
            });
            expect(getOrchestrator).not.toHaveBeenCalled();
        } finally {
            finish(new Response('ok'));
            await inFlight;
            shutdown._resetWebShutdownForTests();
        }
    });
});
