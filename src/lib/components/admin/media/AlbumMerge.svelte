<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { onDestroy, untrack } from 'svelte';
    import { z } from 'zod';
    import { apiGet, apiPost } from '$lib/api/client.js';
    import {
        CompilationRepairPreviewSchema,
        type CompilationRepairPreview,
        AlbumMergeResultSchema,
        type AlbumMergePreview,
    } from '$lib/schemas/album-merge.js';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';

    let {
        albumId,
        initialTarget,
        onmerged,
        hideTrigger = false,
    }: {
        albumId: string;
        initialTarget?: string;
        hideTrigger?: boolean;
        onmerged: (survivorId: string) => void;
    } = $props();
    const SearchSchema = z.object({
        results: z.array(
            z.object({
                id: z.string(),
                title: z.string().nullable(),
                mediaType: z.string(),
                parentTitle: z.string().optional(),
            }),
        ),
    });
    type Target = z.infer<typeof SearchSchema>['results'][number];
    let compilation = $state<CompilationRepairPreview | null>(null);
    async function loadCompilation(): Promise<void> {
        const token = ++generation;
        busy = true;
        error = '';
        try {
            const result = await apiGet(
                `/api/admin/media/${albumId}/artist`,
                CompilationRepairPreviewSchema,
                { params: { compilationPreview: '1' } },
            );
            if (token !== generation) return;
            if (!result.data) {
                error = m.music_compilation_failed();
                return;
            }
            compilation = result.data;
        } catch {
            if (token === generation) error = m.music_compilation_failed();
        } finally {
            if (token === generation) busy = false;
        }
    }
    let open = $state(false);
    export function show(): void {
        open = true;
    }
    let query = $state('');
    let targets = $state<Target[]>([]);
    let targetId = $state('');
    let survivorId = $state<string | undefined>();
    let overrideLocks = $state(false);
    let preview = $state<AlbumMergePreview | null>(null);
    let busy = $state(false);
    let error = $state('');
    let generation = 0;
    let acknowledged = $state(false);
    let confirmationTitle = $state('');
    let sourceId = untrack(() => albumId);
    // The panel sits above the page header; a caller opening it from lower
    // down the page (More actions) needs it brought into view, with the search
    // field focused so the operator can type straight away.
    let panel = $state<HTMLElement | null>(null);
    let searchField = $state<HTMLInputElement | null>(null);
    $effect(() => {
        if (!open || !panel) return;
        searchField?.focus({ preventScroll: true });
        panel.scrollIntoView({ block: 'nearest' });
    });
    function resetConfirmation(): void {
        acknowledged = false;
        confirmationTitle = '';
    }
    function cancel(): void {
        generation += 1;
        busy = false;
        open = false;
        preview = null;
        compilation = null;
        error = '';
        resetConfirmation();
    }
    onDestroy(() => {
        generation += 1;
    });
    $effect(() => {
        const id = albumId;
        untrack(() => {
            if (id !== sourceId) {
                sourceId = id;
                cancel();
                query = '';
                targets = [];
                targetId = '';
                survivorId = undefined;
                overrideLocks = false;
            }
        });
    });

    $effect(() => {
        const id = initialTarget;
        const source = albumId;
        untrack(() => {
            if (id && id !== source) {
                open = true;
                void loadPreview(id);
            }
        });
    });
    async function search(): Promise<void> {
        const seq = ++generation;
        const source = albumId;
        resetConfirmation();
        preview = null;
        compilation = null;
        error = '';
        busy = true;
        try {
            const result = await apiGet(
                `/api/admin/media/search?q=${encodeURIComponent(query)}&mediaType=album`,
                SearchSchema,
            );
            if (seq !== generation || source !== albumId) return;
            targets = (result.data?.results ?? []).filter(
                (t) => t.id !== albumId && t.mediaType === 'album',
            );
            error = result.error ?? '';
        } catch {
            if (seq === generation && source === albumId) error = m.album_merge_error();
        } finally {
            if (seq === generation && source === albumId) busy = false;
        }
    }
    async function loadPreview(id: string, keep?: string): Promise<void> {
        const seq = ++generation;
        const source = albumId;
        resetConfirmation();
        targetId = id;
        survivorId = keep;
        preview = null;
        compilation = null;
        error = '';
        busy = true;
        try {
            const result = await apiPost('/api/admin/media/merge', AlbumMergeResultSchema, {
                keepId: albumId,
                mergeId: id,
                survivorId: keep,
                overrideLocks,
                mode: 'preview',
            });
            if (seq !== generation || source !== albumId) return;
            preview = result.data?.preview ?? null;
            error = result.error ?? '';
        } catch {
            if (seq === generation && source === albumId) error = m.album_merge_error();
        } finally {
            if (seq === generation && source === albumId) busy = false;
        }
    }
    async function apply(): Promise<void> {
        if (
            !preview ||
            busy ||
            !acknowledged ||
            confirmationTitle !== preview.removed.title ||
            (preview.locks.requiresOverride && !overrideLocks)
        )
            return;
        const seq = ++generation;
        const source = albumId;
        const notify = onmerged;
        const confirmed = preview;
        busy = true;
        error = '';
        try {
            const result = await apiPost('/api/admin/media/merge', AlbumMergeResultSchema, {
                keepId: albumId,
                mergeId: targetId,
                survivorId,
                overrideLocks,
                mode: 'apply',
                previewToken: confirmed.previewToken,
            });
            if (seq !== generation || source !== albumId) return;
            if (
                result.data?.applied &&
                result.data.preview.keepId === confirmed.keepId &&
                result.data.preview.mergeId === confirmed.mergeId
            ) {
                preview = null;
                open = false;
                notify(result.data.preview.keepId);
            } else {
                preview = null;
                error = result.error ?? m.album_merge_error();
            }
        } catch {
            if (seq !== generation || source !== albumId) return;
            preview = null;
            error = m.album_merge_error();
        } finally {
            if (seq === generation && source === albumId) busy = false;
        }
    }
    function referenceLabel(table: string): string {
        switch (table) {
            case 'media_artwork':
            case 'media_artwork_suppressions':
                return m.album_merge_data_images();
            case 'user_ratings':
                return m.album_merge_data_ratings();
            case 'user_media_state':
                return m.album_merge_data_state();
            case 'playlist_items':
                return m.album_merge_data_playlists();
            case 'external_ids':
                return m.album_merge_data_ids();
            case 'provider_metadata':
            case 'media_item_stage_state':
                return m.album_merge_data_enrichment();
            default:
                return m.album_merge_data_other();
        }
    }
    function policyLabel(policy: AlbumMergePreview['albumData'][number]['policy']): string {
        switch (policy) {
            case 'merge-user-state':
                return m.album_merge_policy_state();
            case 'move-all':
                return m.album_merge_policy_move();
            case 'artwork-alternatives':
                return m.album_merge_policy_artwork();
            case 'archive-enrichment':
                return m.album_merge_policy_enrichment();
            default:
                return m.album_merge_policy_survivor();
        }
    }
</script>

<div class={hideTrigger && !open ? 'hidden' : 'my-4'}>
    {#if !hideTrigger}<button
            class="btn btn-sm variant-soft-primary"
            disabled={busy}
            onclick={() => (open = !open)}>{m.album_merge_open()}</button
        >{/if}
    {#if open}
        <section
            bind:this={panel}
            class="mt-3 space-y-4 rounded-lg border border-surface-600 p-4"
            aria-label={m.album_merge_open()}>
            <button
                type="button"
                class="btn btn-sm"
                disabled={busy}
                onclick={() => void loadCompilation()}>{m.music_compilation_preview()}</button>
            {#if compilation}
                <div class="space-y-2 rounded border border-surface-600 p-3 text-sm">
                    <p>{m.music_compilation_preview_help()}</p>
                    {#if compilation.truncated}<p>{m.music_compilation_truncated()}</p>{/if}
                    {#if !compilation.groups.length}<p>{m.music_compilation_none()}</p>{/if}
                    {#if compilation.skipped.length}<p>
                            {m.music_compilation_skipped({
                                count: String(
                                    compilation.skipped.reduce(
                                        (n, row) => n + row.albumIds.length,
                                        0,
                                    ),
                                ),
                            })}
                        </p>{/if}
                    {#each compilation.groups as group, index (index)}
                        <ul>
                            {#each group.albums as album (album.id)}
                                <li>
                                    <a
                                        class="text-primary-300 underline"
                                        href={resolve(`/admin/library/media/${album.id}`)}
                                        >{album.title}</a>
                                    · {album.artistTitle ?? '—'}
                                </li>
                            {/each}
                        </ul>
                        <p>{m.music_compilation_tracks({ count: String(group.trackCount) })}</p>
                    {/each}
                </div>
            {/if}

            <form
                class="flex flex-wrap gap-2"
                onsubmit={(event) => {
                    event.preventDefault();
                    void search();
                }}>
                <input
                    bind:this={searchField}
                    class="input min-w-0 flex-1"
                    aria-label={m.album_merge_search()}
                    placeholder={m.album_merge_search()}
                    bind:value={query}
                    disabled={busy}
                    maxlength="200" />
                <button
                    class="btn btn-sm variant-soft-primary"
                    disabled={busy || query.trim().length < 2}>{m.album_merge_search()}</button>
            </form>
            {#if targets.length}
                <ul class="space-y-2">
                    {#each targets as target (target.id)}
                        <li>
                            <button
                                class="btn btn-sm variant-soft-surface"
                                disabled={busy}
                                onclick={() => {
                                    overrideLocks = false;
                                    void loadPreview(target.id);
                                }}
                                >{target.title} · {target.parentTitle ?? ''} · {target.id.slice(
                                    0,
                                    8,
                                )}</button>
                        </li>
                    {/each}
                </ul>
            {/if}
            {#if busy}<p role="status">{m.album_merge_loading()}</p>{/if}
            {#if error}
                <p role="alert" class="text-error-400">{error}</p>
                {#if targetId}<button
                        class="btn btn-sm variant-soft-primary"
                        disabled={busy}
                        onclick={() => loadPreview(targetId, survivorId)}
                        >{m.album_merge_preview()}</button
                    >{/if}
            {/if}
            {#if preview}
                <div class="space-y-2 break-words text-sm">
                    <p>
                        {m.music_merge_kept({
                            title: preview.survivor.title,
                            id: preview.survivor.id,
                            count: preview.survivor.trackCount,
                            owner: preview.survivor.parentTitle ?? '—',
                        })}
                    </p>
                    <p>
                        {m.music_merge_removed({
                            title: preview.removed.title,
                            id: preview.removed.id,
                            count: preview.removed.trackCount,
                            owner: preview.removed.parentTitle ?? '—',
                        })}
                    </p>
                    <p>{m.music_merge_effects()}</p>
                    <p>{m.music_merge_recovery()}</p>
                </div>
                <label class="label">
                    <span>{m.album_merge_survivor()}</span>
                    <select
                        class="select"
                        value={preview.keepId}
                        disabled={busy}
                        onchange={(event) => loadPreview(targetId, event.currentTarget.value)}>
                        <option value={preview.survivor.id}
                            >{preview.survivor.title} · {preview.survivor.createdAt.slice(0, 10)} · {preview
                                .survivor.trackCount} · {preview.survivor.id.slice(0, 8)}</option>
                        <option value={preview.removed.id}
                            >{preview.removed.title} · {preview.removed.createdAt.slice(0, 10)} · {preview
                                .removed.trackCount} · {preview.removed.id.slice(0, 8)}</option>
                    </select>
                </label>
                <p class="break-words">
                    {m.album_merge_parent({ artist: preview.parentArtist.title })}
                </p>
                <p>
                    {m.album_merge_tracks({
                        count: preview.trackCount,
                        total: preview.resultingTrackCount,
                    })}
                </p>
                <details>
                    <summary>{m.album_merge_track_list()}</summary>
                    <ul>
                        {#each preview.tracksToMove as track (track.id)}<li>
                                {track.disc ?? '–'}/{track.number ?? '–'} · {track.title} · {track.id}
                            </li>{/each}
                    </ul>
                </details>
                <p>{m.album_merge_duplicates({ count: preview.duplicateCandidates.length })}</p>
                {#if preview.duplicateCandidates.length}<ul>
                        {#each preview.duplicateCandidates as candidate (`${candidate.movingTrackId}:${candidate.survivorTrackId}`)}
                            <li>
                                {candidate.title} · {candidate.movingTrackId} / {candidate.survivorTrackId}
                            </li>
                        {/each}
                    </ul>{/if}
                <p>{m.album_merge_metadata()}</p>
                <details>
                    <summary>{m.album_merge_image_changes()}</summary>
                    <ul>
                        {#each preview.selectedImages as image (image.role)}<li>
                                {image.role}: {image.sourceUrl ?? '–'} → {image.resultUrl ?? '–'}
                            </li>{/each}
                    </ul>
                </details>
                <p>
                    {m.album_merge_metadata_keys({
                        filled: preview.metadataKeys.filled.join(', ') || '–',
                        conflicts: preview.metadataKeys.conflicts.join(', ') || '–',
                    })}
                </p>
                <ul class="text-sm space-y-1">
                    {#each preview.albumData.filter((d) => d.sourceCount > 0) as data (data.table)}
                        <li>
                            {referenceLabel(data.table)}: {data.sourceCount} → {policyLabel(
                                data.policy,
                            )}
                        </li>
                    {/each}
                </ul>
                {#if preview.locks.requiresOverride}
                    <label class="flex items-center gap-2"
                        ><input
                            type="checkbox"
                            class="checkbox"
                            checked={overrideLocks}
                            disabled={busy}
                            onchange={(event) => {
                                overrideLocks = event.currentTarget.checked;
                                void loadPreview(targetId, survivorId);
                            }} />{m.album_merge_override()}</label>
                {/if}
                <p>{m.album_merge_lock_policy()}</p>
                <p>{m.album_merge_confirm_description({ album: preview.removed.title })}</p>
                <label class="flex items-start gap-2"
                    ><input
                        type="checkbox"
                        bind:checked={acknowledged}
                        disabled={busy} />{m.music_merge_ack()}</label>
                <label class="block"
                    >{m.music_merge_type_title()}<input
                        class="input mt-1 w-full"
                        aria-label={m.music_merge_type_title()}
                        bind:value={confirmationTitle}
                        disabled={busy} /></label>
                <button
                    class="btn variant-filled-warning"
                    disabled={busy ||
                        !acknowledged ||
                        confirmationTitle !== preview.removed.title ||
                        (preview.locks.requiresOverride && !overrideLocks)}
                    onclick={apply}>{m.album_merge_confirm()}</button>
            {/if}
            <button type="button" class="btn btn-sm" onclick={cancel}>{m.common_cancel()}</button>
        </section>
    {/if}
</div>
