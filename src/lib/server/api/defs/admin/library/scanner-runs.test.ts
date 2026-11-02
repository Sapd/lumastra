// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The scanner-runs def's row → wire mapping.
 *
 * This is where "did it work" is decided. The admin table renders `status`
 * verbatim, so if the derivation is wrong here nothing downstream can notice
 * — a component test would only be re-asserting its own fixture. The scope
 * mapping is tested for the same reason: `= NULL` matches no rows, so the
 * "All libraries" row's history is only correct if the sentinel is turned
 * into a real `IS NULL` branch before it reaches SQL.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const { mockGetDb, mockRecent, mockLatest } = vi.hoisted(() => ({
    mockGetDb: vi.fn(),
    mockRecent: vi.fn(),
    mockLatest: vi.fn(),
}));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: mockGetDb }));
vi.mock('$lib/server/database/queries/file-scanner-runs.queries.js', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('$lib/server/database/queries/file-scanner-runs.queries.js')
        >();
    return {
        ...actual,
        getRecentScannerRuns: mockRecent,
        getLatestScannerRunPerLibrary: mockLatest,
    };
});

import { def } from './scanner-runs.js';

const STARTED = new Date('2026-08-27T10:00:00.000Z');

function row(over: Record<string, unknown> = {}) {
    return {
        id: 'run-1',
        library_path_id: 'lib-1',
        library_path: '/media/movies',
        started_at: STARTED,
        completed_at: new Date('2026-08-27T10:02:10.000Z'),
        total_files: 4000,
        matched: 12,
        updated: 3,
        unmatched: 0,
        errors: 0,
        match_rate: '0.30',
        error_samples: [],
        created_at: STARTED,
        ...over,
    };
}

async function call(query: Record<string, unknown>) {
    const res = await def.handlers.GET!(
        {} as RequestEvent,
        {
            input: { query },
        } as never,
    );
    return (await (res as Response).json()) as { items: Record<string, unknown>[] };
}

describe('GET /api/admin/library/scanner-runs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({});
        mockRecent.mockResolvedValue([]);
        mockLatest.mockResolvedValue([]);
    });

    it('serves the latest-per-library view from the per-library query', async () => {
        mockLatest.mockResolvedValue([row()]);
        const body = await call({ view: 'latest', limit: 20 });
        expect(mockLatest).toHaveBeenCalled();
        expect(mockRecent).not.toHaveBeenCalled();
        expect(body.items).toHaveLength(1);
    });

    it('serves the history view from the recent-runs query', async () => {
        mockRecent.mockResolvedValue([row()]);
        await call({ view: 'history', limit: 20 });
        expect(mockRecent).toHaveBeenCalled();
        expect(mockLatest).not.toHaveBeenCalled();
    });

    // `matched` is written as `added + updated`, so the added count the table
    // shows is the difference. Shipping `matched` raw would overstate what a
    // run added by exactly the number of items it merely updated.
    it('derives added as matched minus updated', async () => {
        mockLatest.mockResolvedValue([row({ matched: 12, updated: 3 })]);
        const body = await call({ view: 'latest', limit: 20 });
        expect(body.items[0].added).toBe(9);
        expect(body.items[0].updated).toBe(3);
    });

    // An abandoned row's counters are not real numbers from a real pass, so
    // the subtraction can invert. A negative "added" is not a thing.
    it('never emits a negative added count', async () => {
        mockLatest.mockResolvedValue([row({ matched: 0, updated: 5 })]);
        const body = await call({ view: 'latest', limit: 20 });
        expect(body.items[0].added).toBe(0);
    });

    it('ships the run duration so the client does not subtract timestamps', async () => {
        mockLatest.mockResolvedValue([row()]);
        const body = await call({ view: 'latest', limit: 20 });
        expect(body.items[0].durationMs).toBe(130_000);
    });

    it('leaves duration null while a run is still open', async () => {
        // Started just now, so it is inside the grace window against the real
        // clock the handler uses — an open run only becomes abandoned once it
        // is past that window, which the next test covers.
        mockLatest.mockResolvedValue([
            row({ started_at: new Date(Date.now() - 60_000), completed_at: null }),
        ]);
        const body = await call({ view: 'latest', limit: 20 });
        expect(body.items[0].durationMs).toBeNull();
        expect(body.items[0].status).toBe('running');
    });

    // The sentinel must never reach the client as a renderable error count.
    it('reports the -1 sentinel row as abandoned', async () => {
        mockLatest.mockResolvedValue([row({ errors: -1 })]);
        const body = await call({ view: 'latest', limit: 20 });
        expect(body.items[0].status).toBe('abandoned');
    });

    it('reports an in-flight run past the grace window as abandoned', async () => {
        mockLatest.mockResolvedValue([
            row({
                started_at: new Date(Date.now() - 5 * 3_600_000),
                completed_at: null,
                errors: 0,
            }),
        ]);
        const body = await call({ view: 'latest', limit: 20 });
        expect(body.items[0].status).toBe('abandoned');
    });

    // `library_path_id = NULL` matches nothing. Without the translation to a
    // real `IS NULL` branch, expanding the "All libraries" row either returns
    // zero rows or falls through to every library's runs at once.
    it("translates the 'global' sentinel into a null scope, not a literal", async () => {
        await call({ view: 'history', limit: 10, library_path_id: 'global' });
        expect(mockRecent).toHaveBeenCalledWith(expect.anything(), 10, null, undefined);
    });

    it('passes a real library id straight through', async () => {
        const id = '11111111-2222-3333-4444-555555555555';
        await call({ view: 'history', limit: 10, library_path_id: id });
        expect(mockRecent).toHaveBeenCalledWith(expect.anything(), 10, id, undefined);
    });

    // Distinct from the sentinel: no filter at all still means every library.
    it('keeps an absent filter as undefined, not as the global scope', async () => {
        await call({ view: 'history', limit: 10 });
        expect(mockRecent).toHaveBeenCalledWith(expect.anything(), 10, undefined, undefined);
    });

    it('passes the library_group_id filter through to both views', async () => {
        const groupId = '99999999-8888-7777-6666-555555555555';
        await call({ view: 'latest', limit: 20, library_group_id: groupId });
        expect(mockLatest).toHaveBeenCalledWith(expect.anything(), groupId);

        await call({ view: 'history', limit: 10, library_group_id: groupId });
        expect(mockRecent).toHaveBeenCalledWith(expect.anything(), 10, undefined, groupId);
    });

    it('carries the joined library path through to the client', async () => {
        mockLatest.mockResolvedValue([row({ library_path: '/media/music' })]);
        const body = await call({ view: 'latest', limit: 20 });
        expect(body.items[0].libraryPath).toBe('/media/music');
    });

    // A deleted path leaves a dangling id. The field must be null rather than
    // absent: the client schema declares it `.nullable()`, and zod's
    // `.nullable()` rejects `undefined`, so dropping the projection turns
    // into an unhandled 500 on rows that otherwise look fine.
    it('emits a null library path rather than omitting it', async () => {
        mockLatest.mockResolvedValue([row({ library_path: null })]);
        const body = await call({ view: 'latest', limit: 20 });
        expect(body.items[0]).toHaveProperty('libraryPath');
        expect(body.items[0].libraryPath).toBeNull();
    });

    it('carries the stored error samples through', async () => {
        mockLatest.mockResolvedValue([row({ errors: 2, error_samples: ['a: x', 'b: y'] })]);
        const body = await call({ view: 'latest', limit: 20 });
        expect(body.items[0].errorSamples).toEqual(['a: x', 'b: y']);
    });

    // Every row written before the error_samples column exists reads as an
    // absent value on some driver paths; the client array must still be one.
    it('emits an empty sample array rather than null for an old row', async () => {
        mockLatest.mockResolvedValue([row({ error_samples: undefined })]);
        const body = await call({ view: 'latest', limit: 20 });
        expect(body.items[0].errorSamples).toEqual([]);
    });
});
