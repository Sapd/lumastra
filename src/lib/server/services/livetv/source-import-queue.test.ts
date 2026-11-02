// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
const h = vi.hoisted(() => ({ startRun: vi.fn(), updateRefreshStatus: vi.fn() }));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({ orchestrator: { startRun: h.startRun } }));
vi.mock('$lib/server/database/queries/livetv-sources.queries.js', () => ({
    updateRefreshStatus: h.updateRefreshStatus,
    updateEpgRefreshStatus: vi.fn(),
}));
vi.mock('$lib/server/utils/logger.js', () => ({ Logger: { for: () => ({ warn: vi.fn() }) } }));
import { queueSourceImport } from './source-import-queue.js';
beforeEach(() => {
    vi.clearAllMocks();
});
it.each(['import-m3u', 'import-epg'] as const)(
    'returns a fresh follow-up task when %s dedupes an already running import',
    async (task) => {
        h.startRun
            .mockResolvedValueOnce({ runId: 'old', deduped: true })
            .mockResolvedValueOnce({ runId: 'follow-up' });
        const result = await queueSourceImport({} as postgres.Sql, 'source', task, 'admin');
        expect(h.startRun).toHaveBeenCalledTimes(2);
        expect(h.startRun.mock.calls[1]).toEqual([
            task,
            { sourceId: 'source', requestId: expect.any(String) },
            expect.objectContaining({
                idempotencyKey: expect.not.stringMatching(/^manual_import-(m3u|epg)_source$/),
            }),
        ]);
        expect(result.taskIds).toEqual(
            task === 'import-m3u' ? { m3u: 'follow-up' } : { epg: 'follow-up' },
        );
    },
);
