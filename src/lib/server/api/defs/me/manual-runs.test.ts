// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const listMyManualRuns = vi.hoisted(() => vi.fn());
const loadRunLibraryNames = vi.hoisted(() => vi.fn());
const getRun = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/database/queries/my-manual-runs.queries.js', () => ({
    listMyManualRuns,
    loadRunLibraryNames,
}));
vi.mock('$lib/server/database/connection.js', () => ({ getTaskDb: () => ({}) }));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({ orchestrator: { getRun } }));
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: {
        getTask: (id: string) =>
            id === 'file-library-scan' ? { name: 'File Library Scan' } : undefined,
    },
}));
vi.mock('$lib/server/api/defs/runs/index.js', () => ({
    resolveRunMediaItems: async () => new Map([['m1', { id: 'm1', title: 'Awakening' }]]),
}));
vi.mock('$lib/server/utils/scope-gated-access-boundary.js', () => ({
    resolveScopeGatedAccessBoundary: async () => ({}),
}));

const { def } = await import('./manual-runs.js');

const PATH = '11111111-1111-4111-8111-111111111111';

function event(query = ''): RequestEvent {
    const url = new URL(`http://localhost/api/me/manual-runs${query}`);
    return {
        url,
        locals: { user: { userId: 'uid-1', username: 'Denis' } },
        request: new Request(url),
    } as unknown as RequestEvent;
}

const row = (over: Record<string, unknown>) => ({
    id: 'r1',
    task_id: 'file-library-scan',
    parent_run_id: null,
    label: 'scan',
    state: 'active',
    scope: null,
    input: {},
    started_at: new Date('2026-09-23T12:00:00Z'),
    completed_at: null,
    error: null,
    stages: [],
    ...over,
});

describe('GET /api/me/manual-runs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        loadRunLibraryNames.mockResolvedValue({
            groups: new Map(),
            paths: new Map([[PATH, 'Kids']]),
        });
    });

    it("asks only for the caller's own identities, and never further back than 24h", async () => {
        listMyManualRuns.mockResolvedValue([]);
        const before = Date.now();
        await def.handlers.GET!(event('?since=2020-01-01T00:00:00Z'), {} as never);

        const [, identities, since] = listMyManualRuns.mock.calls[0];
        expect(identities).toEqual(['uid-1', 'Denis']);
        expect((since as Date).getTime()).toBeGreaterThanOrEqual(before - 24 * 3600_000 - 1000);
    });

    it('names runs and merges LIVE progress for active ones', async () => {
        listMyManualRuns.mockResolvedValue([
            row({ id: 'scan', input: { libraryPathId: PATH } }),
            row({
                id: 'sync',
                task_id: 'acme-plugin-sync',
                state: 'failed',
                scope: { subjectId: 'm1' },
                completed_at: new Date('2026-09-23T12:05:00Z'),
                error: { message: 'TMDB 503' },
            }),
        ]);
        getRun.mockResolvedValue({
            state: 'active',
            stages: [{ id: 's', state: 'active', processed: 40, total: 160 }],
        });

        const res = await def.handlers.GET!(event(), {} as never);
        const body = await res.json();
        expect(body.runs).toEqual([
            expect.objectContaining({
                id: 'scan',
                title: 'Scan Media Library',
                detail: 'Kids',
                state: 'active',
                processed: 40,
                total: 160,
            }),
            expect.objectContaining({
                id: 'sync',
                title: 'scan', // unregistered task: the run's own label
                detail: 'Awakening',
                state: 'failed',
                error: 'TMDB 503',
            }),
        ]);
        expect(getRun).toHaveBeenCalledTimes(1); // only the live run
        expect(typeof body.serverTime).toBe('string');
    });
});
