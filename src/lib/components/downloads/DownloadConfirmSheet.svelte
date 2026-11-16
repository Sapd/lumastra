<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * DownloadConfirmSheet - shows what is about to be downloaded (file count,
     * total size, unavailable episodes), for a series lets the user choose the scope
     * (this episode, the rest of the season, a hand-picked list, a season, the series)
     * and, in Chromium, lets the user pick the target folder (needs a click, so it
     * lives here and not in the queue start).
     */
    import { tick } from 'svelte';
    import { downloadQueue, FAT32_LIMIT_BYTES } from '$lib/downloads/download-queue.svelte';
    import {
        episodeCode,
        scopeOptions,
        seasonEpisodes,
        type ScopeOption,
    } from '$lib/downloads/download-scope';
    import { formatFileSize } from '$lib/utils/metric-formatters';
    import { Z } from '$lib/utils/z-index';
    import * as m from '$lib/paraglide/messages';

    let pending = $derived(downloadQueue.pending);
    let available = $derived(pending?.list.items.filter((i) => i.available) ?? []);
    let totalBytes = $derived(available.reduce((s, i) => s + i.sizeBytes, 0));

    // Series sheet: every option, count and size is derived from the one list the queue holds.
    let series = $derived(pending?.series);
    let options = $derived(series ? scopeOptions(series) : []);
    let showScope = $derived(options.length > 1);
    let checklist = $derived(series && series.scope === 'custom' ? seasonEpisodes(series) : []);
    // Season 0 only joins a series-wide download, and only when the series has some.
    let canToggleSpecials = $derived(
        series?.scope === 'series' && series.all.items.some((i) => i.season === 0 && i.available),
    );
    function label(o: ScopeOption): string {
        const size = formatFileSize(o.bytes);
        switch (o.scope) {
            case 'episode': {
                const from = series?.all.items.find((i) => i.mediaItemId === series?.episodeId);
                return m.downloads_scope_episode({ code: from ? episodeCode(from) : '', size });
            }
            case 'fromHere':
                return m.downloads_scope_from_here({ count: o.count, size });
            case 'custom':
                return m.downloads_scope_custom();
            case 'season':
                return series?.season === 0
                    ? m.downloads_scope_specials({ count: o.count, size })
                    : m.downloads_scope_season({
                          season: series?.season ?? 0,
                          count: o.count,
                          size,
                      });
            case 'series':
                return m.downloads_scope_series({ count: o.count, size });
        }
    }
    /** "Show - S01E02 - Title.mkv" -> "Title"; empty when the name has no title part. */
    function episodeTitle(i: { fileName: string }): string {
        return /S\d+E\d+(?:-?E\d+)*\s+-\s+(.+)\.[^.]+$/.exec(i.fileName)?.[1] ?? '';
    }
    let titleName = $derived(pending?.list.seriesFolder ?? '');
    // No folder picker and a season/series: the user may take one ZIP (folders kept) instead.
    let zipOffered = $derived(downloadQueue.zipOffered);
    let zipChosen = $derived(zipOffered && downloadQueue.archive);
    let startLabel = $derived(
        zipChosen
            ? m.downloads_start_zip({ size: formatFileSize(totalBytes) })
            : available.length === 1
              ? m.downloads_start_one({ size: formatFileSize(totalBytes) })
              : m.downloads_start_n({
                    count: available.length,
                    size: formatFileSize(totalBytes),
                }),
    );

    // FAT32 sticks cannot hold a file of 4 GiB or more. Only matters when saving to a folder.
    let hasOversize = $derived(
        downloadQueue.supportsFolderPicker &&
            available.some((i) => i.sizeBytes >= FAT32_LIMIT_BYTES),
    );

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

    const FOCUSABLE =
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

    /**
     * What Tab really visits: enabled, visible controls, and of a radio group only the checked
     * radio (the first one when none is checked).
     */
    /** Visible to the user: no display:none / visibility:hidden on the element or an ancestor. */
    function isRendered(el: HTMLElement): boolean {
        if (typeof el.checkVisibility === 'function') {
            return el.checkVisibility({ visibilityProperty: true });
        }
        for (let n: HTMLElement | null = el; n; n = n.parentElement) {
            const s = getComputedStyle(n);
            if (s.display === 'none' || s.visibility === 'hidden') return false;
        }
        return true;
    }

    function tabStops(root: HTMLElement): HTMLElement[] {
        const all = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
            (el) => !el.closest('[hidden], [inert]') && isRendered(el),
        );
        const radios = all.filter(
            (el): el is HTMLInputElement => el instanceof HTMLInputElement && el.type === 'radio',
        );
        const keep: HTMLElement[] = [];
        for (const name of [...new Set(radios.map((r) => r.name))]) {
            const group = radios.filter((r) => r.name === name);
            keep.push(group.find((r) => r.checked) ?? group[0]!);
        }
        return all.filter(
            (el) => !(el instanceof HTMLInputElement && el.type === 'radio') || keep.includes(el),
        );
    }

    // The sheet is the topmost overlay, usually above the media modal. Its keys are handled in
    // the CAPTURE phase and consumed there, so neither the modal's window Tab trap (which would
    // pull focus out of the sheet) nor its Escape handler (which would close the modal too)
    // ever sees them.
    function onKeyCapture(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            downloadQueue.dismissPending();
            return;
        }
        if (e.key !== 'Tab' || !dialogEl) return;
        e.stopPropagation();
        const list = tabStops(dialogEl);
        if (list.length === 0) {
            e.preventDefault();
            return;
        }
        const first = list[0];
        const last = list[list.length - 1];
        const active = document.activeElement as HTMLElement | null;
        const inside = !!active && dialogEl.contains(active);
        if (e.shiftKey && (!inside || active === first || active === dialogEl)) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && (!inside || active === last)) {
            e.preventDefault();
            first.focus();
        }
    }
    $effect(() => {
        if (!pending) return;
        window.addEventListener('keydown', onKeyCapture, true);
        return () => window.removeEventListener('keydown', onKeyCapture, true);
    });
</script>

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
            style="max-height: 100dvh; padding-bottom: max(1.25rem, env(safe-area-inset-bottom)); padding-top: max(1.25rem, env(safe-area-inset-top));"
            class="w-full sm:max-w-md max-h-[100dvh] overflow-y-auto bg-surface-800 rounded-t-xl sm:rounded-xl px-5 shadow-xl space-y-3">
            <h3 id="download-sheet-title" class="text-lg font-semibold text-white break-words">
                {m.downloads_confirm_title({ name: titleName })}
            </h3>

            {#if series && showScope}
                <fieldset class="space-y-1" data-testid="download-scope">
                    <legend class="sr-only">{m.downloads_scope_legend()}</legend>
                    {#each options as o (o.scope)}
                        <label class="flex items-center gap-2 text-sm text-surface-200">
                            <input
                                type="radio"
                                name="download-scope"
                                class="radio"
                                data-testid="download-scope-{o.scope}"
                                checked={series.scope === o.scope}
                                onchange={() => downloadQueue.setScope(o.scope)} />
                            {label(o)}
                        </label>
                    {/each}
                </fieldset>
            {/if}

            {#if series && series.scope === 'custom'}
                <div class="space-y-1" data-testid="download-episodes">
                    <div class="flex gap-3 text-xs">
                        <button
                            type="button"
                            class="text-primary-400 hover:underline"
                            data-testid="download-select-all"
                            onclick={() =>
                                downloadQueue.setAllEpisodes(
                                    true,
                                    checklist.map((i) => i.mediaItemId),
                                )}>
                            {m.downloads_select_all()}
                        </button>
                        <button
                            type="button"
                            class="text-primary-400 hover:underline"
                            data-testid="download-select-none"
                            onclick={() => downloadQueue.setAllEpisodes(false, [])}>
                            {m.downloads_select_none()}
                        </button>
                    </div>
                    <ul class="max-h-48 overflow-y-auto space-y-0.5 pr-1">
                        {#each checklist as ep (ep.mediaItemId)}
                            <li>
                                <label
                                    class="flex items-center gap-2 text-sm text-surface-200 py-0.5">
                                    <input
                                        type="checkbox"
                                        class="checkbox"
                                        data-testid="download-episode-{ep.mediaItemId}"
                                        checked={series.custom.includes(ep.mediaItemId)}
                                        onchange={() =>
                                            downloadQueue.toggleEpisode(ep.mediaItemId)} />
                                    <span class="font-mono text-xs shrink-0"
                                        >{episodeCode(ep)}</span>
                                    <span class="truncate min-w-0 flex-1">{episodeTitle(ep)}</span>
                                    <span class="text-xs text-surface-400 shrink-0"
                                        >{formatFileSize(ep.sizeBytes)}</span>
                                </label>
                            </li>
                        {/each}
                    </ul>
                </div>
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
                        data-testid="download-specials"
                        checked={series?.specials === true}
                        onchange={(e) => downloadQueue.setSpecials(e.currentTarget.checked)} />
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
