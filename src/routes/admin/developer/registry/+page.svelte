<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Developer → Registry (admin IA redesign, spec §3.7): the raw, complete
  plugin/task runtime registry, rendered exactly once. Curated subsets of
  this same data live on Settings → Plugins & features (feature/watch-sync/
  integration cards with Configure) and Settings → Providers (metadata
  chain) — this page is deliberately the un-curated, mono/raw-id view for
  developers, not a second operator surface.
-->
<script lang="ts">
    import { Icon, ArrowPath, Cog6Tooth, TableCells } from 'svelte-hero-icons';
    import type { PageData } from './$types';
    import { AdminPageHeader } from '$lib/components/admin';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import * as adminApi from '$lib/api/admin';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        data: PageData;
    }

    let { data }: Props = $props();

    const GROUP_LABELS: Record<string, () => string> = {
        metadataProviders: m.admin_registry_group_metadata_providers,
        aiServices: m.admin_registry_group_ai_services,
        syncTasks: m.admin_registry_group_sync_tasks,
        featurePlugins: m.admin_registry_group_feature_plugins,
        watchSyncPlugins: m.admin_registry_group_watch_sync_plugins,
        integrations: m.admin_registry_group_integrations,
        mediaSources: m.admin_registry_group_media_sources,
        trickplayProviders: m.admin_registry_group_trickplay_providers,
        subtitleProviders: m.admin_registry_group_subtitle_providers,
        lyricsProviders: m.admin_registry_group_lyrics_providers,
        authProviders: m.admin_registry_group_auth_providers,
    };

    interface CheckState {
        checking: boolean;
        checkable?: boolean;
        healthy?: boolean;
        latencyMs?: number;
        error?: string;
    }

    // Keyed by entry id — flat across all groups, ids are unique per the
    // registry's own collision guard (TaskRegistry's per-type Maps).
    let checks: Record<string, CheckState> = $state({});

    async function runCheck(id: string): Promise<void> {
        checks[id] = { checking: true };
        const { data: result, error } = await adminApi.checkProviderHealth(id);
        if (error || !result) {
            checks[id] = { checking: false, healthy: false, error: error ?? m.request_failed() };
            return;
        }
        checks[id] = {
            checking: false,
            checkable: result.checkable,
            healthy: result.healthy,
            latencyMs: result.latencyMs,
            error: result.error,
        };
    }
</script>

<svelte:head>
    <title>{m.admin_nav_page_developer_registry()} - Admin</title>
</svelte:head>

<div class="space-y-6">
    <AdminPageHeader
        icon={adminPageIcons['/admin/developer/registry']}
        title={m.admin_nav_page_developer_registry()}
        description={m.admin_nav_desc_developer_registry()} />

    <p class="text-xs font-mono text-surface-500">
        {m.admin_registry_total_count({ count: data.totalCount })}
    </p>

    {#each data.groups as group (group.kind)}
        {#if group.entries.length > 0}
            <div class="card-base">
                <div class="mb-3 flex items-center gap-2">
                    <Icon src={TableCells} class="h-4 w-4 text-surface-500" />
                    <h3 class="font-mono text-sm font-semibold text-surface-300">
                        {GROUP_LABELS[group.kind]?.() ?? group.kind}
                    </h3>
                    <span class="text-xs text-surface-600">({group.entries.length})</span>
                </div>
                <div class="overflow-x-auto">
                    <table class="w-full text-sm">
                        <thead>
                            <tr
                                class="border-b border-surface-800 text-left text-xs uppercase text-surface-600">
                                <th class="py-2 pr-4 font-mono font-medium"
                                    >{m.admin_registry_col_id()}</th>
                                <th class="py-2 pr-4 font-medium">{m.admin_registry_col_name()}</th>
                                <th class="py-2 pr-4 font-mono font-medium"
                                    >{m.admin_registry_col_version()}</th>
                                <th class="py-2 pr-4 font-medium"
                                    >{m.admin_registry_col_settings()}</th>
                                <th class="py-2 pr-0 text-right font-medium"
                                    >{m.admin_registry_col_check()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each group.entries as entry (entry.id)}
                                {@const check = checks[entry.id]}
                                <tr class="border-b border-surface-800/60">
                                    <td class="py-2 pr-4 font-mono text-xs text-surface-300"
                                        >{entry.id}</td>
                                    <td class="py-2 pr-4 text-surface-300">{entry.name}</td>
                                    <td class="py-2 pr-4 font-mono text-xs text-surface-500"
                                        >{entry.version}</td>
                                    <td class="py-2 pr-4 text-xs text-surface-500">
                                        {#if entry.hasSettings}
                                            <Icon
                                                src={Cog6Tooth}
                                                class="h-3.5 w-3.5"
                                                aria-label={m.admin_registry_has_settings()} />
                                        {:else}
                                            <span aria-hidden="true">—</span>
                                        {/if}
                                    </td>
                                    <td class="py-2 pr-0 text-right">
                                        {#if check && !check.checking}
                                            {#if check.checkable === false}
                                                <span class="text-xs text-surface-600"
                                                    >{m.providers_health_not_applicable()}</span>
                                            {:else if check.healthy}
                                                <span class="text-xs text-green-400"
                                                    >{m.providers_health_healthy()}{#if check.latencyMs !== undefined}
                                                        &nbsp;{check.latencyMs}ms{/if}</span>
                                            {:else}
                                                <span
                                                    class="text-xs text-red-400"
                                                    title={check.error}
                                                    >{m.providers_health_unhealthy()}</span>
                                            {/if}
                                        {/if}
                                        <button
                                            type="button"
                                            class="btn btn-sm btn-ghost ml-2 inline-flex items-center gap-1"
                                            disabled={check?.checking}
                                            onclick={() => void runCheck(entry.id)}>
                                            <Icon
                                                src={ArrowPath}
                                                class="h-3.5 w-3.5 {check?.checking
                                                    ? 'animate-spin'
                                                    : ''}" />
                                            <span class="text-xs"
                                                >{m.providers_button_check()}</span>
                                        </button>
                                    </td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
            </div>
        {/if}
    {/each}
</div>
