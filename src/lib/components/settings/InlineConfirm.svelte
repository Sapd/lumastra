<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { Icon, Trash } from 'svelte-hero-icons';
    import type { IconSource } from 'svelte-hero-icons';
    import { tick } from 'svelte';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        triggerLabel: string;
        /**
         * Accessible name for the trigger when the visible label is short
         * ("Log out") and eight identical buttons need telling apart
         * ("Log out Apple TV").
         */
        ariaLabel?: string;
        confirmLabel: string;
        /** Optional icon-only trigger: when true, triggerLabel is the aria-label. */
        iconOnly?: boolean;
        icon?: IconSource;
        busy?: boolean;
        disabled?: boolean;
        /** Variant of the confirm action — destructive defaults to error. */
        variant?: 'error' | 'primary';
        onConfirm: () => void | Promise<void>;
    }
    let {
        triggerLabel,
        ariaLabel = undefined,
        confirmLabel,
        iconOnly = false,
        icon = Trash,
        busy = false,
        disabled = false,
        variant = 'error',
        onConfirm,
    }: Props = $props();

    let armed = $state(false);
    let pending = $state(false);
    let container: HTMLDivElement | null | undefined;

    async function setArmed(value: boolean): Promise<void> {
        armed = value;
        await tick();
        // Successful revoke/delete can remove this entire row before tick resolves.
        container?.querySelector<HTMLButtonElement>(value ? '[data-cancel]' : 'button')?.focus();
    }

    function onKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape' && armed) {
            event.preventDefault();
            event.stopPropagation();
            void setArmed(false);
        }
    }

    async function confirm(): Promise<void> {
        if (busy || disabled || pending) return;
        pending = true;
        try {
            await onConfirm();
        } finally {
            pending = false;
            await setArmed(false);
        }
    }
</script>

<div bind:this={container} class="max-w-full">
    {#if armed}
        <div class="flex flex-wrap items-center gap-2">
            <span class="text-xs text-surface-400">{confirmLabel}?</span>
            <button
                class="btn btn-sm {variant === 'error'
                    ? 'variant-filled-error'
                    : 'variant-filled-primary'}"
                onclick={confirm}
                onkeydown={onKeydown}
                disabled={busy || disabled || pending}>
                {busy || pending ? m.settings_data_busy() : confirmLabel}
            </button>
            <button
                data-cancel
                class="btn btn-sm variant-ghost-surface"
                disabled={busy || pending}
                onkeydown={onKeydown}
                onclick={() => setArmed(false)}>
                {m.common_cancel()}
            </button>
        </div>
    {:else if iconOnly}
        <button
            class="btn-icon w-9 h-9 variant-ghost-error"
            aria-label={ariaLabel ?? triggerLabel}
            title={ariaLabel ?? triggerLabel}
            disabled={disabled || busy || pending}
            onclick={() => setArmed(true)}>
            <Icon src={icon} class="w-4 h-4" />
        </button>
    {:else}
        <button
            class="btn btn-sm variant-ghost-{variant === 'error' ? 'error' : 'surface'}"
            aria-label={ariaLabel}
            disabled={disabled || busy || pending}
            onclick={() => setArmed(true)}>
            {triggerLabel}
        </button>
    {/if}
</div>
