// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MDBLIST_API_KEY is a host setting: the release runs from the config-change
 * listener in each WORKER process, after that process holds the new key (a
 * local save or the reload a save broadcasts). Acting there — not in the web
 * replica that saved — means the sweep and the run never read an empty key and
 * re-park the rows for another 12h.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { config, listeners, releaseRows, startRun, getTaskDb } = vi.hoisted(() => ({
    config: { MDBLIST_API_KEY: '', WORKER_MODE: 'enabled' } as Record<string, string>,
    listeners: [] as Array<(keys: readonly string[] | null) => void>,
    releaseRows: vi.fn(),
    startRun: vi.fn(),
    getTaskDb: vi.fn(),
}));

vi.mock('$lib/server/config.js', () => ({ config }));
vi.mock('$lib/server/config/index.js', () => ({
    onConfigChange: (fn: (keys: readonly string[] | null) => void) => {
        listeners.push(fn);
        return () => undefined;
    },
}));
vi.mock('$lib/server/database/queries/stage-state.queries.js', () => ({
    releaseSkippedTransientForReason: releaseRows,
}));
vi.mock('$lib/server/database/connection.js', () => ({ getTaskDb }));
vi.mock('./orchestrator.js', () => ({ orchestrator: { startRun } }));

import { watchHostProviderKey, MDBLIST_KEY_RELEASE } from './provider-key-release.js';

const DB = { db: true };

function configChanged(keys: readonly string[] | null): void {
    for (const fn of listeners) fn(keys);
}

describe('watchHostProviderKey (MDBList)', () => {
    beforeEach(() => {
        listeners.length = 0;
        config.MDBLIST_API_KEY = '';
        config.WORKER_MODE = 'enabled';
        releaseRows.mockReset().mockResolvedValue(4);
        startRun.mockReset().mockResolvedValue({ runId: 'r' });
        getTaskDb.mockReset().mockReturnValue(DB);
        watchHostProviderKey(() => config.MDBLIST_API_KEY, MDBLIST_KEY_RELEASE);
    });

    it('releases the guard-parked rows and starts both tasks when the key becomes set', async () => {
        config.MDBLIST_API_KEY = 'abc';
        // After a reload the listener gets null keys.
        configChanged(null);

        await vi.waitFor(() => expect(startRun).toHaveBeenCalledTimes(2));
        expect(releaseRows).toHaveBeenCalledWith(DB, {
            stageId: 'mdblist-sync',
            skippedReason: 'no-mdblist-api-key-configured',
        });
        expect(startRun.mock.calls.map((c) => c[0])).toEqual([
            'mdblist-sync',
            'curated-lists-sync',
        ]);
    });

    it('does nothing for a re-save of the same key, a changed key, or a cleared key', async () => {
        config.MDBLIST_API_KEY = 'abc';
        configChanged(['MDBLIST_API_KEY']);
        await vi.waitFor(() => expect(startRun).toHaveBeenCalledTimes(2));
        startRun.mockClear();
        releaseRows.mockClear();

        configChanged(['MDBLIST_API_KEY']);
        config.MDBLIST_API_KEY = 'def';
        configChanged(null);
        config.MDBLIST_API_KEY = '  ';
        configChanged(null);
        await new Promise((r) => setTimeout(r, 0));

        expect(releaseRows).not.toHaveBeenCalled();
        expect(startRun).not.toHaveBeenCalled();
    });

    it('a web replica (WORKER_MODE=disabled) only reloads', async () => {
        config.WORKER_MODE = 'disabled';
        config.MDBLIST_API_KEY = 'abc';
        configChanged(['MDBLIST_API_KEY']);
        await new Promise((r) => setTimeout(r, 0));

        expect(releaseRows).not.toHaveBeenCalled();
        expect(startRun).not.toHaveBeenCalled();
    });

    it('a run already in flight is not reported as started, and a failed start does not stop the next', async () => {
        startRun
            .mockResolvedValueOnce({ runId: 'r0', deduped: true, existingRunId: 'r0' })
            .mockRejectedValueOnce(new Error('circuit open'));
        const { releaseAfterProviderKeySaved } = await import('./provider-key-release.js');
        const out = await releaseAfterProviderKeySaved(DB as never, MDBLIST_KEY_RELEASE);
        expect(out).toEqual({ released: 4, started: [] });
        expect(startRun).toHaveBeenCalledTimes(2);
    });
});
