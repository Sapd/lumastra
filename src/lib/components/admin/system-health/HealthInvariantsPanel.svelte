<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { apiGet } from '$lib/api/client.js';
    import { HealthInvariantsResponseSchema } from '$lib/schemas/health-invariants.schema.js';
    import type {
        HealthFinding,
        InvariantDetailLink,
    } from '$lib/schemas/health-invariants.schema.js';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import StatusPip from './StatusPip.svelte';
    import { healthFindingRank } from './health-finding-order.js';

    const ENDPOINT = '/api/admin/system-health/invariants';
    const POLL_MS = 30_000;

    // Red-first ordering is `healthFindingRank` in `health-finding-order.ts`.
    // It was a record keyed on the finding status here, and this component is
    // where that was measured to be unchecked — a renamed key gave 0 tsgo errors
    // AND 0 svelte-check errors. An unranked status makes the comparator below
    // return NaN, which costs the whole list's ordering, not one row.

    let findings = $state<HealthFinding[]>([]);
    let lastFullRunAt = $state<string | null>(null);
    let lastSuccessfulRunAt = $state<string | null>(null);
    let erroredCount = $state(0);
    let loadError = $state<string | null>(null);
    let loading = $state(true);
    let expanded = $state(false);

    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let destroyed = false;

    async function fetchInvariants(): Promise<void> {
        const { data, error } = await apiGet(ENDPOINT, HealthInvariantsResponseSchema);
        if (destroyed) return;
        if (error || !data) {
            loadError = error ?? 'Failed to fetch invariants';
        } else {
            findings = [...data.findings].sort(
                (a, b) => healthFindingRank(a.status) - healthFindingRank(b.status),
            );
            lastFullRunAt = data.lastFullRunAt;
            lastSuccessfulRunAt = data.lastSuccessfulRunAt;
            erroredCount = data.erroredCount;
            loadError = null;
        }
        if (!destroyed) loading = false;
    }

    // Pause polling when the tab is hidden. Five backgrounded admin tabs
    // would otherwise hammer the endpoint every 30 s for the entire session.
    // Visibility change handler also fires an immediate refresh on resume so
    // the panel doesn't show a stale snapshot for up to 30 s after focus.
    function startPolling(): void {
        if (pollTimer !== undefined) return;
        pollTimer = setInterval(() => void fetchInvariants(), POLL_MS);
    }
    function stopPolling(): void {
        if (pollTimer !== undefined) {
            clearInterval(pollTimer);
            pollTimer = undefined;
        }
    }
    function handleVisibilityChange(): void {
        if (typeof document === 'undefined') return;
        if (document.hidden) {
            stopPolling();
        } else {
            void fetchInvariants();
            startPolling();
        }
    }

    onMount(() => {
        void fetchInvariants();
        startPolling();
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', handleVisibilityChange);
        }
    });

    onDestroy(() => {
        destroyed = true;
        stopPolling();
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        }
    });

    function minutesAgo(isoTs: string | null): string {
        if (!isoTs) return '—';
        const diffMs = Date.now() - new Date(isoTs).getTime();
        const mins = Math.round(diffMs / 60_000);
        if (mins < 1) return 'just now';
        if (mins === 1) return '1 minute ago';
        return `${mins} minutes ago`;
    }

    /**
     * Honest metric copy: the raw value (thousands-separated) plus what the
     * two thresholds actually mean, instead of the old "2604 (problem level:
     * 10000)" phrasing that read like the finding itself was already at the
     * red threshold.
     */
    function metricLabel(f: HealthFinding): string | null {
        const value = f.value !== null ? f.value.toLocaleString() : null;
        const hasThresholds = f.thresholdAmber !== null && f.thresholdRed !== null;
        if (value !== null && hasThresholds) {
            return m.admin_health_invariant_value_thresholds({
                value,
                amber: f.thresholdAmber!.toLocaleString(),
                red: f.thresholdRed!.toLocaleString(),
            });
        }
        if (hasThresholds) {
            return m.admin_health_invariant_thresholds_only({
                amber: f.thresholdAmber!.toLocaleString(),
                red: f.thresholdRed!.toLocaleString(),
            });
        }
        return value;
    }

    const allGreen = $derived(findings.length > 0 && findings.every((f) => f.status === 'green'));

    const showList = $derived(!allGreen || expanded);

    /**
     * Split invariant copy into plain-text and link segments so a path the
     * remediation mentions (e.g. /admin/tasks) renders as a clickable
     * link instead of dead text. Matches internal /admin/… routes and absolute
     * http(s) URLs. Safe by construction — segments bind as text/href (Svelte
     * escapes both), never {@html}.
     */
    interface TextSegment {
        text: string;
        href?: string;
    }
    function linkify(text: string): TextSegment[] {
        const pattern = /(https?:\/\/[^\s)]+|\/admin\/[A-Za-z0-9/_-]+)/g;
        const segments: TextSegment[] = [];
        let lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
            const idx = match.index ?? 0;
            if (idx > lastIndex) segments.push({ text: text.slice(lastIndex, idx) });
            segments.push({ text: match[0], href: match[0] });
            lastIndex = idx + match[0].length;
        }
        if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex) });
        return segments;
    }
</script>

<!-- Render invariant copy with any /admin/… or http(s) URL it mentions turned
     into a clickable link (internal links nav in-app; external open a new tab). -->
{#snippet linked(
    text: string,
)}{#each linkify(text) as seg, i (i)}{#if seg.href && seg.href.startsWith('/')}<a
                href={resolve(seg.href)}
                class="underline decoration-dotted underline-offset-2 hover:opacity-80"
                >{seg.text}</a
            >{:else if seg.href}<a
                href={resolve(seg.href)}
                target="_blank"
                rel="noopener noreferrer"
                class="underline decoration-dotted underline-offset-2 hover:opacity-80"
                >{seg.text}</a
            >{:else}{seg.text}{/if}{/each}{/snippet}

<!-- One actionable target under a finding — deep-links straight to the
     affected task instead of leaving the operator to hunt for it. Falls back
     to a plain (non-clickable) chip when the invariant couldn't resolve an
     href for this target. -->
{#snippet detailLink(d: InvariantDetailLink)}
    {#if d.href}
        <a
            href={resolve(d.href)}
            class="inline-flex items-center gap-1.5 rounded border border-surface-700/50 bg-surface-800/60 px-2 py-1 text-xs text-surface-300 hover:border-sky-700/50 hover:bg-surface-800 hover:text-sky-300 transition-colors">
            {#if d.count !== undefined}
                <span class="font-mono tabular-nums text-surface-200"
                    >{d.count.toLocaleString()}</span>
            {/if}
            <span
                >{d.label}{#if d.sublabel}<span class="text-surface-500">
                        · {d.sublabel}</span
                    >{/if}</span>
            <span class="font-medium text-sky-400">{m.admin_health_invariant_open()}</span>
        </a>
    {:else}
        <span
            class="inline-flex items-center gap-1.5 rounded border border-surface-700/50 bg-surface-800/40 px-2 py-1 text-xs text-surface-400">
            {#if d.count !== undefined}
                <span class="font-mono tabular-nums text-surface-300"
                    >{d.count.toLocaleString()}</span>
            {/if}
            <span
                >{d.label}{#if d.sublabel}<span class="text-surface-500">
                        · {d.sublabel}</span
                    >{/if}</span>
        </span>
    {/if}
{/snippet}

<div class="space-y-3">
    <!-- Panel heading -->
    <div class="flex items-center gap-3">
        <h2 class="text-base font-semibold text-surface-100">Database Health</h2>
        {#if erroredCount > 0}
            <span
                class="rounded bg-amber-950/40 border border-amber-800/50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300"
                title="One or more checks could not run last time — see the rows below for detail">
                {erroredCount} couldn't run
            </span>
        {/if}
        {#if lastFullRunAt}
            <span class="text-xs text-surface-500 ml-auto">
                {#if lastSuccessfulRunAt}
                    Last clean check {minutesAgo(lastSuccessfulRunAt)}
                {:else}
                    Last attempt {minutesAgo(lastFullRunAt)}
                {/if}
            </span>
        {/if}
    </div>

    {#if loading}
        <div class="flex items-center gap-2 py-4 text-surface-400 text-sm">
            <span
                class="inline-block h-3 w-3 rounded-full border-2 border-surface-500 border-t-surface-300 animate-spin"
            ></span>
            <span>Loading checks…</span>
        </div>
    {:else if loadError}
        <div
            class="rounded border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300"
            role="alert">
            {loadError}
        </div>
    {:else if findings.length === 0}
        <!-- Fresh boot: table empty until first task run finishes. The task
             is scheduled with runOnStartup so the window is short, but a
             slow boot or a misconfigured task should not leave the operator
             staring at an empty card with no indication. -->
        <div
            class="rounded border border-surface-700/40 bg-surface-900/40 px-4 py-3 text-sm text-surface-400">
            No results yet — the health check runs every 15 minutes and on startup. If this
            persists, check that the database health check is scheduled under Operations -> Jobs.
        </div>
    {:else if allGreen && !expanded}
        <!-- Collapsed all-green summary -->
        <button
            type="button"
            class="flex items-center gap-2 rounded border border-green-800/40 bg-green-950/20 px-4 py-2.5 text-sm text-green-300 w-full text-left hover:bg-green-950/30 transition-colors"
            onclick={() => (expanded = true)}
            aria-expanded="false">
            <StatusPip status="green" size="sm" />
            <span>All {findings.length} checks healthy</span>
            <span class="ml-auto text-xs text-green-500/70">click to expand</span>
        </button>
    {:else}
        <!-- Finding cards -->
        {#if allGreen}
            <button
                type="button"
                class="text-xs text-surface-500 hover:text-surface-300 transition-colors mb-1"
                onclick={() => (expanded = false)}>
                collapse ↑
            </button>
        {/if}

        <div class="space-y-2">
            {#each findings as finding (finding.id)}
                {@const showRemediation = finding.status === 'red' || finding.status === 'amber'}
                {@const cardBorder =
                    finding.status === 'red'
                        ? 'border-red-800/40'
                        : finding.status === 'amber'
                          ? 'border-amber-800/40'
                          : 'border-surface-700/50'}

                <div class="rounded border {cardBorder} bg-surface-900/60 px-4 py-3 space-y-1.5">
                    <!-- Top row: pip + label + value + timestamp -->
                    <div class="flex items-center gap-2">
                        <StatusPip status={finding.status} />
                        <span class="text-sm font-medium text-surface-100">
                            {finding.label}
                        </span>
                        {#if metricLabel(finding) !== null}
                            <span class="text-xs font-mono text-surface-400">
                                {metricLabel(finding)}
                            </span>
                        {/if}
                        <span class="ml-auto text-xs text-surface-500 shrink-0">
                            Updated {minutesAgo(finding.lastRunAt)}
                        </span>
                    </div>

                    <!-- Description -->
                    <p class="text-xs text-surface-400 leading-relaxed pl-5">
                        {@render linked(finding.description)}
                    </p>

                    <!-- Action links (which specific task/stage is affected) —
                         rendered BEFORE the remediation prose so the operator
                         hits a deep link before a paragraph of general advice. -->
                    {#if finding.details && finding.details.length > 0}
                        <div class="ml-5 flex flex-wrap gap-1.5">
                            {#each finding.details as d (d.href ?? `${d.label}:${d.sublabel ?? ''}`)}
                                {@render detailLink(d)}
                            {/each}
                        </div>
                    {/if}

                    <!-- Remediation hint (amber/red only) -->
                    {#if showRemediation && finding.remediation}
                        <div
                            class="ml-5 mt-1 rounded border {finding.status === 'red'
                                ? 'border-red-800/30 bg-red-950/20 text-red-300'
                                : 'border-amber-800/30 bg-amber-950/20 text-amber-300'} px-3 py-2 text-xs leading-relaxed">
                            {@render linked(finding.remediation)}
                        </div>
                    {/if}

                    <!-- Error detail (query failed) -->
                    {#if finding.error}
                        <p class="ml-5 text-xs text-red-400/80 italic">
                            {finding.error}
                        </p>
                    {/if}
                </div>
            {/each}
        </div>
    {/if}
</div>
