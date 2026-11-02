<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    interface Props {
        /**
         * @deprecated Use LoadingState.svelte instead for consistent loading/error/empty states
         *
         * Reusable loading spinner component
         * Consistent loading states across the application
         */
        message?: string;
        color?: string;
        size?: 'sm' | 'md' | 'lg';
        showMessage?: boolean;
    }

    let {
        message = 'Loading...',
        color = 'primary-500',
        size = 'md',
        showMessage = true,
    }: Props = $props();

    const sizeClasses = {
        sm: 'h-5 w-5',
        md: 'h-8 w-8',
        lg: 'h-12 w-12',
    };
</script>

<div class="center py-8">
    <div class={`animate-spin rounded-full ${sizeClasses[size]} border-b-2 border-${color}`}></div>
    {#if showMessage}
        <span class="ml-3 text-surface-400">{message}</span>
    {/if}
</div>
