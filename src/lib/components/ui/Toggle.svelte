<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    interface Props {
        checked?: boolean;
        disabled?: boolean;
        size?: 'sm' | 'md' | 'lg';
        label?: string;
        /** id of a visible element naming the switch; preferred over `label` when the name is already on screen */
        labelledby?: string;
        /** id of a visible element describing the switch */
        describedby?: string;
        activeColor?: string;
        inactiveColor?: string;
        children?: import('svelte').Snippet;
        onchange?: (detail: { checked: boolean }) => void;
    }

    let {
        checked = $bindable(false),
        disabled = false,
        size = 'md',
        label = '',
        labelledby,
        describedby,
        activeColor = 'bg-primary-500',
        inactiveColor = 'bg-surface-400',
        children,
        onchange,
    }: Props = $props();

    function toggle() {
        if (disabled) return;
        checked = !checked;
        onchange?.({ checked });
    }

    // Size mappings
    const sizes = {
        sm: {
            track: 'w-10 h-5',
            thumb: 'w-4 h-4',
            translate: 'translate-x-5',
        },
        md: {
            track: 'w-12 h-6',
            thumb: 'w-5 h-5',
            translate: 'translate-x-6',
        },
        lg: {
            track: 'w-14 h-7',
            thumb: 'w-6 h-6',
            translate: 'translate-x-7',
        },
    };

    let config = $derived(sizes[size]);
    let trackColor = $derived(checked ? activeColor : inactiveColor);
</script>

<button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={labelledby ? undefined : label || undefined}
    aria-labelledby={labelledby}
    aria-describedby={describedby}
    {disabled}
    class="toggle-container inline-flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
    onclick={toggle}>
    <div
        class="toggle-track relative inline-flex items-center rounded-full transition-colors duration-200 {config.track} {trackColor}">
        <span
            class="toggle-thumb bg-white rounded-full transition-transform duration-200 {config.thumb} {checked
                ? config.translate
                : 'translate-x-0.5'}"></span>
    </div>

    {#if children}
        <span class="toggle-label text-sm select-none">
            {@render children?.()}
        </span>
    {/if}
</button>

<style>
    .toggle-track {
        box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.1);
    }

    .toggle-thumb {
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
    }
</style>
