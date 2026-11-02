<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
     SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
    import { SvelteSet, SvelteMap } from 'svelte/reactivity';
    import type { MusicTrack } from '$lib/schemas/music';
    import { createPlaylist, addItem, reorderItems } from '$lib/api/playlists';
    import { resolve } from '$lib/paths';
    import { toasts } from '$lib/stores/toast.store';

    let { title, tracks }: { title: string; tracks: MusicTrack[] } = $props();
    let saving = $state(false);
    let playlistId = $state<number | null>(null);
    let snapshot = $state<MusicTrack[]>([]);
    const added = new SvelteSet<string>();
    const entries = new SvelteMap<string, number>();
    let revision = 0;
    let needsOrder = $state(false);
    const complete = $derived(snapshot.length > 0 && added.size === snapshot.length && !needsOrder);

    async function save(): Promise<void> {
        if (saving || complete || !tracks.length) return;
        saving = true;
        try {
            if (playlistId === null) {
                // Freeze the displayed order, including when a request later needs retrying.
                snapshot = [...new Map(tracks.map((track) => [track.id, track])).values()];
                const result = await createPlaylist({
                    name: title,
                    description:
                        'Saved mix selection. This playlist does not update automatically.',
                    visibility: 'private',
                    playlistType: 'music',
                });
                if (result.error || !result.data) throw new Error('create failed');
                playlistId = result.data.id;
            }
            const pending = snapshot.filter((track) => !added.has(track.id));
            for (let offset = 0; offset < pending.length; offset += 500) {
                const chunk = pending.slice(offset, offset + 500);
                const result = await addItem(playlistId, {
                    mediaIds: chunk.map((track) => track.id),
                });
                if (result.error || !result.data) {
                    needsOrder = true; // The response may have been lost after the write committed.
                    throw new Error('add failed');
                }
                revision = result.data.summary.revision;
                let rejected = false;
                for (const outcome of result.data.results) {
                    const entry = outcome.entries[0];
                    if (outcome.status === 'rejected' || !entry) {
                        rejected = true;
                        continue;
                    }
                    added.add(outcome.mediaId);
                    entries.set(outcome.mediaId, entry.id);
                }
                if (rejected) {
                    needsOrder = true;
                    throw new Error('Some tracks were rejected');
                }
            }
            if (needsOrder) {
                const result = await reorderItems(playlistId, {
                    expectedRevision: revision,
                    entryIds: snapshot.map((track) => entries.get(track.id)!),
                });
                if (result.error) throw new Error('Unable to restore mix order');
                needsOrder = false;
            }
            toasts.success(`Saved ${added.size} tracks as a private playlist.`);
        } catch {
            toasts.error(
                playlistId === null
                    ? 'Unable to create the playlist. Please try again.'
                    : `Saved ${added.size} of ${snapshot.length} tracks. Retry to finish this playlist.`,
            );
        } finally {
            saving = false;
        }
    }
</script>

<button
    class="min-h-11 rounded-lg border border-surface-600 px-3 py-2"
    disabled={saving || complete || !tracks.length}
    onclick={save}>
    {saving
        ? 'Saving…'
        : complete
          ? 'Saved'
          : playlistId !== null
            ? 'Retry saving'
            : 'Save as playlist'}
</button>
{#if playlistId !== null && !saving}
    <a class="underline" href={resolve(`/playlists/${playlistId}?type=music&from=music`)}
        >Open saved playlist</a>
{/if}
