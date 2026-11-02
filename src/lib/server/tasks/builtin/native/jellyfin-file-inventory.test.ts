// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockContext } from '@sapd/lumastra-plugin-sdk-testing';

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), startRun: vi.fn(), enabled: true }));
vi.mock('../../registry.js', () => ({ registry: { registerTask: vi.fn() } }));
vi.mock('$lib/server/config.js', () => ({
    features: {
        get jellyfinSync() {
            return mocks.enabled;
        },
    },
}));
vi.mock('$lib/server/services/jellyfin-file-pairing.service.js', () => ({
    refreshJellyfinFilePairings: mocks.refresh,
}));
vi.mock('../../orchestrator.js', () => ({ orchestrator: { startRun: mocks.startRun } }));
vi.mock('$lib/server/services/jellyfin-setup-sync.service.js', () => ({
    requestJellyfinSetupPull: () =>
        mocks.startRun(
            'watch-sync-pull',
            {},
            {
                trigger: { kind: 'in-process', sourceRoute: 'jellyfin-file-inventory' },
            },
        ),
}));
import { jellyfinFileInventoryTask } from './jellyfin-file-inventory.js';

beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled = true;
    mocks.refresh.mockResolvedValue({ firstInventory: false, changedPairings: true });
    mocks.startRun.mockResolvedValue({ runId: 'pull', deduped: false });
});

describe('Jellyfin inventory follow-up', () => {
    it('waits for pairing before enqueuing the singleton watch pull', async () => {
        let finish = (): void => undefined;
        mocks.refresh.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    finish = () =>
                        resolve({ firstInventory: true, changedPairings: false } as never);
                }),
        );
        const running = jellyfinFileInventoryTask.execute(
            mockContext({ input: { kickPull: true } }),
        );
        await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
        expect(mocks.startRun).not.toHaveBeenCalled();
        finish();
        await running;
        expect(mocks.startRun).toHaveBeenCalledWith(
            'watch-sync-pull',
            {},
            {
                trigger: { kind: 'in-process', sourceRoute: 'jellyfin-file-inventory' },
            },
        );
    });

    it('does not override the configured pull interval on a scheduled inventory', async () => {
        await jellyfinFileInventoryTask.execute(mockContext({ input: {} }));
        expect(mocks.startRun).not.toHaveBeenCalled();
    });

    it('does not kick a pull when a setup inventory did not change any pairings', async () => {
        mocks.refresh.mockResolvedValue({ firstInventory: false, changedPairings: false });
        await jellyfinFileInventoryTask.execute(mockContext({ input: { kickPull: true } }));
        expect(mocks.startRun).not.toHaveBeenCalled();
    });

    it('does kick after the first inventory, even if no pairings changed', async () => {
        mocks.refresh.mockResolvedValue({ firstInventory: true, changedPairings: false });
        await jellyfinFileInventoryTask.execute(mockContext({ input: { kickPull: true } }));
        expect(mocks.startRun).toHaveBeenCalledTimes(1);
    });

    it('keeps a successful inventory successful when the pull trigger fails', async () => {
        mocks.startRun.mockRejectedValue(new Error('breaker open'));
        const context = mockContext({ input: { kickPull: true } });
        context.logger.warn = vi.fn();
        await expect(jellyfinFileInventoryTask.execute(context)).resolves.toMatchObject({
            success: true,
        });
        expect(context.logger.warn).toHaveBeenCalled();
    });

    it('does not pull after an aborted inventory', async () => {
        const abort = new AbortController();
        abort.abort();
        await jellyfinFileInventoryTask.execute(mockContext({ input: {}, signal: abort.signal }));
        expect(mocks.startRun).not.toHaveBeenCalled();
    });

    it('does not pull when Jellyfin sync is disabled', async () => {
        mocks.enabled = false;
        await jellyfinFileInventoryTask.execute(mockContext({ input: {} }));
        expect(mocks.refresh).not.toHaveBeenCalled();
        expect(mocks.startRun).not.toHaveBeenCalled();
    });
});
