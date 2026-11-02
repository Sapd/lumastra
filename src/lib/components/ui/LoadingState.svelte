<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	Generic Loading State Component
	Handles loading, error, and empty states with customizable snippets

	Usage: Pass loading, error, isEmpty, and emptyMessage props
	Use children snippet for content, or override loading/error/empty snippets
-->
<script lang="ts">
    import type { Snippet } from 'svelte';
    import ProgressRadial from './ProgressRadial.svelte';
    import ErrorMessage from './ErrorMessage.svelte';
    import EmptyState from './EmptyState.svelte';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        loading?: boolean;
        error?: string | null;
        isEmpty?: boolean;
        emptyMessage?: string | null;
        loadingMessage?: string;
        showSpinner?: boolean;
        minHeight?: string;
        loadingSnippet?: Snippet;
        errorSnippet?: Snippet<[string]>;
        empty?: Snippet;
        children?: Snippet;
    }

    let {
        loading = false,
        error = null,
        isEmpty = false,
        emptyMessage = null,
        loadingMessage = m.loading_default(),
        showSpinner = true,
        minHeight = 'auto',
        loadingSnippet,
        errorSnippet,
        empty,
        children,
    }: Props = $props();
</script>

{#if loading}
    {#if loadingSnippet}
        {@render loadingSnippet()}
    {:else}
        <div class="center-col p-8" style="min-height: {minHeight}">
            {#if showSpinner}
                <ProgressRadial width="w-8" />
            {/if}
            <p class="text-sm text-surface-600 dark:text-surface-300 mt-4">
                {loadingMessage}
            </p>
        </div>
    {/if}
{:else if error}
    {#if errorSnippet}
        {@render errorSnippet(error)}
    {:else}
        <ErrorMessage message={error} />
    {/if}
{:else if isEmpty && emptyMessage}
    {#if empty}
        {@render empty()}
    {:else}
        <EmptyState title={emptyMessage} />
    {/if}
{:else if children}
    {@render children()}
{/if}
