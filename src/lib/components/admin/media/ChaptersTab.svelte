<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { Icon, XMark, Plus, ArrowPath } from 'svelte-hero-icons';
    import { toasts } from '$lib/stores/toast.store';
    import {
        getAdminCustomMetadata,
        updateAdminCustomMetadata,
        undoAdminCuratedOutput,
    } from '$lib/api/admin';
    import { beforeNavigate } from '$app/navigation';

    interface Chapter {
        title: string;
        artist?: string;
        start_ms: number;
        end_ms?: number;
    }

    interface ParsedChapter {
        title: string;
        artist: string;
        start_ms: number;
    }

    interface Props {
        mediaId: string;
        runtimeSeconds?: number;
        onsaved?: () => void;
    }

    let { mediaId, runtimeSeconds, onsaved }: Props = $props();

    let chapters = $state<Chapter[]>([]);
    let savedChapters = $state<Chapter[]>([]);
    let loading = $state(true);
    let saving = $state(false);
    let undoId = $state<string | undefined>();

    let pasteText = $state('');
    // Parsed live while typing; null while the textarea is empty.
    let parsedPreview = $derived(pasteText.trim() ? parseTracklist(pasteText) : null);
    let dirty = $derived(!sameChapters(chapters, savedChapters));
    const tracklistPlaceholder = `00:00 Artist - Title
0:00 - Artist - Title
[00:00] Artist - Title
1. Artist - Title (0:00)
00:00:00 Artist Name - Track Title
00:00 Title (no artist)`;

    /** Field-wise compare; a missing artist and an empty one are the same chapter. */
    function sameChapters(a: Chapter[], b: Chapter[]): boolean {
        return (
            a.length === b.length &&
            a.every(
                (ch, i) =>
                    ch.title === b[i].title &&
                    (ch.artist ?? '') === (b[i].artist ?? '') &&
                    ch.start_ms === b[i].start_ms &&
                    ch.end_ms === b[i].end_ms,
            )
        );
    }

    function parseTimeToMs(time: string): number {
        const parts = time.split(':').map(Number);
        if (parts.length === 3) {
            return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
        }
        return (parts[0] * 60 + parts[1]) * 1000;
    }

    function formatTime(ms: number): string {
        const totalSeconds = Math.floor(ms / 1000);
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = totalSeconds % 60;
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    /**
     * Strip common YouTube/release noise from a track title.
     *
     * Repeatedly trims trailing bracketed segments like `(Official Video)`,
     * `[HD]`, `(Remastered 2011)` when their contents match a noise pattern
     * as a whole — so legitimate parentheticals like `(Live at Wembley)` or
     * `(Acoustic Demo)` stay intact. Also strips trailing `- Topic` from
     * YouTube auto-generated channel strings.
     *
     * Never returns an empty string.
     */
    function stripYoutubeNoise(input: string): string {
        const NOISE_CONTENT =
            /^\s*(?:(?:official\s+)?(?:music\s+|lyric\s+|lyrics\s+)?(?:video|audio|visualizer)|lyric(?:s)?(?:\s+video)?|audio(?:\s+only)?|hd|hq|4k|8k|1080p|720p|explicit|uncensored|clean(?:\s+version)?|radio\s+edit|album\s+version|remaster(?:ed)?(?:\s+\d{4})?|m\/?v)\s*$/i;

        let result = input.trim();
        let prev: string;
        do {
            prev = result;
            result = result
                .replace(/\s*-\s*Topic\s*$/i, '')
                .replace(/\s*[[(]([^[\]()]*?)[\])]\s*$/, (match, inner: string) =>
                    NOISE_CONTENT.test(inner) ? '' : match,
                )
                .trim();
        } while (result !== prev && result.length > 0);

        return result.length > 0 ? result : input.trim();
    }

    function parseTracklist(text: string): ParsedChapter[] {
        const lines = text
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        const results: ParsedChapter[] = [];

        for (const line of lines) {
            let match: RegExpMatchArray | null;
            let timeStr = '';
            let remainder = '';

            // Leading timestamp: `0:00 ...`, `[0:00] ...`, `0:00 - ...`, `(0:00) ...`
            match = line.match(/^[[(]?(\d{1,2}:\d{2}(?::\d{2})?)[\])]?\s*[-–—]?\s*(.+)$/);
            if (match) {
                timeStr = match[1];
                remainder = match[2];
            }

            // Trailing timestamp: `1. Artist - Title (0:00)` or `Artist - Title [0:00]`
            if (!match) {
                match = line.match(/^(?:\d+\.\s*)?(.+?)\s*[[(](\d{1,2}:\d{2}(?::\d{2})?)[\])]\s*$/);
                if (match) {
                    remainder = match[1];
                    timeStr = match[2];
                }
            }

            if (!timeStr) continue;

            const startMs = parseTimeToMs(timeStr);

            // Split into artist / title on the FIRST space-flanked dash.
            // Requiring whitespace on both sides avoids breaking names like
            // `AC-DC`, `+44`, or `Twenty One Pilots: Heathens` while still
            // catching the common `Artist - Title` layout from YT comments.
            const dashMatch = remainder.match(/^(.+?)\s+[-–—]\s+(.+)$/);
            let artist = '';
            let title = remainder;
            if (dashMatch) {
                artist = dashMatch[1].trim();
                title = dashMatch[2].trim();
            }

            title = title.replace(/^\d+\.\s*/, '').trim();
            title = stripYoutubeNoise(title);
            artist = stripYoutubeNoise(artist);

            results.push({ title, artist, start_ms: startMs });
        }

        return results;
    }

    let computedChapters = $derived.by(() => {
        const totalMs = runtimeSeconds !== undefined ? runtimeSeconds * 1000 : undefined;
        return chapters.map((ch, i) => {
            const nextStart = i + 1 < chapters.length ? chapters[i + 1].start_ms : undefined;
            const end_ms = ch.end_ms ?? nextStart ?? totalMs;
            return { ...ch, end_ms };
        });
    });

    $effect(() => {
        const id = mediaId;
        chapters = [];
        savedChapters = [];
        pasteText = '';
        void loadChapters(id);
    });

    beforeNavigate(({ cancel, willUnload }) => {
        if (!dirty) return;
        // A page unload only gets the browser's own prompt; cancel() triggers it.
        if (willUnload || !window.confirm(m.media_chapters_unsaved_confirm())) cancel();
    });

    async function loadChapters(id: string): Promise<void> {
        loading = true;
        try {
            const { data, error } = await getAdminCustomMetadata(id);
            // A response for an item we already left must not land in this one.
            if (id !== mediaId) return;
            if (error || !data) {
                toasts.error(m.media_chapters_load_failed());
                return;
            }
            undoId = data.undoIds?.chapters;
            const customMeta = data.custom_metadata;
            if ('chapters' in customMeta && Array.isArray(customMeta.chapters)) {
                chapters = customMeta.chapters as Chapter[];
            } else {
                chapters = [];
            }
            savedChapters = chapters;
        } catch {
            toasts.error(m.media_chapters_load_failed());
        } finally {
            loading = false;
        }
    }

    /**
     * Persists a chapter list. Only `savedChapters` is updated here: edits typed
     * while the request was in flight stay in `chapters` and keep the tab dirty.
     */
    async function saveChapters(chaptersForSave: Chapter[]): Promise<boolean> {
        if (saving) return false;
        const id = mediaId;
        saving = true;
        let saved = false;
        try {
            // Payload is merged into custom_metadata JSONB, so send the
            // `chapters` field directly — nesting it under `custom_metadata`
            // would produce `custom_metadata.custom_metadata.chapters`.
            const { data, error } = await updateAdminCustomMetadata(id, {
                chapters: chaptersForSave,
            });
            if (error || !data) {
                toasts.error(m.media_chapters_save_failed());
            } else {
                saved = true;
                if (id === mediaId) undoId = data.undoId;
                if (id === mediaId) savedChapters = chaptersForSave;
                toasts.success(m.media_chapters_save_success());
            }
        } catch {
            toasts.error(m.media_chapters_save_failed());
        } finally {
            saving = false;
        }
        if (saved) onsaved?.();
        return saved;
    }

    function handleSave(): void {
        void saveChapters(chapters);
    }

    function handleDiscard(): void {
        chapters = savedChapters;
    }

    function addChapter(): void {
        const lastEnd =
            chapters.length > 0
                ? (chapters[chapters.length - 1].end_ms ??
                  (runtimeSeconds !== undefined ? runtimeSeconds * 1000 : 0))
                : 0;
        chapters = [...chapters, { title: '', artist: '', start_ms: lastEnd }];
    }

    function deleteChapter(index: number): void {
        chapters = chapters.filter((_, i) => i !== index);
    }

    function updateChapterTitle(index: number, value: string): void {
        chapters = chapters.map((ch, i) => (i === index ? { ...ch, title: value } : ch));
    }

    function updateChapterArtist(index: number, value: string): void {
        chapters = chapters.map((ch, i) => (i === index ? { ...ch, artist: value } : ch));
    }

    function updateChapterStartTime(index: number, value: string): void {
        const parts = value.split(':').map(Number);
        let ms = 0;
        if (parts.length === 3) {
            ms = (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
        } else if (parts.length === 2) {
            ms = (parts[0] * 60 + parts[1]) * 1000;
        }
        if (!isNaN(ms)) {
            chapters = chapters.map((ch, i) => (i === index ? { ...ch, start_ms: ms } : ch));
        }
    }

    /** Replaces the chapter list with the parsed tracklist and saves it in one step. */
    async function handleImport(): Promise<void> {
        if (!parsedPreview || parsedPreview.length === 0) return;
        if (dirty && !window.confirm(m.media_chapters_unsaved_confirm())) return;
        const id = mediaId;
        const submittedText = pasteText;
        const imported = parsedPreview.map((p) => ({
            title: p.title,
            artist: p.artist || undefined,
            start_ms: p.start_ms,
        }));
        if (!(await saveChapters(imported)) || id !== mediaId) return;
        chapters = imported;
        // Keep anything typed into the box while the save was running.
        if (pasteText === submittedText) pasteText = '';
    }
    async function undoOutput(): Promise<void> {
        if (!undoId || saving) return;
        const id = mediaId;
        saving = true;
        try {
            const result = await undoAdminCuratedOutput(id, 'chapters', undoId);
            if (id !== mediaId) return;
            if (!result.data) {
                toasts.error(result.error ?? m.media_p5_undo_conflict());
                return;
            }
            await loadChapters(id);
            onsaved?.();
        } catch {
            if (id === mediaId) toasts.error(m.media_p5_undo_conflict());
        } finally {
            if (id === mediaId) saving = false;
        }
    }
</script>

<div class="space-y-6">
    <!-- Header -->
    <div class="flex items-center justify-between">
        <h3 class="text-lg font-semibold text-white">
            {m.media_chapters_heading({ count: chapters.length })}
        </h3>
        <div class="flex items-center gap-2">
            {#if undoId}
                <button
                    class="btn variant-ghost-surface text-sm px-3 py-1.5"
                    onclick={undoOutput}
                    disabled={saving || dirty}>
                    {m.media_p5_undo_chapters()}
                </button>
            {/if}
            {#if dirty}
                <span class="text-xs text-warning-400" role="status">
                    {m.media_chapters_unsaved()}
                </span>
                <button
                    class="btn variant-ghost-surface text-sm px-3 py-1.5"
                    onclick={handleDiscard}
                    disabled={saving}>
                    {m.media_chapters_discard()}
                </button>
            {/if}
            <button
                class="btn variant-ghost-surface text-sm px-3 py-1.5 inline-flex items-center gap-1.5"
                onclick={addChapter}>
                <Icon src={Plus} class="w-4 h-4" />
                {m.media_chapters_add_chapter()}
            </button>
            <button
                class="btn variant-filled-primary text-sm px-4 py-1.5"
                onclick={handleSave}
                disabled={saving || !dirty}>
                {saving ? m.media_chapters_saving() : m.media_chapters_save()}
            </button>
        </div>
    </div>

    {#if loading}
        <div class="flex items-center gap-2 text-surface-400 text-sm py-4">
            <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
            {m.media_chapters_loading()}
        </div>
    {:else if chapters.length === 0}
        <!-- Empty state -->
        <div
            class="rounded-lg border border-surface-700/50 bg-surface-800/30 px-6 py-10 text-center space-y-3">
            <p class="text-surface-400 text-sm">
                {m.media_chapters_empty_state()}
            </p>
            <div class="flex justify-center gap-2">
                <button class="btn variant-ghost-surface text-sm px-3 py-1.5" onclick={addChapter}>
                    {m.media_chapters_add_chapter()}
                </button>
                <button
                    class="btn variant-ghost-surface text-sm px-3 py-1.5"
                    onclick={() => {
                        const el = document.getElementById('paste-tracklist-textarea');
                        el?.focus();
                        el?.scrollIntoView({ behavior: 'smooth' });
                    }}>
                    {m.media_chapters_paste_tracklist()}
                </button>
            </div>
        </div>
    {:else}
        <!-- Chapters table -->
        <div class="rounded-lg border border-surface-700/50 overflow-hidden text-sm">
            <table class="w-full">
                <thead>
                    <tr class="bg-surface-800/80">
                        <th
                            class="text-surface-400 text-xs uppercase tracking-wide font-medium text-left px-3 py-2.5 w-8">
                            #
                        </th>
                        <th
                            class="text-surface-400 text-xs uppercase tracking-wide font-medium text-left px-3 py-2.5 w-24">
                            {m.admin_task_start()}
                        </th>
                        <th
                            class="text-surface-400 text-xs uppercase tracking-wide font-medium text-left px-3 py-2.5 w-24">
                            {m.media_chapters_col_end()}
                        </th>
                        <th
                            class="text-surface-400 text-xs uppercase tracking-wide font-medium text-left px-3 py-2.5">
                            {m.media_chapters_col_artist()}
                        </th>
                        <th
                            class="text-surface-400 text-xs uppercase tracking-wide font-medium text-left px-3 py-2.5">
                            {m.media_chapters_col_title()}
                        </th>
                        <th class="w-8"></th>
                    </tr>
                </thead>
                <tbody>
                    {#each computedChapters as chapter, i (i)}
                        <tr class="border-t border-surface-700/30">
                            <td class="px-3 py-2 text-surface-500 tabular-nums text-xs">
                                {i + 1}
                            </td>
                            <td class="px-3 py-2">
                                <input
                                    type="text"
                                    class="w-20 bg-surface-700/40 border border-surface-600/50 rounded px-2 py-1 text-surface-100 text-xs font-mono focus:border-primary-500 focus:outline-none"
                                    value={formatTime(chapter.start_ms)}
                                    onchange={(e) =>
                                        updateChapterStartTime(
                                            i,
                                            (e.currentTarget as HTMLInputElement).value,
                                        )} />
                            </td>
                            <td class="px-3 py-2 text-surface-400 text-xs font-mono tabular-nums">
                                {chapter.end_ms !== undefined ? formatTime(chapter.end_ms) : '—'}
                            </td>
                            <td class="px-3 py-2">
                                <input
                                    type="text"
                                    class="w-full bg-surface-700/40 border border-surface-600/50 rounded px-2 py-1 text-surface-100 text-xs focus:border-primary-500 focus:outline-none"
                                    placeholder={m.media_chapters_col_artist()}
                                    value={chapter.artist ?? ''}
                                    oninput={(e) =>
                                        updateChapterArtist(
                                            i,
                                            (e.currentTarget as HTMLInputElement).value,
                                        )} />
                            </td>
                            <td class="px-3 py-2">
                                <input
                                    type="text"
                                    class="w-full bg-surface-700/40 border border-surface-600/50 rounded px-2 py-1 text-surface-100 text-xs focus:border-primary-500 focus:outline-none"
                                    placeholder={m.media_chapters_col_title()}
                                    value={chapter.title}
                                    oninput={(e) =>
                                        updateChapterTitle(
                                            i,
                                            (e.currentTarget as HTMLInputElement).value,
                                        )} />
                            </td>
                            <td class="px-3 py-2">
                                <button
                                    class="text-surface-500 hover:text-red-400 transition-colors p-0.5"
                                    onclick={() => deleteChapter(i)}
                                    aria-label={m.media_chapters_delete_chapter()}>
                                    <Icon src={XMark} class="w-4 h-4" />
                                </button>
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>
    {/if}

    <!-- Separator -->
    <hr class="border-surface-700/50" />

    <!-- Paste Tracklist -->
    <div class="space-y-3">
        <div>
            <h4 class="text-sm font-medium text-surface-200">
                {m.media_chapters_paste_tracklist()}
            </h4>
            <p class="text-xs text-surface-400 mt-1">{m.media_chapters_paste_hint()}</p>
        </div>
        <textarea
            id="paste-tracklist-textarea"
            class="w-full bg-surface-800/60 border border-surface-700/50 rounded-lg px-3 py-2 text-surface-100 text-sm font-mono focus:border-primary-500 focus:outline-none"
            rows="8"
            placeholder={tracklistPlaceholder}
            bind:value={pasteText}></textarea>

        {#if parsedPreview !== null}
            <!-- Parsed preview -->
            <div class="space-y-2">
                <div class="flex items-center justify-between">
                    <p class="text-sm text-surface-400">
                        {m.media_chapters_preview_count({ count: parsedPreview.length })}
                    </p>
                    <button
                        class="btn variant-filled-primary text-sm px-3 py-1.5"
                        onclick={handleImport}
                        disabled={saving || parsedPreview.length === 0}>
                        {savedChapters.length > 0 || dirty
                            ? m.media_chapters_import_replace({ count: parsedPreview.length })
                            : m.media_chapters_import_save({ count: parsedPreview.length })}
                    </button>
                </div>
                {#if parsedPreview.length > 0}
                    <div class="rounded-lg border border-surface-700/50 overflow-hidden text-sm">
                        <table class="w-full">
                            <thead>
                                <tr class="bg-surface-800/80">
                                    <th
                                        class="text-surface-400 text-xs uppercase tracking-wide font-medium text-left px-3 py-2.5 w-8">
                                        #
                                    </th>
                                    <th
                                        class="text-surface-400 text-xs uppercase tracking-wide font-medium text-left px-3 py-2.5 w-24">
                                        {m.admin_task_start()}
                                    </th>
                                    <th
                                        class="text-surface-400 text-xs uppercase tracking-wide font-medium text-left px-3 py-2.5">
                                        {m.media_chapters_col_artist()}
                                    </th>
                                    <th
                                        class="text-surface-400 text-xs uppercase tracking-wide font-medium text-left px-3 py-2.5">
                                        {m.media_chapters_col_title()}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {#each parsedPreview as row, i (i)}
                                    <tr class="border-t border-surface-700/30">
                                        <td class="px-3 py-2 text-surface-500 tabular-nums text-xs">
                                            {i + 1}
                                        </td>
                                        <td
                                            class="px-3 py-2 text-surface-300 font-mono text-xs tabular-nums">
                                            {formatTime(row.start_ms)}
                                        </td>
                                        <td class="px-3 py-2 text-surface-300 text-xs">
                                            {row.artist || '—'}
                                        </td>
                                        <td class="px-3 py-2 text-surface-100 text-xs">
                                            {row.title}
                                        </td>
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                    </div>
                {:else}
                    <p class="text-sm text-surface-500">
                        {m.media_chapters_parse_empty()}
                    </p>
                {/if}
            </div>
        {/if}
    </div>
</div>
