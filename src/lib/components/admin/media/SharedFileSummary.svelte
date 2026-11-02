<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { untrack } from 'svelte';
    import * as m from '$lib/paraglide/messages.js';
    import { getFileEpisodes } from '$lib/api/admin';
    import { apiUrl } from '$lib/shared/api-urls.js';
    import { resolve } from '$lib/paths';
    import type { FileEpisodesResponse } from '$lib/schemas/admin-file-episodes.js';
    import { formatOffset } from '$lib/shared/manual-file-segments';
    import EpisodeTrickplayPreview from './EpisodeTrickplayPreview.svelte';
    let {
        mediaId,
        fileId = null,
        onedit,
        refreshKey = 0,
    }: {
        mediaId: string;
        fileId?: string | null;
        onedit?: () => void;
        refreshKey?: number;
    } = $props();
    let data = $state<FileEpisodesResponse | null>(null);
    let failed = $state(false);
    let seekMs = $state<number | null>(null);
    let generation = 0;
    let seekDirection = $state<'nearest' | 'before'>('nearest');
    $effect(() => {
        const id = mediaId;
        const file = fileId;
        void refreshKey;
        untrack(() => {
            data = null;
            failed = false;
            seekMs = null;
            void load(id, file, ++generation);
        });
        return () => {
            generation += 1;
        };
    });
    async function load(id: string, file: string | null, token: number): Promise<void> {
        try {
            let selected = file;
            if (!selected) {
                const response = await fetch(apiUrl('internal', `/admin/media/${id}/files`));
                if (!response.ok) throw new Error('file-summary');
                const body = (await response.json()) as {
                    files?: Array<{ id: string; is_default?: boolean; file_sort_order?: number }>;
                };
                selected =
                    [...(body.files ?? [])].sort(
                        (a, b) =>
                            Number(b.is_default ?? false) - Number(a.is_default ?? false) ||
                            (a.file_sort_order ?? 0) - (b.file_sort_order ?? 0),
                    )[0]?.id ?? null;
            }
            if (token !== generation) return;
            if (!selected) {
                failed = true;
                return;
            }
            const result = await getFileEpisodes(id, selected);
            if (token !== generation) return;
            if (result.error || !result.data) {
                failed = true;
                return;
            }
            data = result.data;
        } catch {
            if (token === generation) failed = true;
        }
    }
    function boundaryEvidence(origin: string | null | undefined): string {
        switch (origin) {
            case 'manual':
                return m.file_editor_ux_manual();
            case 'chapter':
                return m.file_editor_ux_chapter();
            case 'runtime-split':
                return m.file_editor_ux_runtime();
            case 'even-split':
                return m.file_editor_ux_even();
            default:
                return m.media_redesign_boundary_source_unknown();
        }
    }
</script>

{#if data && data.links.length > 0}
    <section
        class="min-w-0 rounded-xl border border-surface-700 bg-surface-800/40 p-4 space-y-3"
        aria-label={m.media_redesign_shared_mappings()}>
        <h3 class="font-semibold">{m.media_redesign_shared_mappings()}</h3>
        <p class="text-sm text-surface-400">
            {m.media_redesign_file_links({ count: data.links.length })}
        </p>
        {#each data.links as link, index (link.mediaItemId)}
            <div
                class="rounded-lg bg-surface-900/50 p-3 space-y-2 {link.mediaItemId === mediaId
                    ? 'border border-yellow-500/40'
                    : ''}">
                <a
                    class="break-words text-sm text-yellow-300 hover:underline"
                    href={resolve(`/admin/library/media/${link.mediaItemId}`)}
                    >S{link.seasonNumber ?? '?'}E{link.episodeNumber ?? '?'} · {link.title ??
                        '—'}</a>
                <p class="text-xs text-surface-300">
                    {m.media_redesign_part({ index: index + 1, count: data.links.length })}
                </p>
                <p class="text-xs text-surface-300">
                    {m.media_redesign_file_time()}: {link.startMs == null
                        ? m.media_redesign_unknown()
                        : formatOffset(link.startMs)} → {link.endMs == null
                        ? m.media_redesign_unknown()
                        : formatOffset(link.endMs)}
                </p>
                <p class="text-xs text-surface-400">
                    {m.media_redesign_episode_time()}: {link.startMs != null && link.endMs != null
                        ? `0:00 → ${formatOffset(link.endMs - link.startMs)}`
                        : m.media_redesign_unknown()} · {boundaryEvidence(
                        link.boundaryOrigin ??
                            (link.offsetSource === 'manual' ? 'unknown' : link.offsetSource),
                    )}
                </p>
                <div class="flex flex-wrap gap-3 text-xs text-yellow-300">
                    {#if link.startMs != null}<button
                            type="button"
                            class="underline"
                            onclick={() => {
                                seekDirection = 'nearest';
                                seekMs = link.startMs;
                            }}>{m.media_redesign_preview_start()}</button
                        >{/if}
                    {#if link.endMs != null}<button
                            type="button"
                            class="underline"
                            onclick={() => {
                                seekDirection = 'before';
                                seekMs = link.endMs;
                            }}>{m.media_redesign_preview_end()}</button
                        >{/if}
                </div>
            </div>
        {/each}
        {#if seekMs != null}<EpisodeTrickplayPreview
                mediaId={data.links[0].mediaItemId}
                fileId={data.file.id}
                {seekMs}
                {seekDirection} />{/if}
        {#if onedit}<button type="button" class="text-sm text-yellow-300 underline" onclick={onedit}
                >{m.file_episodes_button()}</button
            >{/if}
    </section>
{:else if failed}
    <p class="text-sm text-surface-400">{m.media_redesign_boundaries_unknown()}</p>
{/if}
