<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Folder picker for a filesystem path input (Add folder / setup wizard).

  Renders a "Browse" button next to the caller's path input; clicking it opens
  an INLINE panel below the input (never a second modal stacked on the
  first). The panel lists subdirectories via `GET /api/admin/library/browse`
  and lets the operator drill down, or type the path by hand in the input as
  before — this component never disables that input, and `validate-path`
  still runs server-side on save regardless of how the value got there.

  Navigation is a breadcrumb trail built from the drill-down itself (Roots →
  each directory entered), not from splitting the OS path string: the server
  is the only thing that knows which roots are allowed, so a crumb can only
  ever point at a path this component actually reached by browsing.
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { browseLibraryFolders } from '$lib/api/admin';
    import type { LibraryBrowseEntry } from '$lib/schemas/api-admin-library-responses';
    import {
        Icon,
        Folder,
        ChevronRight,
        ArrowUp,
        ArrowPath,
        ExclamationTriangle,
    } from 'svelte-hero-icons';

    interface Props {
        /** Fired with the chosen absolute path. The caller's input keeps accepting typed text too. */
        onSelect: (path: string) => void;
        /** Distinguishes multiple pickers on one page (setup wizard has one per folder row). */
        id?: string;
    }

    let { onSelect, id = 'folder-picker' }: Props = $props();

    type ErrorKind = 'forbidden' | 'validation' | 'network';

    let open = $state(false);
    let loading = $state(false);
    let errorKind = $state<ErrorKind | null>(null);
    let errorMessage = $state('');
    let entries = $state<LibraryBrowseEntry[]>([]);
    /** Roots first, then one crumb per directory entered. The last crumb is the current view. */
    let crumbs = $state<{ label: string; path: string | null }[]>([]);
    const currentPath = $derived(crumbs.length > 0 ? crumbs[crumbs.length - 1].path : null);

    let browseButtonEl: HTMLButtonElement | undefined = $state();
    let panelEl: HTMLDivElement | undefined = $state();

    // Guards against an out-of-order response overwriting a newer one — the
    // operator can click into another folder (or Retry) while a request is
    // still in flight.
    let generation = 0;

    async function load(path: string | undefined): Promise<void> {
        const mine = ++generation;
        loading = true;
        errorKind = null;
        errorMessage = '';
        try {
            const { data, error, status } = await browseLibraryFolders(path);
            if (mine !== generation) return;
            if (error || !data) {
                if (status === 403) errorKind = 'forbidden';
                else if (status === 400 || status === 422) errorKind = 'validation';
                else errorKind = 'network';
                errorMessage = error ?? '';
                entries = [];
                return;
            }
            entries = data.entries;
        } catch (e) {
            if (mine !== generation) return;
            errorKind = 'network';
            errorMessage = e instanceof Error ? e.message : '';
            entries = [];
        } finally {
            if (mine === generation) loading = false;
        }
    }

    function openPicker(): void {
        open = true;
        crumbs = [{ label: m.admin_library_picker_roots_crumb(), path: null }];
        void load(undefined);
        // Move focus into the panel once it has rendered, so keyboard users land
        // somewhere inside it rather than staying on the Browse button.
        queueMicrotask(() => panelEl?.focus());
    }

    function closePicker(): void {
        open = false;
        browseButtonEl?.focus();
    }

    function isSelectable(entry: LibraryBrowseEntry): boolean {
        return entry.readable && entry.libraryGroupId === undefined;
    }

    function navigateInto(entry: LibraryBrowseEntry): void {
        if (!isSelectable(entry)) return;
        crumbs = [...crumbs, { label: entry.name, path: entry.path }];
        void load(entry.path);
    }

    function navigateToCrumb(index: number): void {
        if (index >= crumbs.length - 1) return;
        crumbs = crumbs.slice(0, index + 1);
        void load(crumbs[index].path ?? undefined);
    }

    function goUp(): void {
        navigateToCrumb(crumbs.length - 2);
    }

    function selectCurrent(): void {
        if (!currentPath) return;
        onSelect(currentPath);
        closePicker();
    }

    function handlePanelKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            e.stopPropagation();
            closePicker();
        }
    }
</script>

<button
    type="button"
    class="btn btn-ghost btn-sm shrink-0"
    id="{id}-browse"
    bind:this={browseButtonEl}
    aria-expanded={open}
    aria-controls="{id}-panel"
    onclick={openPicker}>
    <Icon src={Folder} class="w-4 h-4" />
    {m.admin_library_picker_browse()}
</button>

{#if open}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
        bind:this={panelEl}
        id="{id}-panel"
        class="mt-2 w-full rounded-lg border border-surface-700 bg-surface-800 p-3"
        role="group"
        aria-label={m.admin_library_picker_panel_label()}
        tabindex="-1"
        onkeydown={handlePanelKeydown}>
        <!-- Breadcrumb -->
        <div class="flex flex-wrap items-center gap-1 text-xs text-surface-400 mb-2">
            {#each crumbs as crumb, i (i)}
                {#if i > 0}
                    <Icon src={ChevronRight} class="w-3 h-3 shrink-0" />
                {/if}
                {#if i === crumbs.length - 1}
                    <span class="text-surface-200 truncate max-w-[10rem]" title={crumb.label}>
                        {crumb.label}
                    </span>
                {:else}
                    <button
                        type="button"
                        class="underline hover:text-white truncate max-w-[10rem]"
                        title={crumb.label}
                        onclick={() => navigateToCrumb(i)}>
                        {crumb.label}
                    </button>
                {/if}
            {/each}
        </div>

        <div class="flex items-center gap-2 mb-2">
            <button
                type="button"
                class="btn btn-ghost btn-sm"
                disabled={crumbs.length <= 1}
                onclick={goUp}>
                <Icon src={ArrowUp} class="w-4 h-4" />
                {m.admin_library_picker_up()}
            </button>
            {#if currentPath}
                <button type="button" class="btn btn-blue btn-sm" onclick={selectCurrent}>
                    {m.admin_library_picker_select_this_folder()}
                </button>
            {/if}
        </div>

        {#if loading}
            <div class="flex items-center gap-2 text-sm text-surface-400 py-2">
                <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                <span>{m.admin_library_picker_loading()}</span>
            </div>
        {:else if errorKind}
            <div class="rounded-lg border border-red-500/40 bg-red-500/10 p-3">
                <div class="flex items-start gap-2">
                    <Icon src={ExclamationTriangle} class="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                    <div class="text-sm min-w-0">
                        <p class="text-red-200">
                            {errorKind === 'forbidden'
                                ? m.admin_library_picker_error_forbidden()
                                : errorKind === 'validation'
                                  ? errorMessage || m.admin_library_picker_error_generic()
                                  : m.admin_library_picker_error_network()}
                        </p>
                        {#if errorKind === 'network'}
                            <button
                                type="button"
                                class="underline text-red-300 hover:text-red-200 mt-1"
                                onclick={() => void load(currentPath ?? undefined)}>
                                {m.admin_library_picker_retry()}
                            </button>
                        {/if}
                    </div>
                </div>
            </div>
        {:else if entries.length === 0}
            <p class="text-sm text-surface-500 py-2">{m.admin_library_picker_empty()}</p>
        {:else}
            <ul class="max-h-56 overflow-y-auto space-y-0.5">
                {#each entries as entry (entry.path)}
                    {@const selectable = isSelectable(entry)}
                    <li>
                        <button
                            type="button"
                            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-left {selectable
                                ? 'text-surface-200 hover:bg-surface-700'
                                : 'text-surface-500 cursor-not-allowed'}"
                            disabled={!selectable}
                            title={entry.name}
                            onclick={() => navigateInto(entry)}>
                            <Icon src={Folder} class="w-4 h-4 shrink-0" />
                            <span class="truncate flex-1">{entry.name}</span>
                            {#if entry.libraryGroupId}
                                <span class="text-xs text-surface-500 shrink-0">
                                    {m.admin_library_picker_already_in({
                                        name: entry.libraryName ?? '',
                                    })}
                                </span>
                            {:else if !entry.readable}
                                <span class="text-xs text-surface-500 shrink-0">
                                    {m.admin_library_picker_not_readable()}
                                </span>
                            {:else if entry.childCount !== null}
                                <span class="text-xs text-surface-500 shrink-0">
                                    {m.admin_library_picker_child_count({
                                        count: entry.childCount,
                                    })}
                                </span>
                            {/if}
                        </button>
                    </li>
                {/each}
            </ul>
        {/if}
    </div>
{/if}
