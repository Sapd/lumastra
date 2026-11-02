<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Z } from '$lib/utils/z-index';
    import { z } from 'zod';
    import { Icon, XMark, ClipboardDocument } from 'svelte-hero-icons';
    import { apiGet } from '$lib/api/client';
    import { stopPropagation } from '$lib/utils/event-helpers';
    import { trapFocus } from '$lib/utils/focus-trap';
    import { toasts } from '$lib/stores/toast.store';
    import { getMediaStreams } from '$lib/api/media-streams';
    import * as m from '$lib/paraglide/messages';
    import type { StreamsResponse } from '$lib/schemas/api-admin-media-streams';

    interface Props {
        open: boolean;
        mediaId: string;
        title: string;
        /** When true (series cards), the /files endpoint includes
         * descendant season/episode files. The series-level row itself
         * has no media_files attached, so this is required to show
         * anything for a series. */
        includeChildren?: boolean;
        onClose: () => void;
    }

    let { open, mediaId, title, includeChildren = false, onClose }: Props = $props();

    type FileRow = {
        id: string;
        file_path: string;
        file_size_bytes: string | null;
        duration_seconds: number | null;
        container_format: string | null;
    };

    const FilesResponseSchema = z.object({
        files: z.array(
            z.object({
                id: z.string(),
                file_path: z.string(),
                file_size_bytes: z.union([z.string(), z.number()]).nullable(),
                duration_seconds: z.number().nullable(),
                container_format: z.string().nullable(),
            }),
        ),
    });

    type LoadState =
        | { kind: 'idle' }
        | { kind: 'loading' }
        | { kind: 'error'; message: string }
        | {
              kind: 'loaded';
              files: FileRow[];
              streams: StreamsResponse['streams'];
          };

    let loadState: LoadState = $state({ kind: 'idle' });

    $effect(() => {
        if (!open || !mediaId) return;
        loadState = { kind: 'loading' };
        let cancelled = false;
        const filesPath = `/api/admin/media/${encodeURIComponent(
            mediaId,
        )}/files${includeChildren ? '?children=true' : ''}`;
        void Promise.all([apiGet(filesPath, FilesResponseSchema), getMediaStreams(mediaId)])
            .then(([filesRes, streamsRes]) => {
                if (cancelled) return;
                if (filesRes.error || streamsRes.error) {
                    loadState = {
                        kind: 'error',
                        message: filesRes.error || streamsRes.error || m.modal_load_failed(),
                    };
                    return;
                }
                const rawFiles = filesRes.data?.files ?? [];
                const files: FileRow[] = rawFiles.map((f) => ({
                    id: f.id,
                    file_path: f.file_path,
                    file_size_bytes:
                        typeof f.file_size_bytes === 'number'
                            ? String(f.file_size_bytes)
                            : f.file_size_bytes,
                    duration_seconds: f.duration_seconds,
                    container_format: f.container_format,
                }));
                loadState = {
                    kind: 'loaded',
                    files,
                    streams: streamsRes.data?.streams ?? [],
                };
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                loadState = {
                    kind: 'error',
                    message: err instanceof Error ? err.message : 'Load failed',
                };
            });
        return () => {
            cancelled = true;
        };
    });

    function formatBytes(bytes: string | null): string {
        if (!bytes) return '—';
        const n = Number(bytes);
        if (!Number.isFinite(n) || n <= 0) return '—';
        const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
        let i = 0;
        let v = n;
        while (v >= 1024 && i < units.length - 1) {
            v /= 1024;
            i++;
        }
        return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
    }

    function formatDuration(sec: number | null): string {
        if (!sec || sec <= 0) return '—';
        const total = Math.round(sec);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
        return `${m}m ${String(s).padStart(2, '0')}s`;
    }

    async function copyPath(path: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(path);
            toasts.info(m.card_file_info_path_copied());
        } catch {
            toasts.error(m.card_file_info_copy_path_failed());
        }
    }

    function handleBackdrop(e: MouseEvent): void {
        if (e.target === e.currentTarget) onClose();
    }

    function handleKey(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
        }
    }
</script>

{#if open}
    <div
        class="fixed inset-0 flex items-center justify-center bg-black/50 px-4"
        style="z-index: {Z.FLOATING_MODAL}"
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-info-title"
        tabindex="-1"
        onclick={handleBackdrop}
        onkeydown={handleKey}>
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
            use:trapFocus
            role="document"
            class="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-surface-700 bg-surface-900 shadow-2xl"
            onclick={stopPropagation()}
            onkeydown={handleKey}>
            <header
                class="flex items-start justify-between gap-3 border-b border-surface-700 px-4 py-3">
                <div class="min-w-0">
                    <h2
                        id="file-info-title"
                        class="truncate text-base font-semibold text-surface-100">
                        {m.card_file_info_title()}
                    </h2>
                    <p class="truncate text-xs text-surface-400">{title}</p>
                </div>
                <button
                    type="button"
                    class="text-surface-400 hover:text-surface-100"
                    aria-label={m.close()}
                    onclick={onClose}>
                    <Icon src={XMark} class="h-5 w-5" />
                </button>
            </header>

            <div class="overflow-y-auto px-4 py-4 text-sm">
                {#if loadState.kind === 'loading'}
                    <p class="py-6 text-center text-surface-400">
                        {m.card_file_info_loading()}
                    </p>
                {:else if loadState.kind === 'error'}
                    <p class="py-6 text-center text-error-400">
                        {loadState.message}
                    </p>
                {:else if loadState.kind === 'loaded'}
                    {#if loadState.files.length === 0}
                        <p class="py-6 text-center text-surface-400">
                            {m.card_file_info_no_files()}
                        </p>
                    {:else}
                        <h3
                            class="mb-2 text-xs font-semibold uppercase tracking-wider text-surface-400">
                            {m.card_file_info_files_label()}
                        </h3>
                        <ul class="space-y-3">
                            {#each loadState.files as file (file.id)}
                                <li class="rounded border border-surface-700 bg-surface-800/50 p-3">
                                    <div class="flex items-center justify-between gap-2">
                                        <code
                                            class="block grow overflow-x-auto whitespace-nowrap text-xs text-surface-200">
                                            {file.file_path}
                                        </code>
                                        <button
                                            type="button"
                                            class="shrink-0 text-surface-400 hover:text-surface-100"
                                            aria-label={m.card_file_info_copy_path()}
                                            onclick={() => copyPath(file.file_path)}>
                                            <Icon src={ClipboardDocument} class="h-4 w-4" />
                                        </button>
                                    </div>
                                    <dl
                                        class="mt-2 grid grid-cols-3 gap-2 text-xs text-surface-400">
                                        <div>
                                            <dt class="opacity-70">
                                                {m.card_file_info_container()}
                                            </dt>
                                            <dd>
                                                {file.container_format ?? '—'}
                                            </dd>
                                        </div>
                                        <div>
                                            <dt class="opacity-70">
                                                {m.card_file_info_size()}
                                            </dt>
                                            <dd>
                                                {formatBytes(file.file_size_bytes)}
                                            </dd>
                                        </div>
                                        <div>
                                            <dt class="opacity-70">
                                                {m.card_file_info_duration()}
                                            </dt>
                                            <dd>
                                                {formatDuration(file.duration_seconds)}
                                            </dd>
                                        </div>
                                    </dl>
                                </li>
                            {/each}
                        </ul>
                    {/if}

                    {#if loadState.streams.length > 0}
                        <h3
                            class="mt-5 mb-2 text-xs font-semibold uppercase tracking-wider text-surface-400">
                            {m.card_file_info_streams_label()}
                        </h3>
                        <ul class="space-y-1.5 text-xs">
                            {#each loadState.streams as stream (stream.id)}
                                <li
                                    class="flex flex-wrap items-center gap-2 rounded border border-surface-700 bg-surface-800/50 px-3 py-1.5">
                                    <span
                                        class="rounded bg-surface-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-surface-200">
                                        {stream.stream_type}
                                    </span>
                                    <code class="text-surface-200">{stream.codec}</code>
                                    {#if stream.language}
                                        <span class="text-surface-400">· {stream.language}</span>
                                    {/if}
                                    {#if stream.width && stream.height}
                                        <span class="text-surface-400"
                                            >· {stream.width}×{stream.height}</span>
                                    {/if}
                                    {#if stream.channels}
                                        <span class="text-surface-400">· {stream.channels}ch</span>
                                    {/if}
                                    {#if stream.bitrate}
                                        <span class="text-surface-400"
                                            >· {Math.round(stream.bitrate / 1000)} kbps</span>
                                    {/if}
                                    {#if stream.is_default}
                                        <span
                                            class="rounded bg-primary-500/20 px-1.5 py-0.5 text-[10px] text-primary-300"
                                            >default</span>
                                    {/if}
                                </li>
                            {/each}
                        </ul>
                    {/if}
                {/if}
            </div>
        </div>
    </div>
{/if}
