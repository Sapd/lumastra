<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Bulk action bar for the admin media browser — task 6 of the
  media-inspector-and-selection spec.

  Every button here comes from `actionsFor({ surface: 'selection', … })`. It
  used to be a hand-written list of `{#if}` blocks, and it had already drifted
  away from the per-row Actions column beside it: it offered Sync Metadata and
  Sync Images unconditionally, including in the unidentified domain where there
  is no provider match to sync against and the row's own column correctly hides
  them (task 1 report, finding R2). Rendering from the registry is what fixes
  that and stops it happening again — resist adding a second, local list of
  `{#if}`s next to the `{#each}` below, because that is exactly the shape the
  drift took last time.

  What the caller still owns: WHAT each action does (`onaction`), and whether
  the selection is mid-flight (`isBusy`). What this component owns: turning a
  set of row snapshots into one `ActionContext`.
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { Icon, XMark } from 'svelte-hero-icons';
    import { mediaActionIcon, mediaActionShortLabel } from './media-action-presentation.js';
    import { isSeries, isNonEntertainment } from '$lib/shared/media-types';
    import {
        actionsFor,
        MIXED_SELECTION_MEDIA_TYPE,
        type MediaActionDef,
        type MediaActionId,
    } from './media-actions.js';

    /**
     * One selected row, as the page snapshotted it at select time.
     *
     * Structurally a superset of `selection.ts`'s `SelectedRow` plus the two
     * fields the registry's selection-eligible rules need (`metadataLocked`
     * for `unlock`, `tmdbId` for the unidentified-domain rules). Deliberately
     * not imported from the route: a component under `$lib` must not depend on
     * a route module, and props are structurally typed, so the page's richer
     * `SelectedRowSnapshot` satisfies this without either side exporting a
     * shared alias.
     */
    interface SelectionActionRow {
        id: string;
        mediaType: string;
        childCount: number;
        hasFiles: boolean;
        metadataLocked: boolean;
        tmdbId?: string;
    }

    interface Props {
        /**
         * The selection snapshots themselves — NOT pre-chewed booleans.
         *
         * `hasSeriesSelected` / `hasUnidentifiedSelected` used to arrive as
         * props computed on the page. Deriving them here instead is the point:
         * the page cannot then compute one of them differently from the way
         * the registry is asked about it, which is how the bar and the row
         * column got out of step in the first place.
         */
        rows: SelectionActionRow[];
        /** Whether the browser is showing the unidentified domain. Not derivable from a row. */
        isUnidentifiedDomain: boolean;
        isBusy: boolean;
        /** Run one registry action across the whole selection. */
        onaction: (action: MediaActionId) => void;
        onDeselectAll: () => void;
    }

    let { rows, isUnidentifiedDomain, isBusy, onaction, onDeselectAll }: Props = $props();

    let selectedCount = $derived(rows.length);

    // ------------------------------------------------------------------
    // The aggregate context
    // ------------------------------------------------------------------

    /**
     * Whether anything selected is a series.
     *
     * Only a series cascades on the bulk path: `bulk-media-sync` calls
     * `syncSeriesWithChildren` only when `includeChildren && isSeries(...)`,
     * and falls back to a plain `syncSingleItem` for everything else. So an
     * album's tracks are not children this action would ever reach, and
     * counting them would offer "Sync + Children" for a selection where
     * pressing it changes nothing.
     */
    let hasSeriesSelected = $derived(rows.some((r) => isSeries(r.mediaType)));

    /**
     * Whether anything selected lacks a provider match.
     *
     * Combined with the domain below rather than used alone: `identify` and
     * `dismiss` are unidentified-domain actions, and a row with no `tmdbId` in
     * the ordinary video domain is just an unmatched item in a normal listing,
     * not something to dismiss.
     */
    let hasUnidentifiedSelected = $derived(rows.some((r) => !r.tmdbId));

    /** Children of the SERIES rows only — see `hasSeriesSelected` above. */
    let cascadableChildCount = $derived(
        hasSeriesSelected
            ? rows.reduce((n, r) => n + (isSeries(r.mediaType) ? r.childCount : 0), 0)
            : 0,
    );

    /**
     * Whether a cascading sync has a container to cascade INTO — which is not
     * the same question as whether any child rows exist yet.
     *
     * `syncSeriesWithChildren` FETCHES seasons and episodes from TMDB; it does
     * not read existing ones. A series that has never been synced therefore
     * has `cascadableChildCount === 0` and is the item the action would do the
     * most work on. Sending only the count would hide "Sync + Children"
     * exactly there — a narrowing against the old bar, which offered it for
     * any selected series regardless of child rows.
     */
    let hasCascadableContainer = $derived(hasSeriesSelected);

    let actions = $derived<MediaActionDef[]>(
        actionsFor({
            surface: 'selection',
            // A selection has no single media type, and no rule eligible at
            // this surface reads one — `media-actions.test.ts` holds that as
            // an invariant so this sentinel cannot rot into a silent lie. See
            // MIXED_SELECTION_MEDIA_TYPE's own comment.
            mediaType: MIXED_SELECTION_MEDIA_TYPE,
            // "Applies to at least one selected row" is the bulk reading of
            // every rule below, and it is what the executors already assume:
            // bulk delete skips the rows it cannot delete rather than refusing
            // the whole batch.
            hasFiles: rows.some((r) => r.hasFiles),
            childCount: cascadableChildCount,
            hasCascadableContainer,
            locked: rows.some((r) => r.metadataLocked),
            domainFlags: {
                isUnidentified: isUnidentifiedDomain && hasUnidentifiedSelected,
                supportsProviderIdentity: rows.some((r) => !isNonEntertainment(r.mediaType)),
            },
        }),
    );

    // ------------------------------------------------------------------
    // Presentation
    // ------------------------------------------------------------------

    // Labels and icons live in `media-action-presentation.ts`, next to the
    // registry, as switches over `MediaActionId` — NOT as the two
    // `Record<MediaActionId, …>` literals that used to sit here. Those were
    // checked by nothing: tsgo does not read `.svelte`, and svelte-check-native
    // was measured not to flag a broken key in a component-local record either,
    // so a newly registered action rendered here as a blank-faced button in a
    // toolbar whose other members include Delete. See that module's doc.

    const btnClass =
        'flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-surface-800 hover:bg-surface-700 text-surface-300 hover:text-white transition-colors disabled:opacity-40 disabled:pointer-events-none';
    const destructiveBtnClass =
        'flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-surface-800 hover:bg-red-900/60 text-red-400 hover:text-red-300 transition-colors disabled:opacity-40 disabled:pointer-events-none';
</script>

<!-- `role="toolbar"` names this group of controls and, just as usefully,
     distinguishes the bar's "Identify"/"Sync Metadata" from the identically
     named per-row buttons in the table behind it — for a screen reader and for
     a test alike. Focus is not roving: every button stays tabbable, which the
     ARIA toolbar pattern permits and which matches how the rest of this admin
     UI behaves. -->
<div
    role="toolbar"
    aria-label={m.media_plain_bulk_actions()}
    class="fixed z-50 bg-surface-900 border border-surface-700 shadow-2xl px-4 py-3 flex items-center gap-3 animate-slide-up
        bottom-0 left-0 right-0 rounded-t-xl pb-[env(safe-area-inset-bottom)]
        sm:bottom-6 sm:left-1/2 sm:right-auto sm:w-auto sm:-translate-x-1/2 sm:rounded-xl sm:pb-3">
    <!-- Selected count -->
    <span class="text-sm text-surface-300 whitespace-nowrap">
        {selectedCount} selected
    </span>

    <div class="w-px h-6 bg-surface-700"></div>

    {#each actions as action (action.id)}
        <button
            type="button"
            class={action.destructive ? destructiveBtnClass : btnClass}
            onclick={() => onaction(action.id)}
            disabled={isBusy}>
            <Icon src={mediaActionIcon(action.id)} class="w-4 h-4" />
            {mediaActionShortLabel(action.id)}
        </button>
    {/each}

    <div class="w-px h-6 bg-surface-700"></div>

    <!-- Deselect all -->
    <button
        type="button"
        class="p-1.5 rounded-lg hover:bg-surface-700 text-surface-400 hover:text-white transition-colors"
        onclick={onDeselectAll}
        aria-label={m.media_plain_deselect_all()}
        title={m.media_plain_deselect_all()}>
        <Icon src={XMark} class="w-5 h-5" />
    </button>
</div>

<style>
    @keyframes slide-up {
        from {
            transform: translateY(100%);
            opacity: 0;
        }
        to {
            transform: translateY(0);
            opacity: 1;
        }
    }

    @keyframes slide-up-centered {
        from {
            transform: translate(-50%, 100%);
            opacity: 0;
        }
        to {
            transform: translate(-50%, 0);
            opacity: 1;
        }
    }

    .animate-slide-up {
        animation: slide-up 0.2s ease-out;
    }

    @media (min-width: 640px) {
        .animate-slide-up {
            animation: slide-up-centered 0.2s ease-out;
        }
    }
</style>
