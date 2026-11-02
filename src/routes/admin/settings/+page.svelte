<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { AdminSettingsPage } from '$lib/components/admin';
    import AdminNavStyleControl from '$lib/components/admin/settings/AdminNavStyleControl.svelte';
    import LicenseStatusCard from '$lib/components/admin/settings/LicenseStatusCard.svelte';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import type { PageData, ActionData } from './$types';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        data: PageData;
        form: ActionData;
    }

    let { data, form }: Props = $props();
</script>

<svelte:head>
    <title>{m.admin_settings_page_title()}</title>
</svelte:head>

<AdminSettingsPage
    {data}
    {form}
    icon={adminPageIcons['/admin/settings']}
    heading={m.admin_settings_heading()}
    description={m.admin_settings_description()}>
    {#snippet sectionSnippet({ sectionId })}
        <!-- The `auth` (AuthDiagnosticsPanel) and `social` (SocialAudiencePanel)
             companions moved to /admin/settings/access together with their
             sections — a panel must render on the page that renders its
             section, or it documents settings the operator cannot see. -->
        {#if sectionId === 'features'}
            <div class="mt-4">
                <AdminNavStyleControl />
            </div>
        {:else if sectionId === 'licensing'}
            <LicenseStatusCard status={data.licenseSummary ?? null} />
        {/if}
    {/snippet}
</AdminSettingsPage>
