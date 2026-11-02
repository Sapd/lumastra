<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  One category's worth of provider cards (status, health check, settings
  modal) — extracted from the Providers page so the SAME
  interactive card renders wherever a provider category needs to show
  (Settings → Providers' Metadata/AI sections AND Settings → Plugins &
  features' Integrations section, admin IA redesign spec §3.6 "registry
  renders once" — the CARD renders once too, not per page).
-->
<script lang="ts">
    import {
        Icon,
        CheckCircle,
        XCircle,
        ArrowPath,
        Cog6Tooth,
        type IconSource,
    } from 'svelte-hero-icons';
    import * as adminApi from '$lib/api/admin';
    import PluginSettingsPanel from '$lib/components/admin/PluginSettingsPanel.svelte';
    import { openPluginSettings } from '$lib/stores/plugin-settings-open.store';
    import * as m from '$lib/paraglide/messages.js';
    import type { AdminProviderEntry } from '$lib/server/plugins/runtime/admin-providers-listing';

    interface Props {
        title: string;
        description: string;
        icon: IconSource;
        iconClass?: string;
        providers: AdminProviderEntry[];
        /**
         * Provider ids that have a live connectivity check. "Check" only
         * renders for these — offering it everywhere meant most clicks
         * answered "No health check available".
         */
        checkableIds?: ReadonlySet<string>;
        /**
         * Where to configure a provider that has no settings modal of its own
         * (e.g. the Jellyfin metadata provider, configured by the Jellyfin
         * connection) — rendered as a link instead of a dead end.
         */
        configureLinks?: Readonly<Record<string, { href: string; label: string }>>;
    }

    let {
        title,
        description,
        icon,
        iconClass = 'text-surface-400',
        providers,
        checkableIds,
        configureLinks = {},
    }: Props = $props();

    // Health check state per provider
    let healthResults: Record<
        string,
        {
            checking: boolean;
            healthy?: boolean;
            checkable?: boolean;
            latencyMs?: number;
            error?: string;
            rateLimited?: boolean;
            serverInfo?: Record<string, unknown>;
        }
    > = $state({});

    function canCheck(p: AdminProviderEntry): boolean {
        return p.configured && (checkableIds ? checkableIds.has(p.provider) : true);
    }

    // Settings expand inline under the card (the shared settings components),
    // not in a modal.
    function toggleSettings(pluginId: string): void {
        openPluginSettings.update((current) => (current === pluginId ? null : pluginId));
    }

    function getStatusDot(p: AdminProviderEntry): { color: string; label: string } {
        const health = healthResults[p.provider];
        if (!p.configured)
            return { color: 'bg-surface-500', label: m.admin_providers_not_configured() };
        // No connectivity check exists (e.g. file-scanner) — neutral, not a failure.
        if (health?.checkable === false)
            return { color: 'bg-surface-500', label: m.providers_health_not_applicable() };
        if (health?.healthy === true)
            return { color: 'bg-green-400', label: m.providers_status_healthy() };
        if (health?.rateLimited)
            return { color: 'bg-amber-400', label: m.providers_status_rate_limited() };
        if (health?.healthy === false)
            return { color: 'bg-red-400', label: m.providers_status_unhealthy() };
        // Configured but not checked yet: neutral. Yellow read as a warning on
        // every card of a healthy install.
        return { color: 'bg-surface-400', label: m.providers_status_not_checked() };
    }

    async function checkHealth(provider: string): Promise<void> {
        healthResults[provider] = { checking: true };
        const { data: result, error } = await adminApi.checkProviderHealth(provider);
        if (error || !result) {
            healthResults[provider] = {
                checking: false,
                healthy: false,
                error: error ?? m.request_failed(),
            };
            return;
        }
        healthResults[provider] = {
            checking: false,
            healthy: result.healthy,
            checkable: result.checkable,
            latencyMs: result.latencyMs,
            error: result.error,
            rateLimited: result.rateLimited,
            serverInfo: result.serverInfo,
        };
    }
</script>

<div>
    <div class="between mb-4">
        <h3 class="text-lg font-semibold flex items-center gap-2">
            <Icon src={icon} class="w-5 h-5 {iconClass}" />
            {title}
        </h3>
    </div>
    <p class="text-sm text-surface-400 mb-3">{description}</p>

    <div class="grid gap-4">
        {#each providers as provider (provider.provider)}
            {@const health = healthResults[provider.provider]}
            {@const statusDot = getStatusDot(provider)}
            <!-- id lets a ?settings=<id> deep-link (⌘K palette / admin alert)
                 scroll to + highlight this card, mirroring the settings search. -->
            {@const configureLink = configureLinks[provider.provider]}
            <div
                id="settings-card-{provider.provider}"
                class="card-bordered transition-colors {!provider.enabled ? 'opacity-60' : ''}">
                <div class="flex flex-col lg:flex-row lg:items-center gap-4">
                    <!-- Left: Info -->
                    <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-3 mb-2">
                            <!-- Status dot -->
                            <span
                                class="w-2.5 h-2.5 rounded-full shrink-0 {statusDot.color}"
                                title={statusDot.label}
                                aria-label={statusDot.label}></span>

                            <h4 class="text-lg font-medium text-white">
                                {provider.label}
                            </h4>
                            <span class="text-xs text-surface-500">{provider.provider}</span>

                            <!-- Source badge -->
                            {#if provider.source === 'external'}
                                <span
                                    class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-900/50 text-purple-300 border border-purple-700/50">
                                    {m.providers_badge_external()}
                                </span>
                            {/if}

                            {#if !provider.configured}
                                <span
                                    class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-surface-700 text-surface-400">
                                    {m.providers_badge_not_configured()}
                                </span>
                            {:else if provider.enabled}
                                <span
                                    class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-900/50 text-green-300">
                                    <Icon src={CheckCircle} class="w-3 h-3 mr-1" />
                                    {m.providers_badge_configured()}
                                </span>
                            {:else}
                                <span
                                    class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-900/50 text-red-300">
                                    <Icon src={XCircle} class="w-3 h-3 mr-1" />
                                    {m.providers_badge_disabled()}
                                </span>
                            {/if}
                        </div>

                        <!-- Capabilities -->
                        {#if Object.keys(provider.capabilities).length > 0}
                            <div class="flex flex-wrap gap-1.5 mb-2">
                                {#each Object.entries(provider.capabilities) as [cap, enabled] (cap)}
                                    {#if enabled}
                                        <span
                                            class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-cyan-900/30 text-cyan-300 border border-cyan-800/50">
                                            {cap}
                                        </span>
                                    {/if}
                                {/each}
                            </div>
                        {/if}

                        <!-- Health result -->
                        {#if health && !health.checking}
                            <div class="flex items-center gap-2 text-sm">
                                {#if health.checkable === false}
                                    <span class="text-surface-400"
                                        >{m.providers_health_not_applicable()}</span>
                                {:else if health.healthy}
                                    <span class="text-green-400"
                                        >{m.providers_health_healthy()}</span>
                                    {#if health.latencyMs !== undefined}
                                        <span class="text-surface-500">{health.latencyMs}ms</span>
                                    {/if}
                                    {#if health.serverInfo}
                                        <span class="text-surface-500"
                                            >({Object.values(health.serverInfo)
                                                .filter(Boolean)
                                                .join(', ')})</span>
                                    {/if}
                                {:else if health.rateLimited}
                                    <span class="text-amber-300"
                                        >{m.providers_status_rate_limited()}</span>
                                    {#if health.error}
                                        <span class="text-amber-300/70">— {health.error}</span>
                                    {/if}
                                {:else}
                                    <span class="text-red-400"
                                        >{m.providers_health_unhealthy()}</span>
                                    {#if health.latencyMs !== undefined}
                                        <span class="text-surface-500">{health.latencyMs}ms</span>
                                    {/if}
                                    {#if health.error}
                                        <span class="text-red-400/70">— {health.error}</span>
                                    {/if}
                                {/if}
                            </div>
                        {/if}
                    </div>

                    <!-- Right: Actions -->
                    <div class="flex items-center gap-3 lg:flex-shrink-0">
                        <!-- Health check button (hidden once a provider is
                             known to have no health check) -->
                        {#if canCheck(provider) && health?.checkable !== false}
                            <button
                                type="button"
                                class="btn btn-sm btn-ghost flex min-h-9 items-center gap-1 sm:min-h-0"
                                aria-label={m.providers_button_check_label({
                                    provider: provider.label,
                                })}
                                disabled={health?.checking}
                                onclick={() => checkHealth(provider.provider)}>
                                <Icon
                                    src={ArrowPath}
                                    class="w-4 h-4 {health?.checking ? 'animate-spin' : ''}" />
                                <span class="hidden sm:inline text-xs"
                                    >{m.providers_button_check()}</span>
                            </button>
                        {/if}

                        <!-- Settings button -->
                        {#if provider.hasSettings}
                            <button
                                type="button"
                                class="btn btn-sm btn-ghost flex min-h-9 items-center gap-1 sm:min-h-0"
                                aria-label={m.providers_button_settings_label({
                                    provider: provider.label,
                                })}
                                aria-expanded={$openPluginSettings === provider.provider}
                                onclick={() => toggleSettings(provider.provider)}>
                                <Icon src={Cog6Tooth} class="w-4 h-4" />
                                <span class="hidden sm:inline text-xs"
                                    >{m.providers_button_settings()}</span>
                            </button>
                        {:else if configureLink}
                            <a
                                href={configureLink.href}
                                class="text-xs font-medium text-sky-400 hover:text-sky-300"
                                >{configureLink.label}</a>
                        {/if}
                    </div>
                </div>
                {#if provider.hasSettings && $openPluginSettings === provider.provider}
                    <div class="mt-4">
                        <PluginSettingsPanel
                            pluginId={provider.provider}
                            heading={m.plugin_settings_title({ name: provider.label })}
                            onClose={() => openPluginSettings.set(null)} />
                    </div>
                {/if}
            </div>
        {/each}
    </div>
</div>

<style>
    /* Deep-link reveal highlight for settings cards. `:global` so it also
       applies to the plugins page's inline feature/watch-sync cards, which
       carry the same `settings-card-highlight` class but live outside this
       component. Mirrors SettingInput's `search-highlight` glow. */
    :global(.settings-card-highlight) {
        animation: settings-card-glow 2.2s ease-out;
        border-radius: 0.75rem;
    }

    @keyframes settings-card-glow {
        0% {
            box-shadow: 0 0 0 2px rgb(250 204 21 / 0.9);
            background-color: rgb(250 204 21 / 0.12);
        }
        100% {
            box-shadow: 0 0 0 2px rgb(250 204 21 / 0);
            background-color: rgb(250 204 21 / 0);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        :global(.settings-card-highlight) {
            animation: none;
            box-shadow: 0 0 0 2px rgb(250 204 21 / 0.9);
        }
    }
</style>
