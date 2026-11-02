<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { page } from '$app/stores';
    import PersonalStatsPage from '$lib/components/stats/PersonalStatsPage.svelte';

    let targetUsername = $derived($page.params.username);
    let currentUser = $derived($page.data?.user?.username);
    let isOwnStats = $derived(currentUser?.toLowerCase() === targetUsername?.toLowerCase());
</script>

<svelte:head>
    <title>Stats: {targetUsername} | {$page.data?.branding?.appName || 'Dashboard'}</title>
</svelte:head>

{#if targetUsername}
    {#key JSON.stringify([targetUsername, isOwnStats])}
        <PersonalStatsPage username={targetUsername} {isOwnStats} />
    {/key}
{:else}
    <div class="center min-h-screen">
        <p class="text-gray-400">User not found.</p>
    </div>
{/if}
