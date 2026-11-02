<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { PageData } from './$types';
    import { deserialize } from '$app/forms';
    import {
        afterNavigate,
        beforeNavigate,
        goto,
        invalidateAll,
        replaceState,
    } from '$app/navigation';
    import { page } from '$app/state';
    import { browser } from '$app/environment';
    import { env } from '$env/dynamic/public';
    import { SvelteMap, SvelteSet, SvelteURLSearchParams } from 'svelte/reactivity';
    import { onDestroy, tick, untrack } from 'svelte';
    import { resolve } from '$lib/paths';
    import {
        Icon,
        MagnifyingGlass,
        Film,
        Tv,
        ChevronLeft,
        ChevronRight,
        ChevronDown,
        ChevronUp,
        FolderOpen,
        MusicalNote,
        BookOpen,
        Squares2x2,
        ListBullet,
        Play,
        ArrowPath,
        ExclamationTriangle,
        ExclamationCircle,
        XMark,
        Funnel,
        Cog6Tooth,
    } from 'svelte-hero-icons';
    import { getCatalogPosterUrl } from '$lib/utils/image-utils';
    import { fileHealthIssueLabel, isSevereHealthIssue } from '$lib/utils/file-health-issue';
    import { findPageScroller } from '$lib/utils/scroll-restoration';
    import { popup } from '$lib/utils/popup';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import {
        isMovie,
        isNonEntertainment,
        isSeries,
        isMusicType,
        isSeason,
        isEpisode,
        isAudiobook,
    } from '$lib/shared/media-types';
    import { getMediaTypeDisplay } from '$lib/utils/media-types';
    import { Z } from '$lib/utils/z-index';
    import { AdminPageHeader, ActionModal, IdentifyModal } from '$lib/components/admin';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import MediaActionBar from '$lib/components/admin/media/MediaActionBar.svelte';
    import MediaInspector from '$lib/components/admin/media/MediaInspector.svelte';
    import MediaViewsBar from '$lib/components/admin/media/MediaViewsBar.svelte';
    import MediaIssueBadges from '$lib/components/admin/media/MediaIssueBadges.svelte';
    import CollaborationReviewModal from '$lib/components/admin/media/CollaborationReviewModal.svelte';
    import SeriesTreeRows from '$lib/components/admin/media/SeriesTreeRows.svelte';
    import type { BrowserSeasonGroupDto } from '$lib/schemas/api-admin-browser-children.js';
    import { listSearchWithout, parseTriageEdge, saveTriageContext } from './triage-context.js';
    import {
        mediaIssueFix,
        mediaIssueLabel,
        mediaTypeName,
        mediaViewLabel,
        severityBadgeClass,
        type MediaIssueFix,
    } from '$lib/components/admin/media/media-issue-presentation.js';
    import {
        problemIssues,
        type MediaBrowserView,
        type MediaIssue,
    } from '$lib/shared/media-issues.js';
    import type { MediaInspectorItem } from '$lib/components/admin/media/media-inspector-types.js';
    import type { MediaActionId } from '$lib/components/admin/media/media-actions.js';
    import { clearPreviewCache } from '$lib/components/admin/media/media-inspector-cache.js';
    import { getMediaTypeBadge } from '$lib/components/admin/media/media-type-badge';
    import SectionAttentionStrip from '$lib/components/admin/attention/SectionAttentionStrip.svelte';
    import {
        FILTERS_STORAGE_KEY,
        COLUMNS_STORAGE_KEY,
        shouldRestoreSavedFilters,
        loadBrowserReturn,
        saveBrowserReturn,
        loadSavedFilters,
        saveFilters,
        loadColumnVisibility as loadColumnVisibilityFromStorage,
        saveColumnVisibility,
    } from './media-browser-storage.js';
    import { toasts } from '$lib/stores/toast.store';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import { musicTrackFromCard } from '$lib/utils/music-track';
    import {
        syncMediaMetadata,
        syncMediaImages,
        unlockMediaMetadata,
        deleteMedia,
        dismissUnmatchedFile,
        getMusicHierarchy,
        getMediaDuplicates,
        getBrowserChildren,
        getFilelessDuplicatePairs,
        mergeMediaItems,
        bulkSetLock,
        enqueueBulkSync,
        setArtistNoSplit,
        type FilelessDuplicatePair,
    } from '$lib/api/admin';
    import { apiGet } from '$lib/api/client.js';
    import { RunSchema } from '$lib/schemas/run.schema.js';
    import { getErrorMessage } from '$lib/utils/error-handling';
    import { shortcuts } from '$lib/stores/shortcuts.svelte';
    import * as m from '$lib/paraglide/messages.js';
    import {
        pruneFiltersForDomain,
        normalizeRestoredView,
        ancestryLabel,
        ancestryPlanFor,
        ancestrySortKeyFor,
        childrenColumnLabel,
        columnAppliesTo,
        JUMP_LETTERS,
        LAYOUT_COOKIE,
        PAGE_SIZE_COOKIE,
        PAGE_SIZES,
        type BrowserLayout,
        defaultSortDirFor,
        isGroupingSort,
        musicHygieneChipLabel,
        resolveSortUrlParam,
        type SortCol,
        type SortUrlAction,
    } from './media-filters.js';
    import {
        filterIdentity,
        shouldClearSelection,
        refreshSelection,
        summarise,
        SELECTION_MAX,
        BULK_CHUNK_SIZE,
        chunkIds,
        type SelectedRow,
    } from './selection.js';
    // The delete confirmation rule is the detail page's, reused verbatim. A
    // second copy here would be a second thing to keep true.
    // `EMPTY_TITLE_DELETE_CONFIRM_WORD` deliberately NOT imported: the expected
    // word is read back out of `deleteConfirmExpectedValue()` so the label, the
    // placeholder and the comparison can only ever agree.
    import { isDeleteConfirmed, deleteConfirmExpectedValue } from './[id]/delete-confirm.js';

    interface Props {
        data: PageData;
    }

    let { data }: Props = $props();

    // svelte-ignore state_referenced_locally
    let searchInput = $state(data.query);
    let searchTimeout: ReturnType<typeof setTimeout> | null = null;
    let searchInputEl = $state<HTMLInputElement | undefined>(undefined);
    let focusedRowIndex = $state<number | null>(null);

    // ---------------------------------------------------------------------------
    // Column customization
    // ---------------------------------------------------------------------------

    interface ColumnDef {
        key: string;
        label: string;
        alwaysVisible?: boolean;
        defaultVisible: boolean;
        /** The docked inspector renders this same information for EVERY media type
         *  the table can list — shed it while the panel is open. Verified against
         *  MediaInspector's markup, not its remit. */
        inspectorDuplicates: boolean;
    }

    const COLUMNS: ColumnDef[] = [
        {
            key: 'poster',
            label: m.media_col_poster(),
            alwaysVisible: true,
            defaultVisible: true,
            inspectorDuplicates: false,
        },
        {
            key: 'title',
            label: m.media_col_title(),
            alwaysVisible: true,
            defaultVisible: true,
            inspectorDuplicates: false,
        },
        {
            key: 'type',
            label: m.media_col_type(),
            defaultVisible: true,
            inspectorDuplicates: false,
        },
        // Labels are contextual (Album/Artist vs Season/Series), so they are
        // resolved at render time from `ancestryPlan` — the static `label` here
        // is only what the column picker shows.
        {
            key: 'ancestryParent',
            label: m.media_col_parent(),
            defaultVisible: true,
            inspectorDuplicates: false,
        },
        {
            key: 'ancestryRoot',
            label: m.media_col_root(),
            defaultVisible: true,
            inspectorDuplicates: false,
        },
        // `year` is deliberately NOT shed. The panel's year comes from
        // `preview.year` — an async preview fetch rendered conditionally — which
        // is CONDITIONAL duplication and fails the "renders it for every media
        // type" bar above. With an elastic Title its 67px is not needed anyway.
        {
            key: 'year',
            label: m.media_col_year(),
            defaultVisible: true,
            inspectorDuplicates: false,
        },
        {
            key: 'children',
            label: m.media_col_children(),
            defaultVisible: true,
            // The panel renders a child count for a SERIES only — the per-season
            // fill block gated on `isSeries(item.mediaType)`. For an album, an
            // artist or a season it shows nothing of the kind (`item.childCount`
            // reaches it only as an ACTION-GATING input, never as text), so
            // shedding this column would lose the count rather than relocate it.
            inspectorDuplicates: false,
        },
        {
            key: 'tmdb',
            label: m.media_col_tmdb_id(),
            defaultVisible: false,
            // The panel's Identifiers section renders `externalIds.tmdb` as a
            // deep link into TMDB, which the bare id in the cell is not.
            inspectorDuplicates: true,
        },
        {
            key: 'status',
            // Key kept as 'status' so saved column preferences survive; the
            // column is the Issues badges since the triage redesign.
            label: m.media_col_issues(),
            defaultVisible: true,
            // The panel's Health section renders the series' episode-coverage
            // status plus the per-issue detail and file path the badges only hint at.
            inspectorDuplicates: true,
        },
        {
            key: 'actions',
            label: m.media_col_actions(),
            defaultVisible: true,
            inspectorDuplicates: false,
        },
        {
            key: 'dateAdded',
            label: m.media_col_date_added(),
            defaultVisible: false,
            inspectorDuplicates: false,
        },
        {
            key: 'dateUpdated',
            label: m.media_col_date_updated(),
            defaultVisible: false,
            inspectorDuplicates: false,
        },
        {
            key: 'originalTitle',
            label: m.media_col_original_title(),
            defaultVisible: false,
            inspectorDuplicates: false,
        },
        {
            key: 'runtime',
            label: m.media_col_runtime(),
            defaultVisible: false,
            inspectorDuplicates: false,
        },
        {
            key: 'overview',
            label: m.media_col_overview(),
            defaultVisible: false,
            inspectorDuplicates: false,
        },
        {
            key: 'availability',
            label: m.media_redesign_availability(),
            defaultVisible: true,
            inspectorDuplicates: false,
        },
        {
            key: 'fileCount',
            label: m.media_redesign_versions(),
            defaultVisible: true,
            inspectorDuplicates: false,
        },
        // Audiobook-domain columns. Present in COLUMNS unconditionally so a
        // stored visibility preference containing them stays valid, and gated at
        // render time by `columnAppliesToDomain`.
        {
            key: 'author',
            label: m.media_col_author(),
            defaultVisible: true,
            inspectorDuplicates: false,
        },
        {
            key: 'series',
            label: m.media_col_series(),
            defaultVisible: true,
            inspectorDuplicates: false,
        },
        {
            key: 'narrator',
            label: m.media_col_narrator(),
            defaultVisible: false,
            inspectorDuplicates: false,
        },
    ];

    let visibleColumns = new SvelteSet(
        loadColumnVisibilityFromStorage(
            browser ? localStorage : null,
            COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key),
            COLUMNS.map((c) => c.key),
            COLUMNS.filter((c) => c.alwaysVisible).map((c) => c.key),
        ),
    );
    let showColumnPicker = $state(false);
    let columnPickerTriggerEl = $state<HTMLButtonElement | undefined>(undefined);
    let columnPickerDialogEl = $state<HTMLDivElement | undefined>(undefined);

    // Focus management for column picker (#2, #16)
    $effect(() => {
        if (showColumnPicker) {
            tick().then(() => {
                const first = columnPickerDialogEl?.querySelector<HTMLElement>('button');
                first?.focus();
            });
        }
    });

    function toggleColumn(key: string): void {
        const col = COLUMNS.find((c) => c.key === key);
        if (col?.alwaysVisible) return;
        if (visibleColumns.has(key)) visibleColumns.delete(key);
        else visibleColumns.add(key);
        saveColumnVisibility(browser ? localStorage : null, [...visibleColumns]);
    }

    /**
     * Whether a column means anything in the domain currently being browsed.
     *
     * Separate from the visibility preference on purpose: an operator's choice to
     * show the TMDB column is about the video domain, and should survive a trip
     * through Audiobooks rather than being silently rewritten by it.
     */
    function columnAppliesToDomain(key: string): boolean {
        return columnAppliesTo(key, data.domain, data.typeFilter);
    }

    /**
     * Columns the docked inspector renders MORE legibly than the table can, and
     * which the table therefore sheds while that panel is open.
     *
     * Measured on production at 1457px: minus the admin sidebar and the 420px
     * panel the table gets ~780px for the 949px it wants. Something has to
     * give, and until this shedding existed the BROWSER chose — it squeezed the
     * poster thumbnail from 20px to 0px wide, which read as "all the pictures
     * disappeared". While the panel is open the table's job is identity plus
     * selection; these questions are answered better beside it.
     *
     * DERIVED, never hand-listed. `inspectorDuplicates` is a REQUIRED field on
     * `ColumnDef`, so a new column cannot be added without answering the
     * question — omitting it is a compile error rather than a silent `false`.
     * The per-column justification lives on the entry it justifies, which is
     * the only place it can go stale in the same edit that invalidates it.
     */
    const INSPECTOR_DUPLICATED_COLUMNS: readonly string[] = COLUMNS.filter(
        (c) => c.inspectorDuplicates,
    ).map((c) => c.key);

    /**
     * Whether a column renders RIGHT NOW: the operator's stored preference,
     * narrowed by the domain, and narrowed again while the docked inspector is
     * open.
     *
     * ⚠️ The inspector layer is a transient VIEW suppression and must never
     * become a preference write. It is applied HERE, on top of
     * `visibleColumns`, rather than by removing keys from that set — that set
     * is persisted to localStorage by `toggleColumn` on every change, so
     * suppressing by mutation would silently rewrite the operator's saved
     * columns and leave them off after the panel closed. The column picker
     * keeps reading `visibleColumns` directly for the same reason: it must show
     * the preference, not this narrowed view of it.
     */
    function isColVisible(key: string): boolean {
        if (inspectorSuppressesColumns && INSPECTOR_DUPLICATED_COLUMNS.includes(key)) return false;
        return columnAppliesToDomain(key) && visibleColumns.has(key);
    }

    // Ancestry column headings come from `ancestryLabel()` in media-filters.ts —
    // an exhaustive switch, not the `Record<AncestryLabelKey, () => string>`
    // that used to sit here. Nothing checked that record (tsgo skips `.svelte`;
    // svelte-check-native does not flag a broken key in one either), and the
    // four call sites below CALL the result, so a missing key threw rather than
    // rendering blank.

    let ancestryPlan = $derived(ancestryPlanFor(data.domain, data.typeFilter));

    /**
     * The sort key the ancestry headers link to, or null where the view offers
     * no grouping the query can actually deliver (the mixed "Everything" list).
     * Both the Parent and the Root header point at the SAME key: `hierarchy`
     * and `artist` are one multi-column ORDER BY spanning both levels, not two
     * independent sorts.
     */
    let ancestrySortKey = $derived(
        ancestrySortKeyFor(data.domain, data.typeFilter) as SortCol | null,
    );

    /**
     * `sortUrl` for the ancestry headers. A function rather than an inline
     * `sortUrl(ancestrySortKey)` in the click handler: the handler closes over a
     * reassignable `$derived`, so the `{#if ancestrySortKey}` guard around the
     * markup does not narrow away the `null` inside the callback.
     */
    function ancestrySortUrl(): string {
        return ancestrySortKey ? sortUrl(ancestrySortKey) : '';
    }

    /**
     * The cell value for an ancestry slot.
     *
     * In the Everything view the types are mixed, so each cell falls back through
     * whichever field is actually set on that row.
     */
    function ancestryValue(
        item: (typeof data.items)[number],
        slot: 'parent' | 'root',
    ): string | undefined {
        const label = ancestryPlan[slot];
        if (!label) return undefined;
        switch (label) {
            case 'album':
                return item.albumTitle;
            case 'artist':
                return item.artistTitle;
            case 'season':
                return item.seasonTitle;
            case 'series':
                return item.seriesTitle;
            // The generic fallbacks come last, and only fire for a parent none
            // of the named hierarchy levels describes — an `extra` hanging off a
            // movie or an episode. Without them the Everything view showed a
            // trailer as a bare `trailer` with no indication of which film it
            // belonged to.
            case 'parent':
                return item.albumTitle ?? item.seasonTitle ?? item.genericParentTitle;
            case 'root':
                return item.artistTitle ?? item.seriesTitle ?? item.genericRootTitle;
        }
    }

    // ---------------------------------------------------------------------------
    // Filter persistence — remember the last-used filters across visits so that
    // a bare navigation (e.g. clicking the sidebar "Media" link) restores them,
    // while an explicit filter URL (deep link, bookmark) always wins outright.
    // ---------------------------------------------------------------------------

    // The restore check must run exactly ONCE, against whatever URL the page
    // happens to mount with — not on every subsequent URL change. Re-checking
    // "does the current URL have any persisted param?" on every navigation would
    // also fire for URLs the user reached by explicit action (switching to the
    // default domain tab, clearing all filters, searching from a filterless
    // view — buildUrl() strips params that equal their default, so these all
    // produce a bare URL) and silently re-apply the old saved filters over the
    // user's own reset. After the one-shot check, every URL change just saves.
    let restoreAttempted = false;

    // True only for the one-shot restore below, so the operator can see that the
    // view they are looking at came from storage rather than from the URL.
    let filtersRestored = $state(false);

    $effect(() => {
        // Reactive dependency: reruns this effect on every URL change so the
        // save step below stays current with the user's filter interactions.
        void page.url.search;

        if (!restoreAttempted) {
            restoreAttempted = true;
            // The decision lives in media-browser-storage.ts, where it is unit
            // tested against the deep-link case (`?filter=file-issues` must
            // SUPPRESS). Inline here it was untestable, and which param list it
            // consults is the whole substance of it.
            if (shouldRestoreSavedFilters(page.url.searchParams)) {
                const saved = loadSavedFilters(browser ? localStorage : null);
                const entries = Object.entries(saved);
                if (entries.length > 0) {
                    const url = new URL(page.url);
                    for (const [key, value] of entries) url.searchParams.set(key, value);
                    normalizeRestoredView(url.searchParams, data.jellyfinEnabled);
                    filtersRestored = true;
                    goto(url.pathname + url.search, {
                        replaceState: true,
                        keepFocus: true,
                        noScroll: true,
                    });
                    return;
                }
            }
        }

        if (!browser) return;
        saveFilters(browser ? localStorage : null, page.url.searchParams);
    });

    // Format helpers
    function formatRuntime(seconds: number): string {
        const h = Math.floor(seconds / 3600);
        // NB: don't name this `m` — it shadows the paraglide `m` messages import.
        const min = Math.floor((seconds % 3600) / 60);
        return h > 0
            ? m.media_runtime_hm({ hours: h, minutes: min })
            : m.media_runtime_m({ minutes: min });
    }

    function formatRelativeDate(dateStr: string): string {
        const date = new Date(dateStr);
        const now = Date.now();
        const diffMs = now - date.getTime();
        const diffSec = Math.floor(diffMs / 1000);
        const diffMin = Math.floor(diffSec / 60);
        const diffHour = Math.floor(diffMin / 60);
        const diffDay = Math.floor(diffHour / 24);

        if (diffDay > 30) return date.toLocaleDateString();
        if (diffDay > 0) return m.media_relative_days({ value: diffDay });
        if (diffHour > 0) return m.media_relative_hours({ value: diffHour });
        if (diffMin > 0) return m.media_relative_minutes({ value: diffMin });
        return m.media_relative_just_now();
    }

    // Reset the per-page cursors whenever the loaded rows swap — a page turn, a
    // sort change, a filter change, or an `invalidateAll()` after a mutation.
    //
    // `inspectorItemId` MUST be cleared here and not only left to `inspectorItem`
    // deriving to null. The panel does unmount on its own, but three places read
    // the RAW id, and a stale one is invisible in all three:
    //   * below the docked breakpoint it is a silent keyboard lockout — the
    //     window handler's overlay guard treats "modal inspector open" as
    //     "something owns the screen", so `/`, arrows, Space and Enter all go
    //     dead with no panel on screen to explain why;
    //   * Escape then does nothing at all, because the inspector branch claims
    //     it before the selection branch — the ordered precedence exists
    //     precisely to stop one key doing zero or two things;
    //   * docked, the next arrow key re-opens the panel on a row of the NEW
    //     page, which contradicts "the inspector follows an OPEN panel".
    //
    // `untrack` for the same reason as the selection-refresh effect below: this
    // reads `inspectorItemId` and writes it, and an unguarded read of the signal
    // it writes is the loop that already cost this page once.
    $effect(() => {
        const items = data.items;
        focusedRowIndex = null;
        untrack(() => {
            if (inspectorItemId !== null && !items.some((it) => it.id === inspectorItemId)) {
                inspectorItemId = null;
            }
        });
    });

    $effect(() => {
        if (focusedRowIndex === null) return;
        const row = document.querySelector<HTMLElement>(`[data-row-index="${focusedRowIndex}"]`);
        row?.scrollIntoView({ block: 'nearest' });
        // Arrow navigation now has exactly ONE owner (`moveRowFocus`), which
        // writes `focusedRowIndex`; moving DOM focus to match is what keeps the
        // focus ring, the `:focus-within` checkbox reveal and the index in step.
        // Guarded on `activeElement` so a click (which focuses the row natively)
        // and a Tab onto a control INSIDE the row are both left alone — an
        // unguarded focus() here would yank focus back off the row's checkbox.
        if (row && document.activeElement !== row && !row.contains(document.activeElement)) {
            row.focus({ preventScroll: true });
        }
    });

    // Register keyboard shortcuts for the help modal
    $effect(() => {
        const unregister = shortcuts.register({
            label: m.media_shortcut_group(),
            entries: [
                { keys: ['/'], description: m.media_shortcut_focus_search() },
                {
                    keys: ['↑', '↓'],
                    description: m.media_shortcut_row_navigation(),
                },
                {
                    keys: ['Space'],
                    description: m.media_shortcut_toggle_select(),
                },
                { keys: ['Enter'], description: m.media_shortcut_open_item() },
                // No `x` entry: the colspan preview row it expanded is gone,
                // replaced by the inspector. An advertised shortcut that does
                // nothing is worse than an absent one.
                {
                    keys: ['Esc'],
                    description: m.media_shortcut_escape_precedence(),
                },
            ],
        });
        return unregister;
    });

    /**
     * Move the row focus by `delta`, and let the inspector follow.
     *
     * The single owner of arrow navigation. The row's own `onkeydown` used to
     * move DOM focus (whose `onfocus` writes `focusedRowIndex`) and then let
     * the event bubble here, where this handler advanced the index a SECOND
     * time — a two-row jump per keypress that was invisible while clicking a
     * row navigated away instead of leaving it focused.
     *
     * The inspector follows only when DOCKED and already open: under the modal
     * presentation the panel is a focus-trapped dialog over a backdrop, so
     * arrow-walking the table behind it is incoherent, and opening the panel
     * from an arrow key would ambush an operator who only wanted to move.
     */
    function moveRowFocus(delta: number): void {
        if (data.items.length === 0) return;
        const next =
            focusedRowIndex === null
                ? 0
                : Math.min(Math.max(focusedRowIndex + delta, 0), data.items.length - 1);
        focusedRowIndex = next;
        if (isInspectorDocked && inspectorItemId !== null) {
            inspectorItemId = data.items[next]?.id ?? inspectorItemId;
        }
    }

    function handleGlobalKeydown(e: KeyboardEvent): void {
        // The collaboration dialog owns Escape and keyboard focus while open.
        if (collaborationArtistId !== null) return;
        const target = e.target as HTMLElement;
        const isInInput =
            target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT' ||
            target.isContentEditable;

        if (e.key === 'Escape') {
            // Ordered precedence, not a switch: ONE Escape does exactly one of
            // these. Overlay → inspector → selection.
            if (anyOverlayOpen) {
                closeTopOverlay();
                return;
            }
            if (inspectorItemId !== null) {
                closeInspector();
                return;
            }
            if (selectedCount > 0) {
                clearSelection();
                return;
            }
            if (isInInput) {
                target.blur();
            }
            focusedRowIndex = null;
            return;
        }

        if (isInInput) return;

        // A focused row CONTROL owns its own keys. The child controls stop
        // `click` (and the row's `ondblclick` guards on the same selector), but
        // nothing stopped `keydown` — so Tab onto a row's Sync button and press
        // Enter and the button fires the sync AND this handler `goto`s the
        // detail page, navigating away from the page it just acted on. One key,
        // two actions; identical in shape to the dblclick hazard, and it applies
        // equally to Identify, Dismiss, Play and the `/watch/` link. Space on
        // any of them both activated the control and toggled row selection.
        //
        // Pre-existing, but THIS change is what made it reachable: under the old
        // model a row click navigated away, so a row was almost never left
        // focused with the operator still on the page.
        //
        // This also subsumes the checkbox's own ad-hoc Space guard further down,
        // which is now belt-and-braces rather than the only thing standing
        // between Space and a double toggle.
        if (target.closest?.('button, a')) return;

        // Every remaining shortcut acts on the TABLE, so none of them may run
        // while something else owns the screen. This is not cosmetic: the
        // overlays here trap focus, and the row-focus effect above now moves
        // DOM focus to match `focusedRowIndex` — so one arrow key would yank
        // focus out of an open confirmation dialog. `Enter` was the worse
        // case even before that: it bubbles past ActionModal's own handler
        // and would navigate away from the page the operator is confirming a
        // delete on. A modal-presentation inspector counts as an overlay for
        // exactly the same reason; a DOCKED one does not, since it is a
        // non-modal sibling and arrow-walking it is the point.
        if (anyOverlayOpen || (inspectorItemId !== null && !isInspectorDocked)) return;

        if (e.key === '/') {
            e.preventDefault();
            searchInputEl?.focus();
            return;
        }

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            moveRowFocus(1);
            return;
        }

        if (e.key === 'ArrowUp') {
            e.preventDefault();
            moveRowFocus(-1);
            return;
        }

        if (e.key === ' ' && focusedRowIndex !== null) {
            e.preventDefault();
            toggleSelectItem(focusedRowIndex, e.shiftKey);
            return;
        }

        if (e.key === 'Enter' && focusedRowIndex !== null) {
            const item = data.items[focusedRowIndex];
            if (item) goto(resolve(`/admin/library/media/${item.id}`));
        }
    }

    let totalPages = $derived(Math.ceil(data.total / data.pageSize));

    // `SortCol` is imported from media-filters.ts, derived from VALID_SORT_COLS —
    // the list the server actually gates on. It used to be re-typed here as a
    // third hand-copy that nothing compared against the other two.

    // First-click sort direction: `defaultSortDirFor()` in media-filters.ts. It
    // was a `Record<SortCol, 'asc' | 'desc'>` here — a fourth hand-copy of
    // VALID_SORT_COLS that nothing compared against the other three.

    function sortUrl(col: SortCol): string {
        const currentSort = data.sort as SortCol;
        // Groupings never toggle. `namedOrder()` in admin-media.queries.ts emits
        // a fixed ascending multi-column ORDER BY for `hierarchy`/`artist` and
        // ignores sortDir, so the usual second-click flip would change the URL
        // and re-render an identically-ordered table.
        const newDir = isGroupingSort(col)
            ? defaultSortDirFor(col)
            : currentSort === col
              ? data.order === 'asc'
                  ? 'desc'
                  : 'asc'
              : defaultSortDirFor(col);
        return buildUrl({ sort: col, order: newDir, page: 1 });
    }

    // Filter param keys — used for toggling boolean filters in URL
    const FILTER_PARAMS = [
        'missing_tmdb',
        'missing_jf',
        'missing_poster',
        'missing_overview',
        'has_embedding',
        'locked',
        'local_only',
        'custom_poster',
    ] as const;
    type FilterParam = (typeof FILTER_PARAMS)[number];

    interface BuildUrlParams {
        /** Saved view (`?view=`); `all` is the default and is not encoded. */
        view?: MediaBrowserView;
        /** A–Z jump target; the server redirects to the page it starts on. */
        jump?: string;
        q?: string;
        type?: string;
        library?: string;
        unavailable?: boolean;
        page?: number;
        domain?: string;
        sort?: SortCol;
        order?: 'asc' | 'desc';
        // Advanced filter toggles
        toggleFilter?: FilterParam;
        removeFilter?: FilterParam;
        added_since?: string;
        updated_since?: string;
        clearFilters?: boolean;
        /** "Has file issues" filter (spec §3.2) — single-value `?filter=file-issues`,
         * not a `?x=1` toggle like the FILTER_PARAMS above. */
        fileIssues?: boolean;
    }

    /** Apply one `resolveSortUrlParam` verdict to the URL being built. */
    function applySortUrlParam(url: URL, key: 'sort' | 'order', verdict: SortUrlAction): void {
        if (verdict.action === 'set') url.searchParams.set(key, verdict.value);
        else if (verdict.action === 'delete') url.searchParams.delete(key);
        // 'keep' — leave whatever the current URL already carries.
    }

    function buildUrl(params: BuildUrlParams): string {
        const url = new URL(window.location.href);
        // One-shot instruction from the detail page's triage bar; never carried on.
        url.searchParams.delete('triage');
        url.searchParams.delete('restore');
        if (params.domain !== undefined) {
            if (params.domain && params.domain !== 'video')
                url.searchParams.set('domain', params.domain);
            else url.searchParams.delete('domain');
            // Filters the target domain does not offer are dropped rather than
            // carried across invisibly — see `pruneFiltersForDomain`. The server
            // neutralises them too, so a hand-edited URL behaves the same; this
            // keeps the address bar honest about what is actually applied.
            pruneFiltersForDomain(url.searchParams, params.domain || 'video');
        }
        if (params.view !== undefined) {
            if (params.view !== 'all') url.searchParams.set('view', params.view);
            else url.searchParams.delete('view');
        }
        if (params.jump !== undefined) {
            url.searchParams.set('jump', params.jump);
            url.searchParams.delete('page');
        }
        if (params.q !== undefined) {
            if (params.q) url.searchParams.set('q', params.q);
            else url.searchParams.delete('q');
        }
        if (params.type !== undefined) {
            if (params.type && params.type !== 'main') url.searchParams.set('type', params.type);
            else url.searchParams.delete('type');
        }
        if (params.library !== undefined) {
            if (params.library) url.searchParams.set('library', params.library);
            else url.searchParams.delete('library');
        }
        if (params.unavailable !== undefined) {
            if (params.unavailable) url.searchParams.set('unavailable', '1');
            else url.searchParams.delete('unavailable');
        }
        if (params.page !== undefined) {
            if (params.page > 1) url.searchParams.set('page', String(params.page));
            else url.searchParams.delete('page');
        }
        // Both `sort`/`order` rules live in `resolveSortUrlParam`: an explicit
        // value is always encoded (never stripped for matching a default, which
        // is now per TYPE), and a domain/type switch DELETES them so the
        // server's per-type default can reassert itself instead of a stale key
        // riding into a view whose column may not even be rendered. The two
        // rules used to sit in separate blocks here, one of them untested.
        const viewChanging = params.domain !== undefined || params.type !== undefined;
        applySortUrlParam(url, 'sort', resolveSortUrlParam(params.sort, viewChanging));
        applySortUrlParam(url, 'order', resolveSortUrlParam(params.order, viewChanging));
        // Toggle a boolean filter param
        if (params.toggleFilter) {
            const key = params.toggleFilter;
            if (url.searchParams.get(key) === '1') url.searchParams.delete(key);
            else url.searchParams.set(key, '1');
        }
        // Remove a specific filter
        if (params.removeFilter) {
            url.searchParams.delete(params.removeFilter);
        }
        // Date filters
        if (params.added_since !== undefined) {
            if (params.added_since) url.searchParams.set('added_since', params.added_since);
            else url.searchParams.delete('added_since');
        }
        if (params.updated_since !== undefined) {
            if (params.updated_since) url.searchParams.set('updated_since', params.updated_since);
            else url.searchParams.delete('updated_since');
        }
        // "Has file issues" filter
        if (params.fileIssues !== undefined) {
            if (params.fileIssues) url.searchParams.set('filter', 'file-issues');
            else url.searchParams.delete('filter');
        }
        // Clear all advanced filters
        if (params.clearFilters) {
            for (const key of FILTER_PARAMS) url.searchParams.delete(key);
            url.searchParams.delete('added_since');
            url.searchParams.delete('updated_since');
            url.searchParams.delete('filter');
            // The library scope now renders as a chip in the same row as the
            // filters above, and that row's own "Clear all" is this function.
            // Leaving `library` set would strand a visible chip behind the
            // button that claims to have cleared them.
            url.searchParams.delete('library');
        }
        return url.pathname + url.search;
    }

    /**
     * The advanced-filter buttons, minus the ones the current domain cannot
     * answer (`data.advancedFilterKeys` is resolved server-side alongside the
     * neutralisation of the matching query params, so the panel and the query
     * cannot disagree about which filters are live).
     */
    let dataQualityFilters = $derived(
        [
            { key: 'missing_tmdb', label: m.media_filter_missing_tmdb_id() },
            { key: 'missing_jf', label: m.media_filter_missing_jellyfin_id() },
            { key: 'missing_poster', label: m.media_filter_missing_poster() },
            { key: 'missing_overview', label: m.media_filter_missing_overview() },
            { key: 'has_embedding', label: m.media_filter_has_embedding() },
        ].filter((f) => data.advancedFilterKeys.includes(f.key)),
    );

    let metadataFilters = $derived(
        [
            { key: 'locked', label: m.media_filter_locked_items() },
            { key: 'local_only', label: m.media_filter_local_only() },
            { key: 'custom_poster', label: m.media_filter_has_custom_poster() },
        ].filter((f) => data.advancedFilterKeys.includes(f.key)),
    );

    /**
     * Columns offered in the picker: the toggleable ones that mean something in
     * the domain being browsed. A column hidden here keeps whatever visibility
     * the operator last chose for it — see `columnAppliesToDomain`.
     */
    let pickableColumns = $derived(
        COLUMNS.filter((c) => !c.alwaysVisible && columnAppliesToDomain(c.key)),
    );

    // Filter panel state
    let showFilterPanel = $state(false);

    // Derived: active filter count and chip labels
    interface ActiveFilterChip {
        label: string;
        param: string; // URL param to remove
    }

    const filterChipLabels: Record<string, string> = {
        missing_tmdb: m.admin_media_chip_missing_tmdb(),
        missing_jf: m.admin_media_chip_missing_jellyfin(),
        missing_poster: m.admin_media_chip_missing_poster(),
        missing_overview: m.admin_media_chip_missing_overview(),
        has_embedding: m.admin_media_chip_has_embedding(),
        locked: m.admin_media_chip_locked(),
        local_only: m.admin_media_chip_local_only(),
        custom_poster: m.admin_media_chip_custom_poster(),
    };

    const datePresetLabels: Record<string, string> = {
        '24h': m.admin_media_date_preset_24h(),
        '7d': m.admin_media_date_preset_7d(),
        '30d': m.admin_media_date_preset_30d(),
    };

    let activeFilterChips = $derived.by((): ActiveFilterChip[] => {
        const chips: ActiveFilterChip[] = [];
        const af = data.activeFilters;
        // The library scope, chipped like any other narrowing filter — and read
        // off `data.libraryGroups`, the UNFILTERED list, never `filteredLibraries`.
        // That distinction is the whole point. The library selector row below is
        // fed by `filteredLibraries`, which drops every group whose `mediaTypes`
        // do not match the current domain, so the one group that most needs
        // representing — a group carried in from another domain — is by
        // construction the one that row can never show, neither as a selected
        // chip nor as a control to clear. On production that rendered an
        // Audiobooks tab narrowed to a Music library as an empty list with no
        // LIBRARY section on the page at all: nothing named the cause and
        // nothing could clear it short of editing the URL.
        //
        // An id matching no known group still gets a chip (a deleted group, a
        // hand-typed uuid). It narrows the list to zero rows exactly the same
        // way, so falling through to no chip would reproduce the same defect.
        if (data.libraryGroupId) {
            const group = data.libraryGroups.find((g) => g.id === data.libraryGroupId);
            chips.push({
                label: m.admin_media_chip_library({
                    label: group?.label ?? m.admin_media_chip_library_unknown(),
                }),
                param: 'library',
            });
        }
        for (const key of FILTER_PARAMS) {
            if (af[key]) chips.push({ label: filterChipLabels[key], param: key });
        }
        if (af.added_since) {
            const label =
                datePresetLabels[af.added_since] ??
                m.admin_media_chip_added_since({ date: af.added_since });
            chips.push({ label: m.admin_media_chip_added({ label }), param: 'added_since' });
        }
        if (af.updated_since) {
            const label =
                datePresetLabels[af.updated_since] ??
                m.admin_media_chip_updated_since({ date: af.updated_since });
            chips.push({ label: m.admin_media_chip_updated({ label }), param: 'updated_since' });
        }
        if (af.file_issues) {
            chips.push({ label: m.admin_media_chip_file_issues(), param: 'filter' });
        }
        // Same `filter` param as file-issues — the two are mutually exclusive by
        // construction, so at most one of these branches can fire. Without a
        // chip an operator arriving from an attention badge sees a narrowed list
        // with nothing on the page saying why, and no control to clear it.
        if (af.music_hygiene) {
            // No fallback guard: `musicHygieneChipLabel` is an exhaustive switch
            // in a `.ts` module, so a missing or mistyped finding is a tsgo
            // error rather than a chip that quietly does not render. It lives
            // there and not here BECAUSE tsgo skips `.svelte` and
            // svelte-check-native was measured not to flag a mistyped key in a
            // `Record<MusicHygieneFinding, string>` written in a component.
            chips.push({ label: musicHygieneChipLabel(af.music_hygiene), param: 'filter' });
        }
        return chips;
    });

    // The two Include toggles live in the Filters panel since the triage
    // redesign, so they count toward the button's badge like any other filter.
    let activeFilterCount = $derived(
        activeFilterChips.length + (data.showUnavailable ? 1 : 0) + (data.showDismissed ? 1 : 0),
    );

    const isSingleActQueue = $derived(data.activeFilters.music_hygiene === 'music-artist-unsplit');
    let collaborationArtistId = $state<string | null>(null);
    function canResolveCollaboration(title: string): boolean {
        return /\s+(?:feat\.?|ft\.?|featuring|vs\.?|x|und|and|[&+])\s+/i.test(title);
    }
    async function refreshCollaborationQueue(): Promise<void> {
        if (isSingleActQueue) {
            if (!(await refreshSingleActQueue())) throw new Error('Review queue context changed');
        } else await invalidateAll();
    }

    interface SingleActFeedback {
        title: string;
        status: 'marked' | 'review' | 'mark-error' | 'undo-error';
        refreshFailed: boolean;
    }

    let singleActFeedback = new SvelteMap<string, SingleActFeedback>();
    let singleActPending = new SvelteSet<string>();
    let singleActFeedbackEntries = $derived([...singleActFeedback.entries()]);
    let singleActNavigationEpoch = 0;
    let singleActRefreshRequestEpoch = 0;

    interface SingleActRefreshPayload {
        success: true;
        browserData: PageData;
        correctedPage: number;
    }

    function isSingleActRefreshPayload(value: unknown): value is SingleActRefreshPayload {
        if (!value || typeof value !== 'object') return false;
        const payload = value as Partial<SingleActRefreshPayload>;
        return (
            payload.success === true &&
            typeof payload.correctedPage === 'number' &&
            !!payload.browserData &&
            Array.isArray(payload.browserData.items) &&
            typeof payload.browserData.total === 'number' &&
            typeof payload.browserData.page === 'number' &&
            typeof payload.browserData.pageSize === 'number'
        );
    }

    async function refreshSingleActQueue(): Promise<boolean> {
        clearPreviewCache();
        const requestUrl = new URL(page.url);
        const requestState = page.state;
        const requestEpoch = singleActNavigationEpoch;
        const refreshRequestEpoch = ++singleActRefreshRequestEpoch;
        const actionUrl = new URL(requestUrl);
        actionUrl.searchParams.set('/refreshSingleActQueue', '');
        const body = new FormData();
        body.set('refresh', '1');

        const response = await fetch(actionUrl, {
            method: 'POST',
            headers: {
                accept: 'application/json',
                'x-sveltekit-action': 'true',
            },
            body,
        });
        const result = deserialize(await response.text());
        if (result.type !== 'success' || !response.ok || !isSingleActRefreshPayload(result.data)) {
            throw new Error('Could not refresh the single-act queue');
        }

        // A route or shallow-state change means this response belongs to the
        // previous browsing context. Keep the current page data untouched.
        if (
            singleActNavigationEpoch !== requestEpoch ||
            singleActRefreshRequestEpoch !== refreshRequestEpoch ||
            page.url.href !== requestUrl.href ||
            page.state !== requestState
        ) {
            return false;
        }

        // Keep parent layout data while replacing the page's authoritative
        // browser data returned by the checked read-only action.
        data = { ...data, ...result.data.browserData };
        if (result.data.correctedPage !== Number(requestUrl.searchParams.get('page') ?? '1')) {
            const correctedUrl = new URL(requestUrl);
            correctedUrl.searchParams.set('page', String(result.data.correctedPage));
            replaceState(correctedUrl, page.state);
        }
        return true;
    }

    async function changeSingleAct(
        artistId: string,
        title: string,
        noSplit: boolean,
    ): Promise<void> {
        if (singleActPending.has(artistId)) return;
        singleActPending.add(artistId);

        try {
            const { data: result, error } = await setArtistNoSplit(artistId, noSplit);
            if (error || !result || result.noSplit !== noSplit) {
                throw new Error('Single-act update was not confirmed');
            }

            singleActFeedback.set(artistId, {
                title,
                status: noSplit ? 'marked' : 'review',
                refreshFailed: false,
            });

            try {
                await refreshSingleActQueue();
            } catch {
                // The write is confirmed. Keep that truthful status and offer a
                // refresh retry that cannot repeat or reverse the mutation.
                singleActFeedback.set(artistId, {
                    title,
                    status: noSplit ? 'marked' : 'review',
                    refreshFailed: true,
                });
            }
        } catch {
            const previous = singleActFeedback.get(artistId);
            singleActFeedback.set(artistId, {
                title,
                status: noSplit ? 'mark-error' : 'undo-error',
                refreshFailed: previous?.refreshFailed ?? false,
            });
        } finally {
            singleActPending.delete(artistId);
        }
    }

    async function retrySingleActRefresh(artistId: string): Promise<void> {
        if (singleActPending.has(artistId)) return;
        const feedback = singleActFeedback.get(artistId);
        if (!feedback) return;
        singleActPending.add(artistId);
        try {
            const refreshed = await refreshSingleActQueue();
            if (!refreshed) return;
            singleActFeedback.set(artistId, { ...feedback, refreshFailed: false });
        } catch {
            singleActFeedback.set(artistId, { ...feedback, refreshFailed: true });
        } finally {
            singleActPending.delete(artistId);
        }
    }

    function removeFilterChip(param: string): void {
        const url = new URL(window.location.href);
        url.searchParams.delete(param);
        url.searchParams.delete('page');
        goto(url.pathname + url.search);
    }

    function toggleBoolFilter(key: FilterParam): void {
        goto(buildUrl({ toggleFilter: key, page: 1 }));
    }

    function toggleFileIssuesFilter(): void {
        goto(buildUrl({ fileIssues: !data.activeFilters.file_issues, page: 1 }));
    }

    function setDateFilter(param: 'added_since' | 'updated_since', value: string): void {
        goto(buildUrl({ [param]: value, page: 1 }));
    }

    function clearAllFilters(): void {
        goto(buildUrl({ clearFilters: true, page: 1 }));
    }

    /** Cancel any pending debounced search navigation (#14). */
    function clearSearchTimeout(): void {
        if (searchTimeout) {
            clearTimeout(searchTimeout);
            searchTimeout = null;
        }
    }

    function handleSearch(): void {
        clearSearchTimeout();
        searchTimeout = setTimeout(() => {
            // keepFocus/noScroll: without them each debounced navigation took
            // focus off the search box and the next keystrokes went nowhere.
            goto(buildUrl({ q: searchInput.trim(), page: 1 }), {
                replaceState: true,
                keepFocus: true,
                noScroll: true,
            });
        }, 300);
    }

    // Cancel a pending debounced search when the component is torn down so a
    // stale timer cannot inject query params after navigation (#14).
    $effect(() => {
        return () => clearSearchTimeout();
    });

    function setDomain(domain: string): Promise<void> {
        // A pending debounced search must not fire after a tab switch and
        // re-inject a stale `q` param into the freshly-selected domain URL (#14).
        clearSearchTimeout();
        const query = searchInput.trim();
        // No `type` param: the server resolves the domain's default itself, and
        // only an absent `type` lets a search widen past it (Music's Artists
        // default would hide every album/track match — defaultSearchTypeForDomain).
        // A type the operator picks from the select is still sent explicitly.
        const url = buildUrl({
            domain,
            q: query,
            type: '',
            library: '',
            page: 1,
        });
        return goto(url);
    }

    // Tablist container ref, used to move focus to the newly selected tab so focus
    // follows selection per the ARIA roving-tabindex pattern.
    let tablistEl = $state<HTMLDivElement | null>(null);

    /**
     * Keyboard tab selection: switch domain, then (after the navigation resolves and
     * the DOM re-renders with the new roving tabindex) move focus to the newly active
     * tab button. Without this the browser keeps focus on the button the user pressed,
     * which then has tabindex="-1", breaking arrow-key navigation (focus must follow
     * selection per ARIA APG).
     */
    async function selectDomainTabByKeyboard(domain: string): Promise<void> {
        await setDomain(domain);
        await tick();
        const target = tablistEl?.querySelector<HTMLButtonElement>(`[data-domain-tab="${domain}"]`);
        target?.focus();
    }

    function setTypeFilter(type: string): void {
        goto(buildUrl({ type, page: 1 }));
    }

    function setLibraryFilter(libraryId: string): void {
        goto(buildUrl({ library: libraryId, page: 1 }));
    }

    function toggleUnavailable(): void {
        goto(buildUrl({ unavailable: !data.showUnavailable, page: 1 }));
    }

    /** Remembered in a cookie so the server renders the chosen size/layout directly. */
    function setBrowserCookie(name: string, value: string): void {
        document.cookie = `${name}=${encodeURIComponent(value)}; path=${resolve('/admin')}; max-age=31536000; samesite=lax`;
    }

    function setPageSize(size: number): void {
        setBrowserCookie(PAGE_SIZE_COOKIE, String(size));
        const target = new URL(page.url);
        target.searchParams.delete('page');
        target.searchParams.set('page_size', String(size));
        void goto(target.pathname + target.search, { invalidateAll: true });
    }

    function setLayout(layout: BrowserLayout): void {
        setBrowserCookie(LAYOUT_COOKIE, layout);
        const target = new URL(page.url);
        target.searchParams.set('layout', layout);
        void goto(target.pathname + target.search, { invalidateAll: true });
    }

    function jumpToLetter(letter: string): void {
        goto(buildUrl({ jump: letter }));
    }

    function goToPage(page: number): void {
        goto(buildUrl({ page }));
    }

    function posterUrl(id: string): string {
        return getCatalogPosterUrl(id, { size: 'thumb' });
    }

    // File-issue labels/severity come from $lib/utils/file-health-issue so this
    // page, the detail Overview and the Files tab cannot disagree about what a
    // type is called or how serious it is.
    const healthIssueLabel = fileHealthIssueLabel;

    /**
     * Recorded specifics for one issue type, if any. `detail` holds the
     * verbatim ffmpeg complaint (including the byte offset for a broken
     * container), which is the whole point of surfacing this at all — a bare
     * "Unreadable" tells an admin nothing actionable.
     */
    function healthIssueDetails(
        fi: FileIssues,
        type: string,
    ): Array<{ detail?: string; filePath?: string }> {
        // EVERY recorded file, not just the first. A multi-source item — two
        // editions of one film — can have both files unreadable, and the SQL
        // already aggregates both; `.find()` then showed one reason and one
        // filename, so the second broken edition was invisible. The filename is
        // rendered beside each reason precisely so an admin can tell them apart.
        return (fi.healthDetails ?? [])
            .filter((d) => d.type === type && d.detail)
            .map((d) => ({
                ...(d.detail !== undefined ? { detail: d.detail } : {}),
                ...(d.filePath !== undefined ? { filePath: d.filePath } : {}),
            }));
    }

    /** Just the filename — the full library path is noise inside a tooltip. */
    function baseName(path: string): string {
        const parts = path.split('/');
        return parts[parts.length - 1] || path;
    }

    function integritySeverityClass(severity: string | null | undefined): string {
        if (severity === 'critical' || severity === 'high') return 'text-red-400';
        if (severity === 'medium') return 'text-orange-400';
        return 'text-yellow-400';
    }

    type FileIssues = NonNullable<(typeof data.items)[number]['fileIssues']>;

    /** Red when any issue is playback-breaking / high-severity, else amber. */
    function fileIssueIconClass(fi: FileIssues): string {
        const severeHealth = fi.health.some((t) => isSevereHealthIssue(t));
        const severeIntegrity = fi.integrity.some(
            (iv) => iv.severity === 'critical' || iv.severity === 'high',
        );
        return severeHealth || severeIntegrity ? 'text-red-400' : 'text-amber-400';
    }

    /** Flat sr-only summary of an item's file issues for screen readers. */
    function fileIssueSummary(fi: FileIssues): string {
        const parts = [
            ...fi.health.map((t) => {
                const reasons = healthIssueDetails(fi, t)
                    .map((info) => info.detail)
                    .filter((d): d is string => !!d);
                return reasons.length > 0
                    ? `${healthIssueLabel(t)}: ${reasons.join('; ')}`
                    : healthIssueLabel(t);
            }),
            ...fi.integrity.map((iv) => iv.message ?? iv.rule),
        ];
        return parts.join('; ');
    }

    function getLibraryIcon(mediaTypes: string[]): typeof Film {
        if (mediaTypes.some((t) => t === 'movie')) return Film;
        if (mediaTypes.some((t) => t === 'tv' || t === 'anime')) return Tv;
        if (mediaTypes.some((t) => MUSIC_TYPES.has(t))) return MusicalNote;
        if (mediaTypes.some((t) => AUDIOBOOK_TYPES.has(t))) return BookOpen;
        return FolderOpen;
    }

    // Domain tabs define the top-level content split
    const domainTabs = [
        { value: 'video', label: m.route_admin_media_tab_video(), icon: Film },
        {
            value: 'music',
            label: m.route_admin_media_tab_music(),
            icon: MusicalNote,
        },
        {
            value: 'audiobook',
            label: m.audiobooks(),
            icon: BookOpen,
        },
        {
            value: 'other',
            label: m.route_admin_media_tab_other(),
            icon: FolderOpen,
        },
        {
            value: 'everything',
            label: m.route_admin_media_tab_everything(),
            icon: Squares2x2,
        },
    ] as const;

    // Type filters per domain
    const domainTypeFilters: Record<string, Array<{ value: string; label: string }>> = {
        video: [
            {
                value: 'main',
                label: m.route_admin_media_filter_movies_series(),
            },
            { value: 'movie', label: m.movies() },
            { value: 'tv', label: m.route_admin_media_filter_series() },
            { value: 'episode', label: m.route_admin_media_filter_episodes() },
            { value: 'season', label: m.route_admin_media_filter_seasons() },
        ],
        music: [
            { value: 'music', label: m.route_admin_media_filter_all_music() },
            { value: 'artist', label: m.route_admin_media_filter_artists() },
            { value: 'album', label: m.route_admin_media_filter_albums() },
            { value: 'track', label: m.route_admin_media_filter_tracks() },
        ],
        // Single-entry: the chip row only renders when there is more than one
        // filter to choose between, so the audiobook domain shows no chips.
        audiobook: [{ value: 'audiobook', label: m.audiobooks() }],
        other: [
            { value: 'other_all', label: m.route_admin_media_filter_all() },
            {
                value: 'home_video',
                label: m.route_admin_media_filter_home_videos(),
            },
            { value: 'training', label: m.route_admin_media_filter_training() },
            {
                value: 'educational',
                label: m.route_admin_media_filter_educational(),
            },
            { value: 'personal', label: m.route_admin_media_filter_personal() },
        ],
        everything: [{ value: 'all', label: m.media_filter_all_types() }],
    };

    const VIDEO_TYPES = new Set(['movie', 'tv', 'anime', 'episode', 'season']);
    const MUSIC_TYPES = new Set(['music', 'artist', 'album', 'track']);
    const AUDIOBOOK_TYPES = new Set(['audiobook']);

    /** Check if a library group belongs to a domain based on any of its media types */
    function libraryMatchesDomain(mediaTypes: string[], domain: string): boolean {
        if (domain === 'everything') return true;
        if (domain === 'video') return mediaTypes.some((t) => VIDEO_TYPES.has(t));
        if (domain === 'music') return mediaTypes.some((t) => MUSIC_TYPES.has(t));
        if (domain === 'audiobook') return mediaTypes.some((t) => AUDIOBOOK_TYPES.has(t));
        // 'other' — matches if none of the types are video, music or audiobook.
        // Audiobook groups must be excluded explicitly: this branch is a
        // negation, so a Hörbücher group would otherwise list under BOTH
        // "Audiobooks" and "Other".
        return mediaTypes.some(
            (t) => !VIDEO_TYPES.has(t) && !MUSIC_TYPES.has(t) && !AUDIOBOOK_TYPES.has(t),
        );
    }

    let activeTypeFilters = $derived(domainTypeFilters[data.domain] ?? domainTypeFilters.video);

    /** Episodes and seasons are rarely browsed flat; they sit under a divider. */
    const INDIVIDUAL_TYPES = new Set(['episode', 'season']);
    let primaryTypeFilters = $derived(
        activeTypeFilters.filter((f) => !INDIVIDUAL_TYPES.has(f.value)),
    );
    let individualTypeFilters = $derived(
        activeTypeFilters.filter((f) => INDIVIDUAL_TYPES.has(f.value)),
    );
    let showJumpBar = $derived(
        data.sort === 'title' && data.order === 'asc' && !data.query && totalPages > 1,
    );
    let filteredLibraries = $derived(
        data.domain === 'everything' || data.domain === 'unidentified'
            ? data.libraryGroups
            : data.libraryGroups.filter((g) => libraryMatchesDomain(g.mediaTypes, data.domain)),
    );

    interface DuplicateItem {
        id: string;
        title: string;
        year: number | null;
        created_at: string;
    }

    interface DuplicateGroup {
        tmdb_id: string;
        media_type: string;
        items: DuplicateItem[];
    }

    let duplicates = $state<DuplicateGroup[]>([]);
    let duplicatesLoading = $state(false);
    let duplicatesError = $state('');
    let showDuplicates = $state(false);
    let duplicatesPanelEl = $state<HTMLElement>();

    // File-less duplicate pairs (real file row with no external_ids + TMDB
    // discovery row) — loaded alongside the regular duplicates panel.
    let filelessPairs = $state<FilelessDuplicatePair[]>([]);
    // Server-side total of file-less duplicate pairs (may exceed the loaded list,
    // which is capped by the endpoint). Defaults to the loaded length so nothing
    // breaks if the endpoint does not yet return `total` (#35).
    let filelessTotal = $state(0);
    let mergingPairId = $state<string | null>(null);

    // Triage bar (triage spec §7): remember this page for the detail page's
    // Previous/Next, and answer its page-boundary hop (`?triage=first|last`)
    // by opening that end of the page.
    $effect(() => {
        if (!browser) return;
        const triageParams = new SvelteURLSearchParams(window.location.search);
        triageParams.set('layout', data.layout);
        triageParams.set('page_size', String(data.pageSize));
        triageParams.delete('restore');
        const search = listSearchWithout(triageParams.toString());
        saveTriageContext(sessionStorage, {
            search,
            viewLabel: data.query
                ? m.media_redesign_back_query({ query: data.query })
                : m.media_redesign_back_view({ view: mediaViewLabel(data.view) }),
            ids: data.items.map((it) => it.id),
            page: data.page,
            pageSize: data.pageSize,
            total: data.total,
        });
        const edge = parseTriageEdge(
            new SvelteURLSearchParams(window.location.search).get('triage'),
        );
        const target =
            edge === 'first' ? data.items[0] : edge === 'last' ? data.items.at(-1) : undefined;
        if (target) void goto(resolve(`/admin/library/media/${target.id}`), { replaceState: true });
    });

    /** Select a saved view; always back to page 1, the old page may not exist. */
    function setView(view: MediaBrowserView): void {
        goto(buildUrl({ view, page: 1 }));
    }

    let failedImages = new SvelteSet<string>();

    // Series drill-down (triage spec §4). Per page, not persisted: a page turn
    // or filter change starts collapsed. Keyed by series id.
    interface SeriesTreeState {
        status: 'loading' | 'error' | 'ready';
        seasons: BrowserSeasonGroupDto[];
        truncated?: boolean;
    }
    const seriesTrees = new SvelteMap<string, SeriesTreeState>();

    async function toggleSeriesTree(seriesId: string): Promise<void> {
        if (seriesTrees.has(seriesId)) {
            seriesTrees.delete(seriesId);
            return;
        }
        seriesTrees.set(seriesId, { status: 'loading', seasons: [] });
        const { data: result, error } = await getBrowserChildren(seriesId);
        // Collapsed again while the request was in flight: stay collapsed.
        if (!seriesTrees.has(seriesId)) return;
        seriesTrees.set(
            seriesId,
            error || !result
                ? { status: 'error', seasons: [] }
                : { status: 'ready', seasons: result.seasons, truncated: result.truncated },
        );
    }
    let syncingItems = new SvelteSet<string>();
    let dismissingItems = new SvelteSet<string>();

    // Identify modal state
    interface IdentifyTarget {
        id: string;
        title: string;
        mediaType: string;
    }
    let identifyItem = $state<IdentifyTarget | null>(null);

    // Bulk-identify queue: the IdentifyModal is single-item, so a bulk identify
    // walks the selected items one at a time using the SAME per-item mechanism.
    // Once `identifyItem` is consumed, the modal close handler pulls the next id
    // off this queue (#18-wiring).
    let bulkIdentifyQueue = $state<string[]>([]);

    let isUnidentifiedDomain = $derived(data.domain === 'unidentified');

    // ---------------------------------------------------------------------------
    // Inspector
    // ---------------------------------------------------------------------------
    // The inspector shows ONE item — the row the operator clicked or arrow-walked
    // onto. It is deliberately NOT driven by `selectedRows`: that set is the bulk
    // scope (checkbox / Space), can span pages and can hold hundreds of rows,
    // and "which one am I looking at" is a different question from "which ones am
    // I about to act on". Held as an id rather than a snapshot so the panel tracks
    // `data.items` after an `invalidateAll()` instead of showing stale fields.
    let inspectorItemId = $state<string | null>(null);

    /**
     * Viewport width, from `<svelte:window bind:innerWidth>`.
     *
     * Drives the inspector's presentation (docked vs modal). Read through a
     * binding rather than `matchMedia` because `MediaInspector` takes `docked`
     * as a PROP — it does not measure — and the keyboard model differs by
     * presentation, so this value has to be the same one the arrow-walk logic
     * consults. `undefined` until the binding first fires (SSR), which reads as
     * "not docked" — the modal presentation is the safe default because it does
     * not depend on there being room beside the table.
     */
    let viewportWidth = $state<number | undefined>(undefined);

    /** ≥1280px (Tailwind's `xl`) — the breakpoint MediaInspector documents. */
    const DOCKED_INSPECTOR_MIN_WIDTH = 1280;
    let isInspectorDocked = $derived((viewportWidth ?? 0) >= DOCKED_INSPECTOR_MIN_WIDTH);

    /**
     * The inspected row, mapped into the panel's own item shape.
     *
     * Resolved from `data.items` on every read rather than snapshotted, so a
     * sync/unlock followed by `invalidateAll()` re-feeds the panel with the
     * server's new values. Returns null when the id is no longer on the page
     * (a page turn, a filter change, or a delete) — the panel then unmounts
     * rather than describing a row that is no longer listed.
     */
    let inspectorItem = $derived.by((): MediaInspectorItem | null => {
        if (inspectorItemId === null) return null;
        const row = data.items.find((it) => it.id === inspectorItemId);
        if (!row) return null;
        return {
            id: row.id,
            title: row.title,
            mediaType: row.mediaType,
            updatedAt: row.updatedAt,
            hasFiles: row.hasFiles,
            childCount: row.childCount,
            metadataLocked: row.metadataLocked,
            isUnidentifiedDomain,
            // Exactly the gate the row's own Identify button uses, so the
            // inspector never offers Identify on a row whose action column
            // does not — the registry asks for a domain flag, and this is the
            // page's answer to it.
            supportsProviderIdentity: !isNonEntertainment(row.mediaType),
            // Handoff (c) from task 4: the row already carries the resolved
            // ancestry, and the panel prefers it over its own preview fetch.
            // Forgetting these is SILENT — the panel just renders no ancestry
            // line for a season/track, the case where it matters most.
            artistTitle: row.artistTitle,
            albumTitle: row.albumTitle,
            seriesTitle: row.seriesTitle,
            seasonTitle: row.seasonTitle,
            genericParentTitle: row.genericParentTitle,
            issues: row.issues,
        };
    });

    /**
     * Whether the table sheds the columns the docked panel duplicates.
     *
     * Keyed on `inspectorItem` because that is EXACTLY what `{#if inspectorItem}`
     * gates the panel on, so the columns and the panel cannot disagree by
     * construction.
     *
     * ⚠️ Honest note, because the comment here used to overclaim: keying on
     * `inspectorItemId` instead would behave identically today. The
     * `data.items` effect above clears that id whenever the inspected row
     * leaves the page, so the two are equivalent in every settled state and no
     * test can tell them apart — this was revert-checked and the check came
     * back green. `inspectorItem` is kept as the more direct seam, not because
     * the id is known to be wrong.
     *
     * Docked-only, and that half is not an optimisation. Below
     * `DOCKED_INSPECTOR_MIN_WIDTH` the panel is a drawer OVER the table, so the
     * table still has its full width — giving up columns there would cost the
     * operator information and buy back nothing.
     */
    let inspectorSuppressesColumns = $derived(isInspectorDocked && inspectorItem !== null);

    function closeInspector(): void {
        inspectorItemId = null;
    }

    /**
     * A row click: focus it and show it in the inspector.
     *
     * Deliberately does NOT touch `selectedRows` — the checkbox and Space own
     * that, and a click that silently grew the bulk scope would make the
     * action bar's count lie about what a subsequent Delete would hit.
     */
    function selectRowIntoInspector(index: number): void {
        const item = data.items[index];
        if (!item) return;
        focusedRowIndex = index;
        inspectorItemId = item.id;
    }

    /**
     * Single-item delete confirmation, opened from the inspector's Delete
     * action. Separate from `showDeleteConfirm`, which is scoped to the whole
     * `selectedRows` set: routing one item through the bulk path would mean
     * mutating the operator's selection to delete something they never
     * selected.
     */
    let inspectorDeleteItem = $state<{ id: string; title: string; childCount: number } | null>(
        null,
    );

    /**
     * Run every inspector action the registry can emit at `surface:'inspector'`.
     *
     * The registry decides WHICH buttons exist; this decides what they do, and
     * the `MediaActionId` switch is exhaustive so a newly registered action
     * fails typecheck here rather than rendering a live-looking dead button
     * (which is exactly what shipped between task 4 and this one).
     */
    function handleInspectorAction(action: MediaActionId, item: MediaInspectorItem): void {
        switch (action) {
            case 'play':
                void playMusicItem(item);
                return;
            case 'watch':
                // Same target and same new-tab behaviour as the row's Play link.
                window.open(resolve(`/watch/${item.id}`), '_blank', 'noopener');
                return;
            case 'unlock':
                void unlockItem(item.id);
                return;
            case 'delete':
                inspectorDeleteItem = {
                    id: item.id,
                    title: item.title,
                    childCount: item.childCount,
                };
                return;
            case 'syncMetadata':
                void syncItem(item.id, false);
                return;
            case 'syncWithChildren':
                void syncItem(item.id, true);
                return;
            case 'syncImages':
                void syncItemImages(item.id);
                return;
            case 'reprobe':
                // Labelled "Open Files" in the panel, and this is why: there is
                // no persisting re-probe endpoint anywhere in this codebase
                // (see the ⚠️ note on the `reprobe` rule in media-actions.ts).
                // `probe-raw` is a per-FILE, non-persisting diagnostic behind a
                // modal on the detail page's Files tab, and the browser row
                // carries no file id to open it with — so this navigates to
                // that tab. Inventing a second probe path from the list page to
                // justify the old label is the thing NOT to do here.
                void goto(resolve(`/admin/library/media/${item.id}?tab=files`));
                return;
            case 'identify':
                identifyItem = { id: item.id, title: item.title, mediaType: item.mediaType };
                return;
            case 'dismiss':
                requestDismissItem(item.id);
                return;
            case 'reorder':
                // Detail-surface only (`actionsFor` never returns it here); the
                // case exists so the switch stays exhaustive.
                return;
        }
    }

    /** An issue card's fix button (triage spec, "Inspector fix actions"). */
    function fixInspectorIssue(issue: MediaIssue, item: MediaInspectorItem): void {
        const fix: MediaIssueFix = mediaIssueFix(issue);
        switch (fix) {
            case 'identify':
            case 'syncImages':
            case 'syncMetadata':
                handleInspectorAction(fix, item);
                return;
            case 'showFiles':
                handleInspectorAction('reprobe', item);
                return;
            case 'merge':
                void findDuplicates();
                return;
        }
    }

    async function deleteInspectorItem(): Promise<void> {
        const target = inspectorDeleteItem;
        inspectorDeleteItem = null;
        if (!target) return;
        // A parent cannot be deleted here — the server 409s on a non-cascade
        // delete of a row with children, and no cascade delete exists on this
        // surface. The dialog's Delete button is `disabled` for exactly this
        // case, but the guard is repeated in the thing that actually deletes,
        // for the same reason `bulkDelete` repeats its two: the rule belongs to
        // the deleter, not only to the renderer. Before both existed the dialog
        // said the item "will be skipped" and then deleted anyway, so the
        // operator read a promise of no action and got a raw 409 toast.
        if (target.childCount > 0) return;
        try {
            const { error } = await deleteMedia(target.id);
            if (error) {
                toasts.error(error);
                return;
            }
            toasts.success(m.admin_media_toast_deleted_items({ deleted: 1 }));
            // The row is gone; so is anything the panel could show for it.
            closeInspector();
            selectedRows.delete(target.id);
            reloadAfterMutation();
        } catch (e) {
            toasts.error(getErrorMessage(e, m.media_overview_delete_failed()));
        }
    }

    async function unlockItem(itemId: string): Promise<void> {
        try {
            const { error } = await unlockMediaMetadata(itemId);
            if (error) {
                toasts.error(error || m.toast_metadata_unlock_failed());
                return;
            }
            toasts.success(m.toast_metadata_unlocked());
            reloadAfterMutation();
        } catch (e) {
            toasts.error(getErrorMessage(e, m.toast_metadata_unlock_failed()));
        }
    }

    async function syncItemImages(itemId: string): Promise<void> {
        syncingItems.add(itemId);
        try {
            const { error } = await syncMediaImages(itemId);
            if (!error) {
                toasts.success(m.media_toast_image_sync_complete({ done: 1 }));
                reloadAfterMutation();
            } else {
                toasts.error(error);
            }
        } catch (e) {
            toasts.error(getErrorMessage(e, m.media_images_sync_failed()));
        } finally {
            syncingItems.delete(itemId);
        }
    }

    // ---------------------------------------------------------------------------
    // Selection
    // ---------------------------------------------------------------------------
    // Snapshots, not bare ids: `bulkDelete`'s child-skip and the delete
    // confirmation both need `mediaType`/`childCount` for rows that are no
    // longer on the current page once a selection spans multiple pages.
    // `title`/`tmdbId` ride along too — they are not part of the `SelectedRow`
    // contract `selection.ts` exports (that stays the minimal cross-module
    // shape), but `hasUnidentifiedSelected` and the bulk-identify queue need
    // them and a superset snapshot satisfies `SelectedRow` structurally.
    interface SelectedRowSnapshot extends SelectedRow {
        title: string;
        tmdbId?: string;
        // Read by the bulk bar's `unlock` rule. Part of the snapshot rather
        // than looked up in `data.items` for the same reason as everything
        // else here: a selection spans pages, and most of it is not on screen.
        metadataLocked: boolean;
    }
    const selectedRows = new SvelteMap<string, SelectedRowSnapshot>();
    export const snapshot = {
        capture: () => ({
            selected: [...selectedRows.entries()],
            focusId: document.activeElement?.id,
            scroll: findPageScroller().scrollTop,
            rowIndex: focusedRowIndex,
        }),
        restore: (saved: {
            selected: Array<[string, SelectedRowSnapshot]>;
            focusId?: string;
            scroll?: number;
            rowIndex?: number | null;
        }) => {
            selectedRows.clear();
            for (const [id, row] of saved.selected.slice(0, SELECTION_MAX))
                selectedRows.set(id, row);
            focusedRowIndex = saved.rowIndex ?? null;
            void tick().then(() => {
                if (saved.scroll !== undefined) findPageScroller().scrollTop = saved.scroll;
                if (saved.focusId)
                    document.getElementById(saved.focusId)?.focus({ preventScroll: true });
            });
        },
    };
    let browserReturnRestored = false;
    function persistBrowserReturn(): void {
        if (!browser) return;
        const url = new URL(window.location.href);
        if (url.pathname !== resolve('/admin/library/media')) return;
        if (url.searchParams.get('restore') === '1' && !browserReturnRestored) return;
        url.searchParams.delete('restore');
        url.searchParams.set('layout', data.layout);
        url.searchParams.set('page_size', String(data.pageSize));
        url.searchParams.sort();
        const focused = document.activeElement as HTMLElement | null;
        saveBrowserReturn(sessionStorage, {
            url: url.pathname + url.search,
            selected: [...selectedRows.entries()],
            scroll: findPageScroller().scrollTop,
            focusId:
                focused?.id ||
                (focusedRowIndex !== null ? `media-row-${data.items[focusedRowIndex]?.id}` : null),
            focusHref: focused?.closest('a')?.getAttribute('href') ?? null,
            layout: data.layout,
            pageSize: data.pageSize,
        });
    }
    // Persist when selection changes as well as on departure: client routing may
    // update the reactive page URL before beforeNavigate callbacks run.
    $effect(() => {
        [...selectedRows.entries()];
        page.url.search;
        untrack(persistBrowserReturn);
    });
    beforeNavigate(() => persistBrowserReturn());
    afterNavigate(() => {
        singleActNavigationEpoch += 1;
        if (page.url.searchParams.get('restore') !== '1') return;
        const url = new URL(page.url);
        url.searchParams.delete('restore');
        url.searchParams.set('layout', data.layout);
        url.searchParams.set('page_size', String(data.pageSize));
        url.searchParams.sort();
        const saved = loadBrowserReturn<SelectedRowSnapshot>(
            sessionStorage,
            url.pathname + url.search,
        );
        browserReturnRestored = true;
        if (!saved) return;
        selectedRows.clear();
        for (const [id, row] of saved.selected.slice(0, SELECTION_MAX)) selectedRows.set(id, row);
        setBrowserCookie(LAYOUT_COOKIE, saved.layout);
        setBrowserCookie(PAGE_SIZE_COOKIE, String(saved.pageSize));
        void tick().then(() => {
            findPageScroller().scrollTop = saved.scroll;
            const focused = saved.focusId
                ? document.getElementById(saved.focusId)
                : [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].find(
                      (link) => link.getAttribute('href') === saved.focusHref,
                  );
            focused?.focus({ preventScroll: true });
        });
    });
    let selectedCount = $derived(selectedRows.size);
    let lastSelectedIndex = $state<number | null>(null);
    let bulkBusy = $state(false);
    let showDeleteConfirm = $state(false);
    let bulkDeleteConfirmInput = $state('');

    function toSelectedRowSnapshot(item: (typeof data.items)[number]): SelectedRowSnapshot {
        return {
            id: item.id,
            mediaType: item.mediaType,
            childCount: item.childCount,
            hasFiles: item.hasFiles,
            title: item.title,
            tmdbId: item.tmdbId,
            metadataLocked: item.metadataLocked,
        };
    }

    // DELETE /api/admin/unmatched-files/{id} soft-dismisses the item and its
    // descendants. This browser offers no Undo/restore control, so warn and
    // confirm before both the single-row and bulk paths
    // (#19). `dismissConfirmIds` non-empty means the confirm modal is open;
    // a single entry is the single-row case, many entries the bulk case.
    let dismissConfirmIds = $state<string[]>([]);
    let dismissConfirmTitle = $state('');
    /**
     * How many SELECTED rows the confirmed dismiss will leave alone, because
     * they already have a provider match. Held beside the id list rather than
     * re-derived in the dialog: the dialog must describe the batch that was
     * pinned when the button was pressed, not a selection that a background
     * `invalidateAll()` may have refreshed underneath it.
     */
    let dismissConfirmSkipped = $state(0);

    // Fileless-merge confirmation (replaces native confirm(), #33). Holds the
    // pending pair while the ActionModal is shown.
    let mergeConfirmPair = $state<FilelessDuplicatePair | null>(null);

    /*
     * PLACEMENT (do not move back up): `anyOverlayOpen` reads state declared
     * as far down as `mergeConfirmPair` just above, so it must be declared
     * AFTER all seven. It previously sat ~1200 lines earlier, which is a
     * temporal dead zone: legal only because `$derived` is lazy and nothing
     * evaluates it during setup. svelte-check reported 12 "used before its
     * declaration" errors for it, invisible until .svelte type checking was
     * restored. Keep it below every member it reads.
     */
    /**
     * Whether a page-owned overlay is currently open.
     *
     * Every one of these is an `ActionModal`/`IdentifyModal`/popover that
     * ALSO closes itself on Escape without stopping propagation, so the event
     * still reaches this window handler. Listing them here is what makes one
     * Escape do exactly ONE thing: without `dismissConfirmIds` in this set,
     * an Escape over the dismiss confirmation would close the modal AND fall
     * through to clear the selection the operator was about to act on.
     */
    let anyOverlayOpen = $derived(
        showDeleteConfirm ||
            inspectorDeleteItem !== null ||
            dismissConfirmIds.length > 0 ||
            mergeConfirmPair !== null ||
            identifyItem !== null ||
            showColumnPicker ||
            showFilterPanel,
    );

    /** Close the topmost open overlay. Mirrors `anyOverlayOpen`'s membership. */
    function closeTopOverlay(): void {
        if (showDeleteConfirm) closeBulkDeleteConfirm();
        else if (inspectorDeleteItem !== null) inspectorDeleteItem = null;
        else if (dismissConfirmIds.length > 0) dismissConfirmIds = [];
        else if (mergeConfirmPair !== null) mergeConfirmPair = null;
        else if (identifyItem !== null) advanceIdentifyQueue();
        else if (showColumnPicker) showColumnPicker = false;
        else if (showFilterPanel) showFilterPanel = false;
    }

    /**
     * How many `<td>`s a full-width row must span.
     *
     * ONE consumer left — the empty-state cell. The other was
     * `MediaPreviewRow`'s colspan expansion, which the inspector replaced; the
     * count is still needed because "no items match" must stretch across the
     * whole table, and it is still worth deriving rather than hard-coding for
     * the reason below.
     *
     * Counts with `isColVisible` — the SAME predicate the header and body cells
     * render through — so the count and the render agree by construction.
     * Counting `visibleColumns.has()` alone (the stored preference) overshot
     * whenever a column is stored-visible but not applicable to the current
     * view, which the ancestry columns now make routine: they flip on
     * `typeFilter` at every Tracks↔Albums and Episodes↔Seasons switch, so the
     * empty-state cell was over-spanning constantly.
     *
     * The same construction is what makes the docked-inspector suppression safe
     * for the colspan: `isColVisible` drops `INSPECTOR_DUPLICATED_COLUMNS` while
     * the panel is open, so this count follows the RENDERED set without needing
     * to know that layer exists.
     */
    // Checkbox column is always present now that selection is not a mode.
    let visibleColumnCount = $derived(COLUMNS.filter((c) => isColVisible(c.key)).length + 1);

    function clearSelection(): void {
        selectedRows.clear();
        lastSelectedIndex = null;
    }

    // Clear the selection on a real filter change only — NOT on a page turn or
    // a sort change, both of which leave `filterIdentity` unchanged. Comparing
    // against the previous URL's identity (rather than reacting to
    // `data.items` directly, the original bug) is what lets a selection span
    // pages at all.
    let previousFilterIdentity: string | null = null;
    $effect(() => {
        const currentFilterIdentity = filterIdentity(page.url.searchParams);
        if (
            previousFilterIdentity !== null &&
            shouldClearSelection(previousFilterIdentity, currentFilterIdentity)
        ) {
            selectedRows.clear();
        }
        previousFilterIdentity = currentFilterIdentity;
    });

    // The shift-range anchor, unlike the selection itself, is index-based into
    // `data.items` and MUST reset on every navigation that swaps that array —
    // page turns and sort changes included, not just real filter changes.
    // Otherwise a shift-click on a new page would range against an index that
    // now points at a different row on a different page.
    //
    // This is also where a still-selected row's snapshot gets refreshed
    // against the newly loaded page. `bulkSync`/`bulkImageSync`/bulk-identify
    // all `invalidateAll()` without clearing the selection (cross-page
    // selection surviving a bulk action is the point of this module), so
    // without a refresh here `bulkDelete`'s `childCount > 0` skip guard would
    // keep reading the ORIGINAL snapshot forever — e.g. `bulkSync(true)`
    // ("sync with children") can grow a series' real child count
    // server-side, and a later Delete on the same still-selected row would
    // see a stale `childCount: 0` and attempt a non-cascade delete against a
    // parent that now has children. `refreshSelection` only touches ids
    // already selected that reappear in `data.items`; an off-page id is left
    // exactly as it was — refreshing must never drop a selection that spans
    // pages. (An off-page snapshot can still go stale between refreshes; the
    // server's own 409-on-children-without-cascade guard is the backstop for
    // that residual gap.)
    //
    // The refresh runs inside `untrack` because it both READS `selectedRows`
    // (`refreshSelection` copies the map and probes it per row) and WRITES it,
    // and `toSelectedRowSnapshot` mints a fresh object every call — so the
    // identity guard this used to rely on never held, every run wrote, every
    // write re-invalidated the map, and the effect re-ran forever. Svelte
    // aborts that with `effect_update_depth_exceeded`, which meant ticking a
    // single checkbox tore the page down. `data.items` alone is the intended
    // (and only correct) trigger: this exists to reconcile a selection against
    // a NEWLY LOADED page, never against its own writes.
    $effect(() => {
        const freshSnapshots = data.items.map((item) => toSelectedRowSnapshot(item));
        untrack(() => {
            const refreshed = refreshSelection(selectedRows, freshSnapshots);
            for (const [id, row] of refreshed) selectedRows.set(id, row);
        });
        // Deliberately OUTSIDE `untrack`, and safe only because nothing in this
        // effect READS `lastSelectedIndex` — a write alone creates no
        // dependency. Adding a read of it anywhere above (e.g. "only reset the
        // anchor if it points off the new page") silently restores the exact
        // read-and-write loop the `untrack` above exists to prevent. Move this
        // inside `untrack` before adding any such read.
        lastSelectedIndex = null;
    });

    /**
     * Grow the selection, stopping at `SELECTION_MAX`.
     *
     * EVERY growth path goes through here — checkbox, Space, shift-range and
     * select-all-on-page — because the cap is a property of the SELECTION, not
     * of any one gesture. Capping only the select-all button would not be a
     * cap at all: a selection deliberately spans pages (that is what
     * `selection.ts` exists for), so twenty-one page-selects would walk
     * straight past the ceiling one gesture at a time.
     *
     * Re-adding a row that is already selected refreshes its snapshot and
     * cannot grow the set, so it is never refused even at the cap.
     */
    function addToSelection(rows: SelectedRowSnapshot[]): void {
        let refused = 0;
        for (const row of rows) {
            if (selectedRows.has(row.id) || selectedRows.size < SELECTION_MAX) {
                selectedRows.set(row.id, row);
            } else {
                refused++;
            }
        }
        if (refused > 0) toasts.warning(m.media_selection_cap_reached({ max: SELECTION_MAX }));
    }

    function toggleSelectItem(index: number, shiftKey: boolean): void {
        const item = data.items[index];
        if (!item) return;

        if (shiftKey && lastSelectedIndex !== null) {
            const start = Math.min(lastSelectedIndex, index);
            const end = Math.max(lastSelectedIndex, index);
            const range: SelectedRowSnapshot[] = [];
            for (let j = start; j <= end; j++) {
                const row = data.items[j];
                if (row) range.push(toSelectedRowSnapshot(row));
            }
            addToSelection(range);
        } else {
            if (selectedRows.has(item.id)) selectedRows.delete(item.id);
            else addToSelection([toSelectedRowSnapshot(item)]);
        }
        lastSelectedIndex = index;
    }

    // Whether every row on the CURRENT page is selected — not whether the
    // total selection size happens to equal the page length, which breaks the
    // moment a selection spans more than one page (e.g. 30 selected on page 1
    // + 20 on page 2 also equals a 50-row page).
    let allOnPageSelected = $derived(
        data.items.length > 0 && data.items.every((it) => selectedRows.has(it.id)),
    );

    function toggleSelectAll(): void {
        if (allOnPageSelected) {
            for (const item of data.items) selectedRows.delete(item.id);
        } else {
            addToSelection(data.items.map((item) => toSelectedRowSnapshot(item)));
        }
    }

    // Derived: context-aware info about selected items, valid across pages
    // because the snapshots carry their own `mediaType`/`tmdbId` rather than
    // being looked up by filtering the current page's `data.items`.
    //
    // `hasSeriesSelected` / `hasUnidentifiedSelected` used to live here and be
    // handed to `MediaActionBar` as props. They are derived inside the bar
    // now, from these same snapshots: the bar builds the `ActionContext` the
    // registry answers, and a flag computed on this side could disagree with
    // the way the registry is asked about it — which is precisely how the bar
    // and the per-row Actions column drifted apart before task 1.
    let selectedItems = $derived([...selectedRows.values()]);

    /**
     * Reload the page data after a mutation.
     *
     * `clearPreviewCache()` rides along deliberately (handoff (b) from task 4).
     * `MediaInspector` also self-clears via an `$effect` on `page.data`, but
     * that only covers paths that actually reload — anything that mutates the
     * item and then decides NOT to reload would leave the panel showing a
     * pre-mutation preview with no signal that it is stale. Pairing the two
     * calls in ONE helper is what stops a future call site remembering the
     * invalidate and forgetting the cache.
     */
    function reloadAfterMutation(): void {
        clearPreviewCache();
        void invalidateAll();
    }

    // Bulk action helpers — progress shown via persistent toast that gets replaced
    function showProgress(prevId: number | null, msg: string): number {
        if (prevId !== null) toasts.remove(prevId);
        return toasts.info(msg, 0);
    }

    /**
     * Stops any in-flight run poll when the page goes away, so navigating off
     * the browser does not leave a timer walking to its ceiling.
     */
    let pageDestroyed = false;
    onDestroy(() => {
        pageDestroyed = true;
    });

    const RUN_POLL_INTERVAL_MS = 2000;
    /**
     * Poll ceiling: 7h, i.e. `bulk-media-sync`'s own `timeout: { hard: '6h' }`
     * plus an hour of queue slack. Past that the run has been killed by the
     * orchestrator and there is nothing left to wait for.
     *
     * Present because an unbounded `for (;;)` around a network call is not
     * acceptable however unlikely the ceiling is. Reaching it is reported as
     * "still running", NOT as failure — the client giving up says nothing
     * about what the server did.
     */
    const RUN_POLL_MAX_ATTEMPTS = Math.ceil((7 * 60 * 60 * 1000) / RUN_POLL_INTERVAL_MS);

    /**
     * Consecutive failed polls tolerated before this page stops waiting.
     *
     * The loop polls every 2s for up to 7h — as many as 12,600 requests.
     * Treating the FIRST failure as "the run failed" turns a deploy's 502, a
     * token refresh, a sleeping laptop or one dropped connection into
     * "Synced 0 items, 500 failed" for a run that is proceeding perfectly
     * well. The toast is false, and the natural operator response to it is to
     * re-fire the batch — 500 more TMDB round trips against a run still in
     * flight.
     *
     * Exhausting the budget reports `incomplete` ("still running"), never
     * failure: the CLIENT losing contact says nothing about what the server
     * did. Only a 404 proves the run is actually gone.
     */
    const RUN_POLL_MAX_CONSECUTIVE_ERRORS = 5;

    interface BulkSyncOutcome {
        processed: number;
        failed: number;
        /**
         * Ids in this chunk the run's own report does not account for. NOT the
         * same as `failed`: failed means the task tried and the item errored,
         * unaccounted means nobody knows what happened to it.
         */
        unaccounted: number;
        /**
         * The run itself said it did not finish cleanly — its own
         * `success: false`, or a terminal `failed`/`cancelled` state. Carries
         * no count: it exists for the case the arithmetic cannot see, where an
         * abort landed on the FINAL item so every id is accounted for and the
         * run still did not complete normally.
         */
        degraded: boolean;
        /** The run had not finished when we stopped waiting. */
        incomplete: boolean;
    }

    /**
     * Read what a `bulk-media-sync` run actually did out of its result payload.
     *
     * `run.result` IS the task's `TaskResult`, so `itemsProcessed`/`failedIds`
     * sit on it directly — not under a nested `result` key the way
     * `auto-identify-personal-media`'s `matched` does (confirmed against
     * `runner.ts`'s own `result->>'itemsProcessed'` comment). Typed as
     * `unknown` on the wire (`RunSchema.result` is `z.unknown()`), hence the
     * narrowing.
     *
     * Every field is read defensively and an unrecognised payload reports
     * 0 / 0 / null. That is deliberately NOT treated as "the run did nothing"
     * — the caller reconciles against the chunk size, so a payload it cannot
     * read leaves the whole chunk unaccounted for. Not a hypothetical shape:
     * `runner.ts` documents 1.06M preprod rows that landed as JSONB *string
     * scalars* before `sql.json()` was introduced, and a renamed field reads
     * identically.
     *
     * `declaredSuccess` is `null` when the task did not state a verdict, which
     * must not be read as `false` — most payloads carry it, and inventing a
     * failure from its absence would warn on every clean run that omits it.
     */
    function readBulkSyncResult(result: unknown): {
        processed: number;
        failed: number;
        declaredSuccess: boolean | null;
    } {
        if (typeof result !== 'object' || result === null || Array.isArray(result)) {
            return { processed: 0, failed: 0, declaredSuccess: null };
        }
        const payload = result as {
            itemsProcessed?: unknown;
            failedIds?: unknown;
            success?: unknown;
        };
        return {
            processed: typeof payload.itemsProcessed === 'number' ? payload.itemsProcessed : 0,
            failed: Array.isArray(payload.failedIds) ? payload.failedIds.length : 0,
            declaredSuccess: typeof payload.success === 'boolean' ? payload.success : null,
        };
    }

    /**
     * Live per-item progress for a run, from its `main` stage.
     *
     * `bulk-media-sync` already calls `ctx.reportProgress` once per item and
     * the orchestrator merges that into `run.stages`, synthesising a stage
     * entry for single-task runs that persist no pipeline plan
     * (`mergeLiveProgress`). So the poll this page is already making carries
     * real progress for free — and without reading it, a 1,000-item selection
     * produces exactly two toast updates for however long the batch runs.
     *
     * Structurally typed rather than importing `Run`: all this needs is the
     * highest `processed` any stage reports.
     */
    function readRunProgress(run: { stages: { processed?: number }[] }): number | null {
        let best: number | null = null;
        for (const stage of run.stages) {
            if (typeof stage.processed === 'number' && Number.isFinite(stage.processed)) {
                best = Math.max(best ?? 0, stage.processed);
            }
        }
        return best;
    }

    /**
     * Wait for one enqueued bulk-sync run and report what it did.
     *
     * ⚠️ Deliberately NOT modelled on `NeverMatchedPanel`'s `pollAutoIdentify`,
     * which decides the outcome from `run.state` alone. `bulk-media-sync`
     * returns NORMALLY on a partial failure — it only throws when nothing at
     * all synced — so a batch where 499 of 500 items failed still records as a
     * `completed` run. Branching on state would hand that batch a success
     * toast and lose the failures silently.
     *
     * But reading the payload is not sufficient on its own either, because
     * `completed` proves the run RETURNED, not that it touched every id. Two
     * reachable payloads report zero failures over a chunk that was mostly
     * skipped:
     *
     *  - an ABORT returns normally (`{ success: false, itemsProcessed,
     *    stopReason: 'aborted', failedIds }` in `media-item-tasks.ts`), so a
     *    500-id chunk cancelled after 10 items records `completed` with
     *    `itemsProcessed: 10` and an empty `failedIds`;
     *  - an unreadable payload reads as `0 / 0` — see `readBulkSyncResult`.
     *
     * So the payload is reconciled against the CHUNK SIZE: whatever the run
     * does not account for is `unaccounted`, and the task's own
     * `success: false` is believed even when the arithmetic happens to balance
     * (an abort landing on the final item processes every id and still
     * declares failure).
     */
    async function awaitBulkSyncRun(
        jobId: string,
        size: number,
        onProgress?: (processedInChunk: number) => void,
    ): Promise<BulkSyncOutcome> {
        /**
         * Reconcile a terminal payload against what we actually submitted.
         *
         * The subtraction is the whole guard, and it covers an unreadable
         * payload for free: a result that cannot be parsed reports 0 and 0, so
         * `size - 0` leaves the entire chunk unaccounted for rather than
         * reading as a clean run that happened to do nothing. (An earlier
         * draft special-cased unreadability separately; revert-checking showed
         * the branch could not fail on its own, because the arithmetic had
         * already caught every input it was written for.)
         *
         * `degraded` covers the one case the arithmetic cannot see: an abort
         * that lands on the FINAL item has processed every id, so the
         * subtraction is 0 and only the task's own `success: false`
         * distinguishes it from a clean finish. It is a FLAG and not an
         * adjustment to `unaccounted` on purpose — a first draft folded it in
         * as `size - processed`, which is either 0 (no effect) or, when the
         * chunk also had real failures, silently double-counts them as
         * unaccounted. Revert-checking caught that: the clause could not make
         * a single test fail, which is what a no-op-or-wrong branch looks like.
         */
        const settle = (result: unknown, terminalFailure: boolean): BulkSyncOutcome => {
            const { processed, failed, declaredSuccess } = readBulkSyncResult(result);
            return {
                processed,
                failed,
                unaccounted: Math.max(0, size - (processed + failed)),
                degraded: declaredSuccess === false || terminalFailure,
                incomplete: false,
            };
        };

        let consecutiveErrors = 0;
        let lastReported = -1;
        for (let attempt = 0; attempt < RUN_POLL_MAX_ATTEMPTS; attempt++) {
            if (pageDestroyed)
                return {
                    processed: 0,
                    failed: 0,
                    unaccounted: 0,
                    degraded: false,
                    incomplete: true,
                };
            const {
                data: run,
                error,
                status,
            } = await apiGet(`/api/runs/${encodeURIComponent(jobId)}`, RunSchema);
            if (error || !run) {
                // A 404 is the one answer that proves the run is gone; every
                // other failure is a transport problem that says nothing about
                // the run. See RUN_POLL_MAX_CONSECUTIVE_ERRORS.
                if (status === 404) {
                    return {
                        processed: 0,
                        failed: 0,
                        unaccounted: size,
                        degraded: true,
                        incomplete: false,
                    };
                }
                consecutiveErrors++;
                if (consecutiveErrors >= RUN_POLL_MAX_CONSECUTIVE_ERRORS) {
                    return {
                        processed: 0,
                        failed: 0,
                        unaccounted: 0,
                        degraded: false,
                        incomplete: true,
                    };
                }
                await new Promise((resolve) => setTimeout(resolve, RUN_POLL_INTERVAL_MS));
                continue;
            }
            // One good answer clears the budget: five SCATTERED failures over
            // seven hours are noise, five in a row are a real loss of contact.
            consecutiveErrors = 0;

            if (run.state === 'completed') return settle(run.result, false);
            if (run.state === 'failed' || run.state === 'cancelled') {
                return settle(run.result, true);
            }

            // Still running — surface the per-item progress the run is already
            // reporting, but only when it moves, so the toast is not torn down
            // and rebuilt every 2s for no visible change.
            const progressed = readRunProgress(run);
            if (progressed !== null && progressed !== lastReported) {
                lastReported = progressed;
                onProgress?.(Math.min(progressed, size));
            }
            await new Promise((resolve) => setTimeout(resolve, RUN_POLL_INTERVAL_MS));
        }
        return { processed: 0, failed: 0, unaccounted: 0, degraded: false, incomplete: true };
    }

    /**
     * Bulk metadata sync — one enqueued background run per chunk.
     *
     * Was N sequential `syncMediaMetadata` calls straight from the browser:
     * one HTTP round trip per item, every one of them provider-hitting, and
     * all of them dying with the tab. Task 2 replaced that with
     * `POST /api/admin/media/bulk-sync`, which enqueues a `bulk-media-sync`
     * run and hands back a jobId; the work now survives the tab closing.
     *
     * Progress is reported PER CHUNK, not once at the end. A 1,000-item
     * selection is two runs and each can take a long time — a single toast at
     * the end would leave the operator with no signal at all for the first
     * one, which is precisely when they most want to know something is
     * happening.
     */
    async function bulkSync(includeChildren: boolean): Promise<void> {
        const ids = [...selectedRows.keys()];
        if (ids.length === 0) return;
        const chunks = chunkIds(ids, BULK_CHUNK_SIZE);
        bulkBusy = true;
        let processed = 0;
        let failed = 0;
        let unaccounted = 0;
        let settled = 0;
        let degraded = false;
        let incomplete = false;
        let tid: number | null = null;
        try {
            tid = showProgress(
                null,
                m.admin_media_progress_syncing({ current: 0, total: ids.length }),
            );
            for (const batch of chunks) {
                const { data, error } = await enqueueBulkSync(batch, { includeChildren });
                if (error || !data) {
                    // The enqueue itself was refused, so nothing was ever
                    // started for these ids — a real failure, not an unknown.
                    failed += batch.length;
                } else {
                    const outcome = await awaitBulkSyncRun(
                        data.jobId,
                        batch.length,
                        // Per-ITEM progress, from the run's own reportProgress
                        // (see readRunProgress). `settled` is the chunks
                        // already finished, so this counts across the whole
                        // selection rather than restarting each chunk.
                        (inChunk) => {
                            tid = showProgress(
                                tid,
                                m.admin_media_progress_syncing({
                                    current: settled + inChunk,
                                    total: ids.length,
                                }),
                            );
                        },
                    );
                    processed += outcome.processed;
                    failed += outcome.failed;
                    unaccounted += outcome.unaccounted;
                    degraded = degraded || outcome.degraded;
                    incomplete = incomplete || outcome.incomplete;
                }
                settled += batch.length;
                tid = showProgress(
                    tid,
                    m.admin_media_progress_syncing({ current: settled, total: ids.length }),
                );
            }
            toasts.remove(tid);
            tid = null;
            if (incomplete && !degraded && failed === 0 && unaccounted === 0 && processed === 0) {
                // Never observed a terminal state — the run is still going, or
                // this page lost contact with it. Saying "synced 0" here would
                // be a lie in the other direction.
                toasts.info(m.media_toast_sync_still_running({ total: ids.length }));
            } else {
                // Anything other than a fully accounted-for, fully clean batch
                // is a WARNING. `unaccounted` is reported SEPARATELY from
                // `failed` on purpose: failed means the run tried and the item
                // errored, unaccounted means the run's own report does not
                // cover it (it aborted, or its payload was unreadable) and
                // nobody can say what happened to it. Collapsing the two would
                // put a confident number on a genuine unknown.
                let msg: string = m.media_toast_synced_items({ done: processed });
                if (failed > 0) msg += m.media_toast_failed_suffix({ failed });
                if (unaccounted > 0) msg += m.media_toast_unaccounted_suffix({ unaccounted });
                // `degraded` carries no count, so it needs its own words — a
                // bare warning over "Synced 2 items" would leave the operator
                // with nothing to act on.
                if (degraded) msg += m.media_toast_sync_run_degraded();
                // A chunk whose outcome never arrived is unknown, even when
                // the other chunks finished cleanly.
                if (incomplete) msg += m.media_toast_sync_still_running_suffix();
                toasts[
                    failed > 0 || unaccounted > 0 || degraded || incomplete ? 'warning' : 'success'
                ](msg);
            }
            reloadAfterMutation();
        } catch {
            if (tid !== null) toasts.remove(tid);
            toasts.error(
                m.media_toast_sync_failed({
                    processed: processed + failed + unaccounted,
                    total: ids.length,
                }),
            );
        } finally {
            bulkBusy = false;
        }
    }

    /**
     * Bulk unlock — `PATCH /api/admin/media/bulk-lock` per chunk.
     *
     * One request per 500 rows against a single `UPDATE ... WHERE id = ANY(...)`,
     * rather than N requests: unlike sync this touches nothing but the
     * database, which is why task 2 gave it a batch endpoint instead of a
     * background run.
     *
     * Only ever sends `locked: false`. There is no manual "lock now" anywhere
     * in this codebase — a lock is a side effect of saving metadata — which is
     * also why the registry's `unlock` is the one rule that reads `locked`.
     */
    async function bulkUnlock(): Promise<void> {
        const ids = [...selectedRows.keys()];
        if (ids.length === 0) return;
        const chunks = chunkIds(ids, BULK_CHUNK_SIZE);
        bulkBusy = true;
        let unlocked = 0;
        let failed = 0;
        let settled = 0;
        let tid: number | null = null;
        try {
            tid = showProgress(null, m.media_progress_unlocking({ current: 0, total: ids.length }));
            for (const batch of chunks) {
                const { data, error } = await bulkSetLock(batch, false);
                if (error || !data) {
                    failed += batch.length;
                } else {
                    unlocked += data.updatedCount;
                    // `skippedCount` is rows that were already unlocked — not a
                    // failure, and not worth reporting as one. `failedIds` is
                    // the ids the UPDATE matched no row for.
                    failed += data.failedIds.length;
                }
                settled += batch.length;
                tid = showProgress(
                    tid,
                    m.media_progress_unlocking({ current: settled, total: ids.length }),
                );
            }
            toasts.remove(tid);
            tid = null;
            let msg: string = m.media_toast_unlocked_items({ count: unlocked });
            if (failed > 0) msg += m.media_toast_failed_suffix({ failed });
            toasts[failed > 0 ? 'warning' : 'success'](msg);
            reloadAfterMutation();
        } catch (e) {
            if (tid !== null) toasts.remove(tid);
            toasts.error(getErrorMessage(e, m.toast_metadata_unlock_failed()));
        } finally {
            bulkBusy = false;
        }
    }

    async function bulkImageSync(): Promise<void> {
        const ids = [...selectedRows.keys()];
        bulkBusy = true;
        let done = 0;
        let failed = 0;
        let tid: number | null = null;
        try {
            tid = showProgress(
                null,
                m.media_progress_syncing_images({
                    current: 0,
                    total: ids.length,
                }),
            );
            for (const id of ids) {
                const { error } = await syncMediaImages(id);
                if (!error) done++;
                else failed++;
                tid = showProgress(
                    tid,
                    m.media_progress_syncing_images({
                        current: done + failed,
                        total: ids.length,
                    }),
                );
            }
            toasts.remove(tid);
            let msg: string = m.media_toast_image_sync_complete({ done });
            if (failed > 0) msg += m.media_toast_failed_suffix({ failed });
            toasts[failed > 0 ? 'warning' : 'success'](msg);
            reloadAfterMutation();
        } catch {
            if (tid !== null) toasts.remove(tid);
            toasts.error(
                m.media_toast_image_sync_failed({
                    processed: done + failed,
                    total: ids.length,
                }),
            );
        } finally {
            bulkBusy = false;
        }
    }

    async function bulkDelete(): Promise<void> {
        // The dialog's Delete button is `disabled` until this holds, but the
        // guard is repeated here so the rule is enforced by the thing that
        // actually deletes rather than only by the thing that renders.
        if (!bulkDeleteConfirmed) return;
        // Nothing in the selection survives the child skip, so there is no
        // destructive action to run. Enforced here as well as by the dialog's
        // `disabled`, for the same reason the confirmation guard above is:
        // the thing that deletes owns the rule.
        if (deleteSummary.deletable === 0) return;
        const items = [...selectedItems];
        closeBulkDeleteConfirm();
        bulkBusy = true;
        let deleted = 0;
        let skipped = 0;
        // Every attempted item lands in exactly one of these three buckets, so
        // `deleted + skipped + failed === items.length` by construction.
        //
        // `failed` used to not exist and the `else` branch below was simply
        // absent: an item the server refused — a stale off-page snapshot
        // meeting the server's own 409-on-children guard, a row another admin
        // had already deleted, a permissions error — was counted in NEITHER
        // `deleted` nor `skipped`. The toast then reported a number smaller
        // than the selection with nothing to say why, after the operator had
        // typed a confirmation word to authorise the batch. Silence is the
        // wrong report for a destructive action that did not do what it said.
        let failed = 0;
        let tid: number | null = null;
        try {
            tid = showProgress(
                null,
                m.admin_media_progress_deleting({ current: 0, total: items.length }),
            );
            for (const item of items) {
                if (item.childCount > 0) {
                    skipped++;
                    continue;
                }
                const { error } = await deleteMedia(item.id);
                if (!error) deleted++;
                else failed++;
                tid = showProgress(
                    tid,
                    m.admin_media_progress_deleting({
                        current: deleted + skipped + failed,
                        total: items.length,
                    }),
                );
            }
            toasts.remove(tid);
            let msg: string = m.admin_media_toast_deleted_items({ deleted });
            // Skipped and failed are reported SEPARATELY, and neither is folded
            // into the other: skipped is a rule this page applied before asking
            // the server anything, failed is the server refusing. Collapsing
            // them would tell the operator a row was protected when it was in
            // fact an error they can retry.
            if (skipped > 0) msg += m.media_toast_delete_skipped_suffix({ skipped });
            if (failed > 0) msg += m.media_toast_failed_suffix({ failed });
            toasts[failed > 0 ? 'warning' : 'success'](msg);
            clearSelection();
            reloadAfterMutation();
        } catch {
            if (tid !== null) toasts.remove(tid);
            toasts.error(m.media_toast_delete_failed({ deleted, total: items.length }));
        } finally {
            bulkBusy = false;
        }
    }

    /**
     * Open the confirmation modal for dismissing the current selection (#19).
     *
     * Narrowed to the rows the action APPLIES TO, which is not the same set as
     * the rows that are selected. The bar offers Dismiss when
     * `isUnidentifiedDomain && hasUnidentifiedSelected` — i.e. when AT LEAST
     * ONE selected row lacks a provider match (`!tmdbId`, the same predicate
     * `MediaActionBar` derives that flag from) — while this executor used to
     * pass every selected id. A mixed selection could therefore hide rows that
     * already HAD a match, outside the button's stated scope.
     *
     * The fix is deliberately on this side: narrowing the executor to the
     * button's rule, rather than widening the rule to hide the button for a
     * mixed selection. "Applies to at least one selected row" is how every
     * other bulk action in this bar reads (bulk delete skips the rows it
     * cannot delete rather than refusing the whole batch), so the visibility
     * rule is right and the executor was the thing out of step.
     */
    function requestBulkDismiss(): void {
        const targets = selectedItems.filter((row) => !row.tmdbId);
        if (targets.length === 0) return;
        dismissConfirmTitle = m.admin_aria_confirm_bulk_dismiss();
        dismissConfirmSkipped = selectedItems.length - targets.length;
        dismissConfirmIds = targets.map((row) => row.id);
    }

    /** Open the confirmation modal for dismissing a single row (#19). */
    function requestDismissItem(itemId: string): void {
        dismissConfirmTitle = m.admin_aria_confirm_dismiss();
        dismissConfirmSkipped = 0;
        dismissConfirmIds = [itemId];
    }

    /** Execute the confirmed dismiss. Single id → single toast; many → bulk. */
    async function confirmDismiss(): Promise<void> {
        const ids = [...dismissConfirmIds];
        dismissConfirmIds = [];
        if (ids.length === 0) return;
        if (ids.length === 1 && ids[0]) {
            await dismissItem(ids[0]);
            return;
        }
        await bulkDismiss(ids);
    }

    async function bulkDismiss(ids: string[]): Promise<void> {
        bulkBusy = true;
        let done = 0;
        let failed = 0;
        let tid: number | null = null;
        try {
            tid = showProgress(
                null,
                m.media_progress_dismissing({ current: 0, total: ids.length }),
            );
            for (const id of ids) {
                // Track per-item API failures so a partial outcome is reported
                // truthfully instead of a blanket success (#20).
                const { error } = await dismissUnmatchedFile(id);
                if (!error) done++;
                else failed++;
                tid = showProgress(
                    tid,
                    m.media_progress_dismissing({
                        current: done + failed,
                        total: ids.length,
                    }),
                );
            }
            toasts.remove(tid);
            let msg: string = m.media_toast_dismissed({ count: done });
            if (failed > 0) msg += m.media_toast_failed_suffix({ failed });
            toasts[failed > 0 ? 'warning' : 'success'](msg);
            // On a total failure keep the selection so the operator can retry the
            // same items instead of having to re-select everything (#20-selection).
            if (done > 0) clearSelection();
            reloadAfterMutation();
        } catch {
            if (tid !== null) toasts.remove(tid);
            toasts.error(m.media_toast_dismiss_failed({ done, total: ids.length }));
        } finally {
            bulkBusy = false;
        }
    }

    /**
     * "1 Movie", "40 Movies", "3 Series" — a counted, plural-correct label for
     * one media type in the delete confirmation's breakdown.
     *
     * `getMediaTypeDisplay` rather than `toPublicMediaType`: the latter maps
     * `extra`, `home_video`, `personal`, `book` and several others to `null`,
     * so a fallback to the raw value printed the internal storage token
     * ("2 home_video") in a destructive dialog. `getMediaTypeDisplay` has an
     * entry for every internal type and is the same label the Type column
     * badge already shows, so the dialog and the table agree.
     *
     * The plural is appended in code, matching what `MediaInspector` already
     * does for its season count. Two Paraglide keys differing only by a
     * literal "s" would carry no translation value, because the LABEL is
     * English in every locale — `getMediaTypeDisplay` has no localised form
     * anywhere in this codebase. Localising the media-type vocabulary is its
     * own task; until then the sentence around these nouns is translated and
     * the nouns are not, exactly as in the Type column beside it.
     *
     * The trailing-s guard is not cosmetic: "Series" is the label for `tv`,
     * the single most likely type in this dialog, and it would otherwise read
     * "3 Seriess".
     */
    function pluralMediaTypeLabel(type: string, count: number): string {
        const label = getMediaTypeDisplay(type);
        if (count === 1 || label.endsWith('s')) return label;
        return `${label}s`;
    }

    /**
     * What a bulk delete is about to do, in the operator's own terms.
     *
     * "Delete 40 items" is not something anyone can consent to: it does not
     * say what the forty ARE, and it does not say that the three series among
     * them will not in fact be deleted. Both numbers come from `summarise()`
     * over the same snapshots the request will carry, so the dialog and the
     * requests cannot describe different sets.
     *
     * Deliberately carries NO child count. `child_count` in the listing query
     * is `COUNT(*) WHERE parent_id = mi.id` — DIRECT children — so a series'
     * number is its seasons, and printing "(12 in total)" invited the reader
     * to take 12 as the untouched subtree when for three series it is nearer
     * 215. Worse, nothing is deleted on its account either way: the parents
     * are skipped and their descendants were never in scope. No decision
     * depends on the number, so the line names the skip and stops there.
     *
     * `deletable` is the number the dialog must actually promise. It used to
     * promise `selectedCount` in the title, the lead sentence and the
     * type-to-confirm line while the yellow line below them said every one of
     * those rows would be skipped — with 19 artists that read "permanently
     * delete 19 items" above "19 of these ... will be SKIPPED", with Delete
     * enabled and pressing it deleting nothing. It is `total - withChildren`
     * rather than a second count of its own so it cannot disagree with the
     * skip line beside it, and both come from the `summarise()` whose
     * `childCount > 0` predicate is the one `bulkDelete` skips on.
     */
    let deleteSummary = $derived.by(() => {
        const totals = summarise(selectedItems);
        const breakdown = Object.entries(totals.byType)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([type, count]) => `${count} ${pluralMediaTypeLabel(type, count)}`)
            .join(', ');
        return {
            breakdown,
            withChildren: totals.withChildren,
            deletable: totals.total - totals.withChildren,
        };
    });

    /**
     * The typed confirmation, reusing the detail page's rule rather than
     * inventing a bulk one.
     *
     * A selection has no single raw title, which is exactly the case
     * `delete-confirm.ts` already handles: with an empty title the expected
     * value falls back to a fixed word, so the guard demands a deliberate act
     * instead of unlocking on an empty input. Passing '' is therefore the
     * intended use of that module, not a workaround for it.
     */
    const BULK_DELETE_CONFIRM_TITLE = '';
    const bulkDeleteConfirmExpected = deleteConfirmExpectedValue(BULK_DELETE_CONFIRM_TITLE);
    let bulkDeleteConfirmed = $derived(
        isDeleteConfirmed(bulkDeleteConfirmInput, BULK_DELETE_CONFIRM_TITLE),
    );

    function openBulkDeleteConfirm(): void {
        bulkDeleteConfirmInput = '';
        showDeleteConfirm = true;
    }

    function closeBulkDeleteConfirm(): void {
        showDeleteConfirm = false;
        bulkDeleteConfirmInput = '';
    }

    /**
     * Run every action the registry can emit at `surface: 'selection'`.
     *
     * The mirror of `handleInspectorAction`: the registry decides WHICH
     * buttons the bar shows, this decides what they do, and the switch is
     * exhaustive over `MediaActionId` so a newly registered action fails
     * typecheck here instead of rendering a live-looking dead button — the
     * failure mode that actually shipped between tasks 4 and 5.
     */
    function handleSelectionAction(action: MediaActionId): void {
        switch (action) {
            case 'unlock':
                void bulkUnlock();
                return;
            case 'delete':
                openBulkDeleteConfirm();
                return;
            case 'syncMetadata':
                void bulkSync(false);
                return;
            case 'syncWithChildren':
                void bulkSync(true);
                return;
            case 'syncImages':
                void bulkImageSync();
                return;
            case 'identify':
                handleBulkIdentify();
                return;
            case 'dismiss':
                requestBulkDismiss();
                return;
            // Item-surface only: `play`, `watch`, `reorder` and `reprobe` are
            // all `scope: 'item'`, so `actionsFor` never returns them at
            // `surface: 'selection'`. The cases exist to keep the switch
            // exhaustive, exactly as `reorder` does in the inspector's.
            case 'play':
            case 'watch':
            case 'reorder':
            case 'reprobe':
                return;
        }
    }

    async function dismissItem(itemId: string): Promise<void> {
        dismissingItems.add(itemId);
        try {
            const { error } = await dismissUnmatchedFile(itemId);
            if (!error) {
                toasts.success(m.admin_toast_item_dismissed());
                reloadAfterMutation();
            } else {
                toasts.error(m.admin_toast_dismiss_failed());
            }
        } catch {
            toasts.error(m.admin_toast_dismiss_failed());
        } finally {
            dismissingItems.delete(itemId);
        }
    }

    /**
     * Bulk identify: the IdentifyModal handles one item at a time, so we queue
     * the selected unidentified items and open the modal for the first one. The
     * modal's onidentified / onclose handlers advance the queue (#18-wiring).
     * Reuses the existing per-item identify mechanism — no new backend endpoint.
     */
    function handleBulkIdentify(): void {
        // Guard: don't clobber an identify session that's already in flight (e.g. a
        // per-row Identify modal is open). Abandoning it would silently drop its queue.
        if (identifyItem !== null) return;
        // Only entertainment items can be identified (matches the per-row gate).
        const targets = selectedItems.filter(
            (it) => !it.tmdbId && !isNonEntertainment(it.mediaType),
        );
        if (targets.length === 0) return;
        const [first, ...rest] = targets;
        if (!first) return;
        bulkIdentifyQueue = rest.map((it) => it.id);
        identifyItem = {
            id: first.id,
            title: first.title,
            mediaType: first.mediaType,
        };
    }

    /** Advance the bulk-identify queue to the next pending item, if any. */
    function advanceIdentifyQueue(): void {
        // Iterative drain: after invalidateAll() the page may no longer contain some
        // queued IDs. Skip absent ones in a loop rather than recursing, so a large
        // bulk selection where every remaining item is gone can't overflow the stack.
        let queue = bulkIdentifyQueue;
        for (;;) {
            const [nextId, ...rest] = queue;
            if (!nextId) {
                bulkIdentifyQueue = [];
                identifyItem = null;
                return;
            }
            queue = rest;
            const next = data.items.find((it) => it.id === nextId);
            if (next) {
                bulkIdentifyQueue = rest;
                identifyItem = {
                    id: next.id,
                    title: next.title,
                    mediaType: next.mediaType,
                };
                return;
            }
            // Item no longer present (e.g. filtered out after invalidate) — skip.
        }
    }

    function toggleDismissed(): void {
        const url = new URL(window.location.href);
        if (data.showDismissed) {
            url.searchParams.delete('dismissed');
        } else {
            url.searchParams.set('dismissed', '1');
            // Turning "show dismissed" ON also lifts the availability filter.
            //
            // Dismissal and unavailability are separate filters, but the rows an
            // operator turns this toggle on to FIND fail both: the AudiobookShelf
            // sweep marks a book that vanished upstream `is_dismissed = true` AND
            // `has_files = false`, so with availability still filtered the list
            // comes back empty and reads as "there are no dismissed items" — while
            // hand-deleting such a row is the only sanctioned way to remove it.
            // Enabling dismissed is an explicit "show me what's hidden" intent, so
            // pairing them matches it; the availability toggle stays independently
            // switchable afterwards.
            url.searchParams.set('unavailable', '1');
        }
        // Back to page 1: the filtered row count changes, so the current offset
        // can land past the end of the new result set.
        url.searchParams.delete('page');
        goto(url.pathname + url.search);
    }

    // `includeChildren` defaults to false so the row's own Sync button keeps
    // its exact previous behaviour; only the inspector's separate "Sync With
    // Children" action passes true.
    async function syncItem(itemId: string, includeChildren = false): Promise<void> {
        syncingItems.add(itemId);
        try {
            const { error } = await syncMediaMetadata(itemId, includeChildren);
            if (!error) {
                toasts.success(m.admin_toast_sync_complete());
                reloadAfterMutation();
            } else {
                toasts.error(m.admin_toast_sync_failed());
            }
        } catch {
            toasts.error(m.admin_toast_sync_failed());
        } finally {
            syncingItems.delete(itemId);
        }
    }

    async function playMusicItem(item: {
        id: string;
        title: string;
        mediaType: string;
    }): Promise<void> {
        if (item.mediaType === 'track') {
            // Play the track directly
            void musicPlayerStore.startPlayback(
                musicTrackFromCard({
                    id: item.id,
                    title: item.title,
                    artists: [{ id: null, title: m.music_unknown_artist() }],
                }),
            );
            return;
        }
        // For albums/artists: fetch hierarchy and play the first track
        try {
            const { data: hierarchy, error: hierarchyError } = await getMusicHierarchy(item.id);
            if (hierarchyError || !hierarchy) {
                toasts.error(m.admin_toast_could_not_load_tracks());
                return;
            }
            const albums = hierarchy.albums ?? [];
            const allTracks = albums.flatMap((a) =>
                a.tracks.map((t) =>
                    musicTrackFromCard({
                        id: t.id,
                        title: t.title ?? m.admin_media_unknown_track(),
                        artists: [
                            {
                                id: hierarchy.artist?.id ?? null,
                                title: hierarchy.artist?.title ?? m.music_unknown_artist(),
                            },
                        ],
                        type: 'track' as const,
                        durationMs:
                            t.runtime_seconds == null ? null : Math.round(t.runtime_seconds * 1000),
                        album: { id: a.id, title: a.title },
                    }),
                ),
            );
            if (allTracks.length === 0) {
                toasts.warning(m.admin_toast_no_tracks_found());
                return;
            }
            // Shuffle for artists, play in order for albums
            const queue =
                item.mediaType === 'artist' ? allTracks.sort(() => Math.random() - 0.5) : allTracks;
            void musicPlayerStore.startPlayback(queue[0]);
            for (let i = 1; i < queue.length; i++) {
                musicPlayerStore.addToQueue(queue[i]);
            }
        } catch {
            toasts.error(m.admin_toast_failed_to_play());
        }
    }

    async function findDuplicates(): Promise<void> {
        duplicatesLoading = true;
        duplicatesError = '';
        showDuplicates = true;
        try {
            const { data: result, error } = await getMediaDuplicates();
            if (error || !result) {
                duplicatesError = m.admin_media_err_load_duplicates();
                toasts.error(m.admin_media_err_load_duplicates());
                return;
            }
            duplicates = result.duplicates;

            // Also load file-less duplicate pairs (invisible to the external_id
            // grouping above). Best-effort — don't fail the whole panel if this
            // sub-fetch errors.
            const { data: filelessResult } = await getFilelessDuplicatePairs();
            filelessPairs = filelessResult?.pairs ?? [];
            // Fall back to the loaded length when the endpoint omits `total` so the
            // "showing N of M" note never appears with a bogus total (#35).
            filelessTotal = filelessResult?.total ?? filelessPairs.length;

            // The results panel lives at the bottom of the page, far from the
            // button — give feedback at click position. Empty result (the
            // common case) gets a toast; an actual result scrolls into view.
            if (duplicates.length === 0 && filelessPairs.length === 0) {
                toasts.info(m.media_no_duplicates_found());
            } else {
                await tick();
                duplicatesPanelEl?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start',
                });
            }
        } catch (e) {
            console.warn('[AdminMedia] Failed to load duplicates', e);
            duplicatesError = m.admin_media_err_load_duplicates();
            toasts.error(m.admin_media_err_load_duplicates());
        } finally {
            duplicatesLoading = false;
        }
    }

    // Merge a file-less duplicate pair: keep the FILE row, fold the discovery
    // row (with its tmdb id) into it. Per-pair, operator-confirmed via the
    // ActionModal (replaces the blocking native confirm(), #33).
    function requestMergeFilelessPair(pair: FilelessDuplicatePair): void {
        if (mergingPairId) return;
        mergeConfirmPair = pair;
    }

    async function mergeFilelessPair(pair: FilelessDuplicatePair): Promise<void> {
        if (mergingPairId) return;
        mergingPairId = pair.fileId;
        try {
            const { data, error } = await mergeMediaItems(pair.fileId, pair.discoveryId);
            if (error || !data) {
                toasts.error(error || m.admin_media_merge_failed());
                return;
            }
            toasts.success(m.admin_media_merge_success({ title: pair.fileTitle }));
            filelessPairs = filelessPairs.filter((p) => p.fileId !== pair.fileId);
            filelessTotal = Math.max(filelessPairs.length, filelessTotal - 1);
        } catch (e) {
            console.warn('[AdminMedia] Merge failed', e);
            toasts.error(m.admin_media_merge_failed());
        } finally {
            mergingPairId = null;
        }
    }
</script>

<svelte:window onkeydown={handleGlobalKeydown} bind:innerWidth={viewportWidth} />

<!-- Header -->
<div>
    <AdminPageHeader
        icon={adminPageIcons['/admin/library/media']}
        title={m.route_admin_media_title()}
        description={data.query
            ? m.route_admin_media_description_filtered({
                  total: data.total.toLocaleString(),
                  query: data.query,
              })
            : m.route_admin_media_description({
                  total: data.total.toLocaleString(),
              })}>
        <div class="flex items-center gap-2">
            <!-- Explains the sidebar's Library nav dot: the open attention items
                 that light it (spec: a dot's destination page should explain
                 itself). In the header so its late arrival shifts nothing. -->
            <SectionAttentionStrip section="library" />
            <div class="relative">
                <button
                    bind:this={columnPickerTriggerEl}
                    class="p-2 rounded-lg transition-colors bg-surface-800/60 border border-surface-700 text-surface-400 hover:text-surface-200"
                    onclick={() => (showColumnPicker = !showColumnPicker)}
                    aria-label={m.admin_aria_toggle_column_visibility()}
                    aria-expanded={showColumnPicker}
                    aria-controls={showColumnPicker ? 'column-picker-dialog' : undefined}
                    title={m.route_admin_media_column_settings()}>
                    <Icon src={Cog6Tooth} class="w-4 h-4" />
                </button>
                {#if showColumnPicker}
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                    <div
                        class="fixed inset-0 z-10"
                        onclick={() => {
                            showColumnPicker = false;
                            columnPickerTriggerEl?.focus();
                        }}>
                    </div>
                    <div
                        bind:this={columnPickerDialogEl}
                        id="column-picker-dialog"
                        role="dialog"
                        aria-label={m.media_visible_columns()}
                        aria-modal="true"
                        tabindex="-1"
                        class="absolute z-20 top-full right-0 mt-2 w-56 bg-surface-800 border border-surface-700 rounded-lg shadow-xl p-3 space-y-1"
                        onkeydown={(e) => {
                            if (e.key === 'Escape') {
                                showColumnPicker = false;
                                columnPickerTriggerEl?.focus();
                            }
                            if (e.key === 'Tab') {
                                const focusable = (
                                    e.currentTarget as HTMLElement
                                ).querySelectorAll<HTMLElement>('button:not([disabled]), select');
                                const first = focusable[0];
                                const last = focusable[focusable.length - 1];
                                if (!first || !last) return;
                                if (e.shiftKey && document.activeElement === first) {
                                    e.preventDefault();
                                    last.focus();
                                } else if (!e.shiftKey && document.activeElement === last) {
                                    e.preventDefault();
                                    first.focus();
                                }
                            }
                        }}>
                        <h4 class="text-xs text-surface-500 uppercase tracking-wider mb-2 px-1">
                            {m.media_visible_columns()}
                        </h4>
                        <label class="inline-flex items-center gap-2 text-xs text-surface-400">
                            {m.media_page_size_label()}
                            <select
                                class="rounded-md border border-surface-700 bg-surface-800/60 px-2 py-1 text-xs text-surface-100"
                                value={data.pageSize}
                                onchange={(e) => setPageSize(Number(e.currentTarget.value))}>
                                {#each PAGE_SIZES as size (size)}
                                    <option value={size}>{size}</option>
                                {/each}
                            </select>
                        </label>
                        {#if showJumpBar}
                            <nav
                                class="flex flex-wrap items-center gap-0.5"
                                aria-label={m.media_jump_label()}>
                                {#each JUMP_LETTERS as letter (letter)}
                                    <button
                                        type="button"
                                        class="h-7 min-w-7 rounded px-1 text-xs font-medium text-surface-400 hover:bg-surface-700/60 hover:text-surface-100"
                                        onclick={() => jumpToLetter(letter)}>{letter}</button>
                                {/each}
                            </nav>
                        {/if}
                        {#each pickableColumns as col (col.key)}
                            <button
                                class="flex items-center gap-2 w-full px-2 py-1.5 rounded text-sm transition-colors {visibleColumns.has(
                                    col.key,
                                )
                                    ? 'text-surface-200'
                                    : 'text-surface-500 hover:text-surface-300 hover:bg-surface-700/50'}"
                                aria-pressed={visibleColumns.has(col.key)}
                                onclick={() => toggleColumn(col.key)}>
                                <span
                                    class="inline-block w-3.5 h-3.5 rounded border {visibleColumns.has(
                                        col.key,
                                    )
                                        ? 'bg-yellow-500 border-yellow-500'
                                        : 'border-surface-600'}">
                                    {#if visibleColumns.has(col.key)}
                                        <svg
                                            class="w-3.5 h-3.5 text-surface-900"
                                            viewBox="0 0 14 14"
                                            ><path
                                                fill="currentColor"
                                                d="M11.7 3.3a1 1 0 0 1 0 1.4l-5 5a1 1 0 0 1-1.4 0l-2-2a1 1 0 0 1 1.4-1.4L6 7.6l4.3-4.3a1 1 0 0 1 1.4 0Z" /></svg>
                                    {/if}
                                </span>
                                {col.label}
                            </button>
                        {/each}
                    </div>
                {/if}
            </div>
        </div>
    </AdminPageHeader>
</div>

{#if filtersRestored}
    <div
        role="status"
        class="mb-4 flex items-center gap-3 rounded-lg border border-surface-700 bg-surface-800/60 px-3 py-2 text-xs text-surface-300">
        <span class="flex-1">{m.admin_media_filters_restored()}</span>
        <button
            type="button"
            class="font-medium text-primary-400 underline hover:text-primary-300"
            onclick={() => {
                filtersRestored = false;
                // NOT clearAllFilters(): that clears advanced filters, dates
                // and the library scope but leaves domain/type/sort — precisely
                // the params the restore reapplied — so the restored view would
                // survive its own reset button and be immediately re-persisted.
                // Go to a genuinely bare URL instead, and clear the stored blob
                // so the next bare navigation does not restore it right back.
                try {
                    if (browser) localStorage.removeItem(FILTERS_STORAGE_KEY);
                } catch {
                    /* storage unavailable — the goto below still resets the view */
                }
                void goto(resolve('/admin/library/media'), {
                    replaceState: true,
                    noScroll: true,
                });
            }}>
            {m.admin_media_filters_restored_reset()}
        </button>
    </div>
{/if}

<!-- Domain Tabs (#0) -->
<div
    bind:this={tablistEl}
    class="flex items-center gap-1 border-b border-surface-700 mb-4"
    role="tablist"
    aria-label={m.route_admin_media_title()}>
    {#each domainTabs as d (d.value)}
        {@const isSelected = data.domain === d.value}
        <button
            role="tab"
            data-domain-tab={d.value}
            aria-selected={isSelected}
            aria-controls="domain-tabpanel"
            tabindex={isSelected ? 0 : -1}
            class="flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px
                {isSelected
                ? 'border-yellow-500 text-yellow-400'
                : 'border-transparent text-surface-400 hover:text-surface-200 hover:border-surface-600'}"
            onclick={() => setDomain(d.value)}
            onkeydown={(e) => {
                const tabs = [...domainTabs];
                const idx = tabs.findIndex((t) => t.value === d.value);
                if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    const next = tabs[(idx + 1) % tabs.length];
                    if (next) void selectDomainTabByKeyboard(next.value);
                } else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
                    if (prev) void selectDomainTabByKeyboard(prev.value);
                }
            }}>
            <Icon src={d.icon} class="w-4 h-4" />
            {d.label}
        </button>
    {/each}
</div>

<div id="domain-tabpanel" role="tabpanel">
    {#if data.view === 'unidentified'}
        <div
            class="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-surface-700 bg-surface-800/60 px-3 py-2 text-xs text-surface-300">
            <span class="flex-1">{m.media_view_unidentified_banner()}</span>
            <a
                class="font-medium text-yellow-300 hover:text-yellow-200"
                href={resolve(
                    data.libraryGroupId
                        ? `/admin/library/fix-matches?library=${data.libraryGroupId}`
                        : '/admin/library/fix-matches',
                )}>{m.media_view_unidentified_banner_link()}</a>
        </div>
    {:else if data.view === 'duplicates'}
        <div
            class="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-surface-700 bg-surface-800/60 px-3 py-2 text-xs text-surface-300">
            <span class="flex-1">{m.media_view_duplicates_banner()}</span>
            <button
                type="button"
                class="font-medium text-yellow-300 hover:text-yellow-200"
                onclick={findDuplicates}>{m.media_view_duplicates_banner_link()}</button>
        </div>
    {/if}
    <!-- Search & Type Filters -->
    <div class="flex flex-wrap items-center gap-3 mb-4">
        <div class="relative flex-1 min-w-[200px] max-w-md">
            <Icon src={MagnifyingGlass} class="w-4 h-4 text-surface-500 absolute left-3 top-2.5" />
            <input
                bind:this={searchInputEl}
                type="text"
                placeholder={m.admin_placeholder_search_by_title()}
                aria-label={m.admin_placeholder_search_by_title()}
                class="w-full bg-surface-800/60 border border-surface-700 rounded-lg pl-9 pr-3 py-2 text-sm text-surface-100 focus:border-yellow-500 focus:outline-none"
                bind:value={searchInput}
                oninput={handleSearch} />
        </div>
        <div
            class="inline-flex rounded-md border border-surface-700 p-0.5"
            role="group"
            aria-label={m.media_layout_label()}>
            {#each [{ id: 'list', label: m.media_layout_list(), icon: ListBullet }, { id: 'grid', label: m.media_layout_grid(), icon: Squares2x2 }] as opt (opt.id)}
                <button
                    type="button"
                    class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs {data.layout ===
                    opt.id
                        ? 'bg-surface-700 text-surface-100'
                        : 'text-surface-400 hover:text-surface-200'}"
                    aria-pressed={data.layout === opt.id}
                    onclick={() => setLayout(opt.id as BrowserLayout)}>
                    <Icon src={opt.icon} class="h-3.5 w-3.5" />
                    {opt.label}
                </button>
            {/each}
        </div>

        <label class="inline-flex items-center gap-2 text-xs text-surface-300">
            {m.media_redesign_search_scope()}
            <select
                aria-label={m.media_redesign_search_scope()}
                class="rounded-lg border border-surface-700 bg-surface-800 px-2 py-2 text-sm"
                value={data.searchScope}
                onchange={(event) => {
                    clearSearchTimeout();
                    const target = new URL(page.url);
                    target.searchParams.set('scope', event.currentTarget.value);
                    if (searchInput.trim()) target.searchParams.set('q', searchInput.trim());
                    else target.searchParams.delete('q');
                    target.searchParams.delete('page');
                    void goto(target.pathname + target.search, { keepFocus: true });
                }}>
                <option value="title">{m.media_redesign_title_only()}</option>
                <option value="metadata">{m.media_redesign_metadata_search()}</option>
            </select>
        </label>
        <div class="relative">
            <button
                class="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg transition-colors {activeFilterCount >
                0
                    ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/40'
                    : 'bg-surface-800/60 text-surface-400 border border-surface-700 hover:text-surface-200'}"
                onclick={() => (showFilterPanel = !showFilterPanel)}
                aria-expanded={showFilterPanel}
                aria-label={activeFilterCount > 0
                    ? m.admin_media_filters_active({ count: activeFilterCount })
                    : m.admin_media_filters()}>
                <Icon src={Funnel} class="w-4 h-4" />
                {m.admin_media_filters()}
                {#if activeFilterCount > 0}
                    <span
                        class="inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-bold bg-yellow-500 text-surface-900">
                        {activeFilterCount}
                    </span>
                {/if}
            </button>
            <!-- Filter dropdown panel -->
            {#if showFilterPanel}
                <!-- Backdrop to close panel on outside click -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div class="fixed inset-0 z-10" onclick={() => (showFilterPanel = false)}></div>
                <div
                    class="absolute z-20 top-full left-0 mt-2 w-80 bg-surface-800 border border-surface-700 rounded-lg shadow-xl p-4 space-y-4"
                    role="dialog"
                    aria-modal="true"
                    tabindex="-1"
                    aria-label={m.admin_aria_filter_options()}
                    onkeydown={(e) => {
                        if (e.key === 'Escape') showFilterPanel = false;
                    }}>
                    <!-- Include (moved here from the toolbar toggles) -->
                    <div>
                        <h4 class="text-xs text-surface-500 uppercase tracking-wider mb-2">
                            {m.media_filter_section_include()}
                        </h4>
                        <div class="space-y-1.5">
                            {#if !isUnidentifiedDomain}
                                <button
                                    role="switch"
                                    aria-checked={data.showUnavailable}
                                    class="flex items-center gap-2 w-full px-2 py-1.5 rounded text-sm transition-colors {data.showUnavailable
                                        ? 'bg-yellow-500/20 text-yellow-400'
                                        : 'text-surface-300 hover:bg-surface-700/50'}"
                                    onclick={toggleUnavailable}>
                                    <span
                                        class="inline-block w-3.5 h-3.5 rounded border {data.showUnavailable
                                            ? 'bg-yellow-500 border-yellow-500'
                                            : 'border-surface-600'}"></span>
                                    {m.media_filter_show_unavailable()}
                                </button>
                            {/if}
                            <button
                                role="switch"
                                aria-checked={data.showDismissed}
                                class="flex items-center gap-2 w-full px-2 py-1.5 rounded text-sm transition-colors {data.showDismissed
                                    ? 'bg-yellow-500/20 text-yellow-400'
                                    : 'text-surface-300 hover:bg-surface-700/50'}"
                                onclick={toggleDismissed}>
                                <span
                                    class="inline-block w-3.5 h-3.5 rounded border {data.showDismissed
                                        ? 'bg-yellow-500 border-yellow-500'
                                        : 'border-surface-600'}"></span>
                                {m.media_filter_show_dismissed()}
                            </button>
                        </div>
                    </div>
                    <!-- Data Quality -->
                    <div>
                        <h4 class="text-xs text-surface-500 uppercase tracking-wider mb-2">
                            {m.media_label_data_quality()}
                        </h4>
                        <div class="space-y-1.5">
                            {#each dataQualityFilters as f (f.key)}
                                <button
                                    class="flex items-center gap-2 w-full px-2 py-1.5 rounded text-sm transition-colors {data
                                        .activeFilters[f.key as FilterParam]
                                        ? 'bg-yellow-500/20 text-yellow-400'
                                        : 'text-surface-300 hover:bg-surface-700/50'}"
                                    onclick={() => toggleBoolFilter(f.key as FilterParam)}>
                                    <span
                                        class="inline-block w-3.5 h-3.5 rounded border {data
                                            .activeFilters[f.key as FilterParam]
                                            ? 'bg-yellow-500 border-yellow-500'
                                            : 'border-surface-600'}">
                                        {#if data.activeFilters[f.key as FilterParam]}
                                            <svg
                                                class="w-3.5 h-3.5 text-surface-900"
                                                viewBox="0 0 14 14"
                                                ><path
                                                    fill="currentColor"
                                                    d="M11.7 3.3a1 1 0 0 1 0 1.4l-5 5a1 1 0 0 1-1.4 0l-2-2a1 1 0 0 1 1.4-1.4L6 7.6l4.3-4.3a1 1 0 0 1 1.4 0Z" /></svg>
                                        {/if}
                                    </span>
                                    {f.label}
                                </button>
                            {/each}
                            <!-- "Has file issues" (admin IA redesign, spec §3.2) — replaces
                                     the removed File Health / Integrity tabs; deep-link target
                                     `?filter=file-issues` from System → Health's findings. -->
                            <button
                                class="flex items-center gap-2 w-full px-2 py-1.5 rounded text-sm transition-colors {data
                                    .activeFilters.file_issues
                                    ? 'bg-yellow-500/20 text-yellow-400'
                                    : 'text-surface-300 hover:bg-surface-700/50'}"
                                onclick={toggleFileIssuesFilter}>
                                <span
                                    class="inline-block w-3.5 h-3.5 rounded border {data
                                        .activeFilters.file_issues
                                        ? 'bg-yellow-500 border-yellow-500'
                                        : 'border-surface-600'}">
                                    {#if data.activeFilters.file_issues}
                                        <svg
                                            class="w-3.5 h-3.5 text-surface-900"
                                            viewBox="0 0 14 14"
                                            ><path
                                                fill="currentColor"
                                                d="M11.7 3.3a1 1 0 0 1 0 1.4l-5 5a1 1 0 0 1-1.4 0l-2-2a1 1 0 0 1 1.4-1.4L6 7.6l4.3-4.3a1 1 0 0 1 1.4 0Z" /></svg>
                                    {/if}
                                </span>
                                {m.admin_media_chip_file_issues()}
                            </button>
                        </div>
                    </div>
                    <!-- Metadata -->
                    <div>
                        <h4 class="text-xs text-surface-500 uppercase tracking-wider mb-2">
                            {m.admin_media_section_metadata()}
                        </h4>
                        <div class="space-y-1.5">
                            {#each metadataFilters as f (f.key)}
                                <button
                                    class="flex items-center gap-2 w-full px-2 py-1.5 rounded text-sm transition-colors {data
                                        .activeFilters[f.key as FilterParam]
                                        ? 'bg-yellow-500/20 text-yellow-400'
                                        : 'text-surface-300 hover:bg-surface-700/50'}"
                                    onclick={() => toggleBoolFilter(f.key as FilterParam)}>
                                    <span
                                        class="inline-block w-3.5 h-3.5 rounded border {data
                                            .activeFilters[f.key as FilterParam]
                                            ? 'bg-yellow-500 border-yellow-500'
                                            : 'border-surface-600'}">
                                        {#if data.activeFilters[f.key as FilterParam]}
                                            <svg
                                                class="w-3.5 h-3.5 text-surface-900"
                                                viewBox="0 0 14 14"
                                                ><path
                                                    fill="currentColor"
                                                    d="M11.7 3.3a1 1 0 0 1 0 1.4l-5 5a1 1 0 0 1-1.4 0l-2-2a1 1 0 0 1 1.4-1.4L6 7.6l4.3-4.3a1 1 0 0 1 1.4 0Z" /></svg>
                                        {/if}
                                    </span>
                                    {f.label}
                                </button>
                            {/each}
                        </div>
                    </div>
                    <!-- Date Range -->
                    <div>
                        <h4 class="text-xs text-surface-500 uppercase tracking-wider mb-2">
                            {m.media_filter_added_since()}
                        </h4>
                        <div class="flex flex-wrap gap-1">
                            {#each ['24h', '7d', '30d'] as preset (preset)}
                                <button
                                    class="px-2 py-1 text-xs rounded transition-colors {data
                                        .activeFilters.added_since === preset
                                        ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/40'
                                        : 'bg-surface-700/50 text-surface-400 border border-surface-600 hover:text-surface-200'}"
                                    onclick={() =>
                                        setDateFilter(
                                            'added_since',
                                            data.activeFilters.added_since === preset ? '' : preset,
                                        )}>
                                    {datePresetLabels[preset]}
                                </button>
                            {/each}
                        </div>
                    </div>
                    <div>
                        <h4 class="text-xs text-surface-500 uppercase tracking-wider mb-2">
                            {m.media_filter_updated_since()}
                        </h4>
                        <div class="flex flex-wrap gap-1">
                            {#each ['24h', '7d', '30d'] as preset (preset)}
                                <button
                                    class="px-2 py-1 text-xs rounded transition-colors {data
                                        .activeFilters.updated_since === preset
                                        ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/40'
                                        : 'bg-surface-700/50 text-surface-400 border border-surface-600 hover:text-surface-200'}"
                                    onclick={() =>
                                        setDateFilter(
                                            'updated_since',
                                            data.activeFilters.updated_since === preset
                                                ? ''
                                                : preset,
                                        )}>
                                    {datePresetLabels[preset]}
                                </button>
                            {/each}
                        </div>
                    </div>
                    <!-- Clear all -->
                    {#if activeFilterCount > 0}
                        <button
                            class="w-full px-3 py-1.5 text-xs font-medium rounded-lg text-red-400 border border-red-500/30 hover:bg-red-500/10 transition-colors"
                            onclick={clearAllFilters}>
                            {m.media_filter_clear_all_filters()}
                        </button>
                    {/if}
                </div>
            {/if}
        </div>
        <!-- Scope pickers (triage spec §1): type and library as two selects
             instead of two rows of chips. Episodes/seasons sit under a divider;
             series drill-down is the usual way into them. -->
        {#if activeTypeFilters.length > 1}
            <label class="inline-flex items-center gap-2 text-xs text-surface-400">
                <span class="sr-only">{m.media_picker_type()}</span>
                <select
                    class="rounded-lg border border-surface-700 bg-surface-800/60 px-3 py-2 text-sm text-surface-100 focus:border-yellow-500 focus:outline-none"
                    value={data.typeFilter}
                    onchange={(e) => setTypeFilter(e.currentTarget.value)}>
                    {#each primaryTypeFilters as filter (filter.value)}
                        <option value={filter.value}>{filter.label}</option>
                    {/each}
                    {#if individualTypeFilters.length > 0}
                        <optgroup label={m.media_picker_individual()}>
                            {#each individualTypeFilters as filter (filter.value)}
                                <option value={filter.value}>{filter.label}</option>
                            {/each}
                        </optgroup>
                    {/if}
                </select>
            </label>
        {/if}
        {#if filteredLibraries.length > 0}
            <label class="inline-flex items-center gap-2 text-xs text-surface-400">
                <span class="sr-only">{m.media_picker_library()}</span>
                <select
                    class="rounded-lg border border-surface-700 bg-surface-800/60 px-3 py-2 text-sm text-surface-100 focus:border-yellow-500 focus:outline-none"
                    value={data.libraryGroupId}
                    onchange={(e) => setLibraryFilter(e.currentTarget.value)}>
                    <option value="">{m.media_picker_all_libraries()}</option>
                    {#each filteredLibraries as group (group.id)}
                        <option value={group.id}>{group.label}</option>
                    {/each}
                </select>
            </label>
        {/if}
    </div>

    <!-- Active Filter Chips -->
    {#if activeFilterChips.length > 0}
        <div class="flex items-center gap-2 mb-3 flex-wrap">
            <span class="text-xs text-surface-500 uppercase tracking-wider shrink-0"
                >{m.media_label_active_colon()}</span>
            {#each activeFilterChips as chip (chip.param)}
                <button
                    data-testid="active-filter-chip"
                    class="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-lg bg-yellow-500/15 text-yellow-400 border border-yellow-500/30 hover:bg-yellow-500/25 transition-colors"
                    onclick={() => removeFilterChip(chip.param)}>
                    {chip.label}
                    <Icon src={XMark} class="w-3 h-3" />
                </button>
            {/each}
            <button
                class="text-xs text-surface-500 hover:text-surface-300 transition-colors"
                onclick={clearAllFilters}>
                {m.media_filter_clear_all()}
            </button>
        </div>
    {/if}

    {#if data.domain === 'music' && !isSingleActQueue}
        <a
            class="mb-3 inline-block text-sm text-primary-300 underline"
            href={resolve(
                '/admin/library/media?domain=music&type=artist&filter=music-artist-unsplit',
            )}>{m.music_optional_cleanup()}</a>
    {/if}
    {#if isSingleActQueue}
        <p class="mb-3 text-sm text-surface-400">
            {m.admin_media_single_act_heuristic_note()}
        </p>
        <p class="mb-3 text-sm text-surface-400">
            {m.music_credits_collaboration_help()}
        </p>
        {#if singleActFeedbackEntries.length > 0}
            <div
                class="mb-4 space-y-2"
                role="region"
                aria-label={m.admin_media_single_act_feedback_label()}>
                {#each singleActFeedbackEntries as [artistId, feedback] (artistId)}
                    <div
                        class="flex flex-wrap items-center gap-2 rounded-lg border border-surface-700 bg-surface-800/60 px-3 py-2 text-sm"
                        data-testid={`single-act-feedback-${artistId}`}
                        role="status">
                        {#if feedback.status === 'marked'}
                            <span class="text-green-300"
                                >{m.admin_media_single_act_marked({ title: feedback.title })}</span>
                            <button
                                type="button"
                                class="rounded border border-surface-600 px-2 py-1 text-surface-100 hover:bg-surface-700 disabled:opacity-50"
                                disabled={singleActPending.has(artistId)}
                                aria-label={m.admin_media_single_act_undo_for({
                                    title: feedback.title,
                                })}
                                onclick={() =>
                                    void changeSingleAct(artistId, feedback.title, false)}>
                                {m.admin_media_single_act_undo()}
                            </button>
                        {:else if feedback.status === 'review'}
                            <span class="text-green-300"
                                >{m.admin_media_single_act_returned({
                                    title: feedback.title,
                                })}</span>
                        {:else if feedback.status === 'mark-error'}
                            <span class="text-red-300"
                                >{m.admin_media_single_act_mark_failed({
                                    title: feedback.title,
                                })}</span>
                            <button
                                type="button"
                                class="rounded border border-surface-600 px-2 py-1 text-surface-100 hover:bg-surface-700 disabled:opacity-50"
                                disabled={singleActPending.has(artistId)}
                                onclick={() =>
                                    void changeSingleAct(artistId, feedback.title, true)}>
                                {m.admin_media_single_act_retry_mark()}
                            </button>
                        {:else}
                            <span class="text-red-300"
                                >{m.admin_media_single_act_undo_failed({
                                    title: feedback.title,
                                })}</span>
                            <button
                                type="button"
                                class="rounded border border-surface-600 px-2 py-1 text-surface-100 hover:bg-surface-700 disabled:opacity-50"
                                disabled={singleActPending.has(artistId)}
                                onclick={() =>
                                    void changeSingleAct(artistId, feedback.title, false)}>
                                {m.admin_media_single_act_retry_undo()}
                            </button>
                        {/if}
                        {#if feedback.refreshFailed}
                            <span class="text-amber-300"
                                >{m.admin_media_single_act_refresh_failed()}</span>
                            <button
                                type="button"
                                class="rounded border border-surface-600 px-2 py-1 text-surface-100 hover:bg-surface-700 disabled:opacity-50"
                                disabled={singleActPending.has(artistId)}
                                onclick={() => void retrySingleActRefresh(artistId)}>
                                {m.admin_media_single_act_retry_refresh()}
                            </button>
                        {/if}
                    </div>
                {/each}
            </div>
        {/if}
    {/if}

    <MediaViewsBar
        views={data.availableViews}
        counts={data.viewCounts}
        current={data.view}
        onselect={setView} />
    <!-- Table + docked inspector. The inspector is a flex SIBLING of the table
         (task 4's docked presentation); below the docked breakpoint the same
         component renders as a fixed drawer and ignores this layout. -->
    <div class="flex items-start gap-4">
        {#if data.layout === 'grid'}
            <!-- Poster grid (triage spec §6): same rows and URL as the table.
                 Poster = inspector, title = detail page, like the list. -->
            <div class="min-w-0 flex-1">
                {#if data.items.length > 0}
                    <ul
                        class="grid gap-4 grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))]"
                        data-testid="media-grid">
                        {#each data.items as item, i (`${item.id ?? 'null'}__${i}`)}
                            {@const cardProblems = problemIssues(item.issues)}
                            {@const worst = cardProblems[0]}
                            <li
                                class="group relative overflow-hidden rounded-lg border bg-surface-800/40 {inspectorItemId ===
                                item.id
                                    ? 'border-yellow-500'
                                    : selectedRows.has(item.id)
                                      ? 'border-yellow-500/60'
                                      : 'border-surface-700'}">
                                <!-- Bulk selection, same selection set and shift-range as
                                     the list's row checkbox, so the bulk bar works in both
                                     layouts. Revealed on hover like the list's; always
                                     shown once selected or on a device without hover. -->
                                <button
                                    type="button"
                                    class="absolute left-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded border transition-opacity {selectedRows.has(
                                        item.id,
                                    )
                                        ? 'border-yellow-500 bg-yellow-500 opacity-100'
                                        : 'border-surface-300 bg-surface-900/70 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'}"
                                    aria-pressed={selectedRows.has(item.id)}
                                    aria-label={selectedRows.has(item.id)
                                        ? m.admin_aria_deselect_row()
                                        : m.admin_aria_select_row()}
                                    onclick={(e) => toggleSelectItem(i, e.shiftKey)}>
                                    {#if selectedRows.has(item.id)}
                                        <svg class="h-4 w-4 text-surface-900" viewBox="0 0 14 14"
                                            ><path
                                                fill="currentColor"
                                                d="M11.7 3.3a1 1 0 0 1 0 1.4l-5 5a1 1 0 0 1-1.4 0l-2-2a1 1 0 0 1 1.4-1.4L6 7.6l4.3-4.3a1 1 0 0 1 1.4 0Z" /></svg>
                                    {/if}
                                </button>
                                <button
                                    type="button"
                                    class="relative block aspect-[2/3] w-full bg-surface-800"
                                    aria-label={m.media_grid_quick_look({ title: item.title })}
                                    onclick={() => selectRowIntoInspector(i)}>
                                    {#if failedImages.has(item.id)}
                                        <span class="flex h-full items-center justify-center">
                                            <Icon
                                                src={isMovie(item.mediaType) ? Film : Tv}
                                                class="h-8 w-8 text-surface-600" />
                                        </span>
                                    {:else}
                                        <img
                                            src={posterUrl(item.id)}
                                            alt=""
                                            loading="lazy"
                                            class="h-full w-full object-cover"
                                            onerror={() => failedImages.add(item.id)} />
                                    {/if}
                                    {#if worst}
                                        <span
                                            class="absolute right-1.5 top-1.5 inline-flex h-6 items-center rounded-full border px-2 text-[11px] font-semibold {severityBadgeClass(
                                                worst.severity,
                                            )}"
                                            title={cardProblems
                                                .map((iss) => mediaIssueLabel(iss, item.mediaType))
                                                .join(', ')}>{cardProblems.length}</span>
                                    {/if}
                                </button>
                                <div class="p-2">
                                    <a
                                        href={resolve(`/admin/library/media/${item.id}`)}
                                        data-sveltekit-preload-data="hover"
                                        class="block truncate text-sm font-medium text-surface-100 hover:text-primary-300 hover:underline">
                                        {item.title}
                                    </a>
                                    <div class="truncate text-xs text-surface-400">
                                        {item.year ?? '—'} · {getMediaTypeBadge(item.mediaType)
                                            .label}
                                    </div>
                                    {#if isSingleActQueue && item.mediaType === 'artist'}
                                        {@const feedback = singleActFeedback.get(item.id)}
                                        <a
                                            class="mt-2 block w-full rounded border border-primary-500/40 px-2 py-1.5 text-center text-xs text-primary-200 hover:bg-primary-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400"
                                            href={resolve(
                                                `/admin/library/media/${item.id}?tab=tracks`,
                                            )}
                                            onclick={(e) => e.stopPropagation()}>
                                            {m.music_credits_open_tracks()}
                                        </a>
                                        <button
                                            type="button"
                                            class="mt-2 w-full rounded border border-primary-500 px-2 py-1.5 text-xs text-primary-200 hover:bg-primary-500/10"
                                            onclick={(event) => {
                                                event.stopPropagation();
                                                collaborationArtistId = item.id;
                                            }}>
                                            {m.collaboration_resolve()}
                                        </button>
                                        <button
                                            type="button"
                                            class="mt-2 w-full rounded border border-surface-600 px-2 py-1.5 text-xs text-surface-100 hover:bg-surface-700 disabled:opacity-50"
                                            disabled={singleActPending.has(item.id)}
                                            aria-label={feedback?.status === 'marked' ||
                                            feedback?.status === 'undo-error'
                                                ? m.admin_media_single_act_undo_for({
                                                      title: item.title,
                                                  })
                                                : m.admin_media_single_act_mark_for({
                                                      title: item.title,
                                                  })}
                                            onclick={(e) => {
                                                e.stopPropagation();
                                                void changeSingleAct(
                                                    item.id,
                                                    item.title,
                                                    feedback?.status === 'marked' ||
                                                        feedback?.status === 'undo-error'
                                                        ? false
                                                        : true,
                                                );
                                            }}>
                                            {feedback?.status === 'marked' ||
                                            feedback?.status === 'undo-error'
                                                ? m.admin_media_single_act_undo()
                                                : m.admin_media_single_act_mark()}
                                        </button>
                                    {/if}
                                    {#if !isSingleActQueue && item.mediaType === 'artist' && canResolveCollaboration(item.title)}
                                        <button
                                            type="button"
                                            class="mt-2 w-full rounded border border-primary-500 px-2 py-1.5 text-xs text-primary-200 hover:bg-primary-500/10"
                                            onclick={(event) => {
                                                event.stopPropagation();
                                                collaborationArtistId = item.id;
                                            }}>
                                            {m.collaboration_resolve()}
                                        </button>
                                    {/if}
                                </div>
                            </li>
                        {/each}
                    </ul>
                {:else}
                    <div
                        class="rounded-lg border border-surface-700 px-4 py-12 text-center text-surface-500">
                        {#if data.query}
                            {m.admin_media_empty_matching({ query: data.query })}
                        {:else if data.view !== 'all' && data.view !== 'recent'}
                            <div class="font-medium text-surface-200">
                                {m.media_view_empty_title()}
                            </div>
                            <div class="mt-1 text-xs">{m.media_view_empty_text()}</div>
                        {:else}
                            {m.admin_media_empty_no_items()}
                        {/if}
                    </div>
                {/if}
            </div>
        {:else}
            <div class="min-w-0 flex-1 overflow-x-auto rounded-lg border border-surface-700">
                <table class="w-full text-sm">
                    <thead>
                        <tr class="border-b border-surface-700 bg-surface-800/50">
                            <th class="px-3 py-3 w-10">
                                <button
                                    class="inline-block w-4 h-4 rounded border transition-colors {allOnPageSelected
                                        ? 'bg-yellow-500 border-yellow-500'
                                        : 'border-surface-500 hover:border-surface-300'}"
                                    onclick={toggleSelectAll}
                                    aria-label={allOnPageSelected
                                        ? m.admin_livetv_deselect_all()
                                        : m.route_admin_library_select_all_page()}
                                    title={allOnPageSelected
                                        ? m.admin_livetv_deselect_all()
                                        : m.route_admin_library_select_all_page()}>
                                    {#if allOnPageSelected}
                                        <svg class="w-4 h-4 text-surface-900" viewBox="0 0 14 14"
                                            ><path
                                                fill="currentColor"
                                                d="M11.7 3.3a1 1 0 0 1 0 1.4l-5 5a1 1 0 0 1-1.4 0l-2-2a1 1 0 0 1 1.4-1.4L6 7.6l4.3-4.3a1 1 0 0 1 1.4 0Z" /></svg>
                                    {/if}
                                </button>
                            </th>
                            <th class="px-2 py-3 text-left text-surface-400 font-medium w-16"></th>
                            <th class="px-2 py-3 text-left text-surface-400 font-medium">
                                <button
                                    class="inline-flex items-center gap-1 cursor-pointer hover:text-surface-200 transition-colors {data.sort ===
                                    'title'
                                        ? 'text-yellow-400'
                                        : ''}"
                                    onclick={() => goto(sortUrl('title'))}>
                                    {m.media_col_title()}
                                    {#if data.sort === 'title'}
                                        <Icon
                                            src={data.order === 'desc' ? ChevronDown : ChevronUp}
                                            class="w-3.5 h-3.5" />
                                    {/if}
                                </button>
                            </th>
                            {#if isColVisible('type')}
                                <th class="px-2 py-3 text-left text-surface-400 font-medium w-24"
                                    >{m.media_col_type()}</th>
                            {/if}
                            <!-- The ancestry headers are the only `sort=hierarchy` / `sort=artist`
                         entry points; without them the named sorts were reachable as a
                         per-type default and never again. Chevron is always Up: these
                         are ascending groupings with no direction toggle (see sortUrl). -->
                            {#if isColVisible('ancestryParent')}
                                <th class="px-2 py-3 text-left text-surface-400 font-medium">
                                    {#if ancestrySortKey}
                                        <button
                                            class="inline-flex items-center gap-1 cursor-pointer hover:text-surface-200 transition-colors {data.sort ===
                                            ancestrySortKey
                                                ? 'text-yellow-400'
                                                : ''}"
                                            onclick={() => goto(ancestrySortUrl())}>
                                            {ancestryPlan.parent
                                                ? ancestryLabel(ancestryPlan.parent)
                                                : ''}
                                            {#if data.sort === ancestrySortKey}
                                                <Icon src={ChevronUp} class="w-3.5 h-3.5" />
                                            {/if}
                                        </button>
                                    {:else}
                                        {ancestryPlan.parent
                                            ? ancestryLabel(ancestryPlan.parent)
                                            : ''}
                                    {/if}
                                </th>
                            {/if}
                            {#if isColVisible('ancestryRoot')}
                                <th class="px-2 py-3 text-left text-surface-400 font-medium">
                                    {#if ancestrySortKey}
                                        <button
                                            class="inline-flex items-center gap-1 cursor-pointer hover:text-surface-200 transition-colors {data.sort ===
                                            ancestrySortKey
                                                ? 'text-yellow-400'
                                                : ''}"
                                            onclick={() => goto(ancestrySortUrl())}>
                                            {ancestryPlan.root
                                                ? ancestryLabel(ancestryPlan.root)
                                                : ''}
                                            {#if data.sort === ancestrySortKey}
                                                <Icon src={ChevronUp} class="w-3.5 h-3.5" />
                                            {/if}
                                        </button>
                                    {:else}
                                        {ancestryPlan.root ? ancestryLabel(ancestryPlan.root) : ''}
                                    {/if}
                                </th>
                            {/if}
                            {#if isColVisible('author')}
                                <th
                                    class="px-2 py-3 text-left text-surface-400 font-medium w-40 hidden md:table-cell"
                                    >{m.media_col_author()}</th>
                            {/if}
                            {#if isColVisible('narrator')}
                                <th
                                    class="px-2 py-3 text-left text-surface-400 font-medium w-40 hidden lg:table-cell"
                                    >{m.media_col_narrator()}</th>
                            {/if}
                            {#if isColVisible('series')}
                                <th
                                    class="px-2 py-3 text-left text-surface-400 font-medium w-48 hidden md:table-cell"
                                    >{m.media_col_series()}</th>
                            {/if}
                            {#if isColVisible('year')}
                                <th class="px-2 py-3 text-left text-surface-400 font-medium w-16">
                                    <button
                                        class="inline-flex items-center gap-1 cursor-pointer hover:text-surface-200 transition-colors {data.sort ===
                                        'year'
                                            ? 'text-yellow-400'
                                            : ''}"
                                        onclick={() => goto(sortUrl('year'))}>
                                        {m.media_col_year()}
                                        {#if data.sort === 'year'}
                                            <Icon
                                                src={data.order === 'desc'
                                                    ? ChevronDown
                                                    : ChevronUp}
                                                class="w-3.5 h-3.5" />
                                        {/if}
                                    </button>
                                </th>
                            {/if}
                            {#if isColVisible('children')}
                                <th
                                    class="px-2 py-3 text-left text-surface-400 font-medium w-24 hidden md:table-cell"
                                    >{childrenColumnLabel(data.typeFilter)}</th>
                            {/if}
                            {#if isColVisible('tmdb')}
                                <th
                                    class="px-2 py-3 text-left text-surface-400 font-medium w-24 hidden lg:table-cell"
                                    >{m.media_col_tmdb_short()}</th>
                            {/if}
                            {#if isColVisible('status')}
                                <th
                                    class="px-2 py-3 text-left text-surface-400 font-medium min-w-[14rem] hidden lg:table-cell"
                                    >{m.media_col_issues()}</th>
                            {/if}
                            {#if isColVisible('dateAdded')}
                                <th class="px-2 py-3 text-left text-surface-400 font-medium w-28">
                                    <button
                                        class="inline-flex items-center gap-1 cursor-pointer hover:text-surface-200 transition-colors {data.sort ===
                                        'created_at'
                                            ? 'text-yellow-400'
                                            : ''}"
                                        onclick={() => goto(sortUrl('created_at'))}>
                                        {m.media_col_added_short()}
                                        {#if data.sort === 'created_at'}
                                            <Icon
                                                src={data.order === 'desc'
                                                    ? ChevronDown
                                                    : ChevronUp}
                                                class="w-3.5 h-3.5" />
                                        {/if}
                                    </button>
                                </th>
                            {/if}
                            {#if isColVisible('dateUpdated')}
                                <th class="px-2 py-3 text-left text-surface-400 font-medium w-28">
                                    <button
                                        class="inline-flex items-center gap-1 cursor-pointer hover:text-surface-200 transition-colors {data.sort ===
                                        'updated_at'
                                            ? 'text-yellow-400'
                                            : ''}"
                                        onclick={() => goto(sortUrl('updated_at'))}>
                                        {m.media_col_updated_short()}
                                        {#if data.sort === 'updated_at'}
                                            <Icon
                                                src={data.order === 'desc'
                                                    ? ChevronDown
                                                    : ChevronUp}
                                                class="w-3.5 h-3.5" />
                                        {/if}
                                    </button>
                                </th>
                            {/if}
                            {#if isColVisible('originalTitle')}
                                <th class="px-2 py-3 text-left text-surface-400 font-medium w-40"
                                    >{m.media_col_original_title()}</th>
                            {/if}
                            {#if isColVisible('runtime')}
                                <th class="px-2 py-3 text-left text-surface-400 font-medium w-20"
                                    >{m.media_col_runtime()}</th>
                            {/if}
                            {#if isColVisible('overview')}
                                <th class="px-2 py-3 text-left text-surface-400 font-medium w-48"
                                    >{m.media_col_overview()}</th>
                            {/if}
                            {#if isColVisible('availability')}<th
                                    class="px-2 py-3 text-left text-surface-400 text-xs"
                                    >{m.media_redesign_availability()}</th
                                >{/if}
                            {#if isColVisible('fileCount')}
                                <th class="px-2 py-3 text-left text-surface-400 font-medium w-16"
                                    >{m.media_redesign_versions()}</th>
                            {/if}
                            {#if isColVisible('actions')}
                                <th
                                    class="px-2 py-3 text-left text-surface-400 font-medium w-28 hidden md:table-cell"
                                    >{m.media_col_actions()}</th>
                            {/if}
                        </tr>
                    </thead>
                    <tbody>
                        {#each data.items as item, i (`${item.id ?? 'null'}__${i}`)}
                            {@const badge = getMediaTypeBadge(item.mediaType)}
                            <!-- `aria-selected` below is INERT and kept only as a styling/
                             debugging hook: it is defined for `option`/`row`/`tab`/etc.,
                             and a bare `<tr>` inside a plain `<table>` has the `row`
                             role only within a `grid`/`treegrid`, which this table is
                             not. Selection is genuinely conveyed by the per-row
                             checkbox, whose `aria-pressed` and `aria-label`
                             ("Select row" / "Deselect row") are both announced.
                             Promoting the table to `role="grid"` is the honest pattern
                             now that arrow keys walk rows, but it rewrites the whole
                             table's a11y contract (roving tabindex, every cell needing
                             `role="gridcell"`) and is deliberately NOT bundled into
                             this change. -->
                            <tr
                                data-row-index={i}
                                id={`media-row-${item.id}`}
                                tabindex="0"
                                class="group border-b border-surface-800 hover:bg-surface-800/50 cursor-pointer transition-colors {focusedRowIndex ===
                                i
                                    ? 'ring-1 ring-inset ring-primary-500/50 bg-surface-700/30'
                                    : ''} {selectedRows.has(item.id) ? 'bg-yellow-500/5' : ''}"
                                onclick={() => selectRowIntoInspector(i)}
                                ondblclick={(e) => {
                                    // The migration affordance: every comparable tool
                                    // (Jellyfin, Sonarr, Plex) opens the detail page on
                                    // a single click, so muscle memory has to land
                                    // somewhere. Two clicks fire first and merely set
                                    // the inspector, which is idempotent.
                                    //
                                    // The child controls in this row stop `click` but
                                    // NOT `dblclick`, so without this guard a rapid
                                    // double-tap on Sync or the Play link would run the
                                    // control twice AND navigate away from the page it
                                    // just acted on.
                                    if ((e.target as HTMLElement).closest('button, a')) return;
                                    goto(resolve(`/admin/library/media/${item.id}`));
                                }}
                                onfocus={() => {
                                    focusedRowIndex = i;
                                }}
                                onkeydown={(e) => {
                                    // Delegated to the same owner the window handler
                                    // uses, and STOPPED here: this handler used to move
                                    // DOM focus itself, whose `onfocus` already advanced
                                    // `focusedRowIndex`, and then the window handler
                                    // advanced it a second time — two rows per keypress.
                                    //
                                    // The overlay guard is repeated rather than relied
                                    // on from the window handler: this is the SECOND
                                    // caller of `moveRowFocus`, and it stops the event
                                    // before the window handler's copy of the rule can
                                    // run. Arrow navigation having one governed owner
                                    // is the whole point of routing both through here.
                                    if (anyOverlayOpen) return;
                                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        moveRowFocus(e.key === 'ArrowDown' ? 1 : -1);
                                    }
                                }}
                                aria-selected={selectedRows.has(item.id)}>
                                <td class="px-3 py-2">
                                    <!-- Hover/focus reveal above the tablet breakpoint (`md`); always
                                 visible below it, and also whenever the row is focused or
                                 already selected so the state stays visible without requiring
                                 the pointer to stay put.

                                 `md` is a proxy for "has a pointer", and a wrong one: a tablet
                                 held in landscape is >=768px wide and has no hover, so the
                                 checkbox was `opacity: 0` with nothing able to reveal it —
                                 Tailwind v4 already wraps `group-hover:` in
                                 `@media (hover: hover)`, so the reveal half of the pair was
                                 dead there while the hide half was not. That left selection
                                 reachable on touch only through the header's "select all on
                                 page". `[@media(hover:none)]:` restores the floor on any device
                                 without hover while leaving the deliberate density choice
                                 intact wherever a pointer exists. The `!` is not decoration:
                                 both rules are single-class `opacity` utilities, so without it
                                 the outcome would rest on Tailwind's variant sort order rather
                                 than on anything this file states. -->
                                    <button
                                        class="inline-block w-4 h-4 rounded border transition-opacity {selectedRows.has(
                                            item.id,
                                        )
                                            ? 'bg-yellow-500 border-yellow-500 opacity-100'
                                            : focusedRowIndex === i
                                              ? 'border-surface-600 opacity-100'
                                              : 'border-surface-600 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 [@media(hover:none)]:opacity-100!'}"
                                        onclick={(e) => {
                                            e.stopPropagation();
                                            toggleSelectItem(i, e.shiftKey);
                                        }}
                                        onkeydown={(e) => {
                                            // The row this checkbox sits in tracks `focusedRowIndex`
                                            // independently (via the row's own `onfocus`, from arrow-key
                                            // navigation). Tabbing onto the checkbox itself does not clear
                                            // that index, so an unguarded Space would both trigger this
                                            // button's native activation AND bubble to the window-level
                                            // handler, toggling the same row twice.
                                            //
                                            // Now belt-and-braces: `handleGlobalKeydown` returns early for
                                            // ANY event whose target is inside a `button, a`, which covers
                                            // this checkbox along with the four sibling controls that
                                            // never had a guard of their own. Kept because it stops the
                                            // event at the source rather than relying on the window
                                            // handler's rule staying correct.
                                            if (e.key === ' ') e.stopPropagation();
                                        }}
                                        aria-label={selectedRows.has(item.id)
                                            ? m.admin_aria_deselect_row()
                                            : m.admin_aria_select_row()}
                                        aria-pressed={selectedRows.has(item.id)}>
                                        {#if selectedRows.has(item.id)}
                                            <svg
                                                class="w-4 h-4 text-surface-900"
                                                viewBox="0 0 14 14"
                                                ><path
                                                    fill="currentColor"
                                                    d="M11.7 3.3a1 1 0 0 1 0 1.4l-5 5a1 1 0 0 1-1.4 0l-2-2a1 1 0 0 1 1.4-1.4L6 7.6l4.3-4.3a1 1 0 0 1 1.4 0Z" /></svg>
                                        {/if}
                                    </button>
                                </td>
                                <td class="py-2 px-2">
                                    <div class="flex items-center gap-1">
                                        {#if failedImages.has(item.id)}
                                            <div
                                                class="w-8 h-12 shrink-0 rounded bg-surface-700 flex items-center justify-center">
                                                <Icon
                                                    src={isMovie(item.mediaType) ? Film : Tv}
                                                    class="w-4 h-4 text-surface-500" />
                                            </div>
                                        {:else}
                                            <!-- `max-w-none min-w-8`: preflight gives every img
                                         `max-width: 100%`, and WebKit resolves that percentage
                                         against the cell while the Title cell's `w-full` is
                                         claiming the whole table — the poster column's
                                         contribution becomes 0 and Safari renders every img at
                                         0px wide (Blink sizes the column from the 2rem width
                                         first, so Chrome never showed it). `max-w-none` removes
                                         the percentage from the equation; `min-w-8` is the
                                         floor that keeps the thumbnail visible even if some
                                         future rule reintroduces a fluid max-width. Verified in
                                         Playwright WebKit 26 against this page's frozen prod
                                         markup, 2026-08-28. -->
                                            <img
                                                src={posterUrl(item.id)}
                                                alt=""
                                                class="w-8 max-w-none min-w-8 h-12 shrink-0 rounded object-cover bg-surface-700"
                                                onerror={() => failedImages.add(item.id)} />
                                        {/if}
                                    </div>
                                </td>
                                <!-- Keep the elastic sizing on the cell: its floor participates
                                     in the table algorithm, while the link below can still
                                     truncate without painting over neighboring data. -->
                                <td class="px-4 py-2 w-full max-w-0 min-w-[28ch]">
                                    <div class="flex items-center gap-2">
                                        <!-- `min-w-0` is what lets `truncate` actually fire:
                                     a flex item defaults to `min-width: auto`, which
                                     refuses to shrink below min-content, so without this
                                     a long title would spill over the next column instead
                                     of ellipsing. It used to be `max-w-xs` that clamped
                                     that automatic minimum — the cap this replaces. -->
                                        {#if isSeries(item.mediaType) && item.childCount > 0}
                                            <button
                                                type="button"
                                                class="shrink-0 rounded px-1 text-surface-400 hover:text-surface-100"
                                                aria-expanded={seriesTrees.has(item.id)}
                                                aria-label={seriesTrees.has(item.id)
                                                    ? m.media_tree_collapse({ title: item.title })
                                                    : m.media_tree_expand({ title: item.title })}
                                                onclick={(e) => {
                                                    e.stopPropagation();
                                                    void toggleSeriesTree(item.id);
                                                }}>
                                                <span
                                                    aria-hidden="true"
                                                    class="inline-block w-3 transition-transform {seriesTrees.has(
                                                        item.id,
                                                    )
                                                        ? 'rotate-90'
                                                        : ''}">›</span>
                                            </button>
                                        {/if}
                                        <!-- The title is THE way into an item: a real link, so a
                                     plain click opens the detail page, cmd/middle-click opens
                                     a tab, hover preloads it, and the URL shows in the status
                                     bar. The rest of the row still selects into the
                                     inspector; double-click stays as a fallback. It used to
                                     be double-click ONLY — undiscoverable, impossible on
                                     touch, and it selected the word under the pointer. -->
                                        <a
                                            href={resolve(`/admin/library/media/${item.id}`)}
                                            data-sveltekit-preload-data="hover"
                                            onclick={(e) => e.stopPropagation()}
                                            class="text-surface-100 font-medium truncate min-w-0 hover:text-primary-300 hover:underline underline-offset-2">
                                            {item.title}
                                        </a>
                                        {#if item.fileIssues}
                                            {@const fiId = `file-issues-${item.id}`}
                                            <a
                                                href={resolve(
                                                    `/admin/library/media/${item.id}?tab=files`,
                                                )}
                                                onclick={(event) => event.stopPropagation()}
                                                class="shrink-0 {fileIssueIconClass(
                                                    item.fileIssues,
                                                )}"
                                                use:popup={{
                                                    event: 'hover',
                                                    target: fiId,
                                                    placement: 'top',
                                                    middleware: {
                                                        offset: 6,
                                                        shift: true,
                                                        flip: true,
                                                    },
                                                }}>
                                                <span class="sr-only"
                                                    >{m.admin_media_file_issues_label()}: {fileIssueSummary(
                                                        item.fileIssues,
                                                    )}</span>
                                                <Icon
                                                    src={ExclamationTriangle}
                                                    class="w-4 h-4"
                                                    theme="mini"
                                                    aria-hidden="true" />
                                            </a>
                                            <div
                                                data-popup={fiId}
                                                class="card px-3 py-2 bg-surface-900 border border-surface-700 rounded-lg text-xs text-surface-300 z-30 shadow-lg space-y-1 max-w-xs">
                                                <p class="font-semibold text-surface-100">
                                                    {m.admin_media_file_issues_label()}
                                                </p>
                                                {#if item.fileIssues.health.length > 0}
                                                    <div class="space-y-0.5">
                                                        {#each item.fileIssues.health as issueType (issueType)}
                                                            {@const infos = healthIssueDetails(
                                                                item.fileIssues,
                                                                issueType,
                                                            )}
                                                            <div class="flex items-start gap-1.5">
                                                                <Icon
                                                                    src={ExclamationTriangle}
                                                                    class="w-3 h-3 mt-0.5 shrink-0 {isSevereHealthIssue(
                                                                        issueType,
                                                                    )
                                                                        ? 'text-red-400'
                                                                        : 'text-amber-400'}"
                                                                    theme="mini"
                                                                    aria-hidden="true" />
                                                                <div class="min-w-0">
                                                                    <span
                                                                        >{healthIssueLabel(
                                                                            issueType,
                                                                        )}</span>
                                                                    <!-- The verbatim reason: e.g. the exact
                                                                 demuxer error and byte offset. -->
                                                                    {#each infos as info, infoIdx (issueType + '__' + infoIdx)}
                                                                        {#if info.detail}
                                                                            <p
                                                                                class="text-surface-400 break-words">
                                                                                {info.detail}
                                                                            </p>
                                                                        {/if}
                                                                        {#if info.filePath}
                                                                            <p
                                                                                class="text-surface-500 font-mono text-[10px] break-all">
                                                                                {baseName(
                                                                                    info.filePath,
                                                                                )}
                                                                            </p>
                                                                        {/if}
                                                                    {/each}
                                                                </div>
                                                            </div>
                                                        {/each}
                                                    </div>
                                                {/if}
                                                {#if item.fileIssues.integrity.length > 0}
                                                    <div class="space-y-0.5">
                                                        {#each item.fileIssues.integrity as iv, ivIdx (iv.rule + '__' + ivIdx)}
                                                            <div class="flex items-start gap-1.5">
                                                                <Icon
                                                                    src={ExclamationCircle}
                                                                    class="w-3 h-3 mt-0.5 shrink-0 {integritySeverityClass(
                                                                        iv.severity,
                                                                    )}"
                                                                    theme="mini"
                                                                    aria-hidden="true" />
                                                                <span>{iv.message ?? iv.rule}</span>
                                                            </div>
                                                        {/each}
                                                    </div>
                                                {/if}
                                            </div>
                                        {/if}
                                    </div>
                                    {#if !isColVisible('originalTitle') && item.originalTitle && item.originalTitle !== item.title}
                                        <p class="text-xs text-surface-500 truncate max-w-xs">
                                            {item.originalTitle}
                                        </p>
                                    {/if}
                                    {#if isEpisode(item.mediaType)}
                                        <p class="text-xs text-surface-500">
                                            S{String(item.seasonNumber ?? 0).padStart(
                                                2,
                                                '0',
                                            )}E{String(item.episodeNumber ?? 0).padStart(2, '0')}
                                        </p>
                                    {/if}
                                    {#if isSingleActQueue && item.mediaType === 'artist'}
                                        {@const feedback = singleActFeedback.get(item.id)}
                                        <a
                                            class="mr-3 inline-flex min-h-8 items-center text-xs text-primary-300 underline underline-offset-2 hover:text-primary-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400"
                                            href={resolve(
                                                `/admin/library/media/${item.id}?tab=tracks`,
                                            )}
                                            onclick={(e) => e.stopPropagation()}>
                                            {m.music_credits_open_tracks()}
                                        </a>
                                        <button
                                            type="button"
                                            class="mr-3 rounded border border-primary-500 px-2 py-1 text-xs text-primary-200 hover:bg-primary-500/10"
                                            onclick={(event) => {
                                                event.stopPropagation();
                                                collaborationArtistId = item.id;
                                            }}>
                                            {m.collaboration_resolve()}
                                        </button>
                                        <button
                                            type="button"
                                            class="mt-2 rounded border border-surface-600 px-2 py-1 text-xs text-surface-100 hover:bg-surface-700 disabled:opacity-50"
                                            disabled={singleActPending.has(item.id)}
                                            aria-label={feedback?.status === 'marked' ||
                                            feedback?.status === 'undo-error'
                                                ? m.admin_media_single_act_undo_for({
                                                      title: item.title,
                                                  })
                                                : m.admin_media_single_act_mark_for({
                                                      title: item.title,
                                                  })}
                                            onclick={(e) => {
                                                e.stopPropagation();
                                                void changeSingleAct(
                                                    item.id,
                                                    item.title,
                                                    feedback?.status === 'marked' ||
                                                        feedback?.status === 'undo-error'
                                                        ? false
                                                        : true,
                                                );
                                            }}>
                                            {feedback?.status === 'marked' ||
                                            feedback?.status === 'undo-error'
                                                ? m.admin_media_single_act_undo()
                                                : m.admin_media_single_act_mark()}
                                        </button>
                                    {/if}
                                    {#if !isSingleActQueue && item.mediaType === 'artist' && canResolveCollaboration(item.title)}
                                        <button
                                            type="button"
                                            class="mr-3 rounded border border-primary-500 px-2 py-1 text-xs text-primary-200 hover:bg-primary-500/10"
                                            onclick={(event) => {
                                                event.stopPropagation();
                                                collaborationArtistId = item.id;
                                            }}>
                                            {m.collaboration_resolve()}
                                        </button>
                                    {/if}
                                </td>
                                {#if isColVisible('type')}
                                    <td class="px-2 py-2">
                                        <span
                                            class="inline-flex px-2 py-0.5 rounded text-xs font-medium border {badge.class}">
                                            {badge.label}
                                        </span>
                                    </td>
                                {/if}
                                {#if isColVisible('ancestryParent')}
                                    {@const v = ancestryValue(item, 'parent')}
                                    <td
                                        class="px-2 py-2 text-surface-300 max-w-40 truncate"
                                        title={v ?? ''}>{v ?? '—'}</td>
                                {/if}
                                {#if isColVisible('ancestryRoot')}
                                    {@const v = ancestryValue(item, 'root')}
                                    <td
                                        class="px-2 py-2 text-surface-300 max-w-40 truncate"
                                        title={v ?? ''}>{v ?? '—'}</td>
                                {/if}
                                {#if isColVisible('author')}
                                    <td
                                        class="px-2 py-2 text-surface-300 hidden md:table-cell max-w-40 truncate"
                                        title={item.bookAuthor ?? ''}>
                                        {item.bookAuthor ?? '—'}
                                    </td>
                                {/if}
                                {#if isColVisible('narrator')}
                                    <td
                                        class="px-2 py-2 text-surface-400 hidden lg:table-cell max-w-40 truncate"
                                        title={item.bookNarrator ?? ''}>
                                        {item.bookNarrator ?? '—'}
                                    </td>
                                {/if}
                                {#if isColVisible('series')}
                                    <td
                                        class="px-2 py-2 text-surface-400 hidden md:table-cell max-w-48 truncate"
                                        title={item.bookSeries ?? ''}>
                                        {#if item.bookSeries}
                                            {item.bookSeries}{#if item.bookSeriesSequence}<span
                                                    class="text-surface-500">
                                                    &nbsp;#{item.bookSeriesSequence}</span
                                                >{/if}
                                        {:else}
                                            —
                                        {/if}
                                    </td>
                                {/if}
                                {#if isColVisible('year')}
                                    <td class="px-2 py-2 text-surface-400">
                                        {item.year ?? '—'}
                                    </td>
                                {/if}
                                {#if isColVisible('children')}
                                    <td class="px-2 py-2 text-surface-400 hidden md:table-cell">
                                        {#if item.childCount > 0}
                                            {item.childCount}
                                        {:else}
                                            —
                                        {/if}
                                    </td>
                                {/if}
                                {#if isColVisible('tmdb')}
                                    <td
                                        class="px-2 py-2 text-surface-500 hidden lg:table-cell font-mono text-xs">
                                        {item.tmdbId ?? '—'}
                                    </td>
                                {/if}
                                {#if isColVisible('status')}
                                    <td class="px-2 py-2 hidden lg:table-cell">
                                        <MediaIssueBadges
                                            issues={item.issues}
                                            mediaType={item.mediaType}
                                            max={1}
                                            onselectview={(view) =>
                                                view === 'files'
                                                    ? goto(
                                                          resolve(
                                                              `/admin/library/media/${item.id}?tab=files`,
                                                          ),
                                                      )
                                                    : setView(view)} />
                                    </td>
                                {/if}
                                {#if isColVisible('dateAdded')}
                                    <td
                                        class="px-2 py-2 text-surface-400 text-xs"
                                        title={new Date(item.createdAt).toLocaleString()}>
                                        {formatRelativeDate(item.createdAt)}
                                    </td>
                                {/if}
                                {#if isColVisible('dateUpdated')}
                                    <td
                                        class="px-2 py-2 text-surface-400 text-xs"
                                        title={new Date(item.updatedAt).toLocaleString()}>
                                        {formatRelativeDate(item.updatedAt)}
                                    </td>
                                {/if}
                                {#if isColVisible('originalTitle')}
                                    <td
                                        class="px-2 py-2 text-surface-400 text-xs truncate max-w-[10rem]">
                                        {item.originalTitle ?? '—'}
                                    </td>
                                {/if}
                                {#if isColVisible('runtime')}
                                    <td class="px-2 py-2 text-surface-400 text-xs">
                                        {item.runtimeSeconds
                                            ? formatRuntime(item.runtimeSeconds)
                                            : '—'}
                                    </td>
                                {/if}
                                {#if isColVisible('overview')}
                                    <td
                                        class="px-2 py-2 text-surface-500 text-xs truncate max-w-xs overflow-hidden">
                                        {item.overview ?? '—'}
                                    </td>
                                {/if}
                                {#if isColVisible('availability')}
                                    <td class="px-2 py-2 text-xs text-surface-300">
                                        {#if isSeries(item.mediaType)}
                                            {@const regularSeasons = (
                                                item.episodeCoverage ?? []
                                            ).filter(
                                                (season) =>
                                                    season.seasonNumber !== null &&
                                                    season.seasonNumber > 0,
                                            )}
                                            {@const hasRegularCoverage = regularSeasons.some(
                                                (season) => season.identified > 0,
                                            )}
                                            {@const held = regularSeasons.reduce(
                                                (sum, season) => sum + season.held,
                                                0,
                                            )}
                                            {@const listed = regularSeasons.reduce(
                                                (sum, season) => sum + season.listed,
                                                0,
                                            )}
                                            {@const missingUnknown = regularSeasons.some(
                                                (season) => season.missing === null,
                                            )}
                                            {@const coverageText =
                                                m.media_redesign_regular_coverage({ held, listed })}
                                            {#if hasRegularCoverage}
                                                <Tooltip
                                                    lines={[
                                                        { text: coverageText },
                                                        ...(missingUnknown
                                                            ? [
                                                                  {
                                                                      text: m.media_redesign_missing_unknown(),
                                                                      class: 'text-amber-200',
                                                                  },
                                                              ]
                                                            : []),
                                                    ]}
                                                    position="top"
                                                    fixed
                                                    inline
                                                    wrap
                                                    delay={0}
                                                    toggleOnClick={false}>
                                                    <button
                                                        type="button"
                                                        class="rounded px-1 text-left text-surface-300 hover:text-surface-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-400"
                                                        aria-label={missingUnknown
                                                            ? `${coverageText}. ${m.media_redesign_missing_unknown()}`
                                                            : coverageText}>
                                                        {m.media_redesign_regular_coverage_compact({
                                                            held,
                                                            listed,
                                                        })}
                                                        {#if missingUnknown}<span
                                                                class="ml-1 text-amber-200"
                                                                aria-hidden="true">?</span
                                                            >{/if}
                                                    </button>
                                                </Tooltip>
                                            {:else}
                                                {m.media_redesign_unknown()}
                                            {/if}
                                        {:else if ['album', 'artist', 'season'].includes(item.mediaType)}{m.media_redesign_container_availability()}
                                        {:else if item.mediaType === 'audiobook'}{m.media_redesign_availability_external()}
                                        {:else}{item.hasFiles
                                                ? m.media_redesign_availability_yes()
                                                : m.media_redesign_catalog_only()}{/if}
                                    </td>
                                {/if}
                                {#if isColVisible('fileCount')}
                                    <td class="px-2 py-2 text-surface-400 text-xs">
                                        {item.fileCount > 0 ? item.fileCount : '—'}
                                    </td>
                                {/if}
                                {#if isColVisible('actions')}
                                    <td class="px-2 py-2 hidden md:table-cell">
                                        <div class="flex items-center gap-1">
                                            {#if isUnidentifiedDomain}
                                                {#if !isNonEntertainment(item.mediaType)}
                                                    <button
                                                        onclick={(e) => {
                                                            e.stopPropagation();
                                                            identifyItem = {
                                                                id: item.id,
                                                                title: item.title,
                                                                mediaType: item.mediaType,
                                                            };
                                                        }}
                                                        class="px-2 py-1 rounded text-xs font-medium bg-blue-500/20 text-blue-400 border border-blue-500/40 hover:bg-blue-500/30 transition-colors"
                                                        title={m.admin_title_identify_this_item()}>
                                                        {m.route_admin_library_identify()}
                                                    </button>
                                                {/if}
                                                <button
                                                    onclick={(e) => {
                                                        e.stopPropagation();
                                                        // Confirm first — this browser has
                                                        // no restore control (#19).
                                                        requestDismissItem(item.id);
                                                    }}
                                                    class="p-1 rounded text-surface-400 hover:text-red-400 transition-colors disabled:opacity-50"
                                                    disabled={dismissingItems.has(item.id)}
                                                    aria-label={m.admin_aria_dismiss()}
                                                    title={m.admin_title_dismiss()}>
                                                    <Icon src={XMark} class="w-4 h-4" />
                                                </button>
                                            {:else}
                                                {#if item.hasFiles && isMusicType(item.mediaType)}
                                                    <button
                                                        onclick={(e) => {
                                                            e.stopPropagation();
                                                            void playMusicItem(item);
                                                        }}
                                                        class="p-1 rounded text-surface-400 hover:text-primary-400 transition-colors"
                                                        aria-label={m.admin_aria_play_in_mini_player()}
                                                        title={m.admin_title_play_in_mini_player()}>
                                                        <Icon src={Play} class="w-4 h-4" />
                                                    </button>
                                                {:else if !isAudiobook(item.mediaType) && (item.hasFiles || isSeries(item.mediaType) || isSeason(item.mediaType))}
                                                    <!-- Audiobooks carry hasFiles = true (playable
                                                 on the upstream ABS server) but have no
                                                 /watch route, so they get no play link. -->

                                                    <a
                                                        href={resolve(`/watch/${item.id}`)}
                                                        target="_blank"
                                                        rel="noopener"
                                                        onclick={(e) => e.stopPropagation()}
                                                        class="p-1 rounded text-surface-400 hover:text-primary-400 transition-colors"
                                                        aria-label={m.admin_aria_play()}
                                                        title={m.admin_title_play()}>
                                                        <Icon src={Play} class="w-4 h-4" />
                                                    </a>
                                                {/if}
                                                <button
                                                    onclick={async (e) => {
                                                        e.stopPropagation();
                                                        await syncItem(item.id);
                                                    }}
                                                    class="p-1 rounded text-surface-400 hover:text-primary-400 transition-colors disabled:opacity-50"
                                                    disabled={syncingItems.has(item.id)}
                                                    aria-label={m.admin_aria_sync_metadata()}
                                                    title={m.admin_title_sync_metadata()}>
                                                    <Icon
                                                        src={ArrowPath}
                                                        class="w-4 h-4 {syncingItems.has(item.id)
                                                            ? 'animate-spin'
                                                            : ''}" />
                                                </button>
                                            {/if}
                                        </div>
                                    </td>
                                {/if}
                            </tr>
                            {@const tree = seriesTrees.get(item.id)}
                            {#if tree}
                                <SeriesTreeRows
                                    seriesId={item.id}
                                    seriesTitle={item.title}
                                    truncated={tree.truncated}
                                    status={tree.status}
                                    seasons={tree.seasons}
                                    colspan={visibleColumnCount}
                                    onselectview={setView}
                                    onopenfiles={(id) =>
                                        goto(resolve(`/admin/library/media/${id}?tab=files`))} />
                            {/if}
                        {:else}
                            <tr>
                                <td
                                    colspan={visibleColumnCount}
                                    class="px-4 py-12 text-center text-surface-500">
                                    {#if data.query}
                                        {m.admin_media_empty_matching({ query: data.query })}
                                    {:else if data.view !== 'all' && data.view !== 'recent'}
                                        <div class="font-medium text-surface-200">
                                            {m.media_view_empty_title()}
                                        </div>
                                        <div class="mt-1 text-xs">{m.media_view_empty_text()}</div>
                                    {:else}
                                        {m.admin_media_empty_no_items()}
                                    {/if}
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        {/if}

        {#if inspectorItem}
            <MediaInspector
                item={inspectorItem}
                docked={isInspectorDocked}
                onclose={closeInspector}
                onaction={(action) => {
                    if (inspectorItem) handleInspectorAction(action, inspectorItem);
                }}
                onfixissue={(issue) => {
                    if (inspectorItem) fixInspectorIssue(issue, inspectorItem);
                }} />
        {/if}
    </div>

    {#if showDuplicates}
        {@render duplicatesPanel()}
    {/if}

    <!-- Pagination -->
    {#if totalPages > 1}
        <div class="flex items-center justify-between mt-4">
            <p class="text-sm text-surface-500">
                {m.media_pagination_page_of({
                    page: data.page,
                    total: totalPages,
                })}
            </p>
            <div class="flex items-center gap-1">
                <button
                    class="p-2 rounded-lg text-surface-400 hover:text-white hover:bg-surface-800 disabled:opacity-30 disabled:cursor-not-allowed"
                    disabled={data.page <= 1}
                    onclick={() => goToPage(data.page - 1)}>
                    <Icon src={ChevronLeft} class="w-4 h-4" />
                </button>
                {#each Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                    if (totalPages <= 7) return i + 1;
                    if (data.page <= 4) return i + 1;
                    if (data.page >= totalPages - 3) return totalPages - 6 + i;
                    return data.page - 3 + i;
                }) as pageNum (pageNum)}
                    <button
                        class="min-w-[2rem] h-8 px-2 rounded-lg text-sm font-medium transition-colors
                        {data.page === pageNum
                            ? 'bg-yellow-500/20 text-yellow-400'
                            : 'text-surface-400 hover:text-white hover:bg-surface-800'}"
                        onclick={() => goToPage(pageNum)}>
                        {pageNum}
                    </button>
                {/each}
                <button
                    class="p-2 rounded-lg text-surface-400 hover:text-white hover:bg-surface-800 disabled:opacity-30 disabled:cursor-not-allowed"
                    disabled={data.page >= totalPages}
                    onclick={() => goToPage(data.page + 1)}>
                    <Icon src={ChevronRight} class="w-4 h-4" />
                </button>
            </div>
        </div>
    {/if}
</div>

<!-- Duplicate-detection panel — defined as a snippet so it can be rendered
     INSIDE the file-health tab content rather than appended after every tab (#32). -->
{#snippet duplicatesPanel()}
    <div class="mt-8 space-y-4" bind:this={duplicatesPanelEl}>
        <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold text-white">
                {m.media_label_duplicate_detection()}
            </h3>
            <button
                class="text-xs text-surface-500 hover:text-surface-300 transition-colors"
                onclick={() => {
                    showDuplicates = false;
                    duplicates = [];
                    filelessPairs = [];
                    filelessTotal = 0;
                }}>
                {m.toast_dismiss()}
            </button>
        </div>

        {#if duplicatesError}
            <p class="text-sm text-red-400">{duplicatesError}</p>
        {:else if duplicatesLoading}
            <p class="text-sm text-surface-500">
                {m.media_scanning_duplicates()}
            </p>
        {:else}
            {#if duplicates.length === 0 && filelessPairs.length === 0}
                <p class="text-sm text-surface-400">
                    {m.media_no_duplicates_found()}
                </p>
            {/if}

            {#if duplicates.length > 0}
                <p class="text-sm text-surface-400">
                    {m.admin_media_found_tmdb_duplicates({ count: duplicates.length })}
                </p>
                <div class="space-y-3">
                    {#each duplicates as group (group.tmdb_id + ':' + group.media_type)}
                        <div
                            class="rounded-lg border border-red-800/40 bg-red-950/20 p-4 space-y-2">
                            <div class="flex items-center gap-2 text-xs text-surface-500">
                                <details>
                                    <summary>{m.media_plain_technical_details()}</summary><span
                                        class="font-mono"
                                        >{m.media_label_tmdb_id({ id: group.tmdb_id })}</span>
                                </details>
                                <span>&middot;</span>
                                <span>{mediaTypeName(group.media_type)}</span>
                                <span>&middot;</span>
                                <span
                                    >{m.admin_media_entries_count({
                                        count: group.items.length,
                                    })}</span>
                            </div>
                            <div class="space-y-1">
                                {#each group.items as item, dupIdx (item.id + '__' + dupIdx)}
                                    <div class="flex items-center gap-3 text-sm">
                                        <a
                                            href={resolve(`/admin/library/media/${item.id}`)}
                                            class="text-yellow-400 hover:text-yellow-300 font-medium truncate max-w-xs">
                                            {item.title ?? m.admin_media_untitled()}
                                            {#if item.year}({item.year}){/if}
                                        </a>
                                        <details class="text-surface-500 text-xs">
                                            <summary>{m.media_plain_technical_details()}</summary
                                            ><span class="font-mono">{item.id}</span>
                                        </details>
                                        <span class="text-surface-600 text-xs shrink-0">
                                            {new Date(item.created_at).toLocaleDateString()}
                                        </span>
                                    </div>
                                {/each}
                            </div>
                        </div>
                    {/each}
                </div>
            {/if}

            {#if filelessPairs.length > 0}
                <div class="space-y-2 pt-2">
                    <h4 class="text-sm font-semibold text-amber-300">
                        {m.admin_media_unlinked_library_files({ count: filelessPairs.length })}
                    </h4>
                    <p class="text-xs text-surface-400">{m.media_plain_duplicate_action()}</p>
                    <details class="text-xs text-surface-400">
                        <summary>{m.media_plain_technical_details()}</summary
                        >{m.admin_media_unlinked_library_files_desc()}
                    </details>
                    {#if filelessTotal > filelessPairs.length}
                        <p class="text-xs text-amber-400/80">
                            {m.admin_media_fileless_showing({
                                shown: filelessPairs.length,
                                total: filelessTotal,
                            })}
                        </p>
                    {/if}
                    <div class="space-y-3">
                        {#each filelessPairs as pair (pair.fileId)}
                            <div
                                class="rounded-lg border border-amber-800/40 bg-amber-950/20 p-4 space-y-2">
                                <div class="flex items-center gap-2 text-xs text-surface-500">
                                    <details>
                                        <summary>{m.media_plain_technical_details()}</summary><span
                                            class="font-mono">TMDB: {pair.tmdbId}</span>
                                    </details>
                                    <span>&middot;</span>
                                    <span>{mediaTypeName(pair.mediaType)}</span>
                                    {#if pair.year}
                                        <span>&middot;</span>
                                        <span>{pair.year}</span>
                                    {/if}
                                </div>
                                <div class="flex flex-wrap items-center gap-3 text-sm">
                                    <span class="flex flex-col">
                                        <a
                                            href={resolve(`/admin/library/media/${pair.fileId}`)}
                                            class="text-emerald-400 hover:text-emerald-300 font-medium truncate max-w-xs">
                                            {pair.fileTitle}
                                        </a>
                                        <span class="text-[10px] uppercase text-emerald-600"
                                            >{m.admin_media_file_keep()}</span>
                                    </span>
                                    <span class="text-surface-600">←</span>
                                    <span class="flex flex-col">
                                        <a
                                            href={resolve(
                                                `/admin/library/media/${pair.discoveryId}`,
                                            )}
                                            class="text-yellow-400 hover:text-yellow-300 font-medium truncate max-w-xs">
                                            {pair.discoveryTitle}
                                        </a>
                                        <span class="text-[10px] uppercase text-yellow-600"
                                            >{m.admin_media_discovery_merge()}</span>
                                    </span>
                                    <button
                                        class="ml-auto rounded bg-amber-700/70 hover:bg-amber-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                                        disabled={mergingPairId !== null}
                                        onclick={() => requestMergeFilelessPair(pair)}>
                                        {mergingPairId === pair.fileId
                                            ? m.admin_media_merging()
                                            : m.admin_media_merge()}
                                    </button>
                                </div>
                            </div>
                        {/each}
                    </div>
                </div>
            {/if}
        {/if}
    </div>
{/snippet}

<!-- Identify Modal -->
{#if identifyItem}
    <IdentifyModal
        item={identifyItem}
        onidentified={() => {
            reloadAfterMutation();
            // Advance the bulk-identify queue (no-op for single-item identify) (#18).
            advanceIdentifyQueue();
        }}
        onclose={() => {
            // Closing skips to the next queued item rather than discarding the
            // whole bulk run; clears the queue once exhausted (#18).
            advanceIdentifyQueue();
        }} />
{/if}

<!-- Bulk Selection Action Bar -->
{#if selectedCount > 0}<p class="my-3 text-sm text-surface-300">
        {m.media_redesign_selection_scope({
            page: data.items.filter((item) => selectedRows.has(item.id)).length,
            other: selectedCount - data.items.filter((item) => selectedRows.has(item.id)).length,
        })}
    </p>{/if}
{#if selectedCount > 0}
    <MediaActionBar
        rows={selectedItems}
        {isUnidentifiedDomain}
        isBusy={bulkBusy}
        onaction={handleSelectionAction}
        onDeselectAll={clearSelection} />
{/if}

<!-- Bulk Delete Confirmation -->
{#if showDeleteConfirm}
    <!-- Every count the dialog PROMISES is `deleteSummary.deletable`, never
         `selectedCount`: the two differ by the rows `bulkDelete` skips, and a
         dialog that promises the larger number over a line saying those rows
         are skipped describes an action that does not exist. `selectedCount`
         still drives the breakdown and the skip line, which describe the
         SELECTION rather than the outcome. -->
    <ActionModal
        title={deleteSummary.deletable === 0
            ? m.media_bulk_delete_nothing_title()
            : m.admin_media_delete_modal_title({ count: deleteSummary.deletable })}
        confirmText={m.btn_delete()}
        confirmColor="red"
        disabled={deleteSummary.deletable === 0 || !bulkDeleteConfirmed}
        onconfirm={bulkDelete}
        onclose={closeBulkDeleteConfirm}>
        {#if deleteSummary.deletable === 0}
            <!-- Nothing survives the skip. Saying so plainly, and withholding
                 the type-to-confirm input entirely, is the whole content of
                 this branch: offering a route to a destructive action that
                 would delete nothing is the bug, not the wording of it. -->
            <p class="text-sm text-yellow-400">
                {m.media_bulk_delete_nothing_body({ count: selectedCount })}
            </p>
        {:else}
            <p class="text-sm text-surface-300">
                {m.admin_media_delete_modal_body({ count: deleteSummary.deletable })}
            </p>
        {/if}
        <!-- WHAT the selection is, not just how many. A count alone cannot be
             consented to once a selection spans pages and types. -->
        <p class="text-sm text-surface-300">
            {m.media_bulk_delete_breakdown({ breakdown: deleteSummary.breakdown })}
        </p>
        {#if deleteSummary.withChildren > 0 && deleteSummary.deletable > 0}
            <!-- The cascade consequence, named. Cascade delete is deliberately
                 NOT implemented here (it is new destructive server behaviour);
                 what the operator needs to know is therefore that those rows
                 will be SKIPPED, not that their children will go too.
                 Suppressed when NOTHING is deletable — the zero-case body
                 above already says every selected row is skipped, and printing
                 both makes the reader count two numbers to reach one fact. -->
            <p class="text-sm text-yellow-400">
                {m.media_bulk_delete_cascade_skip({ count: deleteSummary.withChildren })}
            </p>
        {/if}
        {#if deleteSummary.deletable > 0}
            <div class="space-y-1.5">
                <label
                    class="text-xs text-surface-400 font-medium uppercase tracking-wide"
                    for="bulk-delete-confirm-input">
                    {m.media_bulk_delete_confirm_label({
                        word: bulkDeleteConfirmExpected,
                        count: deleteSummary.deletable,
                    })}
                </label>
                <input
                    id="bulk-delete-confirm-input"
                    type="text"
                    data-autofocus
                    class="w-full bg-surface-900/60 border border-surface-700/50 rounded-lg px-3 py-2 text-surface-100 text-sm focus:border-red-500 focus:outline-none"
                    placeholder={bulkDeleteConfirmExpected}
                    bind:value={bulkDeleteConfirmInput} />
            </div>
        {/if}
    </ActionModal>
{/if}

<!-- Single-item Delete Confirmation (inspector action). Separate from the bulk
     modal above because it must not read or mutate `selectedRows`. -->
{#if inspectorDeleteItem}
    {@const target = inspectorDeleteItem}
    <!-- A row with children is NOT deletable here, and this dialog now says so
         instead of promising a skip it cannot perform. It used to render
         `media_delete_warning` ("1 item(s) will be skipped (have children)")
         with Delete live and `deleteInspectorItem` calling `deleteMedia`
         unconditionally: the operator was told nothing would happen, pressed a
         live button, and got a raw 409 error toast. That is the same defect
         already fixed on the BULK path, and it is fixed here the same way and
         in the same wording register — "Nothing to delete" as the title, a
         plain statement of why, and `disabled` on the confirm. -->
    {@const blocked = target.childCount > 0}
    <ActionModal
        title={blocked
            ? m.media_bulk_delete_nothing_title()
            : m.admin_media_delete_modal_title({ count: 1 })}
        confirmText={m.btn_delete()}
        confirmColor="red"
        disabled={blocked}
        onconfirm={deleteInspectorItem}
        onclose={() => (inspectorDeleteItem = null)}>
        <p class="text-sm text-surface-300">{target.title}</p>
        {#if blocked}
            <p class="text-sm text-yellow-400 mt-2">
                {m.media_delete_single_blocked()}
            </p>
        {:else}
            <p class="text-sm text-surface-300 mt-1">
                {m.admin_media_delete_modal_body({ count: 1 })}
            </p>
        {/if}
    </ActionModal>
{/if}

<!-- Soft-dismiss is restorable by API, but this browser has no Undo control. -->
{#if dismissConfirmIds.length > 0}
    <ActionModal
        title={dismissConfirmTitle}
        confirmText={m.media_plain_hide()}
        confirmColor="red"
        onconfirm={confirmDismiss}
        onclose={() => (dismissConfirmIds = [])}>
        <p class="text-sm text-surface-300">
            {m.admin_library_bulk_dismiss_body()}
        </p>
        {#if dismissConfirmSkipped > 0}
            <!-- The selection and the batch differ, so the dialog says by how
                 much. Same shape as the bulk delete dialog's skip line: an
                 operator cannot consent to a destructive action whose scope is
                 narrower than the rows they highlighted unless they are told
                 which of them it covers. -->
            <p class="text-sm text-yellow-400">
                {m.media_bulk_dismiss_skip({
                    skipped: dismissConfirmSkipped,
                    total: dismissConfirmIds.length + dismissConfirmSkipped,
                    count: dismissConfirmIds.length,
                })}
            </p>
        {/if}
    </ActionModal>
{/if}

<!-- Fileless-merge Confirmation — replaces the native confirm() with a styled
     modal showing BOTH titles and the destructive consequence (#33). -->
{#if mergeConfirmPair}
    {@const pair = mergeConfirmPair}
    <ActionModal
        title={m.media_label_duplicate_detection()}
        confirmText={m.admin_media_merge()}
        confirmColor="red"
        onconfirm={async () => {
            mergeConfirmPair = null;
            await mergeFilelessPair(pair);
        }}
        onclose={() => (mergeConfirmPair = null)}>
        <div class="space-y-2 text-sm text-surface-300">
            <div class="flex items-center gap-2">
                <span class="text-emerald-400 font-medium truncate">{pair.fileTitle}</span>
                <span class="text-[10px] uppercase text-emerald-600"
                    >{m.admin_media_file_keep()}</span>
            </div>
            <div class="flex items-center gap-2">
                <span class="text-yellow-400 font-medium truncate">{pair.discoveryTitle}</span>
                <span class="text-[10px] uppercase text-yellow-600"
                    >{m.admin_media_discovery_merge()}</span>
            </div>
            <p class="text-xs text-surface-400">
                {m.admin_media_merge_confirm({
                    discoveryTitle: pair.discoveryTitle,
                    fileTitle: pair.fileTitle,
                    tmdbId: pair.tmdbId,
                })}
            </p>
        </div>
    </ActionModal>
{/if}

<!-- Mobile scroll spacer for action bar -->
{#if collaborationArtistId}
    <CollaborationReviewModal
        artistId={collaborationArtistId}
        onclose={() => (collaborationArtistId = null)}
        onchanged={refreshCollaborationQueue} />
{/if}

{#if selectedCount > 0}
    <div class="h-24 sm:hidden" aria-hidden="true"></div>
{/if}
