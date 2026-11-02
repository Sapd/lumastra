<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import {
        Icon,
        InformationCircle,
        CheckCircle,
        ExclamationTriangle,
        XCircle,
        XMark,
        type IconSource,
    } from 'svelte-hero-icons';

    // Additional classes
    interface Props {
        // Alert type
        type?: 'info' | 'success' | 'warning' | 'error';
        // Optional title
        title?: string;
        // Dismissible
        dismissible?: boolean;
        // Custom icon (overrides type-based icon)
        icon?: IconSource | null;
        // Compact mode (less padding)
        compact?: boolean;
        class?: string;
        children?: import('svelte').Snippet;
        actions?: import('svelte').Snippet;
        ondismiss?: () => void;
        [key: string]: unknown;
    }

    let {
        type = 'info',
        title = '',
        dismissible = false,

        icon = null,
        compact = false,
        class: className = '',
        children,
        actions,
        ondismiss,
        ...rest
    }: Props = $props();
    // Compute all derived values directly inline to avoid function return type issues

    let resolvedIcon: IconSource = $derived(
        icon ??
            (type === 'info'
                ? InformationCircle
                : type === 'success'
                  ? CheckCircle
                  : type === 'warning'
                    ? ExclamationTriangle
                    : XCircle),
    );
    let typeClass = $derived(
        type === 'info'
            ? 'bg-blue-900/30 border-blue-600/50 text-blue-200'
            : type === 'success'
              ? 'bg-green-900/30 border-green-600/50 text-green-200'
              : type === 'warning'
                ? 'bg-yellow-900/30 border-yellow-600/50 text-yellow-200'
                : 'bg-red-900/30 border-red-600/50 text-red-200',
    );

    let iconColor = $derived(
        type === 'info'
            ? 'text-blue-400'
            : type === 'success'
              ? 'text-green-400'
              : type === 'warning'
                ? 'text-yellow-400'
                : 'text-red-400',
    );

    let paddingClass = $derived(compact ? 'p-3' : 'p-4');

    function handleDismiss(): void {
        ondismiss?.();
    }
</script>

<div class="alert rounded-lg border {typeClass} {paddingClass} {className}" role="alert" {...rest}>
    <div class="flex gap-3">
        <!-- Icon -->
        <div class="shrink-0 {iconColor}">
            <Icon src={resolvedIcon} class="w-5 h-5" />
        </div>

        <!-- Content -->
        <div class="flex-1 min-w-0">
            {#if title}
                <h4 class="font-medium mb-1">{title}</h4>
            {/if}
            <div class="text-sm opacity-90">
                {@render children?.()}
            </div>

            {#if actions}
                <div class="mt-3">
                    {@render actions?.()}
                </div>
            {/if}
        </div>

        <!-- Dismiss button -->
        {#if dismissible}
            <button
                type="button"
                onclick={handleDismiss}
                class="shrink-0 p-1 rounded hover:bg-white/10 transition-colors opacity-70 hover:opacity-100"
                aria-label={m.ui_dismiss_aria()}>
                <Icon src={XMark} class="w-4 h-4" />
            </button>
        {/if}
    </div>
</div>
