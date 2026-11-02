<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Optional-dependency reachability report on the admin health page. Reuses the same
  server probe (`runDependencyChecks`) as the first-run wizard, plus media-library
  path readability (a DB handle is available here). Self-fetching on mount + manual
  refresh — deliberately NOT on the fast poll, since each check makes an outbound
  network request. Non-blocking, informational.
-->
<script lang="ts">
    import { onMount } from 'svelte';
    import { z } from 'zod';
    import { Icon, ArrowPath } from 'svelte-hero-icons';
    import { apiGet } from '$lib/api/client.js';
    import * as m from '$lib/paraglide/messages.js';
    import StatusPip from './StatusPip.svelte';
    import {
        dependencyCheckText,
        type DependencyFindingView,
    } from '$lib/utils/dependency-check-text.js';

    const ENDPOINT = '/api/admin/dependency-check';

    const ResponseSchema = z.object({
        checks: z.array(
            z.object({
                id: z.string(),
                name: z.string(),
                status: z.enum(['pass', 'warn']),
                url: z.string().optional(),
                count: z.number().optional(),
            }),
        ),
    });

    let checks = $state<DependencyFindingView[]>([]);
    let loading = $state(true);
    let loadError = $state<string | null>(null);

    // Warnings first so problems are immediately visible.
    const sorted = $derived(
        [...checks].sort((a, b) => (a.status === b.status ? 0 : a.status === 'warn' ? -1 : 1)),
    );
    const warnCount = $derived(checks.filter((c) => c.status === 'warn').length);

    async function fetchChecks(): Promise<void> {
        loading = true;
        const { data, error } = await apiGet(ENDPOINT, ResponseSchema);
        if (error || !data) {
            loadError = error ?? m.admin_deps_fetch_failed();
        } else {
            checks = data.checks;
            loadError = null;
        }
        loading = false;
    }

    onMount(() => {
        void fetchChecks();
    });
</script>

<section class="card-bordered p-4 space-y-3">
    <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2">
            <h3 class="text-sm font-semibold text-surface-100">{m.admin_deps_title()}</h3>
            {#if !loading && warnCount > 0}
                <span
                    class="rounded-full bg-amber-950/60 px-2 py-0.5 text-[11px] font-medium text-amber-300"
                    >{m.admin_deps_warn_count({ count: String(warnCount) })}</span>
            {/if}
        </div>
        <button
            type="button"
            class="btn btn-secondary btn-sm inline-flex items-center gap-1"
            onclick={fetchChecks}
            disabled={loading}>
            <Icon src={ArrowPath} class="h-4 w-4 {loading ? 'animate-spin' : ''}" />
            <span>{m.admin_deps_recheck()}</span>
        </button>
    </div>

    <p class="text-xs text-surface-500">{m.admin_deps_intro()}</p>

    {#if loading && checks.length === 0}
        <div class="flex items-center gap-2 py-6 text-sm text-surface-400">
            <Icon src={ArrowPath} class="h-4 w-4 animate-spin" />
            <span>{m.common_loading()}</span>
        </div>
    {:else if loadError}
        <div class="rounded border border-red-800/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {loadError}
        </div>
    {:else if checks.length === 0}
        <p class="py-4 text-sm text-surface-400">{m.admin_deps_none()}</p>
    {:else}
        <ul class="space-y-1.5">
            {#each sorted as c (c.id)}
                <li class="flex items-start gap-2 text-sm">
                    <span class="mt-1.5">
                        <StatusPip status={c.status === 'pass' ? 'green' : 'amber'} size="sm" />
                    </span>
                    <span class={c.status === 'warn' ? 'text-amber-200' : 'text-surface-200'}>
                        {dependencyCheckText(c)}
                    </span>
                </li>
            {/each}
        </ul>
    {/if}
</section>
