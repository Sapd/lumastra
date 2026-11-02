<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { PublicAuthor } from '$lib/schemas/public-author';
    import { Icon, Trash } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        tokenId: number;
        tokenName: string;
        owner?: PublicAuthor | null;
        onRevoke: (id: number, name: string, username?: string) => void;
    }

    let { tokenId, tokenName, owner, onRevoke }: Props = $props();
</script>

<td class="px-4 py-3 text-right">
    <button
        class="text-red-400 hover:text-red-300 p-1"
        onclick={() => onRevoke(tokenId, tokenName, owner?.displayName ?? undefined)}
        title={m.route_admin_api_tokens_revoke_title()}
        aria-label={m.route_admin_api_tokens_revoke_title()}>
        <Icon src={Trash} class="w-5 h-5" />
    </button>
</td>
