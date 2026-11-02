<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Hardware-encoder check of the web replica that answers: a real test encode,
  capabilities, troubleshooting hints and the learned GPU decode cache (with its
  reset). Collapsed by default and fetched only when opened, because each fetch
  can run a test encode. Live GPU load per host is in the host cards above; this
  section names the replica it measured.
-->
<script lang="ts">
    import { page } from '$app/state';
    import { untrack, tick } from 'svelte';
    import { resolve } from '$lib/paths';
    import GpuMetricsSection from '$lib/components/admin/GpuMetricsSection.svelte';
    import { getSystemMetrics } from '$lib/api/admin.js';
    import type { SystemMetrics } from '$lib/types/admin-metrics';
    import * as m from '$lib/paraglide/messages.js';

    let open = $state(false);
    let metrics = $state<SystemMetrics | null>(null);
    let failed = $state(false);
    let loading = $state(false);
    let receivedAt = $state<Date | null>(null);
    let panel: HTMLDetailsElement;

    $effect(() => {
        if (page.url.hash === '#hardware-encoder-check') {
            untrack(() => {
                open = true;
                if (!metrics) void load();
                void tick().then(() => panel?.scrollIntoView({ block: 'start' }));
            });
        }
    });

    async function load(): Promise<void> {
        if (loading) return;
        loading = true;
        try {
            const { data, error } = await getSystemMetrics();
            failed = !!error || !data;
            if (data) {
                metrics = data;
                receivedAt = new Date();
            }
        } catch {
            failed = true;
        } finally {
            loading = false;
        }
    }

    function onToggle(event: Event): void {
        open = (event.currentTarget as HTMLDetailsElement).open;
        if (open && !metrics && !failed) void load();
    }
</script>

<details
    id="hardware-encoder-check"
    bind:this={panel}
    {open}
    class="mt-6 rounded-xl border border-surface-700 bg-surface-800/40 p-4"
    ontoggle={onToggle}
    data-testid="cluster-encoder-check">
    <summary class="cursor-pointer text-sm font-medium text-white">
        {m.admin_cluster_encoder_check()}
        <span class="ml-1 text-xs font-normal text-muted"
            >{m.admin_cluster_encoder_check_hint()}</span>
    </summary>
    {#if open}
        <div class="mt-3 space-y-3">
            {#if metrics}
                <p class="text-xs text-muted" data-testid="cluster-encoder-check-replica">
                    {m.admin_cluster_encoder_check_replica({ hostname: metrics.hostname })}
                    {#if receivedAt}
                        · {m.admin_hardware_result_time({ time: receivedAt.toLocaleString() })}{/if}
                    {#if metrics.ffmpegVersion}· FFmpeg {metrics.ffmpegVersion}{/if}
                </p>
            {/if}
            {#if failed}
                <p class="text-xs text-red-300">{m.admin_cluster_encoder_check_failed()}</p>
            {/if}
            <div class="flex flex-wrap gap-4 text-sm">
                <a
                    class="text-primary-300 underline"
                    href={resolve('/admin/settings/playback?category=ffmpeg-hardware')}
                    >{m.admin_hardware_configure()}</a>
                <button
                    type="button"
                    class="text-primary-300 underline"
                    disabled={loading}
                    onclick={() => void load()}>{m.admin_hardware_refresh()}</button>
            </div>
            <p class="text-xs text-muted">{m.admin_hardware_cached_probe()}</p>
            <GpuMetricsSection gpu={metrics?.gpu} loading={loading || (!metrics && !failed)} />
        </div>
    {/if}
</details>
