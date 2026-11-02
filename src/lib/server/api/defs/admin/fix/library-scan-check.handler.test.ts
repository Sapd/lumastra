// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `/admin/fix/new-files` degrades per lookup. A lookup that FAILED must say so
 * rather than fall back to the "nothing has happened yet" defaults, and an open
 * scanner run is judged by the same staleness rule as the scan history.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    scheduleFails: false,
    runsFail: false,
    runs: [] as unknown[],
}));

vi.mock('$lib/server/database/connection.js', () => ({ getAdminDb: () => ({}) }));
vi.mock('$lib/server/database/queries/library-paths.queries.js', async (orig) => ({
    ...(await orig<typeof import('$lib/server/database/queries/library-paths.queries.js')>()),
    getAllLibraryPaths: async () => [
        {
            id: 'p1',
            path: '/media/movies',
            media_type: 'movie',
            provider: 'remote-only',
            enabled: true,
            library_group_id: 'g1',
        },
    ],
}));
vi.mock('$lib/server/database/queries/library-groups.queries.js', () => ({
    getLibraryGroupsWithCounts: async () => [
        { id: 'g1', name: 'movies', display_name: 'Movies', item_count: 3 },
    ],
}));
vi.mock('$lib/server/database/queries/file-scanner-runs.queries.js', async (orig) => ({
    ...(await orig<typeof import('$lib/server/database/queries/file-scanner-runs.queries.js')>()),
    getRecentScannerRuns: async () => {
        if (state.runsFail) throw new Error('boom');
        return state.runs;
    },
}));
vi.mock('$lib/server/tasks/scheduler-state.js', () => ({
    getSchedulerState: async () => {
        if (state.scheduleFails) throw new Error('boom');
        return null;
    },
}));
vi.mock('$lib/server/database/queries/ingest-map.queries.js', () => ({
    loadIngestPipelineSummary: async () => {
        throw new Error('not needed');
    },
}));

import { def } from './library-scan-check.js';
import {
    LibraryScanCheckSchema,
    type LibraryScanCheck,
} from '$lib/components/admin/fix/library-scan-check.schema.js';

async function check(): Promise<LibraryScanCheck> {
    const resp = await def.handlers.GET!({} as never, {} as never);
    return LibraryScanCheckSchema.parse(await (resp as Response).json());
}

function run(startedHoursAgo: number, completed: boolean): unknown {
    const started = new Date(Date.now() - startedHoursAgo * 3_600_000);
    return {
        started_at: started,
        completed_at: completed ? new Date(started.getTime() + 60_000) : null,
        total_files: 10,
        matched: 2,
        updated: 1,
        unmatched: 0,
        errors: 0,
    };
}

beforeEach(() => {
    state.scheduleFails = false;
    state.runsFail = false;
    state.runs = [];
});

describe('library-scan-check degradation', () => {
    it('no scheduler row is neverScheduled; a failed read is unreadable instead', async () => {
        expect((await check()).schedule).toMatchObject({ neverScheduled: true, unreadable: false });
        state.scheduleFails = true;
        expect((await check()).schedule).toMatchObject({ neverScheduled: false, unreadable: true });
    });

    it('a failed scanner-runs read is flagged, an empty one is not', async () => {
        expect((await check()).paths[0]).toMatchObject({
            lastScan: null,
            lastScanUnreadable: false,
        });
        state.runsFail = true;
        expect((await check()).paths[0]).toMatchObject({
            lastScan: null,
            lastScanUnreadable: true,
        });
    });

    it('an open run past the cutoff is abandoned, a fresh one is running', async () => {
        state.runs = [run(0.1, false)];
        expect((await check()).paths[0]?.lastScan).toMatchObject({
            running: true,
            abandoned: false,
        });
        state.runs = [run(48, false)];
        expect((await check()).paths[0]?.lastScan).toMatchObject({
            running: false,
            abandoned: true,
        });
    });
});
