// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    phase: 'serving' as 'serving' | 'draining' | 'closing',
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('$lib/server/utils/logger.js', () => ({ Logger: { for: () => h.log } }));
vi.mock('$lib/server/lifecycle/web-shutdown.js', () => ({
    getWebShutdownPhase: () => h.phase,
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => undefined }));

import { TranscodeJobPersistenceService } from './transcode-job-persistence.service.js';

/** A tagged-template `sql` whose every query fails like a stopped PostgreSQL. */
function deadSql(): never {
    const sql = (): never => {
        throw new Error('the database system is shutting down');
    };
    return sql as never;
}

const PLAY_SESSION = '8f14e45f-ceea-467a-9575-1a0c2a2f6d11';

describe('TranscodeJobPersistenceService failure logging at shutdown', () => {
    beforeEach(() => {
        h.phase = 'serving';
        for (const fn of Object.values(h.log)) fn.mockReset();
    });

    it('keeps logging a failed write as an error while serving', async () => {
        const service = new TranscodeJobPersistenceService(deadSql());
        await expect(service.markPodJobsAsStopped('pod', 'graceful_shutdown')).rejects.toThrow();
        expect(h.log.error).toHaveBeenCalledWith(
            'Failed to mark pod jobs as stopped',
            expect.any(Error),
            expect.anything(),
        );
    });

    it('logs the same failures as warnings once services are closing', async () => {
        h.phase = 'closing';
        const service = new TranscodeJobPersistenceService(deadSql());
        await expect(service.markPodJobsAsStopped('pod', 'graceful_shutdown')).rejects.toThrow();
        await expect(service.getJob(PLAY_SESSION)).rejects.toThrow();
        await expect(service.updateStatus(PLAY_SESSION, 'stopped')).rejects.toThrow();
        expect(h.log.error).not.toHaveBeenCalled();
        const messages = h.log.warn.mock.calls.map((c) => String(c[0]));
        expect(messages).toEqual([
            expect.stringContaining('Failed to mark pod jobs as stopped (shutting down'),
            expect.stringContaining('Failed to load job from database (shutting down'),
            expect.stringContaining('Failed to update job status (shutting down'),
        ]);
    });
});
