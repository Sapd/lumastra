// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ command: vi.fn(), runs: vi.fn(), items: vi.fn() }));
vi.mock('$lib/server/cache/valkey.js', () => ({
    getValkeyClient: () => ({ customCommand: mocks.command }),
}));
vi.mock('$lib/server/database/queries/failure-patterns.queries.js', () => ({
    listRunFailureRows: mocks.runs,
    listItemFailureRows: mocks.items,
}));
import { getFailurePatterns } from './failure-patterns.service.js';

it('ignores old cached grouping and caches the pointer-normalized aggregate without changing samples', async () => {
    const cache = new Map([
        [
            'v1:obs:failure-patterns:run:24:all',
            JSON.stringify([{ count: 1, sampleMessage: 'obsolete grouping' }]),
        ],
    ]);
    mocks.command.mockImplementation(async (args: string[]) => {
        if (args[0] === 'GET') return cache.get(args[1]) ?? null;
        if (args[0] === 'SET') cache.set(args[1], args[2]);
        return null;
    });
    const latest = '[matroska,webm @ 0x7fabc1234def] Invalid data found when processing input';
    mocks.runs.mockResolvedValue([
        {
            taskId: 'probe',
            message: '[matroska,webm @ 0x55def1234abc] Invalid data found when processing input',
            completedAt: new Date('2026-10-20T10:00:00Z'),
        },
        { taskId: 'probe', message: latest, completedAt: new Date('2026-10-20T10:01:00Z') },
    ]);
    const options = { source: 'run' as const, sinceHours: 24, limit: 10 };
    const fresh = await getFailurePatterns({} as never, options);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ count: 2, sampleMessage: latest });
    expect(await getFailurePatterns({} as never, options)).toEqual(fresh);
    expect(mocks.runs).toHaveBeenCalledOnce();
});

it('re-reads current analyzer item groups across ongoing source changes within the cache TTL', async () => {
    mocks.command.mockClear();
    mocks.items.mockReset();
    mocks.items
        .mockResolvedValueOnce([
            {
                taskId: 'lumastra-intro-analyzer',
                message: 'current source failed',
                occurredAt: new Date(),
            },
        ])
        .mockResolvedValueOnce([]);
    const options = {
        source: 'item' as const,
        sinceHours: 24,
        limit: 10,
        taskId: 'lumastra-intro-analyzer',
    };
    expect(await getFailurePatterns({} as never, options)).toHaveLength(1);
    expect(await getFailurePatterns({} as never, options)).toEqual([]);
    expect(mocks.items).toHaveBeenCalledTimes(2);
    expect(mocks.command).not.toHaveBeenCalled();
});
