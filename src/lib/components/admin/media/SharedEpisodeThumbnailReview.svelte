<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { onDestroy, untrack } from 'svelte';
    import * as m from '$lib/paraglide/messages.js';
    import { apiGet } from '$lib/api/client.js';
    import {
        cancelRun,
        getSharedEpisodeThumbReview,
        regenerateEpisodeThumbnails,
    } from '$lib/api/admin.js';
    import { RunSchema } from '$lib/schemas/run.schema.js';
    import type { SharedEpisodeThumbReview } from '$lib/schemas/admin-image-extraction.js';
    import { getCatalogThumbUrl } from '$lib/utils/image-utils.js';
    import { formatOffset } from '$lib/shared/manual-file-segments.js';
    import { toasts } from '$lib/stores/toast.store.js';

    let {
        mediaId,
        revision = 0,
        onsaved,
    }: {
        mediaId: string;
        revision?: number;
        onsaved?: () => void;
    } = $props();
    const pageSize = 12;
    let offset = $state(0);
    let review = $state<SharedEpisodeThumbReview | null>(null);
    let loading = $state(false);
    let error = $state('');
    let active = $state<{ episodeId: string; runId: string; ownerId: string } | null>(null);
    let queueing = $state<string | null>(null);
    let status = $state('');
    let generation = 0;
    let runTimer: ReturnType<typeof setInterval> | null = null;

    function stopPolling(): void {
        if (runTimer) clearInterval(runTimer);
        runTimer = null;
    }
    onDestroy(stopPolling);
    $effect(() => {
        void mediaId;
        untrack(() => {
            active = null;
            queueing = null;
            status = '';
            stopPolling();
        });
    });

    async function load(id: string, pageOffset: number, token: number): Promise<void> {
        loading = true;
        error = '';
        const result = await getSharedEpisodeThumbReview(id, pageSize, pageOffset).catch(() => ({
            data: undefined,
            error: m.media_thumb_review_load_failed(),
        }));
        if (token !== generation) return;
        loading = false;
        if (!result.data) {
            error = result.error ?? m.media_thumb_review_load_failed();
            review = null;
            return;
        }
        review = result.data;
        // A removal can empty the last page while the view is open.
        if (pageOffset > 0 && result.data.total <= pageOffset)
            offset = Math.max(0, pageOffset - pageSize);
    }

    $effect(() => {
        const id = mediaId;
        const pageOffset = offset;
        void revision;
        untrack(() => void load(id, pageOffset, ++generation));
        return () => {
            generation += 1;
        };
    });

    function refresh(): void {
        void load(mediaId, offset, ++generation);
    }

    function basename(path: string | null): string {
        return path?.split(/[\\/]/).pop() || m.media_thumb_review_unknown_source();
    }

    function resultCounts(
        value: unknown,
    ): { extracted: number; skipped: number; errors: number } | null {
        if (!value || typeof value !== 'object' || !('result' in value)) return null;
        const counts = value.result;
        if (
            !counts ||
            typeof counts !== 'object' ||
            !('extracted' in counts) ||
            !('skipped' in counts) ||
            !('errors' in counts) ||
            typeof counts.extracted !== 'number' ||
            typeof counts.skipped !== 'number' ||
            typeof counts.errors !== 'number'
        )
            return null;
        return { extracted: counts.extracted, skipped: counts.skipped, errors: counts.errors };
    }

    async function pollRun(): Promise<void> {
        const current = active;
        if (!current) return;
        const { data } = await apiGet(
            `/api/runs/${encodeURIComponent(current.runId)}`,
            RunSchema,
        ).catch(() => ({ data: undefined }));
        if (active?.runId !== current.runId || current.ownerId !== mediaId) return;
        if (!data) {
            status = m.media_p5_artwork_uncertain();
            return;
        }
        if (!['completed', 'failed', 'cancelled'].includes(data.state)) return;
        const counts = resultCounts(data.result);
        if (data.state === 'completed' && !counts) {
            status = m.media_p5_artwork_uncertain();
            return;
        }
        stopPolling();
        active = null;
        if (counts) {
            status = m.media_thumb_review_result({
                extracted: counts.extracted,
                skipped: counts.skipped,
                errors: counts.errors,
            });
        } else if (data.state === 'cancelled') status = m.media_thumb_review_cancelled();
        else status = m.media_thumb_review_failed();
        if (counts?.extracted) onsaved?.();
        refresh();
    }

    async function extract(episodeId: string, reviewToken: string): Promise<void> {
        if (active || queueing) return;
        const ownerId = mediaId;
        queueing = episodeId;
        status = '';
        const { data, error: requestError } = await regenerateEpisodeThumbnails(episodeId, {
            scope: 'episode',
            reviewToken,
        }).catch(() => ({ data: undefined, error: m.media_p5_artwork_uncertain() }));
        if (ownerId !== mediaId) return;
        queueing = null;
        if (!data) {
            status = requestError ?? m.media_thumb_review_stale();
            refresh();
            return;
        }
        active = { episodeId, runId: data.runId, ownerId };
        status = data.deduped ? m.task_action_already_running() : m.media_thumb_review_queued();
        stopPolling();
        runTimer = setInterval(() => void pollRun(), 3000);
        void pollRun();
    }

    async function cancel(): Promise<void> {
        if (!active) return;
        const { error: cancelError } = await cancelRun(active.runId);
        if (cancelError) toasts.error(cancelError);
        else status = m.task_action_cancelling();
    }
</script>

<details
    class="rounded border border-surface-700 bg-surface-800/30 p-3"
    aria-label={m.media_thumb_review_title()}>
    <summary class="cursor-pointer text-sm font-semibold text-surface-100"
        >{m.media_p5_optional_pictures()}</summary>
    <div class="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div>
            <p class="text-xs text-surface-400">{m.media_thumb_review_description()}</p>
        </div>
        <button
            type="button"
            onclick={refresh}
            disabled={loading}
            class="text-xs text-primary-400 disabled:opacity-50">
            {m.media_thumb_review_refresh()}
        </button>
    </div>
    {#if error}<p role="alert" class="mt-2 text-xs text-red-400">{error}</p>{/if}
    {#if status}<p role="status" class="mt-2 text-xs text-surface-200">{status}</p>{/if}
    {#if loading && !review}<p class="mt-3 text-xs text-surface-400">
            {m.media_thumb_review_loading()}
        </p>{/if}
    {#if review}
        <p class="mt-3 text-xs text-surface-400">
            {m.media_thumb_review_count({ count: review.total })}
        </p>
        {#if review.rows.length === 0}
            <p class="mt-2 text-xs text-surface-400">{m.media_thumb_review_empty()}</p>
        {:else}
            <ul class="mt-2 divide-y divide-surface-700">
                {#each review.rows as row (row.episodeId)}
                    <li
                        class="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-3 py-2 text-xs sm:flex sm:flex-wrap sm:items-center">
                        <img
                            src={`${getCatalogThumbUrl(row.episodeId, { size: 'thumb', fallback: 'none' })}&v=${revision}`}
                            alt=""
                            class="h-12 w-20 rounded bg-surface-700 object-cover" />
                        <div class="min-w-0 flex-1">
                            <p class="font-medium text-surface-100">
                                {m.media_thumb_review_episode({
                                    season: row.seasonNumber ?? 0,
                                    episode: row.episodeNumber ?? 0,
                                })} · {row.episodeTitle}
                            </p>
                            <p class="truncate text-surface-400" title={row.sourcePath ?? ''}>
                                {m.media_thumb_review_source()}: {basename(row.sourcePath)}
                            </p>
                            <p class="text-surface-400">
                                {#if row.startOffsetMs !== null && row.endOffsetMs !== null}
                                    {formatOffset(Number(row.startOffsetMs))}–{formatOffset(
                                        Number(row.endOffsetMs),
                                    )}
                                {:else}{m.media_thumb_review_window_unknown()}{/if}
                                {#if row.sourceSharedCount > 1}
                                    · {m.media_thumb_review_shared_file({
                                        count: row.sourceSharedCount,
                                    })}{/if}
                            </p>
                            <p class="text-surface-400">
                                {m.media_thumb_review_shared_image({ count: row.sharedCount })} · {m.media_thumb_review_candidates(
                                    { count: row.candidateCount },
                                )}
                            </p>
                            <p class="truncate text-surface-400" title={row.artworkPath}>
                                {m.media_thumb_review_selected()}: {basename(row.artworkPath)}
                            </p>
                            <p class="text-surface-400">
                                {row.provider}
                                {#if row.locked}
                                    · {m.media_thumb_review_locked()}{/if}
                                {#if row.chosenBy !== 'auto'}
                                    · {m.media_thumb_review_manual()}{/if}
                                {#if row.suppressed}
                                    · {m.media_thumb_review_removed()}{/if}
                            </p>
                        </div>
                        <button
                            type="button"
                            class="col-span-2 justify-self-start rounded bg-surface-700 px-2 py-1 text-surface-100 hover:bg-surface-600 disabled:opacity-50"
                            disabled={loading ||
                                !row.reviewToken ||
                                !!active ||
                                !!queueing ||
                                row.sourceMissing === true}
                            onclick={() =>
                                row.reviewToken && extract(row.episodeId, row.reviewToken)}>
                            {queueing === row.episodeId
                                ? m.media_images_queuing()
                                : m.media_thumb_review_extract()}
                        </button>
                    </li>
                {/each}
            </ul>
        {/if}
        <div class="mt-2 flex items-center justify-between gap-2 text-xs text-surface-400">
            <button
                type="button"
                disabled={offset === 0 || loading}
                onclick={() => (offset = Math.max(0, offset - pageSize))}
                class="disabled:opacity-40">{m.media_thumb_review_previous()}</button>
            <span
                >{m.media_thumb_review_page({
                    page: Math.floor(offset / pageSize) + 1,
                    pages: Math.max(1, Math.ceil(review.total / pageSize)),
                })}</span>
            <button
                type="button"
                disabled={offset + pageSize >= review.total || loading}
                onclick={() => (offset += pageSize)}
                class="disabled:opacity-40">{m.media_thumb_review_next()}</button>
        </div>
    {/if}
    {#if active}
        <div class="mt-2 flex items-center gap-3 text-xs text-surface-300">
            <span>{m.task_action_running()}</span>
            <button type="button" onclick={cancel} class="text-red-400"
                >{m.task_action_cancel()}</button>
        </div>
    {/if}
</details>
