<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, PlayCircle } from 'svelte-hero-icons';
    import { z } from 'zod';
    import { apiPost } from '$lib/api/client.js';
    import { toasts } from '$lib/stores/toast.store.js';

    const WebhookTestResponseSchema = z
        .object({
            delivered: z.boolean().optional(),
            status: z.number().optional(),
            error: z.string().optional(),
            durationMs: z.number().optional(),
        })
        .passthrough();

    interface Props {
        webhookId: string;
    }

    let { webhookId }: Props = $props();

    let testing = $state(false);

    async function runTest(): Promise<void> {
        if (testing) return;
        testing = true;
        try {
            const { data, error } = await apiPost(
                `/api/webhooks/${webhookId}/test`,
                WebhookTestResponseSchema,
            );
            if (error || !data) {
                toasts.error(`Test failed: ${error ?? 'unknown error'}`);
            } else if (data.delivered) {
                toasts.success(
                    `Delivered — HTTP ${data.status ?? '?'} in ${data.durationMs ?? '?'}ms`,
                );
            } else {
                toasts.error(`Test failed: ${data.error ?? 'unknown error'}`);
            }
        } finally {
            testing = false;
        }
    }
</script>

<button
    type="button"
    class="rounded p-1.5 text-surface-400 hover:bg-surface-700 hover:text-cyan-400 transition-colors disabled:opacity-40"
    title="Send test event"
    disabled={testing}
    onclick={() => void runTest()}>
    <Icon src={PlayCircle} class="w-4 h-4 {testing ? 'animate-pulse' : ''}" />
</button>
