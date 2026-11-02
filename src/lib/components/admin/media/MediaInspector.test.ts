// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Behavioral tests for MediaInspector — the two presentations, the
 * single-line summary announcement, the registry-driven action list, and the
 * id+updatedAt preview cache.
 *
 * `getMediaPreview` ($lib/api/admin) is mocked so tests control the fetch
 * without network I/O while exercising the real modal presentation.
 */

import { render, screen, waitFor, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import MediaInspector from './MediaInspector.svelte';
import { audioTailAssessmentFixture } from './audio-tail-assessment.fixture.js';
import type { MediaInspectorItem } from './media-inspector-types.js';
import {
    clearPreviewCache,
    getCachedPreview,
    setCachedPreview,
    previewCacheSizeForTest,
} from './media-inspector-cache.js';
import type { MediaPreviewResponse } from '$lib/schemas/api-admin-responses';

vi.mock('$lib/api/admin', () => ({
    getMediaPreview: vi.fn(),
}));

import { getMediaPreview } from '$lib/api/admin';

function makeItem(overrides: Partial<MediaInspectorItem> = {}): MediaInspectorItem {
    return {
        id: 'item-1',
        title: 'Some Movie',
        mediaType: 'movie',
        updatedAt: '2026-08-01T00:00:00.000Z',
        hasFiles: true,
        childCount: 0,
        metadataLocked: false,
        isUnidentifiedDomain: false,
        supportsProviderIdentity: true,
        ...overrides,
    };
}

function makePreviewData(overrides: Partial<MediaPreviewResponse> = {}): MediaPreviewResponse {
    return {
        id: 'item-1',
        title: 'Some Movie',
        overview: null,
        year: 2020,
        media_type: 'movie',
        runtime_seconds: null,
        premiere_date: null,
        externalIds: {},
        fileCount: 1,
        totalFileSize: 1000,
        filePaths: ['/data/movies/foo.mkv'],
        ...overrides,
    };
}

beforeEach(() => {
    vi.mocked(getMediaPreview).mockReset();
    clearPreviewCache();
});

afterEach(() => {
    cleanup();
});

describe('MediaInspector — docked vs modal presentation', () => {
    it('docked presentation carries no dialog role and no aria-modal anywhere', () => {
        // Regression this guards: if the docked branch ever reused the modal
        // markup (or a shared wrapper stopped branching on `docked`), the
        // table beside it would become inert behind a real dialog.
        vi.mocked(getMediaPreview).mockResolvedValue({
            data: makePreviewData(),
            error: null,
            status: 200,
        });
        render(MediaInspector, {
            item: makeItem(),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.querySelector('[aria-modal]')).toBeNull();
    });

    it('modal presentation carries role="dialog" and aria-modal="true"', () => {
        vi.mocked(getMediaPreview).mockResolvedValue({
            data: makePreviewData(),
            error: null,
            status: 200,
        });
        render(MediaInspector, {
            item: makeItem(),
            docked: false,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        const dialog = screen.getByRole('dialog');
        expect(dialog.getAttribute('aria-modal')).toBe('true');
    });
});

describe('MediaInspector — one-line summary announcement', () => {
    it('announces "title · type · state" and updates it when the item changes', async () => {
        vi.mocked(getMediaPreview).mockResolvedValue({
            data: makePreviewData(),
            error: null,
            status: 200,
        });
        const { rerender, container } = render(MediaInspector, {
            item: makeItem({ title: 'Movie A', hasFiles: true }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        const live = container.querySelector('[aria-live="polite"]');
        expect(live).not.toBeNull();
        expect(live?.textContent).toBe('Movie A · Movie · Files available');

        await rerender({
            item: makeItem({ id: 'item-2', title: 'Movie B', hasFiles: false }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        expect(live?.textContent).toBe('Movie B · Movie · No files available');
    });

    it('announces the public media type, not the raw DB value ("series", not "tv")', () => {
        // Fix-round finding #10: the summary used to read `item.mediaType`
        // verbatim, so a series announced as "tv". Fails if the summary ever
        // reverts to the raw internal value.
        vi.mocked(getMediaPreview).mockResolvedValue({
            data: makePreviewData({ media_type: 'series' }),
            error: null,
            status: 200,
        });
        const { container } = render(MediaInspector, {
            item: makeItem({ mediaType: 'tv', title: 'Some Show' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        const live = container.querySelector('[aria-live="polite"]');
        expect(live?.textContent).toBe('Some Show · Series · Files available');
        // The visible header label must match — no split-brain between what
        // is announced and what is shown.
        expect(screen.getByText('Series')).toBeTruthy();
    });

    it('keeps the rest of the panel out of the live region', async () => {
        // The hazard this spec calls out by name: wrapping the whole panel in
        // aria-live re-announces every field on every arrow key. Only the
        // dedicated summary node may carry aria-live.
        vi.mocked(getMediaPreview).mockResolvedValue({
            data: makePreviewData(),
            error: null,
            status: 200,
        });
        const { container } = render(MediaInspector, {
            item: makeItem(),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        // Wait for the fetched body to actually render — asserted too early
        // (still in the `{:else if preview}`'s un-taken loading branch) this
        // count is trivially 1 no matter what the body does, so it cannot
        // catch a future `aria-live` added to, say, the Health section.
        await waitFor(() => expect(screen.getByText('File findings')).toBeTruthy());

        expect(container.querySelectorAll('[aria-live]').length).toBe(1);
    });
});

describe('MediaInspector — actions from the registry', () => {
    it('renders actions computed via actionsFor({ surface: "inspector" }), not a hand-rolled list', async () => {
        // Fix-round finding #4: a movie-with-files fixture yields an
        // IDENTICAL action set under 'inspector' and 'detail' (the registry's
        // `watch` rule's first clause covers both), so that fixture cannot
        // tell the two surfaces apart — flipping the literal 'inspector'
        // string in the component to 'detail' left the old version of this
        // test green. A `tv` item with `hasFiles: false` DOES discriminate:
        // `watch.appliesTo` only grants a watchable-container type (tv,
        // season) when `surface !== 'detail'`, and the has-files clause
        // doesn't apply (tv is not in WATCHABLE_TYPES), so 'detail' would
        // drop Watch entirely for this exact item.
        vi.mocked(getMediaPreview).mockResolvedValue({
            data: makePreviewData({ media_type: 'series' }),
            error: null,
            status: 200,
        });
        render(MediaInspector, {
            item: makeItem({ mediaType: 'tv', hasFiles: false }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        await waitFor(() => expect(screen.getByRole('button', { name: 'Watch' })).toBeTruthy());
    });

    it('omits identify for an already-identified item, per the registry rule', async () => {
        vi.mocked(getMediaPreview).mockResolvedValue({
            data: makePreviewData(),
            error: null,
            status: 200,
        });
        render(MediaInspector, {
            item: makeItem({ isUnidentifiedDomain: false }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        await waitFor(() => expect(screen.getByRole('button', { name: 'Watch' })).toBeTruthy());
        expect(screen.queryByRole('button', { name: 'Choose online match' })).toBeNull();
    });

    /**
     * Revert-check: render `actions` in one row again and this fails — Delete
     * is then a sibling of Watch instead of sitting in its own block.
     */
    it('puts Delete in a separate danger block, away from Watch', async () => {
        vi.mocked(getMediaPreview).mockResolvedValue({
            data: makePreviewData(),
            error: null,
            status: 200,
        });
        render(MediaInspector, {
            item: makeItem(),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        const watch = await screen.findByRole('button', { name: 'Watch' });
        const del = screen.getByRole('button', { name: 'Delete' });
        const danger = screen.getByTestId('inspector-danger-actions');
        expect(danger.contains(del)).toBe(true);
        expect(danger.contains(watch)).toBe(false);
    });
});

describe('MediaInspector — ancestry (fix-round finding #6)', () => {
    it('prefers row-level ancestry over the fetched parent chain', async () => {
        vi.mocked(getMediaPreview).mockResolvedValue({
            // The fetched preview carries the OLD episode-only ancestry — the
            // row-level fields must win when both are present.
            data: makePreviewData({
                parentTitle: 'Fetched Season',
                grandparentTitle: 'Fetched Series',
            }),
            error: null,
            status: 200,
        });
        render(MediaInspector, {
            item: makeItem({
                mediaType: 'episode',
                seriesTitle: 'Row Series',
                seasonTitle: 'Row Season',
            }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        await waitFor(() => expect(screen.getByText('Row Series → Row Season')).toBeTruthy());
        expect(screen.queryByText(/Fetched Series/)).toBeNull();
    });

    it('shows ancestry for a track/season even though it is not an episode', async () => {
        // Fix-round finding #6: ancestry used to be gated on `isEpisode`, so
        // a track or season showed nothing even when the parent chain query
        // had already fetched parentTitle/grandparentTitle. Fails if the
        // `isEpisode` gate ever comes back.
        vi.mocked(getMediaPreview).mockResolvedValue({
            data: makePreviewData({
                media_type: 'track',
                parentTitle: 'Some Album',
                grandparentTitle: 'Some Artist',
            }),
            error: null,
            status: 200,
        });
        render(MediaInspector, {
            item: makeItem({ mediaType: 'track' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        await waitFor(() => expect(screen.getByText('Some Artist → Some Album')).toBeTruthy());
    });
});

describe('MediaInspector — state section (fix-round findings #2, #8)', () => {
    it('shows the real duration gap for a truncated_video issue with no detail', async () => {
        // Fix-round finding #2: fileHealthIssueReason reads snake_case
        // (expected_duration/actual_duration); this schema's healthIssues[]
        // is camelCase. Unmapped, a probe-written truncated_video with only
        // durations (no `detail`) rendered "0s ... 0s" instead of the real
        // numbers. Fails if the call site stops mapping the field names.
        vi.mocked(getMediaPreview).mockResolvedValue({
            data: makePreviewData({
                healthIssues: [
                    { type: 'truncated_video', expectedDuration: 7200, actualDuration: 5400 },
                ],
            }),
            error: null,
            status: 200,
        });
        render(MediaInspector, {
            item: makeItem(),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        await waitFor(() =>
            expect(
                screen.getByText(/video stops at 5400s; the container reports 7200s/),
            ).toBeTruthy(),
        );
        expect(screen.queryByText(/0s but container reports 0s/)).toBeNull();
    });

    it('renders filesLostAt in the availability line', async () => {
        // Fix-round finding #8: filesLostAt was plumbed through the query,
        // schema, and type, but never rendered anywhere.
        vi.mocked(getMediaPreview).mockResolvedValue({
            data: makePreviewData({ filesLostAt: '2026-08-10T00:00:00.000Z' }),
            error: null,
            status: 200,
        });
        render(MediaInspector, {
            item: makeItem({ hasFiles: false }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        await waitFor(() => expect(screen.getByText(/lost/)).toBeTruthy());
    });
});

describe('media-inspector-cache — one entry per id, keyed on updatedAt', () => {
    it('treats a different updatedAt as a cache miss, so a mutation busts its own entry', () => {
        const data = makePreviewData();
        setCachedPreview('item-1', '2026-08-01T00:00:00.000Z', data);

        expect(getCachedPreview('item-1', '2026-08-01T00:00:00.000Z')).toBe(data);
        // Same id, newer updatedAt (as after a sync/edit) — must NOT hit.
        expect(getCachedPreview('item-1', '2026-08-02T00:00:00.000Z')).toBeUndefined();
    });

    it('replaces the entry for an id when updatedAt changes, rather than accumulating one per version', () => {
        // Fix-round finding #9: an earlier version of this cache keyed the
        // backing Map by `id::updatedAt`, so re-viewing an item after it
        // changed added a SECOND entry instead of replacing the first —
        // arrow-walking a large library across a session-long edit history
        // would grow the map without bound. Fails if the composite-key
        // scheme comes back.
        setCachedPreview('item-1', 't1', makePreviewData());
        setCachedPreview('item-1', 't2', makePreviewData());

        expect(previewCacheSizeForTest()).toBe(1);
        expect(getCachedPreview('item-1', 't1')).toBeUndefined();
        expect(getCachedPreview('item-1', 't2')).toBeDefined();
    });

    it('clearPreviewCache empties every entry', () => {
        setCachedPreview('item-1', 't1', makePreviewData());
        expect(previewCacheSizeForTest()).toBeGreaterThan(0);

        clearPreviewCache();

        expect(previewCacheSizeForTest()).toBe(0);
        expect(getCachedPreview('item-1', 't1')).toBeUndefined();
    });
});

describe('MediaInspector — prefetch debounce', () => {
    it('coalesces rapid item changes into a single fetch for the settled item', async () => {
        vi.mocked(getMediaPreview).mockResolvedValue({
            data: makePreviewData(),
            error: null,
            status: 200,
        });

        const { rerender } = render(MediaInspector, {
            item: makeItem({ id: 'a', updatedAt: 't1' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });
        await rerender({
            item: makeItem({ id: 'b', updatedAt: 't1' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });
        await rerender({
            item: makeItem({ id: 'c', updatedAt: 't1' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        // Only the item the operator settled on (id 'c') should ever reach
        // the network — arrow-walking through 'a' and 'b' must not each fire
        // their own request.
        await waitFor(() => expect(getMediaPreview).toHaveBeenCalledTimes(1));
        expect(getMediaPreview).toHaveBeenCalledWith('c');
    });
});

describe('MediaInspector — stale in-flight preview must never paint (B3)', () => {
    it('does not render item A’s payload after the operator has moved to item B', async () => {
        // THE WINDOW, precisely. Item A's request is in flight; the operator
        // arrows to an UNCACHED item B; A resolves BEFORE B's 150ms debounce
        // has even fired a request. Before the fix the effect bumped
        // `fetchToken` only on the CACHED path, so at that instant the token
        // was still A's, A's response passed its own staleness guard, and A's
        // fields painted under B's title.
        //
        // The ordering below is load-bearing: A must be resolved while B is
        // still debouncing. If B's fetch is allowed to start first it takes
        // the token itself and the old code passes too — which is exactly how
        // this survived the first round of tests.
        let resolveA: (v: Awaited<ReturnType<typeof getMediaPreview>>) => void = () => {};
        vi.mocked(getMediaPreview).mockImplementation((id: string) => {
            if (id === 'a') {
                return new Promise((resolve) => {
                    resolveA = resolve;
                }) as ReturnType<typeof getMediaPreview>;
            }
            return Promise.resolve({
                data: makePreviewData({ id: 'b', overview: 'OVERVIEW-OF-B' }),
                error: null,
                status: 200,
            }) as ReturnType<typeof getMediaPreview>;
        });

        const { rerender, container } = render(MediaInspector, {
            item: makeItem({ id: 'a', title: 'Item A', updatedAt: 't1' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        // A's request is genuinely in flight before we switch away.
        await waitFor(() => expect(getMediaPreview).toHaveBeenCalledWith('a'));

        await rerender({
            item: makeItem({ id: 'b', title: 'Item B', updatedAt: 't1' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        // B is still inside its debounce here — no second call yet.
        expect(getMediaPreview).toHaveBeenCalledTimes(1);

        resolveA({
            data: makePreviewData({ id: 'a', overview: 'OVERVIEW-OF-A' }),
            error: null,
            status: 200,
        });
        // Flush the awaiting continuation in fetchPreview, THEN Svelte's
        // render. Both are required and the second is the one that bites:
        // measured against the reverted component, two bare microtasks leave
        // the DOM still reading "Loading…" — the stale payload has been
        // assigned but not yet painted — so a version of this test that
        // stopped at `await Promise.resolve()` passed against the BUG. `tick()`
        // resolves after the flush, and still lands far inside B's 150ms
        // debounce, which is what keeps the window open.
        await Promise.resolve();
        await tick();

        // THE assertion. Under the bug this reads 'OVERVIEW-OF-A' while the
        // header reads "Item B".
        expect(container.textContent).not.toContain('OVERVIEW-OF-A');
        expect(container.textContent).toContain('Item B');

        // ...and B still lands normally once its own debounce elapses.
        await waitFor(() => expect(container.textContent).toContain('OVERVIEW-OF-B'));
        expect(container.textContent).not.toContain('OVERVIEW-OF-A');
    });

    it('shows no previous-item body at all while the new item is still loading', async () => {
        // Companion invariant: between items, the panel shows the loading
        // state, never the outgoing item's fields under the incoming title.
        //
        // HONEST SCOPE, because it was measured. Two things in the effect
        // could enforce this — `preview = null` and `loading = true` — and
        // only the second is observable: the template gates the whole body
        // behind `{#if loading}`, so deleting `preview = null` alone changes
        // NOTHING in the DOM and this test cannot see it (verified by
        // reverting that line: 22/22 still passed). What this test does catch
        // is the `loading = true` going away, or both going away together.
        // `preview = null` stays in the component as a local invariant rather
        // than a tested one, and is documented there as such.
        vi.mocked(getMediaPreview).mockImplementation((id: string) => {
            if (id === 'a') {
                return Promise.resolve({
                    data: makePreviewData({ id: 'a', overview: 'OVERVIEW-OF-A' }),
                    error: null,
                    status: 200,
                }) as ReturnType<typeof getMediaPreview>;
            }
            return new Promise(() => {}) as ReturnType<typeof getMediaPreview>; // never resolves
        });

        const { rerender, container } = render(MediaInspector, {
            item: makeItem({ id: 'a', title: 'Item A', updatedAt: 't1' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        await waitFor(() => expect(container.textContent).toContain('OVERVIEW-OF-A'));

        await rerender({
            item: makeItem({ id: 'b', title: 'Item B', updatedAt: 't1' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        expect(container.textContent).not.toContain('OVERVIEW-OF-A');
        expect(container.textContent).toContain('Loading');
    });
});

describe('MediaInspector — identity detail the inline preview row used to show (B1)', () => {
    it('renders every external id, and links the two whose URL is unambiguous', async () => {
        vi.mocked(getMediaPreview).mockResolvedValue({
            data: makePreviewData({
                externalIds: {
                    tmdb: '550',
                    imdb: 'tt0137523',
                    tvdb: '77777',
                    jellyfin: 'abc123def',
                },
            }),
            error: null,
            status: 200,
        });
        render(MediaInspector, {
            item: makeItem({ mediaType: 'movie' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        // All four VALUES reach the panel — the inline row printed all four
        // and the inspector printed none of them.
        await waitFor(() => expect(screen.getByText('550')).toBeTruthy());
        expect(screen.getByText('tt0137523')).toBeTruthy();
        expect(screen.getByText('77777')).toBeTruthy();
        expect(screen.getByText('abc123def')).toBeTruthy();

        // The two links must point at THEIR OWN id — a cross-wired href
        // (tmdb's path carrying imdb's value) would still render four ids.
        expect(screen.getByRole('link', { name: '550' }).getAttribute('href')).toBe(
            'https://www.themoviedb.org/movie/550',
        );
        expect(screen.getByRole('link', { name: 'tt0137523' }).getAttribute('href')).toBe(
            'https://www.imdb.com/title/tt0137523/',
        );

        // TVDB and Jellyfin have no id-only canonical URL — selectable text,
        // never a link that 404s.
        expect(screen.queryByRole('link', { name: '77777' })).toBeNull();
        expect(screen.queryByRole('link', { name: 'abc123def' })).toBeNull();
    });

    it('uses TMDB’s /tv/ path for a series and no link at all for an episode', async () => {
        // TMDB namespaces by kind. Getting this wrong sends the operator to an
        // unrelated title, which is worse than the regression being fixed.
        vi.mocked(getMediaPreview).mockResolvedValue({
            data: makePreviewData({ media_type: 'series', externalIds: { tmdb: '1396' } }),
            error: null,
            status: 200,
        });
        const { unmount } = render(MediaInspector, {
            item: makeItem({ mediaType: 'tv' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        await waitFor(() =>
            expect(screen.getByRole('link', { name: '1396' }).getAttribute('href')).toBe(
                'https://www.themoviedb.org/tv/1396',
            ),
        );
        unmount();

        vi.mocked(getMediaPreview).mockResolvedValue({
            data: makePreviewData({ media_type: 'episode', externalIds: { tmdb: '62085' } }),
            error: null,
            status: 200,
        });
        render(MediaInspector, {
            item: makeItem({ id: 'ep-1', mediaType: 'episode' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        // Still SHOWN — just not linked.
        await waitFor(() => expect(screen.getByText('62085')).toBeTruthy());
        expect(screen.queryByRole('link', { name: '62085' })).toBeNull();
    });

    it('renders runtime and premiere date alongside the year', async () => {
        vi.mocked(getMediaPreview).mockResolvedValue({
            data: makePreviewData({
                runtime_seconds: 5400,
                year: 1999,
                premiere_date: '2001-10-15',
            }),
            error: null,
            status: 200,
        });
        const { container } = render(MediaInspector, {
            item: makeItem(),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        // "1h 30m", not "5400" and not "90m" — a runtime field cross-wired to
        // the year (or a seconds/minutes mixup) changes this string.
        await waitFor(() => expect(container.textContent).toContain('Duration: 1h 30m'));
        expect(container.textContent).toContain('Year: 1999');
        expect(container.textContent).toContain('First released:');
        // The premiere line must carry the premiere date's year, not the
        // item's `year` column — the two differ here on purpose.
        expect(container.textContent).toMatch(/First released:[^·]*2001/);
    });

    it('shows per-season episode and linked counts, not just a season count', async () => {
        vi.mocked(getMediaPreview).mockResolvedValue({
            data: makePreviewData({
                media_type: 'series',
                seasons: [
                    { seasonNumber: 1, episodeCount: 10, linkedCount: 10 },
                    { seasonNumber: 2, episodeCount: 8, linkedCount: 3 },
                    { seasonNumber: 3, episodeCount: 6, linkedCount: 0 },
                ],
            }),
            error: null,
            status: 200,
        });
        const { container } = render(MediaInspector, {
            item: makeItem({ mediaType: 'tv' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        await waitFor(() => expect(container.textContent).toContain('3 seasons'));

        // Exact per-season strings: swapping episodeCount and linkedCount, or
        // pointing both at the same field, changes all three of these.
        const text = container.textContent ?? '';
        expect(text).toContain('Season 1:');
        expect(text).toMatch(/Season 1:\s*10 episodes\s*\(10 linked — All linked\)/);
        expect(text).toMatch(/Season 2:\s*8 episodes\s*\(3 linked — Some files linked\)/);
        expect(text).toMatch(/Season 3:\s*6 episodes\s*\(0 linked — No files linked\)/);
    });

    it('shows audio features for a track and withholds them from a movie', async () => {
        vi.mocked(getMediaPreview).mockResolvedValue({
            data: makePreviewData({
                media_type: 'track',
                audioFeatures: { bpm: 128, key: 'A minor', energy: 0.82 },
            }),
            error: null,
            status: 200,
        });
        const { unmount, container } = render(MediaInspector, {
            item: makeItem({ mediaType: 'track' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        await waitFor(() => expect(container.textContent).toContain('BPM: 128'));
        expect(container.textContent).toContain('Musical key: A minor');
        expect(container.textContent).toContain('Energy: 0.82');
        unmount();

        // Same payload, non-music item: the block is gated on the item's type,
        // so a stray `essentia` key on a film never renders a BPM row. This
        // half fails if the gate is deleted; the half above fails if it is
        // inverted.
        vi.mocked(getMediaPreview).mockResolvedValue({
            data: makePreviewData({
                audioFeatures: { bpm: 128, key: 'A minor', energy: 0.82 },
            }),
            error: null,
            status: 200,
        });
        const second = render(MediaInspector, {
            item: makeItem({ id: 'film-1', mediaType: 'movie' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        await waitFor(() => expect(screen.getByText('File findings')).toBeTruthy());
        expect(second.container.textContent).not.toContain('BPM');
    });
});

describe('MediaInspector — artwork', () => {
    // ⚠️ WHAT THESE CANNOT PROVE. happy-dom has no layout engine and never
    // loads an image, so nothing below establishes that the artwork *looks*
    // right, that it fits inside the panel, that the height cap actually
    // bites, or that a collapsed fallback is visually invisible. They assert
    // the attributes and structure the component emits — the URL it asks for,
    // which element the artwork is a child of, whether an element exists at
    // all — and stop there. The `max-h-…` assertion in particular checks that
    // a cap is REQUESTED, not that it constrains anything.

    function artwork(): HTMLImageElement | null {
        return document.querySelector<HTMLImageElement>('[data-testid="inspector-artwork"]');
    }

    beforeEach(() => {
        vi.mocked(getMediaPreview).mockResolvedValue({
            data: makePreviewData(),
            error: null,
            status: 200,
        });
    });

    it('shows the count of findings omitted by the preview limit', async () => {
        vi.mocked(getMediaPreview).mockResolvedValue({
            data: makePreviewData({
                healthIssues: [{ type: 'no_keyframes' }],
                healthIssuesOmitted: 13,
            }),
            error: null,
            status: 200,
        });
        render(MediaInspector, {
            item: makeItem(),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });
        expect(await screen.findByText('and 13 more findings')).toBeTruthy();
    });

    it('asks for the backdrop of a movie, full-width and capped, with the placeholder suppressed', () => {
        render(MediaInspector, {
            item: makeItem({ id: 'movie-7', mediaType: 'movie' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        const img = artwork();
        expect(img).not.toBeNull();
        expect(img?.getAttribute('data-artwork-role')).toBe('backdrop');
        expect(img?.getAttribute('src')).toContain('/api/media/movie-7/images/backdrop');
        expect(img?.getAttribute('src')).toContain('size=card');
        // Without `fallback=none` a miss answers 302 → popcorn placeholder,
        // which LOADS: `onerror` never fires, so the collapse below can never
        // happen and the panel shows a graphic that is not the item.
        expect(img?.getAttribute('src')).toContain('fallback=none');
        expect(img?.className).toContain('w-full');
        expect(img?.className).toContain('max-h-[min(30dvh,15rem)]');
    });

    it('renders no image element at all for a type with no artwork worth asking for', () => {
        // A bookkeeping row has no artwork by construction. "Collapses to
        // nothing" has to mean no element — a hidden or empty box would still
        // occupy the slot and still cost a 404 per arrow key.
        render(MediaInspector, {
            item: makeItem({ id: 'sonarr-1', mediaType: 'sonarr' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        expect(artwork()).toBeNull();
    });

    it('steps to the poster when the backdrop 404s, then collapses to nothing', async () => {
        render(MediaInspector, {
            item: makeItem({ id: 'movie-7', mediaType: 'movie' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        artwork()?.dispatchEvent(new Event('error'));
        await tick();

        const poster = artwork();
        expect(poster?.getAttribute('data-artwork-role')).toBe('poster');
        expect(poster?.getAttribute('src')).toContain('/api/media/movie-7/images/poster');
        // The inline shape: a fixed narrow column, not a full-width band
        // cropped out of the middle of a poster.
        expect(poster?.className).toContain('w-[120px]');
        expect(poster?.className).not.toContain('w-full');

        poster?.dispatchEvent(new Event('error'));
        await tick();

        expect(artwork()).toBeNull();
    });

    it('builds a fresh element when the item changes, so row N cannot paint under row N+1', async () => {
        const { rerender } = render(MediaInspector, {
            item: makeItem({ id: 'movie-7', mediaType: 'movie' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        const first = artwork();
        expect(first?.getAttribute('src')).toContain('/api/media/movie-7/');

        await rerender({
            item: makeItem({ id: 'movie-8', mediaType: 'movie' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        const second = artwork();
        expect(second?.getAttribute('src')).toContain('/api/media/movie-8/');
        // Node IDENTITY, not just the src: reusing the element and swapping
        // `src` leaves the previous image painted until the new one decodes,
        // which on arrow-walk is exactly the stale frame under a new title.
        // Only a `{#key}` (or equivalent) makes this a different node.
        expect(second).not.toBe(first);
    });

    it('resets to the first candidate on a new item after the previous one fell back', async () => {
        const { rerender } = render(MediaInspector, {
            item: makeItem({ id: 'movie-7', mediaType: 'movie' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        artwork()?.dispatchEvent(new Event('error'));
        await tick();
        expect(artwork()?.getAttribute('data-artwork-role')).toBe('poster');

        await rerender({
            item: makeItem({ id: 'movie-8', mediaType: 'movie' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        // The fallback index is tagged with the item it belongs to, so a new
        // item starts at candidate 0. If the index were plain state reset from
        // an $effect, item 8 would render one frame at item 7's poster role —
        // and if it were never reset, permanently.
        expect(artwork()?.getAttribute('data-artwork-role')).toBe('backdrop');
    });

    it('ignores an error event that belongs to a superseded item', async () => {
        const { rerender } = render(MediaInspector, {
            item: makeItem({ id: 'movie-7', mediaType: 'movie' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        const stale = artwork();

        await rerender({
            item: makeItem({ id: 'movie-8', mediaType: 'movie' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        // Item 7's element is gone from the document but the handler closure
        // is still reachable; a late `error` from that request must not push
        // item 8 past a candidate it never tried.
        stale?.dispatchEvent(new Event('error'));
        await tick();

        expect(artwork()?.getAttribute('data-artwork-role')).toBe('backdrop');
        expect(artwork()?.getAttribute('src')).toContain('/api/media/movie-8/');
    });

    it('puts the artwork in the same scroll container as the action buttons', async () => {
        render(MediaInspector, {
            item: makeItem({ id: 'movie-7', mediaType: 'movie' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        await waitFor(() => expect(screen.getByText('Actions')).toBeTruthy());

        const img = artwork();
        expect(img).not.toBeNull();
        const actionsHeading = screen.getByText('Actions');
        const buttons = actionsHeading.parentElement?.querySelectorAll('button') ?? [];
        expect(buttons.length).toBeGreaterThan(0);

        // Reachability is structural, not visual: because the artwork is a
        // sibling of the Actions section INSIDE the scrolling body — rather
        // than in the fixed header above it — however tall the artwork gets,
        // Actions can still be scrolled to. Moving the artwork into the
        // header would break this without changing a single style.
        const scroller = img?.closest('.overflow-y-auto');
        expect(scroller).not.toBeNull();
        expect(actionsHeading.closest('.overflow-y-auto')).toBe(scroller);
    });

    it('paints artwork while the preview fetch is still in flight', async () => {
        // The artwork derives from the row, so it must not sit behind the
        // debounced fetch's loading gate: on arrow-walk the identity check
        // should be there immediately, not 150ms later.
        vi.mocked(getMediaPreview).mockReturnValue(new Promise(() => {}));
        render(MediaInspector, {
            item: makeItem({ id: 'movie-7', mediaType: 'movie' }),
            docked: true,
            onclose: vi.fn(),
            onaction: vi.fn(),
        });

        await tick();
        expect(screen.getByText('Loading…')).toBeTruthy();
        expect(artwork()).not.toBeNull();
    });
});

it('switches the real inspector’s audio diagnosis and raw file evidence with the selected item', async () => {
    vi.mocked(getMediaPreview).mockImplementation(async (id: string) => ({
        data: makePreviewData({
            id,
            filePaths: [`/fictional/${id}.mkv`],
            tailAssessments: [
                {
                    fileId: `file-${id}`,
                    assessment: audioTailAssessmentFixture(
                        `file-${id}`,
                        id === 'a' ? 'near_silent' : 'audible',
                    ),
                },
            ],
        }),
        error: null,
        status: 200,
    }));
    const view = render(MediaInspector, {
        item: makeItem({ id: 'a', title: 'Silent fixture' }),
        docked: true,
        onclose: vi.fn(),
        onaction: vi.fn(),
    });
    await screen.findByText(/All measured channels stayed at or below/);
    expect(screen.getByText(/File completeness remains unverified/)).toBeTruthy();
    let details = screen.getByText('Measurement details').closest('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('fixture-physical-file-a');
    expect(details.textContent).not.toContain('fixture-physical-file-b');
    expect(screen.getByText('/fictional/a.mkv')).toBeTruthy();
    await view.rerender({
        item: makeItem({ id: 'b', title: 'Audible fixture' }),
        docked: true,
        onclose: vi.fn(),
        onaction: vi.fn(),
    });
    await screen.findByText(/Audio was observed after the video ended/);
    expect(screen.queryByText(/All measured channels stayed at or below/)).toBeNull();
    expect(screen.getByText(/File completeness remains unverified/)).toBeTruthy();
    details = screen.getByText('Measurement details').closest('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('fixture-physical-file-b');
    expect(details.textContent).not.toContain('fixture-physical-file-a');
    expect(screen.getByText('/fictional/b.mkv')).toBeTruthy();
    expect(screen.queryByText('/fictional/a.mkv')).toBeNull();
});

it('uses current duration acceptance when another warning keeps the file actionable', async () => {
    vi.mocked(getMediaPreview).mockResolvedValue({
        data: makePreviewData({
            healthIssues: [
                {
                    type: 'video_ends_early',
                    reviewed: true,
                    detail: 'Needs review: inspect the ending now',
                },
                { type: 'video_decode_gaps', detail: 'New decoder evidence' },
            ],
        }),
        error: null,
        status: 200,
    });
    render(MediaInspector, { item: makeItem(), docked: true, onclose: vi.fn(), onaction: vi.fn() });
    expect(await screen.findByText(/duration difference was accepted/)).toBeTruthy();
    expect(screen.queryByText(/Needs review: inspect the ending now/)).toBeNull();
    expect(screen.getByText(/New decoder evidence/)).toBeTruthy();
});
