<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import AdminSettingsPage from '$lib/components/admin/settings/AdminSettingsPage.svelte';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import HardwareAccelerationPanel from '$lib/components/admin/settings/HardwareAccelerationPanel.svelte';
    import TranscodeDiagnosticsPanel from '$lib/components/admin/playback/TranscodeDiagnosticsPanel.svelte';
    import TrickplayHwaccelDenyPanel from '$lib/components/admin/playback/TrickplayHwaccelDenyPanel.svelte';
    import type { PageData, ActionData } from './$types';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        data: PageData;
        form: ActionData;
    }

    let { data, form }: Props = $props();
</script>

<svelte:head>
    <title>{m.admin_playback_page_title()}</title>
</svelte:head>

<AdminSettingsPage
    {data}
    {form}
    icon={adminPageIcons['/admin/settings/playback']}
    heading={m.admin_playback_heading()}
    description={m.admin_playback_description()}>
    {#snippet beforeSectionSnippet({ sectionId, currentValues, envOverridesSet, handleChange })}
        {#if sectionId === 'ffmpeg-hardware'}
            <HardwareAccelerationPanel
                savedValues={data.values}
                {currentValues}
                {envOverridesSet}
                {handleChange} />
        {/if}
    {/snippet}
    {#snippet sectionSnippet({ sectionId })}
        {#if sectionId === 'ffmpeg'}
            <div class="mt-4 space-y-4">
                <TranscodeDiagnosticsPanel />
                <TrickplayHwaccelDenyPanel />
            </div>
        {/if}
    {/snippet}
</AdminSettingsPage>
