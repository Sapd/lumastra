<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Channels tab content for Settings → Live TV (admin IA redesign, spec §3.6:
  sources/channels/proxy/radio as tabs on ONE page). Ported near-verbatim
  from the deleted standalone `/admin/livetv/channels` page — fully
  self-fetching, no props from the parent route needed.

  This tab has its OWN inner sub-tabs (channels / backup groups / EPG
  review). Its `urlParam` is renamed to `ctab` so it doesn't collide with
  the parent Live TV page's own `?tab=sources|channels|proxy|radio` param.
-->
<script lang="ts">
    import { untrack } from 'svelte';
    import { apiGet, apiPost } from '$lib/api/client.js';
    import {
        AdminChannelsResponseSchema,
        RenumberChannelsResponseSchema,
    } from '$lib/schemas/livetv.js';
    import type { AdminChannelsResponse } from '$lib/schemas/livetv.js';
    import { toasts } from '$lib/stores/toast.store';
    import { resolve } from '$lib/paths';
    import { AdminPageHeader } from '$lib/components/admin';
    import { Tv } from 'svelte-hero-icons';
    import { ConfirmModal, Tabs } from '$lib/components/ui';
    import ChannelTable from '$lib/components/admin/livetv/ChannelTable.svelte';
    import BackupGroupEditor from '$lib/components/admin/livetv/BackupGroupEditor.svelte';
    import EPGMatchReview from '$lib/components/admin/livetv/EPGMatchReview.svelte';
    import ViewerPreview from '$lib/components/admin/livetv/ViewerPreview.svelte';
    import * as m from '$lib/paraglide/messages.js';

    type SubTab = 'channels' | 'backup-groups' | 'epg-matches' | 'viewer-preview';

    const subTabItems: { id: SubTab; label: string }[] = [
        { id: 'channels', label: m.admin_livetv_channels_title() },
        { id: 'backup-groups', label: m.admin_livetv_backup_groups() },
        { id: 'epg-matches', label: m.admin_livetv_epg_review() },
        { id: 'viewer-preview', label: m.admin_livetv_viewer_preview() },
    ];

    let activeSubTab = $state<SubTab>('channels');

    let data = $state<AdminChannelsResponse | null>(null);
    let loading = $state(true);

    /** `quiet`: keep the list on screen (a number change reloads it). */
    async function loadChannels(quiet = false): Promise<void> {
        if (!quiet) loading = true;
        const { data: result, error } = await apiGet(
            '/api/admin/livetv/channels',
            AdminChannelsResponseSchema,
        );
        if (error) {
            toasts.error(error);
        } else if (result) {
            data = result;
        }
        loading = false;
    }

    $effect(() => {
        untrack(() => loadChannels());
    });

    // "Renumber in current order" — changes the numbers viewers know, so it asks first.
    let confirmRenumber = $state(false);

    async function renumber(): Promise<void> {
        const { data: result, error } = await apiPost(
            '/api/admin/livetv/channels/renumber',
            RenumberChannelsResponseSchema,
            {},
        );
        confirmRenumber = false;
        if (error || !result) {
            toasts.error(m.admin_livetv_number_save_error());
            return;
        }
        toasts.success(m.admin_livetv_renumber_done({ count: String(result.numbered) }));
        await loadChannels(true);
    }
</script>

<div class="space-y-6">
    <AdminPageHeader
        icon={Tv}
        title={m.admin_livetv_channels_title()}
        description={m.admin_livetv_channels_description()} />

    <Tabs
        items={subTabItems}
        bind:active={activeSubTab}
        variant="underline"
        size="sm"
        syncToUrl
        urlParam="ctab" />

    {#if activeSubTab === 'channels'}
        {#if loading}
            <div class="space-y-4">
                <div class="h-8 bg-surface-700 rounded animate-pulse w-64"></div>
                <div class="bg-surface-800 rounded-lg overflow-hidden">
                    {#each Array(5) as _, i (i)}
                        <div class="px-4 py-3 border-b border-surface-700">
                            <div class="h-6 bg-surface-700 rounded animate-pulse"></div>
                        </div>
                    {/each}
                </div>
            </div>
        {:else if data && data.totalChannels > 0}
            <p class="text-sm text-surface-400">
                {m.admin_livetv_channels_summary({
                    visible: data.visibleChannels,
                    total: data.totalChannels,
                    categories: data.categories.length,
                })}
            </p>
            <div
                class="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-800 px-4 py-3">
                <p class="text-sm text-surface-400 max-w-3xl">{m.admin_livetv_numbers_help()}</p>
                <button
                    type="button"
                    class="shrink-0 rounded-md border border-surface-600 px-3 py-1.5 text-sm text-surface-200 hover:bg-surface-700"
                    onclick={() => (confirmRenumber = true)}>
                    {m.admin_livetv_renumber()}
                </button>
            </div>
            <ChannelTable
                categories={data.categories}
                totalChannels={data.totalChannels}
                onNumbersChanged={() => loadChannels(true)} />
        {:else}
            <div class="bg-surface-800 rounded-lg p-8 text-center">
                <p class="text-surface-400">
                    {m.admin_livetv_channels_empty()}
                </p>
                <a
                    href={resolve('/admin/settings/livetv')}
                    class="mt-4 inline-block text-yellow-500 hover:text-yellow-400 underline">
                    {m.admin_livetv_go_to_sources()}
                </a>
            </div>
        {/if}
    {:else if activeSubTab === 'backup-groups'}
        <BackupGroupEditor />
    {:else if activeSubTab === 'epg-matches'}
        <EPGMatchReview />
    {:else if activeSubTab === 'viewer-preview'}
        <ViewerPreview />
    {/if}
</div>

{#if confirmRenumber}
    <ConfirmModal
        title={m.admin_livetv_renumber()}
        body={m.admin_livetv_renumber_confirm()}
        confirmText={m.admin_livetv_renumber()}
        confirmVariant="danger"
        onConfirm={renumber}
        onCancel={() => (confirmRenumber = false)} />
{/if}
