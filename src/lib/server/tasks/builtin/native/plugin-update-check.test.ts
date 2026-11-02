// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The scheduled half of the plugin catalog.
 *
 * This task NEVER installs anything — it re-syncs the repository indexes and
 * records what is on offer, so the admin UI can say "an update exists" and an
 * operator can choose. Automatic installation would take the one deliberate
 * human step out of a flow whose entire trust model is "an operator decided to
 * run this code", so the assertions here are as much about what it declines to
 * do as about what it does.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type SyncOutcome = { repositoryId: string; entries: number; error: string | null };
const mockSyncAll = vi.fn(async (): Promise<SyncOutcome[]> => [
    { repositoryId: 'r1', entries: 2, error: null },
]);
const mockFindUpdates = vi.fn(() => [] as unknown[]);
vi.mock('$lib/server/services/plugin-repository.service.js', () => ({
    syncAllRepositories: (...a: unknown[]) => mockSyncAll(...(a as [])),
    findAvailableUpdates: (...a: unknown[]) => mockFindUpdates(...(a as [])),
}));

let installed: Array<{ name: string; version: string; signingKeyId: string | null }> = [];
vi.mock('$lib/server/database/queries/external-plugins.queries.js', () => ({
    listExternalPlugins: vi.fn(async () => installed),
}));

let catalog: unknown[] = [];
const mockSetAvailable = vi.fn(async () => undefined);
vi.mock('$lib/server/database/queries/plugin-repositories.queries.js', () => ({
    listCatalogEntries: vi.fn(async () => catalog),
    setAvailableUpdate: (...a: unknown[]) => mockSetAvailable(...(a as [])),
}));

let sql: unknown = {};
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => sql,
}));

vi.mock('../../registry.js', () => ({
    registry: { registerTask: vi.fn() },
}));

import { pluginUpdateCheckTask } from './plugin-update-check.js';

function makeCtx(aborted = false) {
    return {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: { aborted },
    } as never;
}

beforeEach(() => {
    vi.clearAllMocks();
    installed = [];
    catalog = [];
    sql = {};
    mockSyncAll.mockResolvedValue([{ repositoryId: 'r1', entries: 2, error: null }]);
    mockFindUpdates.mockReturnValue([]);
});

describe('what it refuses to do', () => {
    it('declares no install capability — a scheduled job must not be able to run new code', () => {
        expect(pluginUpdateCheckTask.capabilities?.database).toBe(true);
        // Whatever else it gains, it must never gain the filesystem write that
        // an install needs.
        expect(
            (pluginUpdateCheckTask.capabilities as Record<string, unknown>).filesystem,
        ).toBeUndefined();
    });

    it('records an available update rather than installing it', async () => {
        installed = [{ name: 'acme', version: '1.0.0', signingKeyId: 'k1' }];
        mockFindUpdates.mockReturnValue([
            {
                name: 'acme',
                fromVersion: '1.0.0',
                toVersion: '1.1.0',
                manifestUrl: 'https://x/m.json',
                signature: 'sig',
                security: false,
            },
        ]);
        const res = await pluginUpdateCheckTask.execute(makeCtx());
        expect(mockSetAvailable).toHaveBeenCalledWith(
            {},
            'acme',
            expect.objectContaining({ version: '1.1.0' }),
        );
        expect(res.success).toBe(true);
    });
});

describe('clearing stale offers', () => {
    it('clears the recorded update for a plugin that no longer has one', async () => {
        installed = [{ name: 'acme', version: '1.1.0', signingKeyId: 'k1' }];
        mockFindUpdates.mockReturnValue([]);
        await pluginUpdateCheckTask.execute(makeCtx());
        // Otherwise the badge outlives the update — the operator installs it by
        // hand, the offer stays on screen, and the UI is lying.
        expect(mockSetAvailable).toHaveBeenCalledWith({}, 'acme', null);
    });

    it('does not touch plugins it was never asked about', async () => {
        installed = [];
        await pluginUpdateCheckTask.execute(makeCtx());
        expect(mockSetAvailable).not.toHaveBeenCalled();
    });
});

describe('degradation', () => {
    it('reports rather than throws when a repository sync fails, so one bad URL does not fail the run', async () => {
        mockSyncAll.mockResolvedValue([
            { repositoryId: 'r1', entries: 0, error: 'connect ECONNREFUSED' },
        ]);
        const res = await pluginUpdateCheckTask.execute(makeCtx());
        expect(res.success).toBe(true);
        expect(res.result?.repositoryErrors).toBe(1);
    });

    it('is a no-op without a database rather than a crash at boot', async () => {
        sql = null;
        const res = await pluginUpdateCheckTask.execute(makeCtx());
        expect(res.success).toBe(true);
        expect(mockSyncAll).not.toHaveBeenCalled();
    });

    it('stops before doing any network work when already aborted', async () => {
        const res = await pluginUpdateCheckTask.execute(makeCtx(true));
        expect(mockSyncAll).not.toHaveBeenCalled();
        expect(res.stopReason).toBe('aborted');
    });
});
