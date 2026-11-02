<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import UniversalMediaCard from '$lib/components/ui/UniversalMediaCard.svelte';
    import { audiobookCardItem, openAudiobook } from '$lib/utils/audiobook-catalog';
    import { resolveAudiobookEntryClick } from '$lib/utils/audiobook-entry-click';
    import { playAudiobook, audiobookStartFailureMessage } from '$lib/services/audiobook-playback';
    import { toasts } from '$lib/stores/toast.store';
    import { goto } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages';
    import type { AudiobookPreview } from '$lib/schemas/api-audiobook-preview';

    let { books, nextUpId }: { books: AudiobookPreview[]; nextUpId?: string } = $props();

    function open(book: AudiobookPreview): void {
        const click = resolveAudiobookEntryClick(book);
        if (click.action === 'series') void goto(resolve(`/audiobooks/series/${click.seriesId}`));
        else openAudiobook(book);
    }
    function play(book: AudiobookPreview): void {
        void playAudiobook(book.catalogId).then((started) => {
            if (!started) toasts.error(audiobookStartFailureMessage());
        });
    }
</script>

<div
    class="grid grid-cols-2 gap-4 min-[420px]:grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
    {#each books as book, index (`${book.id}:${index}`)}
        <div
            class="relative rounded-lg"
            class:ring-2={book.id === nextUpId}
            class:ring-primary-400={book.id === nextUpId}>
            <UniversalMediaCard
                item={audiobookCardItem(book)}
                variant="poster"
                onclick={() => open(book)}
                onplay={() => play(book)} />
            {#if book.id === nextUpId}
                <span
                    data-testid="audiobook-next-up"
                    class="absolute left-2 top-2 rounded bg-primary-600 px-2 py-1 text-xs text-white"
                    >{m.audiobook_catalog_next_up()}</span>
            {:else if book.audiobook.series?.bookCount !== undefined}
                <span
                    class="pointer-events-none absolute left-2 top-2 rounded bg-surface-900/80 px-1.5 py-0.5 text-xs text-surface-100"
                    >{m.audiobooks_book_count({ count: book.audiobook.series.bookCount })}</span>
            {/if}
        </div>
    {/each}
</div>
