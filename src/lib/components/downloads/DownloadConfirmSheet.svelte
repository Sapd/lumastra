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
    import { tick } from 'svelte';
    import { downloadQueue, FAT32_LIMIT_BYTES } from '$lib/downloads/download-queue.svelte';
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

    // FAT32 sticks cannot hold a file of 4 GiB or more. Only matters when saving to a folder.
    let hasOversize = $derived(
        downloadQueue.supportsFolderPicker &&
            available.some((i) => i.sizeBytes >= FAT32_LIMIT_BYTES),
    );

    // Exactly one browser-specific hint: the Brave one when the picker is off in Brave
    // (blocked by default or just failed), else the one for this browser.
    let batchSize = $derived(downloadQueue.profile.batchSize(pending?.list.maxParallel ?? 0));
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
                {m.downloads_confirm_title()}
            </h3>

            <p class="text-sm text-surface-200" data-testid="download-summary">
                {m.downloads_confirm_summary({
                    count: available.length,
                    size: formatFileSize(totalBytes),
                })}
            </p>

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
                    <p class="text-xs text-surface-400">{m.downloads_folder_hint()}</p>
                    {#if hasOversize}
                        <p class="text-sm text-amber-300" data-testid="download-fat32-warning">
                            {m.downloads_fat32_warning()}
                        </p>
                    {/if}
                </div>
            {/if}
            {#if !downloadQueue.supportsFolderPicker || !downloadQueue.folderName}
                <p class="text-xs text-surface-400">
                    {downloadQueue.supportsFolderPicker
                        ? m.downloads_links_hint_no_folder()
                        : m.downloads_links_hint()}
                </p>
                <p class="text-xs text-surface-400" data-testid="download-browser-hint">
                    {browserHint}
                </p>
                {#if batchSize > 1 && available.length > batchSize}
                    <p class="text-xs text-surface-400" data-testid="download-batch-hint">
                        {m.downloads_links_batch_hint({ count: batchSize })}
                    </p>
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
                    {m.downloads_start()}
                </button>
            </div>
        </div>
    </div>
{/if}
