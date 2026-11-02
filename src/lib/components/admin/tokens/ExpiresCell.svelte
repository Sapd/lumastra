<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { SvelteDate } from 'svelte/reactivity';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        expiresAt?: string | null;
        isExpired?: boolean;
    }

    let { expiresAt, isExpired }: Props = $props();

    // Whole days between `expiresAt` and now, direction-agnostic. Bidirectional
    // by construction — the page-level `formatRelativeDate` helper is past-only
    // and was previously misused here for FUTURE `expiresAt` dates, producing
    // negative "-N days ago" text for tokens that hadn't expired yet.
    function daysBetween(dateStr: string): number {
        const date = new SvelteDate(dateStr);
        const now = new SvelteDate();
        return Math.floor(Math.abs(date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    }

    let expiryLabel = $derived.by(() => {
        if (!expiresAt) return m.route_admin_api_tokens_never();
        const days = daysBetween(expiresAt);
        if (isExpired) {
            if (days === 0) return m.route_admin_api_tokens_expired_today();
            if (days === 1) return m.route_admin_api_tokens_expired_yesterday();
            return m.route_admin_api_tokens_expired_days_ago({ count: days });
        }
        if (days === 0) return m.route_admin_api_tokens_expires_today();
        if (days === 1) return m.route_admin_api_tokens_expires_tomorrow();
        return m.route_admin_api_tokens_expires_in_days({ count: days });
    });
</script>

<td class="px-4 py-3 text-sm">
    {#if isExpired}
        <span
            class="inline-flex items-center rounded-full border border-red-700/60 bg-red-900/30 px-2 py-0.5 text-xs text-red-300">
            {expiryLabel}
        </span>
    {:else if expiresAt}
        {expiryLabel}
    {:else}
        <span class="text-surface-500">{m.route_admin_api_tokens_never()}</span>
    {/if}
</td>
