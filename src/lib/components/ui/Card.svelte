<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
    Card.svelte - Unified card component for consistent styling

    Variants:
    - default: Solid gray background
    - gradient: Gradient from surface-800 to surface-900 with border
    - glass: Semi-transparent background with border
    - bordered: Solid gray with border

    @example Basic usage
    <Card>Content here</Card>

    @example Gradient with large padding
    <Card variant="gradient" padding="lg">
        <MetricContent />
    </Card>

    @example With header snippet
    <Card variant="bordered">
        {#snippet header()}
            <h3>Title</h3>
        {/snippet}
        Content
    </Card>
-->
<script lang="ts">
    import type { Snippet } from 'svelte';

    type CardVariant = 'default' | 'gradient' | 'glass' | 'bordered';
    type CardPadding = 'none' | 'sm' | 'md' | 'lg';
    type CardRounded = 'md' | 'lg' | 'xl';

    interface Props {
        /** Card style variant */
        variant?: CardVariant;
        /** Padding size */
        padding?: CardPadding;
        /** Border radius size */
        rounded?: CardRounded;
        /** Additional custom classes */
        class?: string;
        /** Header snippet */
        header?: Snippet;
        /** Footer snippet */
        footer?: Snippet;
        /** Main content snippet */
        children?: Snippet;
    }

    let {
        variant = 'default',
        padding = 'md',
        rounded = 'lg',
        class: className = '',
        header,
        footer,
        children,
    }: Props = $props();

    const variantClasses: Record<CardVariant, string> = {
        default: 'bg-surface-800',
        gradient: 'bg-gradient-to-br from-surface-800 to-surface-900 border border-surface-700',
        glass: 'bg-surface-800/50 border border-surface-700',
        bordered: 'bg-surface-800 border border-surface-700',
    };

    const paddingClasses: Record<CardPadding, string> = {
        none: '',
        sm: 'p-3',
        md: 'p-4',
        lg: 'p-5 lg:p-6',
    };

    const roundedClasses: Record<CardRounded, string> = {
        md: 'rounded-md',
        lg: 'rounded-lg',
        xl: 'rounded-xl',
    };

    let classes = $derived(
        [variantClasses[variant], paddingClasses[padding], roundedClasses[rounded], className]
            .filter(Boolean)
            .join(' '),
    );
</script>

<div class={classes}>
    {#if header}
        <div class="mb-3 pb-3 border-b border-surface-700/50">
            {@render header()}
        </div>
    {/if}

    {#if children}
        {@render children()}
    {/if}

    {#if footer}
        <div class="mt-3 pt-3 border-t border-surface-700/50">
            {@render footer()}
        </div>
    {/if}
</div>
