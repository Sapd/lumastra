<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * ModalAudiobookDetails — the audiobook-shaped half of the media detail modal.
     *
     * Renders what a book actually is (author, narrator, series position,
     * publisher) plus its table of contents. None of this has a home on
     * ModalBody: its metadata row is built around ratings/runtime/genres, and an
     * audiobook has authors and narrators instead of a cast.
     *
     * The chapter list is COLLAPSED by default and shows a count. A real library
     * book runs to ~100 chapters — rendering that expanded pushes the actions and
     * the description off screen, and the operator opening a detail modal wants
     * "how is this book divided" before "chapter 61 starts at 4:12:07". Expanded,
     * the list is scroll-bounded so it never grows the modal.
     *
     * Rows are inert text, not seek buttons: this modal has no playback session to
     * seek. The full-screen player owns seeking (MusicChapterSheet).
     */
    import { Icon, ChevronDown, ChevronUp } from 'svelte-hero-icons';
    import type { AudiobookChapter, AudiobookPersonRef, AudiobookSeriesRef } from '$lib/schemas/api-audiobook';
    import {
        chapterTitlesAreUninformative,
        formatChapterLabels,
    } from '$lib/utils/audiobook-timeline';
    import { untrack, type Snippet } from 'svelte';
    import { convertSecondsToHoursAndMinutes } from '../../../utility';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        authors?: AudiobookPersonRef[];
        narrators?: AudiobookPersonRef[];
        publisher?: string | undefined;
        /** Derived series/shelf name (ABS series → folder → absent). */
        series?: AudiobookSeriesRef | null;
        abridged?: boolean | undefined;
        /**
         * Server-reported chapter count. Authoritative over `chapters.length` —
         * a surface may report the count without shipping the list.
         */
        chapterCount?: number;
        chapters?: AudiobookChapter[];
        /**
         * Open the table of contents on mount.
         *
         * The caller passes true for a book with no description, where the
         * modal would otherwise be half empty — the list is the only thing left
         * with something to say.
         */
        /** Publication year — a labelled row here, not a bare number below. */
        year?: number | undefined;
        /** Total listening length in milliseconds. */
        durationMs?: number | undefined;
        expandChapters?: boolean;
        /**
         * Rendered between the identity rows and the parts list.
         *
         * The series rail belongs there and nowhere else: it is the most
         * actionable thing in the modal ("what do I read next"), and the parts
         * list is the least, so the rail must not sit below it. A snippet keeps
         * this component owning its own vertical rhythm instead of the caller
         * reaching in to interleave two siblings.
         */
        afterIdentity?: Snippet;
    }

    let {
        authors = [],
        narrators = [],
        publisher = undefined,
        series = undefined,
        abridged = undefined,
        chapterCount = 0,
        chapters = [],
        year = undefined,
        durationMs = undefined,
        expandChapters = false,
        afterIdentity = undefined,
    }: Props = $props();

    // `untrack`: this is the INITIAL state only. Following the prop after
    // mount would fight the user's own toggle.
    /**
     * `expandChapters` is passed when the modal has no synopsis to show — a fair
     * rule for real chapters with real names, and backwards for file splits: an
     * absent description would promote 555 rows of "<book title> - 001" to the
     * most prominent thing in the modal. Opening the list stays one click away.
     *
     * `dividedIntoParts` is not available at init (it derives from props), so
     * this is an effect on the FIRST resolution rather than an initial value.
     */
    let chaptersExpanded = $state(untrack(() => expandChapters && !partsAtInit()));

    /**
     * The titles the "are these real chapters or file splits?" test may read.
     *
     * The server's invented tail span is excluded: it carries an empty title on
     * purpose (the client owns the wording), and an empty string collapses the
     * shared prefix `formatChapterLabels` strips — which would put the repeated
     * book title back on all 555 rows of a split book.
     */
    function realChapterTitles(list: readonly AudiobookChapter[]): string[] {
        return list.filter((chapter) => chapter.synthetic !== true).map((c) => c.name ?? '');
    }

    function partsAtInit(): boolean {
        return (
            chapters.length > 0 &&
            chapterTitlesAreUninformative(formatChapterLabels(realChapterTitles(chapters)))
        );
    }

    /**
     * Series line: "Harry Potter #1". The sequence is dropped when absent rather
     * than defaulting to 1 — a standalone book in a folder-derived shelf has no
     * position, and inventing one is a factual claim.
     */
    let seriesLine = $derived.by(() => {
        if (!series) return undefined;
        return series.position === null ? series.name : `${series.name} #${series.position}`;
    });

    let hasChapterList = $derived(chapters.length > 0);
    let effectiveChapterCount = $derived(chapterCount || chapters.length);

    /**
     * "555 chapters" was a claim the expanded list immediately broke: those are
     * 3-minute file splits, not chapters, and every title was the book's own
     * name plus an ordinal. Same test the player uses to decide it should label
     * rows by start time.
     */
    let dividedIntoParts = $derived(
        hasChapterList &&
            chapterTitlesAreUninformative(formatChapterLabels(realChapterTitles(chapters))),
    );
    let countLabel = $derived(
        dividedIntoParts
            ? m.modal_audiobook_parts({ count: String(effectiveChapterCount) })
            : m.modal_audiobook_chapters({ count: String(effectiveChapterCount) }),
    );

    let hasAnything = $derived(
        authors.length > 0 ||
            narrators.length > 0 ||
            !!publisher ||
            !!seriesLine ||
            !!year ||
            !!durationMs ||
            abridged === true ||
            effectiveChapterCount > 0,
    );

    /**
     * `h:mm:ss` offset from the start of the book.
     *
     * Deliberately not reusing the music player's `formatChapterTime` (which
     * takes milliseconds and drops the hour segment under one hour): every
     * audiobook chapter offset past the first hour needs the hour field, and a
     * list that switches format between rows 3 and 4 is unreadable.
     */
    function formatOffset(ms: number): string {
        const total = Math.max(0, Math.floor(ms / 1000));
        const h = Math.floor(total / 3600);
        const min = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return `${h}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
</script>

{#if hasAnything}
    <div class="audiobook-details space-y-1.5 text-sm">
        <div class="identity-grid">
            {#if authors.length > 0}
                <div class="flex gap-2">
                    <span class="shrink-0 text-surface-400"
                        >{authors.length === 1
                            ? m.modal_audiobook_author()
                            : m.modal_audiobook_authors()}:</span>
                    <span class="text-surface-200">
                        {#each authors as author, index (author.id)}{#if index > 0},
                            {/if}<a
                                href={resolve(
                                    `/audiobooks/authors/${encodeURIComponent(author.id)}`,
                                )}
                                data-testid="audiobook-author-link"
                                class="underline decoration-surface-500 underline-offset-2 hover:text-white hover:decoration-surface-300"
                                >{author.name}</a
                            >{/each}
                    </span>
                </div>
            {/if}

            {#if narrators.length > 0}
                <div class="flex gap-2">
                    <span class="shrink-0 text-surface-400"
                        >{narrators.length === 1
                            ? m.modal_audiobook_narrator()
                            : m.modal_audiobook_narrators()}:</span>
                    <span class="text-surface-200">
                        {#each narrators as narrator, index (narrator.id)}{#if index > 0},
                            {/if}<a
                                href={resolve(
                                    `/audiobooks/narrators/${encodeURIComponent(narrator.id)}`,
                                )}
                                data-testid="audiobook-narrator-link"
                                class="underline decoration-surface-500 underline-offset-2 hover:text-white hover:decoration-surface-300"
                                >{narrator.name}</a
                            >{/each}
                    </span>
                </div>
            {/if}

            {#if seriesLine}
                <div class="flex gap-2">
                    <span class="shrink-0 text-surface-400">{m.modal_audiobook_series()}:</span>
                    <!-- The most likely thing a listener wants next is book 5, and
                     this was inert text. `/audiobooks` already filters by series. -->
                    <a
                        href={resolve(`/audiobooks/series/${encodeURIComponent(series?.id ?? '')}`)}
                        data-testid="audiobook-series-link"
                        class="text-surface-200 underline decoration-surface-500 underline-offset-2 hover:text-white hover:decoration-surface-300">
                        {seriesLine}
                    </a>
                </div>
            {/if}

            {#if publisher}
                <div class="flex gap-2">
                    <span class="shrink-0 text-surface-400">{m.modal_audiobook_publisher()}:</span>
                    <span class="text-surface-200">{publisher}</span>
                </div>
            {/if}

            {#if year}
                <div class="flex gap-2">
                    <span class="shrink-0 text-surface-400">{m.modal_audiobook_published()}:</span>
                    <span class="text-surface-200">{year}</span>
                </div>
            {/if}

            {#if durationMs}
                <div class="flex gap-2">
                    <span class="shrink-0 text-surface-400">{m.modal_audiobook_length()}:</span>
                    <span class="text-surface-200"
                        >{convertSecondsToHoursAndMinutes(durationMs / 1000)}</span>
                </div>
            {/if}

            {#if abridged === true}
                <div>
                    <span
                        class="inline-flex items-center rounded border border-amber-500/25 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber-400">
                        {m.modal_audiobook_abridged()}
                    </span>
                </div>
            {/if}
        </div>
        {@render afterIdentity?.()}

        {#if effectiveChapterCount > 0}
            <div class="pt-1">
                {#if hasChapterList}
                    <button
                        type="button"
                        class="inline-flex items-center gap-1 rounded text-surface-300 transition-colors hover:text-surface-100"
                        aria-expanded={chaptersExpanded}
                        aria-controls="audiobook-chapter-list"
                        onclick={() => (chaptersExpanded = !chaptersExpanded)}>
                        <span>{countLabel}</span>
                        <Icon
                            src={chaptersExpanded ? ChevronUp : ChevronDown}
                            class="h-4 w-4 shrink-0" />
                    </button>
                {:else}
                    <span class="text-surface-300">{countLabel}</span>
                {/if}

                {#if chaptersExpanded && hasChapterList}
                    <ol
                        id="audiobook-chapter-list"
                        class="mt-2 max-h-64 overflow-y-auto overscroll-contain rounded-lg bg-surface-900/50 py-1">
                        {#each chapters as chapter, index (chapter.index)}
                            <li class="flex items-baseline gap-2 px-3 py-1">
                                <span
                                    class="w-8 shrink-0 text-right text-xs tabular-nums text-surface-500">
                                    {index + 1}
                                </span>
                                <!-- The same signal that renamed the count to
                                     "parts" also decides the row: when every
                                     title is the book's own name plus an ordinal,
                                     the number and the offset already carry all of
                                     it, and the title column is pure repetition.
                                     This is what the player does with these rows.

                                     The untagged tail is the exception. It is
                                     NOT one more part — it is the audio past the
                                     last thing ABS tagged — so it keeps its
                                     label, or a book with both traits shows a
                                     bare offset indistinguishable from a part. -->
                                {#if dividedIntoParts && !chapter.synthetic}
                                    <span class="min-w-0 flex-1 tabular-nums text-surface-200">
                                        {formatOffset(chapter.startMs)}
                                    </span>
                                {:else}
                                    <span class="min-w-0 flex-1 truncate text-surface-200">
                                        {chapter.synthetic
                                            ? m.audiobook_chapter_untagged_tail()
                                            : chapter.name ||
                                              m.modal_audiobook_chapter_fallback({
                                                  number: String(index + 1),
                                              })}
                                    </span>
                                    <span class="shrink-0 text-xs tabular-nums text-surface-500">
                                        {formatOffset(chapter.startMs)}
                                    </span>
                                {/if}
                            </li>
                        {/each}
                    </ol>
                {/if}
            </div>
        {/if}
    </div>
{/if}

<style>
    .identity-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 1.25rem 2rem;
        padding: 1.25rem 0;
        margin-bottom: 1rem;
        border-top: 1px solid rgb(var(--color-surface-700-rgb) / 0.5);
        border-bottom: 1px solid rgb(var(--color-surface-700-rgb) / 0.5);
    }
    .identity-grid > div {
        flex-direction: column;
        gap: 0.35rem;
        min-width: 0;
        overflow-wrap: anywhere;
    }
    .identity-grid > div > span:first-child {
        font-size: 0.75rem;
    }
    .identity-grid a:focus-visible {
        outline: 2px solid var(--color-primary-400);
        outline-offset: 3px;
        border-radius: 2px;
    }
    @media (min-width: 900px) {
        .identity-grid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
        }
    }
</style>
