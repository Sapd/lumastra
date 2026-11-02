<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Sources tab content for Settings → Live TV (admin IA redesign, spec §3.6:
  sources/channels/proxy/radio as tabs on ONE page). Ported near-verbatim
  from the deleted standalone `/admin/livetv` page.
-->
<script lang="ts">
    import { AdminSettingsPage } from '$lib/components/admin';
    import { Tv } from 'svelte-hero-icons';
    import SourceManager from '$lib/components/admin/livetv/SourceManager.svelte';
    import type { SettingsLoadResult } from '$lib/server/admin/settings-helpers';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        data: SettingsLoadResult & { warnings: string[] };
        form: { success?: boolean; error?: string; reloaded?: boolean } | null;
    }

    let { data, form }: Props = $props();
</script>

<AdminSettingsPage
    {data}
    {form}
    icon={Tv}
    heading={m.admin_livetv_sources_title()}
    description={m.admin_livetv_sources_description()}>
    <!-- Sources first: they are what this tab is for. Before, the source list
         and its Add form sat below every Live TV setting, so adding a source
         meant scrolling past 18 settings and the form opened off-screen. -->
    {#snippet beforeSections()}
        <SourceManager />
    {/snippet}
</AdminSettingsPage>
