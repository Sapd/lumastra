<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { Icon, ArrowPath, XMark, Check } from 'svelte-hero-icons';
    import { browseMediaImages, uploadMediaImageByUrl } from '$lib/api/admin';
    import { toasts } from '$lib/stores/toast.store';
    import type { BrowseImage } from '$lib/schemas/media-image-upload';

    interface Props {
        mediaId: string;
        artworkType: 'poster' | 'backdrop' | 'logo';
        onselected: () => void;
        onclose: () => void;
    }

    let { mediaId, artworkType, onselected, onclose }: Props = $props();

    let images = $state<BrowseImage[]>([]);
    let loading = $state(true);
    let saving = $state(false);
    let selectedPath = $state<string | null>(null);

    $effect(() => {
        loadImages();
    });

    async function loadImages() {
        loading = true;
        const { data, error } = await browseMediaImages(mediaId);
        if (error || !data) {
            toasts.error(m.toast_failed_load_images());
            loading = false;
            return;
        }
        if (artworkType === 'poster') images = data.posters;
        else if (artworkType === 'backdrop') images = data.backdrops;
        else if (artworkType === 'logo') images = data.logos;
        loading = false;
    }

    async function selectImage(image: BrowseImage) {
        saving = true;
        selectedPath = image.filePath;
        const { data, error } = await uploadMediaImageByUrl(mediaId, artworkType, image.fullUrl);
        if (error || !data) {
            toasts.error(m.toast_failed_save_image());
            selectedPath = null;
            saving = false;
            return;
        }
        toasts.success(m.toast_artwork_updated({ type: artworkType }));
        onselected();
    }
</script>

<div class="space-y-3">
    <div class="flex items-center justify-between">
        <h4 class="text-sm font-medium text-surface-200 capitalize">
            {m.provider_image_picker_title({ type: artworkType })}
        </h4>
        <button
            class="p-1 rounded hover:bg-surface-600/60 text-surface-400 hover:text-surface-100 transition-colors"
            onclick={onclose}
            aria-label={m.provider_image_picker_close_aria()}>
            <Icon src={XMark} class="w-4 h-4" />
        </button>
    </div>

    {#if loading}
        <div class="flex justify-center py-8">
            <Icon src={ArrowPath} class="w-5 h-5 animate-spin text-surface-400" />
        </div>
    {:else if images.length === 0}
        <p class="text-sm text-surface-500 text-center py-4">
            {m.provider_image_picker_no_images({ type: artworkType })}
        </p>
    {:else}
        <div
            class="grid gap-2 max-h-80 overflow-y-auto pr-1
                {artworkType === 'backdrop' ? 'grid-cols-2' : 'grid-cols-3'}">
            {#each images as image (image.filePath)}
                <button
                    class="relative group rounded-lg overflow-hidden border-2 transition-all
                        {selectedPath === image.filePath
                        ? 'border-primary-400 ring-2 ring-primary-400/30'
                        : 'border-transparent hover:border-surface-500/50'}"
                    onclick={() => selectImage(image)}
                    disabled={saving}>
                    <img
                        src={image.thumbUrl}
                        alt={m.provider_image_picker_image_alt({
                            type: artworkType,
                        })}
                        class="w-full object-cover
                            {artworkType === 'backdrop' ? 'aspect-video' : ''}
                            {artworkType === 'poster' ? 'aspect-[2/3]' : ''}
                            {artworkType === 'logo'
                            ? 'aspect-video bg-surface-900 object-contain p-2'
                            : ''}"
                        loading="lazy" />

                    <!-- Hover overlay -->
                    <div
                        class="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                        {#if selectedPath === image.filePath && saving}
                            <Icon src={ArrowPath} class="w-6 h-6 text-white animate-spin" />
                        {/if}
                    </div>

                    <!-- Size badge -->
                    <span
                        class="absolute bottom-1 right-1 text-[10px] px-1 py-0.5 rounded bg-black/60 text-surface-300">
                        {image.width}x{image.height}
                    </span>

                    <!-- Language badge -->
                    {#if image.language}
                        <span
                            class="absolute top-1 left-1 text-[10px] px-1 py-0.5 rounded bg-black/60 text-surface-300 uppercase">
                            {image.language}
                        </span>
                    {/if}
                </button>
            {/each}
        </div>
        <p class="text-xs text-surface-500">
            {images.length === 1
                ? m.provider_image_picker_image_one({ count: images.length })
                : m.provider_image_picker_image_many({ count: images.length })}
        </p>
    {/if}
</div>
