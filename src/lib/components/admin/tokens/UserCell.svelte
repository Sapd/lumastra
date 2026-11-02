<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { PublicAuthor } from '$lib/schemas/public-author';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        owner?: PublicAuthor | null;
    }

    let { owner }: Props = $props();
</script>

<td class="px-4 py-3">
    {#if owner}
        <span class="text-blue-400">{owner.displayName ?? ''}</span>
    {:else}
        <span class="text-surface-500 italic">{m.route_admin_api_tokens_deleted_user()}</span>
    {/if}
</td>
