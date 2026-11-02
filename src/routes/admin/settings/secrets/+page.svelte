<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { AdminPageHeader } from '$lib/components/admin/index.js';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons.js';
    import SecretsManager from '$lib/components/admin/secrets/SecretsManager.svelte';
    import type { SecretsPageData } from './+page.server.js';
    import * as m from '$lib/paraglide/messages.js';

    let { data }: { data: SecretsPageData } = $props();
</script>

<svelte:head>
    <title>{m.admin_nav_page_settings_secrets()} - Admin</title>
</svelte:head>

<div class="space-y-6">
    <AdminPageHeader
        icon={adminPageIcons['/admin/settings/secrets']}
        title={m.admin_secrets_title()}
        description={m.admin_secrets_description()} />

    {#if data.dbError}
        <div class="rounded border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {data.dbError}
        </div>
    {:else}
        <SecretsManager secretKeys={data.secretKeys} />
    {/if}
</div>
