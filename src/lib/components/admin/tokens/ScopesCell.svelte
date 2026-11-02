<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        scopes?: string[];
    }

    let { scopes = [] }: Props = $props();

    function scopeLabel(scope: string): string {
        return scope === 'integrations:read'
            ? m.route_admin_api_tokens_scope_integrations()
            : scope;
    }
</script>

<td class="px-4 py-3">
    <div class="flex gap-1 flex-wrap">
        {#each scopes as scope (scope)}
            <span class="text-xs px-2 py-0.5 rounded bg-surface-700 text-surface-300" title={scope}>
                {scopeLabel(scope)}
            </span>
        {/each}
    </div>
</td>
