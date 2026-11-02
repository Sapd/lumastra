<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Renders an external plugin's DECLARED capabilities (cooperative metadata, NOT a
  sandbox). Well-known keys (allowedDomains, database) get first-class rendering;
  any other key renders as a generic `key: value` chip. Pure-presentational — no
  client calls, no trusted-key material.
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import type { ExternalPluginCapabilities } from '$lib/schemas/api-external-plugins.js';

    let { capabilities }: { capabilities?: ExternalPluginCapabilities } = $props();

    const KNOWN = new Set(['allowedDomains', 'database']);

    let domains = $derived(
        Array.isArray(capabilities?.allowedDomains) ? capabilities.allowedDomains : [],
    );
    let hasDatabase = $derived(capabilities?.database === true);
    let otherEntries = $derived(
        capabilities ? Object.entries(capabilities).filter(([k]) => !KNOWN.has(k)) : [],
    );
    let hasAny = $derived(domains.length > 0 || hasDatabase || otherEntries.length > 0);
</script>

{#if hasAny}
    <div class="flex flex-col gap-1.5">
        <div class="flex flex-wrap items-center gap-1.5">
            {#if hasDatabase}
                <span class="badge preset-tonal-warning text-xs">
                    {m.plugins_external_capability_database()}
                </span>
            {/if}
            {#each domains as domain (domain)}
                <span class="badge preset-tonal-surface text-xs font-mono">
                    {m.plugins_external_capability_domains()}: {domain}
                </span>
            {/each}
            {#each otherEntries as [key, value] (key)}
                <span class="badge preset-tonal-surface text-xs font-mono">
                    {key}: {JSON.stringify(value)}
                </span>
            {/each}
        </div>
        <p class="text-caption">{m.plugins_external_capabilities_caption()}</p>
    </div>
{/if}
