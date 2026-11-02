<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, Cog6Tooth } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';

    interface ServiceStatus {
        configured: boolean;
        label: string;
        version?: string;
        /** Cached reachability probe; absent = not probed. */
        probe?: { status: 'pass' | 'warn' };
    }

    interface Props {
        services: Record<string, ServiceStatus>;
        /** Card heading — defaults to the generic "Provider & service connections". */
        title?: string;
    }

    let { services, title = m.admin_health_services_title() }: Props = $props();

    /**
     * Some services report long version strings — Jellyseerr's
     * `/api/v1/status` returns the dev-build commit hash as version
     * (e.g. `develop-7f3979411b557e75f6f5...`) which overflowed the
     * service tile and rendered as a meaningless token. Truncate
     * anything past 12 chars and surface the full value as a tooltip.
     */
    function formatVersion(v: string): string {
        const semverMatch = /^v?\d+\.\d+\.\d+(?:[-+][\w.]+)?$/.test(v);
        if (semverMatch) return v;
        if (v.length <= 12) return v;
        return v.slice(0, 12) + '…';
    }

    /**
     * Only a passing probe is green. "Configured" alone says nothing about
     * whether the service answers, so it gets a neutral "not checked" state —
     * green for configuration was a health claim nobody had verified.
     */
    type Tone = 'down' | 'up' | 'unchecked' | 'off';
    function tone(s: ServiceStatus): Tone {
        if (!s.configured) return 'off';
        if (s.probe?.status === 'warn') return 'down';
        if (s.probe?.status === 'pass') return 'up';
        return 'unchecked';
    }
    const TONE_ORDER: Record<Tone, number> = { down: 0, up: 1, unchecked: 2, off: 3 };
    const TILE: Record<Tone, string> = {
        down: 'bg-red-900/20 border-red-800 text-red-300',
        up: 'bg-green-900/20 border-green-800 text-green-300',
        unchecked: 'bg-surface-800/40 border-surface-600 text-surface-200',
        off: 'bg-surface-700/30 border-surface-700 text-surface-500',
    };
    const DOT: Record<Tone, string> = {
        down: 'bg-red-400',
        up: 'bg-green-400',
        unchecked: 'bg-surface-400',
        off: 'bg-surface-600',
    };

    // Unreachable first, then reachable, then configured-but-unchecked, then
    // not configured — alphabetical within each.
    let sortedEntries = $derived.by(() => {
        return Object.entries(services).sort(([, a], [, b]) => {
            const d = TONE_ORDER[tone(a)] - TONE_ORDER[tone(b)];
            if (d !== 0) return d;
            return a.label.localeCompare(b.label);
        });
    });

    let configuredCount = $derived(Object.values(services).filter((s) => s.configured).length);
    let totalCount = $derived(Object.keys(services).length);
</script>

<div class="card-bordered">
    <div class="flex items-center gap-2 mb-4">
        <Icon src={Cog6Tooth} class="w-5 h-5 text-surface-400" />
        <h3 class="font-medium text-white">{title}</h3>
        <span class="text-xs text-surface-500 ml-auto"
            >{m.admin_health_services_configured_count({
                configured: configuredCount,
                total: totalCount,
            })}</span>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
        {#each sortedEntries as [key, service] (key)}
            {@const t = tone(service)}
            <div
                class="flex flex-col gap-0.5 px-3 py-2 rounded-lg border transition-colors {TILE[
                    t
                ]}"
                data-tone={t}>
                <div class="flex items-center gap-2">
                    <div class="w-2 h-2 rounded-full shrink-0 {DOT[t]}"></div>
                    <span class="text-sm font-medium">{service.label}</span>
                </div>
                {#if t === 'down'}
                    <span class="text-[10px] text-red-300 pl-4"
                        >{m.admin_health_services_unreachable()}</span>
                {:else if t === 'unchecked'}
                    <span class="text-[10px] text-surface-400 pl-4"
                        >{m.admin_health_services_not_checked()}</span>
                {:else if t === 'off'}
                    <span class="text-[10px] text-surface-600 pl-4"
                        >{m.admin_health_services_not_configured()}</span>
                {/if}
                {#if service.configured && service.version}
                    <span
                        class="text-[10px] text-surface-500 pl-4 font-mono truncate"
                        title={service.version}>{formatVersion(service.version)}</span>
                {/if}
            </div>
        {/each}
    </div>
</div>
