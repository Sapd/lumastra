// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { RunListResponseSchema } from '$lib/schemas/run.schema.js';

const { listRuns, grouped, getTaskDb } = vi.hoisted(() => ({
    listRuns: vi.fn(),
    grouped: vi.fn(),
    getTaskDb: vi.fn(),
}));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({ orchestrator: { listRuns } }));
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { getTask: () => ({ name: 'Test task' }) },
}));
vi.mock('$lib/server/database/connection.js', () => ({ getTaskDb }));
vi.mock('$lib/server/database/queries/runs-grouped.queries.js', () => ({
    listRunsGrouped: grouped,
}));
vi.mock('$lib/server/utils/scope-gated-access-boundary.js', () => ({
    resolveScopeGatedAccessBoundary: vi.fn().mockResolvedValue({}),
}));

const run = {
    id: 'run-1',
    taskId: 'test-task',
    label: 'Test',
    state: 'failed',
    input: {},
    trigger: { kind: 'manual' },
    startedAt: '2026-10-16T10:00:00.000Z',
    stages: [],
    actor: { type: 'system' },
    error: { message: 'failed', kind: 'transient', stack: '/private/path' },
};
const group = {
    taskId: 'test-task',
    count: 301,
    stateCounts: { pending: 0, active: 1, cancelling: 0, completed: 299, failed: 1, cancelled: 0 },
    latestRun: { id: run.id, state: run.state, startedAt: run.startedAt },
    oldestActiveAt: '2026-10-15T10:00:00.000Z',
};

function event(path: string, scopes = ['runs:read']): RequestEvent {
    const url = new URL(`http://localhost${path}`);
    return {
        url,
        request: new Request(url),
        params: {},
        route: { id: null },
        locals: {
            principal: {
                kind: 'session',
                userId: 'u1',
                username: 'alice',
                userGroups: [],
                scopes,
                isAdmin: false,
            },
        },
        getClientAddress: () => '127.0.0.1',
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

describe('HTTP Run schema', () => {
    it('excludes stack from parsed errors and requires the SDK run fields', () => {
        const page = { limit: 50, hasMore: false };
        const parsed = RunListResponseSchema.parse({ items: [run], page });
        expect(parsed.items[0]?.error).toEqual({ message: 'failed', kind: 'transient' });
        expect(RunListResponseSchema.safeParse({ items: [{ id: run.id }], page }).success).toBe(
            false,
        );
    });
});

beforeEach(() => {
    vi.clearAllMocks();
    listRuns.mockResolvedValue({ runs: [run] });
    getTaskDb.mockReturnValue(null);
    grouped.mockResolvedValue([group]);
});

describe.each([
    {
        prefix: '/api',
        flat: () => import('../../../../../routes/api/runs/+server.js'),
        groups: () => import('../../../../../routes/api/runs/groups/+server.js'),
    },
    {
        prefix: '/api/v1',
        flat: () => import('../../../../../routes/api/v1/runs/+server.js'),
        groups: () => import('../../../../../routes/api/v1/runs/groups/+server.js'),
    },
])('$prefix runs collections', ({ prefix, flat, groups }) => {
    it('returns typed items with default page and no stack or legacy wrapper', async () => {
        const { GET } = await flat();
        const response = await GET!(event(`${prefix}/runs`));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            items: [{ ...run, error: { message: 'failed', kind: 'transient' } }],
            page: { limit: 50, hasMore: false },
        });
    });

    it('keeps the task result envelope (result.message) on completed items and error.message on failed items', async () => {
        // Backfill-style tasks return { success, itemsProcessed, result, message }
        // as their run result; the safety-net snapshot pins result.message.
        // A failed run carries no result (writeTerminalToPostgres writes null)
        // and its message lives on error.message.
        const completed = {
            ...run,
            id: 'run-2',
            taskId: 'sonic-embedding-backfill',
            state: 'completed',
            error: undefined,
            result: {
                success: true,
                itemsProcessed: 0,
                result: { embedded: 0, failed: 0, skipped: 0 },
                message: 'Sonic backfill: 0 embedded, 0 failed, 0 skipped',
            },
        };
        listRuns.mockResolvedValue({ runs: [completed, run] });
        const { GET } = await flat();
        const body = await (await GET!(event(`${prefix}/runs`))).json();
        expect(body.items[0].result.message).toBe(
            'Sonic backfill: 0 embedded, 0 failed, 0 skipped',
        );
        expect(body.items[0].result.success).toBe(true);
        expect(body.items[1].result).toBeUndefined();
        expect(body.items[1].error).toEqual({ message: 'failed', kind: 'transient' });
    });

    it('preserves cursor and flat filters, ignoring the retired groupBy switch', async () => {
        listRuns.mockResolvedValue({ runs: [run], nextCursor: 'opaque-next==' });
        const { GET } = await flat();
        const response = await GET!(
            event(
                `${prefix}/runs?limit=200&cursor=opaque-prev&state=active,pending&taskId=t1&parentRunId=p1&libraryGroupId=l1&subjectId=s1&since=2026-10-15T00:00:00.000Z&groupBy=task`,
            ),
        );
        expect(response.status).toBe(200);
        expect((await response.json()).page).toEqual({
            limit: 200,
            hasMore: true,
            nextCursor: 'opaque-next==',
        });
        expect(listRuns).toHaveBeenCalledWith({
            limit: 200,
            cursor: 'opaque-prev',
            state: ['active', 'pending'],
            taskId: 't1',
            parentRunId: 'p1',
            libraryGroupId: 'l1',
            subjectId: 's1',
            since: new Date('2026-10-15T00:00:00.000Z'),
        });
        expect(grouped).not.toHaveBeenCalled();
    });

    it('follows nextCursor across pages without repeating runs and retains the since time filter', async () => {
        listRuns.mockImplementation(async ({ cursor }) =>
            cursor
                ? { runs: [{ ...run, id: 'run-2' }] }
                : { runs: [run], nextCursor: 'run-page-2' },
        );
        const { GET } = await flat();
        const first = await (
            await GET!(event(`${prefix}/runs?limit=1&since=2026-10-15T00:00:00.000Z`))
        ).json();
        const second = await (
            await GET!(
                event(
                    `${prefix}/runs?limit=1&cursor=${first.page.nextCursor}&since=2026-10-15T00:00:00.000Z`,
                ),
            )
        ).json();
        expect([...first.items, ...second.items].map((r: { id: string }) => r.id)).toEqual([
            'run-1',
            'run-2',
        ]);
        expect(second.page).toEqual({ limit: 1, hasMore: false });
        expect(listRuns.mock.calls[1][0]).toMatchObject({
            cursor: 'run-page-2',
            since: new Date('2026-10-15T00:00:00.000Z'),
        });
    });

    it('groups the full history using only the former grouped filters', async () => {
        getTaskDb.mockReturnValue({});
        const { GET } = await groups();
        const response = await GET!(
            event(
                `${prefix}/runs/groups?state=active,failed&libraryGroupId=l1&since=2026-10-15T00:00:00.000Z&taskId=ignored&parentRunId=ignored&subjectId=ignored&limit=1&cursor=ignored`,
            ),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            items: [{ ...group, name: 'Test task' }],
            page: { limit: 1, offset: 0, hasMore: false },
        });
        expect(grouped).toHaveBeenCalledWith(
            {},
            {
                state: ['active', 'failed'],
                libraryGroupId: 'l1',
                since: new Date('2026-10-15T00:00:00.000Z'),
            },
        );
        expect(listRuns).not.toHaveBeenCalled();
    });

    it('returns a complete empty group page', async () => {
        getTaskDb.mockReturnValue({});
        grouped.mockResolvedValue([]);
        const { GET } = await groups();
        expect(await (await GET!(event(`${prefix}/runs/groups`))).json()).toEqual({
            items: [],
            page: { limit: 0, offset: 0, hasMore: false },
        });
    });

    it.each(['state=unknown', 'since=invalid'])(
        'keeps the legacy 422 validation status for %s',
        async (query) => {
            const { GET } = await groups();
            expect((await GET!(event(`${prefix}/runs/groups?${query}`))).status).toBe(422);
            expect(grouped).not.toHaveBeenCalled();
        },
    );

    it('retains the runs:read gate on groups', async () => {
        const { GET } = await groups();
        expect((await GET!(event(`${prefix}/runs/groups`, []))).status).toBe(403);
        expect(grouped).not.toHaveBeenCalled();
    });

    it('retains the unavailable-database response', async () => {
        const { GET } = await groups();
        expect((await GET!(event(`${prefix}/runs/groups`))).status).toBe(503);
    });
});
