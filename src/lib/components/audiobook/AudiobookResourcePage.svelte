<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import AudiobookCardGrid from './AudiobookCardGrid.svelte';
    import { getAudiobookResourceBooks } from '$lib/api/audiobooks';
    import type { AudiobookResourceData } from '../../../routes/audiobooks/resource-load';
    import type { AudiobookPreview } from '$lib/schemas/api-audiobook-preview';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages';

    let { data }: { data: AudiobookResourceData } = $props();
    let appended = $state<{
        key: string;
        books: AudiobookPreview[];
        offset: number;
        hasMore: boolean;
    } | null>(null);
    let loadingKey = $state<string | null>(null);
    let failedKey = $state<string | null>(null);
    const key = $derived(`${data.kind}:${data.detail.id}`);
    const loading = $derived(loadingKey === key);
    const failed = $derived(failedKey === key);
    const tail = $derived(appended?.key === key ? appended : null);
    const books = $derived([...data.books.items, ...(tail?.books ?? [])]);
    const hasMore = $derived(tail?.hasMore ?? data.books.page.hasMore);
    const nextUp = $derived('nextUp' in data.detail ? data.detail.nextUp : null);
    async function loadMore(): Promise<void> {
        if (loading || !hasMore) return;
        const requestedKey = key;
        const offset = tail?.offset ?? (data.books.page.offset ?? 0) + data.books.items.length;
        const previous = tail?.books ?? [];
        loadingKey = requestedKey;
        failedKey = null;
        try {
            const result = await getAudiobookResourceBooks(data.kind, data.detail.id, offset);
            if (requestedKey !== key) return;
            if (!result.data || result.error) {
                failedKey = requestedKey;
                return;
            }
            appended = {
                key,
                books: [...previous, ...result.data.items],
                offset: (result.data.page.offset ?? offset) + result.data.items.length,
                hasMore: result.data.page.hasMore && result.data.items.length > 0,
            };
        } catch {
            if (requestedKey === key) failedKey = requestedKey;
        } finally {
            if (requestedKey === key) loadingKey = null;
        }
    }
</script>

<svelte:head><title>{data.detail.name} · {m.audiobooks_title()}</title></svelte:head>
<div class="mx-auto max-w-[1800px] px-4 pb-20 pt-8 lg:pt-20">
    <a href={resolve('/audiobooks')} class="text-primary-300 hover:underline"
        >← {m.viewer_audiobooks_library()}</a>
    <h1 class="mt-4 text-2xl font-semibold">{data.detail.name}</h1>
    <p class="mb-6 text-surface-400">{m.audiobooks_book_count({ count: data.detail.bookCount })}</p>
    {#if nextUp}
        <section aria-label={m.audiobook_catalog_next_up()} class="mb-8">
            <h2 class="mb-3 text-lg font-semibold">{m.audiobook_catalog_next_up()}</h2>
            <AudiobookCardGrid books={[nextUp]} nextUpId={nextUp.id} />
        </section>
    {/if}
    {#if books.length}
        <AudiobookCardGrid {books} nextUpId={nextUp?.id} />
    {:else}
        <p>{m.audiobooks_empty()}</p>
    {/if}
    {#if failed}<p role="alert" class="mt-4">{m.viewer_audiobooks_load_error()}</p>{/if}
    {#if hasMore}
        <button
            type="button"
            class="mt-6 rounded bg-surface-700 px-4 py-2"
            disabled={loading}
            onclick={() => void loadMore()}>
            {loading ? m.audiobooks_loading() : failed ? m.common_retry() : m.section_load_more()}
        </button>
    {/if}
</div>
