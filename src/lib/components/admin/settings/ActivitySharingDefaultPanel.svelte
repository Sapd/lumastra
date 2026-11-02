<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import {
        ActivitySharingDefaultSchema,
        ActivitySharingDefaultAppliedSchema,
    } from '$lib/schemas/activity-sharing.js';
    import { apiGet, apiPost } from '$lib/api/client.js';
    import ActionModal from '../ActionModal.svelte';
    import * as m from '$lib/paraglide/messages.js';

    let confirming = $state<boolean | null>(null);
    let busy = $state(false);
    let result = $state<string | null>(null);
    let failed = $state(false);

    async function preview(): Promise<void> {
        if (busy) return;
        busy = true;
        failed = false;
        result = null;
        try {
            const { data, error } = await apiGet(
                '/api/admin/activity-sharing-default',
                ActivitySharingDefaultSchema,
            );
            if (error || !data) failed = true;
            else confirming = data.sharing;
        } catch {
            failed = true;
        } finally {
            busy = false;
        }
    }

    async function apply(): Promise<void> {
        if (busy || confirming === null) return;
        busy = true;
        try {
            const { data, error } = await apiPost(
                '/api/admin/activity-sharing-default',
                ActivitySharingDefaultAppliedSchema,
                {
                    confirmed: true,
                    expectedDefault: confirming,
                },
            );
            if (error || !data) failed = true;
            else result = m.activity_sharing_applied({ count: data.changedCount });
        } catch {
            failed = true;
        } finally {
            confirming = null;
            busy = false;
        }
    }
</script>

<div class="mt-4 rounded border border-surface-600/60 p-3">
    <p class="text-sm text-surface-400">{m.activity_sharing_apply_hint()}</p>
    <button
        type="button"
        class="btn btn-sm variant-soft-primary mt-2"
        disabled={busy}
        onclick={() => void preview()}>
        {m.activity_sharing_apply()}
    </button>
    <div role="status" class="text-sm mt-2">
        {#if failed}{m.activity_sharing_failed()}{:else if result}{result}{/if}
    </div>
</div>

{#if confirming !== null}
    <ActionModal
        title={m.activity_sharing_apply()}
        confirmText={m.activity_sharing_apply()}
        cancelText={m.common_cancel()}
        disabled={busy}
        onclose={() => {
            if (!busy) confirming = null;
        }}
        onconfirm={apply}>
        <p>{confirming ? m.activity_sharing_confirm_on() : m.activity_sharing_confirm_off()}</p>
    </ActionModal>
{/if}
