// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the /metrics static-bearer-token comparison (security review
 * 2026-09-12, P2). The route used to compare the presented token with `===`;
 * every other secret compare in the tree uses `crypto.timingSafeEqual`
 * (webhook-dispatch.ts's secretMatches). These tests spy on
 * `node:crypto`'s `timingSafeEqual` to prove the route now goes through it,
 * rather than asserting only on the response status.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from './$types';

const REAL_TOKEN = 'super-secret-metrics-token';

const { mockMetricsRegistry, timingSafeEqualSpy } = vi.hoisted(() => {
    const body =
        '# HELP lumastra_task_runs_total Total task runs\n# TYPE lumastra_task_runs_total counter\nlumastra_task_runs_total{task="test"} 42\n';
    const type = 'text/plain; version=0.0.4; charset=utf-8';
    return {
        mockMetricsRegistry: {
            metrics: vi.fn().mockResolvedValue(body),
            contentType: type,
        },
        timingSafeEqualSpy: vi.fn(),
    };
});

vi.mock('$lib/server/tasks/metrics.js', () => ({
    tasksRegistry: mockMetricsRegistry,
}));

vi.mock('$lib/server/config.js', () => ({
    LUMASTRA_METRICS_BEARER_TOKEN: REAL_TOKEN,
    LUMASTRA_METRICS_PUBLIC: false,
}));

vi.mock('$lib/server/api/mount.js', () => ({
    enforce: vi.fn(async () => new Response('Unauthorized', { status: 401 })),
    scopeGranted: vi.fn(() => false),
}));

// Partial mock: keep the real crypto module (createHash etc.) but wrap
// timingSafeEqual so we can assert it was actually called — spying at the
// seam the route calls through, not the nearest wrapper function.
vi.mock('node:crypto', async () => {
    const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
    return {
        ...actual,
        default: {
            // `typeof import('node:crypto')` has no `default` in its type; the
            // runtime namespace is what the route's `import crypto from` sees.
            ...(actual as unknown as { default: Record<string, unknown> }).default,
            timingSafeEqual: (...args: Parameters<typeof actual.timingSafeEqual>) => {
                timingSafeEqualSpy(...args);
                return actual.timingSafeEqual(...args);
            },
        },
    };
});

describe('/metrics bearer token — constant-time comparison', () => {
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

    it('rejects a mismatched bearer token via timingSafeEqual, not ===', async () => {
        const { GET } = await import('./+server');
        const res = await GET(buildEvent({ authHeader: 'Bearer totally-wrong-token' }));

        expect(res.status).toBe(401);
        expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
    });

    it('accepts a matching bearer token, comparing it via timingSafeEqual', async () => {
        const { GET } = await import('./+server');
        const res = await GET(buildEvent({ authHeader: `Bearer ${REAL_TOKEN}` }));

        expect(res.status).toBe(200);
        expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
        expect(mockMetricsRegistry.metrics).toHaveBeenCalledTimes(1);
    });

    it('rejects a missing Authorization header without calling timingSafeEqual', async () => {
        const { GET } = await import('./+server');
        const res = await GET(buildEvent());

        expect(res.status).toBe(401);
        expect(timingSafeEqualSpy).not.toHaveBeenCalled();
    });
});
