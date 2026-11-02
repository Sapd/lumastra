<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  "Live message" on the Message users page: a one-off pop-up on every screen
  that is playing right now (the former "Broadcast to all" on Active
  sessions). Perishable by design — anyone not watching never sees it; for
  that, send an announcement. The reach line is computed from the same
  play-sessions list the sessions page shows, and is never a gate: a client
  that cannot draw the frame ignores it, which is the right failure mode.
-->
<script lang="ts">
    import { onMount } from 'svelte';
    import { Icon, ChatBubbleOvalLeft, ArrowPath } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import * as adminApi from '$lib/api/admin';
    import { toasts } from '$lib/stores/toast.store';
    import { announcesFeature, CLIENT_FEATURE_ADMIN_MESSAGE } from '$lib/shared/client-features';
    import SendSessionMessageModal from './SendSessionMessageModal.svelte';
    import type { AdminPlaySession } from '$lib/schemas/api-admin-responses';

    let total = $state<number | null>(null);
    let capable = $state(0);
    let loading = $state(false);
    let modalOpen = $state(false);

    async function loadReach(): Promise<void> {
        loading = true;
        try {
            const { data, error } = await adminApi.getAdminPlaySessions();
            if (error || !data) throw new Error(error ?? 'no data');
            const sessions = (data.sessions ?? []) as AdminPlaySession[];
            total = sessions.length;
            capable = sessions.filter((s) =>
                announcesFeature(s.clientFeatures, CLIENT_FEATURE_ADMIN_MESSAGE),
            ).length;
        } catch {
            total = null;
        } finally {
            loading = false;
        }
    }

    onMount(() => void loadReach());

    async function send(body: {
        message: string;
        severity: 'info' | 'warning' | 'error';
        durationMs: number;
    }): Promise<void> {
        const { error } = await adminApi.broadcastSessionMessage(body);
        if (error) {
            toasts.error(error || m.route_admin_sessions_broadcast_error());
            return;
        }
        // No count — per-pod would be misleading on multi-pod deployments.
        toasts.success(m.route_admin_sessions_broadcast_sent());
        modalOpen = false;
    }
</script>

<section class="rounded-lg border border-surface-700 bg-surface-800/40 p-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="text-sm text-surface-300">
            {#if total === null}
                {loading ? m.admin_messages_live_counting() : m.admin_messages_live_unknown()}
            {:else if total === 0}
                {m.admin_messages_live_nobody()}
            {:else}
                {m.admin_messages_live_reach({ capable, total })}
            {/if}
        </p>
        <button
            type="button"
            class="flex items-center gap-1 rounded px-2 py-1 text-xs text-surface-400 hover:text-surface-200 disabled:opacity-50"
            disabled={loading}
            onclick={() => void loadReach()}>
            <Icon src={ArrowPath} class="h-3.5 w-3.5 {loading ? 'animate-spin' : ''}" />
            {m.btn_refresh()}
        </button>
    </div>
    <button
        type="button"
        class="btn btn-primary mt-4"
        disabled={total === 0}
        onclick={() => (modalOpen = true)}>
        <Icon src={ChatBubbleOvalLeft} class="h-4 w-4" />
        {m.admin_messages_live_write()}
    </button>
</section>

<SendSessionMessageModal
    open={modalOpen}
    sessionLabel={m.admin_sessions_all_active_sessions()}
    onClose={() => (modalOpen = false)}
    onSend={send} />
