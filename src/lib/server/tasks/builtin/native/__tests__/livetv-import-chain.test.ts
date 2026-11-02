// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * import-m3u starts import-epg itself once the channels exist (the routes used
 * to start both side by side, and the EPG run read the channel list while the
 * M3U run was replacing it). It does not start it after a cancel, for a source
 * without an XMLTV URL, or when the M3U import fails.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
    startRun: vi.fn(),
    getSourceById: vi.fn(),
    importM3uSource: vi.fn(),
    getSourcesWithRefreshCron: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock('../../../registry.js', () => ({ registry: { registerTask: vi.fn() } }));
vi.mock('../../../orchestrator.js', () => ({ orchestrator: { startRun: h.startRun } }));
vi.mock('$lib/server/database/queries/livetv-sources.queries.js', () => ({
    getSourceById: h.getSourceById,
    getSourcesWithRefreshCron: h.getSourcesWithRefreshCron,
}));
vi.mock('../../../../services/livetv/livetv-import.service.js', () => ({
    importM3uSource: h.importM3uSource,
}));

import { mockLogger } from '@sapd/lumastra-plugin-sdk-testing';
import type { Sql } from 'postgres';
import { importM3uTask, buildLivetvDueEntries } from '../livetv-tasks.js';

const SOURCE_ID = '39fd41c1-d8c7-43c8-82cf-8393274dcd31';

function ctx(signal = new AbortController().signal) {
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    return {
        context: {
            sql: {},
            signal,
            runId: 'run-m3u',
            input: { sourceId: SOURCE_ID },
            logger,
            reportProgress: vi.fn(),
        } as unknown as Parameters<typeof importM3uTask.execute>[0],
        logger,
    };
}

describe('import-m3u → import-epg chain', () => {
    beforeEach(() => {
        h.startRun.mockReset().mockResolvedValue({ runId: 'run-epg' });
        h.getSourceById.mockReset().mockResolvedValue({ id: SOURCE_ID, xmltv_url: 'http://x/epg' });
        h.importM3uSource.mockReset().mockResolvedValue({ channelCount: 12619, errors: [] });
    });

    it('starts import-epg as a child run after a successful M3U import', async () => {
        await importM3uTask.execute(ctx().context);

        expect(h.startRun).toHaveBeenCalledTimes(1);
        const [taskId, input, opts] = h.startRun.mock.calls[0];
        expect(taskId).toBe('import-epg');
        expect(input).toEqual({ sourceId: SOURCE_ID });
        expect(opts).toMatchObject({
            parentRunId: 'run-m3u',
            idempotencyKey: `manual_import-epg_${SOURCE_ID}`,
        });
        // The EPG run starts only after the channels were written.
        expect(h.importM3uSource.mock.invocationCallOrder[0]).toBeLessThan(
            h.startRun.mock.invocationCallOrder[0],
        );
    });

    it('does not start the guide import for a source without an XMLTV URL', async () => {
        h.getSourceById.mockResolvedValue({ id: SOURCE_ID, xmltv_url: null });
        await importM3uTask.execute(ctx().context);
        expect(h.startRun).not.toHaveBeenCalled();
    });

    it('does not start the guide import when the run was cancelled', async () => {
        const ac = new AbortController();
        h.importM3uSource.mockImplementation(async () => {
            ac.abort();
            return { channelCount: 10, errors: [] };
        });
        await importM3uTask.execute(ctx(ac.signal).context);
        expect(h.startRun).not.toHaveBeenCalled();
    });

    it('does not start the guide import when the M3U import fails', async () => {
        h.importM3uSource.mockRejectedValue(new Error('MAX_PARAMETERS_EXCEEDED'));
        await expect(importM3uTask.execute(ctx().context)).rejects.toThrow(
            'MAX_PARAMETERS_EXCEEDED',
        );
        expect(h.startRun).not.toHaveBeenCalled();
    });

    it('keeps the M3U run successful when the guide import cannot be started', async () => {
        h.startRun.mockRejectedValue(new Error('queue down'));
        const { context, logger } = ctx();
        await expect(importM3uTask.execute(context)).resolves.toMatchObject({
            itemsProcessed: 12619,
        });
        expect(logger.warn).toHaveBeenCalled();
    });

    it('warns when an earlier guide import for the source is still running', async () => {
        h.startRun.mockResolvedValue({ runId: 'run-old-epg', deduped: true });
        const { context, logger } = ctx();
        await importM3uTask.execute(context);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('still running'),
            expect.objectContaining({ runId: 'run-old-epg' }),
        );
    });
});

it.each(['0 3 * * *', '0 3 * * 0'])(
    'honours the daily and weekly schedules offered in Settings (%s)',
    async (refresh_cron) => {
        h.getSourcesWithRefreshCron.mockResolvedValueOnce([
            {
                id: SOURCE_ID,
                m3u_url: 'http://provider.example/list',
                refresh_cron,
                last_refresh_at: null,
            },
        ]);
        const entries = await buildLivetvDueEntries({} as Sql, mockLogger(), 'm3u', new Date());
        expect(entries).toHaveLength(1);
    },
);

it.each(['0 */24 * * *', '*/90 * * * *'])(
    'continues to schedule legacy stored intervals: %s',
    async (refresh_cron) => {
        h.getSourcesWithRefreshCron.mockResolvedValueOnce([
            {
                id: SOURCE_ID,
                m3u_url: 'http://provider.example/list',
                refresh_cron,
                last_refresh_at: null,
            },
        ]);
        expect(
            await buildLivetvDueEntries({} as Sql, mockLogger(), 'm3u', new Date()),
        ).toHaveLength(1);
    },
);

it('gives follow-up requests their own queue identity', () => {
    expect(importM3uTask.identityFor({ sourceId: SOURCE_ID, requestId: 'second' })).not.toBe(
        importM3uTask.identityFor({ sourceId: SOURCE_ID }),
    );
});

it('uses the independent guide clock when the playlist was just refreshed', async () => {
    const now = new Date('2026-10-30T12:00:00Z');
    h.getSourcesWithRefreshCron.mockResolvedValueOnce([
        {
            id: SOURCE_ID,
            m3u_url: 'http://provider.example/list',
            xmltv_url: 'http://provider.example/guide',
            refresh_cron: '0 */12 * * *',
            last_refresh_at: now,
            last_epg_refresh_at: new Date('2026-10-29T12:00:00Z'),
        },
    ]);
    expect(await buildLivetvDueEntries({} as Sql, mockLogger(), 'epg', now)).toHaveLength(1);
});
