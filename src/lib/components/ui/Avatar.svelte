<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { generateAvatarDataUri } from '$lib/utils/avatar-svg';
    import { withAvatarWidth, pickVariant } from '$lib/utils/image-utils';

    import type { ImageDescriptor } from '$lib/schemas/api-image-descriptor.js';

    interface Props {
        image?: ImageDescriptor;
        src?: string;
        alt?: string;
        initials?: string;
        /** Username for deterministic colored SVG avatar fallback */
        username?: string;
        size?: '2xs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';
        background?: string;
        border?: string;
        rounded?: 'full' | 'lg' | 'md';
        badge?: import('svelte').Snippet;
        /** 'eager' for avatars that are on screen the moment they mount (dialog headers). */
        loading?: 'lazy' | 'eager';
    }

    let {
        src = '',
        image,
        alt = 'User avatar',
        initials = '?',
        username,
        size = 'md',
        background = 'bg-surface-500',
        border = '',
        rounded = 'full',
        badge,
        loading = 'lazy',
    }: Props = $props();

    /**
     * The src that failed to load — NOT a boolean. A plain `imageError` flag
     * latched for the lifetime of the component: a user with no avatar yet
     * 404s on mount, and the upload popover's later `blob:` preview was then
     * rendered as the fallback instead of the image they just picked.
     */
    let failedSrc = $state<string | null>(null);
    /** The src that finished loading — until then the fallback shows through, not an empty circle. */
    let loadedSrc = $state<string | null>(null);

    function handleImageError() {
        failedSrc = sizedSrc;
    }

    // Size mappings (consistent with Skeleton)
    const sizeClasses = {
        '2xs': 'w-5 h-5 text-[10px]',
        xs: 'w-8 h-8 text-xs',
        sm: 'w-10 h-10 text-sm',
        md: 'w-12 h-12 text-base',
        lg: 'w-16 h-16 text-lg',
        xl: 'w-20 h-20 text-xl',
    };

    const roundedClasses = {
        full: 'rounded-full',
        lg: 'rounded-lg',
        md: 'rounded-md',
    };

    /**
     * Rendered box in CSS pixels for each preset, mirroring `sizeClasses`.
     * Used to ask the avatar endpoint for an appropriately-sized image — the
     * classes below only SCALE whatever arrives, so without this a 20px avatar
     * still downloaded and decoded the full-size source.
     */
    const sizePx = { '2xs': 20, xs: 32, sm: 40, md: 48, lg: 64, xl: 80 };

    let sizeClass = $derived(sizeClasses[size]);
    let sizedSrc = $derived(
        image
            ? (pickVariant(image, sizePx[size] <= 48 ? 'thumb' : 'card') ?? '')
            : src
              ? withAvatarWidth(src, sizePx[size])
              : src,
    );
    let roundedClass = $derived(roundedClasses[rounded]);
    let showInitials = $derived(!sizedSrc || failedSrc === sizedSrc);

    // Generate deterministic SVG fallback when username is provided
    let fallbackSrc = $derived(username ? generateAvatarDataUri(username) : undefined);
    /** SSR'd images can finish before hydration attaches `onload`. */
    function markIfComplete(node: HTMLImageElement): void {
        if (node.complete && node.naturalWidth > 0) loadedSrc = sizedSrc;
    }
    let placeholderStyle = $derived(
        !showInitials && fallbackSrc && loadedSrc !== sizedSrc
            ? `background-image: url("${fallbackSrc}"); background-size: cover;`
            : undefined,
    );
</script>

<div
    class="avatar relative inline-flex items-center justify-center overflow-hidden {sizeClass} {roundedClass} {border}"
    style={placeholderStyle}
    role="img"
    aria-label={alt}>
    {#if showInitials && fallbackSrc}
        <!-- Deterministic SVG avatar -->
        <img src={fallbackSrc} {alt} class="w-full h-full object-cover" loading="lazy" />
    {:else if showInitials}
        <!-- Plain text initials fallback -->
        <div
            class="initials center w-full h-full {background} text-white font-semibold uppercase select-none">
            {initials}
        </div>
    {:else}
        <!-- Image -->
        <img
            src={sizedSrc}
            {alt}
            class="w-full h-full object-cover"
            onerror={handleImageError}
            onload={() => (loadedSrc = sizedSrc)}
            use:markIfComplete
            {loading} />
    {/if}

    <!-- Optional slot for badges/status indicators -->
    {#if badge}
        <div class="badge-slot absolute bottom-0 right-0">
            {@render badge?.()}
        </div>
    {/if}
</div>

<style>
    .avatar {
        flex-shrink: 0;
    }

    .initials {
        letter-spacing: 0.05em;
    }
</style>
