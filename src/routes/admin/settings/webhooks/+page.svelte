<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import { AdminPageHeader } from '$lib/components/admin/index.js';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons.js';
    import { Icon, Plus } from 'svelte-hero-icons';
    import { toasts } from '$lib/stores/toast.store.js';
    import { apiGet, apiDelete } from '$lib/api/client.js';
    import {
        WebhooksListResponseSchema,
        WebhookDeleteResponseSchema,
    } from '$lib/schemas/api-v1.js';
    import ActionModal from '$lib/components/admin/ActionModal.svelte';
    import WebhookList from '$lib/components/admin/webhooks/WebhookList.svelte';
    import WebhookEditor from '$lib/components/admin/webhooks/WebhookEditor.svelte';
    import type { WebhookRow } from '$lib/components/admin/webhooks/WebhookList.svelte';
    import * as m from '$lib/paraglide/messages.js';

    let webhooks = $state<WebhookRow[]>([]);
    let loading = $state(true);
    let loadError = $state<string | null>(null);

    // Editor panel state
    let showEditor = $state(false);
    let editingWebhook = $state<WebhookRow | null>(null);

    // Delete confirmation state
    let pendingDelete = $state<{ id: string; url: string } | null>(null);
    let deleting = $state(false);

    // Save, delete and retry each reload the list; only the newest answer may land.
    let loadSeq = 0;

    async function loadWebhooks(): Promise<void> {
        const seq = ++loadSeq;
        loading = true;
        loadError = null;
        const { data, error } = await apiGet('/api/webhooks', WebhooksListResponseSchema);
        if (seq !== loadSeq) return;
        if (error || !data) {
            loadError = error ?? 'Failed to load webhooks';
        } else {
            // apiGet fail-opens on a schema mismatch (returns raw data), so guard
            // against a legacy/non-conforming payload (e.g. mid rolling deploy) where
            // `items` is absent — otherwise the WebhookList {#each} throws.
            webhooks = data.items ?? [];
        }
        loading = false;
    }

    function openCreate(): void {
        editingWebhook = null;
        showEditor = true;
    }

    function openEdit(webhook: WebhookRow): void {
        editingWebhook = webhook;
        showEditor = true;
    }

    function onEditorSaved(): void {
        showEditor = false;
        editingWebhook = null;
        void loadWebhooks();
    }

    function onEditorCancel(): void {
        showEditor = false;
        editingWebhook = null;
    }

    function requestDelete(id: string, url: string): void {
        pendingDelete = { id, url };
    }

    async function confirmDelete(): Promise<void> {
        if (!pendingDelete || deleting) return;
        deleting = true;
        const { error } = await apiDelete(
            `/api/webhooks/${pendingDelete.id}`,
            WebhookDeleteResponseSchema,
        );
        if (error) {
            toasts.error(`Delete failed: ${error}`);
        } else {
            toasts.success(m.admin_toast_webhook_deleted());
            // An editor still open on the deleted hook could only fail on save.
            if (editingWebhook?.id === pendingDelete.id) onEditorCancel();
            pendingDelete = null;
            void loadWebhooks();
        }
        deleting = false;
    }

    onMount(() => {
        void loadWebhooks();
    });
</script>

<svelte:head>
    <title>{m.admin_nav_page_settings_webhooks()} - Admin</title>
</svelte:head>

<div class="space-y-6">
    <AdminPageHeader
        icon={adminPageIcons['/admin/settings/webhooks']}
        title="Webhooks"
        description={m.admin_webhooks_description()}>
        <button type="button" class="btn btn-blue flex items-center gap-2" onclick={openCreate}>
            <Icon src={Plus} class="w-4 h-4" />{m.admin_webhooks_new()}</button>
    </AdminPageHeader>

    {#if showEditor}
        <div class="card-bordered p-6">
            <!-- Keyed: the editor seeds its fields from `existing` once. Switching
                 to another hook mid-edit kept the first hook's fields and then
                 PUT them to the second hook's id. -->
            {#key editingWebhook?.id ?? 'new'}
                <WebhookEditor
                    existing={editingWebhook}
                    onSaved={onEditorSaved}
                    onCancel={onEditorCancel} />
            {/key}
        </div>
    {/if}

    <div class="card-bordered overflow-hidden">
        {#if loading}
            <div class="py-12 text-center text-sm text-surface-400">
                {m.common_loading()}
            </div>
        {:else if loadError}
            <div class="py-12 text-center text-sm text-red-400">
                {loadError}
                <button
                    type="button"
                    class="btn btn-secondary ml-3"
                    onclick={() => void loadWebhooks()}>{m.common_retry()}</button>
            </div>
        {:else}
            <WebhookList {webhooks} onEdit={openEdit} onDelete={requestDelete} />
        {/if}
    </div>
</div>

{#if pendingDelete}
    <ActionModal
        title={m.admin_title_delete_webhook()}
        confirmText={m.admin_webhooks_delete_confirm_btn()}
        confirmColor="red"
        disabled={deleting}
        onclose={() => {
            pendingDelete = null;
        }}
        onconfirm={confirmDelete}>
        <p class="text-sm text-surface-300">
            {m.admin_webhooks_delete_prompt_before()}
            <span class="font-mono text-xs text-surface-200 break-all">{pendingDelete.url}</span>?
            {m.admin_webhooks_delete_prompt_after()}
        </p>
    </ActionModal>
{/if}
