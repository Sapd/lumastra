<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { untrack } from 'svelte';
    import { browser } from '$app/environment';
    import { fly, fade } from 'svelte/transition';
    import { flip } from 'svelte/animate';
    import { Icon, ArrowPath } from 'svelte-hero-icons';
    import { trapFocus } from '$lib/utils/focus-trap';
    import { Z } from '$lib/utils/z-index';
    import { runSSEBus } from '$lib/stores/run-sse-bus.js';
    import * as m from '$lib/paraglide/messages.js';
    import { resolve } from '$lib/paths';
    import { relativeTime } from '$lib/utils/relative-time';
    import { useNow } from '$lib/utils/use-now.svelte';
    import type { Run } from '$lib/schemas/run.schema.js';
    import type {
        AttentionItem,
        AttentionVerdict,
        RecentlyAddedItem,
    } from '$lib/schemas/api-attention-responses';
    import { z } from 'zod';
    import { apiGet } from '$lib/api/client.js';
    import ActivityRow from './ActivityRow.svelte';
    import RecentlyAddedRow from './RecentlyAddedRow.svelte';
    import AttentionItemRow from './AttentionItemRow.svelte';
    import StreamingSummary from './StreamingSummary.svelte';

    interface Props {
        open: boolean;
        onclose: () => void;
        items: AttentionItem[];
        recentlyAdded: RecentlyAddedItem[];
        onAck: (item: AttentionItem) => void;
        /** Snooze (time-box suppress) an item. */
        onSnooze?: (item: AttentionItem, durationMs: number) => void;
        /** Recently auto-resolved items ("what happened while away"). */
        resolvedHistory?: AttentionItem[];
        /** Overall health verdict (drives the header status dot). */
        verdict?: AttentionVerdict;
        /** True when the attention block couldn't be computed — items/verdict may disagree. */
        unavailable?: boolean;
        /** True until the first poll resolves — drives the loading skeleton. */
        loading?: boolean;
        /** Epoch ms of the last successful refresh (for the "updated …" hint). */
        lastUpdatedAt?: number | null;
        /** True while a refresh is in flight (spins the refresh icon). */
        refreshing?: boolean;
        /** Manual refresh trigger. */
        onRefresh?: () => void;
    }

    let {
        open,
        onclose,
        items,
        recentlyAdded,
        onAck,
        onSnooze,
        resolvedHistory = [],
        verdict = 'healthy',
        unavailable = false,
        loading = false,
        lastUpdatedAt = null,
        refreshing = false,
        onRefresh,
    }: Props = $props();

    const now = useNow();

    // Scroll lock + scrollbar compensation while the drawer is open — mirrors
    // ModalContainer.svelte so the background page doesn't scroll behind the
    // fixed drawer/backdrop. Must lock <html> too: on mobile the root
    // scrolling element is <html>, not <body>.
    let originalOverflow = '';
    let originalHtmlOverflow = '';
    let originalPaddingRight = '';
    $effect(() => {
        if (!browser) return;
        if (open) {
            originalOverflow = document.body.style.overflow;
            originalHtmlOverflow = document.documentElement.style.overflow;
            originalPaddingRight = document.body.style.paddingRight;

            const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

            document.body.style.overflow = 'hidden';
            document.documentElement.style.overflow = 'hidden';
            if (scrollbarWidth > 0) {
                document.body.style.paddingRight = `${scrollbarWidth}px`;
            }
        } else {
            document.body.style.overflow = originalOverflow;
            document.documentElement.style.overflow = originalHtmlOverflow;
            document.body.style.paddingRight = originalPaddingRight;
        }
    });

    // ── Library processing summary (compact, drawer-only) ─────────────────────
    // Lightweight schema — only the aggregate counts needed for the strip.
    const ProcSummarySchema = z.object({
        total: z.number(),
        completed: z.number(),
        in_progress: z.number(),
        pending: z.number(),
        skipped: z.number().optional(),
        obsolete: z.number().optional(),
    });
    const ProcProbeSchema = z.object({ summary: ProcSummarySchema }).passthrough();

    let procSummary = $state<z.infer<typeof ProcSummarySchema> | null>(null);

    // Eligible done = completed + skipped + obsolete (none are remaining work).
    let procDone = $derived(
        procSummary
            ? procSummary.completed + (procSummary.skipped ?? 0) + (procSummary.obsolete ?? 0)
            : 0,
    );
    let procTotal = $derived(procSummary?.total ?? 0);
    let procPct = $derived(
        procTotal > 0 ? Math.min(100, Math.round((procDone / procTotal) * 100)) : 0,
    );
    let procInFlight = $derived(procSummary ? procSummary.in_progress + procSummary.pending : 0);
    let procIsActive = $derived(procInFlight > 0);

    async function loadProc(): Promise<void> {
        const { data } = await apiGet('/api/admin/library/coverage?limit=1', ProcProbeSchema);
        if (data) procSummary = data.summary;
    }

    // Poll while the drawer is open; stop when it closes.
    $effect(() => {
        if (!open) return;
        void loadProc();
        const t = setInterval(() => void loadProc(), 20_000);
        return () => clearInterval(t);
    });

    const verdictStyle = $derived(
        verdict === 'critical'
            ? {
                  dot: 'bg-red-500',
                  text: 'text-red-300',
                  label: m.admin_ops_verdict_critical(),
              }
            : verdict === 'degraded'
              ? {
                    dot: 'bg-amber-400',
                    text: 'text-amber-300',
                    label: m.admin_ops_verdict_degraded(),
                }
              : {
                    dot: 'bg-green-500',
                    text: 'text-surface-400',
                    // When healthy and processing is in-flight, the reassurance
                    // second sentence replaces the generic healthy label so the
                    // admin sees positive context, not just "nothing needs you".
                    label: procIsActive
                        ? m.admin_ops_verdict_healthy_processing()
                        : m.admin_ops_verdict_healthy(),
                },
    );

    const SEVERITY_RANK: Record<string, number> = {
        critical: 0,
        warning: 1,
        info: 2,
    };

    const updatedLabel = $derived(
        lastUpdatedAt ? relativeTime(new Date(lastUpdatedAt).toISOString(), now.value) : '',
    );

    // ── SSE reactivity bridge ─────────────────────────────────────────────────
    // runSSEBus getters are not $state — bump sseVersion to force $derived.by
    // re-evaluation. Mirrors ActiveRunsPanel.svelte:1-29.
    let sseVersion = $state(0);

    // Row keys that survive a new episode joining a grouped row (its lead id
    // changes then); a series that appears twice (two separate imports) gets "#2".
    const recentlyAddedRows = $derived.by(() => {
        const seen: Record<string, number> = {};
        return recentlyAdded.map((item) => {
            const base = item.episodeCount && item.seriesId ? `series:${item.seriesId}` : item.id;
            const n = (seen[base] ?? 0) + 1;
            seen[base] = n;
            return { item, key: n === 1 ? base : `${base}#${n}` };
        });
    });

    // ── Recent completions (30s retention) ───────────────────────────────────
    interface Completion {
        run: Run;
        state: 'completed' | 'failed';
        at: number;
    }

    let completions = $state<Completion[]>([]);

    const COMPLETION_TTL = 30_000;

    function pruneCompletions(): void {
        const now = Date.now();
        completions = completions.filter((c) => now - c.at < COMPLETION_TTL);
    }

    function collectCompletions(): void {
        const now = Date.now();
        const existing = new Set(completions.map((c) => c.run.id));
        const incoming: Completion[] = [];
        for (const run of runSSEBus.runs.values()) {
            if (run.trigger?.kind !== 'manual') continue;
            if (run.state !== 'completed' && run.state !== 'failed') continue;
            if (existing.has(run.id)) continue;
            incoming.push({ run, state: run.state, at: now });
        }
        if (incoming.length > 0) {
            completions = [...completions, ...incoming];
        }
        pruneCompletions();
    }

    // ── Lazy SSE lifecycle — connect only while the drawer is open ────────────
    // The cleanup fn runs both when open flips false AND on component destroy,
    // so there is no leak and no double-subscribe.
    $effect(() => {
        if (!open) return;

        runSSEBus.connect();
        // Refresh the reactive snapshot on open. MUST be untracked: `+= 1` reads
        // sseVersion, and a tracked read here would make this effect depend on a
        // value it writes → infinite re-run (effect_update_depth_exceeded).
        untrack(() => {
            sseVersion += 1;
        });

        const unsubChange = runSSEBus.onAnyChange(() => {
            sseVersion += 1;
        });

        const unsubTransition = runSSEBus.onTransitionChange(() => {
            collectCompletions();
        });

        const pruneTimer = setInterval(() => {
            pruneCompletions();
        }, 5_000);

        return () => {
            unsubChange();
            unsubTransition();
            clearInterval(pruneTimer);
            runSSEBus.disconnect();
            completions = []; // drop stale completions so reopening starts clean
        };
    });

    // ── Derived projections ───────────────────────────────────────────────────
    const activeManual = $derived.by((): Run[] => {
        void sseVersion;
        return runSSEBus.activeRuns.filter((r) => r.trigger?.kind === 'manual');
    });

    const activeManualIds = $derived(new Set(activeManual.map((r) => r.id)));

    // Newest-first; exclude any run still in activeManual (shouldn't happen, but guard).
    const visibleCompletions = $derived.by((): Completion[] => {
        void sseVersion;
        return [...completions]
            .filter((c) => !activeManualIds.has(c.run.id))
            .sort((a, b) => b.at - a.at);
    });

    const rankOf = (s: string): number => SEVERITY_RANK[s] ?? 99;
    const bySeverity = (a: AttentionItem, b: AttentionItem): number =>
        rankOf(a.severity) - rankOf(b.severity);
    // Active = needs you now: neither acked nor snoozed (matches the server's unread/verdict).
    const activeItems = $derived(items.filter((i) => !i.acked && !i.snoozed).sort(bySeverity));
    // Suppressed = acked or snoozed — still listed, but folded away.
    const suppressedItems = $derived(items.filter((i) => i.acked || i.snoozed).sort(bySeverity));

    // Badge colour follows the highest unacked severity (list is sorted critical-first),
    // so an all-info badge doesn't scream red.
    const attentionBadgeClass = $derived(
        activeItems[0]?.severity === 'critical'
            ? 'bg-red-900/60 text-red-300'
            : activeItems[0]?.severity === 'warning'
              ? 'bg-amber-900/50 text-amber-200'
              : 'bg-blue-900/50 text-blue-200',
    );

    const activityCount = $derived(activeManual.length + visibleCompletions.length);

    // First load with nothing yet known — distinguish "loading" from "all clear".
    const showSkeleton = $derived(
        loading && items.length === 0 && recentlyAdded.length === 0 && activityCount === 0,
    );

    // ── Keyboard handler ─────────────────────────────────────────────────────
    function handleDrawerKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
                return;
            }
            if (window.getSelection()?.toString()) {
                return;
            }
            e.stopPropagation();
            onclose();
        }
    }
</script>

{#if open}
    <!-- Backdrop — Z.MODAL so it sits above the fixed navbar (Z.NAVBAR=500); the old
         Tailwind z-40 left the navbar painting over the drawer, eating clicks on the X. -->
    <div
        class="fixed inset-0 bg-black/50"
        style="z-index: {Z.MODAL}"
        onclick={onclose}
        role="presentation"
        tabindex="-1"
        transition:fade={{ duration: 150 }}>
    </div>

    <!-- Drawer — one above its backdrop (mirrors ModalContainer's MODAL / MODAL+1 split).
         max-w-[calc(100vw-1rem)] (not max-w-full/100vw) so the drawer always keeps a
         minimum margin from the left viewport edge instead of touching it flush on
         narrow screens; overflow-x-clip is a safety net so no descendant (long
         unbroken text, a wide row) can bleed past the right viewport edge. clip, not
         hidden: hidden turns overflow-y into auto, making the shell a second scroll
         container under the body's own. -->
    <div
        class="fixed right-0 top-0 bottom-0 flex w-[420px] max-w-[calc(100vw-1rem)] flex-col overflow-x-clip border-l border-surface-700 bg-surface-800"
        style="z-index: {Z.MODAL + 1}"
        transition:fly={{ x: 420, duration: 200 }}
        role="dialog"
        aria-modal="true"
        aria-label={m.admin_ops_drawer_title()}
        tabindex="-1"
        use:trapFocus
        onkeydown={handleDrawerKeydown}>
        <!-- Header -->
        <div class="flex items-start justify-between border-b border-surface-700 p-4">
            <a href={resolve('/admin/system/health')} class="group min-w-0" onclick={onclose}>
                <div class="flex items-center gap-2">
                    <span
                        class="h-2.5 w-2.5 shrink-0 rounded-full {verdictStyle.dot}"
                        aria-hidden="true"></span>
                    <h2 class="text-base font-semibold text-white group-hover:underline">
                        {m.admin_ops_drawer_title()}
                    </h2>
                </div>
                <p class="mt-0.5 text-xs {verdictStyle.text}">
                    {verdictStyle.label}
                </p>
            </a>
            <div class="flex shrink-0 items-center gap-1">
                {#if updatedLabel}
                    <span class="mr-1 text-[11px] text-surface-500" aria-live="off"
                        >{m.admin_ops_updated()} {updatedLabel}</span>
                {/if}
                {#if onRefresh}
                    <button
                        class="p-1 text-surface-400 hover:text-white disabled:opacity-50"
                        onclick={onRefresh}
                        disabled={refreshing}
                        aria-label={m.admin_ops_refresh()}
                        title={m.admin_ops_refresh()}>
                        <Icon src={ArrowPath} class="h-4 w-4 {refreshing ? 'animate-spin' : ''}" />
                    </button>
                {/if}
                <button
                    class="p-1 text-surface-400 hover:text-white"
                    onclick={onclose}
                    data-autofocus
                    aria-label="Close"
                    title="Close">
                    ✕
                </button>
            </div>
        </div>

        <!-- Scrollable content -->
        <!-- relative: the attention cards' sr-only labels are absolutely positioned;
             without a containing block here they resolve against the drawer shell and,
             once the list runs past the viewport, overflow it (double scroll). -->
        <div class="relative flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4">
            {#if showSkeleton}
                <!-- First load: a skeleton, so an empty drawer doesn't read as "all good" before data arrives -->
                <div class="space-y-2" aria-hidden="true">
                    <div class="h-3 w-24 animate-pulse rounded bg-surface-700"></div>
                    <div class="h-12 animate-pulse rounded bg-surface-700/60"></div>
                    <div class="h-12 animate-pulse rounded bg-surface-700/60"></div>
                </div>
                <p class="sr-only" role="status">{m.admin_ops_loading()}</p>
            {:else}
                <!-- 0. Live streams — ambient "what's happening now" (read-only, never an alert) -->
                <StreamingSummary {open} />

                <!-- 0b. Library processing — compact strip shown only while work is in flight -->
                {#if procIsActive && procTotal > 0}
                    <section
                        class="rounded-lg border border-sky-800/30 bg-sky-950/20 px-3 py-2"
                        aria-label="Library processing status">
                        <div class="mb-1.5 flex items-center justify-between gap-2">
                            <span
                                class="flex items-center gap-1.5 text-xs font-medium text-surface-200">
                                <span
                                    class="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sky-400"
                                ></span>
                                Library processing
                            </span>
                            <a
                                href={resolve('/admin/tasks/pipeline')}
                                class="text-[11px] text-sky-400 hover:text-sky-300 hover:underline"
                                onclick={onclose}>
                                Details →
                            </a>
                        </div>
                        <div class="h-1 w-full overflow-hidden rounded-full bg-surface-800">
                            <div
                                class="h-full rounded-full bg-sky-500 transition-all"
                                style="width: {procPct}%">
                            </div>
                        </div>
                        <p class="mt-1 text-[11px] text-surface-400">
                            {procDone.toLocaleString()} of {procTotal.toLocaleString()} ·
                            {procPct}% complete
                        </p>
                    </section>
                {/if}

                <!-- 1. Activity -->
                <section>
                    <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-surface-400">
                        {m.admin_ops_section_activity()}
                        {#if activityCount > 0}
                            <span class="ml-1 rounded bg-surface-700 px-1.5 py-0.5 text-surface-300"
                                >{activityCount}</span>
                        {/if}
                    </h3>
                    {#if activeManual.length === 0 && visibleCompletions.length === 0}
                        <p class="text-xs text-surface-500">
                            {m.admin_ops_activity_empty()}
                        </p>
                    {:else}
                        <div class="space-y-1.5">
                            {#each activeManual as run (run.id)}
                                <ActivityRow {run} />
                            {/each}
                            {#each visibleCompletions as c (c.run.id)}
                                <ActivityRow run={c.run} completedState={c.state} />
                            {/each}
                        </div>
                    {/if}
                </section>

                <!-- 2. Recently added -->
                <section>
                    <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-surface-400">
                        {m.admin_ops_section_recently_added()}
                        {#if recentlyAdded.length > 0}
                            <span class="ml-1 rounded bg-surface-700 px-1.5 py-0.5 text-surface-300"
                                >{recentlyAdded.length}</span>
                        {/if}
                    </h3>
                    {#if recentlyAdded.length === 0}
                        <p class="text-xs text-surface-500">
                            {m.admin_ops_recent_empty()}
                        </p>
                    {:else}
                        <div class="space-y-1.5">
                            {#each recentlyAddedRows as row (row.key)}
                                <RecentlyAddedRow item={row.item} />
                            {/each}
                        </div>
                    {/if}
                </section>

                <!-- 3. Needs attention -->
                <section>
                    <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-surface-400">
                        {m.admin_ops_section_attention()}
                        {#if activeItems.length > 0}
                            <span class="ml-1 rounded px-1.5 py-0.5 {attentionBadgeClass}"
                                >{activeItems.length}</span>
                        {/if}
                    </h3>
                    {#if unavailable}
                        <div
                            class="flex items-center gap-2 rounded border border-amber-700/40 bg-amber-950/20 px-3 py-3 text-amber-300">
                            <span aria-hidden="true">⚠</span>
                            <span class="text-xs">{m.admin_ops_attention_unavailable()}</span>
                        </div>
                    {:else if activeItems.length === 0}
                        <div
                            class="flex items-center gap-2 rounded border border-surface-700/40 px-3 py-3 text-surface-400">
                            <span class="text-green-500" aria-hidden="true">✓</span>
                            <span class="text-xs">{m.admin_ops_attention_empty()}</span>
                        </div>
                    {:else}
                        <div class="space-y-1.5">
                            {#each activeItems as item (item.id)}
                                <div animate:flip={{ duration: 150 }} in:fade={{ duration: 120 }}>
                                    <AttentionItemRow
                                        {item}
                                        {onAck}
                                        {onSnooze}
                                        onChanged={onRefresh}
                                        {onclose} />
                                </div>
                            {/each}
                        </div>
                    {/if}
                </section>

                <!-- 4. Acknowledged & snoozed (collapsed) -->
                {#if suppressedItems.length > 0}
                    <details class="group">
                        <summary
                            class="cursor-pointer list-none text-xs font-medium uppercase tracking-wide text-surface-500 hover:text-surface-300 select-none">
                            {m.admin_ops_section_suppressed()}
                            <span class="ml-1 rounded bg-surface-700 px-1.5 py-0.5 text-surface-400"
                                >{suppressedItems.length}</span>
                        </summary>
                        <div class="mt-2 space-y-1.5">
                            {#each suppressedItems as item (item.id)}
                                <AttentionItemRow
                                    {item}
                                    {onAck}
                                    {onSnooze}
                                    onChanged={onRefresh}
                                    {onclose} />
                            {/each}
                        </div>
                    </details>
                {/if}

                <!-- 5. What happened while away — recently auto-resolved (collapsed) -->
                {#if resolvedHistory.length > 0}
                    <details class="group">
                        <summary
                            class="cursor-pointer list-none text-xs font-medium uppercase tracking-wide text-surface-500 hover:text-surface-300 select-none">
                            {m.admin_ops_section_history()}
                            <span class="ml-1 rounded bg-surface-700 px-1.5 py-0.5 text-surface-400"
                                >{resolvedHistory.length}</span>
                        </summary>
                        <div class="mt-2 space-y-1.5">
                            {#each resolvedHistory as item (item.id)}
                                <div
                                    class="flex items-center gap-2 rounded border border-surface-700/40 px-3 py-2 text-xs text-surface-400">
                                    <span class="text-green-500" aria-hidden="true">✓</span>
                                    <span class="min-w-0 flex-1 truncate" title={item.title}
                                        >{item.title}</span>
                                    {#if item.resolvedAt}
                                        <span
                                            class="shrink-0 text-surface-500"
                                            title={item.resolvedAt}
                                            >{relativeTime(item.resolvedAt, now.value)}</span>
                                    {/if}
                                </div>
                            {/each}
                        </div>
                    </details>
                {/if}
            {/if}
        </div>

        <!-- Footer -->
        <div class="border-t border-surface-700 p-4">
            <a
                href={resolve('/admin')}
                class="text-sm text-blue-400 hover:text-blue-300 hover:underline"
                onclick={onclose}>
                {m.admin_ops_view_all()} → /admin
            </a>
        </div>
    </div>
{/if}
