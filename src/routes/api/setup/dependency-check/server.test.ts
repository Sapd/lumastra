// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test for GET /api/setup/dependency-check — verifies it is admin-gated and
 * returns the dependency findings under a `checks` key. The check runner is mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRun } = vi.hoisted(() => ({ mockRun: vi.fn() }));

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAdmin: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/preflight/dependency-checks.js', () => ({
    runDependencyChecks: (...a: unknown[]) => mockRun(...a),
}));

describe('GET /api/setup/dependency-check', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns the dependency findings under checks', async () => {
        mockRun.mockResolvedValue([
            { id: 'config-dir', name: 'Config directory', status: 'pass', url: '/config' },
            { id: 'sonic-embedder', name: 'Music embedder', status: 'warn', url: 'http://x:8000' },
        ]);

        const { GET } = await import('./+server.js');
        const res = await (GET as (event: unknown) => Promise<Response>)({});
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.checks).toHaveLength(2);
        expect(body.checks[1]).toMatchObject({ id: 'sonic-embedder', status: 'warn' });
    });

    it('returns an empty list when nothing is configured', async () => {
        mockRun.mockResolvedValue([]);

        const { GET } = await import('./+server.js');
        const res = await (GET as (event: unknown) => Promise<Response>)({});
        const body = await res.json();

        expect(body.checks).toEqual([]);
    });
});
