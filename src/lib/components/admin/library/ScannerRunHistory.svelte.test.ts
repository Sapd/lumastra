// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Scanner run history.
 *
 * The operator's complaint was that the table was unreadable: "it's not clear
 * why so many scans and files, what match rate means, which errors". All three
 * are properties of what the table CHOSE to render, so the tests below are
 * mostly about absence — no per-cycle row storm, no churn-as-match-rate, no
 * green on a healthy install — plus the two things that replaced them: a
 * library name on every row, and errors that lead somewhere.
 */

import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLatest, mockHistory } = vi.hoisted(() => ({
    mockLatest: vi.fn(),
    mockHistory: vi.fn(),
}));
vi.mock('$lib/api/admin.js', () => ({
    getLatestScannerRunPerLibrary: mockLatest,
    getScannerRuns: mockHistory,
}));

import ScannerRunHistory from './ScannerRunHistory.svelte';

function run(over: Record<string, unknown> = {}) {
    return {
        id: 'run-1',
        libraryPathId: 'lib-1',
        libraryPath: '/media/movies',
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
        completedAt: new Date(Date.now() - 3_470_000).toISOString(),
        totalFiles: 4000,
        matched: 12,
        updated: 3,
        added: 9,
        unmatched: 0,
        errors: 0,
        errorSamples: [],
        status: 'completed',
        durationMs: 130_000,
        matchRate: 0.3,
        createdAt: null,
        ...over,
    };
}

function latest(items: Record<string, unknown>[]) {
    mockLatest.mockResolvedValue({ data: { items }, error: null });
}

describe('ScannerRunHistory', () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(cleanup);

    it('renders nothing at all when there is no scan history', async () => {
        // A fresh install has never scanned; an empty table with headers would
        // be pure noise on the page.
        latest([]);
        const { container } = render(ScannerRunHistory, {});
        await waitFor(() => expect(container.querySelector('table')).toBeNull());
        expect(screen.queryByText('Recent scans')).toBeNull();
    });

    it('says so when the endpoint is broken, rather than looking empty', async () => {
        mockLatest.mockResolvedValue({ data: null, error: new Error('boom') });
        render(ScannerRunHistory, {});
        await waitFor(() =>
            expect(screen.getByText("Can't read the scan history right now.")).toBeTruthy(),
        );
    });

    // The whole "why are there so many scans" complaint: six library paths
    // emitted six anonymous near-identical rows per cycle, and the table
    // rendered no library identity to tell them apart.
    it('names the library on every row', async () => {
        latest([
            run({ id: 'a', libraryPathId: 'lib-a', libraryPath: '/media/movies' }),
            run({ id: 'b', libraryPathId: 'lib-b', libraryPath: '/media/music' }),
        ]);
        render(ScannerRunHistory, {});
        await waitFor(() => expect(screen.getByText(/\/media\/movies/)).toBeTruthy());
        expect(screen.getByText(/\/media\/music/)).toBeTruthy();
    });

    it('calls a global scan "All libraries", not a blank cell', async () => {
        latest([run({ libraryPathId: null, libraryPath: null })]);
        render(ScannerRunHistory, {});
        await waitFor(() => expect(screen.getByText(/All libraries/)).toBeTruthy());
    });

    // A run outlives the path it scanned. A dangling id with no joined path
    // must not render as an empty cell, which reads as a rendering bug.
    it('marks a run whose library path has since been deleted', async () => {
        latest([run({ libraryPathId: 'lib-gone', libraryPath: null })]);
        render(ScannerRunHistory, {});
        await waitFor(() => expect(screen.getByText(/\(removed path\)/)).toBeTruthy());
    });

    // The headline fix. `matchRate` is `matched / total_files * 100` over a
    // `matched` that means `added + updated`, so it measured churn: the
    // fixture's 4,000 fully-matched files that changed a little score 0.3%,
    // and the old table painted that red on a perfectly healthy library.
    it('never renders a match rate, in any form', async () => {
        latest([run({ matchRate: 0.3 })]);
        const { container } = render(ScannerRunHistory, {});
        await waitFor(() => expect(screen.getByText('4,000')).toBeTruthy());
        expect(container.textContent).not.toContain('%');
        expect(screen.queryByText('Match rate')).toBeNull();
        expect(screen.queryByText('Matched')).toBeNull();
        expect(screen.queryByText('Unmatched')).toBeNull();
    });

    it('states changes as absolute counts', async () => {
        latest([run({ added: 12, updated: 3 })]);
        render(ScannerRunHistory, {});
        await waitFor(() => expect(screen.getByText('+12 new · 3 updated')).toBeTruthy());
    });

    // The column counts FILES the scan walked — the same population the FILES
    // column totals — and it must say so. Headed "Changes" over "+N added" it
    // read as items, which is how `+6599 added` for a library of 823 media
    // items survived on the page for as long as it did. "added" went with the
    // header: the counter includes re-registered sidecars whose row merely
    // changed, and only "new" is true of the first number on its own.
    it('names the unit the change counts are in, so they cannot read as items', async () => {
        latest([run({ added: 12, updated: 3 })]);
        render(ScannerRunHistory, {});
        await waitFor(() => expect(screen.getByText('Files changed')).toBeTruthy());
        expect(screen.queryByText('Changes')).toBeNull();
        expect(screen.queryByText(/added/)).toBeNull();
    });

    // A library that changed nothing overnight is the healthy steady state and
    // scored 0% under the old column. Saying "no changes" is the reassurance;
    // a bare zero is not.
    it('reassures rather than reporting zero when nothing changed', async () => {
        latest([run({ added: 0, updated: 0 })]);
        const { container } = render(ScannerRunHistory, {});
        await waitFor(() => expect(screen.getByText(/no changes/)).toBeTruthy());
        expect(container.querySelector('.text-red-300')).toBeNull();
    });

    // No green anywhere: a healthy table is monochrome so the one red cell on
    // a bad morning is visible. Inverted check — this fails the moment any
    // success colouring is reintroduced.
    it('spends no colour at all on a healthy run', async () => {
        latest([run()]);
        const { container } = render(ScannerRunHistory, {});
        await waitFor(() => expect(screen.getByText('OK')).toBeTruthy());
        expect(container.querySelector('.text-emerald-300')).toBeNull();
        expect(container.querySelector('.text-red-300')).toBeNull();
        expect(container.querySelector('.text-sky-300')).toBeNull();
    });

    it('shows how long a completed run took, next to when it ran', async () => {
        latest([run({ durationMs: 130_000 })]);
        render(ScannerRunHistory, {});
        await waitFor(() => expect(screen.getByText(/2m 10s/)).toBeTruthy());
    });

    it('flags errors in red and nothing else', async () => {
        latest([run({ errors: 8, errorSamples: ['/media/movies/a.mkv: unreadable'] })]);
        const { container } = render(ScannerRunHistory, {});
        await waitFor(() => expect(screen.getByText('8 errors')).toBeTruthy());
        expect(container.querySelector('.text-red-300')).toBeTruthy();
    });

    // "Which errors" was unanswerable: only the COUNT was persisted and the
    // strings went to a TTL'd Valkey log buffer the row cannot reference.
    it('reveals which errors, from the samples stored on the run', async () => {
        latest([
            run({
                errors: 2,
                errorSamples: ['/media/movies/a.mkv: unreadable', '/media/movies/b.mkv: timeout'],
            }),
        ]);
        render(ScannerRunHistory, {});
        await waitFor(() => expect(screen.getByText('2 errors')).toBeTruthy());
        expect(screen.queryByText(/a\.mkv: unreadable/)).toBeNull();

        await fireEvent.click(screen.getByText('2 errors'));
        await waitFor(() => expect(screen.getByText(/a\.mkv: unreadable/)).toBeTruthy());
        expect(screen.getByText(/b\.mkv: timeout/)).toBeTruthy();
    });

    // Rendered inside the Result cell, the path list squeezed every other
    // column to a sliver and made one row screens tall.
    it('opens the error list in a full-width row of its own, not inside the Result cell', async () => {
        latest([run({ errors: 1, errorSamples: ['/media/movies/a.mkv: unreadable'] })]);
        render(ScannerRunHistory, {});
        await waitFor(() => expect(screen.getByText('1 error')).toBeTruthy());
        await fireEvent.click(screen.getByText('1 error'));

        const sample = await screen.findByText(/a\.mkv: unreadable/);
        const cell = sample.closest('td');
        expect(cell?.getAttribute('colspan')).toBe('5');
        expect(cell?.contains(screen.getByText('1 error'))).toBe(false);
    });

    // A U+FFFD in the path is a filename that is not valid UTF-8 on disk: the
    // scanner lists it under a lossy name it then cannot open. Older runs only
    // recorded "file processing failed", so the fix has to be spelled out here.
    it('tells the operator to rename a file whose name is not valid UTF-8', async () => {
        latest([
            run({
                errors: 1,
                errorSamples: ['/media/anime/S02E11 - Die Di\uFFFDt.mkv: file processing failed'],
            }),
        ]);
        render(ScannerRunHistory, {});
        await waitFor(() => expect(screen.getByText('1 error')).toBeTruthy());
        await fireEvent.click(screen.getByText('1 error'));
        await waitFor(() =>
            expect(screen.getByText(/isn't valid UTF-8 — rename the file/)).toBeTruthy(),
        );
    });

    // The samples are capped by the writer, so the list length is NOT the
    // error count. Without this line "8 errors" over a 2-item list reads as a
    // contradiction.
    it('admits when the sample list is shorter than the error count', async () => {
        latest([run({ errors: 137, errorSamples: ['a: x', 'b: y'] })]);
        render(ScannerRunHistory, {});
        await waitFor(() => expect(screen.getByText('137 errors')).toBeTruthy());
        await fireEvent.click(screen.getByText('137 errors'));
        await waitFor(() => expect(screen.getByText('showing 2 of 137')).toBeTruthy());
    });

    it('says plainly when an errored run recorded no samples', async () => {
        // Every run that predates the error_samples column is this case.
        latest([run({ errors: 4, errorSamples: [] })]);
        render(ScannerRunHistory, {});
        await waitFor(() => expect(screen.getByText('4 errors')).toBeTruthy());
        await fireEvent.click(screen.getByText('4 errors'));
        await waitFor(() =>
            expect(screen.getByText(/No error details were recorded/)).toBeTruthy(),
        );
    });

    it('shows a running scan as running, with no duration', async () => {
        latest([run({ status: 'running', completedAt: null, durationMs: null })]);
        const { container } = render(ScannerRunHistory, {});
        await waitFor(() => expect(screen.getByText(/Running/)).toBeTruthy());
        expect(container.querySelector('.text-sky-300')).toBeTruthy();
        expect(container.textContent).not.toContain('2m 10s');
    });

    // The abandonment sentinel is `errors = -1`. Rendering it through the
    // error-count branch produces "-1 errors", which is the exact wrong
    // sentence for a run that never finished. Status is checked first.
    it('renders an abandoned run as abandoned, never as "-1 errors"', async () => {
        latest([run({ status: 'abandoned', errors: -1 })]);
        const { container } = render(ScannerRunHistory, {});
        await waitFor(() => expect(screen.getByText('Abandoned')).toBeTruthy());
        expect(container.textContent).not.toContain('-1');
        expect(container.querySelector('.text-red-300')).toBeTruthy();
    });

    // A run can be abandoned while its row still says `errors = 0`: the -1
    // sentinel is only stamped by the next scan's sweep, so between the crash
    // and that sweep the server's own staleness rule is the only thing that
    // knows. Inverted check — a client that derived status from `errors`
    // alone would render "OK" here.
    it('trusts the server status over the row counters', async () => {
        latest([run({ status: 'abandoned', errors: 0, completedAt: null })]);
        render(ScannerRunHistory, {});
        await waitFor(() => expect(screen.getByText('Abandoned')).toBeTruthy());
        expect(screen.queryByText('OK')).toBeNull();
    });

    it('does not fetch any history until a library row is expanded', async () => {
        latest([run()]);
        render(ScannerRunHistory, {});
        await waitFor(() => expect(screen.getByText(/\/media\/movies/)).toBeTruthy());
        expect(mockHistory).not.toHaveBeenCalled();
    });

    it("fetches that library's own earlier runs when expanded", async () => {
        latest([run({ libraryPathId: 'lib-9' })]);
        mockHistory.mockResolvedValue({
            data: { items: [run({ id: 'older', added: 40, updated: 1 })] },
            error: null,
        });
        render(ScannerRunHistory, { historyLimit: 5 });
        await waitFor(() => expect(screen.getByText(/\/media\/movies/)).toBeTruthy());

        await fireEvent.click(screen.getByTitle('Show recent runs for this library'));
        await waitFor(() => expect(mockHistory).toHaveBeenCalledWith(5, 'lib-9'));
        await waitFor(() => expect(screen.getByText('+40 new · 1 updated')).toBeTruthy());
    });

    // Sending no filter would return EVERY library's runs under a heading
    // claiming to be one library's history. `= NULL` matches nothing, so the
    // "runs with no library path" request needs its own sentinel.
    it("scopes the global row's history to global runs, not to everything", async () => {
        latest([run({ libraryPathId: null, libraryPath: null })]);
        mockHistory.mockResolvedValue({ data: { items: [] }, error: null });
        render(ScannerRunHistory, { historyLimit: 7 });
        await waitFor(() => expect(screen.getByText(/All libraries/)).toBeTruthy());

        await fireEvent.click(screen.getByTitle('Show recent runs for this library'));
        await waitFor(() => expect(mockHistory).toHaveBeenCalledWith(7, 'global'));
    });

    // Without the early return, collapsing sets the open row to null and then
    // immediately reassigns it — the row can be opened but never closed.
    it('collapses an expanded row on a second click', async () => {
        latest([run()]);
        mockHistory.mockResolvedValue({
            data: { items: [run({ id: 'older', added: 40, updated: 1 })] },
            error: null,
        });
        render(ScannerRunHistory, {});
        await waitFor(() => expect(screen.getByText(/\/media\/movies/)).toBeTruthy());

        await fireEvent.click(screen.getByTitle('Show recent runs for this library'));
        await waitFor(() => expect(screen.getByText('+40 new · 1 updated')).toBeTruthy());

        await fireEvent.click(screen.getByTitle('Show recent runs for this library'));
        await waitFor(() => expect(screen.queryByText('+40 new · 1 updated')).toBeNull());
    });

    it('does not refetch a library whose history it already has', async () => {
        latest([run()]);
        mockHistory.mockResolvedValue({ data: { items: [run({ id: 'older' })] }, error: null });
        render(ScannerRunHistory, {});
        await waitFor(() => expect(screen.getByText(/\/media\/movies/)).toBeTruthy());

        const toggle = () => screen.getByTitle('Show recent runs for this library');
        await fireEvent.click(toggle());
        await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(1));
        await fireEvent.click(toggle()); // collapse
        await fireEvent.click(toggle()); // expand again, from cache
        await waitFor(() => expect(screen.getByText('Duration')).toBeTruthy());
        expect(mockHistory).toHaveBeenCalledTimes(1);
    });

    it('reports a failed history fetch instead of showing an empty sub-table', async () => {
        latest([run()]);
        mockHistory.mockResolvedValue({ data: null, error: new Error('boom') });
        render(ScannerRunHistory, {});
        await waitFor(() => expect(screen.getByText(/\/media\/movies/)).toBeTruthy());

        await fireEvent.click(screen.getByTitle('Show recent runs for this library'));
        await waitFor(() =>
            expect(screen.getByText("Can't read this library's runs right now.")).toBeTruthy(),
        );
    });
});
