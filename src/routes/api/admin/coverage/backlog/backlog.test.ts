// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for GET /api/admin/coverage/backlog
 *
 * The registry and query modules are mocked so no live infrastructure is
 * required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockCountSweepBacklog = vi.fn();
vi.mock('$lib/server/database/queries/stage-sweep.queries.js', () => ({
    countSweepBacklog: (...args: unknown[]) => mockCountSweepBacklog(...args),
}));

const mockGetTrickplayBacklogCounts = vi.fn();
vi.mock('$lib/server/database/queries/trickplay-params.queries.js', () => ({
    getTrickplayBacklogCounts: (...args: unknown[]) => mockGetTrickplayBacklogCounts(...args),
    TRICKPLAY_PARAMS_PROCESSING_VERSION: 3,
}));

const mockGetAllTasks = vi.fn();
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: {
        getAllTasks: () => mockGetAllTasks(),
    },
}));

const mockSql = {} as never;
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => mockSql),
}));

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (evt: unknown) => Promise<Response>) => fn,
}));

// ── Imports ───────────────────────────────────────────────────────────────────

const { GET } = await import('./+server.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(isAdmin = true) {
    const url = new URL('http://test/api/admin/coverage/backlog');
    return {
        locals: {
            user: {
                userId: 'user-1',
                username: 'testadmin',
                userGroups: [],
                isAdmin,
                maxAgeRating: null,
            },
            // 2026-10-13: an admin session's principal carries the admin scope; a non-admin
            // request has no admin principal and is refused by authenticate() (401).
            principal: isAdmin ? { kind: 'session', isAdmin: true, scopes: ['admin'] } : undefined,
        },
        url,
        request: new Request(url),
        params: {},
    } as never;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/admin/coverage/backlog', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns 401 for non-admin', async () => {
        mockGetAllTasks.mockReturnValue([]);
        const res = await GET!(makeEvent(false));
        expect(res.status).toBe(401);
    });

    it('returns empty stages array when no tasks declare enqueueable stages', async () => {
        mockGetAllTasks.mockReturnValue([]);
        const res = await GET!(makeEvent());
        expect(res.status).toBe(200);
        const body = (await res.json()) as { stages: unknown[] };
        expect(body.stages).toEqual([]);
    });

    it('returns backlog counts for enqueueable stages only', async () => {
        mockGetAllTasks.mockReturnValue([
            {
                id: 'task-a',
                coversStages: [{ id: 'stage-alpha', enqueueable: true }],
            },
            {
                id: 'task-b',
                coversStages: [
                    { id: 'stage-beta', enqueueable: true },
                    { id: 'stage-gamma', enqueueable: false },
                ],
            },
            {
                id: 'task-c',
                // no coversStages
            },
        ]);

        mockCountSweepBacklog
            .mockResolvedValueOnce(10) // stage-alpha
            .mockResolvedValueOnce(5); // stage-beta

        const res = await GET!(makeEvent());
        expect(res.status).toBe(200);

        const body = (await res.json()) as {
            stages: Array<{ stage_id: string; backlog: number }>;
        };
        expect(body.stages).toHaveLength(2);

        const alpha = body.stages.find((s) => s.stage_id === 'stage-alpha');
        const beta = body.stages.find((s) => s.stage_id === 'stage-beta');
        expect(alpha?.backlog).toBe(10);
        expect(beta?.backlog).toBe(5);

        // stage-gamma (enqueueable: false) must not appear
        expect(body.stages.find((s) => s.stage_id === 'stage-gamma')).toBeUndefined();

        // countSweepBacklog called exactly twice (once per enqueueable stage)
        expect(mockCountSweepBacklog).toHaveBeenCalledTimes(2);
    });

    it('passes the sql connection to countSweepBacklog', async () => {
        mockGetAllTasks.mockReturnValue([
            {
                id: 'task-x',
                coversStages: [{ id: 'stage-x', enqueueable: true }],
            },
        ]);
        mockCountSweepBacklog.mockResolvedValueOnce(3);

        await GET!(makeEvent());

        expect(mockCountSweepBacklog).toHaveBeenCalledWith(mockSql, 'stage-x');
    });

    it('shows runnable linked-file pairs for the trickplay coverage pulse', async () => {
        mockGetAllTasks.mockReturnValue([
            {
                id: 'trickplay-params-sync',
                coversStages: [{ id: 'trickplay-params-sync', enqueueable: true }],
            },
        ]);
        mockGetTrickplayBacklogCounts.mockResolvedValue({
            analyzed: 1,
            remaining: 0,
            ineligible: 1,
            failed: 0,
        });

        const res = await GET!(makeEvent());
        expect((await res.json()) as unknown).toEqual({
            stages: [{ stage_id: 'trickplay-params-sync', backlog: 0 }],
        });
        expect(mockGetTrickplayBacklogCounts).toHaveBeenCalledWith(mockSql, 3);
        expect(mockCountSweepBacklog).not.toHaveBeenCalled();
    });
});
