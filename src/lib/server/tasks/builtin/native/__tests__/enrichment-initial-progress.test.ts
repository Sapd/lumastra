// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { DrainBacklogOptions } from '$lib/server/plugins/runtime/drain-backlog.js';

vi.mock('$lib/server/config.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/config.js')>()),
    getAuthoritativeStageIds: () => new Set(['artist-enrichment', 'album-enrichment']),
}));
vi.mock('$lib/server/services/discogs-token.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/services/discogs-token.js')>()),
    readDiscogsToken: async () => 'test-token',
}));
vi.mock('$lib/server/database/queries/task-settings.queries.js', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('$lib/server/database/queries/task-settings.queries.js')
    >()),
    getTaskSettings: async () => ({
        primary_source: 'discogs',
        fallback_source: 'discogs',
        _applied_source_chain: 'discogs',
    }),
}));
vi.mock('$lib/server/database/queries/artist-enrichment.queries.js', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('$lib/server/database/queries/artist-enrichment.queries.js')
    >()),
    countUnenrichedArtists: async () => 17,
    findCoverageTableBacklog: async () => [],
}));
vi.mock('$lib/server/database/queries/album-enrichment.queries.js', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('$lib/server/database/queries/album-enrichment.queries.js')
    >()),
    countUnenrichedAlbums: async () => 17,
    findCoverageTableBacklog: async () => [],
}));
vi.mock('$lib/server/services/album-local-art.js', () => ({
    backfillLocalAlbumArt: async () => 0,
    recoverLocalAlbumArt: async () => false,
}));
vi.mock('../../../api-call-spend.js', () => ({
    withApiCallSpend: async (_ctx: unknown, execute: () => Promise<unknown>) => execute(),
}));
vi.mock('$lib/server/plugins/runtime/drain-backlog.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/plugins/runtime/drain-backlog.js')>()),
    drainBacklog: async (_ctx: unknown, options: DrainBacklogOptions<unknown>) => {
        await options.fetchSlice(50);
        return { stopReason: 'empty', itemsProduced: 0 };
    },
}));

import { buildAdminContextStub } from '../../../plugin-context.js';
import { artistEnrichmentTask } from '../artist-enrichment.js';
import { albumEnrichmentTask } from '../album-enrichment.js';

describe('released enrichment backlog progress', () => {
    it.each([artistEnrichmentTask, albumEnrichmentTask])(
        '$id publishes the initial count before the first slow provider slice',
        async (task) => {
            const ctx = buildAdminContextStub(task.id, { sql: vi.fn() as never });
            const report = vi.spyOn(ctx, 'reportProgress');
            await task.execute(ctx as never);
            expect(report).toHaveBeenCalledWith(0, 17);
        },
    );
});
