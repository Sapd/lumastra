<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { getAvatarUrl } from '$lib/utils/image-utils.js';
    import Avatar from './Avatar.svelte';
    import { uploadAvatar, deleteAvatar } from '$lib/api/user';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        username: string;
        onSuccess?: () => void;
        onClose?: () => void;
        /**
         * `popover` (default): the narrow card the admin user drawer floats.
         * `inline`: settings row — preview beside the drop zone, no card chrome
         * and no dialog role (it is not one there).
         */
        variant?: 'popover' | 'inline';
    }

    let { username, onSuccess, onClose, variant = 'popover' }: Props = $props();

    let fileInput: HTMLInputElement | undefined = $state();
    let preview = $state<string | null>(null);
    let selectedFile = $state<File | null>(null);
    let uploading = $state(false);
    let avatarKey = $state(Date.now());
    let dragging = $state(false);

    function pickFile(file: File) {
        if (file.size > 2 * 1024 * 1024) {
            toasts.error(m.toast_avatar_file_too_large());
            return;
        }
        if (!file.type.match(/^image\/(jpeg|png|webp|gif)$/)) {
            toasts.error(m.toast_avatar_invalid_format());
            return;
        }
        if (preview) URL.revokeObjectURL(preview);
        selectedFile = file;
        preview = URL.createObjectURL(file);
    }

    function handleFileSelect(e: Event) {
        const input = e.target as HTMLInputElement;
        if (!input.files || input.files.length === 0) return;
        pickFile(input.files[0]);
    }

    function handleDrop(e: DragEvent) {
        e.preventDefault();
        dragging = false;
        const file = e.dataTransfer?.files[0];
        if (file) pickFile(file);
    }

    function handleDragOver(e: DragEvent) {
        e.preventDefault();
        dragging = true;
    }

    function handleDragLeave() {
        dragging = false;
    }

    async function handleUpload() {
        if (!selectedFile) return;
        uploading = true;

        const result = await uploadAvatar(username, selectedFile);
        uploading = false;

        if (result.success) {
            toasts.success(m.toast_avatar_updated());
            cleanup();
            avatarKey++;
            onSuccess?.();
        } else if (result.status === 413) {
            // Over a body limit — the route's 2 MB cap, the server's, or a proxy's.
            toasts.error(m.toast_avatar_file_too_large());
        } else {
            toasts.error(result.error ?? m.toast_avatar_upload_failed());
        }
    }

    async function handleRemove() {
        uploading = true;
        const { error } = await deleteAvatar(username);
        uploading = false;

        if (!error) {
            toasts.success(m.toast_avatar_removed());
            cleanup();
            avatarKey++;
            onSuccess?.();
        } else {
            toasts.error(m.toast_avatar_remove_failed());
        }
    }

    function cleanup() {
        if (preview) URL.revokeObjectURL(preview);
        preview = null;
        selectedFile = null;
        if (fileInput) fileInput.value = '';
    }

    $effect(() => {
        return () => {
            if (preview) URL.revokeObjectURL(preview);
        };
    });
    const avatarSrc = $derived(getAvatarUrl(username, { version: avatarKey }));
</script>

{#snippet preview_avatar()}
    <Avatar src={preview ?? avatarSrc} alt={m.ui_avatar_alt({ username })} {username} size="xl" />
{/snippet}

{#snippet dropzone_and_actions()}
    <!-- Drop zone / click-to-browse. A real button so it is reachable and
         operable from the keyboard; it used to be a clickable div. -->
    <button
        type="button"
        class="drop-zone w-full"
        class:dragging
        ondrop={handleDrop}
        ondragover={handleDragOver}
        ondragleave={handleDragLeave}
        disabled={uploading}
        onclick={() => fileInput?.click()}>
        {#if selectedFile}
            <span class="block text-sm font-medium truncate max-w-full px-2 text-center">
                {selectedFile.name}
            </span>
            <span class="block text-xs text-surface-400">{m.ui_avatar_choose_different()}</span>
        {:else}
            <span class="block text-sm font-medium">{m.ui_avatar_drop_here()}</span>
            <span class="block text-xs text-surface-400">{m.ui_avatar_or_browse()}</span>
            <span class="block text-xs text-surface-500 mt-1">{m.ui_avatar_formats_hint()}</span>
        {/if}
    </button>
    <input
        bind:this={fileInput}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        class="sr-only"
        tabindex="-1"
        aria-hidden="true"
        onchange={handleFileSelect}
        disabled={uploading} />

    <!-- Actions -->
    <div class="flex gap-2">
        {#if selectedFile}
            <button
                class="btn variant-filled-primary flex-1 text-sm"
                onclick={handleUpload}
                disabled={uploading}>
                {uploading ? m.ui_avatar_uploading() : m.ui_avatar_upload()}
            </button>
        {/if}
        <button
            class="btn variant-soft-error text-sm {variant === 'inline' ? '' : 'flex-1'}"
            onclick={handleRemove}
            disabled={uploading}>
            {m.ui_avatar_remove()}
        </button>
    </div>
{/snippet}

{#if variant === 'inline'}
    <div class="flex flex-col sm:flex-row items-center gap-4 sm:gap-6">
        <div class="shrink-0">{@render preview_avatar()}</div>
        <div class="w-full max-w-sm space-y-3">{@render dropzone_and_actions()}</div>
    </div>
{:else}
    <div
        class="card p-4 w-72 space-y-4 shadow-xl"
        role="dialog"
        aria-label={m.ui_change_avatar_aria()}>
        <!-- Current / preview avatar -->
        <div class="flex justify-center">{@render preview_avatar()}</div>
        {@render dropzone_and_actions()}

        {#if onClose}
            <button class="btn variant-ghost-surface w-full text-sm" onclick={onClose}
                >{m.cancel()}</button>
        {/if}
    </div>
{/if}

<style>
    .drop-zone {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.25rem;
        padding: 1rem;
        border: 2px dashed rgb(var(--color-surface-500-rgb) / 0.5);
        border-radius: 0.5rem;
        cursor: pointer;
        transition:
            border-color 0.15s,
            background-color 0.15s;
        text-align: center;
        min-height: 80px;
    }

    .drop-zone:hover,
    .drop-zone.dragging {
        border-color: var(--color-primary-500);
        background-color: rgb(var(--color-primary-500-rgb) / 0.06);
    }
</style>
