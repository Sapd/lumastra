<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  ContentEditDrawer — full-edit side drawer for a single non-entertainment media item.
  Renders core fields (title, overview) + all template metadata fields + poster upload.
  Saves via PATCH /api/media/{id}/metadata which locks the item.
-->

<script lang="ts">
    import { getCatalogPosterUrl } from '$lib/utils/image-utils';
    import { getLibraryTypeTemplate } from '$lib/shared/library-type-templates';
    import {
        updateMediaMetadata,
        uploadMediaImage,
        getLibraryMetadataValues,
    } from '$lib/api/admin';
    import { toasts } from '$lib/stores/toast.store';
    import MetadataFieldRenderer from './MetadataFieldRenderer.svelte';
    import { Z } from '$lib/utils/z-index';
    import { resolve } from '$lib/paths';

    interface BrowseItem {
        id: string;
        title: string;
        media_type: string;
        custom_metadata: Record<string, unknown>;
        custom_poster_url: string | null;
    }

    interface Props {
        item: BrowseItem;
        libraryType: string;
        onsaved: () => void;
        onclose: () => void;
    }

    let { item, libraryType, onsaved, onclose }: Props = $props();

    const inputClass =
        'w-full bg-surface-800/60 border border-surface-700/50 rounded-lg px-3 py-2 text-surface-100 text-sm focus:border-primary-500 focus:outline-none';

    let template = $derived(getLibraryTypeTemplate(libraryType));

    // -------------------------------------------------------------------------
    // Local edit state — initialised from item, reset on item change
    // -------------------------------------------------------------------------

    function initialEditTitle(): string {
        return item.title;
    }

    function initialEditMetadata(): Record<string, unknown> {
        return { ...item.custom_metadata };
    }

    let editTitle = $state(initialEditTitle());
    let editOverview = $state('');
    let editMetadata = $state<Record<string, unknown>>(initialEditMetadata());

    // Autocomplete options per field key
    let autocompleteOptions = $state<Record<string, string[]>>({});

    // Poster upload state
    let posterError = $state(false);
    let uploadingPoster = $state(false);
    let posterKey = $state(0); // bump to re-render the img after upload

    // -------------------------------------------------------------------------
    // Fetch autocomplete options for all autocompleteFrom fields on open
    // -------------------------------------------------------------------------

    $effect(() => {
        // Re-run if libraryType or item.id changes
        void item.id;
        void libraryType;

        editTitle = item.title;
        editOverview = '';
        editMetadata = { ...item.custom_metadata };
        posterError = false;
        autocompleteOptions = {};

        const fields = template?.metadataFields ?? [];
        const autoFields = fields.filter((f) => f.autocompleteFrom);
        if (autoFields.length === 0) return;

        void Promise.all(
            autoFields.map(async (f) => {
                if (!f.autocompleteFrom) return;
                const { data } = await getLibraryMetadataValues(
                    item.media_type,
                    f.autocompleteFrom,
                );
                if (data?.values) {
                    autocompleteOptions = { ...autocompleteOptions, [f.key]: data.values };
                }
            }),
        );
    });

    // -------------------------------------------------------------------------
    // Save
    // -------------------------------------------------------------------------

    let saving = $state(false);

    async function handleSave(): Promise<void> {
        saving = true;
        try {
            const { error } = await updateMediaMetadata(item.id, {
                title: editTitle,
                overview: editOverview || undefined,
                customMetadata: editMetadata,
            });
            if (error) {
                toasts.error('Failed to save: ' + error);
                return;
            }
            toasts.success('Saved');
            onsaved();
            onclose();
        } finally {
            saving = false;
        }
    }

    // -------------------------------------------------------------------------
    // Poster upload
    // -------------------------------------------------------------------------

    async function handlePosterUpload(file: File): Promise<void> {
        uploadingPoster = true;
        try {
            const { error } = await uploadMediaImage(item.id, 'poster', file);
            if (error) {
                toasts.error('Poster upload failed: ' + error);
                return;
            }
            posterError = false;
            posterKey += 1;
            toasts.success('Poster uploaded');
        } finally {
            uploadingPoster = false;
        }
    }

    function handlePosterDrop(e: DragEvent): void {
        e.preventDefault();
        const file = e.dataTransfer?.files?.[0];
        if (file && file.type.startsWith('image/')) {
            void handlePosterUpload(file);
        }
    }

    function handlePosterFileInput(e: Event): void {
        const file = (e.currentTarget as HTMLInputElement).files?.[0];
        if (file) void handlePosterUpload(file);
    }

    // -------------------------------------------------------------------------
    // Backdrop click to close (outside the panel)
    // -------------------------------------------------------------------------

    function handleBackdropClick(e: MouseEvent): void {
        if (e.target === e.currentTarget) onclose();
    }

    function handleBackdropKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape') onclose();
    }
</script>

<!-- Backdrop -->
<div
    class="fixed inset-0 bg-black/60"
    style="z-index: {Z.MODAL}"
    onclick={handleBackdropClick}
    onkeydown={handleBackdropKeydown}
    role="presentation">
    <!-- Drawer panel -->
    <div
        class="absolute right-0 top-0 h-full w-full max-w-lg bg-surface-900 border-l border-surface-700 flex flex-col shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Edit {item.title}">
        <!-- Header -->
        <div
            class="flex items-center justify-between px-6 py-4 border-b border-surface-700 shrink-0">
            <h2 class="text-lg font-semibold text-white truncate">Edit: {item.title}</h2>
            <button
                class="text-surface-400 hover:text-white transition-colors"
                onclick={onclose}
                aria-label="Close">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M6 18L18 6M6 6l12 12" />
                </svg>
            </button>
        </div>

        <!-- Scrollable content -->
        <div class="flex-1 overflow-y-auto px-6 py-5 space-y-5">
            <!-- Poster section -->
            <div class="space-y-2">
                <span class="text-xs text-surface-400 font-medium uppercase tracking-wide"
                    >Poster</span>
                <div class="flex items-start gap-4">
                    <!-- Thumbnail -->
                    <div
                        class="w-24 aspect-video rounded-lg overflow-hidden bg-surface-800 shrink-0 relative"
                        ondragover={(e) => e.preventDefault()}
                        ondrop={handlePosterDrop}
                        role="presentation">
                        {#key posterKey}
                            {#if !posterError}
                                <!-- fallback:'none' → a poster-less item 404s and
                                     trips onerror → the neutral "no poster" icon
                                     below, instead of the endpoint's popcorn
                                     placeholder masquerading as a real poster in
                                     this edit context. Real/provider posters 200. -->
                                <img
                                    src={getCatalogPosterUrl(item.id, {
                                        size: 'thumb',
                                        fallback: 'none',
                                    })}
                                    alt={item.title}
                                    class="w-full h-full object-cover"
                                    onerror={() => {
                                        posterError = true;
                                    }} />
                            {:else}
                                <div
                                    class="w-full h-full flex items-center justify-center text-surface-500">
                                    <svg
                                        class="w-6 h-6"
                                        fill="none"
                                        stroke="currentColor"
                                        viewBox="0 0 24 24">
                                        <path
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            stroke-width="2"
                                            d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                    </svg>
                                </div>
                            {/if}
                        {/key}
                        {#if uploadingPoster}
                            <div
                                class="absolute inset-0 bg-black/60 flex items-center justify-center">
                                <span class="text-xs text-white">Uploading…</span>
                            </div>
                        {/if}
                    </div>
                    <!-- Upload controls -->
                    <div class="flex flex-col gap-2">
                        <label
                            class="cursor-pointer px-3 py-1.5 text-xs bg-surface-700 hover:bg-surface-600 text-white rounded-lg transition-colors"
                            for="poster-upload-{item.id}">
                            {uploadingPoster ? 'Uploading…' : 'Upload image'}
                        </label>
                        <input
                            id="poster-upload-{item.id}"
                            type="file"
                            class="sr-only"
                            accept="image/*"
                            onchange={handlePosterFileInput}
                            disabled={uploadingPoster} />
                        <p class="text-xs text-surface-500">Or drag & drop onto thumbnail</p>
                    </div>
                </div>
            </div>

            <!-- Core fields -->
            <div class="space-y-4">
                <div class="space-y-1.5">
                    <label
                        class="text-xs text-surface-400 font-medium uppercase tracking-wide"
                        for="ce-title">
                        Title
                    </label>
                    <input id="ce-title" type="text" class={inputClass} bind:value={editTitle} />
                </div>

                <div class="space-y-1.5">
                    <label
                        class="text-xs text-surface-400 font-medium uppercase tracking-wide"
                        for="ce-overview">
                        Overview
                    </label>
                    <textarea
                        id="ce-overview"
                        class={inputClass}
                        rows="4"
                        style="resize: vertical;"
                        bind:value={editOverview}></textarea>
                </div>
            </div>

            <!-- Template metadata fields -->
            {#if template && template.metadataFields.length > 0}
                <div class="space-y-4">
                    <h3
                        class="text-xs text-surface-400 font-medium uppercase tracking-wide border-t border-surface-700 pt-4">
                        {template.label} Details
                    </h3>
                    {#each template.metadataFields as field (field.key)}
                        <MetadataFieldRenderer
                            {field}
                            value={editMetadata[field.key]}
                            autocompleteOptions={autocompleteOptions[field.key] ?? []}
                            onchange={(v) => {
                                editMetadata = { ...editMetadata, [field.key]: v };
                            }} />
                    {/each}
                </div>
            {/if}

            <!-- Escape hatch -->
            <div class="pt-2">
                <a
                    href={resolve(`/admin/library/media/${item.id}`)}
                    class="text-xs text-primary-400 hover:text-primary-300 underline">
                    Full edit in admin →
                </a>
            </div>
        </div>

        <!-- Footer actions -->
        <div class="flex gap-3 px-6 py-4 border-t border-surface-700 shrink-0">
            <button
                class="btn variant-filled-primary text-sm px-5 py-2"
                onclick={handleSave}
                disabled={saving || uploadingPoster}>
                {saving ? 'Saving…' : 'Save'}
            </button>
            <button
                class="btn variant-ghost-surface text-sm px-5 py-2"
                onclick={onclose}
                disabled={saving}>
                Cancel
            </button>
        </div>
    </div>
</div>
