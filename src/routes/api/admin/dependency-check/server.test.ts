// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test for GET /api/admin/dependency-check — the admin health-page dependency
 * report. Verifies it passes the DB handle through to runDependencyChecks (so
 * media-path checks run) and returns the findings under `checks`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRun, mockGetSql } = vi.hoisted(() => ({ mockRun: vi.fn(), mockGetSql: vi.fn() }));

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAdmin: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...a: unknown[]) => mockGetSql(...a) },
}));
vi.mock('$lib/server/preflight/dependency-checks.js', () => ({
    runDependencyChecks: (...a: unknown[]) => mockRun(...a),
}));

describe('GET /api/admin/dependency-check', () => {
    beforeEach(() => vi.clearAllMocks());

    it('passes the sql handle to runDependencyChecks and returns checks', async () => {
        const sql = { fake: 'sql' };
        mockGetSql.mockResolvedValue(sql);
        mockRun.mockResolvedValue([
            { id: 'config-dir', name: 'Config directory', status: 'pass', url: '/config' },
            { id: 'media-paths-ok', name: 'Media libraries', status: 'pass', count: 3 },
        ]);

        const { GET } = await import('./+server.js');
        const res = await (GET as (event: unknown) => Promise<Response>)({});
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(mockRun).toHaveBeenCalledWith(sql);
        expect(body.checks).toHaveLength(2);
        expect(body.checks[1]).toMatchObject({ id: 'media-paths-ok', count: 3 });
    });

    it('passes undefined when the DB handle is unavailable', async () => {
        mockGetSql.mockResolvedValue(null);
        mockRun.mockResolvedValue([]);

        const { GET } = await import('./+server.js');
        await (GET as (event: unknown) => Promise<Response>)({});

        expect(mockRun).toHaveBeenCalledWith(undefined);
    });
});
