<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Admin IA redesign, spec §6: ONE shared shell for every object-type detail
  view (task, run, media item, node, …). Wide screens render it as a
  right slide-in panel; narrow screens or a direct/shared URL render the
  SAME component filling the page. Callers own the URL-backing
  (`detail-url.ts`'s `openDetail`/`closeDetail`) and the tab content; this
  component only owns the shell chrome (header, tab row, panel-vs-page
  layout, ESC/focus-trap) so every object type gets identical behavior for
  free.

  SSE-patch-safety: this shell NEVER wraps `children` in a `{#key}` block —
  a caller re-rendering the same tab with fresher data (an SSE patch) must
  never remount the tab content. Only a genuinely different object (a new
  `titleText`/`tabs`/`activeTab` from the caller) changes what's rendered,
  and even then only by prop change, not by destroying/recreating this shell.
-->
<script lang="ts">
    import type { Snippet } from 'svelte';
    import { fly } from 'svelte/transition';
    import { Icon, XMark, ArrowLeft } from 'svelte-hero-icons';
    import { Z } from '$lib/utils/z-index.js';
    import { trapFocus } from '$lib/utils/focus-trap.js';
    // Imported directly (not via the ui/ barrel) — the barrel re-exports
    // dozens of unrelated components, which needlessly drags their own
    // dependency graphs into every consumer of this shell.
    import Tabs from '$lib/components/ui/Tabs.svelte';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';

    export interface DetailTab {
        id: string;
        label: string;
        badge?: number;
    }

    interface Props {
        titleText: string;
        subtitle?: string;
        /**
         * One or two sentences on what the thing IS, under the subtitle. Wraps
         * rather than truncating — a description cut off mid-sentence is worse
         * than none, and this is the only line in the header meant to be read
         * rather than scanned.
         */
        description?: string;
        /** `readonly` so callers can pass an `as const` tab list (which is how
         *  every caller declares one); the panel only maps over it. */
        tabs: readonly DetailTab[];
        activeTab: string;
        onTabChange: (id: string) => void;
        /** `'auto'` (default): panel on wide viewports, page below the breakpoint. */
        mode?: 'auto' | 'panel' | 'page';
        /** Panel mode: ESC / backdrop / × call this. Page mode: ESC calls this too, when supplied. */
        onclose?: () => void;
        /** Page mode only: renders a "← back" row above the header. */
        backHref?: string;
        backLabel?: string;
        headerActions?: Snippet;
        children: Snippet<[string]>;
    }

    let {
        titleText,
        subtitle,
        description,
        tabs,
        activeTab,
        onTabChange,
        mode = 'auto',
        onclose,
        backHref,
        backLabel,
        headerActions,
        children,
    }: Props = $props();

    const WIDE_QUERY = '(min-width: 1024px)';

    function matchesWide(): boolean {
        return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia(WIDE_QUERY).matches
            : true;
    }

    // Only read synchronously at init (not reactive by itself) — the $effect
    // below keeps it live. 'auto' mode only ever mounts client-side in
    // practice (its sole caller gates on shallow-routing `page.state`, which
    // SvelteKit guarantees is empty during SSR), so this never causes a
    // hydration mismatch in the panel-vs-page decision.
    let isWide = $state(matchesWide());

    $effect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const mq = window.matchMedia(WIDE_QUERY);
        isWide = mq.matches;
        function onChange(e: MediaQueryListEvent): void {
            isWide = e.matches;
        }
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    });

    let effectiveMode = $derived(mode === 'auto' ? (isWide ? 'panel' : 'page') : mode);

    let tabItems = $derived(tabs.map((t) => ({ id: t.id, label: t.label, badge: t.badge })));

    function handleKeydown(e: KeyboardEvent): void {
        if (e.key !== 'Escape') return;
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        if (!onclose) return;
        e.stopPropagation();
        onclose();
    }
</script>

{#snippet header()}
    <div class="flex items-center justify-between gap-3">
        <div class="min-w-0 flex-1">
            <h2 id="detail-panel-title" class="truncate text-base font-semibold text-surface-100">
                {titleText}
            </h2>
            {#if subtitle}
                <p class="truncate text-xs text-surface-500">{subtitle}</p>
            {/if}
            {#if description}
                <p class="mt-1 max-w-2xl text-xs leading-relaxed text-surface-400">
                    {description}
                </p>
            {/if}
        </div>
        {#if headerActions}
            {@render headerActions()}
        {/if}
        {#if onclose}
            <button
                type="button"
                class="rounded p-1.5 text-surface-400 hover:bg-surface-800 hover:text-surface-200"
                aria-label={m.close()}
                data-autofocus
                onclick={() => onclose?.()}>
                <Icon src={XMark} class="h-4 w-4" />
            </button>
        {/if}
    </div>
{/snippet}

{#snippet tabsRow()}
    <!-- remember={false}: a detail view opens on its first tab (Overview)
         unless the URL names one. Remembering the last tab per pathname made a
         plain /admin/tasks/<id> link land on Settings for whoever last looked
         at Settings — and only the URL can be shared, not that memory.
         wrap: a detail view has five or six short tabs; scrolled sideways on a
         phone, the active one could sit hidden behind "More". -->
    {#if tabs.length > 1}
        <Tabs
            items={tabItems}
            active={activeTab}
            onchange={(d) => onTabChange(d.id)}
            variant="underline"
            size="sm"
            syncToUrl
            urlParam="tab"
            remember={false}
            wrap />
    {/if}
{/snippet}

{#if effectiveMode === 'panel'}
    <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-panel-title"
        tabindex="-1"
        class="fixed inset-0 flex justify-end"
        style="z-index: {Z.MODAL}"
        onkeydown={handleKeydown}
        use:trapFocus>
        <div
            class="absolute inset-0 bg-black/40"
            role="presentation"
            tabindex="-1"
            onclick={() => onclose?.()}>
        </div>
        <div
            class="relative flex h-full w-full max-w-2xl flex-col overflow-y-auto bg-surface-900 shadow-2xl"
            transition:fly={{ x: 560, duration: 200 }}>
            <div class="sticky top-0 z-10 border-b border-surface-700/50 bg-surface-900 px-4 py-3">
                {@render header()}
            </div>
            {#if tabs.length > 1}
                <div class="border-b border-surface-700/50 px-4 pt-3">
                    {@render tabsRow()}
                </div>
            {/if}
            <div class="flex-1 p-4">
                {@render children(activeTab)}
            </div>
        </div>
    </div>
{:else}
    <div>
        {#if backHref}
            <div class="mb-4">
                <a
                    href={resolve(backHref)}
                    class="inline-flex items-center gap-1.5 text-sm text-surface-400 transition-colors hover:text-surface-200">
                    <Icon src={ArrowLeft} class="h-4 w-4" />
                    {backLabel ?? m.back()}
                </a>
            </div>
        {/if}
        <div class="mb-6">
            {@render header()}
        </div>
        {#if tabs.length > 1}
            <div class="mb-6">
                {@render tabsRow()}
            </div>
        {/if}
        <div>
            {@render children(activeTab)}
        </div>
    </div>
{/if}
