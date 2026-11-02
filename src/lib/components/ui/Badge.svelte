<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, type IconSource } from 'svelte-hero-icons';

    // Additional classes
    interface Props {
        // Badge variants
        variant?:
            | 'primary'
            | 'success'
            | 'warning'
            | 'error'
            | 'info'
            | 'purple'
            | 'cyan'
            | 'orange'
            | 'gray'
            | 'surface';
        // Badge styles
        style?: 'solid' | 'soft' | 'outline';
        // Badge sizes
        size?: 'xs' | 'sm' | 'md';
        // Pill shape (rounded-full vs rounded)
        pill?: boolean;
        // Icon support
        icon?: IconSource | null;
        class?: string;
        children?: import('svelte').Snippet;
        [key: string]: unknown;
    }

    let {
        variant = 'primary',
        style = 'soft',
        size = 'sm',
        pill = true,

        icon = null,
        class: className = '',
        children,
        ...rest
    }: Props = $props();

    // Base classes for badge from app.css
    const baseClass = 'badge';

    type BadgeVariant = typeof variant;
    type BadgeStyle = typeof style;

    // Icon sizes
    const iconSizes: Record<typeof size, string> = {
        xs: 'w-2.5 h-2.5',
        sm: 'w-3 h-3',
        md: 'w-4 h-4',
    };

    function getVariantClass(s: BadgeStyle, v: BadgeVariant): string {
        if (s === 'solid') {
            switch (v) {
                case 'primary':
                    return 'bg-primary-600 text-white';
                case 'success':
                    return 'bg-green-600 text-white';
                case 'warning':
                    return 'bg-yellow-500 text-gray-900';
                case 'error':
                    return 'bg-red-600 text-white';
                case 'info':
                    return 'bg-blue-600 text-white';
                case 'purple':
                    return 'bg-purple-600 text-white';
                case 'cyan':
                    return 'bg-cyan-600 text-white';
                case 'orange':
                    return 'bg-orange-600 text-white';
                case 'gray':
                    return 'bg-gray-600 text-white';
                case 'surface':
                    return 'bg-surface-600 text-white';
            }
        } else if (s === 'soft') {
            switch (v) {
                case 'primary':
                    return 'bg-primary-500/20 text-primary-400';
                case 'success':
                    return 'badge-success';
                case 'warning':
                    return 'badge-warning';
                case 'error':
                    return 'badge-error';
                case 'info':
                    return 'badge-info';
                case 'purple':
                    return 'badge-purple';
                case 'cyan':
                    return 'badge-cyan';
                case 'orange':
                    return 'badge-orange';
                case 'gray':
                    return 'bg-gray-500/20 text-gray-400';
                case 'surface':
                    return 'bg-surface-500/20 text-surface-300';
            }
        } else {
            // outline
            switch (v) {
                case 'primary':
                    return 'bg-primary-500/20 text-primary-400 border border-primary-500/30';
                case 'success':
                    return 'badge-outline-success';
                case 'warning':
                    return 'badge-outline-warning';
                case 'error':
                    return 'badge-outline-error';
                case 'info':
                    return 'badge-outline-info';
                case 'purple':
                    return 'bg-purple-500/20 text-purple-400 border border-purple-500/30';
                case 'cyan':
                    return 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30';
                case 'orange':
                    return 'bg-orange-500/20 text-orange-400 border border-orange-500/30';
                case 'gray':
                    return 'bg-gray-500/20 text-gray-400 border border-gray-500/30';
                case 'surface':
                    return 'bg-surface-500/20 text-surface-300 border border-surface-500/30';
            }
        }
    }

    function getSizeClass(s: typeof size): string {
        switch (s) {
            case 'xs':
                return 'px-1.5 py-0.5 text-[10px]';
            case 'sm':
                return '';
            case 'md':
                return 'px-3 py-1 text-sm';
        }
    }

    let shapeClass = $derived(pill ? 'rounded-full' : 'rounded');
    let variantClass = $derived(getVariantClass(style, variant));
    let computedSizeClass = $derived(getSizeClass(size));

    let badgeClasses = $derived(
        [baseClass, variantClass, computedSizeClass, shapeClass, icon ? 'gap-1' : '', className]
            .filter(Boolean)
            .join(' '),
    );
</script>

<span class={badgeClasses} {...rest}>
    {#if icon}
        <Icon src={icon} class={iconSizes[size]} />
    {/if}
    {@render children?.()}
</span>
