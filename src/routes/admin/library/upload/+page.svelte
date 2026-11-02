<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { mediaTypeName } from '$lib/components/admin/media/media-issue-presentation.js';
    import type { PageData } from './$types';
    import ChunkedUploader from '$lib/components/upload/ChunkedUploader.svelte';
    import AncillaryUploader from '$lib/components/upload/AncillaryUploader.svelte';
    import { resolve } from '$lib/paths';
    import { AdminPageHeader } from '$lib/components/admin';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import * as m from '$lib/paraglide/messages.js';
    import { untrack } from 'svelte';
    import { apiGet } from '$lib/api/client.js';
    import { RunSchema } from '$lib/schemas/run.schema.js';
    import { getUploadAttachmentTargets } from '$lib/api/upload-attachment-targets.js';
    import type { UploadAttachmentTargets } from '$lib/schemas/api-upload-responses.js';

    interface Props {
        data: PageData;
    }

    let { data }: Props = $props();

    let libraryPaths = $derived(data.libraryPaths ?? []);

    let selectedLibraryPathId = $state('');
    let destinationFolder = $state('');

    let uploadBusy = $state(false);

    // After a successful primary upload, store the mediaItemId for ancillary uploads
    let lastUploadedPath = $state('');
    /** Library path the last upload went to — ancillary files must go to the same one. */
    let lastUploadLibraryPathId = $state('');
    let lastUploadRunId = $state('');
    let lastUploadId = $state('');
    let attachmentTargets = $state<UploadAttachmentTargets | null>(null);
    let attachmentError = $state(false);
    // Resolve from the exact ingest result, retaining a choice only for a genuinely shared file.
    let ancillaryMediaItemId = $state('');

    function onUploadComplete(result: { uploadId: string; path: string; runId?: string }): void {
        lastUploadedPath = result.path;
        lastUploadLibraryPathId = selectedLibraryPathId;
        ancillaryMediaItemId = '';
        lastUploadRunId = result.runId ?? '';
        lastUploadId = result.uploadId;
        attachmentTargets = null;
    }

    function onUploadError(error: string): void {
        console.error('[upload] primary upload error:', error);
    }

    const ancillaryIdValid = $derived(
        attachmentTargets?.targets.some((target) => target.id === ancillaryMediaItemId) ?? false,
    );
    $effect(() => {
        const uploadId = lastUploadId;
        const libraryId = lastUploadLibraryPathId;
        const runId = lastUploadRunId;
        if (!uploadId || !libraryId) return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;
        async function refresh(): Promise<void> {
            try {
                if (runId) {
                    const run = await apiGet(`/api/runs/${encodeURIComponent(runId)}`, RunSchema);
                    if (stopped) return;
                    if (!run.data || run.data.taskId !== 'file-delta-ingest') {
                        attachmentError = true;
                        timer = setTimeout(() => void refresh(), 3000);
                        return;
                    }
                    if (run.data.state === 'failed' || run.data.state === 'cancelled') {
                        attachmentTargets = { status: 'failed', targets: [] };
                        return;
                    }
                    if (run.data.state !== 'completed') {
                        timer = setTimeout(() => void refresh(), 3000);
                        return;
                    }
                }
                const result = await getUploadAttachmentTargets(libraryId, uploadId);
                if (stopped) return;
                if (result.data) {
                    attachmentTargets = result.data;
                    attachmentError = false;
                    // Preserve a deliberate choice if ingest discovers more than one target.
                    if (!result.data.targets.some((target) => target.id === ancillaryMediaItemId))
                        ancillaryMediaItemId = result.data.targetId ?? '';
                    if (
                        result.data.status === 'ready' ||
                        result.data.status === 'ambiguous' ||
                        result.data.status === 'failed'
                    )
                        return;
                } else attachmentError = true;
            } catch {
                if (!stopped) attachmentError = true;
            }
            if (!stopped) timer = setTimeout(() => void refresh(), 3000);
        }
        untrack(() => void refresh());
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    });
</script>

<svelte:head>
    <title>{m.admin_nav_page_library_upload()} — Admin</title>
</svelte:head>

<div class="container mx-auto max-w-3xl px-4 py-8 space-y-8">
    <AdminPageHeader
        icon={adminPageIcons['/admin/library/upload']}
        title={m.admin_nav_page_library_upload()}
        description={m.admin_nav_desc_library_upload()} />

    {#if libraryPaths.length === 0}
        <div class="card bg-surface-800 p-6 text-center">
            <p class="text-surface-300">{m.admin_upload_no_paths_title()}</p>
            <p class="text-sm text-surface-500 mt-2">
                {m.admin_upload_no_paths_hint({
                    types: ['training', 'educational', 'home_video', 'personal']
                        .map(mediaTypeName)
                        .join(', '),
                })}
                <a href={resolve('/admin/library/sources')} class="anchor"
                    >{m.admin_nav_page_library_sources()}</a>
            </p>
        </div>
    {:else}
        <!-- Library path selector -->
        <div class="card bg-surface-800 p-6 space-y-4">
            <h2 class="h4 font-semibold text-surface-100">{m.admin_upload_target_library()}</h2>

            <div class="space-y-2">
                <label class="label text-sm text-surface-300" for="library-path-select">
                    {m.admin_upload_library_path_label()}
                </label>
                <select
                    id="library-path-select"
                    class="select bg-surface-700 border-surface-500 text-surface-100 rounded-md w-full"
                    disabled={uploadBusy}
                    value={selectedLibraryPathId}
                    onchange={(event) => {
                        selectedLibraryPathId = event.currentTarget.value;
                    }}>
                    <option value="">{m.admin_upload_select_placeholder()}</option>
                    {#each libraryPaths as lp (lp.id)}
                        <option value={lp.id}>{lp.path} ({mediaTypeName(lp.media_type)})</option>
                    {/each}
                </select>
            </div>

            <div class="space-y-2">
                <label class="label text-sm text-surface-300" for="dest-folder">
                    {m.admin_upload_dest_folder_label()}
                    <span class="text-surface-500">{m.admin_home_setup_optional()}</span>
                </label>
                <input
                    id="dest-folder"
                    type="text"
                    class="input bg-surface-700 border-surface-500 text-surface-100 rounded-md w-full"
                    placeholder={m.admin_upload_dest_folder_placeholder()}
                    disabled={uploadBusy}
                    bind:value={destinationFolder} />
                <p class="text-xs text-surface-500">
                    {m.admin_upload_dest_folder_hint()}
                </p>
            </div>
        </div>

        <!-- Uploader -->
        {#if selectedLibraryPathId}
            {#key selectedLibraryPathId}
                <ChunkedUploader
                    libraryPathId={selectedLibraryPathId}
                    {destinationFolder}
                    onComplete={onUploadComplete}
                    onError={onUploadError}
                    onBusyChange={(b) => (uploadBusy = b)} />
            {/key}
        {:else}
            <div class="card bg-surface-800 p-6 text-center text-surface-400 text-sm">
                {m.admin_upload_select_prompt()}
            </div>
        {/if}

        <!-- Post-upload: attach ancillary files -->
        {#if lastUploadedPath && lastUploadLibraryPathId === selectedLibraryPathId}
            <div class="card bg-surface-800 p-6 space-y-4">
                <h2 class="h4 font-semibold text-surface-100">
                    {m.admin_upload_attach_files_heading()}
                </h2>
                <p class="text-sm text-surface-400">
                    {m.admin_upload_uploaded_to()}
                    <code class="font-mono text-xs break-all">{lastUploadedPath}</code>
                </p>
                {#if lastUploadRunId}
                    <p class="text-xs text-surface-500">
                        {m.admin_upload_ingest_run()}
                        <a
                            href="{resolve('/admin/tasks/runs')}?run={lastUploadRunId}"
                            class="anchor">{m.media_plain_open_progress()}</a>
                    </p>
                {/if}

                {#if attachmentTargets && (attachmentTargets.status === 'ambiguous' || attachmentTargets.targets.length > 1)}
                    <label class="block text-sm text-surface-300" for="ancillary-target"
                        >{m.media_p5_upload_choose_target()}</label>
                    <select
                        id="ancillary-target"
                        class="select w-full"
                        value={ancillaryMediaItemId}
                        onchange={(event) => {
                            ancillaryMediaItemId = event.currentTarget.value;
                        }}>
                        <option value="">{m.media_p5_upload_choose_target()}</option>
                        {#each attachmentTargets.targets as target (target.id)}
                            <option value={target.id}
                                >{target.seasonNumber !== undefined
                                    ? `S${target.seasonNumber} E${target.episodeNumber ?? '?'} · `
                                    : ''}{target.title}</option>
                        {/each}
                    </select>
                {:else if attachmentTargets?.targets[0]}
                    <p class="text-sm text-surface-200">
                        {m.media_p5_upload_attaching_to({
                            title: attachmentTargets.targets[0].title,
                        })}
                    </p>
                {/if}
                {#if attachmentError}<p role="status" class="text-xs text-amber-300">
                        {m.media_p5_upload_unknown()}
                    </p>{/if}

                {#if ancillaryIdValid}
                    {#key ancillaryMediaItemId.trim()}
                        <AncillaryUploader
                            libraryPathId={lastUploadLibraryPathId}
                            mediaItemId={ancillaryMediaItemId.trim()}
                            uploadId={lastUploadId} />
                    {/key}
                {:else}
                    <p class="text-xs text-surface-500">
                        {attachmentTargets?.status === 'failed'
                            ? m.media_p5_upload_failed()
                            : m.media_p5_upload_waiting()}
                    </p>
                {/if}
            </div>
        {/if}
    {/if}
</div>
