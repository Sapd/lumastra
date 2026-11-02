<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { page } from '$app/stores';
    import PersonalStatsPage from '$lib/components/stats/PersonalStatsPage.svelte';
    import * as m from '$lib/paraglide/messages';

    let username = $derived($page.data?.user?.username);
</script>

<svelte:head>
    <title>{m.stats_my_statistics()} | {$page.data?.branding?.appName || 'Dashboard'}</title>
</svelte:head>

{#if username}
    {#key username}
        <PersonalStatsPage {username} isOwnStats={true} />
    {/key}
{:else}
    <div class="center min-h-screen">
        <p class="text-gray-400">{m.stats_login_required()}</p>
    </div>
{/if}
