<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
    import { untrack, onDestroy } from 'svelte';
    import type { MusicEditReceipt } from '$lib/schemas/music-credit-review.js';
    import { readMusicEdits, restoreMusicEdit } from '$lib/api/music-credits.js';
    import * as m from '$lib/paraglide/messages.js';
    let {
        mediaId,
        refreshKey = '',
        onsaved,
        disabled = false,
    }: {
        mediaId: string;
        refreshKey?: string | number;
        onsaved?: () => void | Promise<void>;
        disabled?: boolean;
    } = $props();
    let edits = $state<MusicEditReceipt[]>([]);
    let busy = $state(false);
    let error = $state('');
    let message = $state('');
    let generation = 0;
    let targetEpoch = 0;
    let activeId = '';
    let disposed = false;
    onDestroy(() => {
        disposed = true;
        generation++;
        targetEpoch++;
    });
    async function load(): Promise<void> {
        const token = ++generation;
        const id = mediaId;
        try {
            const result = await readMusicEdits(id);
            if (disposed || token !== generation || id !== mediaId) return;
            if (result.data) edits = result.data.edits;
            else error = m.music_edit_history_failed();
        } catch {
            if (!disposed && token === generation && id === mediaId)
                error = m.music_edit_history_failed();
        }
    }
    $effect(() => {
        const id = mediaId;
        const key = refreshKey;
        untrack(() => {
            if (activeId !== id) {
                activeId = id;
                targetEpoch++;
                busy = false;
            }
            void key;
            edits = [];
            error = '';
            message = '';
            void load();
        });
    });
    async function undo(id: string): Promise<void> {
        if (busy || disabled) return;
        const target = mediaId;
        const epoch = targetEpoch;
        busy = true;
        error = '';
        message = '';
        try {
            const result = await restoreMusicEdit(target, id);
            if (disposed || target !== mediaId || epoch !== targetEpoch) return;
            if (!result.data) {
                error =
                    result.status === 409 ? m.music_edit_conflict() : m.music_edit_undo_failed();
                return;
            }
            await onsaved?.();
            if (disposed || target !== mediaId || epoch !== targetEpoch) return;
            await load();
            if (disposed || target !== mediaId || epoch !== targetEpoch) return;
            message = m.music_edit_restored();
        } catch {
            if (!disposed && target === mediaId && epoch === targetEpoch)
                error = m.music_edit_undo_failed();
        } finally {
            if (!disposed && target === mediaId && epoch === targetEpoch) busy = false;
        }
    }
</script>

{#if error}<p role="alert" class="text-sm text-amber-200">{error}</p>{/if}
{#if message}<p role="status" class="text-sm text-green-300">{message}</p>{/if}
{#if edits.some((edit) => !edit.undone)}
    <details class="text-sm text-surface-300">
        <summary class="cursor-pointer">{m.music_edit_history()}</summary>
        <p class="my-2 text-xs">{m.music_edit_undo_help()}</p>
        <ul class="space-y-2">
            {#each edits.filter((edit) => !edit.undone) as edit (edit.id)}
                <li class="flex flex-wrap items-center gap-3">
                    <span
                        >{edit.kind === 'album-artist'
                            ? m.music_edit_album_artist()
                            : edit.kind === 'hierarchy'
                              ? m.music_edit_hierarchy()
                              : edit.kind === 'title'
                                ? m.music_edit_title()
                                : m.music_edit_credits()} · {edit.createdAt}</span>
                    <button
                        type="button"
                        class="btn btn-sm"
                        disabled={busy || disabled}
                        onclick={() => void undo(edit.id)}>{m.music_edit_undo()}</button>
                </li>
            {/each}
        </ul>
    </details>
{/if}
