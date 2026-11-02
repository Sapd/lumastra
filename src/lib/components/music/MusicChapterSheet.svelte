<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Z } from '$lib/utils/z-index';
    import { Icon, XMark } from 'svelte-hero-icons';
    import {
        computeChapterEnds,
        findChapterAtMs,
        formatChapterTime,
    } from '$lib/utils/music-chapters';
    import type { TrackChapter as MusicChapter } from '$lib/schemas/api-music-dto';
    import { fade, fly } from 'svelte/transition';
    import { tick } from 'svelte';
    import * as m from '$lib/paraglide/messages';

    /**
     * Chapters, position and seeking are INJECTED rather than read from
     * `musicPlayerStore`.
     *
     * The audiobook player reuses this sheet, and its position is BOOK time
     * while the music store's `currentTimeMs` is the backend's FILE time. Wired
     * to the store directly, the active-chapter highlight would be wrong on
     * every file after the first of a multi-file book — silently, since both
     * numbers are plausible milliseconds.
     *
     * The music surface passes exactly what it used to read, so its behaviour is
     * unchanged; the reading now happens at the call site, where the caller
     * knows which clock it is holding.
     */
    interface Props {
        open: boolean;
        onclose: () => void;
        /** Chapter list in the caller's own time base. */
        chapters: readonly MusicChapter[];
        /**
         * Current position, in the SAME time base as `chapters`.
         *
         * For an audiobook that is book time, never the element's file time.
         */
        positionMs: number;
        /** Total length, used to close the final chapter's open end. */
        durationMs?: number;
        /** Seek to an absolute position in the same time base. */
        onseek: (positionMs: number) => void;
        /** Sheet heading. Defaults to the music surface's wording. */
        heading?: string;
    }

    let {
        open,
        onclose,
        chapters,
        positionMs,
        durationMs,
        onseek,
        heading = 'Chapters',
    }: Props = $props();

    let decorated = $derived(computeChapterEnds(chapters, durationMs || undefined));
    let activeIndex = $derived.by(() => {
        if (decorated.length === 0) return -1;
        const match = findChapterAtMs(decorated, positionMs);
        return match?.index ?? -1;
    });

    // Sheet root element — used for focus-on-open and focus-trap (finding #1).
    let sheetEl = $state<HTMLElement | null>(null);
    // Chapter list container — used to scroll the active chapter into view on open
    // (finding #10).
    let chapterListEl = $state<HTMLElement | null>(null);

    // When the sheet opens: move focus into it and scroll the active chapter
    // into view (findings #1, #10).
    $effect(() => {
        if (!open) return;
        void tick().then(() => {
            sheetEl?.focus();
            if (chapterListEl && activeIndex >= 0) {
                const activeEl = chapterListEl.children[activeIndex] as HTMLElement | undefined;
                activeEl?.scrollIntoView({ block: 'nearest' });
            }
        });
    });

    // Focus trap: constrain Tab/Shift+Tab within the sheet while it is open
    // (finding #1).
    function handleSheetKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            e.preventDefault();
            onclose();
            return;
        }
        if (e.key !== 'Tab' || !sheetEl) return;
        const focusable = Array.from(
            sheetEl.querySelectorAll<HTMLElement>(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
            ),
        ).filter((el) => !el.hasAttribute('disabled'));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
            if (document.activeElement === first) {
                e.preventDefault();
                last.focus();
            }
        } else {
            if (document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    }

    function seekTo(chapter: MusicChapter): void {
        onseek(chapter.startMs);
    }

    function formatRange(chapter: MusicChapter): string {
        const start = formatChapterTime(chapter.startMs);
        if (chapter.endMs !== undefined && chapter.endMs > chapter.startMs)
            return `${start} – ${formatChapterTime(chapter.endMs)}`;
        return start;
    }

    function handleBackdropClick(e: MouseEvent): void {
        if (e.target === e.currentTarget) onclose();
    }

    function handleKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            e.preventDefault();
            onclose();
        }
    }

    // The sheet is typically opened via a button that keeps focus — keydown
    // bound to the sheet div never sees Escape from outside. Listen on the
    // window while the sheet is open so Escape reliably closes it.
    $effect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onclose();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    });
</script>

{#if open}
    <!-- Backdrop -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="fixed inset-0 bg-black/60 backdrop-blur-sm"
        style="z-index: {Z.MUSIC_SHEET};"
        transition:fade={{ duration: 180 }}
        onclick={handleBackdropClick}
        onkeydown={handleKeydown}>
    </div>

    <!-- Sheet -->
    <div
        bind:this={sheetEl}
        role="dialog"
        aria-label={m.music_chapters_aria()}
        aria-modal="true"
        tabindex="-1"
        class="fixed inset-x-0 bottom-0 flex max-h-[75vh] flex-col rounded-t-2xl border-t border-surface-700/50 bg-surface-900 shadow-2xl"
        style="z-index: {Z.MUSIC_SHEET_CONTENT}; padding-bottom: env(safe-area-inset-bottom);"
        transition:fly={{ y: 400, duration: 220 }}
        onkeydown={handleSheetKeydown}>
        <!-- Grab handle + title -->
        <div class="flex items-center justify-between border-b border-surface-700/50 px-4 py-3">
            <div>
                <h2 class="text-sm font-semibold text-white">{heading}</h2>
                <p class="text-xs text-surface-400">
                    {chapters.length}
                    {chapters.length === 1 ? 'section' : 'sections'}
                </p>
            </div>
            <button
                type="button"
                class="flex h-9 w-9 items-center justify-center rounded-full text-surface-400 transition-colors hover:bg-surface-800 hover:text-white"
                aria-label={m.music_close_chapters_aria()}
                onclick={onclose}>
                <Icon src={XMark} class="h-5 w-5" />
            </button>
        </div>

        <!-- Chapter list -->
        <ul bind:this={chapterListEl} class="flex-1 overflow-y-auto overscroll-contain py-1">
            {#each decorated as chapter, i (i)}
                {@const isActive = i === activeIndex}
                <li>
                    <button
                        type="button"
                        class="group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors {isActive
                            ? 'bg-primary-500/15'
                            : 'hover:bg-surface-800'}"
                        onclick={() => {
                            seekTo(chapter);
                            onclose();
                        }}>
                        <span
                            class="w-14 shrink-0 tabular-nums text-xs {isActive
                                ? 'text-primary-300'
                                : 'text-surface-500'}">
                            {formatChapterTime(chapter.startMs)}
                        </span>
                        <span class="min-w-0 flex-1">
                            <span
                                class="block truncate text-sm font-medium {isActive
                                    ? 'text-white'
                                    : 'text-surface-100'}">
                                {chapter.title || `Chapter ${i + 1}`}
                            </span>
                            {#if chapter.artist}
                                <span class="block truncate text-xs text-surface-400">
                                    {chapter.artist}
                                </span>
                            {/if}
                        </span>
                        {#if isActive}
                            <span
                                class="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-primary-300">
                                Now
                            </span>
                        {:else}
                            <span
                                class="shrink-0 text-[10px] text-surface-500 opacity-0 transition-opacity group-hover:opacity-100">
                                {formatRange(chapter)}
                            </span>
                        {/if}
                    </button>
                </li>
            {/each}
        </ul>
    </div>
{/if}
