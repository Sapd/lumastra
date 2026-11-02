<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * ModalAudiobookSeries — the rest of the series, as covers.
     *
     * Shaped like the Similar Movies rail because a poster carousel is the right
     * shape for "here are the other ones", but it is NOT the same thing and must
     * not be read as one:
     *
     *   Similar Movies  ranked recommendations — order means relevance (81%, 80%…)
     *   This rail       an ordered sequence    — order means READING ORDER
     *
     * Which is why the per-book state is the point rather than a decoration. On
     * book 4 of 7 the question is "which have I finished and what is next", and a
     * similarity score cannot answer it. Audiobooks also have no similarity
     * signal at all — AI suggestions are bound to video media types — so the
     * series relation is the only real one there is.
     */
    import { Icon, Check, Play } from 'svelte-hero-icons';
    import type { AudiobookPreview } from '$lib/schemas/api-audiobook-preview';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        books?: AudiobookPreview[];
        /** The book whose modal this is, so it can be marked rather than opened. */
        currentMediaId?: string | undefined;
        onopen?: (book: AudiobookPreview) => void;
    }

    let { books = [], currentMediaId = undefined, onopen = undefined }: Props = $props();

    function fraction(book: AudiobookPreview): number {
        const duration = book.progress?.durationMs ?? 0;
        const position = book.progress?.positionMs ?? 0;
        if (duration <= 0 || position <= 0) return 0;
        return Math.min(1, position / duration);
    }

    const started = (book: AudiobookPreview): boolean =>
        !book.progress?.finished && (book.progress?.positionMs ?? 0) > 0;

    /** Match the catalog's next-up rule: an in-progress book wins, then reading order. */
    const nextUpId = $derived(
        (books.find(started) ?? books.find((book) => !book.progress?.finished))?.id,
    );
</script>

{#if books.length > 1}
    <section class="mt-4" aria-labelledby="audiobook-series-rail-heading">
        <h3 id="audiobook-series-rail-heading" class="mb-2 text-sm font-semibold text-surface-200">
            {m.modal_audiobook_series_rail()}
        </h3>
        <div class="flex gap-3 overflow-x-auto pb-2" data-testid="audiobook-series-rail">
            {#each books as book (book.id)}
                {@const isCurrent = book.id === currentMediaId}
                {@const progress = fraction(book)}
                <button
                    type="button"
                    data-testid="audiobook-series-book"
                    data-current={isCurrent ? 'true' : undefined}
                    aria-current={isCurrent ? 'true' : undefined}
                    disabled={isCurrent}
                    class="group w-24 shrink-0 text-left {isCurrent
                        ? 'cursor-default'
                        : 'cursor-pointer'}"
                    onclick={() => !isCurrent && onopen?.(book)}>
                    <div
                        class="relative aspect-square w-full overflow-hidden rounded-md bg-surface-800 {isCurrent
                            ? 'ring-2 ring-primary-400'
                            : 'ring-1 ring-surface-700 group-hover:ring-surface-500'}">
                        {#if book.images.primary?.href}
                            <img
                                src={book.images.primary?.href}
                                alt=""
                                loading="lazy"
                                class="h-full w-full object-cover" />
                        {/if}

                        {#if book.progress?.finished}
                            <span
                                class="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-success-500 text-white shadow"
                                data-testid="series-book-finished"
                                title={m.modal_audiobook_series_finished()}>
                                <Icon src={Check} class="h-3 w-3" solid />
                            </span>
                        {:else if book.id === nextUpId}
                            <span
                                class="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary-500 text-white shadow"
                                data-testid="series-book-next"
                                title={m.modal_audiobook_series_next()}>
                                <Icon src={Play} class="h-3 w-3" solid />
                            </span>
                        {/if}

                        <!-- Part-way through: the bar is the only thing that
                             separates "started" from "untouched" at this size. -->
                        {#if progress > 0}
                            <span
                                class="absolute inset-x-0 bottom-0 h-1 bg-surface-900/70"
                                aria-hidden="true">
                                <span
                                    class="block h-full bg-primary-400"
                                    data-testid="series-book-progress"
                                    style:width="{progress * 100}%"></span>
                            </span>
                        {/if}
                    </div>

                    <p
                        class="mt-1 line-clamp-2 text-xs {isCurrent
                            ? 'text-primary-300'
                            : 'text-surface-300 group-hover:text-white'}">
                        {book.audiobook.series?.position != null
                            ? `${book.audiobook.series?.position}. `
                            : ''}{book.title}
                    </p>
                    {#if isCurrent}
                        <!-- surface-500 on surface-900 failed to read as text at
                             10px; this is the one label that says which cover you
                             are looking out FROM. -->
                        <p class="text-[11px] font-medium text-primary-400/90">
                            {m.modal_audiobook_series_current()}
                        </p>
                    {/if}
                </button>
            {/each}
        </div>
    </section>
{/if}
