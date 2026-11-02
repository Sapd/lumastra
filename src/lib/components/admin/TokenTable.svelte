<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, Key, ArrowPath } from 'svelte-hero-icons';
    import { getColumns, getEmptyState } from './tokens/column-registry';
    import * as m from '$lib/paraglide/messages.js';

    import type { PublicAuthor } from '$lib/schemas/public-author';

    type Token = {
        id: number;
        name: string;
        tokenPrefix: string;
        description?: string | null;
        scopes?: string[];
        owner?: PublicAuthor | null;
        allowedIps?: string[] | null;
        allowedPathPrefixes?: string[] | null;
        allowedMethods?: string[] | null;
        forceNonAdmin?: boolean;
        actAs?: PublicAuthor | null;
        createdVia?: { tokenId: number; tokenName: string } | null;
        lastUsedAt?: string | null;
        usageCount?: number;
        expiresAt?: string | null;
        isExpired?: boolean;
    };

    interface Props {
        tokens: Token[];
        type: 'pat' | 'service';
        loading: boolean;
        onRevoke: (id: number, name: string, username?: string) => void;
        formatRelativeDate: (dateStr: string | null) => string;
    }

    let { tokens, type, loading, onRevoke, formatRelativeDate }: Props = $props();

    // Column Registry Pattern - eliminates type-based branching
    let columns = $derived(getColumns(type));
    let emptyState = $derived(getEmptyState(type));
    let emptyIcon = $derived(type === 'pat' ? Key : Icon);
</script>

<div class="bg-surface-800 rounded-lg overflow-hidden">
    {#if loading}
        <div class="p-8 text-center text-surface-400">
            <Icon src={ArrowPath} class="w-8 h-8 mx-auto animate-spin mb-2" />
            {m.loading()}
        </div>
    {:else if tokens.length === 0}
        <div class="p-8 text-center text-surface-400">
            <Icon src={emptyIcon} class="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p>{emptyState.message()}</p>
        </div>
    {:else}
        <table class="w-full">
            <!-- Column Registry Pattern - eliminates type-based branching -->
            <thead class="bg-surface-700">
                <tr>
                    {#each columns as column (column.id)}
                        <th class="px-4 py-3 text-sm text-{column.align ?? 'left'}">
                            {column.header()}
                        </th>
                    {/each}
                </tr>
            </thead>
            <tbody class="divide-y divide-surface-700">
                {#each tokens as token (token.id)}
                    <tr class:opacity-50={token.isExpired}>
                        {#each columns as column (column.id)}
                            {@const CellComponent = column.cell}
                            <CellComponent
                                {...token}
                                {type}
                                {formatRelativeDate}
                                {onRevoke}
                                tokenId={token.id}
                                tokenName={token.name} />
                        {/each}
                    </tr>
                {/each}
            </tbody>
        </table>
    {/if}
</div>
