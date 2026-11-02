<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  A plugin-owned page, inside the normal app shell.

  The plugin renders everything below the title; its data comes from its own
  `/api/plugins/<featureId>/*` routes, so this adds no server dispatch surface
  at all.
-->
<script lang="ts">
    import PluginWidgetSlot from '$lib/components/plugins/PluginWidgetSlot.svelte';
    import type { PageData } from './$types';

    let { data }: { data: PageData } = $props();
</script>

<svelte:head>
    <title>{data.page.title}</title>
</svelte:head>

<div class="plugin-page">
    <h1 class="plugin-page-title">{data.page.title}</h1>
    {#key `${data.featureId}:${data.page.id}`}
        <PluginWidgetSlot
            widget={{
                featureId: data.featureId,
                id: `plugin-page:${data.featureId}:${data.page.id}`,
                title: data.page.title,
                entry: data.page.entry,
            }}
            user={data.pluginUser ?? null}
            minHeight="60vh"
            context={{ surface: 'page' }} />
    {/key}
</div>

<style>
    .plugin-page {
        padding: 1.5rem;
        max-width: 90rem;
        margin: 0 auto;
    }

    .plugin-page-title {
        font-family: var(--lum-font-heading);
        font-size: 1.75rem;
        font-weight: 700;
        color: var(--text);
        margin: 0 0 1.25rem;
    }
</style>
