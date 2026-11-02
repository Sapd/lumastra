<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	LazyMount.svelte

	Defers mounting its children until the wrapper scrolls near the viewport
	(IntersectionObserver), rendering a reserved-height placeholder until then.

	Used to break the front-page load-time request/hydration storm: below-the-fold
	widgets that self-fetch on mount don't mount (and therefore don't fetch) until
	the user scrolls near them. The reserved min-height avoids layout shift (CLS)
	when the real content finally mounts.

	SSR-safe: renders the empty placeholder during SSR AND on the first client
	render (mounted starts false), so hydration matches. The observer then mounts
	children — effectively immediately for content already in / near the viewport
	(IntersectionObserver fires an initial callback), lazily for deeper content.

	Once mounted it never unmounts, so the child's own lifecycle/state is stable.
-->
<script lang="ts">
    import Skeleton from './Skeleton.svelte';

    interface Props {
        /** Reserved placeholder height while unmounted (any CSS length). */
        minHeight?: string;
        /**
         * How far outside the viewport to begin mounting. A generous margin
         * pre-mounts content just below the fold so scrolling stays smooth and
         * near-fold widgets mount essentially immediately.
         */
        rootMargin?: string;
        children: import('svelte').Snippet;
        /** Optional placeholder for compact rows with their own reserved height. */
        placeholder?: import('svelte').Snippet;
    }

    let { minHeight = '320px', rootMargin = '600px 0px', children, placeholder }: Props = $props();

    let mounted = $state(false);
    let el: HTMLDivElement | undefined;

    $effect(() => {
        // Once mounted we never unmount — stop observing.
        if (mounted) return;
        // Environments without IntersectionObserver (old/embedded WebViews):
        // mount eagerly so content is never withheld.
        if (typeof IntersectionObserver === 'undefined' || !el) {
            mounted = true;
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    mounted = true;
                    observer.disconnect();
                }
            },
            { rootMargin },
        );
        observer.observe(el);
        return () => observer.disconnect();
    });
</script>

<div bind:this={el} style:min-height={mounted ? undefined : minHeight}>
    {#if mounted}
        {@render children()}
    {:else if placeholder}
        {@render placeholder()}
    {:else}
        <!-- Shimmer placeholder instead of empty reserved space — reads as
             "loading" rather than a blank gap. Skeleton.svelte already disables
             its own shimmer animation under prefers-reduced-motion. -->
        <div class="flex h-full flex-col gap-4 p-4" aria-hidden="true">
            <Skeleton width="w-40" height="h-6" />
            <div class="flex gap-4 overflow-hidden">
                {#each Array.from({ length: 4 }) as _, i (i)}
                    <Skeleton width="w-36" height="h-48" rounded="lg" class="shrink-0" />
                {/each}
            </div>
        </div>
    {/if}
</div>
