<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Settings → Connections. A status grid of every external service (click one to
  open its section), then the standard settings form — one section per service,
  each with its URL, key, Test connection and the switches that depend on it.
-->
<script lang="ts">
    import type { PageData, ActionData } from './$types';
    import { AdminSettingsPage, JellyfinPairingStatus } from '$lib/components/admin';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import { page } from '$app/state';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        data: PageData;
        form: ActionData;
    }

    let { data, form }: Props = $props();

    let selected = $derived(page.url.searchParams.get('category'));
    let configuredCount = $derived(data.connections.filter((c) => c.configured).length);
</script>

<svelte:head>
    <title>{m.admin_nav_page_settings_connections()} - Admin</title>
</svelte:head>

<AdminSettingsPage
    {data}
    {form}
    icon={adminPageIcons['/admin/settings/connections']}
    heading={m.admin_nav_page_settings_connections()}
    description={m.admin_connections_description()}>
    {#snippet beforeSections()}
        <JellyfinPairingStatus status={data.jellyfinPairing} />
        <section class="mb-6" aria-label={m.admin_connections_overview()}>
            <p class="mb-3 text-sm text-surface-400">
                {m.admin_connections_summary({
                    configured: configuredCount,
                    total: data.connections.length,
                })}
            </p>
            <ul class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {#each data.connections as conn (conn.section)}
                    <li>
                        <a
                            href="?category={conn.section}"
                            data-sveltekit-noscroll
                            aria-current={selected === conn.section ? 'true' : undefined}
                            class="flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors
                                {selected === conn.section
                                ? 'border-primary-500/60 bg-primary-500/10 text-white'
                                : 'border-surface-700 bg-surface-800/40 text-surface-200 hover:bg-surface-800'}">
                            <span
                                class="h-2 w-2 shrink-0 rounded-full {conn.configured
                                    ? 'bg-green-400'
                                    : 'bg-surface-500'}"
                                aria-hidden="true"></span>
                            <span class="min-w-0 flex-1 truncate font-medium">{conn.name}</span>
                            <span class="shrink-0 text-xs text-surface-400"
                                >{conn.configured
                                    ? m.admin_connections_set_up()
                                    : m.admin_connections_not_set_up()}</span>
                        </a>
                    </li>
                {/each}
            </ul>
        </section>
    {/snippet}
</AdminSettingsPage>
