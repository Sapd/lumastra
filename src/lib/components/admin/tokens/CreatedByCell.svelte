<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { PublicAuthor } from '$lib/schemas/public-author';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        owner?: PublicAuthor | null;
        createdVia?: { tokenId: number; tokenName: string } | null;
    }
    let { owner, createdVia }: Props = $props();
</script>

<td class="px-4 py-3 text-muted">
    {owner?.displayName ?? ''}
    {#if createdVia != null}
        <span class="block text-xs"
            >{m.route_admin_api_tokens_via_token({
                name: createdVia.tokenName,
            })}</span>
    {/if}
</td>
