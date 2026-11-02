<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  AncillaryUploader — attaches subtitle, chapter, or resource file to an existing media item.

  Props:
    libraryPathId — UUID of the library path
    mediaItemId   — UUID of the already-ingested media item
    onComplete    — callback on success, receives { path, type }
    onError       — callback on error
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { uploadAncillaryFile, undoUploadedChapterFile } from '$lib/api/admin.js';

    interface Props {
        libraryPathId: string;
        mediaItemId: string;
        uploadId?: string;
        onComplete?: (result: { path: string; type: string }) => void;
        onError?: (error: string) => void;
    }

    let { libraryPathId, mediaItemId, uploadId, onComplete, onError }: Props = $props();

    type AncillaryType = 'subtitle' | 'chapter' | 'resource';

    let selectedType = $state<AncillaryType>('subtitle');
    let selectedFile = $state<File | null>(null);
    let uploading = $state(false);
    let done = $state(false);
    let restored = $state(false);
    let errorMsg = $state('');
    let resultPath = $state('');
    let undoId = $state<string | undefined>();

    let fileInput: HTMLInputElement;

    const TYPE_LABELS: Record<AncillaryType, string> = $derived({
        subtitle: m.media_plain_attachment_subtitle(),
        chapter: m.media_plain_attachment_chapters(),
        resource: m.media_plain_attachment_resource(),
    });

    const ACCEPT_MAP: Record<AncillaryType, string> = {
        subtitle: '.srt,.vtt,.ass,.ssa,.sub,.sup',
        chapter: '.vtt,.json',
        resource: '.pdf,.ppt,.pptx,.zip',
    };

    function onFileInput(e: Event): void {
        const input = e.target as HTMLInputElement;
        selectedFile = input.files?.[0] ?? null;
        errorMsg = '';
        done = false;
    }

    function reset(): void {
        selectedFile = null;
        uploading = false;
        done = false;
        errorMsg = '';
        resultPath = '';
        if (fileInput) fileInput.value = '';
    }

    async function upload(): Promise<void> {
        if (!selectedFile) return;
        uploading = true;
        errorMsg = '';

        const { data, error } = await uploadAncillaryFile(
            libraryPathId,
            mediaItemId,
            selectedFile,
            selectedType,
            uploadId,
        );

        if (error || !data) {
            errorMsg = error ?? 'Upload failed';
            onError?.(errorMsg);
            uploading = false;
            return;
        }

        restored = false;
        resultPath = data.path;
        undoId = data.undoId;
        done = true;
        onComplete?.({ path: resultPath, type: data.type });
        uploading = false;
    }
    async function undo(): Promise<void> {
        if (!undoId || uploading) return;
        uploading = true;
        errorMsg = '';
        try {
            const result = await undoUploadedChapterFile(
                libraryPathId,
                mediaItemId,
                undoId,
                uploadId,
            );
            if (result.error || !result.data) {
                errorMsg = result.error ?? m.media_p5_undo_conflict();
                return;
            }
            restored = true;
            undoId = undefined;
            done = false;
            selectedFile = null;
            if (fileInput) fileInput.value = '';
            onComplete?.({ path: result.data.path, type: 'chapter' });
        } finally {
            uploading = false;
        }
    }
</script>

<div class="card bg-surface-800 p-4 space-y-4">
    <h4 class="h5 font-semibold text-surface-100">{m.media_plain_attach_file()}</h4>

    <!-- Type selector -->
    <div class="space-y-1">
        <label class="label text-sm text-surface-300" for="ancillary-type"
            >{m.media_plain_file_type()}</label>
        <select
            id="ancillary-type"
            class="select bg-surface-700 border-surface-500 text-surface-100 rounded-md w-full"
            bind:value={selectedType}
            disabled={uploading}>
            {#each Object.entries(TYPE_LABELS) as [value, label] (value)}
                <option {value}>{label}</option>
            {/each}
        </select>
    </div>

    <!-- File picker -->
    <div>
        <label class="label text-sm text-surface-300" for="ancillary-file"
            >{m.media_plain_file()}</label>
        <input
            id="ancillary-file"
            bind:this={fileInput}
            type="file"
            class="input bg-surface-700 text-surface-100 w-full rounded-md p-2 text-sm"
            accept={ACCEPT_MAP[selectedType]}
            onchange={onFileInput}
            disabled={uploading} />
        {#if selectedFile}
            <p class="text-xs text-surface-400 mt-1">{selectedFile.name}</p>
        {/if}
    </div>

    {#if restored}<p role="status" class="text-success-400 text-sm">
            {m.media_p5_chapters_restored()}
        </p>{/if}
    {#if errorMsg}
        <p class="text-error-400 text-sm">{errorMsg}</p>
    {/if}

    {#if undoId}<button class="btn variant-soft-surface text-sm" onclick={undo} disabled={uploading}
            >{m.media_p5_undo_chapters()}</button
        >{/if}

    {#if done}
        <div class="rounded bg-success-900/30 border border-success-600 p-3">
            <p class="text-success-400 text-sm font-medium">{m.media_plain_attached()}</p>
            <p class="text-xs text-surface-400 mt-1 font-mono break-all">{resultPath}</p>
        </div>
        <button class="btn variant-soft-surface text-sm" onclick={reset}
            >{m.media_plain_attach_another()}</button>
    {:else}
        <button
            class="btn variant-filled-tertiary w-full"
            onclick={upload}
            disabled={!selectedFile || uploading}>
            {#if uploading}{m.media_plain_uploading()}{:else}{m.media_plain_attach()}{/if}
        </button>
    {/if}
</div>
