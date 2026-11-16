<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * DownloadConfirmSheet - shows what is about to be downloaded (file count,
     * total size, unavailable episodes) and, in Chromium, lets the user pick the
     * target folder (needs a click, so it lives here and not in the queue start).
     */
    import { tick, untrack } from 'svelte';
    import {
        downloadQueue,
        FAT32_LIMIT_BYTES,
        type DownloadList,
    } from '$lib/downloads/download-queue.svelte';
    import { formatFileSize } from '$lib/utils/metric-formatters';
    import { Z } from '$lib/utils/z-index';
    import * as m from '$lib/paraglide/messages';

    let pending = $derived(downloadQueue.pending);
    let available = $derived(pending?.list.items.filter((i) => i.available) ?? []);
    let totalBytes = $derived(available.reduce((s, i) => s + i.sizeBytes, 0));
    // A series-wide list can include season 0 on request; a single season or
    // movie cannot, so the checkbox only shows for the series-wide case.
    let canToggleSpecials = $derived(
        !!pending &&
            pending.opts.season === undefined &&
            pending.list.items.some((i) => i.seasonFolder !== null),
    );

    // Season <-> whole series: only for a season of a series with more than one season
    // (specials do not count). Counts and sizes come from ONE series list (with specials).
    let scopeSeason = $derived(pending?.scopeSeason);
    let seriesList = $state<DownloadList | null>(null);
    let seriesFor: string | undefined;
    $effect(() => {
        const p = pending;
        untrack(() => {
            if (!p || p.scopeSeason === undefined) {
                seriesList = null;
                seriesFor = undefined;
                return;
            }
            // Switching scope re-lists the same series: keep the counts.
            const id: string = p.mediaItemId;
            if (seriesFor === id) return;
            seriesFor = id;
            seriesList = null;
            void downloadQueue.fetchList(id, { specials: true }).then((l) => {
                if (seriesFor === id) seriesList = l;
            });
        });
    });
    let seriesItems = $derived((seriesList?.items ?? []).filter((i) => i.available));
    let realSeasons = $derived(
        new Set((seriesList?.items ?? []).filter((i) => i.season !== 0).map((i) => i.season)),
    );
    let showScope = $derived(scopeSeason !== undefined && realSeasons.size > 1);
    function tally(items: typeof seriesItems) {
        return {
            count: items.length,
            size: formatFileSize(items.reduce((s, i) => s + i.sizeBytes, 0)),
        };
    }
    let seasonTally = $derived(tally(seriesItems.filter((i) => i.season === scopeSeason)));
    let seriesTally = $derived(
        tally(pending?.opts.specials ? seriesItems : seriesItems.filter((i) => i.season !== 0)),
    );
    let seasonScoped = $derived(pending?.opts.season !== undefined);
    let titleName = $derived(pending?.list.seriesFolder ?? '');
    let startLabel = $derived(
        available.length === 1
            ? m.downloads_start_one({ size: formatFileSize(totalBytes) })
            : m.downloads_start_n({ count: available.length, size: formatFileSize(totalBytes) }),
    );

    // FAT32 sticks cannot hold a file of 4 GiB or more. Only matters when saving to a folder.
    let hasOversize = $derived(
        downloadQueue.supportsFolderPicker &&
            available.some((i) => i.sizeBytes >= FAT32_LIMIT_BYTES),
    );

    // No folder picker and a season/series: the user may take one ZIP (folders kept) instead.
    let zipOffered = $derived(downloadQueue.zipOffered);
    let zipChosen = $derived(zipOffered && downloadQueue.archive);
    let zipOverFat32 = $derived(totalBytes >= FAT32_LIMIT_BYTES);
    let isIosBrowser = $derived(downloadQueue.profile.hint === 'ios');

    // Exactly one browser-specific hint: the Brave one when the picker is off in Brave
    // (blocked by default or just failed), else the one for this browser.
    let browserHint = $derived.by(() => {
        if (
            !downloadQueue.supportsFolderPicker &&
            downloadQueue.isBrave &&
            downloadQueue.profile.hint !== 'ios'
        )
            return m.downloads_hint_brave();
        switch (downloadQueue.profile.hint) {
            case 'ios':
                return m.downloads_hint_ios();
            case 'safari':
                return m.downloads_hint_safari();
            case 'firefox':
                return m.downloads_hint_firefox();
            default:
                return m.downloads_hint_generic();
        }
    });

    // Focus moves into the sheet when it opens and back to the trigger when it closes.
    let dialogEl = $state<HTMLElement | null>(null);
    let opener: HTMLElement | null = null;
    let wasOpen = false;
    $effect(() => {
        const open = !!pending;
        if (open && !wasOpen) {
            opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            void tick().then(() => dialogEl?.focus());
        } else if (!open && wasOpen) {
            const target = opener;
            opener = null;
            void tick().then(() => target?.isConnected && target.focus());
        }
        wasOpen = open;
    });

    function onKey(e: KeyboardEvent) {
        if (e.key === 'Escape') downloadQueue.dismissPending();
    }
</script>

<svelte:window onkeydown={pending ? onKey : undefined} />

{#if pending}
    <div
        class="fixed inset-0 flex items-end sm:items-center justify-center bg-black/60"
        style="z-index: {Z.FLOATING_MODAL}"
        role="presentation"
        onclick={(e) => {
            if (e.target === e.currentTarget) downloadQueue.dismissPending();
        }}>
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="download-sheet-title"
            tabindex="-1"
            bind:this={dialogEl}
            data-testid="download-confirm-sheet"
            class="w-full sm:max-w-md bg-surface-800 rounded-t-xl sm:rounded-xl p-5 shadow-xl space-y-3">
            <h3 id="download-sheet-title" class="text-lg font-semibold text-white">
                {m.downloads_confirm_title({ name: titleName })}
            </h3>

            {#if showScope}
                <fieldset
                    class="space-y-1"
                    data-testid="download-scope"
                    disabled={downloadQueue.loading}>
                    <legend class="sr-only">{m.downloads_scope_legend()}</legend>
                    <label class="flex items-center gap-2 text-sm text-surface-200">
                        <input
                            type="radio"
                            name="download-scope"
                            class="radio"
                            data-testid="download-scope-season"
                            checked={seasonScoped}
                            onchange={() => void downloadQueue.setScope(scopeSeason)} />
                        {scopeSeason === 0
                            ? m.downloads_scope_specials(seasonTally)
                            : m.downloads_scope_season({
                                  season: scopeSeason ?? 0,
                                  ...seasonTally,
                              })}
                    </label>
                    <label class="flex items-center gap-2 text-sm text-surface-200">
                        <input
                            type="radio"
                            name="download-scope"
                            class="radio"
                            data-testid="download-scope-series"
                            checked={!seasonScoped}
                            onchange={() => void downloadQueue.setScope(undefined)} />
                        {m.downloads_scope_series(seriesTally)}
                    </label>
                </fieldset>
            {/if}

            {#if pending.list.missingCount > 0}
                <p class="text-sm text-amber-300" data-testid="download-missing">
                    {m.downloads_missing({ count: pending.list.missingCount })}
                </p>
            {/if}

            {#if canToggleSpecials}
                <label class="flex items-center gap-2 text-sm text-surface-200">
                    <input
                        type="checkbox"
                        class="checkbox"
                        checked={pending.opts.specials === true}
                        disabled={downloadQueue.loading}
                        onchange={(e) => void downloadQueue.setSpecials(e.currentTarget.checked)} />
                    {m.downloads_include_specials()}
                </label>
            {/if}

            {#if downloadQueue.supportsFolderPicker}
                <div class="space-y-1">
                    <button
                        type="button"
                        class="btn variant-ghost-surface"
                        data-testid="download-choose-folder"
                        onclick={() => void downloadQueue.chooseFolder()}>
                        {downloadQueue.folderName
                            ? m.downloads_change_folder()
                            : m.downloads_choose_folder()}
                    </button>
                    {#if downloadQueue.folderName}
                        <p class="text-sm text-surface-300 break-all">
                            {m.downloads_folder_chosen({ name: downloadQueue.folderName })}
                        </p>
                    {/if}
                    {#if !downloadQueue.folderName}
                        <p class="text-xs text-surface-400" data-testid="download-folder-hint">
                            {m.downloads_folder_hint()}
                        </p>
                    {/if}
                    {#if hasOversize}
                        <p class="text-sm text-amber-300" data-testid="download-fat32-warning">
                            {m.downloads_fat32_warning()}
                        </p>
                    {/if}
                </div>
            {/if}
            {#if !downloadQueue.supportsFolderPicker || !downloadQueue.folderName}
                {#if !downloadQueue.supportsFolderPicker}
                    <p class="text-xs text-surface-400" data-testid="download-browser-hint">
                        {browserHint}
                    </p>
                {/if}
                {#if zipOffered}
                    <fieldset class="space-y-1" data-testid="download-format">
                        <legend class="text-sm text-surface-200"
                            >{m.downloads_format_legend()}</legend>
                        <label class="flex items-center gap-2 text-sm text-surface-200">
                            <input
                                type="radio"
                                name="download-format"
                                class="radio"
                                data-testid="download-format-files"
                                checked={!zipChosen}
                                onchange={() => downloadQueue.setArchive(false)} />
                            {m.downloads_format_files()}
                        </label>
                        <label class="flex items-center gap-2 text-sm text-surface-200">
                            <input
                                type="radio"
                                name="download-format"
                                class="radio"
                                data-testid="download-format-zip"
                                checked={zipChosen}
                                onchange={() => downloadQueue.setArchive(true)} />
                            {m.downloads_format_zip()}
                        </label>
                        {#if zipChosen}
                            <p
                                class="text-xs text-surface-400"
                                data-testid="download-zip-note-resume">
                                {m.downloads_zip_note_resume()}
                            </p>
                            {#if zipOverFat32}
                                <p
                                    class="text-xs text-amber-300"
                                    data-testid="download-zip-note-big">
                                    {m.downloads_zip_note_big()}
                                </p>
                            {/if}
                            {#if isIosBrowser}
                                <p
                                    class="text-xs text-surface-400"
                                    data-testid="download-zip-note-ios">
                                    {m.downloads_zip_note_ios()}
                                </p>
                            {/if}
                        {/if}
                    </fieldset>
                {/if}
            {/if}

            <div class="flex justify-end gap-2 pt-2">
                <button
                    type="button"
                    class="btn variant-ghost-surface"
                    onclick={() => downloadQueue.dismissPending()}>
                    {m.downloads_cancel()}
                </button>
                <button
                    type="button"
                    class="btn variant-filled-primary"
                    data-testid="download-start"
                    disabled={available.length === 0}
                    onclick={() => void downloadQueue.start()}>
                    {startLabel}
                </button>
            </div>
        </div>
    </div>
{/if}
