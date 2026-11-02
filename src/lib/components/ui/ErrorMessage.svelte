<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { Icon, XMark, ExclamationTriangle, InformationCircle } from 'svelte-hero-icons';

    interface Props {
        /**
         * Reusable error/warning/info message component
         */
        message?: string;
        variant?: 'error' | 'warning' | 'info';
        dismissible?: boolean;
        onDismiss?: (() => void) | undefined;
        children?: import('svelte').Snippet;
    }

    let {
        message = '',
        variant = 'error',
        dismissible = false,
        onDismiss = undefined,
        children,
    }: Props = $props();

    const variantConfig = {
        error: {
            bg: 'bg-red-900/20',
            border: 'border-red-600',
            text: 'text-red-300',
            icon: XMark,
            iconColor: 'text-red-400',
        },
        warning: {
            bg: 'bg-yellow-900/20',
            border: 'border-yellow-600',
            text: 'text-yellow-300',
            icon: ExclamationTriangle,
            iconColor: 'text-yellow-400',
        },
        info: {
            bg: 'bg-blue-900/20',
            border: 'border-blue-600',
            text: 'text-blue-300',
            icon: InformationCircle,
            iconColor: 'text-blue-400',
        },
    };

    let config = $derived(variantConfig[variant]);

    function handleDismiss() {
        if (onDismiss) {
            onDismiss();
        }
    }
</script>

<div class={`${config.bg} border ${config.border} rounded-lg p-4`}>
    <div class="flex items-center gap-2">
        <Icon src={config.icon} class={`w-5 h-5 ${config.iconColor} shrink-0`} />
        <span class={`${config.text} flex-1`}>{message}</span>
        {#if dismissible}
            <button
                onclick={handleDismiss}
                class="p-1 hover:bg-gray-700 rounded-full transition-colors"
                aria-label={m.ui_dismiss_aria()}>
                <Icon src={XMark} class="w-4 h-4" />
            </button>
        {/if}
    </div>
    {#if children}
        <div class="mt-2 ml-7">
            {@render children?.()}
        </div>
    {/if}
</div>
