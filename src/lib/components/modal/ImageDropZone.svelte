<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import DiscogsCredit from '$lib/components/music/DiscogsCredit.svelte';
    import { Icon, Photo, ArrowPath, XMark } from 'svelte-hero-icons';
    import { uploadMediaImage, uploadMediaImageByUrl, deleteMediaImage } from '$lib/api/admin';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        discogsUrl?: string;
        artworkType: 'poster' | 'backdrop' | 'logo' | 'thumb';
        currentUrl?: string;
        mediaId: string;
        onsaved: () => void;
        hasProvider?: boolean;
        onbrowse?: () => void;
        /** True when this image is inherited from a parent (season or series) */
        isInherited?: boolean;
        /** Display name of the parent that owns the image */
        sourceName?: string;
        /** UUID of the parent media item */
        sourceId?: string;
        /** What kind of ancestor the inherited image comes from */
        sourceLevel?: 'season' | 'series' | 'album' | 'artist';
        /** Media type of the current item (e.g. 'episode', 'season') */
        mediaType?: string;
        /** Max upload size in MB (from server config, default 10) */
        maxImageUploadMb?: number;
        /**
         * True when this item has its OWN deletable local artwork row (source
         * 'self'). Only then is there something for "Remove" to delete. When the
         * displayed image is provider-served (TMDB/Jellyfin) with no local
         * override, deleting is a no-op — so we hide Remove rather than show a
         * button that reports false success. Defaults to `true` so callers that
         * can't distinguish local-vs-provider keep the legacy behavior.
         */
        hasLocalArtwork?: boolean;
    }

    let {
        discogsUrl,
        artworkType,
        currentUrl,
        mediaId,
        onsaved,
        hasProvider = false,
        onbrowse,
        isInherited = false,
        sourceName,
        sourceId,
        sourceLevel,
        maxImageUploadMb = 10,
        hasLocalArtwork = true,
    }: Props = $props();

    let saving = $state(false);
    let dragOver = $state(false);
    let urlInput = $state('');
    let showUrlInput = $state(false);
    let fileInput: HTMLInputElement;

    // The catalog endpoint may serve provider-sourced art with no local artwork
    // row; if it 404s (item genuinely has no image) fall back to the placeholder
    // instead of a broken-image icon. Track the URL that failed so the flag
    // resets automatically when `currentUrl` changes (no $effect needed).
    let failedUrl = $state<string | undefined>(undefined);
    let imgFailed = $derived(currentUrl !== undefined && failedUrl === currentUrl);

    // Show the direct upload controls (File / URL / Browse / Remove) when this
    // item is not inheriting a usable image — i.e. it's a non-inherited slot, OR
    // it's flagged inherited but the inherited image failed to load (e.g. an
    // episode whose series has no backdrop, now a real 404 under fallback:'none').
    // In the latter case the "override the parent" framing is wrong — there's
    // nothing to override — so the user needs the normal add-image controls.
    let showUploadControls = $derived(!isInherited || imgFailed);

    let maxFileSizeBytes = $derived(maxImageUploadMb * 1024 * 1024);

    const roleLabel = $derived(
        {
            poster: m.media_p5_poster(),
            backdrop: m.media_p5_backdrop(),
            logo: m.media_p5_logo(),
            thumb: m.media_p5_thumb(),
        }[artworkType],
    );
    const overrideLabel = $derived(m.media_p5_choose_for_title());
    const deleteTooltip = $derived(m.media_p5_inherited_help({ title: sourceName ?? '' }));
    let parentAdminUrl = $derived(
        sourceId ? `/admin/library/media/${sourceId}?tab=images` : undefined,
    );

    function handleKeyDown(e: KeyboardEvent) {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInput.click();
        }
    }

    function handleDragOver(e: DragEvent) {
        e.preventDefault();
        dragOver = true;
    }

    function handleDragLeave() {
        dragOver = false;
    }

    async function handleDrop(e: DragEvent) {
        e.preventDefault();
        dragOver = false;
        const file = e.dataTransfer?.files[0];
        if (file) {
            await uploadFile(file);
        }
    }

    async function handleFileSelect(e: Event) {
        const input = e.target as HTMLInputElement;
        const file = input.files?.[0];
        if (file) {
            await uploadFile(file);
        }
        input.value = '';
    }

    async function uploadFile(file: File) {
        if (file.size > maxFileSizeBytes) {
            toasts.error(m.media_p5_image_too_large({ size: maxImageUploadMb }));
            return;
        }
        saving = true;
        try {
            const { data, error } = await uploadMediaImage(mediaId, artworkType, file);
            if (error || !data) {
                toasts.error(error ?? m.toast_image_upload_failed());
                return;
            }
            toasts.success(m.toast_image_uploaded());
            onsaved();
        } finally {
            saving = false;
        }
    }

    async function handleUrlUpload() {
        if (!urlInput.trim()) return;
        saving = true;
        try {
            const { data, error } = await uploadMediaImageByUrl(
                mediaId,
                artworkType,
                urlInput.trim(),
            );
            if (error || !data) {
                toasts.error(m.toast_image_download_failed());
                return;
            }
            toasts.success(m.toast_image_downloaded());
            urlInput = '';
            showUrlInput = false;
            onsaved();
        } finally {
            saving = false;
        }
    }

    async function handleDelete() {
        saving = true;
        try {
            const { data, error } = await deleteMediaImage(mediaId, artworkType);
            if (error || !data) {
                toasts.error(m.toast_image_remove_failed());
                return;
            }
            if (!data.deleted) {
                // No local artwork row was deleted — either the image is
                // provider-served (nothing local to remove) or a concurrent
                // delete already removed it. Don't claim a removal that didn't
                // happen, but still refresh so the UI reconciles to the item's
                // true current state (provider fallback / empty / parent state)
                // instead of staying frozen on the stale pre-delete view.
                toasts.error(m.toast_image_remove_failed());
                onsaved();
                return;
            }
            toasts.success(m.toast_image_removed());
            onsaved();
        } finally {
            saving = false;
        }
    }
</script>

<div
    class="relative group rounded-lg border-2 border-dashed transition-colors
        {dragOver
        ? 'border-primary-400 bg-primary-900/20'
        : 'border-surface-600/50 hover:border-surface-500/70'}"
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
    ondrop={handleDrop}
    onkeydown={handleKeyDown}
    role="button"
    tabindex="0"
    aria-label={m.media_p5_upload_image({ type: roleLabel })}>
    <!-- Label -->
    <div class="text-xs text-surface-400 font-medium uppercase tracking-wide px-3 pt-2">
        {roleLabel}
    </div>

    {#if currentUrl && !imgFailed}
        <div class="px-3 pt-2">
            <DiscogsCredit sourceUrls={[discogsUrl]} />
        </div>
    {/if}

    <!-- Preview or placeholder -->
    <div class="p-3 flex justify-center items-center min-h-[120px] relative">
        {#if currentUrl && !imgFailed}
            <img
                src={currentUrl}
                alt={artworkType}
                class="max-h-32 rounded object-contain"
                onerror={() => (failedUrl = currentUrl)} />
            {#if isInherited && sourceName}
                <!-- Inherited badge overlay -->
                <div
                    class="absolute inset-x-0 bottom-0 mx-3 mb-0 rounded-b bg-gradient-to-t from-black/80 to-transparent px-2 py-1.5 pointer-events-none"
                    title={deleteTooltip}>
                    <p
                        class="text-[10px] font-semibold uppercase tracking-wide text-yellow-300 leading-tight">
                        {m.media_p5_inherited_from({ title: sourceName })}
                    </p>
                </div>
            {/if}
        {:else}
            <div class="text-surface-600 text-center text-sm">
                <Icon src={Photo} class="w-8 h-8 mx-auto mb-1" />
                {m.media_p5_drop_image()}
            </div>
        {/if}
    </div>

    <!-- Action buttons -->
    <div class="flex gap-1 p-2 border-t border-surface-700/30 flex-wrap">
        {#if !showUploadControls}
            <button
                class="btn variant-ghost-primary text-xs px-2 py-1"
                onclick={() => fileInput.click()}
                disabled={saving}
                title={m.media_p5_choose_for_title()}>
                {overrideLabel}
            </button>
        {:else}
            <button
                class="btn variant-ghost-surface text-xs px-2 py-1"
                onclick={() => fileInput.click()}
                disabled={saving}>
                {m.media_plain_file()}
            </button>
            <button
                class="btn variant-ghost-surface text-xs px-2 py-1"
                onclick={() => (showUrlInput = !showUrlInput)}
                disabled={saving}>
                URL
            </button>
            {#if hasProvider && onbrowse}
                <button
                    class="btn variant-ghost-primary text-xs px-2 py-1"
                    onclick={onbrowse}
                    disabled={saving}>
                    {m.media_p5_browse_images()}
                </button>
            {/if}
            {#if hasLocalArtwork && currentUrl && !imgFailed}
                <button
                    class="ml-auto btn variant-ghost-error text-xs px-2 py-1 text-error-400"
                    onclick={handleDelete}
                    disabled={saving}>
                    <Icon src={XMark} class="w-3 h-3" />
                    {m.media_p5_hide_image()}
                </button>
            {/if}
        {/if}
        {#if !showUploadControls && currentUrl}
            <!-- Disabled delete with link to parent -->
            <span class="ml-auto flex items-center">
                {#if parentAdminUrl}
                    <a
                        href={parentAdminUrl}
                        class="text-xs text-surface-400 hover:text-surface-200 underline"
                        title={deleteTooltip}>
                        {m.media_p5_open_image_owner({ title: sourceName ?? '' })}
                    </a>
                {:else}
                    <span class="text-xs text-surface-500 cursor-not-allowed" title={deleteTooltip}>
                        {m.media_p5_inherited_image()}
                    </span>
                {/if}
            </span>
        {/if}
    </div>

    <!-- URL input (collapsible, only when the direct upload controls are shown) -->
    {#if showUrlInput && showUploadControls}
        <div class="flex gap-2 p-2 border-t border-surface-700/30">
            <input
                bind:value={urlInput}
                placeholder={m.modal_image_url_placeholder()}
                class="flex-1 text-xs bg-surface-800/60 border border-surface-700/50 rounded px-2 py-1 text-surface-100 focus:border-primary-500 focus:outline-none" />
            <button
                class="btn variant-filled-primary text-xs px-2 py-1"
                onclick={handleUrlUpload}
                disabled={saving || !urlInput.trim()}>
                {m.media_p5_use_image()}
            </button>
        </div>
    {/if}

    <!-- Hidden file input -->
    <input
        bind:this={fileInput}
        type="file"
        accept="image/*"
        class="hidden"
        onchange={handleFileSelect} />

    <!-- Loading overlay -->
    {#if saving}
        <div class="absolute inset-0 bg-surface-900/70 flex items-center justify-center rounded-lg">
            <Icon src={ArrowPath} class="w-6 h-6 animate-spin text-surface-300" />
        </div>
    {/if}
</div>
