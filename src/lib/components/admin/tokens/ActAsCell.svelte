<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { PublicAuthor } from '$lib/schemas/public-author';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        actAs?: PublicAuthor | null;
    }

    let { actAs }: Props = $props();
</script>

<td class="px-4 py-3 text-sm">
    {#if actAs}
        <span class="text-purple-400">{actAs.displayName ?? ''}</span>
    {:else}
        <!-- A non-impersonating token acts as its creator with the token's own
             scope (see the Scopes column) — it is not "Admin" by itself. -->
        <span class="text-surface-500">{m.route_admin_api_tokens_act_as_creator()}</span>
    {/if}
</td>
