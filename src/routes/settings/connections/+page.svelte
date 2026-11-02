<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { page } from '$app/stores';
    import ConnectionsSection from '$lib/components/settings/ConnectionsSection.svelte';
    import PluginWidgetSlot from '$lib/components/plugins/PluginWidgetSlot.svelte';

    // Where a watch-sync or scrobble connector puts its "link my account" UI.
    // The per-user credential store has existed for a while with nowhere for a
    // user to actually populate it — this is that place.
    let pluginWidgets = $derived(
        ($page.data?.pluginWidgets ?? []).filter(
            (w: { placement?: string }) => w.placement === 'settings-user',
        ),
    );
</script>

<ConnectionsSection />

{#if pluginWidgets.length > 0}
    <div class="plugin-connection-slots">
        {#each pluginWidgets as w (w.id)}
            <PluginWidgetSlot
                widget={{
                    featureId: w.featureId,
                    id: w.id,
                    title: w.title,
                    entry: w.entry,
                }}
                user={$page.data?.pluginUser ?? null}
                chrome={w.chrome ?? true}
                minHeight={`${w.minHeightPx ?? 120}px`}
                context={{ surface: 'settings-user' }} />
        {/each}
    </div>
{/if}

<style>
    .plugin-connection-slots {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        margin-top: 1rem;
    }
</style>
