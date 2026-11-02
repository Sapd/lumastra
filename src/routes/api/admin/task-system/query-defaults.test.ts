// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Missing numeric query params take the documented default. Number(null) is 0,
 * which used to clamp an absent `limit`/`sinceHours` to the minimum (1) — the
 * in-app pages always pass them, so only API callers saw near-empty results.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/api/mount.js', () => ({
    mount: (def: { handlers: Record<string, unknown> }) => def.handlers,
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));

const listSnapshots = vi.fn(async (_sql: unknown, _opts: unknown) => []);
vi.mock('$lib/server/database/queries/task-metrics-snapshot.queries.js', () => ({
    listSnapshots,
}));
const getSystemicFailures = vi.fn(async (_sql: unknown, _opts: unknown) => ({}));
vi.mock('$lib/server/tasks/observability/systemic.service.js', () => ({ getSystemicFailures }));
const getFailurePatterns = vi.fn(async (_sql: unknown, _opts: unknown) => []);
vi.mock('$lib/server/tasks/observability/failure-patterns.service.js', () => ({
    getFailurePatterns,
}));
const listAuditFeed = vi.fn(async (_sql: unknown, _opts: unknown) => ({
    events: [],
    nextCursor: null,
}));
vi.mock('$lib/server/database/queries/observability.queries.js', () => ({ listAuditFeed }));

vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: { getStalledCounts: vi.fn(async () => ({})) },
}));

type Get = (event: unknown) => Promise<Response>;
const event = (path: string) => ({ url: new URL(`http://localhost${path}`) });

beforeEach(() => vi.clearAllMocks());

describe('task-system routes — missing numeric params', () => {
    it('trends: default 168 h window', async () => {
        const { GET } = (await import('./trends/+server.js')) as unknown as { GET: Get };
        await GET(event('/api/admin/task-system/trends'));
        expect(listSnapshots).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ sinceHours: 168 }),
        );
    });

    it('systemic: default 24 h window', async () => {
        const { GET } = (await import('./systemic/+server.js')) as unknown as { GET: Get };
        await GET(event('/api/admin/task-system/systemic'));
        expect(getSystemicFailures).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ sinceHours: 24 }),
        );
    });

    it('failure patterns: default window and limit; explicit values still clamp', async () => {
        const { GET } = (await import('./failures/patterns/+server.js')) as unknown as { GET: Get };
        await GET(event('/api/admin/task-system/failures/patterns'));
        const opts = getFailurePatterns.mock.calls[0][1] as { sinceHours: number; limit: number };
        expect(opts.sinceHours).toBe(24);
        expect(opts.limit).toBeGreaterThan(1);

        await GET(event('/api/admin/task-system/failures/patterns?sinceHours=0'));
        expect((getFailurePatterns.mock.calls[1][1] as { sinceHours: number }).sinceHours).toBe(1);
    });

    it('audit: default page size, no cursor', async () => {
        const { GET } = (await import('./audit/+server.js')) as unknown as { GET: Get };
        await GET(event('/api/admin/task-system/audit'));
        const opts = listAuditFeed.mock.calls[0][1] as { limit: number; before?: number };
        expect(opts.limit).toBe(50);
        expect(opts.before).toBeUndefined();
    });
});
