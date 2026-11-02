<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        name: string;
        description?: string | null;
        allowedIps?: string[] | null;
        allowedPathPrefixes?: string[] | null;
        allowedMethods?: string[] | null;
        forceNonAdmin?: boolean;
        type: 'pat' | 'service';
    }

    let {
        name,
        description,
        allowedIps,
        allowedPathPrefixes,
        allowedMethods,
        forceNonAdmin,
        type,
    }: Props = $props();

    // Truncated path-prefix preview: show up to 2, then "+N" badge.
    let visiblePathPrefixes = $derived((allowedPathPrefixes ?? []).slice(0, 2));
    let hiddenPathPrefixCount = $derived(Math.max(0, (allowedPathPrefixes ?? []).length - 2));
</script>

<td class="px-4 py-3">
    <div class="font-medium flex items-center gap-1.5 flex-wrap">
        <span>{name}</span>
        {#if type === 'service' && forceNonAdmin}
            <span
                class="text-[10px] px-1.5 py-0.5 rounded bg-yellow-900/50 border border-yellow-700/50 text-yellow-200 font-normal uppercase tracking-wide"
                title={m.route_admin_api_tokens_force_non_admin_badge_title()}
                >{m.route_admin_api_tokens_force_non_admin_badge()}</span>
        {/if}
    </div>
    {#if description}
        <div class="text-muted">
            {description}
        </div>
    {/if}
    {#if type === 'service' && allowedPathPrefixes && allowedPathPrefixes.length > 0}
        <div class="text-caption mt-1 flex flex-wrap items-center gap-1">
            <span class="text-surface-500">Paths:</span>
            {#each visiblePathPrefixes as prefix (prefix)}
                <code
                    class="text-[11px] px-1.5 py-0.5 rounded bg-surface-700/60 text-surface-300 font-mono"
                    >{prefix}</code>
            {/each}
            {#if hiddenPathPrefixCount > 0}
                <span
                    class="text-[11px] text-surface-400"
                    title={(allowedPathPrefixes ?? []).slice(2).join(', ')}
                    >+{hiddenPathPrefixCount}</span>
            {/if}
        </div>
    {/if}
    {#if type === 'service' && allowedMethods && allowedMethods.length > 0}
        <div class="text-caption mt-1 flex flex-wrap items-center gap-1">
            <span class="text-surface-500">Methods:</span>
            <code
                class="text-[11px] px-1.5 py-0.5 rounded bg-surface-700/60 text-surface-300 font-mono"
                >{allowedMethods.join(', ')}</code>
        </div>
    {/if}
    {#if type === 'service' && allowedIps && allowedIps.length > 0}
        <div class="text-caption mt-1">
            {m.route_admin_api_tokens_ips({ ips: allowedIps.join(', ') })}
        </div>
    {/if}
</td>
