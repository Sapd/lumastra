// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Repro test for F31 — /metrics endpoint unauthenticated by default.
 *
 * Finding: When LUMASTRA_METRICS_BEARER_TOKEN is empty (the default), the
 * metrics route performs no authentication and returns Prometheus-formatted
 * operational intelligence to any caller.
 *
 * Citation: src/routes/metrics/+server.ts:5-11, src/lib/server/config.ts:3360
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from './$types';

const { mockMetricsRegistry } = vi.hoisted(() => {
    const body =
        '# HELP lumastra_task_runs_total Total task runs\n# TYPE lumastra_task_runs_total counter\nlumastra_task_runs_total{task="test"} 42\n';
    const type = 'text/plain; version=0.0.4; charset=utf-8';
    return {
        mockMetricsRegistry: {
            metrics: vi.fn().mockResolvedValue(body),
            contentType: type,
        },
    };
});

vi.mock('$lib/server/tasks/metrics.js', () => ({
    tasksRegistry: mockMetricsRegistry,
}));

// Simulate empty bearer token and no public opt-out (production default).
vi.mock('$lib/server/config.js', () => ({
    LUMASTRA_METRICS_BEARER_TOKEN: '',
    LUMASTRA_METRICS_PUBLIC: false,
}));

// Mock mount.js so that Path 3 (PAT/svc-token scope check) returns 401 without
// loading the full module graph (catalog.service → plugin-context → registry).
// The repro test exercises Path 3 (no static token → scope check → deny) and
// verifies the endpoint correctly rejects unauthenticated callers.
vi.mock('$lib/server/api/mount.js', () => ({
    enforce: vi.fn(async () => new Response('Unauthorized', { status: 401 })),
    scopeGranted: vi.fn(() => false),
}));

describe('F31 — /metrics authentication gap', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    function buildEvent(opts?: { authHeader?: string }): RequestEvent {
        return {
            url: new URL('http://localhost/metrics'),
            request: {
                method: 'GET',
                headers: {
                    get: (name: string) => {
                        if (name.toLowerCase() === 'authorization') {
                            return opts?.authHeader ?? null;
                        }
                        return null;
                    },
                },
            },
            locals: {},
            params: {},
            route: { id: null },
            cookies: {} as never,
            fetch,
            getClientAddress: () => '192.168.1.100',
            platform: undefined,
            isDataRequest: false,
            isSubRequest: false,
            setHeaders: () => undefined,
            depends: () => undefined,
            untrack: <T>(fn: () => T) => fn(),
        } as unknown as RequestEvent;
    }

    it('returns 401 UNAUTHORIZED when no bearer token is configured (default)', async () => {
        const { GET } = await import('./+server');
        const res = await GET(buildEvent());

        // CORRECT behavior: metrics should require auth by default.
        // BUG: Currently returns 200 without any auth check.
        expect(res.status).toBe(401);
    });

    it('returns 401 UNAUTHORIZED with a bogus Authorization header', async () => {
        const { GET } = await import('./+server');
        const res = await GET(buildEvent({ authHeader: 'Bearer totally-fake-token' }));

        // CORRECT behavior: should reject invalid tokens.
        // BUG: Currently returns 200.
        expect(res.status).toBe(401);
    });
});
