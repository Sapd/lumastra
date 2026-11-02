<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts" generics="T">
    import { onMount, untrack, type Snippet } from 'svelte';
    import { BoundedRetryLoader } from '$lib/components/players/bounded-retry-loader.svelte';
    import Skeleton from './Skeleton.svelte';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        load: () => Promise<T>;
        minHeight: string;
        children: Snippet<[T]>;
        controls?: Snippet;
    }
    let { load, minHeight, children, controls }: Props = $props();
    let failed = $state(false);
    // One loader per mounted widget; its constructor does no network work.
    const module = new BoundedRetryLoader<T>(() => load().then((value) => ({ default: value })), {
        onAttemptFailed: (attempt, maximum) => {
            failed = attempt === maximum;
        },
    });
    onMount(() => {
        untrack(() => module.notify(true));
        return () => {
            module.notify(false);
            module.dispose();
        };
    });
    function retry(): void {
        // Browsers can cache a failed module fetch. A fresh document reliably
        // revalidates the module graph after connectivity or a deploy changes.
        window.location.reload();
    }
</script>

{#if module.value !== null}
    {@render children(module.value)}
{:else}
    <div data-deferred-widget-pending style:min-height={minHeight} aria-busy={!failed}>
        {@render controls?.()}
        {#if failed}
            <p role="status">{m.error_default()}</p>
            <button type="button" class="btn variant-soft" onclick={retry}>{m.retry()}</button>
        {:else}
            <span class="sr-only">{m.loading_default()}</span>
            <div class="flex flex-col gap-4 p-4" aria-hidden="true">
                <Skeleton width="w-40" height="h-6" />
                <Skeleton width="w-full" height="h-48" />
            </div>
        {/if}
    </div>
{/if}
