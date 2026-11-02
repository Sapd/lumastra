<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  ChunkedUploader — handles chunked multipart video upload to a non-entertainment library.

  Props:
    libraryPathId   — UUID of the target library path
    destinationFolder — optional relative folder under library root
    onComplete      — callback when finalize succeeds, receives { uploadId, path, runId, queued }
    onError         — callback when an unrecoverable error occurs
    onBusyChange    — called with true while an upload is running, false when it ends

  Every upload attempt owns an AbortController. Cancel, unmount and a
  navigation away all abort it: the in-flight request is cancelled, the loop
  stops at its next await, and the server session is dropped so it does not
  keep counting against the per-user session cap.
-->

<script lang="ts">
    import { onDestroy } from 'svelte';
    import { beforeNavigate } from '$app/navigation';
    import { monitoredFetch } from '$lib/auth-monitor.js';
    import {
        initUploadSession,
        finalizeUploadSession,
        abortUploadSession,
    } from '$lib/api/admin.js';
    import {
        UploadInitResponseSchema,
        UploadChunkResponseSchema,
    } from '$lib/schemas/api-upload-responses.js';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        libraryPathId: string;
        destinationFolder?: string;
        onComplete?: (result: {
            uploadId: string;
            path: string;
            runId?: string;
            queued: boolean;
        }) => void;
        onError?: (error: string) => void;
        onBusyChange?: (busy: boolean) => void;
    }

    let {
        libraryPathId,
        destinationFolder = '',
        onComplete,
        onError,
        onBusyChange,
    }: Props = $props();

    // Upload state machine
    type UploadPhase =
        'idle' | 'validating' | 'uploading' | 'finalizing' | 'done' | 'error' | 'aborted';

    let phase = $state<UploadPhase>('idle');
    let errorMsg = $state('');
    let progress = $state(0); // 0–100
    let selectedFile = $state<File | null>(null);
    let dragOver = $state(false);
    let ingestQueued = $state(true);

    let fileInput = $state<HTMLInputElement | undefined>(undefined);

    const busy = $derived(
        phase === 'validating' || phase === 'uploading' || phase === 'finalizing',
    );
    $effect(() => {
        onBusyChange?.(busy);
    });

    /** The running attempt; null when no upload is in flight. */
    let attempt: { controller: AbortController; uploadId: string; finalizing: boolean } | null =
        null;

    /** Retries per chunk on a network error, 408, 429 or 5xx (exponential backoff). */
    const CHUNK_RETRIES = 4;
    /** Assembling a multi-GB file server-side takes far longer than the default 30 s. */
    const FINALIZE_TIMEOUT_MS = 60 * 60_000;
    /** Per-chunk request timeout. */
    const CHUNK_TIMEOUT_MS = 5 * 60_000;

    const ALLOWED_VIDEO_EXTS = new Set([
        '.mkv',
        '.mp4',
        '.avi',
        '.m4v',
        '.mov',
        '.wmv',
        '.ts',
        '.m2ts',
        '.webm',
        '.ogv',
        '.flv',
    ]);

    function getFileExt(filename: string): string {
        const dot = filename.lastIndexOf('.');
        return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
    }

    function formatSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
        return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }

    function validateFile(file: File): string | null {
        const ext = getFileExt(file.name);
        if (!ALLOWED_VIDEO_EXTS.has(ext)) {
            return m.admin_upload_err_type({
                ext: ext || '—',
                allowed: [...ALLOWED_VIDEO_EXTS].join(', '),
            });
        }
        if (file.size === 0) return m.admin_upload_err_empty();
        return null;
    }

    function onDrop(e: DragEvent): void {
        e.preventDefault();
        dragOver = false;
        if (busy) return;
        const file = e.dataTransfer?.files?.[0];
        if (file) pickFile(file);
    }

    function onFileInput(e: Event): void {
        const input = e.target as HTMLInputElement;
        const file = input.files?.[0];
        if (file) pickFile(file);
    }

    function pickFile(file: File): void {
        if (busy) return;
        const err = validateFile(file);
        if (err) {
            // Drop any earlier valid pick: "Start upload" must not stay
            // wired to a file other than the one the error is about.
            selectedFile = null;
            errorMsg = err;
            phase = 'error';
            return;
        }
        selectedFile = file;
        errorMsg = '';
        phase = 'idle';
    }

    function reset(): void {
        phase = 'idle';
        errorMsg = '';
        progress = 0;
        selectedFile = null;
        if (fileInput) {
            fileInput.value = '';
        }
    }

    /** Drops a server session best-effort (frees its slot and staging space). */
    function dropServerSession(uploadId: string): void {
        if (uploadId) void abortUploadSession(libraryPathId, uploadId).catch(() => {});
    }

    function fail(message: string, uploadId: string, keepSession = false): void {
        // A failed attempt is not resumable from this UI, so release the
        // session instead of leaving it to count against the cap for a day.
        if (!keepSession) dropServerSession(uploadId);
        attempt = null;
        errorMsg = message;
        phase = 'error';
        onError?.(message);
    }

    function isRetryableStatus(status: number): boolean {
        return status === 408 || status === 429 || status >= 500;
    }

    function sleep(ms: number, signal: AbortSignal): Promise<void> {
        return new Promise((resolve) => {
            const t = setTimeout(resolve, ms);
            signal.addEventListener(
                'abort',
                () => {
                    clearTimeout(t);
                    resolve();
                },
                { once: true },
            );
        });
    }

    /** PUTs one chunk, retrying transient failures. Throws with a user-facing message. */
    async function putChunk(
        uploadId: string,
        index: number,
        body: Blob,
        signal: AbortSignal,
    ): Promise<void> {
        const url = `/api/admin/upload/${encodeURIComponent(libraryPathId)}/chunks/${encodeURIComponent(uploadId)}/${index}`;
        let lastError = '';
        for (let tryNo = 0; tryNo <= CHUNK_RETRIES; tryNo++) {
            if (signal.aborted) return;
            if (tryNo > 0) await sleep(500 * 2 ** (tryNo - 1), signal);
            if (signal.aborted) return;

            const timeout = new AbortController();
            const timer = setTimeout(() => timeout.abort(), CHUNK_TIMEOUT_MS);
            const onAbort = (): void => timeout.abort();
            signal.addEventListener('abort', onAbort, { once: true });
            let res: Response;
            try {
                res = await monitoredFetch(url, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/octet-stream' },
                    body,
                    signal: timeout.signal,
                });
            } catch (err) {
                if (signal.aborted) return;
                lastError = err instanceof Error ? err.message : String(err);
                continue; // network error / timeout — retry
            } finally {
                clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
            }

            if (res.ok) {
                const parsed = UploadChunkResponseSchema.safeParse(
                    await res.json().catch(() => null),
                );
                // A 200 that is not the chunk acknowledgement (a proxy or
                // captive-portal page) is not a stored chunk.
                if (parsed.success && parsed.data.chunkIndex === index) return;
                lastError = m.admin_upload_err_unexpected_response();
                continue;
            }

            if (res.status === 413) throw new Error(m.admin_upload_err_too_large());
            const problem = (await res.json().catch(() => ({}))) as {
                detail?: string;
                error?: string;
                title?: string;
                message?: string;
            };
            lastError =
                problem.detail ??
                problem.error ??
                problem.title ??
                problem.message ??
                `HTTP ${res.status}`;
            if (!isRetryableStatus(res.status)) throw new Error(lastError);
        }
        throw new Error(lastError);
    }

    async function startUpload(): Promise<void> {
        if (busy || !selectedFile || !libraryPathId) return;
        const controller = new AbortController();
        const current = { controller, uploadId: '', finalizing: false };
        attempt = current;
        const { signal } = controller;
        const stillCurrent = (): boolean => attempt === current && !signal.aborted;

        phase = 'validating';
        errorMsg = '';
        progress = 0;
        const file = selectedFile;

        // 1. Init. The server derives the chunk layout from the size; the
        // count sent here is advisory.
        const assumedChunk = 5 * 1024 * 1024;
        const {
            data: initData,
            error: initError,
            status: initStatus,
        } = await initUploadSession(
            libraryPathId,
            {
                filename: file.name,
                // Browsers report '' for extensions the OS has no MIME entry for;
                // the server's extension check is the real gate.
                mimeType: file.type || 'application/octet-stream',
                totalSize: file.size,
                totalChunks: Math.max(1, Math.ceil(file.size / assumedChunk)),
                destinationFolder: destinationFolder || undefined,
            },
            { signal },
        );
        const parsed = initData ? UploadInitResponseSchema.safeParse(initData) : null;
        if (parsed?.success) current.uploadId = parsed.data.uploadId;
        if (!stillCurrent()) {
            // Cancelled (or unmounted) while init was in flight.
            dropServerSession(current.uploadId);
            return;
        }
        if (initError || !parsed?.success) {
            fail(
                initStatus === 413
                    ? m.admin_upload_err_too_large()
                    : m.admin_upload_err_init({
                          error: initError ?? m.admin_upload_err_unexpected_response(),
                      }),
                current.uploadId,
            );
            return;
        }

        const uploadId = parsed.data.uploadId;
        const chunkSize = parsed.data.chunkSize;
        phase = 'uploading';

        // 2. Chunks — binary PUT of each Blob slice (no full-file read).
        const totalChunks = Math.ceil(file.size / chunkSize);
        for (let i = 0; i < totalChunks; i++) {
            const start = i * chunkSize;
            const slice = file.slice(start, Math.min(start + chunkSize, file.size));
            try {
                await putChunk(uploadId, i, slice, signal);
            } catch (err) {
                if (!stillCurrent()) return;
                fail(
                    m.admin_upload_err_chunk({
                        index: i + 1,
                        error: err instanceof Error ? err.message : String(err),
                    }),
                    uploadId,
                );
                return;
            }
            if (!stillCurrent()) return;
            progress = Math.round(((i + 1) / totalChunks) * 95);
        }

        // 3. Finalize — assembling a large file can take minutes.
        phase = 'finalizing';
        current.finalizing = true;
        const {
            data: finalData,
            error: finalError,
            status: finalStatus,
        } = await finalizeUploadSession(
            libraryPathId,
            uploadId,
            { totalChunks },
            { signal, timeout: FINALIZE_TIMEOUT_MS },
        );
        if (!stillCurrent()) return;
        if (finalError || !finalData) {
            fail(
                m.admin_upload_err_finalize({
                    error: finalError ?? m.admin_upload_err_unexpected_response(),
                }),
                uploadId,
                // No HTTP answer (timeout, network): the server may still be
                // assembling — an abort now would delete the staging dir
                // under it. The session expires on its own.
                finalStatus === 0,
            );
            return;
        }
        attempt = null;
        progress = 100;
        ingestQueued = finalData.status === 'queued';
        phase = 'done';
        onComplete?.({
            uploadId,
            path: finalData.path,
            runId: finalData.runId,
            queued: ingestQueued,
        });
    }

    /** Stops the running attempt and drops its server session. */
    function cancelAttempt(): void {
        const current = attempt;
        if (!current) return;
        attempt = null;
        current.controller.abort();
        // During finalize the server is assembling from the staging dir; an
        // abort would delete it mid-assembly. Only the request is dropped.
        if (!current.finalizing) dropServerSession(current.uploadId);
    }

    function abortUpload(): void {
        if (!busy) return;
        cancelAttempt();
        phase = 'aborted';
        progress = 0;
    }

    beforeNavigate(({ cancel, willUnload }) => {
        if (!busy) return;
        // A full unload is handled by the native beforeunload prompt below.
        if (!willUnload && !confirm(m.admin_upload_leave_confirm())) cancel();
    });

    function onBeforeUnload(e: BeforeUnloadEvent): void {
        if (busy) e.preventDefault();
    }

    onDestroy(() => {
        cancelAttempt();
    });
</script>

<svelte:window onbeforeunload={onBeforeUnload} />

<div class="card bg-surface-800 p-6 space-y-4">
    <h3 class="h4 font-semibold text-surface-100">{m.admin_upload_heading()}</h3>

    <!-- Drop zone -->
    {#if phase === 'idle' || phase === 'error'}
        <div
            class="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors
                   {dragOver
                ? 'border-primary-400 bg-primary-900/20'
                : 'border-surface-500 hover:border-surface-300'}"
            role="button"
            tabindex="0"
            aria-label={m.admin_upload_drop_label()}
            ondrop={onDrop}
            ondragover={(e) => {
                e.preventDefault();
                dragOver = true;
            }}
            ondragleave={() => {
                dragOver = false;
            }}
            onclick={(e) => {
                if (e.target !== fileInput) fileInput?.click();
            }}
            onkeydown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fileInput?.click();
                }
            }}>
            {#if selectedFile}
                <p class="text-surface-200 font-medium">{selectedFile.name}</p>
                <p class="text-sm text-surface-400 mt-1">{formatSize(selectedFile.size)}</p>
            {:else}
                <p class="text-surface-300">{m.admin_upload_drop_prompt()}</p>
                <p class="text-xs text-surface-500 mt-2">
                    {m.admin_upload_supported({
                        formats: 'MKV, MP4, AVI, M4V, MOV, WMV, WebM, TS',
                    })}
                </p>
            {/if}
            <input
                bind:this={fileInput}
                type="file"
                class="hidden"
                accept=".mkv,.mp4,.avi,.m4v,.mov,.wmv,.ts,.m2ts,.webm,.ogv,.flv"
                onchange={onFileInput} />
        </div>

        {#if errorMsg}
            <p class="text-error-400 text-sm" role="alert">{errorMsg}</p>
        {/if}

        {#if selectedFile}
            <button
                class="btn variant-filled-primary w-full"
                onclick={startUpload}
                disabled={!libraryPathId}>
                {m.admin_upload_start()}
            </button>
        {/if}
    {/if}

    <!-- Progress -->
    {#if busy}
        <div class="space-y-2">
            <p class="text-sm text-surface-300" aria-live="polite">
                {#if phase === 'validating'}{m.admin_upload_initialising()}
                {:else if phase === 'uploading'}{m.admin_upload_uploading({ percent: progress })}
                {:else}{m.admin_upload_finalising()}
                {/if}
            </p>
            <div
                class="w-full bg-surface-600 rounded-full h-2"
                role="progressbar"
                aria-label={m.admin_upload_progress_label()}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress}>
                <div
                    class="bg-primary-500 h-2 rounded-full transition-all duration-200"
                    style="width: {progress}%">
                </div>
            </div>
            {#if phase !== 'finalizing'}
                <button class="btn variant-soft-error text-sm" onclick={abortUpload}>
                    {m.admin_upload_cancel()}
                </button>
            {/if}
        </div>
    {/if}

    <!-- Done -->
    {#if phase === 'done'}
        <div
            class="rounded-lg bg-success-900/30 border border-success-600 p-4 space-y-2"
            role="status">
            <p class="text-success-400 font-medium">{m.admin_upload_done()}</p>
            <p class="text-xs text-surface-400">
                {ingestQueued ? m.admin_upload_done_queued() : m.admin_upload_done_not_queued()}
            </p>
        </div>
        <button class="btn variant-soft-surface text-sm" onclick={reset}
            >{m.admin_upload_another()}</button>
    {/if}

    <!-- Aborted -->
    {#if phase === 'aborted'}
        <p class="text-surface-400 text-sm" role="status">{m.admin_upload_cancelled()}</p>
        <button class="btn variant-soft-surface text-sm" onclick={reset}
            >{m.admin_upload_start_over()}</button>
    {/if}
</div>
