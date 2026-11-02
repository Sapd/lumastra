<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { onDestroy } from 'svelte';
    import { Icon, Trash, PencilSquare, ClipboardDocument, Check } from 'svelte-hero-icons';
    import WebhookTestButton from './WebhookTestButton.svelte';
    import { WebhookRowSchema } from '$lib/schemas/api-v1.js';
    import type { z } from 'zod';

    export type WebhookRow = z.infer<typeof WebhookRowSchema>;

    interface Props {
        webhooks: WebhookRow[];
        onEdit: (webhook: WebhookRow) => void;
        onDelete: (id: string, url: string) => void;
    }

    let { webhooks, onEdit, onDelete }: Props = $props();

    let copiedId = $state<string | null>(null);
    let copyTimer: ReturnType<typeof setTimeout> | null = null;

    onDestroy(() => {
        if (copyTimer !== null) clearTimeout(copyTimer);
    });

    function truncateUrl(url: string): string {
        const max = 60;
        return url.length > max ? url.slice(0, max) + '…' : url;
    }

    async function copyUrl(url: string, id: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(url);
            copiedId = id;
            if (copyTimer !== null) clearTimeout(copyTimer);
            copyTimer = setTimeout(() => {
                copiedId = null;
                copyTimer = null;
            }, 1500);
        } catch {
            // Clipboard may be unavailable in non-secure contexts; ignore.
        }
    }

    function formatDate(val: string | Date): string {
        const d = val instanceof Date ? val : new Date(val);
        if (Number.isNaN(d.getTime())) return '—';
        return d.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        });
    }
</script>

{#if webhooks.length === 0}
    <div class="py-12 text-center text-surface-400">
        <p class="text-sm">No webhooks configured.</p>
    </div>
{:else}
    <div class="overflow-x-auto">
        <table class="w-full text-sm">
            <thead>
                <tr class="border-b border-surface-700 text-left text-surface-400">
                    <th class="px-4 py-3 font-medium">URL</th>
                    <th class="px-4 py-3 font-medium">Events</th>
                    <th class="px-4 py-3 font-medium">Active</th>
                    <th class="px-4 py-3 font-medium">Created</th>
                    <th class="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
            </thead>
            <tbody class="divide-y divide-surface-700/50">
                {#each webhooks as hook (hook.id)}
                    <tr class="hover:bg-surface-800/40 transition-colors">
                        <td class="px-4 py-3">
                            {#if hook.label}
                                <div class="text-sm text-surface-100">{hook.label}</div>
                            {/if}
                            <div class="flex items-center gap-2">
                                <span class="font-mono text-xs text-surface-200" title={hook.url}>
                                    {truncateUrl(hook.url)}
                                </span>
                                <button
                                    type="button"
                                    class="shrink-0 text-surface-400 hover:text-surface-200 transition-colors"
                                    title="Copy URL"
                                    onclick={() => void copyUrl(hook.url, hook.id)}>
                                    <Icon
                                        src={copiedId === hook.id ? Check : ClipboardDocument}
                                        class="w-4 h-4" />
                                </button>
                            </div>
                        </td>
                        <td class="px-4 py-3">
                            <div class="flex flex-wrap gap-1">
                                {#each hook.eventFilter.slice(0, 3) as ev (ev)}
                                    <span
                                        class="rounded bg-surface-700 px-1.5 py-0.5 text-xs text-surface-300">
                                        {ev
                                            .replace(/^org\.lumastra\./, '')
                                            .replace(/^com\.lumastra\./, '')}
                                    </span>
                                {/each}
                                {#if hook.eventFilter.length > 3}
                                    <span
                                        class="rounded bg-surface-700 px-1.5 py-0.5 text-xs text-surface-400">
                                        +{hook.eventFilter.length - 3}
                                    </span>
                                {/if}
                            </div>
                        </td>
                        <td class="px-4 py-3">
                            {#if hook.lastError || (hook.lastStatus ?? 0) >= 300}
                                <span
                                    class="inline-flex rounded bg-red-900/40 px-2 py-0.5 text-xs text-red-400">
                                    {m.webhook_delivery_failed()}
                                </span>
                                {#if hook.lastError}
                                    <p class="mt-1 max-w-sm text-xs text-red-300">
                                        {hook.lastError}
                                    </p>
                                {/if}
                                {#if (hook.deadCount ?? 0) > 0}
                                    <p class="mt-1 text-xs text-red-300">
                                        {m.webhook_delivery_dead({ count: hook.deadCount ?? 0 })}
                                    </p>
                                {/if}
                            {:else}
                                <span
                                    class="inline-block h-2 w-2 rounded-full {hook.active
                                        ? 'bg-green-400'
                                        : 'bg-surface-600'}"
                                    title={hook.active ? 'Active' : 'Inactive'}>
                                </span>
                            {/if}
                            {#if hook.lastDeliveredAt}
                                <p class="mt-1 text-xs text-surface-400">
                                    {m.webhook_delivery_last_success({
                                        date: formatDate(hook.lastDeliveredAt),
                                    })}
                                </p>
                            {/if}
                        </td>
                        <td class="px-4 py-3 text-surface-400">
                            {formatDate(hook.createdAt)}
                        </td>
                        <td class="px-4 py-3 text-right">
                            <div class="flex items-center justify-end gap-1">
                                <WebhookTestButton webhookId={hook.id} />
                                <button
                                    type="button"
                                    class="rounded p-1.5 text-surface-400 hover:bg-surface-700 hover:text-surface-200 transition-colors"
                                    title="Edit webhook"
                                    onclick={() => onEdit(hook)}>
                                    <Icon src={PencilSquare} class="w-4 h-4" />
                                </button>
                                <button
                                    type="button"
                                    class="rounded p-1.5 text-surface-400 hover:bg-red-900/40 hover:text-red-400 transition-colors"
                                    title="Delete webhook"
                                    onclick={() => onDelete(hook.id, hook.url)}>
                                    <Icon src={Trash} class="w-4 h-4" />
                                </button>
                            </div>
                        </td>
                    </tr>
                {/each}
            </tbody>
        </table>
    </div>
{/if}
