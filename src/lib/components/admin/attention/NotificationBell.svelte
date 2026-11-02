<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import { Icon, ShieldExclamation } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import type { AttentionItem } from '$lib/schemas/api-attention-responses';
    import { adminStatus } from '$lib/stores/admin-status.store.svelte.js';
    import NotificationDrawer from './NotificationDrawer.svelte';

    let open = $state(false);

    // The bell renders the SAME payload as Home and Health — the one canonical
    // admin status store (spec §5). It can never disagree with them.
    onMount(() => {
        adminStatus.start();
        return () => adminStatus.stop();
    });

    const unread = $derived(adminStatus.payload?.attention.unreadCount ?? 0);
    const hasActiveOps = $derived((adminStatus.payload?.attention.activity?.running ?? 0) > 0);
    const verdict = $derived(adminStatus.payload?.verdict ?? 'healthy');
    // Tint the bell itself by verdict so the health state reads at a glance, not just
    // from a small numeric badge (which conveys nothing when zero-but-degraded).
    const bellTint = $derived(
        verdict === 'critical'
            ? 'text-red-400'
            : verdict === 'degraded'
              ? 'text-amber-400'
              : 'text-surface-300',
    );
    const bellAriaLabel = $derived(
        unread > 0 ? `${m.admin_ops_bell_label()} — ${unread}` : m.admin_ops_bell_label(),
    );

    async function ack(item: AttentionItem): Promise<void> {
        await adminStatus.ack(item.id);
    }

    async function snooze(item: AttentionItem, durationMs: number): Promise<void> {
        await adminStatus.snooze(item.id, new Date(Date.now() + durationMs).toISOString());
    }
</script>

<div class="relative">
    <button
        type="button"
        class="relative rounded p-2 hover:bg-surface-700"
        aria-label={bellAriaLabel}
        title={bellAriaLabel}
        onclick={() => (open = !open)}>
        <!-- Not a bell: the app-wide user-notification bell is pinned to the
             top-right corner of every page, admin included, so two identical
             bells with different counts sat on top of each other. This one is
             operations alerts, and says so. -->
        <Icon src={ShieldExclamation} class="h-4 w-4 {bellTint}" />
        {#if unread > 0}
            <span
                class="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-red-500 px-1 text-center text-[10px] leading-4 text-white"
                aria-hidden="true">{unread}</span>
        {/if}
        {#if hasActiveOps}
            <span
                class="absolute bottom-0.5 right-0.5 h-2 w-2 rounded-full bg-blue-400 animate-pulse"
                aria-hidden="true"></span>
        {/if}
    </button>

    <NotificationDrawer
        {open}
        onclose={() => (open = false)}
        items={adminStatus.payload?.attention.items ?? []}
        recentlyAdded={adminStatus.payload?.attention.recentlyAdded ?? []}
        resolvedHistory={adminStatus.payload?.attention.resolvedHistory ?? []}
        unavailable={adminStatus.payload?.attention.unavailable ?? false}
        onAck={ack}
        onSnooze={snooze}
        {verdict}
        loading={adminStatus.loading}
        lastUpdatedAt={adminStatus.lastUpdatedAt?.getTime() ?? null}
        refreshing={adminStatus.refreshing}
        onRefresh={() => void adminStatus.refresh()} />
</div>
