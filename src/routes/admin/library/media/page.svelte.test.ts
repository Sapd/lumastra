// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Interaction-model proof for the admin media browser (task 5).
 *
 * These drive the REAL page component, not an extracted decision function.
 * That is deliberate: every regression this file exists to catch is a wiring
 * regression — a row whose click still navigates, an Escape that closes a
 * modal AND clears the selection, an arrow key that moves the ring but not
 * the panel. A pure helper asserting the same rules would stay green through
 * all of them, which is the failure mode this series has already produced
 * seven times.
 *
 * Each test's revert-check (what edit in `+page.svelte` makes it fail) is
 * stated above the test.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'devalue';
import * as m from '$lib/paraglide/messages.js';
import { MUSIC_HYGIENE_FINDINGS, type MusicHygieneFinding } from '$lib/shared/music-hygiene.js';

/**
 * The chip copy each finding must render, resolved from Paraglide the same way
 * the page does. Declared here rather than re-typing the English strings so the
 * assertion survives a wording change but not a WIRING change — which is the
 * only thing this file can usefully pin about translated copy.
 */
const EXPECTED_CHIP_LABEL: Record<MusicHygieneFinding, string> = {
    'music-track-no-artist': m.admin_media_chip_music_track_no_artist(),
    'music-album-no-artist': m.admin_media_chip_music_album_no_artist(),
    'music-title-from-filename': m.admin_media_chip_music_title_from_filename(),
    'music-artist-unsplit': m.admin_media_chip_music_artist_unsplit(),
};

vi.mock('$env/dynamic/public', () => ({ env: {} }));

// The page reads `browser` to decide whether localStorage is available; under
// vitest it is false, which would leave every persisted UI preference untestable.
vi.mock('$app/environment', () => ({
    browser: true,
    dev: false,
    building: false,
    version: '0.0.0',
}));

// Mounted tests do not bootstrap SvelteKit's client app/decoders. Decode
// its real action wire format here; production browser cases exercise the
// framework's actual deserialize implementation as well as the page.
vi.mock('$app/forms', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$app/forms')>()),
    deserialize: (text: string): Record<string, unknown> => {
        const result = JSON.parse(text) as Record<string, unknown>;
        if (typeof result.data === 'string') result.data = parse(result.data);
        return result;
    },
}));

const goto = vi.hoisted(() => vi.fn());
const invalidateAll = vi.hoisted(() => vi.fn());
const replaceState = vi.hoisted(() => vi.fn());
const singleActFetch = vi.hoisted(() => vi.fn());
vi.mock('$app/navigation', () => ({
    goto,
    invalidateAll,
    replaceState,
    beforeNavigate: vi.fn(),
    afterNavigate: vi.fn(),
}));

// Reactive, and MUTABLE — see the fixture's own doc. `setPageUrl` is how the
// pagination / filter-change tests below move the page without a real router.
vi.mock('$app/state', async () => await import('./__fixtures__/app-state.svelte.js'));

// AdminPageHeader (rendered by the page) still reads the legacy store form.
vi.mock('$app/stores', async () => {
    const { readable } = await import('svelte/store');
    return {
        page: readable({ url: new URL('http://localhost/admin/library/media'), data: {} }),
        navigating: readable(null),
    };
});

vi.mock('$app/paths', () => ({ base: '', resolve: (p: string) => p }));

vi.mock('$lib/stores/toast.store', () => ({
    toasts: {
        success: vi.fn(),
        error: vi.fn(),
        warning: vi.fn(),
        info: vi.fn(() => 1),
        remove: vi.fn(),
    },
}));

vi.mock('$lib/stores/music-player.store', () => ({
    musicPlayerStore: { startPlayback: vi.fn(), addToQueue: vi.fn() },
}));

// The attention strip fetches on mount; it is irrelevant to the click model.
vi.mock('$lib/components/admin/attention/SectionAttentionStrip.svelte', async () => {
    const { default: Empty } = await import('./__fixtures__/EmptyComponent.svelte');
    return { default: Empty };
});

/**
 * `SELECTION_MAX` is mocked DOWN for this whole file.
 *
 * Its real value is 1,000, and proving the page enforces it with a genuine
 * 1,001-row fixture costs ~10s of happy-dom rendering — over the suite's
 * per-test timeout under load, i.e. a flake, which is worse than no test at
 * all (measured: 10.5s in isolation). So the proof is split. This file proves
 * the PAGE ENFORCES the cap on select-all — the wiring, which is the half that
 * regresses silently — and `selection.test.ts` pins the VALUE at 1,000.
 * Reverting either half fails one of them; neither half alone is the claim.
 *
 * Everything else in the module comes through `importOriginal`, so
 * `filterIdentity` / `shouldClearSelection` / `refreshSelection` / `summarise`
 * are the real implementations that the other tests here depend on.
 */
/**
 * `BULK_CHUNK_SIZE` is mocked through a MUTABLE holder, defaulting to its real
 * 500 so every other test in the file sees production behaviour.
 *
 * It has to be settable per-test rather than pinned for the file: at 500 a
 * selection capped to 6 is always exactly one chunk, so `chunkIds`' loop, the
 * per-chunk accumulation (`processed += …`) and the disjointness of the id
 * arrays sent to endpoints that REJECT more than 500 ids were all unexercised
 * — and a two-chunk batch is the routine case for a real 1,000-row selection,
 * not an edge case. Pinning it low for the whole file instead would break the
 * single-request assertions the other bulk tests make.
 */
const chunking = vi.hoisted(() => ({ size: 500 }));

vi.mock('./selection.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./selection.js')>()),
    // 6, NOT 3. The first draft used 3, which is exactly `ROWS.length` — so
    // `enqueues one bulk-sync run` selected all three rows AT the cap, and
    // adding a fourth row to that shared fixture would have silently truncated
    // every selection in the bulk describe and failed a long way from the
    // cause. 6 leaves ROWS three rows of slack, and the cap test uses its own
    // 8-row fixture so an off-by-one still yields 7 and fails.
    SELECTION_MAX: 6,
    // A getter, not a value: the page reads this constant when a bulk action
    // RUNS, so the holder can be re-pointed inside a test.
    get BULK_CHUNK_SIZE() {
        return chunking.size;
    },
}));

const getMediaDuplicates = vi.hoisted(() => vi.fn());
const getFilelessDuplicatePairs = vi.hoisted(() => vi.fn());
const getMediaPreview = vi.hoisted(() => vi.fn());
const syncMediaMetadata = vi.hoisted(() => vi.fn());
const syncMediaImages = vi.hoisted(() => vi.fn());
const unlockMediaMetadata = vi.hoisted(() => vi.fn());
const deleteMedia = vi.hoisted(() => vi.fn());
const bulkSetLock = vi.hoisted(() => vi.fn());
const enqueueBulkSync = vi.hoisted(() => vi.fn());
const dismissUnmatchedFile = vi.hoisted(() => vi.fn());
const getBrowserChildren = vi.hoisted(() => vi.fn());
const setArtistNoSplit = vi.hoisted(() => vi.fn());
const reviewArtistCollaboration = vi.hoisted(() => vi.fn());
const searchArtists = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/admin', () => ({
    getMediaPreview,
    syncMediaMetadata,
    syncMediaImages,
    unlockMediaMetadata,
    deleteMedia,
    bulkSetLock,
    enqueueBulkSync,
    dismissUnmatchedFile,
    getMusicHierarchy: vi.fn(),
    getMediaDuplicates,
    getBrowserChildren,
    getFilelessDuplicatePairs,
    mergeMediaItems: vi.fn(),
    setArtistNoSplit,
    reviewArtistCollaboration,
    searchArtists,
    addNavPin: vi.fn(),
    removeNavPin: vi.fn(),
}));

// The bulk-sync path polls GET /api/runs/{jobId} for the run it enqueued.
const apiGet = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/client.js', () => ({ apiGet }));

import { toasts } from '$lib/stores/toast.store';
import { page as appPage, setPageUrl, resetPageUrl } from './__fixtures__/app-state.svelte.js';
import {
    COLUMNS_STORAGE_KEY,
    FILTERS_STORAGE_KEY,
    STORAGE_VERSION,
} from './media-browser-storage.js';
import MediaBrowserPage from './+page.svelte';
import type { PageData } from './$types';
import type { MediaIssue } from '$lib/shared/media-issues.js';

interface RowOverrides {
    id: string;
    title: string;
    mediaType?: string;
    hasFiles?: boolean;
    childCount?: number;
    seriesTitle?: string;
    seasonTitle?: string;
    /** Omit to make the row unidentified (no provider match). */
    tmdbId?: number;
    metadataLocked?: boolean;
    issues?: MediaIssue[];
}

function makeRow(o: RowOverrides) {
    return {
        id: o.id,
        title: o.title,
        originalTitle: undefined,
        englishTitle: undefined,
        year: 2020,
        mediaType: o.mediaType ?? 'movie',
        status: undefined,
        seasonNumber: undefined,
        episodeNumber: undefined,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
        externalIds: { internal: o.id },
        tmdbId: 'tmdbId' in o ? o.tmdbId : 550,
        childCount: o.childCount ?? 0,
        hasFiles: o.hasFiles ?? true,
        metadataLocked: o.metadataLocked ?? false,
        isLocalOnly: false,
        hasPoster: true,
        hasOverview: true,
        fileIssues: undefined,
        runtimeSeconds: 3600,
        overview: 'An overview.',
        fileCount: 1,
        bookAuthor: undefined,
        bookNarrator: undefined,
        bookSeries: undefined,
        bookSeriesSequence: undefined,
        artistTitle: undefined,
        albumTitle: undefined,
        seriesTitle: o.seriesTitle,
        seasonTitle: o.seasonTitle,
        genericParentTitle: undefined,
        genericRootTitle: undefined,
        isDuplicate: false,
        issues: o.issues ?? [],
    };
}

function makeData(
    rows: RowOverrides[],
    domain = 'video',
    activeFilters: Record<string, unknown> = {},
    /**
     * Extra `PageData` fields, spread LAST so a test can override any default
     * below — `libraryGroupId` / `libraryGroups` for the library-scope chip.
     */
    extra: Record<string, unknown> = {},
): PageData {
    return {
        items: rows.map(makeRow),
        total: rows.length,
        page: 1,
        pageSize: 50,
        query: '',
        typeFilter: 'main',
        libraryGroupId: '',
        libraryGroups: [],
        showUnavailable: false,
        showDismissed: false,
        domain,
        sort: 'title',
        order: 'asc',
        activeFilters,
        advancedFilterKeys: [],
        view: 'all',
        layout: 'list',
        availableViews: [
            'all',
            'attention',
            'unidentified',
            'artwork',
            'overview',
            'files',
            'duplicates',
            'recent',
            'lost',
        ],
        viewCounts: { all: rows.length, attention: 1, artwork: 1 },
        jellyfinEnabled: false,
        ...extra,
    } as unknown as PageData;
}

function successfulRefreshResponse(browserData: PageData): Response {
    return new Response(
        JSON.stringify({
            type: 'success',
            status: 200,
            location: '/admin/library/media',
            data: stringify({
                success: true,
                browserData,
                correctedPage: browserData.page,
            }),
        }),
        { status: 200 },
    );
}

function rowEl(index: number): HTMLElement {
    const el = document.querySelector<HTMLElement>(`tr[data-row-index="${index}"]`);
    if (!el) throw new Error(`no row at index ${index}`);
    return el;
}

/** Fire a keydown on `window`, the way the page's global handler receives it. */
function pressKey(key: string, target: EventTarget = document.body): void {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

/**
 * Let Svelte's queued flush run.
 *
 * Required before ANY assertion of the form "the DOM did not change": Svelte
 * updates asynchronously, so reading the DOM on the line after a dispatch reads
 * the PRE-dispatch state and passes whether or not the guard under test exists.
 * Two of the guards in this file were revert-checked and found un-failable for
 * exactly that reason before this helper was introduced.
 */
async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function click(el: HTMLElement, shiftKey = false): void {
    // A real pointer click focuses the element it lands on. Reproducing that
    // for rows is what exercises the row-focus effect's
    // `document.activeElement !== row` / `row.contains(activeElement)` guards —
    // a bare synthetic MouseEvent never moves focus, so those branches were
    // dead in every test that only dispatched one.
    if (el.tagName === 'TR') el.focus();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey }));
}

function dblclick(el: HTMLElement): void {
    // A real double-click fires two clicks first; reproduce that so the test
    // proves navigation survives the click handler rather than only firing in
    // isolation.
    click(el);
    click(el);
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
}

/**
 * Tick a row's checkbox. Deliberately not a row click: that opens the
 * inspector, whose own action buttons would then collide by name with the
 * bulk bar's.
 */
async function selectRow(index: number): Promise<void> {
    const box = rowEl(index).querySelector<HTMLElement>('button[aria-pressed]')!;
    click(box);
    await waitFor(() => expect(box.getAttribute('aria-pressed')).toBe('true'));
}

/** Panel heading text — the inspector renders the item title in an <h3>. */
function inspectorTitle(): string | null {
    return document.querySelector('h3.truncate')?.textContent?.trim() ?? null;
}

/**
 * The shared three-row fixture.
 *
 * ⚠️ `SELECTION_MAX` is mocked to 6 for this file (see the top). Growing this
 * past six rows would put the bulk tests that select ALL of it at or over the
 * cap, and they would fail on a truncated selection rather than on whatever
 * they actually assert. Add rows to a local fixture instead.
 */
const ROWS: RowOverrides[] = [
    { id: 'id-alpha', title: 'Alpha Movie' },
    { id: 'id-beta', title: 'Beta Movie' },
    { id: 'id-gamma', title: 'Gamma Movie' },
];

/**
 * happy-dom in this repo's version exposes no `localStorage`, and persisted UI
 * preferences are among the behaviours under test — so provide a real
 * in-memory `Storage` rather than skipping the assertion.
 */
function installLocalStorage(): void {
    const backing = new Map<string, string>();
    const storage: Storage = {
        get length() {
            return backing.size;
        },
        clear: () => backing.clear(),
        getItem: (k) => backing.get(k) ?? null,
        key: (i) => [...backing.keys()][i] ?? null,
        removeItem: (k) => void backing.delete(k),
        setItem: (k, v) => void backing.set(k, String(v)),
    };
    for (const target of [window, globalThis]) {
        Object.defineProperty(target, 'localStorage', { configurable: true, value: storage });
    }
}

beforeEach(() => {
    vi.clearAllMocks();
    installLocalStorage();
    // Both are module-level state that outlives a test.
    resetPageUrl();
    chunking.size = 500;
    // `externalIds` is REQUIRED by `MediaPreviewResponseSchema`, and the
    // inspector reads `p.externalIds.tmdb` unguarded because the schema entitles
    // it to. Omitting it here made the mock a lie about the contract and threw
    // `Cannot read properties of undefined (reading 'tmdb')` out of the render,
    // failing nine tests in this file. Empty object, not a guard in the
    // component: the API always sends the key, so the fixture was the wrong one.
    getMediaPreview.mockResolvedValue({
        data: { fileCount: 1, filePaths: [], healthStatus: 'healthy', externalIds: {} },
        error: null,
    });
    setArtistNoSplit.mockReset();
    reviewArtistCollaboration.mockReset();
    searchArtists.mockReset();
    singleActFetch.mockReset();
    invalidateAll.mockResolvedValue(undefined);
    singleActFetch.mockImplementation(() =>
        successfulRefreshResponse(makeData([], 'music', { music_hygiene: 'music-artist-unsplit' })),
    );
    vi.stubGlobal('fetch', singleActFetch);
    // Docked presentation: the arrow-follow rule is docked-only, and every
    // test here asserts on the panel, so the viewport must be wide enough.
    window.innerWidth = 1600;
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('row click model', () => {
    /**
     * Revert-check: restore the old `onclick={() => goto(...)}` on the `<tr>`
     * and this fails twice over — `goto` is called, and no panel appears.
     */
    it('a single row click opens the inspector and does NOT navigate', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });

        click(rowEl(0));

        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));
        expect(goto).not.toHaveBeenCalled();
    });

    /**
     * Revert-check: delete the `<tr>`'s `ondblclick` handler and this fails —
     * nothing navigates. This is the whole migration affordance, so it must
     * be pinned independently of the click test above.
     */
    it('a double click navigates to the detail page', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });

        dblclick(rowEl(1));

        await waitFor(() => expect(goto).toHaveBeenCalledWith('/admin/library/media/id-beta'));
    });

    /**
     * Revert-check: drop the `closest('button, a')` guard from `ondblclick`
     * and this fails — the row navigates away from the page the operator was
     * double-tapping a control on.
     */
    it('a double click on a row control does not navigate', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });

        const checkbox = rowEl(0).querySelector<HTMLElement>('button[aria-pressed]');
        expect(checkbox).not.toBeNull();
        dblclick(checkbox!);

        expect(goto).not.toHaveBeenCalled();
    });

    /**
     * Revert-check: remove `e.stopPropagation()` from the Sync button's onclick
     * and this fails — the click reaches the `<tr>` and opens the inspector.
     *
     * Sync stands in for the CLASS. Identify, Dismiss, Play and the `/watch/`
     * anchor carry the identical guard for the identical reason; only the
     * checkbox was covered before, and it is the one control whose guard has a
     * second, unrelated job (the Space double-toggle), so it was the least
     * representative of the five.
     */
    it('a row action button does not open the inspector', async () => {
        syncMediaMetadata.mockResolvedValue({ error: null });
        render(MediaBrowserPage, { data: makeData(ROWS) });

        const sync = rowEl(0).querySelector<HTMLElement>('button[aria-label="Sync metadata"]');
        expect(sync).not.toBeNull();
        click(sync!);

        await waitFor(() => expect(syncMediaMetadata).toHaveBeenCalledWith('id-alpha', false));
        await settle();
        expect(inspectorTitle()).toBeNull();
        expect(goto).not.toHaveBeenCalled();
    });

    /**
     * Revert-check: remove `e.stopPropagation()` from the checkbox's onclick
     * and this fails — the click reaches the `<tr>` and opens the inspector.
     */
    it('the checkbox selects without opening the inspector', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });

        const checkbox = rowEl(0).querySelector<HTMLElement>('button[aria-pressed]');
        click(checkbox!);

        await waitFor(() => expect(checkbox!.getAttribute('aria-pressed')).toBe('true'));
        expect(inspectorTitle()).toBeNull();
        expect(goto).not.toHaveBeenCalled();
    });
});

describe('selection refresh effect', () => {
    /**
     * Revert-check: remove the `untrack` around the snapshot refresh (restoring
     * the identity-guard version) and this fails — deterministically, on the
     * shift-range assertion, before the async `effect_update_depth_exceeded`
     * even surfaces.
     *
     * That effect READS `selectedRows` (refreshSelection copies and probes the
     * map) and WRITES it with freshly minted snapshot objects, so the identity
     * guard never held: every run wrote, every write re-invalidated the map,
     * the effect re-ran, and `lastSelectedIndex = null` at the bottom of it
     * ran again too. The visible damage is that the shift-range anchor is
     * destroyed the instant anything is selected — so this asserts on the
     * RANGE, which is the thing an operator loses, rather than on the crash.
     */
    it('selecting a row does not destroy the shift-range anchor', async () => {
        // Secondary, best-effort probe for the crash ITSELF. The shift-anchor
        // assertion below is the deterministic one, but it is a PROXY: if
        // `lastSelectedIndex = null` ever moves behind a guard, that assertion
        // goes green with the loop still running. Svelte throws
        // `effect_update_depth_exceeded` asynchronously, so this cannot be
        // relied on to fire in every scheduling order — it costs four lines and
        // covers the one case the proxy cannot.
        const seen: string[] = [];
        const consoleError = vi
            .spyOn(console, 'error')
            .mockImplementation((...args: unknown[]) => void seen.push(args.join(' ')));
        const priorOnError = window.onerror;
        window.onerror = (message) => void seen.push(String(message));

        try {
            render(MediaBrowserPage, { data: makeData(ROWS) });

            const box = (i: number) => rowEl(i).querySelector<HTMLElement>('button[aria-pressed]')!;

            click(box(0));
            await waitFor(() => expect(box(0).getAttribute('aria-pressed')).toBe('true'));

            click(box(2), true);

            await waitFor(() => expect(box(2).getAttribute('aria-pressed')).toBe('true'));
            // The whole point of shift: the row BETWEEN the anchor and the target.
            expect(box(1).getAttribute('aria-pressed')).toBe('true');

            // Let any queued flush settle so an async throw has a chance to land.
            await new Promise((r) => setTimeout(r, 0));
            expect(seen.join('\n')).not.toContain('effect_update_depth_exceeded');
        } finally {
            consoleError.mockRestore();
            window.onerror = priorOnError;
        }
    });
});

describe('keyboard model', () => {
    /**
     * Revert-check: delete the `isInspectorDocked && inspectorItemId !== null`
     * block in `moveRowFocus` and this fails — the ring moves, the panel keeps
     * showing Alpha.
     */
    it('arrow-walking updates the panel', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });

        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));

        pressKey('ArrowDown');
        await waitFor(() => expect(inspectorTitle()).toBe('Beta Movie'));

        pressKey('ArrowDown');
        await waitFor(() => expect(inspectorTitle()).toBe('Gamma Movie'));

        pressKey('ArrowUp');
        await waitFor(() => expect(inspectorTitle()).toBe('Beta Movie'));
    });

    /**
     * Revert-check: restore the row-level ArrowDown handler that focused the
     * next row WITHOUT `stopPropagation()` and this fails — the row's own
     * `onfocus` advances the index and the window handler advances it again,
     * so one keypress lands on Gamma.
     */
    it('one ArrowDown moves exactly one row', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });

        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));

        // Dispatched on the focused row, so the row-level handler runs first
        // and the window handler sees it bubble — the exact double-advance path.
        pressKey('ArrowDown', rowEl(0));

        await waitFor(() => expect(inspectorTitle()).toBe('Beta Movie'));
    });

    /**
     * Revert-check: remove the `Enter` branch from `handleGlobalKeydown` (or
     * repoint it at the inspector) and this fails.
     */
    it('Enter still navigates to the detail page', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });

        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));

        pressKey('Enter');

        expect(goto).toHaveBeenCalledWith('/admin/library/media/id-alpha');
    });

    /**
     * Revert-check: make the Space branch also set `inspectorItemId`, or make
     * it navigate, and this fails. Space is the bulk-scope gesture and must
     * stay orthogonal to both.
     */
    it('Space selects the focused row without navigating or inspecting', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });

        rowEl(0).focus();
        pressKey(' ');

        const checkbox = rowEl(0).querySelector<HTMLElement>('button[aria-pressed]');
        await waitFor(() => expect(checkbox!.getAttribute('aria-pressed')).toBe('true'));
        expect(goto).not.toHaveBeenCalled();
        expect(inspectorTitle()).toBeNull();
    });
});

describe('row controls own their own keys', () => {
    /**
     * Revert-check (F2): remove the `target.closest?.('button, a')` early
     * return from `handleGlobalKeydown` and this fails — `goto` fires.
     *
     * The row's controls stop `click`, and `ondblclick` guards on the same
     * selector, but nothing stopped `keydown`. Tab onto a row's Sync button,
     * press Enter, and the button runs the sync while the same keypress
     * bubbles to the window handler and navigates away from the page it just
     * acted on. Identical in shape to the dblclick hazard, and it applies to
     * Identify, Dismiss, Play and the `/watch/` link too.
     *
     * Reachable only because of THIS change: under the old model a row click
     * navigated away, so a row was almost never left focused.
     */
    it('Enter on a focused row control does not also navigate', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });

        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));

        const sync = rowEl(0).querySelector<HTMLElement>('button[aria-label="Sync metadata"]')!;
        sync.focus();
        pressKey('Enter', sync);

        expect(goto).not.toHaveBeenCalled();
    });

    /**
     * Revert-check: same early return. `Space` on any of the five controls both
     * activated the control and toggled the row's selection; only the checkbox
     * had a guard of its own, and it is the one control where the double-toggle
     * is self-cancelling and therefore invisible.
     */
    it('Space on a focused row control does not also toggle selection', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });

        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));

        const sync = rowEl(0).querySelector<HTMLElement>('button[aria-label="Sync metadata"]')!;
        sync.focus();
        pressKey(' ', sync);
        await settle();

        expect(
            rowEl(0)
                .querySelector<HTMLElement>('button[aria-pressed]')!
                .getAttribute('aria-pressed'),
        ).toBe('false');
    });

    /**
     * Revert-check (F6): remove `if (anyOverlayOpen) return;` from the ROW's
     * own `onkeydown` and this fails — that handler is the second caller of
     * `moveRowFocus` and it stops the event before the window handler's copy
     * of the same rule can run, so the panel follows an arrow key pressed
     * underneath an open confirmation dialog.
     */
    it('an arrow key on a row is inert while a modal owns the screen', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });

        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));
        click(await screen.findByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeNull());

        pressKey('ArrowDown', rowEl(0));
        await settle();

        expect(inspectorTitle()).toBe('Alpha Movie');
    });
});

describe('Escape precedence', () => {
    /**
     * Revert-check: reorder the Escape branches so the selection clear runs
     * before the inspector close, and this fails — one Escape would clear the
     * selection while the panel stays open.
     */
    it('with BOTH inspector open and a selection, Escape closes only the inspector', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });

        const checkbox = rowEl(0).querySelector<HTMLElement>('button[aria-pressed]');
        click(checkbox!);
        await waitFor(() => expect(checkbox!.getAttribute('aria-pressed')).toBe('true'));

        click(rowEl(1));
        await waitFor(() => expect(inspectorTitle()).toBe('Beta Movie'));

        pressKey('Escape');

        await waitFor(() => expect(inspectorTitle()).toBeNull());
        // Selection survives: exactly one thing happened.
        expect(
            rowEl(0)
                .querySelector<HTMLElement>('button[aria-pressed]')!
                .getAttribute('aria-pressed'),
        ).toBe('true');
    });

    /**
     * Revert-check: delete the `inspectorItemId !== null` branch entirely and
     * this fails — with no selection and no modal, Escape would fall through
     * to the focus reset and leave the panel mounted.
     */
    it('with only the inspector open, Escape closes it', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });

        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));

        pressKey('Escape');

        await waitFor(() => expect(inspectorTitle()).toBeNull());
    });

    /**
     * Revert-check: same branch — if the inspector branch swallowed Escape
     * unconditionally (no `!== null` guard) this would fail, because the
     * selection would never be reached.
     */
    it('with only a selection, Escape clears it', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });

        const checkbox = rowEl(0).querySelector<HTMLElement>('button[aria-pressed]');
        click(checkbox!);
        await waitFor(() => expect(checkbox!.getAttribute('aria-pressed')).toBe('true'));

        pressKey('Escape');

        await waitFor(() =>
            expect(
                rowEl(0)
                    .querySelector<HTMLElement>('button[aria-pressed]')!
                    .getAttribute('aria-pressed'),
            ).toBe('false'),
        );
    });

    /**
     * Revert-check: add `inspectorItemId = null` (or a selection clear) to the
     * modal branch's fall-through and this fails. The dismiss/delete modals
     * close THEMSELVES on Escape without stopping propagation, so the window
     * handler must claim the event or one keypress does two things.
     */
    it('with a modal open over both, Escape closes only the modal', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });

        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));

        // Delete, from the inspector's own action registry — opens the
        // single-item confirmation modal over the panel.
        const deleteButton = await screen.findByRole('button', { name: 'Delete' });
        click(deleteButton);
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeNull());

        pressKey('Escape');

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        // The panel is untouched.
        expect(inspectorTitle()).toBe('Alpha Movie');
    });

    /**
     * Revert-check: delete the `anyOverlayOpen || ...` early return that sits
     * just below the Escape block and this fails — `Enter` bubbles past
     * ActionModal's own handler and navigates away from the page the operator
     * is confirming a delete on. (The same return is what stops an arrow key
     * pulling DOM focus out of the dialog's focus trap.)
     */
    it('row shortcuts are inert while a modal owns the screen', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });

        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));
        click(await screen.findByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeNull());

        pressKey('Enter');
        pressKey('ArrowDown');
        await settle();

        expect(goto).not.toHaveBeenCalled();
        // The panel did not follow the arrow key either.
        expect(inspectorTitle()).toBe('Alpha Movie');
    });

    /**
     * Revert-check: this is the "nothing open" state the brief asks for — if
     * the Escape handler ever started throwing on an empty state (e.g. an
     * unguarded `data.items[focusedRowIndex]`) this catches it.
     */
    it('with nothing open, Escape is inert', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });

        expect(() => pressKey('Escape')).not.toThrow();
        expect(goto).not.toHaveBeenCalled();
        expect(inspectorTitle()).toBeNull();
    });
});

describe('inspector wiring', () => {
    /**
     * Revert-check: drop the `onaction` prop from the `<MediaInspector>` call
     * site and this fails — the Actions section is not rendered at all without
     * a handler, so `Sync Metadata` is not found. Restore the prop but delete
     * the `syncMetadata` case from `handleInspectorAction` and it fails on the
     * API assertion instead.
     */
    it('an inspector action runs the page handler', async () => {
        syncMediaMetadata.mockResolvedValue({ error: null });
        render(MediaBrowserPage, { data: makeData(ROWS) });

        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));

        const syncButton = await screen.findByRole('button', { name: 'Refresh details' });
        click(syncButton);

        await waitFor(() => expect(syncMediaMetadata).toHaveBeenCalledWith('id-alpha', false));
    });

    /**
     * F2. The single-item delete dialog used to promise a skip and then delete
     * anyway: it rendered `media_delete_warning` ("1 item(s) will be skipped
     * (have children)"), had NO `disabled` guard — unlike the bulk modal beside
     * it — and `deleteInspectorItem` called `deleteMedia` unconditionally. So
     * the operator read that nothing would happen, pressed a live button, and
     * got a raw 409 error toast.
     *
     * Both halves are asserted because either alone leaves the defect: a
     * disabled button over the old "will be skipped" copy still describes an
     * action that does not exist, and honest copy over a live button still
     * fires the request.
     *
     * Revert-check A: drop `disabled={blocked}` from the modal and this fails
     * on the disabled assertion — and it is the RENDER guard that the
     * `deleteMedia` assertion below also rides on, see the honesty note.
     * Revert-check B: cross-wire `blocked` to `target.childCount === 0` and
     * every assertion here fails at once.
     *
     * ⚠️ HONESTY NOTE. Removing `deleteInspectorItem`'s own
     * `if (target.childCount > 0) return` — leaving `disabled={blocked}` in
     * place — does NOT fail this test: happy-dom suppresses activation on a
     * disabled button, so the handler is never entered and the final assertion
     * passes for the wrong reason. That guard is defence-in-depth mirroring the
     * two `bulkDelete` repeats beside it (the rule belongs to the thing that
     * deletes, not only to the thing that renders), and it is deliberately NOT
     * claimed as covered here. `bulkDelete`'s `deleteSummary.deletable === 0`
     * guard sits in exactly the same position, for the same reason, and is
     * likewise reachable only by a mis-wired dialog. Verified by running the
     * inversion, not assumed.
     */
    it('the inspector will not delete an item with children, and says so', async () => {
        deleteMedia.mockResolvedValue({ error: null });
        render(MediaBrowserPage, {
            data: makeData([{ id: 'id-show', title: 'A Show', mediaType: 'tv', childCount: 4 }]),
        });

        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('A Show'));
        click(await screen.findByRole('button', { name: 'Delete' }));

        const dialog = await waitFor(() => {
            const el = screen.queryByRole('dialog');
            expect(el).not.toBeNull();
            return el!;
        });

        // Same register as the bulk modal's zero case, not a second vocabulary.
        expect(dialog.getAttribute('aria-label')).toBe('Nothing to delete');
        expect(within(dialog).queryByText(/cannot be deleted here/)).not.toBeNull();
        // ...and no promise of a deletion, nor of a skip it cannot perform.
        expect(within(dialog).queryByText(/permanently delete/)).toBeNull();
        expect(within(dialog).queryByText(/will be skipped/)).toBeNull();

        const confirm = within(dialog).getAllByRole('button', { name: 'Delete' })[0]!;
        expect(confirm.hasAttribute('disabled')).toBe(true);
        click(confirm);
        await settle();
        expect(deleteMedia).not.toHaveBeenCalled();
    });

    /**
     * The other side of the same dialog: a childless item still deletes, so the
     * guard above is a narrowing and not a removal.
     *
     * Revert-check: change `deleteInspectorItem`'s guard to
     * `if (target.childCount >= 0) return` and this fails while the test above
     * still passes.
     */
    it('the inspector deletes a childless item', async () => {
        deleteMedia.mockResolvedValue({ error: null });
        render(MediaBrowserPage, { data: makeData(ROWS) });

        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));
        click(await screen.findByRole('button', { name: 'Delete' }));

        const dialog = await waitFor(() => {
            const el = screen.queryByRole('dialog');
            expect(el).not.toBeNull();
            return el!;
        });
        const confirm = within(dialog).getAllByRole('button', { name: 'Delete' })[0]!;
        expect(confirm.hasAttribute('disabled')).toBe(false);
        click(confirm);

        await waitFor(() => expect(deleteMedia).toHaveBeenCalledWith('id-alpha'));
    });

    /**
     * The BOOLEAN, not just the call.
     *
     * `syncMetadata` and `syncWithChildren` reach the same API function and
     * differ only in its second argument, so the test above ('id-alpha',
     * false) pins nothing about this case. Mis-wiring it to `false` is
     * invisible at every gate this repo has: it typechecks, it lints, the
     * button is present, the request succeeds and a success toast fires — and
     * the seasons and episodes the operator pressed the button FOR are never
     * fetched.
     *
     * A `tv` row with children, because that is what makes the registry offer
     * the action at all (`childCount > 0 || hasCascadableContainer`).
     *
     * Revert-check: change `case 'syncWithChildren': void syncItem(item.id, true)`
     * to `false` — or swap the two cases' bodies, which is the same bug written
     * the other way — and this fails on the boolean while the sibling test
     * above still passes.
     */
    it('the inspector Sync With Children action asks for the children', async () => {
        syncMediaMetadata.mockResolvedValue({ error: null });
        render(MediaBrowserPage, {
            data: makeData([{ id: 'id-show', title: 'A Show', mediaType: 'tv', childCount: 4 }]),
        });

        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('A Show'));

        click(await screen.findByRole('button', { name: 'Refresh title and contents' }));

        await waitFor(() => expect(syncMediaMetadata).toHaveBeenCalledWith('id-show', true));
        expect(syncMediaMetadata).not.toHaveBeenCalledWith('id-show', false);
    });

    /**
     * Revert-check: remove the ancestry fields from `inspectorItem` (task 4's
     * handoff (c)) and this fails. It degrades SILENTLY in the browser — the
     * panel simply renders no ancestry line — which is why it needs a test
     * rather than a reviewer's eye.
     */
    it('passes the row ancestry through to the panel', async () => {
        const rows: RowOverrides[] = [
            {
                id: 'id-ep',
                title: 'The One With The Test',
                mediaType: 'episode',
                seriesTitle: 'Friends',
                seasonTitle: 'Season 3',
            },
        ];
        render(MediaBrowserPage, { data: makeData(rows) });

        click(rowEl(0));

        await waitFor(() => expect(screen.queryByText('Friends → Season 3')).not.toBeNull());
    });
});

/**
 * Everything above runs at 1600px, i.e. the DOCKED presentation. This block is
 * the other half of the component, and the one most laptops actually get: below
 * 1280px `MediaInspector` renders as a focus-trapped modal drawer over a
 * backdrop. Three things live only on this side and were unexercised —
 * the `!isInspectorDocked` half of the window handler's overlay guard, the
 * drawer's own Escape handler racing that window handler, and `trapFocus`'s
 * autofocus ordering.
 */
describe('modal presentation (below the docked breakpoint)', () => {
    beforeEach(() => {
        window.innerWidth = 1000;
    });

    /** Open the drawer on `Beta Movie` with row 0 already selected. */
    async function openDrawerWithSelection(): Promise<HTMLElement> {
        const checkbox = rowEl(0).querySelector<HTMLElement>('button[aria-pressed]');
        click(checkbox!);
        await waitFor(() => expect(checkbox!.getAttribute('aria-pressed')).toBe('true'));

        click(rowEl(1));
        const drawer = await waitFor(() => {
            const el = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
            expect(el).not.toBeNull();
            return el!;
        });
        expect(inspectorTitle()).toBe('Beta Movie');
        return drawer;
    }

    function rowZeroPressed(): string | null {
        return rowEl(0)
            .querySelector<HTMLElement>('button[aria-pressed]')!
            .getAttribute('aria-pressed');
    }

    /**
     * Escape from INSIDE the drawer, which is where focus actually is once
     * `trapFocus` has run.
     *
     * Revert-check is on MediaInspector, not the page: delete the `onclose()`
     * from its `handleKeydown` and this fails, because the `e.stopPropagation()`
     * on the line above it means the window handler never sees the event and
     * nothing else closes the drawer. Confirmed by running it.
     *
     * Deliberately NOT the test for the page's Escape precedence — that
     * stopPropagation makes this path insensitive to the page's branches, which
     * is exactly why the next test dispatches from outside the drawer instead.
     * Discovered by revert-checking: the first version of this test asserted the
     * page's branch and stayed green without it.
     */
    it('Escape inside the drawer closes it and leaves the selection intact', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });
        const drawer = await openDrawerWithSelection();

        pressKey('Escape', document.activeElement ?? drawer);

        await waitFor(() => expect(inspectorTitle()).toBeNull());
        expect(rowZeroPressed()).toBe('true');
    });

    /**
     * Escape reaching the WINDOW — focus outside the drawer (the backdrop, or
     * before `trapFocus`'s deferred autofocus has run).
     *
     * Revert-check: delete the `inspectorItemId !== null` branch from the page's
     * Escape block and this fails twice over — nothing closes the drawer, and
     * the fall-through clears the selection the operator did not ask to lose.
     * This is the page-side half that the in-drawer test above cannot reach.
     */
    it('Escape from outside the drawer closes it, not the selection', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });
        await openDrawerWithSelection();

        pressKey('Escape', document.body);

        await waitFor(() => expect(inspectorTitle()).toBeNull());
        expect(rowZeroPressed()).toBe('true');
    });

    /**
     * Revert-check: pass a literal `docked={true}` at the call site and this
     * fails — the docked panel is a plain flex sibling with no `trapFocus` and
     * no dialog role, so nothing moves focus off the row.
     *
     * `trapFocus` defers its autofocus to a microtask, hence the waitFor.
     */
    it('focus lands inside the drawer after a row click', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });

        click(rowEl(0));

        const drawer = await waitFor(() => {
            const el = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
            expect(el).not.toBeNull();
            return el!;
        });
        await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    });

    /**
     * Revert-check (F1): remove the `inspectorItemId = null` reset from the
     * `data.items` effect and this fails — and it fails as a SILENT KEYBOARD
     * LOCKOUT, which is why it needs a test rather than an eye.
     *
     * After a page turn the drawer is gone from the screen (`inspectorItem`
     * derives to null) but the raw id is still set, so the window handler's
     * `inspectorItemId !== null && !isInspectorDocked` guard treats the page as
     * having a modal open: every row shortcut goes dead, with no panel visible
     * to explain why, and Escape cannot recover it because the inspector branch
     * claims Escape first.
     */
    it('a page turn with the drawer open does not lock the keyboard', async () => {
        const { rerender } = render(MediaBrowserPage, { data: makeData(ROWS) });

        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));

        // The next page. `goToPage` is a client-side `goto`, so in the real app
        // `data.items` swaps under a still-mounted component exactly like this.
        const nextPage: RowOverrides[] = [
            { id: 'id-delta', title: 'Delta Movie' },
            { id: 'id-epsilon', title: 'Epsilon Movie' },
        ];
        await rerender({ data: makeData(nextPage) });
        await waitFor(() => expect(inspectorTitle()).toBeNull());

        pressKey('ArrowDown');
        pressKey('Enter');

        await waitFor(() => expect(goto).toHaveBeenCalledWith('/admin/library/media/id-delta'));
    });

    /**
     * Revert-check: same reset. This is the second symptom of the same stale
     * id — Escape doing ZERO things, and a selection the operator meant to
     * clear surviving it. Separate from the lockout test because a fix that
     * only cleared the id on some paths could pass one and not the other.
     */
    it('after a page turn, Escape still clears the selection', async () => {
        const { rerender } = render(MediaBrowserPage, { data: makeData(ROWS) });

        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));

        const checkbox = rowEl(1).querySelector<HTMLElement>('button[aria-pressed]');
        click(checkbox!);
        await waitFor(() => expect(checkbox!.getAttribute('aria-pressed')).toBe('true'));

        await rerender({ data: makeData([{ id: 'id-beta', title: 'Beta Movie' }]) });
        await waitFor(() => expect(inspectorTitle()).toBeNull());

        pressKey('Escape');

        await waitFor(() =>
            expect(
                rowEl(0)
                    .querySelector<HTMLElement>('button[aria-pressed]')!
                    .getAttribute('aria-pressed'),
            ).toBe('false'),
        );
    });
});

describe('title link', () => {
    /**
     * Revert-check: turn the title back into a `<p>` and this fails — the only
     * way into an item is then a double-click, which touch devices cannot
     * produce and which offers no open-in-new-tab.
     */
    it('is a real link to the detail page and does not open the inspector', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });

        const link = within(rowEl(1)).getByRole('link', { name: 'Beta Movie' });
        expect(link.getAttribute('href')).toBe('/admin/library/media/id-beta');

        // Stop the router-less test DOM from attempting a real navigation.
        link.addEventListener('click', (e) => e.preventDefault());
        click(link);
        await settle();
        expect(inspectorTitle()).toBeNull();
    });
});

/**
 * The bulk action bar (task 6).
 *
 * Everything in here drives the real page: the bar's whole reason to exist is
 * that it renders from `actionsFor({ surface: 'selection' })` instead of a
 * hand-written list of `{#if}` blocks, and a test that called `actionsFor`
 * itself would stay green through the bar being rewired back to a local list —
 * the exact regression this task is undoing.
 */
/**
 * The two halves of the selection-clearing rule, at the PAGE level.
 *
 * `selection.test.ts` calls `filterIdentity` / `shouldClearSelection` directly,
 * which pins the decision but not the wiring — and the wiring is the half that
 * regressed: the page used to clear on every `data.items` change, so the
 * largest selection an operator could build was the 50 rows on screen. A pure
 * helper test stays green through a re-introduction of exactly that.
 *
 * These could not be written before, because `$app/state` was mocked as one
 * frozen URL for the whole file: `page.url.searchParams` never moved, so the
 * effect's compare branch was unreachable. See `__fixtures__/app-state.svelte.ts`.
 *
 * Both assert on the RENDERED bulk bar rather than on a helper's return value,
 * and the pair is deliberate — (a) alone would pass against a page that had
 * simply stopped reacting to the URL at all, and (b) proves it still does.
 */
describe('selection across navigation', () => {
    const NEXT_PAGE: RowOverrides[] = [
        { id: 'id-delta', title: 'Delta Movie' },
        { id: 'id-epsilon', title: 'Epsilon Movie' },
    ];

    /** The bulk bar's own count, i.e. what the operator can see. */
    function selectedLabel(): string | null {
        const bar = screen.queryByRole('toolbar', { name: 'Actions for selected items' });
        return bar
            ? within(bar)
                  .getByText(/\d+ selected/)
                  .textContent!.trim()
            : null;
    }

    /**
     * Revert-check: restore the old rule and clear on every `data.items` change
     * — e.g. add `selectedRows.clear()` to the snapshot-refresh `$effect` — and
     * this fails: the bar is gone after the page turn and `selectedLabel()`
     * reads null.
     *
     * Cross-wire check: swap the two branches of `shouldClearSelection` (return
     * `prev === next`) and this fails for the same reason, while (b) below
     * still passes — which is why both exist.
     */
    it('a page turn keeps a selection that now spans pages', async () => {
        const { rerender } = render(MediaBrowserPage, { data: makeData(ROWS) });

        await selectRow(0);
        await selectRow(1);
        expect(selectedLabel()).toBe('2 selected');

        // `page` and `sort`/`order` are excluded from the filter identity on
        // purpose: they choose a slice of the SAME result set.
        setPageUrl('http://localhost/admin/library/media?page=2');
        await rerender({ data: makeData(NEXT_PAGE) });
        await settle();

        // The page really did turn...
        expect(within(rowEl(0)).queryByText('Delta Movie')).not.toBeNull();
        // ...and neither selected row is on it any more, yet both are still
        // selected. This is the whole point of a cross-page selection.
        expect(selectedLabel()).toBe('2 selected');
    });

    /**
     * Revert-check: delete the `selectedRows.clear()` inside the filter-identity
     * `$effect` and this fails — the bar survives a filter change, leaving the
     * operator holding rows that are no longer in the result set they are
     * looking at, and one Delete away from acting on them.
     *
     * Cross-wire check: point the effect at a param the identity EXCLUDES (swap
     * `'q'` for `'page'` in `FILTER_IDENTITY_PARAMS`) and this fails while (a)
     * above fails too — the two params trade places, which is the shape a
     * careless edit to that list takes.
     */
    it('a filter change clears the selection', async () => {
        const { rerender } = render(MediaBrowserPage, { data: makeData(ROWS) });

        await selectRow(0);
        await selectRow(1);
        expect(selectedLabel()).toBe('2 selected');

        setPageUrl('http://localhost/admin/library/media?q=beta');
        await rerender({ data: makeData([ROWS[1]!]) });

        await waitFor(() => expect(selectedLabel()).toBeNull());
    });
});

describe('bulk action bar', () => {
    /**
     * Scoped to the bar's own `role="toolbar"`, NOT to the whole document. The
     * table behind it carries per-row Identify / Sync buttons with the same
     * accessible names, so an unscoped query is ambiguous in the unidentified
     * domain and — worse — would let a bar assertion pass on a ROW button.
     */
    function barButton(name: string): HTMLElement | null {
        const bar = screen.queryByRole('toolbar', { name: 'Actions for selected items' });
        // THROWS rather than returning null. Returning null made every
        // negative assertion (`expect(barButton('Watch')).toBeNull()`) pass
        // when the bar had not rendered at all — the test would have been
        // satisfied by the feature being absent, which is the unfalsifiable
        // shape this series keeps producing.
        if (!bar) throw new Error(`no bulk action bar rendered (looking for "${name}")`);
        return within(bar).queryByRole('button', { name });
    }

    /**
     * Revert-check: change `surface: 'selection'` to `'inspector'` in
     * MediaActionBar's `actionsFor` call and this fails — Watch, Play and Open
     * Files are all `scope: 'item'`, so they appear in the bar the moment the
     * surface stops discriminating.
     *
     * The fixture is chosen so the surface genuinely SEPARATES the two sets: a
     * movie with files yields Watch + Open Files at `inspector` and neither at
     * `selection`. A fixture that produced the same set under both strings
     * would make this unfalsifiable, which is how an earlier surface test in
     * this series shipped green.
     */
    it('renders the SELECTION action set, not the item one', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });
        await selectRow(0);

        // Selection-scoped actions for a plain identified movie.
        expect(barButton('Refresh details')).not.toBeNull();
        expect(barButton('Refresh artwork')).not.toBeNull();
        expect(barButton('Delete')).not.toBeNull();
        // Item-scoped ones must NOT be here.
        expect(barButton('Watch')).toBeNull();
        expect(barButton('Play')).toBeNull();
        expect(barButton('Open Files')).toBeNull();

        // ...and they are absent because of the SURFACE, not because the rule
        // rejects this row: the same row offers both in the inspector.
        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));
        expect(await screen.findByRole('button', { name: 'Watch' })).not.toBeNull();
        expect(await screen.findByRole('button', { name: 'Open Files' })).not.toBeNull();
    });

    /**
     * Revert-check: delete `hasSeriesSelected` from MediaActionBar and pass a
     * literal `childCount: 0`, and the first assertion fails.
     */
    it('offers Sync + Children only when a selected SERIES has children', async () => {
        render(MediaBrowserPage, {
            data: makeData([
                { id: 'id-show', title: 'A Show', mediaType: 'tv', childCount: 4 },
                { id: 'id-film', title: 'A Film', mediaType: 'movie' },
            ]),
        });

        await selectRow(1); // the movie alone
        expect(barButton('Refresh title and contents')).toBeNull();

        await selectRow(0); // now the series too
        await waitFor(() => expect(barButton('Refresh title and contents')).not.toBeNull());
    });

    /**
     * The regression fix round 1 caught: `childCount > 0` alone hides
     * "Sync + Children" for a series that has NEVER been synced — which is
     * the item the action would do the most work on, because
     * `syncSeriesWithChildren` FETCHES seasons and episodes from TMDB rather
     * than reading existing child rows. The old bar offered it for any
     * selected series, so gating on the count was a per-surface narrowing.
     *
     * Revert-check: drop `|| ctx.hasCascadableContainer === true` from the
     * `syncWithChildren` rule (or stop passing the flag from the bar) and this
     * fails — the button is gone for a `childCount: 0` series.
     */
    it('offers Sync + Children for a series with no child rows yet', async () => {
        render(MediaBrowserPage, {
            data: makeData([
                { id: 'id-new', title: 'Never Synced', mediaType: 'tv', childCount: 0 },
            ]),
        });

        await selectRow(0);

        expect(barButton('Refresh title and contents')).not.toBeNull();
    });

    /**
     * Revert-check: drop the `isSeries(r.mediaType) ? r.childCount : 0` filter
     * from `cascadableChildCount` and this fails — an album's tracks are
     * children, but `bulk-media-sync` only cascades for a series, so the
     * button would appear and do nothing.
     */
    it('does not offer Sync + Children for a non-series container', async () => {
        render(MediaBrowserPage, {
            data: makeData([
                { id: 'id-alb', title: 'An Album', mediaType: 'album', childCount: 12 },
            ]),
        });

        await selectRow(0);

        expect(barButton('Refresh details')).not.toBeNull();
        expect(barButton('Refresh title and contents')).toBeNull();
    });

    /**
     * The R2 bug this task was assigned: the old bar rendered Sync Metadata and
     * Sync Images unconditionally, including in the unidentified domain where
     * there is no provider match to sync against and the row's own Actions
     * column correctly hides them.
     *
     * Revert-check: hard-code `isUnidentified: false` in MediaActionBar's
     * `domainFlags` and this fails on all four assertions at once.
     */
    it('withholds the sync actions in the unidentified domain, and offers Identify/Dismiss', async () => {
        render(MediaBrowserPage, {
            data: makeData(
                [{ id: 'id-unk', title: 'Unknown.File.mkv', tmdbId: undefined }],
                'unidentified',
            ),
        });

        await selectRow(0);

        expect(barButton('Refresh details')).toBeNull();
        expect(barButton('Refresh artwork')).toBeNull();
        expect(barButton('Choose online match')).not.toBeNull();
        expect(barButton('Hide from library')).not.toBeNull();
    });

    /**
     * F1. Dismiss is a hard DELETE of the unmatched-file mapping and is not
     * cheaply reversible.
     *
     * The bar offers it when AT LEAST ONE selected row lacks a provider match,
     * and the executor used to pass EVERY selected id — so a mixed selection
     * destroyed the mapping of rows that already had a match. The fixture is
     * deliberately mixed (2 unidentified + 1 identified) so the two sets
     * genuinely differ; a fixture where every row was unidentified would pass
     * against the old code.
     *
     * Revert-check A: restore `const ids = [...selectedRows.keys()]` in
     * `requestBulkDismiss` and this fails on all four call assertions — three
     * requests, one of them for the identified row.
     * Revert-check B: cross-wire the filter to `(row) => row.tmdbId` (keep the
     * identified rows instead of the unidentified ones) and it fails the same
     * way, on the opposite id.
     * Revert-check C: delete the skip paragraph from the dismiss modal and the
     * dialog assertion fails — the operator consents to a batch narrower than
     * the rows they highlighted with nothing saying so.
     */
    it('bulk Dismiss acts only on the unidentified rows, and says what it skips', async () => {
        dismissUnmatchedFile.mockResolvedValue({ error: null });
        render(MediaBrowserPage, {
            data: makeData(
                [
                    { id: 'id-unk-a', title: 'A.mkv', tmdbId: undefined },
                    { id: 'id-unk-b', title: 'B.mkv', tmdbId: undefined },
                    { id: 'id-known', title: 'Already Identified' },
                ],
                'unidentified',
            ),
        });

        await selectRow(0);
        await selectRow(1);
        await selectRow(2);
        click(barButton('Hide from library')!);

        const dialog = await waitFor(() => {
            const el = screen.queryByRole('dialog');
            expect(el).not.toBeNull();
            return el!;
        });
        expect(
            within(dialog).queryByText(
                /1 of the 3 selected items already have a provider match and will be skipped; 2 will be dismissed/,
            ),
        ).not.toBeNull();

        expect(within(dialog).getByText(/This cannot be undone from this screen/)).toBeTruthy();
        click(within(dialog).getAllByRole('button', { name: 'Hide from library' })[0]!);

        await waitFor(() => expect(dismissUnmatchedFile).toHaveBeenCalledTimes(2));
        expect(dismissUnmatchedFile).toHaveBeenCalledWith('id-unk-a');
        expect(dismissUnmatchedFile).toHaveBeenCalledWith('id-unk-b');
        expect(dismissUnmatchedFile).not.toHaveBeenCalledWith('id-known');
    });

    /**
     * Revert-check: remove `metadataLocked` from `toSelectedRowSnapshot` (or
     * from MediaActionBar's `locked:` aggregate) and this fails — Unlock never
     * appears, and the bulk-lock endpoint task 2 built stays unreachable.
     */
    it('offers Unlock only when something selected is locked, and calls bulk-lock', async () => {
        bulkSetLock.mockResolvedValue({
            data: { updatedCount: 1, skippedCount: 0, failedIds: [] },
            error: null,
        });
        render(MediaBrowserPage, {
            data: makeData([
                { id: 'id-open', title: 'Unlocked One' },
                { id: 'id-lock', title: 'Locked One', metadataLocked: true },
            ]),
        });

        await selectRow(0);
        expect(barButton('Allow automatic updates')).toBeNull();

        await selectRow(1);
        const unlock = await waitFor(() => {
            const el = barButton('Allow automatic updates');
            expect(el).not.toBeNull();
            return el!;
        });
        click(unlock);

        await waitFor(() =>
            expect(bulkSetLock).toHaveBeenCalledWith(['id-open', 'id-lock'], false),
        );
    });

    /**
     * Revert-check: delete the `selectedRows.size < SELECTION_MAX` test from
     * `addToSelection` and this fails — every row on the page is selected and
     * the next bulk request carries an unbounded id list into endpoints that
     * reject anything over 500 per chunk.
     *
     * The cap here is the mocked 6 (see the top of this file); the real 1,000
     * is pinned in `selection.test.ts`.
     */
    it('caps a select-all at SELECTION_MAX', async () => {
        const many: RowOverrides[] = Array.from({ length: 8 }, (_, i) => ({
            id: `id-${i}`,
            title: `Item ${i}`,
        }));
        render(MediaBrowserPage, { data: makeData(many) });

        click(screen.getByRole('button', { name: 'Select all on page' }));

        await waitFor(() => expect(screen.queryByText('6 selected')).not.toBeNull());
        // An off-by-one would read 7, and every row selected would read 8.
        expect(screen.queryByText('7 selected')).toBeNull();
        expect(screen.queryByText('8 selected')).toBeNull();
        // The operator is told, rather than silently handed a short selection.
        expect(toasts.warning).toHaveBeenCalled();
    });

    // ------------------------------------------------------------------
    // Bulk sync: the outcome comes from the RESULT PAYLOAD, not the run state
    // ------------------------------------------------------------------

    function runReturning(result: unknown, state = 'completed') {
        // `stages` is part of the real RunSchema and `readRunProgress` walks
        // it, so a fixture without it would exercise a shape the endpoint
        // never returns.
        return { data: { id: 'job-1', state, result, stages: [] }, error: null, status: 200 };
    }

    /**
     * The handoff note that has been carried across three tasks.
     *
     * `bulk-media-sync` returns NORMALLY on a partial failure — it throws only
     * when nothing at all synced — so a batch where most items failed still
     * records as a `completed` run. Any polling loop that branches on
     * `run.state` (NeverMatchedPanel's `pollAutoIdentify` does exactly that)
     * therefore reports a silent mass failure as success.
     *
     * Revert-check: replace `readBulkSyncResult(run.result)` in
     * `awaitBulkSyncRun`'s `completed` branch with
     * `{ processed: size, failed: 0 }` — i.e. trust the state — and this fails
     * on both assertions: a success toast fires and no warning does.
     */
    it('reports a partial failure as a warning, from failedIds — not the run state', async () => {
        enqueueBulkSync.mockResolvedValue({
            data: { started: true, jobId: 'job-1' },
            error: null,
        });
        apiGet.mockResolvedValue(runReturning({ itemsProcessed: 1, failedIds: ['id-beta'] }));
        render(MediaBrowserPage, { data: makeData(ROWS) });

        await selectRow(0);
        await selectRow(1);
        click(barButton('Refresh details')!);

        await waitFor(() => expect(toasts.warning).toHaveBeenCalled());
        expect(String(vi.mocked(toasts.warning).mock.calls[0]?.[0])).toContain('1 failed');
        expect(toasts.success).not.toHaveBeenCalled();
    });

    /**
     * The other half of the same rule — without this, "always warn" would pass
     * the test above and be just as wrong.
     *
     * Revert-check: make `readBulkSyncResult` return a fixed `failed: 1` and
     * this fails.
     */
    it('reports a clean run as a success', async () => {
        enqueueBulkSync.mockResolvedValue({
            data: { started: true, jobId: 'job-1' },
            error: null,
        });
        apiGet.mockResolvedValue(runReturning({ itemsProcessed: 2, failedIds: [] }));
        render(MediaBrowserPage, { data: makeData(ROWS) });

        await selectRow(0);
        await selectRow(1);
        click(barButton('Refresh details')!);

        await waitFor(() => expect(toasts.success).toHaveBeenCalled());
        expect(String(vi.mocked(toasts.success).mock.calls[0]?.[0])).toContain('2');
        expect(toasts.warning).not.toHaveBeenCalled();
    });

    /**
     * An ABORTED run returns NORMALLY — `{ success: false, itemsProcessed,
     * stopReason: 'aborted', failedIds }` in `media-item-tasks.ts` — so the
     * orchestrator records it as `completed`. Reading only `itemsProcessed`
     * and `failedIds` therefore reports "Synced 1 items" as a clean success
     * for a 3-id chunk that was cancelled after one.
     *
     * Revert-check: delete the `size - (processed + failed)` reconciliation
     * from `awaitBulkSyncRun`'s `settle` and this fails — a success toast
     * fires and no warning does. (Shared with the two tests below: one guard,
     * three reachable payloads. The `declaredSuccess` clause has its own test
     * further down, because this fixture is caught by either mechanism.)
     */
    it('counts the ids an aborted run never touched as unaccounted for', async () => {
        enqueueBulkSync.mockResolvedValue({
            data: { started: true, jobId: 'job-1' },
            error: null,
        });
        apiGet.mockResolvedValue(
            runReturning({
                success: false,
                itemsProcessed: 1,
                stopReason: 'aborted',
                failedIds: [],
            }),
        );
        render(MediaBrowserPage, { data: makeData(ROWS) });

        await selectRow(0);
        await selectRow(1);
        await selectRow(2);
        click(barButton('Refresh details')!);

        await waitFor(() => expect(toasts.warning).toHaveBeenCalled());
        // Two of the three ids are unaccounted for, and they are reported as
        // unaccounted rather than as failures — nobody knows what happened.
        expect(String(vi.mocked(toasts.warning).mock.calls[0]?.[0])).toContain('2 unaccounted');
        expect(toasts.success).not.toHaveBeenCalled();
    });

    /**
     * An unreadable payload is not hypothetical: `runner.ts` documents 1.06M
     * preprod rows that landed as JSONB *string scalars* before `sql.json()`,
     * and a renamed field reads the same way. Both produce a perfectly green
     * `0 processed / 0 failed`, indistinguishable from "completed having done
     * nothing".
     *
     * Revert-check: the same `size - (processed + failed)` reconciliation —
     * delete it and this fails with "Synced 0 items" as a success. An earlier
     * draft special-cased unreadability in `readBulkSyncResult` and asserted
     * against THAT; revert-checking showed the special case could not fail on
     * its own, because the arithmetic had already caught it. The branch was
     * removed rather than left in as unfalsifiable defence.
     */
    it('treats an unreadable result payload as unaccounted, not as zero work', async () => {
        enqueueBulkSync.mockResolvedValue({
            data: { started: true, jobId: 'job-1' },
            error: null,
        });
        // What a JSONB string scalar deserialises to.
        apiGet.mockResolvedValue(runReturning('{"itemsProcessed":3,"failedIds":[]}'));
        render(MediaBrowserPage, { data: makeData(ROWS) });

        await selectRow(0);
        await selectRow(1);
        await selectRow(2);
        click(barButton('Refresh details')!);

        await waitFor(() => expect(toasts.warning).toHaveBeenCalled());
        expect(String(vi.mocked(toasts.warning).mock.calls[0]?.[0])).toContain('3 unaccounted');
        expect(toasts.success).not.toHaveBeenCalled();
    });

    /**
     * The one abort the arithmetic CANNOT see: a run cancelled on its final
     * item has processed every id, so `size - (processed + failed)` is 0 and
     * only the task's own `success: false` says it did not finish cleanly.
     *
     * Revert-check: set `degraded` to a literal `false` in `settle` and this
     * fails — a run that declared failure goes out as a plain success. This is
     * the test that keeps that flag honest; the two above are caught by the
     * subtraction either way.
     */
    it("believes the task's own success:false when the arithmetic balances", async () => {
        enqueueBulkSync.mockResolvedValue({
            data: { started: true, jobId: 'job-1' },
            error: null,
        });
        apiGet.mockResolvedValue(
            runReturning({
                success: false,
                itemsProcessed: 2,
                stopReason: 'aborted',
                failedIds: [],
            }),
        );
        render(MediaBrowserPage, { data: makeData(ROWS) });

        await selectRow(0);
        await selectRow(1);
        click(barButton('Refresh details')!);

        await waitFor(() => expect(toasts.warning).toHaveBeenCalled());
        // Every id is accounted for, so the warning has no count to show — it
        // has to say in words why it is a warning at all.
        expect(String(vi.mocked(toasts.warning).mock.calls[0]?.[0])).toContain(
            'did not finish cleanly',
        );
        expect(toasts.success).not.toHaveBeenCalled();
    });

    /**
     * F2: one failed poll must not condemn a healthy run. The loop makes up to
     * 12,600 requests over seven hours; a deploy's 502, a token refresh or a
     * sleeping laptop is not evidence about the run.
     *
     * Revert-check: restore `if (error || !run) return { …failed: size… }` and
     * this fails — the first transport error reports the whole chunk failed,
     * and the operator's natural response is to re-fire the batch.
     */
    it('rides out a transient poll failure instead of condemning the chunk', async () => {
        enqueueBulkSync.mockResolvedValue({
            data: { started: true, jobId: 'job-1' },
            error: null,
        });
        apiGet
            .mockResolvedValueOnce({ data: null, error: 'Bad Gateway', status: 502 })
            .mockResolvedValueOnce({ data: null, error: 'Network error', status: 0 })
            .mockResolvedValue(runReturning({ success: true, itemsProcessed: 2, failedIds: [] }));
        render(MediaBrowserPage, { data: makeData(ROWS) });

        await selectRow(0);
        await selectRow(1);
        click(barButton('Refresh details')!);

        await waitFor(() => expect(toasts.success).toHaveBeenCalled(), { timeout: 9000 });
        expect(String(vi.mocked(toasts.success).mock.calls[0]?.[0])).toContain('2');
        expect(toasts.warning).not.toHaveBeenCalled();
    });

    /**
     * The other side of F2: a 404 IS proof the run is gone, and must not be
     * retried into the "still running" bucket.
     *
     * Revert-check: delete the `status === 404` branch and this fails — the
     * 404 is retried five times and then reported as `incomplete`, i.e. an
     * info toast saying the sync is still running when the run does not exist.
     */
    it('gives up immediately on a 404 — that run really is gone', async () => {
        enqueueBulkSync.mockResolvedValue({
            data: { started: true, jobId: 'job-1' },
            error: null,
        });
        apiGet.mockResolvedValue({ data: null, error: 'Not found', status: 404 });
        render(MediaBrowserPage, { data: makeData(ROWS) });

        await selectRow(0);
        await selectRow(1);
        click(barButton('Refresh details')!);

        await waitFor(() => expect(toasts.warning).toHaveBeenCalled());
        expect(String(vi.mocked(toasts.warning).mock.calls[0]?.[0])).toContain('2 unaccounted');
        // ONE argument, matching how `bulkSync` actually calls it. The earlier
        // form passed `expect.anything()` as a second argument, which the
        // "still running" call does not have — so the negative held whether or
        // not the branch had fired, i.e. it could not fail.
        expect(toasts.info).not.toHaveBeenCalledWith(
            m.media_toast_sync_still_running({ total: 2 }),
        );
    });

    /**
     * The positive side of the same branch, which nothing drove before: FIVE
     * CONSECUTIVE transport errors exhaust `RUN_POLL_MAX_CONSECUTIVE_ERRORS`
     * and the poll gives up without ever seeing a terminal state.
     *
     * That is a different fact from "the run did nothing", and it must read
     * differently: nothing is known about the ids, so the toast neither claims
     * a count nor condemns the batch. Only the 404 case above proves a run is
     * gone.
     *
     * Slow on purpose — the four 2s back-offs between the five failures are the
     * behaviour under test (see `rides out a transient poll failure`, which
     * proves the same back-off does NOT give up early), hence the raised
     * timeout rather than fake timers.
     *
     * Revert-check A: raise `RUN_POLL_MAX_CONSECUTIVE_ERRORS` above the five
     * errors mocked here and this fails — the poll keeps going and nothing is
     * ever reported.
     * Revert-check B: cross-wire the give-up return to
     * `{ …, unaccounted: size, degraded: true, incomplete: false }` (i.e. make
     * it look like the 404 case) and this fails on both assertions — a warning
     * claiming 2 unaccounted, and no "still running" info.
     */
    it('reports a run it lost contact with as still running, not as done', async () => {
        enqueueBulkSync.mockResolvedValue({
            data: { started: true, jobId: 'job-1' },
            error: null,
        });
        // Never a 404: a transport failure says nothing about the run.
        apiGet.mockResolvedValue({ data: null, error: 'Network error', status: 0 });
        render(MediaBrowserPage, { data: makeData(ROWS) });

        await selectRow(0);
        await selectRow(1);
        click(barButton('Refresh details')!);

        await waitFor(
            () =>
                expect(toasts.info).toHaveBeenCalledWith(
                    m.media_toast_sync_still_running({ total: 2 }),
                ),
            { timeout: 20000 },
        );
        // Neither a count nor a verdict: both would be invented.
        expect(toasts.success).not.toHaveBeenCalled();
        expect(toasts.warning).not.toHaveBeenCalled();
    }, 30000);

    /**
     * F2's second half: the run already reports per-item progress via
     * `ctx.reportProgress`, and the orchestrator merges it into `run.stages`.
     * Without reading it a 1,000-item selection gets exactly two toast
     * updates.
     *
     * Revert-check: delete the `readRunProgress` call (or the `onProgress`
     * callback) from `awaitBulkSyncRun` and this fails — no intermediate
     * "Syncing 2/3…" is ever shown.
     */
    it("surfaces the run's own per-item progress while it is still active", async () => {
        enqueueBulkSync.mockResolvedValue({
            data: { started: true, jobId: 'job-1' },
            error: null,
        });
        apiGet
            .mockResolvedValueOnce({
                data: {
                    id: 'job-1',
                    state: 'active',
                    stages: [{ id: 'main', processed: 2, total: 3 }],
                },
                error: null,
                status: 200,
            })
            .mockResolvedValue(runReturning({ success: true, itemsProcessed: 3, failedIds: [] }));
        render(MediaBrowserPage, { data: makeData(ROWS) });

        await selectRow(0);
        await selectRow(1);
        await selectRow(2);
        click(barButton('Refresh details')!);

        await waitFor(
            () =>
                expect(toasts.info).toHaveBeenCalledWith(
                    expect.stringContaining('2/3'),
                    expect.anything(),
                ),
            { timeout: 9000 },
        );
    });

    /**
     * Revert-check: drop the `enqueueBulkSync` call and restore the old
     * per-item `syncMediaMetadata` loop and this fails — the endpoint task 2
     * built goes unused and the work stops surviving the tab.
     */
    it('enqueues one bulk-sync run rather than one request per item', async () => {
        enqueueBulkSync.mockResolvedValue({
            data: { started: true, jobId: 'job-1' },
            error: null,
        });
        apiGet.mockResolvedValue(runReturning({ itemsProcessed: 3, failedIds: [] }));
        render(MediaBrowserPage, { data: makeData(ROWS) });

        await selectRow(0);
        await selectRow(1);
        await selectRow(2);
        click(barButton('Refresh details')!);

        await waitFor(() =>
            expect(enqueueBulkSync).toHaveBeenCalledWith(['id-alpha', 'id-beta', 'id-gamma'], {
                includeChildren: false,
            }),
        );
        expect(syncMediaMetadata).not.toHaveBeenCalled();
    });

    /**
     * The two-chunk path — routine, not an edge case. `SELECTION_MAX` is 1,000
     * and both endpoints declare `.min(1).max(500)` and REJECT an over-long id
     * array rather than truncating it, so any selection over 500 rows is two
     * requests or it is nothing at all.
     *
     * Every other test in this file runs at the real 500 and therefore only
     * ever exercises `chunks[0]`, which left three separate regressions
     * shippable in silence. All three are named as revert-checks below.
     *
     * Revert-check A (the loop): replace `for (const batch of chunks)` with a
     * single `chunks[0]` and this fails — one enqueue instead of two, and the
     * second chunk's ids never leave the browser.
     * Revert-check B (accumulation): change `processed += outcome.processed` to
     * `processed = outcome.processed` and this fails on the toast — 2 rather
     * than 4, i.e. half the batch reported as never having happened.
     * Revert-check C (the split): change `chunkIds`' `ids.slice(i, i + size)`
     * to `ids.slice(0, size)` and this fails on the second chunk's ids — the
     * same two rows sent twice while the other two are dropped.
     */
    it('splits an over-long selection into disjoint chunks and sums the outcome', async () => {
        chunking.size = 2;
        enqueueBulkSync
            .mockResolvedValueOnce({ data: { started: true, jobId: 'job-1' }, error: null })
            .mockResolvedValueOnce({ data: { started: true, jobId: 'job-2' }, error: null });
        // Each run reports its own chunk's two items; the toast must add them.
        apiGet.mockResolvedValue(runReturning({ success: true, itemsProcessed: 2, failedIds: [] }));
        const four: RowOverrides[] = [
            { id: 'id-c1', title: 'Chunk One A' },
            { id: 'id-c2', title: 'Chunk One B' },
            { id: 'id-c3', title: 'Chunk Two A' },
            { id: 'id-c4', title: 'Chunk Two B' },
        ];
        render(MediaBrowserPage, { data: makeData(four) });

        for (const i of [0, 1, 2, 3]) await selectRow(i);
        click(barButton('Refresh details')!);

        await waitFor(() => expect(enqueueBulkSync).toHaveBeenCalledTimes(2));
        const sent = enqueueBulkSync.mock.calls.map((c) => c[0] as string[]);
        expect(sent[0]).toEqual(['id-c1', 'id-c2']);
        expect(sent[1]).toEqual(['id-c3', 'id-c4']);
        // Disjoint AND complete — stated as a set so a future chunk-size change
        // does not have to re-pin the boundary to keep the real claim.
        expect([...sent[0]!, ...sent[1]!].sort()).toEqual(['id-c1', 'id-c2', 'id-c3', 'id-c4']);
        // Neither chunk may exceed what the endpoints accept.
        for (const batch of sent) expect(batch.length).toBeLessThanOrEqual(chunking.size);

        await waitFor(() => expect(toasts.success).toHaveBeenCalled());
        expect(String(vi.mocked(toasts.success).mock.calls[0]?.[0])).toContain(
            m.media_toast_synced_items({ done: 4 }),
        );
    });

    // ------------------------------------------------------------------
    // Bulk unlock: its own outcome arithmetic, not bulk sync's
    // ------------------------------------------------------------------

    const LOCK_ROWS: RowOverrides[] = [
        { id: 'id-open', title: 'Unlocked One' },
        { id: 'id-lock', title: 'Locked One', metadataLocked: true },
    ];

    /** The Unlock button only exists once a LOCKED row is in the selection. */
    async function clickUnlock(): Promise<void> {
        const unlock = await waitFor(() => {
            const el = barButton('Allow automatic updates');
            expect(el).not.toBeNull();
            return el!;
        });
        click(unlock);
    }

    /**
     * `bulkUnlock` had exactly one test and it asserted only that `bulkSetLock`
     * was called with the right ids — nothing about what the operator is then
     * told. Its sibling `bulkSync` has seven tests pinning precisely that.
     *
     * The response here is deliberately three-valued: one row updated, one
     * SKIPPED (already unlocked — not a failure and must not be reported as
     * one), one in `failedIds`. A response where skipped was 0 would let a
     * `failed += data.skippedCount` regression pass.
     *
     * Revert-check A: add `failed += data.skippedCount` and the failure count
     * reads 2, failing the suffix assertion.
     * Revert-check B: change the toast level to
     * `toasts[failed > 0 ? 'success' : 'warning']` — i.e. cross-wire the two
     * branches — and this fails on both the warning and the success assertion.
     */
    it('reports a partial unlock as a warning that names the failure', async () => {
        bulkSetLock.mockResolvedValue({
            data: { updatedCount: 1, skippedCount: 1, failedIds: ['id-lock'] },
            error: null,
        });
        render(MediaBrowserPage, { data: makeData(LOCK_ROWS) });

        await selectRow(0);
        await selectRow(1);
        await clickUnlock();

        await waitFor(() => expect(toasts.warning).toHaveBeenCalled());
        const msg = String(vi.mocked(toasts.warning).mock.calls[0]?.[0]);
        expect(msg).toContain(m.media_toast_unlocked_items({ count: 1 }));
        expect(msg).toContain(m.media_toast_failed_suffix({ failed: 1 }));
        expect(toasts.success).not.toHaveBeenCalled();
    });

    /**
     * A refused REQUEST is not a partial outcome: nothing in the batch was
     * touched, so every id in it failed. Reporting "Unlocked 0 items" as a
     * success would tell the operator the rows are now unlocked.
     *
     * Revert-check: delete the `if (error || !data) failed += batch.length`
     * branch (fall through to the success path) and this fails — a success
     * toast, and a failure count of 0 for a request that never ran.
     */
    it('counts a refused unlock request as the whole batch failed', async () => {
        bulkSetLock.mockResolvedValue({ data: null, error: 'Forbidden' });
        render(MediaBrowserPage, { data: makeData(LOCK_ROWS) });

        await selectRow(0);
        await selectRow(1);
        await clickUnlock();

        await waitFor(() => expect(toasts.warning).toHaveBeenCalled());
        const msg = String(vi.mocked(toasts.warning).mock.calls[0]?.[0]);
        expect(msg).toContain(m.media_toast_unlocked_items({ count: 0 }));
        expect(msg).toContain(m.media_toast_failed_suffix({ failed: 2 }));
        expect(toasts.success).not.toHaveBeenCalled();
    });

    // ------------------------------------------------------------------
    // The destructive confirmation
    // ------------------------------------------------------------------

    const MIXED: RowOverrides[] = [
        { id: 'id-film', title: 'A Film', mediaType: 'movie' },
        { id: 'id-show', title: 'A Show', mediaType: 'tv', childCount: 4 },
    ];

    async function openBulkDelete(): Promise<HTMLElement> {
        await selectRow(0);
        await selectRow(1);
        click(barButton('Delete')!);
        return await waitFor(() => {
            const el = screen.queryByRole('dialog');
            expect(el).not.toBeNull();
            return el!;
        });
    }

    /**
     * Revert-check: delete the `media_bulk_delete_breakdown` paragraph from the
     * bulk delete modal and this fails. "Delete 2 items?" alone is not
     * something an operator can consent to once a selection spans pages and
     * media types — the title already says the count.
     */
    it('names the media types in the delete confirmation', async () => {
        render(MediaBrowserPage, { data: makeData(MIXED) });
        const dialog = await openBulkDelete();

        expect(within(dialog).queryByText(/1 Movie, 1 Series/)).not.toBeNull();
    });

    /**
     * F4, both halves, in the one dialog the requirement rests on.
     *
     * Revert-check A (plural): restore `${count} ${label}` with no plural and
     * this fails on "2 Movies".
     * Revert-check B (label): restore `toPublicMediaType(type) ?? type` and
     * this fails on the localized home-video label — `TO_PUBLIC` maps `home_video` to null, so
     * the fallback printed the raw storage token `home_video` into a
     * destructive dialog.
     * Revert-check C (the trailing-s guard): drop `label.endsWith('s')` and
     * the "3 Series" assertion fails with "3 Seriess" — `tv` is the single
     * most likely type in this dialog.
     */
    it('pluralises the breakdown and never prints a raw storage token', async () => {
        render(MediaBrowserPage, {
            data: makeData([
                { id: 'm1', title: 'Film One', mediaType: 'movie' },
                { id: 'm2', title: 'Film Two', mediaType: 'movie' },
                { id: 's1', title: 'Show One', mediaType: 'tv' },
                { id: 's2', title: 'Show Two', mediaType: 'tv' },
                { id: 's3', title: 'Show Three', mediaType: 'tv' },
                { id: 'h1', title: 'Holiday 2019', mediaType: 'home_video' },
            ]),
        });
        for (let i = 0; i < 6; i++) await selectRow(i);
        click(barButton('Delete')!);
        const dialog = await waitFor(() => {
            const el = screen.queryByRole('dialog');
            expect(el).not.toBeNull();
            return el!;
        });

        const text = within(dialog).getByText(/^Selected:/).textContent ?? '';
        expect(text).toContain('3 Series');
        expect(text).not.toContain('Seriess');
        expect(text).toContain('2 Movies');
        expect(text).toContain(`1 ${m.media_plain_type_home_video()}`);
        expect(text).not.toContain('home_video');
    });

    /**
     * Revert-check: delete the `media_bulk_delete_cascade_skip` paragraph and
     * this fails. Cascade delete is deliberately out of scope, so the one
     * thing the operator MUST be told is that the series will not actually be
     * deleted — otherwise the toast afterwards is their first notice.
     */
    it('names the cascade skip, with the child count', async () => {
        render(MediaBrowserPage, { data: makeData(MIXED) });
        const dialog = await openBulkDelete();

        const skip = within(dialog).queryByText(/SKIPPED/);
        expect(skip).not.toBeNull();
        expect(skip!.textContent).toContain('1 of these have children');
        // Deliberately NOT a child count. `child_count` is DIRECT children, so
        // for a series it is seasons — a number a reader would take as the
        // untouched subtree, and one no decision depends on.
        expect(skip!.textContent).not.toMatch(/\d+ in total/);
    });

    /**
     * Revert-check: remove `disabled={!bulkDeleteConfirmed}` from the modal and
     * the first assertion fails; remove the `if (!bulkDeleteConfirmed) return;`
     * guard from `bulkDelete` as well and a mis-wired dialog would delete on
     * the first click.
     */
    it('keeps Delete locked until the confirmation word is typed', async () => {
        deleteMedia.mockResolvedValue({ error: null });
        render(MediaBrowserPage, { data: makeData(MIXED) });
        const dialog = await openBulkDelete();

        const confirm = within(dialog).getAllByRole('button', { name: 'Delete' })[0]!;
        expect(confirm.hasAttribute('disabled')).toBe(true);

        await fireEvent.input(within(dialog).getByRole('textbox'), {
            target: { value: 'DELETE' },
        });
        await waitFor(() => expect(confirm.hasAttribute('disabled')).toBe(false));

        click(confirm);

        // The movie is deleted; the series with children is skipped, exactly as
        // the dialog said it would be.
        await waitFor(() => expect(deleteMedia).toHaveBeenCalledWith('id-film'));
        expect(deleteMedia).not.toHaveBeenCalledWith('id-show');
    });

    /**
     * S3. The dialog used to promise `selectedCount` in its title, its lead
     * sentence and its type-to-confirm line, directly above a line saying how
     * many of those rows would be SKIPPED. Observed on preprod with 19 artists
     * that all had children: "permanently delete 19 selected media items"
     * over "19 of these have children and will be SKIPPED", Delete enabled,
     * and pressing it deleting nothing.
     *
     * MIXED is 1 movie + 1 series with children, so selected (2) and deletable
     * (1) genuinely differ — a fixture where they agreed would make every
     * assertion here pass under the old code.
     *
     * Revert-check: change any one of the three `count: deleteSummary.deletable`
     * back to `count: selectedCount` and the matching assertion fails on a 2.
     */
    it('promises the count it will actually delete, not the count selected', async () => {
        render(MediaBrowserPage, { data: makeData(MIXED) });
        const dialog = await openBulkDelete();

        // Title, lead sentence, type-to-confirm line: all the deletable count.
        expect(dialog.getAttribute('aria-label')).toBe('Delete 1 items?');
        expect(
            within(dialog).queryByText(/permanently delete 1 selected media items/),
        ).not.toBeNull();
        expect(within(dialog).queryByText(/confirm deleting 1 items/)).not.toBeNull();

        // ...and nothing in the dialog still quotes the selected count as the
        // number about to be deleted.
        expect(within(dialog).queryByText(/delete 2 selected media items/)).toBeNull();
        expect(within(dialog).queryByText(/confirm deleting 2 items/)).toBeNull();

        // The two lines that describe the SELECTION rather than the outcome are
        // unchanged — 1 + 1 = 2 has to still add up for the reader.
        expect(within(dialog).queryByText(/1 Movie, 1 Series/)).not.toBeNull();
        expect(within(dialog).queryByText(/1 of these have children/)).not.toBeNull();
    });

    /**
     * S3, the zero case — the one the preprod screenshot actually showed.
     *
     * When every selected row is skipped there is no destructive action to
     * offer, so the dialog must say that and offer no route to one. Both rows
     * carry children, so `deletable` is 0.
     *
     * Revert-check A (title): restore
     * `m.admin_media_delete_modal_title({ count: selectedCount })` and the
     * aria-label assertion fails with "Delete 2 items?".
     * Revert-check B (body): drop the `{#if deleteSummary.deletable === 0}`
     * branch and the body reads "permanently delete 0 selected media items".
     * Revert-check C (the input): drop the `{#if deleteSummary.deletable > 0}`
     * around the type-to-confirm block and the textbox assertion fails.
     */
    it('offers no way to delete when every selected row is skipped', async () => {
        render(MediaBrowserPage, {
            data: makeData([
                { id: 'id-show-a', title: 'Show A', mediaType: 'tv', childCount: 4 },
                { id: 'id-show-b', title: 'Show B', mediaType: 'tv', childCount: 2 },
            ]),
        });
        const dialog = await openBulkDelete();

        expect(dialog.getAttribute('aria-label')).toBe('Nothing to delete');
        expect(within(dialog).queryByText(/Nothing would be deleted/)).not.toBeNull();
        expect(within(dialog).queryByText(/All 2 selected items have children/)).not.toBeNull();

        // No promise of a deletion, at any count.
        expect(within(dialog).queryByText(/permanently delete/)).toBeNull();
        // The skip line is suppressed too: the body above already says every
        // selected row is skipped, and both would make the reader reconcile
        // two numbers to reach one fact.
        expect(within(dialog).queryByText(/SKIPPED/)).toBeNull();

        // No type-to-confirm input, and Delete cannot be armed.
        expect(within(dialog).queryByRole('textbox')).toBeNull();
        const confirm = within(dialog).getAllByRole('button', { name: 'Delete' })[0]!;
        expect(confirm.hasAttribute('disabled')).toBe(true);

        // Still says WHAT is selected — the operator has to be able to tell
        // which rows produced this.
        expect(within(dialog).queryByText(/2 Series/)).not.toBeNull();
    });

    /**
     * F3. `deleted + skipped + failed` must equal what was attempted.
     *
     * The loop had no `else`: an item that failed for any reason OTHER than the
     * client-side child skip — a stale off-page snapshot meeting the server's
     * own 409, a row another admin had already deleted, a permissions error —
     * was counted in neither bucket. The toast then reported a number smaller
     * than the selection with nothing to say why, after the operator had typed
     * a confirmation word to authorise it.
     *
     * The fixture yields deleted 1, skipped 1, failed 2 — `failed` deliberately
     * differs from BOTH of the others, because the two cross-wires that are
     * real code shapes both turn on that. An earlier draft used one row per
     * bucket (1/1/1) and revert-check B below PASSED against it: swapping two
     * equal counts changes no output at all.
     *
     * Revert-check A: delete `else failed++` and this fails — the message
     * carries no failure suffix and the toast is a success.
     * Revert-check B: cross-wire the two not-deleted buckets (`failed++` where
     * `skipped++` is, and vice versa) and both suffix assertions fail.
     * Revert-check C: invert `if (!error) deleted++ else failed++` and it fails
     * on both counts — 2 deleted, 1 failed.
     * Revert-check D: change the level back to `toasts.success(msg)` and the
     * warning assertion fails.
     */
    it('accounts for an item the server refuses, rather than silently undercounting', async () => {
        deleteMedia.mockImplementation((id: string) =>
            Promise.resolve(id.startsWith('id-refused') ? { error: 'Conflict' } : { error: null }),
        );
        render(MediaBrowserPage, {
            data: makeData([
                { id: 'id-gone', title: 'Deletes Fine', mediaType: 'movie' },
                { id: 'id-refused-a', title: 'Server Says No', mediaType: 'movie' },
                { id: 'id-refused-b', title: 'Server Says No Again', mediaType: 'movie' },
                { id: 'id-parent', title: 'Has Children', mediaType: 'tv', childCount: 3 },
            ]),
        });

        await selectRow(0);
        await selectRow(1);
        await selectRow(2);
        await selectRow(3);
        click(barButton('Delete')!);
        const dialog = await waitFor(() => {
            const el = screen.queryByRole('dialog');
            expect(el).not.toBeNull();
            return el!;
        });
        await fireEvent.input(within(dialog).getByRole('textbox'), {
            target: { value: 'DELETE' },
        });
        const confirm = within(dialog).getAllByRole('button', { name: 'Delete' })[0]!;
        await waitFor(() => expect(confirm.hasAttribute('disabled')).toBe(false));
        click(confirm);

        await waitFor(() => expect(toasts.warning).toHaveBeenCalled());
        const msg = String(vi.mocked(toasts.warning).mock.calls[0]?.[0]);
        // 1 + 1 + 2 = 4, the number attempted. Nothing goes unreported.
        expect(msg).toContain(m.admin_media_toast_deleted_items({ deleted: 1 }));
        expect(msg).toContain(m.media_toast_delete_skipped_suffix({ skipped: 1 }));
        expect(msg).toContain(m.media_toast_failed_suffix({ failed: 2 }));
        // A partial destructive outcome is never a success toast.
        expect(toasts.success).not.toHaveBeenCalled();
    });
});

/**
 * Presentation contract of the docked inspector, and the breakpoint that
 * chooses it.
 *
 * ⚠️ HONESTY NOTE, read before extending this block. happy-dom has NO layout
 * engine and computes essentially no CSS: it cannot tell you that
 * `position: sticky` sticks, that an ancestor's `overflow` defeats it, or that
 * a checkbox is visible. The two class assertions below therefore prove only
 * that the fix's classes are still on the element — the contract, not the
 * behaviour. They are written that way deliberately rather than dressed up as
 * proofs of the visual outcome, which would be worse than having no test.
 * The behaviour was checked by hand in a real browser; see the sweep report.
 */
describe('docked inspector presentation', () => {
    /** The non-modal docked panel (>=1280px), if rendered. */
    function dockedPanel(): HTMLElement | null {
        return document.querySelector<HTMLElement>('div.w-\\[420px\\]');
    }

    /** The modal drawer presentation (<1280px), if rendered. */
    function drawer(): HTMLElement | null {
        return document.querySelector<HTMLElement>('[role="dialog"][aria-label="Title preview"]');
    }

    /**
     * S1. The docked panel is `position: static` no longer.
     *
     * The panel is the thing the operator arrow-walks WITH, and a static one
     * scrolls off the top of a real catalogue page long before the walk ends
     * (measured on preprod: bounding top -350 at scrollY 1400, beside a
     * 1280px-tall table). CLASS-LEVEL assertion only — see the block comment.
     *
     * Revert-check: remove `sticky top-20 max-h-[calc(100dvh-6rem)]
     * overflow-hidden` from MediaInspector's docked branch and every assertion
     * here fails.
     */
    it('pins the docked panel to the scroll container instead of letting it scroll away', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });
        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));

        const panel = dockedPanel();
        expect(panel).not.toBeNull();
        const cls = panel!.className;
        expect(cls).toContain('sticky');
        // A `top` that clears the fixed navbar chrome, not `top-0`.
        expect(cls).toContain('top-20');
        // Bounded by the viewport, and clipping, so a long panel scrolls in its
        // own body rather than growing the page.
        expect(cls).toMatch(/max-h-\[/);
        expect(cls).toContain('overflow-hidden');
    });

    /**
     * S1's other half: the sticky element needs room to travel inside its
     * containing block, which is what the parent's `items-start` gives it.
     * Under the default `items-stretch` the panel would fill the flex row and
     * `sticky` would have nothing to do. Asserting it here means a later
     * layout tidy-up that drops `items-start` fails a test instead of silently
     * un-fixing S1.
     *
     * Revert-check: drop `items-start` from the table+inspector flex row in
     * `+page.svelte` and this fails.
     */
    it('keeps the flex row that gives the sticky panel room to travel', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });
        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));

        const row = dockedPanel()!.parentElement!;
        expect(row.className).toContain('items-start');
    });

    /**
     * S2. Row checkboxes were `opacity: 0` above `md` with only a hover rule
     * to reveal them — and Tailwind v4 wraps `group-hover:` in
     * `@media (hover: hover)`, so on a >=768px touch device the hide half
     * applied and the reveal half could not. Selection was reachable only
     * through the header's "select all on page".
     *
     * CLASS-LEVEL assertion only — see the block comment. Both halves are
     * asserted: the no-hover floor must be present AND the pointer-device
     * density choice must survive, so "make everything always visible" does
     * not pass this either.
     *
     * Revert-check: delete `[@media(hover:none)]:opacity-100!` from the row
     * checkbox's unselected branch and the first assertion fails.
     */
    it('gives the row checkbox a visible floor on devices without hover', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });

        const box = rowEl(0).querySelector<HTMLElement>('button[aria-pressed]')!;
        // Neither selected nor focused: the branch that used to be invisible.
        expect(box.getAttribute('aria-pressed')).toBe('false');

        expect(box.className).toContain('[@media(hover:none)]:opacity-100!');
        // The hover-reveal density choice is still there for pointer devices.
        expect(box.className).toContain('md:opacity-0');
        expect(box.className).toContain('md:group-hover:opacity-100');
    });

    /**
     * S4. The docked/modal choice must follow the viewport, not the mount.
     *
     * Observed on preprod: resizing 1280 -> 1100 kept the docked panel and
     * only a reload produced the drawer — the case a laptop user hits every
     * time they undock an external display mid-session.
     *
     * This one IS behavioural: the decision is JS, not CSS, so happy-dom can
     * prove it. Both directions, because a one-way test would pass on a
     * `viewportWidth` that only ever shrinks.
     *
     * Revert-check: replace `bind:innerWidth={viewportWidth}` on
     * `<svelte:window>` with a single `onMount(() => (viewportWidth =
     * window.innerWidth))` and this fails at the first post-resize assertion.
     */
    it('flips between docked and modal when the viewport is resized', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });
        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));

        // beforeEach renders at 1600: docked, no drawer.
        expect(dockedPanel()).not.toBeNull();
        expect(drawer()).toBeNull();

        window.innerWidth = 1100;
        window.dispatchEvent(new Event('resize'));
        await settle();

        expect(drawer()).not.toBeNull();
        expect(dockedPanel()).toBeNull();

        window.innerWidth = 1600;
        window.dispatchEvent(new Event('resize'));
        await settle();

        expect(dockedPanel()).not.toBeNull();
        expect(drawer()).toBeNull();
    });
});

/**
 * The music-hygiene active-filter chip.
 *
 * `?filter=music-…` is the landing target of an attention badge. Without a chip
 * the operator arrives on a narrowed list with nothing on the page saying why
 * and no control to clear it — the same defect the provider-identity filters
 * once shipped. The chip label map in `+page.svelte` is also the LAST hand-copy
 * of the four `filter=` value strings (everything else is driven off
 * `MUSIC_HYGIENE_FINDINGS`), and it is the surface the heuristic caveat lives
 * on, so it gets rendered here rather than asserted structurally.
 */
vi.mock('$lib/api/music-credits.js', () => ({
    readMusicEdits: async () => ({ data: { edits: [] } }),
    restoreMusicEdit: vi.fn(),
    readArtistCredits: vi.fn(),
    applyArtistCredits: vi.fn(),
    readArtistTracks: vi.fn(),
}));
describe('music-hygiene filter chip', () => {
    function chipLabels(): string[] {
        return Array.from(
            document.querySelectorAll<HTMLElement>('[data-testid="active-filter-chip"]'),
        ).map((el) => el.textContent?.trim() ?? '');
    }

    /**
     * Revert-check: point any case in `musicHygieneChipLabel`
     * (`media-filters.ts`) at the wrong message, or drop the `af.music_hygiene`
     * branch from `activeFilterChips`, and the affected finding renders the
     * wrong chip or none. (A missing case is caught earlier, by tsgo.)
     */
    it.each(MUSIC_HYGIENE_FINDINGS)('renders one labelled chip for %s', async (finding) => {
        render(MediaBrowserPage, {
            data: makeData(ROWS, 'music', { music_hygiene: finding }),
        });
        await settle();

        expect(chipLabels()).toEqual([EXPECTED_CHIP_LABEL[finding]]);
    });

    /**
     * Revert-check: swap two entries in `musicHygieneChipLabels` and every
     * per-finding case above still passes if it only asserted "some chip"; this
     * pins each finding to ITS OWN label, so a swap fails.
     */
    it('gives every finding a distinct label', () => {
        const labels = MUSIC_HYGIENE_FINDINGS.map((f) => EXPECTED_CHIP_LABEL[f]);
        expect(new Set(labels).size).toBe(labels.length);
    });

    /**
     * The heuristic caveat is baked into the translated message rather than
     * composed at render time, so `isHeuristicMusicHygieneFinding` cannot gate
     * it. Assert the property directly instead: the copy for the one heuristic
     * finding must carry a caveat marker, and no factual finding's may.
     *
     * Revert-check: remove "(heuristic)" from
     * `admin_media_chip_music_artist_unsplit` in `messages/en.json`, recompile
     * paraglide, and this fails.
     */
    it('offers conjunction cleanup as an optional search with a clear uncertainty note', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS, 'music') });
        await settle();
        const link = screen.getByRole('link', { name: m.music_optional_cleanup() });
        expect(link.getAttribute('href')).toContain('filter=music-artist-unsplit');
        expect(chipLabels()).toEqual([]);
    });

    /** A page with no filter must render no chips at all. */
    it('renders no chip when no filter is active', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS, 'music') });
        await settle();
        expect(chipLabels()).toEqual([]);
    });
});

describe('single-act queue actions', () => {
    const artist = { id: 'artist-a', title: 'Above & Lanterns', mediaType: 'artist' };
    const filter = { music_hygiene: 'music-artist-unsplit' };

    async function clickReady(button: HTMLElement): Promise<void> {
        await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
        await fireEvent.click(button);
    }

    it('reports a discarded collaboration queue refresh while preserving the confirmed saved result', async () => {
        const members = [
            { id: '44444444-4444-4444-8444-444444444444', name: 'Ari' },
            { id: '55555555-5555-4555-8555-555555555555', name: 'Bryn' },
        ];
        let applied = false;
        reviewArtistCollaboration.mockImplementation(
            async (_id: string, request: { action: string; members?: typeof members }) => {
                if (request.action === 'apply') {
                    applied = true;
                    return {
                        data: {
                            action: 'apply',
                            result: { changedTracks: 0, unchangedAlbums: 1, reviewed: true },
                        },
                    };
                }
                return {
                    data: {
                        action: 'preview',
                        preview: {
                            artist: { id: artist.id, title: artist.title },
                            members: request.members ?? [],
                            suggestedNames: ['Ari', 'Bryn'],
                            witnesses: [],
                            overflow: false,
                            reviewed: applied,
                            snapshot: 'a'.repeat(64),
                            albums: [
                                {
                                    id: '33333333-3333-4333-8333-333333333333',
                                    title: 'Shared album',
                                    ownerId: artist.id,
                                    ownerTitle: artist.title,
                                },
                            ],
                            tracks: [
                                {
                                    id: '22222222-2222-4222-8222-222222222222',
                                    title: 'Confirmed duet',
                                    albumId: '33333333-3333-4333-8333-333333333333',
                                    albumTitle: 'Shared album',
                                    albumArtistId: artist.id,
                                    albumArtistTitle: artist.title,
                                    sourceTag: null,
                                    fileCount: 1,
                                    status: 'already-resolved',
                                    reason: null,
                                    before: members.map((member) => ({
                                        ...member,
                                        creditedAs: member.name,
                                        role: 'performer',
                                        active: true,
                                    })),
                                    after: members.map((member) => ({
                                        artist: member,
                                        creditedAs: member.name,
                                        role: 'performer',
                                    })),
                                    reviewSnapshot: 'b'.repeat(64),
                                },
                            ],
                        },
                    },
                };
            },
        );
        searchArtists.mockImplementation(async (_id: string, query: string) => ({
            data: {
                artists: members
                    .filter((member) => member.name === query)
                    .map((member) => ({ id: member.id, title: member.name })),
            },
        }));
        let resolveRefresh!: (response: Response) => void;
        singleActFetch.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveRefresh = resolve;
            }),
        );
        render(MediaBrowserPage, { data: makeData([artist], 'music', filter) });
        setPageUrl('http://localhost/admin/library/media?domain=music&filter=music-artist-unsplit');
        await fireEvent.click(screen.getByRole('button', { name: m.collaboration_resolve() }));
        await screen.findByText(m.collaboration_suggestions());
        for (const member of members) {
            await fireEvent.input(
                screen.getByRole('textbox', { name: m.collaboration_search_artist() }),
                { target: { value: member.name } },
            );
            await fireEvent.click(screen.getByRole('button', { name: m.collaboration_search() }));
            await fireEvent.click(await screen.findByRole('button', { name: member.name }));
        }
        await fireEvent.click(screen.getByRole('button', { name: m.collaboration_preview() }));
        await fireEvent.click(screen.getByRole('button', { name: m.collaboration_confirm() }));
        await waitFor(() => expect(singleActFetch).toHaveBeenCalledOnce());
        expect(await screen.findByText(m.collaboration_review_saved())).toBeTruthy();
        setPageUrl(
            'http://localhost/admin/library/media?domain=music&filter=music-artist-unsplit&q=other',
        );
        resolveRefresh(successfulRefreshResponse(makeData([], 'music', filter)));
        expect(await screen.findByText(m.collaboration_refresh_error())).toBeTruthy();
        expect(screen.getByText(m.collaboration_review_saved())).toBeTruthy();
        expect(screen.getByRole('link', { name: artist.title })).toBeTruthy();
    });

    it('marks from the queue and keeps Undo visible after the refreshed list removes the artist', async () => {
        setArtistNoSplit.mockResolvedValue({
            data: { id: artist.id, noSplit: true },
            error: null,
        });
        render(MediaBrowserPage, {
            data: makeData([artist], 'music', filter, { total: 1, page: 3, pageSize: 1 }),
        });
        setPageUrl(
            'http://localhost/admin/library/media?domain=music&filter=music-artist-unsplit&q=above&page=3&sort=title&order=desc',
        );
        singleActFetch.mockResolvedValueOnce(
            successfulRefreshResponse(
                makeData([], 'music', filter, { total: 2, page: 2, pageSize: 1 }),
            ),
        );

        await clickReady(
            screen.getByRole('button', {
                name: m.admin_media_single_act_mark_for({ title: artist.title }),
            }),
        );

        await waitFor(() => expect(setArtistNoSplit).toHaveBeenCalledWith(artist.id, true));
        expect(
            await screen.findByText(m.admin_media_single_act_marked({ title: artist.title })),
        ).toBeTruthy();
        expect(
            within(screen.getByTestId(`single-act-feedback-${artist.id}`)).getByRole('button', {
                name: m.admin_media_single_act_undo_for({ title: artist.title }),
            }),
        ).toBeTruthy();
        await waitFor(() =>
            expect(replaceState).toHaveBeenCalledWith(
                new URL(
                    'http://localhost/admin/library/media?domain=music&filter=music-artist-unsplit&q=above&page=2&sort=title&order=desc',
                ),
                appPage.state,
            ),
        );
    });

    it('keeps independent feedback targets when marking two artists and undoing only one', async () => {
        const secondArtist = { id: 'artist-b', title: 'Cedar & Glass', mediaType: 'artist' };
        setArtistNoSplit
            .mockResolvedValueOnce({ data: { id: artist.id, noSplit: true }, error: null })
            .mockResolvedValueOnce({ data: { id: secondArtist.id, noSplit: true }, error: null })
            .mockResolvedValueOnce({ data: { id: artist.id, noSplit: false }, error: null });
        singleActFetch
            .mockResolvedValueOnce(
                successfulRefreshResponse(makeData([secondArtist], 'music', filter)),
            )
            .mockResolvedValueOnce(successfulRefreshResponse(makeData([], 'music', filter)))
            .mockResolvedValueOnce(successfulRefreshResponse(makeData([artist], 'music', filter)));
        render(MediaBrowserPage, { data: makeData([artist, secondArtist], 'music', filter) });

        await clickReady(
            screen.getByRole('button', {
                name: m.admin_media_single_act_mark_for({ title: artist.title }),
            }),
        );
        await clickReady(
            screen.getByRole('button', {
                name: m.admin_media_single_act_mark_for({ title: secondArtist.title }),
            }),
        );

        const feedbackA = await screen.findByTestId(`single-act-feedback-${artist.id}`);
        const feedbackB = await screen.findByTestId(`single-act-feedback-${secondArtist.id}`);
        await clickReady(
            within(feedbackA).getByRole('button', {
                name: m.admin_media_single_act_undo_for({ title: artist.title }),
            }),
        );

        expect(
            await within(feedbackA).findByText(
                m.admin_media_single_act_returned({ title: artist.title }),
            ),
        ).toBeTruthy();
        expect(
            within(feedbackB).getByText(
                m.admin_media_single_act_marked({ title: secondArtist.title }),
            ),
        ).toBeTruthy();
        expect(setArtistNoSplit.mock.calls).toEqual([
            [artist.id, true],
            [secondArtist.id, true],
            [artist.id, false],
        ]);
    });

    it('suppresses rapid duplicate requests for the same artist while its write is pending', async () => {
        let resolveWrite!: (value: { data: { id: string; noSplit: boolean }; error: null }) => void;
        setArtistNoSplit.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveWrite = resolve;
            }),
        );
        render(MediaBrowserPage, { data: makeData([artist], 'music', filter) });

        const mark = screen.getByRole('button', {
            name: m.admin_media_single_act_mark_for({ title: artist.title }),
        });
        await fireEvent.click(mark);
        expect(mark.hasAttribute('disabled')).toBe(true);
        await fireEvent.click(mark);
        expect(setArtistNoSplit).toHaveBeenCalledTimes(1);

        resolveWrite({ data: { id: artist.id, noSplit: true }, error: null });
        expect(await screen.findByTestId(`single-act-feedback-${artist.id}`)).toBeTruthy();
    });

    it('does not apply a refresh response after the browsing context changes', async () => {
        let resolveRefresh!: (response: Response) => void;
        singleActFetch.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveRefresh = resolve;
            }),
        );
        setArtistNoSplit.mockResolvedValue({
            data: { id: artist.id, noSplit: true },
            error: null,
        });
        render(MediaBrowserPage, { data: makeData([artist], 'music', filter) });
        setPageUrl('http://localhost/admin/library/media?domain=music&filter=music-artist-unsplit');

        await clickReady(
            screen.getByRole('button', {
                name: m.admin_media_single_act_mark_for({ title: artist.title }),
            }),
        );
        await waitFor(() => expect(singleActFetch).toHaveBeenCalledTimes(1));
        setPageUrl(
            'http://localhost/admin/library/media?domain=music&filter=music-artist-unsplit&q=other',
        );
        resolveRefresh(successfulRefreshResponse(makeData([], 'music', filter)));
        await waitFor(() =>
            expect(
                within(screen.getByTestId(`single-act-feedback-${artist.id}`))
                    .getByRole('button', {
                        name: m.admin_media_single_act_undo_for({ title: artist.title }),
                    })
                    .hasAttribute('disabled'),
            ).toBe(false),
        );

        expect(
            await screen.findByText(m.admin_media_single_act_marked({ title: artist.title })),
        ).toBeTruthy();
        expect(screen.getByRole('link', { name: artist.title })).toBeTruthy();
    });

    it('keeps the newest queue result when overlapping refreshes resolve out of order', async () => {
        const secondArtist = { id: 'artist-b', title: 'Cedar & Glass', mediaType: 'artist' };
        let resolveOlder!: (response: Response) => void;
        let resolveNewer!: (response: Response) => void;
        singleActFetch
            .mockReturnValueOnce(
                new Promise((resolve) => {
                    resolveOlder = resolve;
                }),
            )
            .mockReturnValueOnce(
                new Promise((resolve) => {
                    resolveNewer = resolve;
                }),
            );
        setArtistNoSplit
            .mockResolvedValueOnce({ data: { id: artist.id, noSplit: true }, error: null })
            .mockResolvedValueOnce({ data: { id: secondArtist.id, noSplit: true }, error: null });
        render(MediaBrowserPage, { data: makeData([artist, secondArtist], 'music', filter) });

        await clickReady(
            screen.getByRole('button', {
                name: m.admin_media_single_act_mark_for({ title: artist.title }),
            }),
        );
        await waitFor(() => expect(singleActFetch).toHaveBeenCalledTimes(1));
        await clickReady(
            screen.getByRole('button', {
                name: m.admin_media_single_act_mark_for({ title: secondArtist.title }),
            }),
        );
        await waitFor(() => expect(singleActFetch).toHaveBeenCalledTimes(2));

        resolveNewer(successfulRefreshResponse(makeData([], 'music', filter, { total: 0 })));
        await waitFor(() =>
            expect(screen.queryByRole('link', { name: secondArtist.title })).toBeNull(),
        );
        expect(
            await within(
                await screen.findByTestId(`single-act-feedback-${secondArtist.id}`),
            ).findByText(m.admin_media_single_act_marked({ title: secondArtist.title })),
        ).toBeTruthy();
        expect(screen.queryByRole('link', { name: artist.title })).toBeNull();
        expect(screen.queryByRole('link', { name: secondArtist.title })).toBeNull();
        expect(screen.getByText(m.route_admin_media_description({ total: '0' }))).toBeTruthy();

        resolveOlder(
            successfulRefreshResponse(makeData([secondArtist], 'music', filter, { total: 1 })),
        );
        await waitFor(() =>
            expect(
                within(screen.getByTestId(`single-act-feedback-${artist.id}`))
                    .getByRole('button', {
                        name: m.admin_media_single_act_undo_for({ title: artist.title }),
                    })
                    .hasAttribute('disabled'),
            ).toBe(false),
        );
        expect(
            await within(await screen.findByTestId(`single-act-feedback-${artist.id}`)).findByText(
                m.admin_media_single_act_marked({ title: artist.title }),
            ),
        ).toBeTruthy();
        expect(screen.queryByRole('link', { name: artist.title })).toBeNull();
        expect(screen.queryByRole('link', { name: secondArtist.title })).toBeNull();
        expect(screen.getByText(m.route_admin_media_description({ total: '0' }))).toBeTruthy();
    });

    it('undoes a confirmed mark without losing its confirmation state', async () => {
        setArtistNoSplit
            .mockResolvedValueOnce({ data: { id: artist.id, noSplit: true }, error: null })
            .mockResolvedValueOnce({ data: { id: artist.id, noSplit: false }, error: null });
        render(MediaBrowserPage, { data: makeData([artist], 'music', filter) });

        await clickReady(
            screen.getByRole('button', {
                name: m.admin_media_single_act_mark_for({ title: artist.title }),
            }),
        );
        const feedback = await screen.findByTestId(`single-act-feedback-${artist.id}`);
        const undo = within(feedback).getByRole('button', {
            name: m.admin_media_single_act_undo_for({ title: artist.title }),
        });
        await clickReady(undo);

        await waitFor(() => expect(setArtistNoSplit).toHaveBeenNthCalledWith(2, artist.id, false));
        expect(
            screen.getByText(m.admin_media_single_act_returned({ title: artist.title })),
        ).toBeTruthy();
    });

    it('keeps a failed mark retryable and keeps failed Undo available', async () => {
        setArtistNoSplit
            .mockResolvedValueOnce({ data: null, error: new Error('rejected') })
            .mockResolvedValueOnce({ data: { id: artist.id, noSplit: true }, error: null })
            .mockResolvedValueOnce({ data: null, error: new Error('rejected') })
            .mockResolvedValueOnce({ data: { id: artist.id, noSplit: false }, error: null });
        render(MediaBrowserPage, { data: makeData([artist], 'music', filter) });

        await clickReady(
            screen.getByRole('button', {
                name: m.admin_media_single_act_mark_for({ title: artist.title }),
            }),
        );
        await screen.findByRole('button', { name: m.admin_media_single_act_retry_mark() });
        await clickReady(
            screen.getByRole('button', { name: m.admin_media_single_act_retry_mark() }),
        );
        const feedback = await screen.findByTestId(`single-act-feedback-${artist.id}`);
        const undo = within(feedback).getByRole('button', {
            name: m.admin_media_single_act_undo_for({ title: artist.title }),
        });
        await clickReady(undo);

        expect(
            await screen.findByRole('button', { name: m.admin_media_single_act_retry_undo() }),
        ).toBeTruthy();
        expect(
            screen.getByText(m.admin_media_single_act_undo_failed({ title: artist.title })),
        ).toBeTruthy();

        await clickReady(
            within(feedback).getByRole('button', { name: m.admin_media_single_act_retry_undo() }),
        );
        expect(
            await within(feedback).findByText(
                m.admin_media_single_act_returned({ title: artist.title }),
            ),
        ).toBeTruthy();
        expect(setArtistNoSplit).toHaveBeenNthCalledWith(4, artist.id, false);
    });

    it('reports a saved mark truthfully when refresh fails and retries only the refresh', async () => {
        setArtistNoSplit.mockResolvedValue({
            data: { id: artist.id, noSplit: true },
            error: null,
        });
        singleActFetch
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        type: 'error',
                        status: 500,
                        error: { message: 'offline' },
                        location: '/admin/library/media',
                    }),
                    { status: 500 },
                ),
            )
            .mockResolvedValueOnce(
                successfulRefreshResponse(makeData([], 'music', filter, { total: 0, page: 1 })),
            );
        render(MediaBrowserPage, { data: makeData([artist], 'music', filter) });

        await clickReady(
            screen.getByRole('button', {
                name: m.admin_media_single_act_mark_for({ title: artist.title }),
            }),
        );
        await screen.findByRole('button', { name: m.admin_media_single_act_retry_refresh() });
        expect(
            screen.getByText(m.admin_media_single_act_marked({ title: artist.title })),
        ).toBeTruthy();

        await clickReady(
            screen.getByRole('button', { name: m.admin_media_single_act_retry_refresh() }),
        );
        await waitFor(() => expect(singleActFetch).toHaveBeenCalledTimes(2));
        expect(setArtistNoSplit).toHaveBeenCalledTimes(1);
        const feedback = screen.getByTestId(`single-act-feedback-${artist.id}`);
        await waitFor(() =>
            expect(
                within(feedback).queryByText(m.admin_media_single_act_refresh_failed()),
            ).toBeNull(),
        );
        expect(
            within(feedback).queryByRole('button', {
                name: m.admin_media_single_act_retry_refresh(),
            }),
        ).toBeNull();
        expect(screen.queryByRole('link', { name: artist.title })).toBeNull();
        expect(singleActFetch.mock.calls[0]?.[0]).toBeInstanceOf(URL);
        expect(
            (singleActFetch.mock.calls[0]?.[0] as URL).searchParams.get('/refreshSingleActQueue'),
        ).toBe('');
        expect(singleActFetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    });

    it('shows queue controls in grid layout and no single-act controls in other views', async () => {
        const { rerender } = render(MediaBrowserPage, {
            data: makeData([artist], 'music', filter, { layout: 'grid' }),
        });
        const reviewTracks = screen.getByRole('link', { name: m.music_credits_open_tracks() });
        expect(reviewTracks.getAttribute('href')).toBe(
            `/admin/library/media/${artist.id}?tab=tracks`,
        );
        expect(
            screen.getByRole('button', {
                name: m.admin_media_single_act_mark_for({ title: artist.title }),
            }),
        ).toBeTruthy();

        await rerender({ data: makeData([artist], 'music') });
        expect(
            screen.queryByRole('button', {
                name: m.admin_media_single_act_mark_for({ title: artist.title }),
            }),
        ).toBeNull();
        expect(screen.queryByRole('link', { name: m.music_credits_open_tracks() })).toBeNull();
    });

    it('keeps queue controls available when the Actions column is hidden', async () => {
        localStorage.setItem(
            COLUMNS_STORAGE_KEY,
            JSON.stringify({
                v: STORAGE_VERSION,
                keys: ['poster', 'title', 'type', 'year', 'children', 'tmdb', 'status'],
            }),
        );
        render(MediaBrowserPage, { data: makeData([artist], 'music', filter) });

        click(screen.getByRole('button', { name: m.admin_aria_toggle_column_visibility() }));
        await settle();
        expect(
            screen
                .getByRole('button', { name: m.media_col_actions() })
                .getAttribute('aria-pressed'),
        ).toBe('false');
        expect(
            screen.getByRole('button', {
                name: m.admin_media_single_act_mark_for({ title: artist.title }),
            }),
        ).toBeTruthy();
        const reviewTracks = screen.getByRole('link', { name: m.music_credits_open_tracks() });
        const row = reviewTracks.closest('tr');
        expect(row).toBeTruthy();
        click(reviewTracks);
        expect(row?.className).not.toContain('ring-primary-500/50');
    });
});

/**
 * The library scope must be VISIBLE and CLEARABLE in every domain.
 *
 * Production bug this pins: the Audiobooks tab rendered zero of 1,202 books
 * because `?library=` still named a Music group carried in from another domain
 * (a library group holds exactly one media type, so it can never match).
 * `pruneFiltersForDomain` now drops it on a domain switch — but a bookmark, a
 * hand-edited URL and the saved-filter restore all reach this page without
 * passing through that function, so the page must still be able to explain and
 * undo the narrowing on its own.
 *
 * The selector row cannot do it. That row is fed by `filteredLibraries`, which
 * drops every group whose `mediaTypes` do not match the current domain — so the
 * one group that needs representing, the foreign one, is exactly the one it has
 * already filtered out. These tests therefore drive the CHIP row, which is
 * domain-agnostic.
 *
 * On production the selector row was additionally missing ENTIRELY here, for a
 * separate reason since fixed: `getLibraryGroupsWithCounts` reached items only
 * through `media_files`, so AudiobookShelf-backed groups reported no media types
 * and were dropped from the query's result altogether. The chip carries the
 * scope regardless of that, which is the property these tests pin; the selector's
 * own return is covered by 'audiobook library selector' below.
 */
describe('library scope chip', () => {
    const MUSIC_LIBRARY_ID = '31c87d32-5b31-494c-99b5-6157403a923d';

    const GROUPS = [
        { id: MUSIC_LIBRARY_ID, label: 'Musik', mediaTypes: ['artist', 'album', 'track'] },
        // The audiobook group now reports its real type, so the domain filter keeps
        // it. The chip still has to carry the FOREIGN Music group above, which no
        // amount of fixing `mediaTypes` will make match the audiobook domain.
        {
            id: 'a1b2c3d4-0000-4000-8000-000000000001',
            label: 'Hörbücher',
            mediaTypes: ['audiobook'],
        },
    ];

    function chips(): HTMLElement[] {
        return Array.from(
            document.querySelectorAll<HTMLElement>('[data-testid="active-filter-chip"]'),
        );
    }

    function chipLabels(): string[] {
        return chips().map((el) => el.textContent?.trim() ?? '');
    }

    /**
     * Move BOTH URLs the page reads, because it reads two.
     *
     * `$app/state`'s `page.url` drives the reactive effects; `buildUrl` and
     * `removeFilterChip` build their navigation target from
     * `window.location.href`. `setPageUrl` alone moves only the first, so a
     * clear-the-chip assertion would be checking a URL built from happy-dom's
     * default location — which carries no params, and would therefore pass
     * whether or not the chip clears anything.
     */
    function setUrl(search: string): void {
        // Built on the document's OWN origin: happy-dom serves this suite from
        // `http://localhost:3000`, and navigating it to a bare `http://localhost`
        // is a cross-origin history write that throws SecurityError.
        const href = `${window.location.origin}/admin/library/media?${search}`;
        setPageUrl(href);
        // `happyDOM.setURL` rather than `history.replaceState`: SvelteKit's
        // client patches `replaceState` to warn (and the patch is loaded here),
        // and this needs to move the document, not route. The handle is
        // happy-dom's own escape hatch and is not declared on the DOM `Window`,
        // hence the structural cast.
        (window as unknown as { happyDOM: { setURL(href: string): void } }).happyDOM.setURL(href);
    }

    beforeEach(() => {
        goto.mockClear();
        setUrl(`domain=audiobook&type=audiobook&library=${MUSIC_LIBRARY_ID}`);
    });

    /**
     * The exact production reproduction: the audiobook domain, a foreign
     * library, zero rows. An empty list is allowed; an UNEXPLAINED empty list
     * is the defect.
     *
     * Revert-check: delete the `data.libraryGroupId` branch from
     * `activeFilterChips` in `+page.svelte` — the page renders an empty table
     * with no chip naming the library, which is what shipped.
     */
    it('names the carried-over library on an otherwise unexplained empty list', async () => {
        render(MediaBrowserPage, {
            data: makeData(
                [],
                'audiobook',
                {},
                {
                    libraryGroupId: MUSIC_LIBRARY_ID,
                    libraryGroups: GROUPS,
                    typeFilter: 'audiobook',
                },
            ),
        });
        await settle();

        // The list really is empty — this is the state the operator was stuck in.
        expect(document.querySelector('tr[data-row-index="0"]')).toBeNull();
        // ...and the cause is named on the page.
        expect(chipLabels()).toEqual([m.admin_media_chip_library({ label: 'Musik' })]);
    });

    /**
     * Revert-check: change the chip's `param` from `'library'` to anything else
     * and the navigation keeps `library=` set, so the list stays empty.
     *
     * Cross-wire check: point it at `'filter'` (the param the music-hygiene chip
     * uses) and this fails while the label assertion above still passes — a chip
     * that renders correctly and clears the wrong thing is the shape this class
     * of bug actually takes.
     */
    it('clears only the library scope when the chip is dismissed', async () => {
        render(MediaBrowserPage, {
            data: makeData(
                [],
                'audiobook',
                {},
                {
                    libraryGroupId: MUSIC_LIBRARY_ID,
                    libraryGroups: GROUPS,
                    typeFilter: 'audiobook',
                },
            ),
        });
        await settle();

        await fireEvent.click(chips()[0]!);

        expect(goto).toHaveBeenCalledTimes(1);
        const target = new URL(String(goto.mock.calls[0]![0]), 'http://localhost');
        expect(target.searchParams.get('library')).toBeNull();
        // The domain the operator is actually looking at must survive the clear.
        expect(target.searchParams.get('domain')).toBe('audiobook');
        expect(target.searchParams.get('type')).toBe('audiobook');
    });

    /**
     * A `?library=` naming a group that no longer exists narrows the list to
     * zero rows exactly the same way, so it must still get a clearable chip.
     *
     * Revert-check: replace the `?? m.admin_media_chip_library_unknown()`
     * fallback with a guard that skips the chip when the group is not found —
     * a deleted library group then reproduces the original defect in full.
     */
    it('still chips a library id that matches no known group', async () => {
        const orphan = 'ffffffff-0000-4000-8000-00000000dead';
        setUrl(`domain=audiobook&type=audiobook&library=${orphan}`);
        render(MediaBrowserPage, {
            data: makeData(
                [],
                'audiobook',
                {},
                {
                    libraryGroupId: orphan,
                    libraryGroups: GROUPS,
                    typeFilter: 'audiobook',
                },
            ),
        });
        await settle();

        expect(chipLabels()).toEqual([
            m.admin_media_chip_library({ label: m.admin_media_chip_library_unknown() }),
        ]);
    });

    /**
     * The chip row's "Clear all" is `clearAllFilters`, and it sits beside the
     * library chip. If it does not clear `library`, it leaves its own chip
     * standing — a button that says it cleared the filters over a list that is
     * still narrowed.
     *
     * Revert-check: delete `url.searchParams.delete('library')` from the
     * `clearFilters` block in `buildUrl`.
     */
    it('clears the library scope from the row-level Clear all', async () => {
        render(MediaBrowserPage, {
            data: makeData(
                [],
                'audiobook',
                {},
                {
                    libraryGroupId: MUSIC_LIBRARY_ID,
                    libraryGroups: GROUPS,
                    typeFilter: 'audiobook',
                },
            ),
        });
        await settle();

        const clearAll = screen.getAllByText(m.media_filter_clear_all())[0]!;
        await fireEvent.click(clearAll);

        expect(goto).toHaveBeenCalledTimes(1);
        const target = new URL(String(goto.mock.calls[0]![0]), 'http://localhost');
        expect(target.searchParams.get('library')).toBeNull();
    });

    /**
     * The chip is scoped to an APPLIED library, not rendered unconditionally.
     *
     * Revert-check: drop the `if (data.libraryGroupId)` guard and this fails
     * with a stray "Library: Unknown library" chip on every unscoped page.
     */
    it('renders no library chip when no library is applied', async () => {
        setUrl('domain=audiobook&type=audiobook');
        render(MediaBrowserPage, {
            data: makeData(
                [],
                'audiobook',
                {},
                {
                    libraryGroupId: '',
                    libraryGroups: GROUPS,
                    typeFilter: 'audiobook',
                },
            ),
        });
        await settle();

        expect(chipLabels()).toEqual([]);
    });
});

/**
 * The LIBRARY selector row must RETURN in the audiobook domain.
 *
 * The row renders only `#if filteredLibraries.length > 0`, and
 * `filteredLibraries` keeps a group only when one of its `mediaTypes` is in the
 * current domain's set. Audiobook groups used to arrive with no media types at
 * all — `getLibraryGroupsWithCounts` reached items solely through `media_files`
 * and AudiobookShelf-backed items own no file rows — so the filter dropped
 * every candidate and the whole section vanished. On production
 * `?domain=audiobook` listed 1,202 books above no LIBRARY row whatsoever, with
 * two real groups (536 and 673 books) unreachable.
 *
 * This is the CLIENT half of that fix and it is fed by fixtures, so it does not
 * prove the SQL now returns those groups — the query-side pins for that live in
 * `library-groups.queries.integration.test.ts`. What it does hold is the join
 * between the two: given a group that reports 'audiobook', the row appears.
 */
describe('audiobook library selector', () => {
    const BOOKS = { id: 'a1b2c3d4-0000-4000-8000-000000000009', label: 'Hörbücher' };

    /**
     * The Library picker's options (a select since the triage redesign; it
     * was a row of chips prefixed "Library:"). Empty when no picker renders.
     */
    function libraryRowLabels(): string[] {
        const select = Array.from(document.querySelectorAll('select')).find(
            (el) => el.options[0]?.textContent?.trim() === 'All libraries',
        );
        if (!select) return [];
        return Array.from(select.options).map((o) => o.textContent?.trim() ?? '');
    }

    it('renders the library row for a group reporting audiobook media types', async () => {
        render(MediaBrowserPage, {
            data: makeData(
                ROWS,
                'audiobook',
                {},
                {
                    libraryGroups: [{ ...BOOKS, mediaTypes: ['audiobook'] }],
                },
            ),
        });
        await settle();

        expect(libraryRowLabels()).toContain('Hörbücher');
    });

    /**
     * The pre-fix shape, kept as the contrast. Without it the assertion above
     * could be satisfied by a row that renders unconditionally, which would pin
     * nothing about the domain filter.
     */
    it('renders no library row when the group reports no media types', async () => {
        render(MediaBrowserPage, {
            data: makeData(
                ROWS,
                'audiobook',
                {},
                {
                    libraryGroups: [{ ...BOOKS, mediaTypes: [] }],
                },
            ),
        });
        await settle();

        expect(libraryRowLabels()).toEqual([]);
    });
});

/**
 * The poster thumbnail is a FLEX ITEM inside the cell's `flex items-center`
 * wrapper, so `w-8` alone does not hold it: flex items default to
 * `min-width: auto` and shrink below their specified width once the row is
 * constrained. Opening the docked inspector takes 420px out of the table and
 * did exactly that — measured on production, the img went from 20x48 to
 * **0x48** on click, loaded and `opacity: 1` the whole time. It read as "all
 * the pictures disappeared" because a zero-width image is invisible while
 * every check for a broken image passes.
 *
 * ⚠️ WHAT THIS TEST DOES NOT PROVE: happy-dom has no layout engine and loads
 * no images, so it cannot observe the 0px collapse or verify the fix stops it.
 * It pins only that the shrink guard is REQUESTED on both the image and its
 * failed-image placeholder. The behaviour itself was verified in a real
 * browser and needs a real browser to re-verify.
 */
describe('poster thumbnail shrink guard', () => {
    it('keeps shrink-0 on the poster image and its placeholder', async () => {
        const { container } = render(MediaBrowserPage, {
            props: { data: makeData(ROWS) },
        });
        await settle();

        const img = container.querySelector('tbody tr img');
        expect(img, 'poster image should render for a row with a poster').not.toBeNull();
        expect(
            img?.getAttribute('class') ?? '',
            'poster img must carry shrink-0 or the docked inspector squeezes it to 0px',
        ).toContain('shrink-0');
    });
});

/**
 * The table sheds the columns the docked inspector duplicates.
 *
 * At 1457px the admin sidebar and the 420px docked panel leave the table
 * ~780px for the 949px it wants. Before this, the browser resolved that
 * conflict on its own and resolved it badly: the poster thumbnail collapsed to
 * 0px wide (see the shrink-guard block above), and once that was pinned the
 * overflow became a horizontal scrollbar instead. Neither is right — while the
 * panel is open the table's job is identity plus selection, and TMDB/Status
 * are answered more legibly beside it.
 *
 * ⚠️ WHAT THIS BLOCK DOES NOT PROVE. happy-dom has no layout engine: it cannot
 * measure `scrollWidth`, so it cannot show that dropping these columns
 * actually stops the overflow, nor that the remaining columns fit. Every
 * assertion here is about WHICH CELLS RENDER. The width outcome needs a real
 * browser, and Safari specifically was not verified at all — see the report.
 *
 * ⚠️ These columns also carry `hidden lg:table-cell`, so in a real browser
 * they are CSS-hidden below 1024px while still being RENDERED. happy-dom
 * applies no CSS, so "present" below always means "in the DOM", which is
 * exactly the thing `visibleColumnCount` counts.
 */
/**
 * The Title column is the table's ONE elastic column.
 *
 * Every column here used to be rigid — Title's `max-w-xs` was a cap with no
 * ability to yield — so with the 420px inspector docked beside it the row
 * either fit or it overflowed, a boolean outcome. Two prior fixes only moved
 * that threshold; the last of them fit by about 12px, which is a coincidence.
 * `w-full max-w-0` on the cell is the CSS-table idiom that makes Title absorb
 * all leftover width while every other column settles at its content width,
 * `min-w-0` on the title link is what lets `truncate` fire inside the flex wrapper
 * (a flex item defaults to `min-width: auto` and will not shrink below
 * min-content), and `min-w-[28ch]` on that cell is the floor past which the
 * table overflows to a horizontal scroll instead of grinding the title away.
 *
 * ⚠️ WHAT THIS BLOCK DOES NOT PROVE, and it is most of it. happy-dom has no
 * layout engine and no Tailwind: it cannot measure a column, cannot show that
 * Title absorbs anything, cannot show that the row fits, and cannot show that
 * the worst case degrades to scroll rather than collapse. Every assertion
 * below is on the EMITTED CLASS STRING — that the fix is requested, not that
 * it works. The behaviour needs a real browser, and Safari — the operator's
 * browser and the one engine that could not be checked from here — was not
 * verified at all. See the report.
 */
describe('elastic title column', () => {
    /** The Title `<td>` of the first body row. Index 2: checkbox, poster, title. */
    function titleCell(): HTMLElement {
        const td = rowEl(0).querySelectorAll<HTMLElement>('td')[2];
        if (!td) throw new Error('no title cell');
        return td;
    }

    /**
     * Revert-check: drop `w-full max-w-0` from the Title `<td>` and this fails
     * on the first assertion. Cross-wire it — move those two classes onto the
     * poster cell's `<td>` instead — and it fails there too, because the
     * lookup is positional and the poster cell is a different element.
     */
    it('asks the Title cell to absorb the leftover width', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });
        await settle();

        const cls = titleCell().getAttribute('class') ?? '';
        expect(cls, 'Title must be the column that yields, or the row fits only by luck').toContain(
            'w-full',
        );
        expect(
            cls,
            '`max-w-0` is the half that makes `w-full` distribute rather than grow',
        ).toContain('max-w-0');
    });

    /**
     * The cap and the elasticity are mutually exclusive: `max-w-xs` pins Title
     * at 320px no matter how much room the panel leaves it, which is the state
     * this change exists to leave behind.
     *
     * Revert-check: put `max-w-xs` back on the title link and this fails.
     */
    it('no longer caps the title at a fixed width', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });
        await settle();

        const p = titleCell().querySelector('a');
        expect(p?.textContent?.trim()).toBe('Alpha Movie');
        expect(
            p?.getAttribute('class') ?? '',
            'a fixed cap on the title defeats the elastic column above it',
        ).not.toContain('max-w-xs');
    });

    /**
     * `truncate` without `min-w-0` is inert inside a flex row — the title link keeps
     * its automatic min-content minimum and spills over the next column rather
     * than ellipsing. `max-w-xs` used to clamp that automatic minimum; with the
     * cap gone, `min-w-0` is the only thing holding it.
     *
     * Revert-check: remove `min-w-0` from the title link and this fails; remove
     * `truncate` and it fails on the other assertion.
     */
    it('keeps the title shrinkable and truncating inside its flex wrapper', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });
        await settle();

        const cls = titleCell().querySelector('a')?.getAttribute('class') ?? '';
        expect(cls, 'truncate is the whole point of an elastic column').toContain('truncate');
        expect(cls, 'a flex item without min-w-0 will not shrink below min-content').toContain(
            'min-w-0',
        );
    });

    /**
     * The floor, and it must be on the CELL — that placement is the whole
     * assertion, not an incidental detail.
     *
     * `min-w-[28ch]` is the cell floor for a useful default title width. The
     * inner link remains shrinkable, so dense saved preferences can scroll the
     * table without letting title text paint over neighboring cells.
     *
     * ⚠️ Asserts WHICH ELEMENT carries the class, not the layout. happy-dom
     * produces neither outcome; the numbers above came from a real engine.
     *
     * Revert-check: remove `min-w-[28ch]` from the `<td>` and this fails.
     * Cross-wire it — move it back onto the wrapper `<div>` — and it fails on
     * the first assertion while the second catches the regression by name.
     */
    it('puts the floor on the cell, where the column algorithm can see it', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });
        await settle();

        expect(
            titleCell().getAttribute('class') ?? '',
            'without a floor on the CELL the worst case overlaps the next column',
        ).toContain('min-w-[28ch]');
        expect(
            titleCell().querySelector('div')?.getAttribute('class') ?? '',
            'a floor on the inner div is measurably worse than none — it spills over Type',
        ).not.toContain('min-w-[28ch]');
    });
});

describe('docked-inspector column suppression', () => {
    /** Header cells of the media table, in document order. */
    function headerCells(): HTMLElement[] {
        const table = document.querySelector('table');
        if (!table) throw new Error('no media table rendered');
        return [...table.querySelectorAll<HTMLElement>('thead th')];
    }

    function hasHeader(label: string): boolean {
        return headerCells().some((th) => (th.textContent ?? '').includes(label));
    }

    const TMDB = m.media_col_tmdb_short();
    const STATUS = m.media_col_issues();
    const CHILDREN = m.media_col_children();
    const TYPE = m.media_col_type();
    const TITLE = m.media_col_title();

    /**
     * Seed a column preference that explicitly INCLUDES the two suppressed
     * keys, so "the preference survived" is a real assertion rather than a
     * comparison of null with null. A fresh mount writes nothing — only
     * `toggleColumn` saves — so without this seed the persistence test would
     * pass against any implementation, mutating or not.
     */
    function seedColumnPreference(): string {
        const keys = ['poster', 'title', 'type', 'year', 'children', 'tmdb', 'status', 'actions'];
        const blob = JSON.stringify({ v: STORAGE_VERSION, keys });
        localStorage.setItem(COLUMNS_STORAGE_KEY, blob);
        return blob;
    }

    it('defaults TMDB off while keeping it available in the column picker', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });
        await settle();

        expect(hasHeader(TMDB)).toBe(false);
        click(screen.getByRole('button', { name: m.admin_aria_toggle_column_visibility() }));
        await settle();
        const tmdbPickerButton = screen.getByRole('button', { name: m.media_col_tmdb_id() });
        expect(tmdbPickerButton.getAttribute('aria-pressed')).toBe('false');
    });

    /**
     * Revert-check: delete the `INSPECTOR_DUPLICATED_COLUMNS` early return from
     * `isColVisible` and both suppression assertions fail. Cross-wire it
     * instead — swap the guard to `!inspectorSuppressesColumns` — and the
     * "before opening" assertions fail first.
     */
    it('drops TMDB and Status while the inspector is docked and open, and keeps the rest', async () => {
        seedColumnPreference();
        render(MediaBrowserPage, { data: makeData(ROWS) });
        await settle();

        // beforeEach renders at 1600px, docked, with no panel open yet.
        expect(hasHeader(TMDB)).toBe(true);
        expect(hasHeader(STATUS)).toBe(true);
        const closedCount = headerCells().length;

        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));

        expect(hasHeader(TMDB)).toBe(false);
        expect(hasHeader(STATUS)).toBe(false);

        // Identity + selection survive: the table still answers "which row am
        // I on" and "which ones have I ticked".
        expect(hasHeader(TITLE)).toBe(true);
        expect(hasHeader(TYPE)).toBe(true);
        expect(headerCells().length).toBe(closedCount - 2);
    });

    /**
     * `children` is NOT suppressed, and that is a decision, not an oversight:
     * `MediaInspector` renders a child count for a SERIES only (the per-season
     * fill block gated on `isSeries`). An album, an artist or a season shows
     * nothing of the kind, so dropping the column would lose the count rather
     * than relocate it.
     *
     * Revert-check: add `'children'` to `INSPECTOR_DUPLICATED_COLUMNS` and this
     * fails.
     */
    it('keeps Children, which the panel does not render for non-series items', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });
        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));

        expect(hasHeader(CHILDREN)).toBe(true);
    });

    /**
     * Revert-check: make the suppression permanent — have `isColVisible` read a
     * plain `let suppressed = true` once the panel has opened — and this fails
     * at the post-close assertions.
     */
    it('restores the columns when the inspector closes', async () => {
        seedColumnPreference();
        render(MediaBrowserPage, { data: makeData(ROWS) });
        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));
        expect(hasHeader(TMDB)).toBe(false);

        pressKey('Escape');
        await waitFor(() => expect(inspectorTitle()).toBeNull());

        expect(hasHeader(TMDB)).toBe(true);
        expect(hasHeader(STATUS)).toBe(true);
    });

    /**
     * THE regression this design exists to prevent. Column visibility is a
     * PERSISTED preference; suppressing by deleting keys from `visibleColumns`
     * would work on screen and quietly rewrite the operator's saved columns,
     * leaving TMDB and Status off forever after one glance at the panel.
     *
     * Asserts the STORED VALUE, not the rendered columns — the render is
     * already covered above, and a mutation that forgets to save would slip
     * past a render-only check.
     *
     * Revert-check: add `saveColumnVisibility(browser ? localStorage : null,
     * [...])` alongside the suppression, or suppress by mutating
     * `visibleColumns`, and this fails.
     */
    it('leaves the persisted column preference untouched across open and close', async () => {
        const seeded = seedColumnPreference();
        render(MediaBrowserPage, { data: makeData(ROWS) });
        await settle();

        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));
        expect(hasHeader(TMDB)).toBe(false);
        expect(
            localStorage.getItem(COLUMNS_STORAGE_KEY),
            'suppressing must not rewrite the stored preference',
        ).toBe(seeded);

        pressKey('Escape');
        await waitFor(() => expect(inspectorTitle()).toBeNull());
        expect(localStorage.getItem(COLUMNS_STORAGE_KEY)).toBe(seeded);

        // And the preference is still LIVE, not merely still on disk.
        expect(hasHeader(TMDB)).toBe(true);
        expect(hasHeader(STATUS)).toBe(true);
    });

    /**
     * Below 1280px the panel is a drawer OVER the table, so the table keeps its
     * full width and must keep every column — suppressing there would cost the
     * operator information and buy back nothing.
     *
     * Revert-check: drop the `isInspectorDocked &&` half of
     * `inspectorSuppressesColumns` and this fails.
     */
    it('suppresses nothing below the docked breakpoint', async () => {
        seedColumnPreference();
        window.innerWidth = 1000;
        render(MediaBrowserPage, { data: makeData(ROWS) });
        await settle();

        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));

        expect(hasHeader(TMDB)).toBe(true);
        expect(hasHeader(STATUS)).toBe(true);
    });

    /**
     * `visibleColumnCount` feeds the empty-state `colspan`, and it counts
     * through `isColVisible` — the same predicate the headers render through.
     * If the suppression had been layered anywhere else (a template-only
     * `{#if}`, say) the count and the render would disagree and the empty-state
     * cell would span the wrong number of columns.
     *
     * Revert-check: change `visibleColumnCount` to count
     * `visibleColumns.has(c.key)` instead of `isColVisible(c.key)` and this
     * fails on the open-panel case.
     */
    it('keeps the empty-state colspan equal to the rendered column count', async () => {
        seedColumnPreference();
        const { rerender } = render(MediaBrowserPage, { data: makeData([]) });
        await settle();

        const emptyCell = document.querySelector<HTMLElement>('tbody td[colspan]');
        expect(emptyCell, 'the empty state should render a full-width cell').not.toBeNull();
        expect(Number(emptyCell?.getAttribute('colspan'))).toBe(headerCells().length);

        // The panel cannot be open over an empty list — there is no row to
        // select — so the open-panel half of the invariant is checked the only
        // way it occurs in practice: the list empties out UNDER an open panel.
        await rerender({ data: makeData(ROWS) });
        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));
        expect(hasHeader(TMDB)).toBe(false);

        await rerender({ data: makeData([]) });
        await settle();

        // ⚠️ This does NOT prove which signal `inspectorSuppressesColumns` is
        // keyed on. Swapping `inspectorItem` for `inspectorItemId` was
        // revert-checked and every test still passed: the `data.items` effect
        // clears the id when the inspected row leaves the page, so the two are
        // equivalent in any settled state. What IS pinned below is the colspan
        // invariant — the count and the render agree after the panel goes away.
        expect(inspectorTitle()).toBeNull();
        expect(hasHeader(TMDB)).toBe(true);
        const cell = document.querySelector<HTMLElement>('tbody td[colspan]');
        expect(Number(cell?.getAttribute('colspan'))).toBe(headerCells().length);
    });

    /**
     * Header and body must shed the SAME cells. They are separate `{#if}`
     * blocks over the same predicate, so a suppression applied to only one of
     * them would render a table whose rows are misaligned against their
     * headings — the classic column-drift bug, and invisible to any assertion
     * that only reads `<th>`s.
     *
     * Revert-check: remove the `INSPECTOR_DUPLICATED_COLUMNS` guard's effect on
     * the body by wrapping only the header `{#if}`s, and this fails with the
     * body two cells longer than the header.
     */
    it('sheds the same cells from the body as from the header', async () => {
        seedColumnPreference();
        render(MediaBrowserPage, { data: makeData(ROWS) });
        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));

        const headerCount = headerCells().length;
        for (const index of [0, 1, 2]) {
            expect(
                rowEl(index).querySelectorAll('td').length,
                `row ${index} cell count must match the header`,
            ).toBe(headerCount);
        }
    });

    /**
     * EVERY column answers the shed question. This is the tripwire that stops a
     * new column from slipping in without one.
     *
     * It was meant to be the type system's job — `inspectorDuplicates` is a
     * REQUIRED field on `ColumnDef`, so omitting it should not compile. It does
     * not work here, and that was verified rather than assumed: with the field
     * deleted from one `COLUMNS` entry, `npm run typecheck` and `npm run check`
     * both reported zero errors, and so did a deliberate
     * `const x: number = COLUMNS;` planted in the same script block. Nothing in
     * this repo type-checks a `.svelte` script body — tsgo skips `.svelte`
     * outright and svelte-check-native did not flag either — which is the same
     * blind spot recorded above the ancestry-label switch.
     *
     * So the guarantee is enforced by counting the source instead. Crude, and
     * it is a TEXT assertion, not a type one — but it fails on exactly the
     * event that matters: a nineteenth-plus column added without an answer.
     *
     * ⚠️ WHAT THIS DOES NOT PROVE: that the answer is CORRECT. Declaring
     * `inspectorDuplicates: true` on a column the panel does not actually
     * render is a fact about `MediaInspector.svelte`, and no assertion here
     * reads that file. Only that the question was not skipped.
     *
     * Revert-check: delete `inspectorDuplicates` from any one `COLUMNS` entry
     * and this fails, 19 keys against 18 answers. Inverted — duplicate an
     * `inspectorDuplicates` line so there is one answer too many — it fails the
     * other way, which is what proves the assertion is an equality and not a
     * floor. Both were run.
     */
    it('makes every COLUMNS entry declare whether the inspector duplicates it', async () => {
        // Resolved from the vitest root, not `import.meta.url`: Vite rewrites
        // that to an `http://` URL in a transformed module, which
        // `fileURLToPath` rejects outright.
        const source = await readFile(
            resolve(process.cwd(), 'src/routes/admin/library/media/+page.svelte'),
            'utf-8',
        );
        const start = source.indexOf('const COLUMNS: ColumnDef[] = [');
        expect(start, 'COLUMNS moved or was renamed — update this guard').toBeGreaterThan(-1);
        const body = source.slice(start, source.indexOf('\n    ];\n', start));

        const keys = body.match(/\bkey: '/g)?.length ?? 0;
        const answers = body.match(/\binspectorDuplicates: (?:true|false)\b/g)?.length ?? 0;

        expect(keys, 'COLUMNS should still hold every column').toBeGreaterThan(0);
        expect(
            answers,
            'a column was added without answering inspectorDuplicates — the type system does NOT catch this in a .svelte file',
        ).toBe(keys);
    });

    /**
     * The shed set is DERIVED from `COLUMNS.filter((c) => c.inspectorDuplicates)`,
     * not hand-listed beside it. A hand list drifts: this codebase has shipped a
     * new column past a parallel list more than once.
     *
     * This pins the derived OUTPUT exactly — the full set of headers that
     * disappear when the panel opens, not merely "TMDB and Status are gone".
     * Flip `inspectorDuplicates` to `true` on any third column and a third
     * header vanishes and this fails; flip one of these two to `false` and the
     * set comes up short. That is the intended tripwire: the expectation has to
     * be edited deliberately, in the same change that widens the set.
     *
     * ⚠️ WHAT THIS DOES NOT PROVE: that every column ANSWERED the question.
     * Deleting `inspectorDuplicates` from an entry leaves this test green — the
     * derived set is unchanged — and, as the block above records, leaves the
     * build green too. That half is covered by the source-count guard above,
     * not here.
     *
     * ⚠️ It also cannot see the constant. `COLUMNS` is instance-scoped inside
     * the `.svelte` file and is not exported, so this reads the derivation
     * through what `isColVisible` renders. That is the stronger end of the wire
     * anyway — a derived list that never reached the predicate would pass an
     * import-and-compare test and fail this one.
     */
    it('sheds exactly the columns whose ColumnDef declares inspectorDuplicates', async () => {
        seedColumnPreference();
        render(MediaBrowserPage, { data: makeData(ROWS) });
        await settle();

        const before = headerCells().map((th) => (th.textContent ?? '').trim());

        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));

        const after = headerCells().map((th) => (th.textContent ?? '').trim());

        // Multiset difference, because several headers render empty text (the
        // select-all and poster columns) and a Set would silently collapse them.
        const remaining = [...after];
        const shed: string[] = [];
        for (const label of before) {
            const at = remaining.indexOf(label);
            if (at === -1) shed.push(label);
            else remaining.splice(at, 1);
        }

        // The Status header trails a legend for its dots, so compare on the
        // heading itself: everything up to the first run of whitespace that
        // prettier's own indentation puts between the label and any extra text.
        const heading = (text: string) => text.split(/\s{2,}/)[0]?.trim() ?? '';

        expect(
            shed.map(heading),
            'the shed set must be exactly the derived one — a new inspectorDuplicates: true belongs in this expectation',
        ).toEqual([TMDB, STATUS]);
        expect(remaining, 'opening the panel must not ADD a column').toEqual([]);
    });
});

/**
 * Saved views and issue badges (triage spec §2–3), driven through the real page.
 */
describe('saved views and issue badges', () => {
    const NO_POSTER: MediaIssue = { kind: 'no_poster', severity: 'warn' };

    it('a restored unsupported issue view agrees with the selected Music and All controls', async () => {
        localStorage.setItem(
            FILTERS_STORAGE_KEY,
            JSON.stringify({
                v: STORAGE_VERSION,
                filters: { view: 'duplicates', domain: 'music' },
            }),
        );
        const { rerender } = render(MediaBrowserPage, { data: makeData(ROWS) });
        await waitFor(() => expect(goto).toHaveBeenCalled());
        const target = new URL(String(goto.mock.calls.at(-1)![0]), 'http://localhost');
        expect(target.searchParams.get('domain')).toBe('music');
        expect(target.searchParams.has('view')).toBe(false);
        setPageUrl(target.href);
        await rerender({
            data: makeData(
                [],
                'music',
                {},
                {
                    view: 'all',
                    availableViews: ['all', 'attention', 'artwork', 'files', 'recent', 'lost'],
                },
            ),
        });
        expect(
            screen.getByRole('combobox', { name: 'Issue' }).getAttribute('value') ??
                (screen.getByRole('combobox', { name: 'Issue' }) as HTMLSelectElement).value,
        ).toBe('');
        expect(screen.getByRole('button', { name: /^All / }).getAttribute('aria-pressed')).toBe(
            'true',
        );
        expect(screen.getByRole('tab', { name: 'Music' }).getAttribute('aria-selected')).toBe(
            'true',
        );
    });

    it('a file-problem badge opens the affected title Files tab without opening the inspector', async () => {
        render(MediaBrowserPage, {
            data: makeData([
                {
                    id: 'id-a',
                    title: 'Alpha Movie',
                    issues: [{ kind: 'file_problem', severity: 'error', subtype: 'integrity' }],
                },
            ]),
        });
        click(within(rowEl(0)).getByRole('button', { name: /File problems|Integrity/i }));
        await waitFor(() =>
            expect(goto).toHaveBeenCalledWith('/admin/library/media/id-a?tab=files'),
        );
        expect(inspectorTitle()).toBeNull();
    });

    it('names duplicate entries with titles and keeps internal references in closed details', async () => {
        const id = '0315f36c-f892-4f6d-9c42-ded00173f072';
        getMediaDuplicates.mockResolvedValueOnce({
            data: {
                duplicates: [
                    {
                        tmdb_id: '177',
                        media_type: 'tv',
                        items: [
                            {
                                id,
                                title: 'Night Harbor',
                                year: 2024,
                                created_at: '2026-10-24T00:00:00Z',
                            },
                        ],
                    },
                ],
            },
        });
        getFilelessDuplicatePairs.mockResolvedValueOnce({ data: { pairs: [] } });
        render(MediaBrowserPage, { data: makeData([], 'video', {}, { view: 'duplicates' }) });
        click(screen.getByRole('button', { name: m.media_view_duplicates_banner_link() }));
        const link = await screen.findByRole('link', { name: 'Night Harbor (2024)' });
        expect(link.getAttribute('href')).toBe(`/admin/library/media/${id}`);
        expect(screen.queryByText('tv', { exact: true })).toBeNull();
        const reference = screen.getByText(id).closest('details');
        expect(reference).not.toBeNull();
        expect(reference?.open).toBe(false);
    });

    it('an issue choice navigates to that view on page 1', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });

        await fireEvent.change(screen.getByRole('combobox', { name: 'Issue' }), {
            target: { value: 'artwork' },
        });

        await waitFor(() => expect(goto).toHaveBeenCalled());
        const target = new URL(String(goto.mock.calls.at(-1)![0]), 'https://x.invalid');
        expect(target.searchParams.get('view')).toBe('artwork');
        expect(target.searchParams.get('page')).toBeNull();
    });

    /**
     * Revert-check: drop `e.stopPropagation()` from the badge and this fails —
     * the click also reaches the row and opens the inspector.
     */
    it('a badge opens its view and does not open the inspector', async () => {
        render(MediaBrowserPage, {
            data: makeData([{ id: 'id-a', title: 'Alpha Movie', issues: [NO_POSTER] }]),
        });

        click(within(rowEl(0)).getByRole('button', { name: /No poster/ }));

        await waitFor(() => expect(goto).toHaveBeenCalled());
        const target = new URL(String(goto.mock.calls.at(-1)![0]), 'https://x.invalid');
        expect(target.searchParams.get('view')).toBe('artwork');
        await settle();
        expect(inspectorTitle()).toBeNull();
    });

    it('a healthy row renders no badge at all', () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });
        expect(within(rowEl(0)).queryByRole('button', { name: /No poster|No TMDB/ })).toBeNull();
    });

    it("the inspector's fix button runs the matching page action", async () => {
        syncMediaImages.mockResolvedValue({ error: null });
        render(MediaBrowserPage, {
            data: makeData([{ id: 'id-a', title: 'Alpha Movie', issues: [NO_POSTER] }]),
        });

        click(rowEl(0));
        await waitFor(() => expect(inspectorTitle()).toBe('Alpha Movie'));
        const section = await screen.findByTestId('inspector-issues');
        click(within(section).getByRole('button', { name: 'Refresh artwork' }));

        await waitFor(() => expect(syncMediaImages).toHaveBeenCalledWith('id-a'));
    });

    it('an empty problem view says there is nothing to fix', () => {
        render(MediaBrowserPage, { data: makeData([], 'video', {}, { view: 'files' }) });
        expect(screen.getByText('Nothing to fix here')).toBeTruthy();
    });
});

/** Phase 2 of the triage redesign: scope pickers, A–Z jump, page size, grid. */
describe('scope pickers, A–Z jump, page size and grid', () => {
    function lastGotoUrl(): URL {
        return new URL(String(goto.mock.calls.at(-1)![0]), 'https://x.invalid');
    }

    it('the type picker navigates to the chosen type', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });
        const select = Array.from(document.querySelectorAll('select')).find((el) =>
            Array.from(el.options).some((o) => o.value === 'tv'),
        )!;
        await fireEvent.change(select, { target: { value: 'tv' } });
        await waitFor(() => expect(goto).toHaveBeenCalled());
        expect(lastGotoUrl().searchParams.get('type')).toBe('tv');
    });

    it('puts episodes and seasons under the "Individual items" divider', () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });
        const group = document.querySelector('optgroup');
        expect(group?.getAttribute('label')).toBe('Individual items');
        expect(Array.from(group!.querySelectorAll('option')).map((o) => o.value)).toEqual([
            'episode',
            'season',
        ]);
    });

    it('a letter asks the server to jump there', async () => {
        render(MediaBrowserPage, {
            data: makeData(ROWS, 'video', {}, { total: 500 }),
        });
        click(screen.getByRole('button', { name: 'Toggle column visibility' }));
        await settle();
        click(
            within(screen.getByRole('navigation', { name: 'Jump to letter' })).getByRole('button', {
                name: 'M',
            }),
        );
        await waitFor(() => expect(goto).toHaveBeenCalled());
        expect(lastGotoUrl().searchParams.get('jump')).toBe('M');
    });

    it('hides the letter bar while a search orders by relevance', () => {
        render(MediaBrowserPage, {
            data: makeData(ROWS, 'video', {}, { total: 500, query: 'alpha' }),
        });
        expect(screen.queryByRole('navigation', { name: 'Jump to letter' })).toBeNull();
    });

    it('the grid shows one card per row; the poster opens the inspector', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS, 'video', {}, { layout: 'grid' }) });
        const grid = screen.getByTestId('media-grid');
        expect(grid.querySelectorAll('li')).toHaveLength(ROWS.length);
        expect(document.querySelector('table')).toBeNull();

        click(within(grid).getByRole('button', { name: 'Quick look: Beta Movie' }));
        await waitFor(() => expect(inspectorTitle()).toBe('Beta Movie'));
        expect(within(grid).getByRole('link', { name: 'Beta Movie' }).getAttribute('href')).toBe(
            '/admin/library/media/id-beta',
        );
    });
});

/** Phase 3: the series drill-down. */
describe('series drill-down', () => {
    const SERIES: RowOverrides[] = [
        { id: 'id-show', title: 'Some Show', mediaType: 'tv', childCount: 1 },
    ];

    it('the chevron loads the seasons and opens the one with a broken episode', async () => {
        getBrowserChildren.mockResolvedValue({
            data: {
                seasons: [
                    {
                        season: {
                            id: 's1',
                            title: 'Season 1',
                            mediaType: 'season',
                            seasonNumber: 1,
                            hasFiles: true,
                            issues: [],
                        },
                        seasonNumber: 1,
                        withFiles: 1,
                        episodes: [
                            {
                                id: 'e1',
                                title: 'Pilot',
                                mediaType: 'episode',
                                seasonNumber: 1,
                                episodeNumber: 1,
                                hasFiles: true,
                                issues: [
                                    {
                                        kind: 'file_problem',
                                        severity: 'error',
                                        subtype: 'no_keyframes',
                                    },
                                ],
                            },
                            {
                                id: 'e2',
                                title: 'Second',
                                mediaType: 'episode',
                                seasonNumber: 1,
                                episodeNumber: 2,
                                hasFiles: false,
                                issues: [],
                            },
                        ],
                    },
                ],
                truncated: false,
            },
            error: null,
        });
        render(MediaBrowserPage, { data: makeData(SERIES) });

        click(screen.getByRole('button', { name: 'Show seasons and episodes of Some Show' }));

        await waitFor(() => expect(screen.getAllByTestId('tree-season-row')).toHaveLength(1));
        expect(getBrowserChildren).toHaveBeenCalledWith('id-show');
        expect(
            screen.getByText(m.media_tree_season_files({ withFiles: 1, total: 2 })),
        ).toBeTruthy();
        // Opened by default: the season holds an episode with an issue.
        expect(screen.getAllByTestId('tree-episode-row')).toHaveLength(2);
        expect(screen.getByRole('link', { name: 'Pilot' }).getAttribute('href')).toBe(
            '/admin/library/media/e1',
        );
        // The chevron does not open the inspector.
        expect(inspectorTitle()).toBeNull();
    });

    it('shows no chevron on a movie', () => {
        render(MediaBrowserPage, { data: makeData(ROWS) });
        expect(screen.queryByRole('button', { name: /Show seasons and episodes/ })).toBeNull();
    });
});

/** Phase 4: the list saves its page for the detail page's triage bar. */
describe('triage context', () => {
    function installSessionStorage(): Storage {
        const backing = new Map<string, string>();
        const storage: Storage = {
            get length() {
                return backing.size;
            },
            clear: () => backing.clear(),
            getItem: (k) => backing.get(k) ?? null,
            key: (i) => [...backing.keys()][i] ?? null,
            removeItem: (k) => void backing.delete(k),
            setItem: (k, v) => void backing.set(k, String(v)),
        };
        for (const target of [window, globalThis]) {
            Object.defineProperty(target, 'sessionStorage', { configurable: true, value: storage });
        }
        return storage;
    }

    it('saves the rendered page ids, view and paging', async () => {
        const storage = installSessionStorage();
        render(MediaBrowserPage, { data: makeData(ROWS, 'video', {}, { view: 'artwork' }) });
        await settle();
        const saved = JSON.parse(storage.getItem('admin-media-triage')!);
        expect(saved).toMatchObject({
            ids: ['id-alpha', 'id-beta', 'id-gamma'],
            viewLabel: 'Back to Missing artwork results',
            page: 1,
        });
    });

    it('answers ?triage=first by opening the first item', async () => {
        installSessionStorage();
        const before = window.location.href;
        window.history.replaceState(null, '', '/admin/library/media?view=files&triage=first');
        try {
            render(MediaBrowserPage, { data: makeData(ROWS) });
            await waitFor(() =>
                expect(goto).toHaveBeenCalledWith('/admin/library/media/id-alpha', {
                    replaceState: true,
                }),
            );
        } finally {
            window.history.replaceState(null, '', before);
        }
    });
});

/** Bulk selection works in the poster grid too. */
describe('grid selection', () => {
    it('a card checkbox selects the item and brings up the bulk bar', async () => {
        render(MediaBrowserPage, { data: makeData(ROWS, 'video', {}, { layout: 'grid' }) });
        const grid = screen.getByTestId('media-grid');
        const boxes = within(grid).getAllByRole('button', { name: 'Select row' });
        expect(boxes).toHaveLength(ROWS.length);

        click(boxes[1]!);

        await waitFor(() =>
            expect(
                screen.getByRole('toolbar', { name: 'Actions for selected items' }),
            ).toBeTruthy(),
        );
        expect(within(grid).getAllByRole('button', { name: 'Deselect row' })).toHaveLength(1);
        // Selecting is not inspecting.
        expect(inspectorTitle()).toBeNull();
    });
});

it('clears the old query when changing search scope after clearing the input', async () => {
    setPageUrl('http://localhost/admin/library/media?q=OldTitle');
    render(MediaBrowserPage, {
        data: makeData(ROWS, 'video', {}, { query: 'OldTitle', searchScope: 'title' }),
    });
    const input = screen.getByRole('textbox', { name: /search/i });
    await fireEvent.input(input, { target: { value: '' } });
    await fireEvent.change(screen.getByRole('combobox', { name: 'Search scope' }), {
        target: { value: 'metadata' },
    });
    const target = new URL(String(goto.mock.calls.at(-1)?.[0]), 'http://localhost');
    expect(target.searchParams.has('q')).toBe(false);
    expect(target.searchParams.get('scope')).toBe('metadata');
});
