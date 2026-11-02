<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import * as m from '$lib/paraglide/messages.js';
    import { resolve } from '$lib/paths';
    import type { AttentionItem } from '$lib/schemas/api-attention-responses';
    import type { AdminSectionId } from '$lib/schemas/api-admin-status-payload.js';
    import { adminStatus } from '$lib/stores/admin-status.store.svelte.js';
    import { sectionForItem } from '$lib/shared/attention-section-map.js';
    import AttentionItemRow from './AttentionItemRow.svelte';

    interface Props {
        /**
         * When false, suppress the verdict banner — used on /admin where the
         * VerdictBanner now owns the single canonical verdict and this list
         * shows only the actionable items (avoids two verdict banners on one page).
         */
        showVerdict?: boolean;
        /** Home triage excludes informational findings; Health keeps them. */
        actionableOnly?: boolean;
        /**
         * Cap the number of visible rows (spec §3.1: Home shows ~5). When more
         * items exist than `max`, a "show all N →" link to `showAllHref` renders.
         */
        max?: number;
        /** Where "show all N →" points (e.g. System → Health). Required for it to render. */
        showAllHref?: string;
        /**
         * Render a "Show acknowledged" toggle (spec §3.4: Health's findings
         * section). Off by default: quiet/resolved items (acked or snoozed)
         * are hidden until the operator asks for them. Home and the bell never
         * pass this — they show only what's still open.
         */
        allowAcknowledgedToggle?: boolean;
        /**
         * Restrict rows to items belonging to one admin nav section (same
         * `sectionForItem` mapping the server uses for `sectionStatus`) — lets a
         * section landing page (e.g. /admin/tasks) explain its own nav dot
         * without showing items that belong to other sections.
         */
        section?: AdminSectionId;
        /** False when the host already titles the list (the tasks page's "Needs attention (N)"). */
        showHeading?: boolean;
    }

    let {
        showVerdict = true,
        actionableOnly = false,
        showHeading = true,
        max,
        showAllHref,
        allowAcknowledgedToggle = false,
        section,
    }: Props = $props();

    // Same store as the bell and Home — the list can never disagree with them.
    onMount(() => {
        adminStatus.start();
        return () => adminStatus.stop();
    });

    let showAcknowledged = $state(false);

    const allItems = $derived(
        (adminStatus.payload?.attention.items ?? []).filter(
            (i) =>
                (!actionableOnly || i.severity !== 'info') &&
                (section === undefined || sectionForItem(i) === section),
        ),
    );
    // Open items — acked/snoozed ones are quiet by default so a page reading
    // this list can never contradict the verdict banner. With `actionableOnly`
    // (admin Home) Info findings are left out too; the bell and Health still
    // list them, so their counts can be higher than Home's.
    const openItems = $derived(allItems.filter((i) => !i.acked && !i.snoozed));
    const items = $derived(allowAcknowledgedToggle && showAcknowledged ? allItems : openItems);
    const verdict = $derived(adminStatus.payload?.verdict ?? 'healthy');
    const unavailable = $derived(adminStatus.payload?.attention.unavailable ?? false);
    // Rows actually rendered (capped by `max`); the "show all" link uses the full count.
    const visibleItems = $derived(max !== undefined ? items.slice(0, max) : items);
    const hasMore = $derived(max !== undefined && items.length > max);
    const acknowledgedCount = $derived(allItems.length - openItems.length);

    async function ack(item: AttentionItem): Promise<void> {
        await adminStatus.ack(item.id);
    }

    const verdictClass = $derived(
        verdict === 'critical'
            ? 'bg-red-950/30 border-red-500/40 text-red-300'
            : verdict === 'degraded'
              ? 'bg-amber-950/20 border-amber-500/35 text-amber-300'
              : 'bg-green-950/15 border-green-500/35 text-green-300',
    );

    const verdictText = $derived(
        verdict === 'critical'
            ? m.admin_ops_verdict_critical()
            : verdict === 'degraded'
              ? m.admin_ops_verdict_degraded()
              : m.admin_ops_verdict_healthy(),
    );
</script>

{#if !adminStatus.loading && adminStatus.payload}
    <section class="space-y-2">
        {#if showVerdict}
            <div class="rounded border px-3 py-2 text-sm font-semibold {verdictClass}">
                {verdictText}
            </div>
        {/if}
        {#if allowAcknowledgedToggle && acknowledgedCount > 0}
            <label class="flex items-center gap-1.5 text-xs text-surface-400">
                <input type="checkbox" bind:checked={showAcknowledged} class="rounded" />
                {m.admin_attention_show_acknowledged({ count: acknowledgedCount })}
            </label>
        {/if}
        {#if items.length > 0}
            {#if showHeading}
                <div class="text-xs uppercase tracking-wide text-surface-400">
                    {m.admin_ops_attention_heading()}
                </div>
            {/if}
            <div class="space-y-1">
                {#each visibleItems as item (item.id)}
                    <AttentionItemRow
                        {item}
                        onAck={ack}
                        onChanged={() => void adminStatus.refresh()} />
                {/each}
            </div>
            {#if hasMore && showAllHref}
                <a
                    href={resolve(showAllHref)}
                    class="inline-block text-xs font-medium text-sky-400 hover:text-sky-300">
                    {m.admin_home_attention_show_all({ count: items.length })}
                </a>
            {/if}
        {:else if unavailable}
            <p class="text-xs text-amber-300">
                {m.admin_ops_attention_unavailable()}
            </p>
        {:else}
            <p class="text-xs text-surface-500">
                {m.admin_ops_attention_empty()}
            </p>
        {/if}
    </section>
{/if}
