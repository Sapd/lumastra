<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { resolve } from '$lib/paths';
    import { Icon, Clock, CheckCircle, ExclamationTriangle, ArrowRight } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import type { AttentionItem } from '$lib/schemas/api-attention-responses';

    /**
     * Admin Home "Recent activity" digest (audit Tier 2 #28): what
     * finished, what's still going, what failed, and the one thing that
     * needs a human — reframing the task system from alarm panel to
     * butler's report.
     *
     * Numbers are real, not estimated: `completed`/`stillGoing`/`failedCount`
     * come from `task_history` via GET /api/admin/ops/nightly-digest (the
     * SAME `result->>'itemsProcessed'` field the live throughput panel
     * already sums). A task with no `itemsProcessed` on its result is simply
     * not itemized here — no invented "processed 0 items" line.
     *
     * "One thing needs you" is NOT fetched by this component: it is the top
     * open attention item, passed in as `attentionItem` from
     * `/admin/+page.svelte`'s already-loaded `adminStatus.payload.attention`
     * (the exact source the bell and AttentionList already read), so this
     * card can never disagree with them about what's wrong.
     */

    interface CompletedEntry {
        taskId: string;
        taskName: string;
        runs: number;
        itemsProcessed: number;
    }

    interface StillGoingEntry {
        taskId: string;
        taskName: string;
        startedAt: string;
    }

    interface DigestData {
        windowHours: number;
        /** The install is younger than the window — say "since setup". */
        sinceInstall?: boolean;
        totalCompletedRuns: number;
        completed: CompletedEntry[];
        stillGoing: StillGoingEntry[];
        failedCount: number;
    }

    interface Props {
        /** Top open (unacked, unsnoozed) attention item, or null when there is none. */
        attentionItem?: AttentionItem | null;
    }
    let { attentionItem = null }: Props = $props();

    let data = $state<DigestData | null>(null);
    let loading = $state(true);
    let loadError = $state(false);

    $effect(() => {
        (async () => {
            try {
                const res = await fetch('/api/admin/ops/nightly-digest?hours=12');
                if (!res.ok) throw new Error(`${res.status}`);
                const body = (await res.json()) as Partial<DigestData> | null;
                // A body missing a field would throw inside `isEmpty` and take the
                // card down instead of showing its error line.
                if (
                    !body ||
                    !Array.isArray(body.completed) ||
                    !Array.isArray(body.stillGoing) ||
                    typeof body.failedCount !== 'number'
                ) {
                    throw new Error('Unexpected nightly digest response');
                }
                data = body as DigestData;
            } catch {
                loadError = true;
            } finally {
                loading = false;
            }
        })();
    });

    function formatTime(iso: string): string {
        try {
            return new Intl.DateTimeFormat(undefined, {
                hour: '2-digit',
                minute: '2-digit',
            }).format(new Date(iso));
        } catch {
            return iso;
        }
    }

    const needsAttentionHref = $derived(
        attentionItem?.actions.find((a) => a.href)?.href ?? attentionItem?.sourceRef,
    );

    const isEmpty = $derived(
        data !== null &&
            data.completed.length === 0 &&
            data.stillGoing.length === 0 &&
            data.failedCount === 0 &&
            !attentionItem,
    );
</script>

<section
    class="space-y-3 rounded-lg border border-surface-700/40 bg-surface-900/40 p-4"
    aria-label={m.admin_home_digest_heading()}>
    <h3
        class="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-surface-400">
        <Icon src={Clock} class="h-3.5 w-3.5" aria-hidden="true" />
        {m.admin_home_digest_heading()}
    </h3>

    {#if loading}
        <div class="h-20 animate-pulse rounded bg-surface-800/60"></div>
    {:else if loadError || !data}
        <p class="text-sm text-surface-500">{m.admin_home_digest_error()}</p>
    {:else if isEmpty}
        <p class="flex items-center gap-2 text-sm text-surface-500">
            <Icon src={CheckCircle} class="h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
            {m.admin_home_digest_empty()}
        </p>
    {:else}
        <div class="space-y-1.5 text-sm text-surface-300">
            {#if data.totalCompletedRuns > 0}
                <p class="text-surface-400">
                    {data.sinceInstall
                        ? m.admin_home_digest_total_runs_since_setup({
                              count: data.totalCompletedRuns,
                          })
                        : m.admin_home_digest_total_runs({
                              count: data.totalCompletedRuns,
                              hours: data.windowHours,
                          })}
                </p>
            {/if}
            {#each data.completed as entry (entry.taskId)}
                <p>
                    {m.admin_home_digest_completed_item({
                        taskName: entry.taskName,
                        count: entry.itemsProcessed,
                    })}
                </p>
            {/each}
        </div>

        {#if data.stillGoing.length > 0}
            <div class="border-t border-surface-800 pt-2">
                <h4 class="mb-1 text-xs font-medium text-surface-500">
                    {m.admin_home_digest_still_going_heading()}
                </h4>
                <ul class="space-y-1 text-sm text-surface-300">
                    {#each data.stillGoing as entry (entry.taskId)}
                        <li>
                            {m.admin_home_digest_still_going_item({
                                taskName: entry.taskName,
                                time: formatTime(entry.startedAt),
                            })}
                        </li>
                    {/each}
                </ul>
            </div>
        {/if}

        {#if data.failedCount > 0}
            <div class="flex items-center gap-2 border-t border-surface-800 pt-2 text-sm">
                <Icon
                    src={ExclamationTriangle}
                    class="h-4 w-4 shrink-0 text-red-400"
                    aria-hidden="true" />
                <span class="text-red-300">
                    {m.admin_home_digest_failed_count({ count: data.failedCount })}
                </span>
                <a
                    href={resolve('/admin/system/health')}
                    class="ml-auto inline-flex items-center gap-1 text-xs font-medium text-sky-400 hover:text-sky-300">
                    {m.admin_home_digest_review_failures()}
                    <Icon src={ArrowRight} class="h-3.5 w-3.5" aria-hidden="true" />
                </a>
            </div>
        {/if}

        {#if attentionItem}
            <div class="rounded border border-amber-700/40 bg-amber-950/20 p-2.5">
                <h4 class="mb-1 text-xs font-medium text-amber-300">
                    {m.admin_home_digest_needs_you_heading()}
                </h4>
                <p class="text-sm text-surface-200">{attentionItem.title}</p>
                {#if needsAttentionHref}
                    <a
                        href={resolve(needsAttentionHref)}
                        class="mt-1 inline-flex items-center gap-1 text-xs font-medium text-sky-400 hover:text-sky-300">
                        {m.admin_home_digest_needs_you_link()}
                        <Icon src={ArrowRight} class="h-3.5 w-3.5" aria-hidden="true" />
                    </a>
                {/if}
            </div>
        {/if}
    {/if}
</section>
