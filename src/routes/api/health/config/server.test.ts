// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test for GET /api/health/config. The route's whole point is to apply
 * `toConfigHealthView` to the doctor report before returning it — a refactor
 * that reverted to returning `report.issues` directly would pass every
 * existing config-doctor / config-health-view unit test while breaking this
 * endpoint. `toConfigHealthView` is exercised for REAL here (not mocked) so
 * this test actually proves the filtering happens over HTTP: `issues` must
 * exclude `embedding.no-provider` while keeping every other issue.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DoctorReport } from '$lib/server/preflight/config-doctor.js';

const { mockRunConfigDoctor, mockRunConfigDoctorWithDb, mockGetDb, mockPresence } = vi.hoisted(
    () => ({
        mockRunConfigDoctor: vi.fn(),
        mockRunConfigDoctorWithDb: vi.fn(),
        mockGetDb: vi.fn(),
        mockPresence: vi.fn(() => ({ status: 'present', workers: 1, checkedAt: null })),
    }),
);
vi.mock('$lib/server/services/worker-presence.service.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/services/worker-presence.service.js')>()),
    workerPresence: { get: () => mockPresence() },
}));

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAdmin: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/utils/typed-response.js', () => ({
    typedJson: (_schema: unknown, data: unknown) =>
        new Response(JSON.stringify(data), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }),
}));
vi.mock('$lib/server/preflight/config-doctor.js', () => ({
    runConfigDoctor: (...a: unknown[]) => mockRunConfigDoctor(...a),
    runConfigDoctorWithDb: (...a: unknown[]) => mockRunConfigDoctorWithDb(...a),
}));
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => mockGetDb(),
}));

const RESOLVED_EMBEDDING: DoctorReport['resolved']['embedding'] = {
    provider: 'voyage',
    model: 'voyage-3.5',
    spec: null,
    dimensions: 1024,
    dimensionSource: 'provider-default',
    modelSource: 'provider-default',
    hasProvider: false,
};

function report(issues: DoctorReport['issues']): DoctorReport {
    const errorCount = issues.filter((i) => i.severity === 'error').length;
    return {
        ok: errorCount === 0,
        errorCount,
        warningCount: issues.length - errorCount,
        issues,
        resolved: { embedding: RESOLVED_EMBEDDING },
    };
}

describe('GET /api/health/config', () => {
    beforeEach(() => vi.clearAllMocks());

    it('applies toConfigHealthView: drops embedding.no-provider, keeps other issues', async () => {
        mockGetDb.mockReturnValue(null);
        mockRunConfigDoctor.mockReturnValue(
            report([
                {
                    category: 'embedding',
                    severity: 'warning',
                    code: 'embedding.no-provider',
                    message: 'No embedding provider configured',
                },
                {
                    category: 'forward-auth',
                    severity: 'warning',
                    code: 'forward-auth.trust-any',
                    message: 'LUMASTRA_TRUST_ANY_PROXY=true trusts identity headers from any peer',
                },
            ]),
        );

        const { GET } = await import('./+server.js');
        const res = await (GET as (event: unknown) => Promise<Response>)({});
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.issues.map((i: { code: string }) => i.code)).toEqual([
            'forward-auth.trust-any',
        ]);
        expect(body.warningCount).toBe(1);
        expect(body.embedding.hasProvider).toBe(false);
    });

    it('uses the env-only doctor when no DB handle is available', async () => {
        mockGetDb.mockReturnValue(null);
        mockRunConfigDoctor.mockReturnValue(report([]));

        const { GET } = await import('./+server.js');
        await (GET as (event: unknown) => Promise<Response>)({});

        expect(mockRunConfigDoctor).toHaveBeenCalled();
        expect(mockRunConfigDoctorWithDb).not.toHaveBeenCalled();
    });

    it('uses the DB-aware doctor when a DB handle is available', async () => {
        const sql = { fake: 'sql' };
        mockGetDb.mockReturnValue(sql);
        mockRunConfigDoctorWithDb.mockResolvedValue(report([]));

        const { GET } = await import('./+server.js');
        await (GET as (event: unknown) => Promise<Response>)({});

        expect(mockRunConfigDoctorWithDb).toHaveBeenCalledWith(sql);
        expect(mockRunConfigDoctor).not.toHaveBeenCalled();
    });

    it('adds an undismissable runtime error when no worker heartbeats (upgrade without the worker)', async () => {
        mockGetDb.mockReturnValue(null);
        mockRunConfigDoctor.mockReturnValue(report([]));
        mockPresence.mockReturnValueOnce({ status: 'missing', workers: 0, checkedAt: null });

        const { GET } = await import('./+server.js');
        const res = await (GET as (event: unknown) => Promise<Response>)({});
        const body = await res.json();

        expect(body.ok).toBe(false);
        expect(body.errorCount).toBe(1);
        expect(body.issues[0]).toMatchObject({
            code: 'runtime.worker-missing',
            severity: 'error',
        });
        expect(body.issues[0].remediation).toContain('start-worker.sh');
    });

    it('reports nothing about the worker while it is present or still unknown', async () => {
        mockGetDb.mockReturnValue(null);
        mockRunConfigDoctor.mockReturnValue(report([]));
        mockPresence.mockReturnValueOnce({ status: 'unknown', workers: 0, checkedAt: null });

        const { GET } = await import('./+server.js');
        const res = await (GET as (event: unknown) => Promise<Response>)({});
        const body = await res.json();

        expect(body.ok).toBe(true);
        expect(body.issues).toEqual([]);
    });
});
