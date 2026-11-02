// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
    listeners: [] as Array<(keys: readonly string[] | null) => void>,
    startRun: vi.fn(async () => ({ runId: 'r' })),
    configured: true,
    libraryPathIds: ['lp-1'],
}));

vi.mock('$lib/server/config/config.service.js', () => ({
    onConfigChange: (listener: (keys: readonly string[] | null) => void) => {
        h.listeners.push(listener);
        return () => undefined;
    },
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    findLibraryPathIdsWithAwaitingMatch: vi.fn(async () => h.libraryPathIds),
}));
vi.mock('$lib/server/tasks/plugin-context.js', () => ({
    isProviderConfigured: vi.fn(async () => h.configured),
}));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: { startRun: h.startRun },
}));

const { installProviderKeyRematchTrigger } = await import('./provider-key-rematch.service.js');

/** Fire the registered listener and let its fire-and-forget work settle. */
async function fire(keys: readonly string[] | null): Promise<void> {
    for (const listener of h.listeners) listener(keys);
    await vi.waitFor(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('installProviderKeyRematchTrigger', () => {
    beforeEach(() => {
        h.startRun.mockClear();
        h.configured = true;
    });

    it('registers once, and a saved TMDB key starts a re-match scan per awaiting library', async () => {
        installProviderKeyRematchTrigger();
        installProviderKeyRematchTrigger();
        expect(h.listeners).toHaveLength(1);

        await fire(['TMDB_API_KEY']);
        expect(h.startRun).toHaveBeenCalledWith(
            'file-library-scan',
            { libraryPathId: 'lp-1', mode: 'manual' },
            expect.objectContaining({ idempotencyKey: 'provider-key-rematch:lp-1' }),
        );
    });

    it('ignores a whole-config reload, unrelated keys, and a key that is not usable', async () => {
        installProviderKeyRematchTrigger();
        await fire(null);
        await fire(['TMDB_LANGUAGE']);
        h.configured = false;
        await fire(['TMDB_API_KEY']);
        expect(h.startRun).not.toHaveBeenCalled();
    });
});
