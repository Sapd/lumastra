<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { onMount } from 'svelte';
    import { getApiConformance } from '$lib/api/admin-conformance.js';
    import type { ConformanceResponse } from '$lib/schemas/api-conformance.js';
    import * as m from '$lib/paraglide/messages.js';

    let report = $state<ConformanceResponse | null>(null);
    let loading = $state(true);
    let failed = $state(false);

    async function load(): Promise<void> {
        loading = true;
        failed = false;
        try {
            const result = await getApiConformance(1);
            if (result.error || !result.data) failed = true;
            else report = result.data;
        } catch {
            failed = true;
        } finally {
            loading = false;
        }
    }

    onMount(() => {
        void load();
    });
</script>

<section class="card-bordered space-y-3 p-4">
    <div class="flex items-center justify-between gap-3">
        <h3 class="text-sm font-semibold text-surface-100">{m.admin_apiconf_title()}</h3>
        <button
            class="btn btn-sm variant-ghost-surface"
            onclick={() => void load()}
            disabled={loading}>
            {m.common_refresh()}
        </button>
    </div>
    {#if loading}
        <p class="text-sm text-surface-400">{m.common_loading()}</p>
    {:else if failed}
        <p class="text-sm text-red-300">{m.admin_apiconf_failed()}</p>
    {:else if report}
        <p class="text-sm text-surface-300">
            {m.admin_apiconf_totals({
                stripped: report.totals.stripped,
                mismatch: report.totals.mismatch,
            })}
        </p>
        {#if report.items.length === 0}
            <p class="text-sm text-surface-400">{m.admin_apiconf_empty()}</p>
        {:else}
            <ul class="space-y-2 text-xs">
                {#each report.items.slice(0, 10) as item (`${item.method} ${item.route}|${item.kind}`)}
                    <li class="rounded bg-surface-900/40 p-2">
                        <div class="flex flex-wrap items-center justify-between gap-2">
                            <code class="break-all">{item.method} {item.route}</code>
                            <span
                                class={item.kind === 'mismatch'
                                    ? 'text-red-300'
                                    : 'text-amber-300'}>
                                {item.kind === 'mismatch'
                                    ? m.admin_apiconf_mismatch()
                                    : m.admin_apiconf_stripped()}: {item.count}
                            </span>
                        </div>
                        {#if item.lastSeenAt}
                            <p class="mt-1 text-surface-400">
                                {m.admin_apiconf_first_seen()}: {item.firstSeenAt ?? '–'} · {m.admin_apiconf_last_seen()}:
                                {item.lastSeenAt}{item.lastBuild
                                    ? ` (${m.admin_apiconf_build()} ${item.lastBuild})`
                                    : ''}
                            </p>
                        {/if}
                        {#if item.samples.length > 0}
                            <p class="mt-1 break-all text-surface-400">
                                {m.admin_apiconf_samples()}: {item.samples.join(', ')}
                            </p>
                        {/if}
                    </li>
                {/each}
            </ul>
        {/if}
    {/if}
</section>
