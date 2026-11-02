<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
    /my/hidden — restore page for Continue-Watching dismissals.

    Renders every item the current user has hidden from their CW row
    plus a "Restore" button that DELETEs the dismissal. Items disappear
    from the grid on success; an undone item will automatically re-
    appear in Continue Watching the next time the row is fetched.
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { invalidate } from '$app/navigation';
    import { SvelteSet } from 'svelte/reactivity';
    import { Icon, EyeSlash, ArrowUturnLeft } from 'svelte-hero-icons';
    import { FALLBACK_IMAGE } from '$lib/constants/images';
    import { toasts } from '$lib/stores/toast.store';
    import type { PageData } from './$types';
    import type { DismissedItem } from '$lib/schemas/api-dismissals-responses';
    import { deleteCwDismissal } from '$lib/api/for-you';

    interface Props {
        data: PageData;
    }

    let { data }: Props = $props();

    // Local overrides for optimistic mutations. Each entry records the
    // targetId of a card the user just restored so we can hide it
    // immediately without waiting for SvelteKit to re-run the server
    // load. Keep successful removals for this page instance so a stale
    // or failed refresh cannot resurrect an already restored card.
    // Uses SvelteSet (reactive) so mutations trigger re-renders without
    // reassignment. The project's ESLint config mandates SvelteSet in
    // Svelte components.
    const pendingRemovals = new SvelteSet<string>();
    const restoring = new SvelteSet<string>();

    // Derived view: the server-supplied list minus any cards we just
    // optimistically removed. Using $derived here (rather than copying
    // `data.items` into a $state on effect) keeps a clean dependency
    // graph and avoids the `state_referenced_locally` Svelte 5 warning.
    let items = $derived(data.items.filter((item) => !pendingRemovals.has(item.targetId)));

    async function handleRestore(item: DismissedItem): Promise<void> {
        if (restoring.has(item.targetId)) return;
        // Track which card is busy so the button shows a loading state
        // and can't be double-clicked.
        restoring.add(item.targetId);

        // Optimistic removal: record the target in pendingRemovals so
        // the derived `items` immediately hides the card. On error we
        // drop it from the set and surface a toast.
        pendingRemovals.add(item.targetId);

        try {
            const { error: restoreErr } = await deleteCwDismissal({
                targetId: item.targetId,
                targetType: item.targetType,
            });
            if (restoreErr) throw new Error(restoreErr);

            // A refresh failure does not undo the successful server mutation.
            // This key is explicitly registered by the page's server loader.
            await invalidate('app:hidden-items').catch((err: unknown) => {
                console.error('[MyHidden] Refresh after restore failed', err);
            });
        } catch (err) {
            // Rollback + tell the user what happened.
            pendingRemovals.delete(item.targetId);
            toasts.error(m.hidden_restore_error());
            console.error('[MyHidden] Restore failed', err);
        } finally {
            restoring.delete(item.targetId);
        }
    }

    function formatDate(iso: string): string {
        try {
            return new Date(iso).toLocaleDateString();
        } catch {
            return iso;
        }
    }
</script>

<svelte:head>
    <title>{m.hidden_page_title()}</title>
</svelte:head>

<div class="max-w-6xl mx-auto px-4 pt-4 lg:pt-20 pb-8">
    <header class="mb-6">
        <h1 class="text-2xl font-semibold flex items-center gap-2">
            <Icon src={EyeSlash} class="w-6 h-6 text-surface-300" />
            {m.hidden_page_title()}
        </h1>
        <p class="text-hint mt-2">
            {m.hidden_page_description()}
        </p>
    </header>

    {#if items.length === 0}
        <div class="bg-surface-800/60 border border-surface-700 rounded-lg p-8 text-center">
            <Icon src={EyeSlash} class="w-12 h-12 mx-auto mb-3 text-surface-500" />
            <p class="text-surface-200 font-medium">
                {m.hidden_empty_title()}
            </p>
            <p class="text-hint mt-1 text-sm">
                {m.hidden_empty_description()}
            </p>
        </div>
    {:else}
        <div
            class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {#each items as item (item.targetId)}
                <div
                    class="flex flex-col bg-surface-800/40 rounded-lg overflow-hidden border border-surface-700">
                    <div class="relative aspect-[2/3] bg-surface-900">
                        <img
                            src={item.images?.poster?.href || FALLBACK_IMAGE}
                            alt={`${item.title} poster`}
                            class="w-full h-full object-cover"
                            loading="lazy"
                            decoding="async" />
                        <div
                            class="absolute top-1 left-1 badge variant-filled-surface text-[10px] px-1.5 py-0.5 uppercase tracking-wide">
                            {item.targetType === 'series'
                                ? m.media_series()
                                : item.targetType === 'audiobook'
                                  ? m.media_audiobook()
                                  : m.media_movie()}
                        </div>
                    </div>
                    <div class="p-3 flex flex-col gap-2">
                        <p class="text-sm font-medium truncate" title={item.title}>
                            {item.title}
                        </p>
                        <p class="text-[11px] text-surface-400">
                            {m.hidden_on({
                                date: formatDate(item.dismissedAt),
                            })}
                        </p>
                        <button
                            type="button"
                            class="btn btn-sm variant-ghost-primary flex items-center justify-center gap-1"
                            onclick={() => handleRestore(item)}
                            disabled={restoring.has(item.targetId)}>
                            {#if restoring.has(item.targetId)}
                                <span class="loading-spinner loading-spinner-primary w-4 h-4"
                                ></span>
                                {m.hidden_restoring()}
                            {:else}
                                <Icon src={ArrowUturnLeft} class="w-4 h-4" />
                                {m.hidden_restore()}
                            {/if}
                        </button>
                    </div>
                </div>
            {/each}
        </div>
    {/if}
</div>
