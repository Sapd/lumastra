// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetAllTasks = vi.fn();
const mockGetTaskLaneData = vi.fn();
const mockGetCoordinationClient = vi.fn();

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { getAllTasks: (...args: unknown[]) => mockGetAllTasks(...args) },
}));

vi.mock('$lib/server/tasks/lane-data.js', () => ({
    getTaskLaneData: (...args: unknown[]) => mockGetTaskLaneData(...args),
}));

vi.mock('$lib/server/cache/valkey.js', () => ({
    getCoordinationClient: (...args: unknown[]) => mockGetCoordinationClient(...args),
}));

const { def } = await import('./restart-safety.js');

function task(overrides: Record<string, unknown> = {}) {
    return {
        id: 'sample-task',
        name: 'Sample Task',
        resourceClass: 'io',
        demo: false,
        coversStages: undefined,
        backlog: undefined,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetCoordinationClient.mockReturnValue({ customCommand: vi.fn().mockResolvedValue(0) });
});

describe('GET /api/admin/system/restart-safety', () => {
    it('reports safe when nothing is active and nothing is queued', async () => {
        mockGetAllTasks.mockReturnValue([task()]);
        mockGetTaskLaneData.mockResolvedValue(new Map());

        const response = await def.handlers.GET!(null as never, { surface: 'internal' } as never);
        const body = await response.json();

        expect(body.status).toBe('safe');
        expect(body.items).toEqual([]);
        expect(body.pendingWrites).toBe(0);
    });

    it('reports unknown when the task database is unreachable', async () => {
        mockGetAllTasks.mockReturnValue([task()]);
        mockGetTaskLaneData.mockResolvedValue(null);

        const response = await def.handlers.GET!(null as never, { surface: 'internal' } as never);
        const body = await response.json();

        expect(body.status).toBe('unknown');
        expect(body.items).toEqual([]);
    });

    it('marks a task covering pipeline stages as resumable and computes its ETA', async () => {
        mockGetAllTasks.mockReturnValue([
            task({ id: 'artwork-sync', name: 'Artwork Sync', coversStages: [{ id: 'artwork' }] }),
        ]);
        const lastStartedAt = new Date(Date.now() - 60_000).toISOString();
        mockGetTaskLaneData.mockResolvedValue(
            new Map([
                [
                    'artwork-sync',
                    {
                        activeCount: 1,
                        lastStartedAt,
                        lastCompletedAt: null,
                        backlogRemaining: 12,
                        recentFailCount: 0,
                        circuitState: 'closed',
                        itemsPerHour: 60,
                        lastFailedError: null,
                    },
                ],
            ]),
        );

        const response = await def.handlers.GET!(null as never, { surface: 'internal' } as never);
        const body = await response.json();

        expect(body.status).toBe('wait');
        expect(body.items).toHaveLength(1);
        expect(body.items[0]).toMatchObject({
            taskId: 'artwork-sync',
            resumable: true,
            backlogRemaining: 12,
            etaMs: 12 * 60_000,
        });
        expect(body.items[0].elapsedMs).toBeGreaterThan(0);
    });

    it('marks a task with no covered stages as non-resumable and reports lossy', async () => {
        mockGetAllTasks.mockReturnValue([
            task({ id: 'preview-generate', name: 'Preview Generation', coversStages: undefined }),
        ]);
        mockGetTaskLaneData.mockResolvedValue(
            new Map([
                [
                    'preview-generate',
                    {
                        activeCount: 1,
                        lastStartedAt: new Date(Date.now() - 2_400_000).toISOString(),
                        lastCompletedAt: null,
                        backlogRemaining: 0,
                        recentFailCount: 0,
                        circuitState: 'closed',
                        itemsPerHour: null,
                        lastFailedError: null,
                    },
                ],
            ]),
        );

        const response = await def.handlers.GET!(null as never, { surface: 'internal' } as never);
        const body = await response.json();

        expect(body.status).toBe('lossy');
        expect(body.items[0]).toMatchObject({
            taskId: 'preview-generate',
            resumable: false,
            etaMs: null,
        });
    });

    it('reports wait when only pending writes are queued', async () => {
        mockGetAllTasks.mockReturnValue([task()]);
        mockGetTaskLaneData.mockResolvedValue(new Map());
        mockGetCoordinationClient.mockReturnValue({
            customCommand: vi.fn().mockResolvedValue(3),
        });

        const response = await def.handlers.GET!(null as never, { surface: 'internal' } as never);
        const body = await response.json();

        expect(body.status).toBe('wait');
        expect(body.pendingWrites).toBe(3);
    });

    it('never reports safe when the pending-write queue cannot be read', async () => {
        mockGetAllTasks.mockReturnValue([task()]);
        mockGetTaskLaneData.mockResolvedValue(new Map());
        mockGetCoordinationClient.mockReturnValue({
            customCommand: vi.fn().mockRejectedValue(new Error('connection closed')),
        });

        const failed = await (
            await def.handlers.GET!(null as never, { surface: 'internal' } as never)
        ).json();
        expect(failed.status).toBe('unknown');

        mockGetCoordinationClient.mockReturnValue(null);
        const absent = await (
            await def.handlers.GET!(null as never, { surface: 'internal' } as never)
        ).json();
        expect(absent.status).toBe('unknown');
    });

    it('a lossy verdict still wins over an unreadable queue', async () => {
        mockGetAllTasks.mockReturnValue([task({ id: 'preview-generate' })]);
        mockGetTaskLaneData.mockResolvedValue(
            new Map([['preview-generate', { activeCount: 1, backlogRemaining: 0 }]]),
        );
        mockGetCoordinationClient.mockReturnValue(null);

        const body = await (
            await def.handlers.GET!(null as never, { surface: 'internal' } as never)
        ).json();
        expect(body.status).toBe('lossy');
    });
});
