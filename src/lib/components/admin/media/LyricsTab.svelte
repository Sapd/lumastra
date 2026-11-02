<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, ArrowPath } from 'svelte-hero-icons';
    import { beforeNavigate } from '$app/navigation';
    import { toasts } from '$lib/stores/toast.store';
    import {
        getAdminCustomMetadata,
        updateAdminCustomMetadata,
        undoAdminCuratedOutput,
    } from '$lib/api/admin';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        mediaId: string;
        onsaved?: () => void;
    }

    let { mediaId, onsaved }: Props = $props();

    type TabMode = 'plain' | 'synced' | 'edit';

    /**
     * `custom_metadata.lyrics` as every writer stores it (lyrics.service,
     * lyrics-fetch, the user lyrics endpoint): an object, not a string. The
     * player's lyrics endpoint ignores anything else, so the editor must read
     * and write this shape.
     */
    interface StoredLyrics {
        plain: string | null;
        synced: string | null;
        source: string | null;
    }

    let lyrics = $state<string | null>(null);
    let syncedLyrics = $state<string | null>(null);
    let lyricsSource = $state<string | null>(null);
    let loading = $state(true);
    let fetching = $state(false);
    let saving = $state(false);
    let undoId = $state<string | undefined>();
    let activeTab = $state<TabMode>('plain');
    let editValue = $state('');
    let dirty = $derived(editValue !== (lyrics ?? ''));

    interface LrcLine {
        time: string;
        text: string;
    }

    function parseLrc(lrc: string): LrcLine[] {
        return lrc
            .split('\n')
            .map((line) => {
                const match = line.match(/^\[(\d{2}:\d{2}\.\d{2,3})\](.*)$/);
                if (!match) return null;
                return { time: match[1], text: match[2].trim() };
            })
            .filter((x): x is LrcLine => x !== null);
    }

    let parsedSyncedLines = $derived(syncedLyrics ? parseLrc(syncedLyrics) : []);

    let hasLyrics = $derived(
        (lyrics !== null && lyrics.length > 0) ||
            (syncedLyrics !== null && syncedLyrics.length > 0),
    );

    function sourceBadgeClass(source: string | null): string {
        switch (source) {
            case 'embedded':
                return 'bg-blue-500/20 text-blue-400';
            case 'lrclib':
                return 'bg-emerald-500/20 text-emerald-400';
            case 'user':
                return 'bg-amber-500/20 text-amber-400';
            default:
                return 'bg-surface-700/40 text-surface-400';
        }
    }

    function str(value: unknown): string | null {
        return typeof value === 'string' ? value : null;
    }

    /** Reads the stored object; a bare string (older manual saves) counts as plain lyrics. */
    function readStoredLyrics(raw: unknown): StoredLyrics {
        if (typeof raw === 'string') return { plain: raw, synced: null, source: 'user' };
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            const obj = raw as Record<string, unknown>;
            return { plain: str(obj.plain), synced: str(obj.synced), source: str(obj.source) };
        }
        return { plain: null, synced: null, source: null };
    }

    $effect(() => {
        const id = mediaId;
        lyrics = null;
        syncedLyrics = null;
        lyricsSource = null;
        editValue = '';
        activeTab = 'plain';
        void loadMetadata(id);
    });

    beforeNavigate(({ cancel, willUnload }) => {
        if (!dirty) return;
        // A page unload only gets the browser's own prompt; cancel() triggers it.
        if (willUnload || !window.confirm(m.media_lyrics_unsaved_confirm())) cancel();
    });

    async function loadMetadata(id: string): Promise<void> {
        loading = true;
        try {
            const { data, error } = await getAdminCustomMetadata(id);
            // A response for an item we already left must not land in this one.
            if (id !== mediaId) return;
            if (error || !data) {
                toasts.error(m.media_lyrics_load_failed());
                return;
            }
            undoId = data.undoIds?.lyrics;
            const stored = readStoredLyrics(data.custom_metadata.lyrics);
            lyrics = stored.plain;
            syncedLyrics = stored.synced;
            lyricsSource = stored.source;
            editValue = lyrics ?? '';
        } catch {
            if (id === mediaId) toasts.error(m.media_lyrics_load_failed());
        } finally {
            if (id === mediaId) loading = false;
        }
    }

    async function fetchFromLrclib(): Promise<void> {
        if (fetching || saving) return;
        // The fetch replaces the stored lyrics and reloads the editor.
        if (dirty && !window.confirm(m.media_lyrics_unsaved_confirm())) return;
        const id = mediaId;
        fetching = true;
        try {
            const res = await fetch(`/api/admin/media/${id}/lyrics-fetch`, {
                method: 'POST',
            });
            if (res.status === 404) {
                toasts.error(m.media_lyrics_fetch_not_found());
                return;
            }
            if (!res.ok) {
                toasts.error(m.media_lyrics_fetch_failed());
                return;
            }
            toasts.success(m.media_lyrics_fetch_success());
            if (id === mediaId) await loadMetadata(id);
        } catch {
            toasts.error(m.media_lyrics_fetch_failed());
        } finally {
            fetching = false;
        }
    }

    /**
     * Saves the edited text as the plain lyrics and drops the synced (timed)
     * lyrics: every player shows synced lyrics whenever they exist, so keeping
     * them made a plain edit invisible. Only what was sent is marked saved, so
     * text typed while the request runs stays dirty.
     */
    async function saveLyrics(): Promise<void> {
        if (saving || fetching) return;
        const id = mediaId;
        const sent = editValue;
        saving = true;
        let saved = false;
        try {
            const { data, error } = await updateAdminCustomMetadata(id, {
                lyrics: {
                    plain: sent,
                    synced: null,
                    source: 'user',
                    fetchedAt: new Date().toISOString(),
                },
            });
            if (error || !data) {
                toasts.error(m.media_lyrics_save_failed());
            } else {
                saved = true;
                if (id === mediaId) undoId = data.undoId;
                if (id === mediaId) {
                    lyrics = sent;
                    syncedLyrics = null;
                    lyricsSource = 'user';
                }
                toasts.success(m.media_lyrics_save_success());
            }
        } catch {
            toasts.error(m.media_lyrics_save_failed());
        } finally {
            saving = false;
        }
        if (saved) onsaved?.();
    }

    function setTab(tab: TabMode): void {
        activeTab = tab;
    }
    async function undoOutput(): Promise<void> {
        if (!undoId || saving || fetching) return;
        const id = mediaId;
        saving = true;
        try {
            const result = await undoAdminCuratedOutput(id, 'lyrics', undoId);
            if (id !== mediaId) return;
            if (!result.data) {
                toasts.error(result.error ?? m.media_p5_undo_conflict());
                return;
            }
            await loadMetadata(id);
            onsaved?.();
        } catch {
            if (id === mediaId) toasts.error(m.media_p5_undo_conflict());
        } finally {
            if (id === mediaId) saving = false;
        }
    }
</script>

<div class="space-y-4">
    {#if undoId}<button
            type="button"
            class="btn btn-sm variant-ghost-surface"
            disabled={saving || fetching || dirty}
            onclick={undoOutput}>{m.media_p5_undo_lyrics()}</button
        >{/if}
    {#if loading}
        <div class="flex items-center gap-2 text-surface-400 text-sm">
            <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
            <span>{m.media_lyrics_loading()}</span>
        </div>
    {:else}
        <!-- Source badge -->
        {#if lyricsSource}
            <div class="flex items-center gap-2">
                <span class="text-surface-400 text-xs">{m.media_lyrics_source_label()}</span>
                <span class="px-2 py-0.5 text-xs rounded-full {sourceBadgeClass(lyricsSource)}">
                    {lyricsSource}
                </span>
            </div>
        {/if}

        {#if hasLyrics || activeTab === 'edit'}
            <!-- Tab buttons -->
            <div class="flex items-center gap-1">
                <button
                    type="button"
                    onclick={() => setTab('plain')}
                    class="px-3 py-1.5 rounded text-sm font-medium transition-colors {activeTab ===
                    'plain'
                        ? 'bg-primary-500/15 text-primary-400'
                        : 'text-surface-400 hover:text-surface-200 hover:bg-surface-700/40'}">
                    {m.media_lyrics_tab_plain()}
                </button>
                {#if syncedLyrics}
                    <button
                        type="button"
                        onclick={() => setTab('synced')}
                        class="px-3 py-1.5 rounded text-sm font-medium transition-colors {activeTab ===
                        'synced'
                            ? 'bg-primary-500/15 text-primary-400'
                            : 'text-surface-400 hover:text-surface-200 hover:bg-surface-700/40'}">
                        {m.media_lyrics_tab_synced()}
                    </button>
                {/if}
                <button
                    type="button"
                    onclick={() => setTab('edit')}
                    class="px-3 py-1.5 rounded text-sm font-medium transition-colors {activeTab ===
                    'edit'
                        ? 'bg-primary-500/15 text-primary-400'
                        : 'text-surface-400 hover:text-surface-200 hover:bg-surface-700/40'}">
                    {m.media_lyrics_tab_edit()}
                </button>
            </div>

            <!-- Content area -->
            {#if activeTab === 'plain'}
                <pre
                    class="text-surface-200 text-sm whitespace-pre-wrap font-sans leading-relaxed max-h-[60vh] overflow-y-auto">{lyrics ??
                        m.media_lyrics_empty_plain()}</pre>
            {:else if activeTab === 'synced'}
                <div class="space-y-0.5 max-h-[60vh] overflow-y-auto">
                    {#if parsedSyncedLines.length > 0}
                        {#each parsedSyncedLines as line (line.time + line.text)}
                            <div class="flex gap-3 py-0.5">
                                <span class="text-surface-500 font-mono text-xs shrink-0 w-16"
                                    >[{line.time}]</span>
                                <span class="text-surface-200 text-sm">{line.text}</span>
                            </div>
                        {/each}
                    {:else}
                        <p class="text-surface-400 text-sm">{m.media_lyrics_empty_synced()}</p>
                    {/if}
                </div>
            {:else if activeTab === 'edit'}
                {#if syncedLyrics}
                    <p class="text-xs text-warning-400">{m.media_lyrics_edit_drops_synced()}</p>
                {/if}
                <textarea
                    bind:value={editValue}
                    rows={20}
                    class="w-full bg-surface-800/60 border border-surface-700/50 rounded-lg px-3 py-2 text-surface-100 text-sm focus:border-primary-500 focus:outline-none resize-y"
                    placeholder={m.media_lyrics_edit_placeholder()}></textarea>
            {/if}

            <!-- Actions -->
            <div class="flex items-center gap-3 pt-1">
                <button
                    type="button"
                    onclick={fetchFromLrclib}
                    disabled={fetching || saving}
                    class="flex items-center gap-2 px-3 py-1.5 rounded text-sm font-medium bg-surface-700/60 hover:bg-surface-700 text-surface-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                    <Icon src={ArrowPath} class="w-4 h-4 {fetching ? 'animate-spin' : ''}" />
                    {m.media_lyrics_fetch_button()}
                </button>

                {#if activeTab === 'edit'}
                    {#if dirty}
                        <span class="text-xs text-warning-400" role="status">
                            {m.media_lyrics_unsaved()}
                        </span>
                    {/if}
                    <button
                        type="button"
                        onclick={saveLyrics}
                        disabled={saving || fetching || !dirty}
                        class="flex items-center gap-2 px-3 py-1.5 rounded text-sm font-medium bg-primary-500/20 hover:bg-primary-500/30 text-primary-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                        {saving ? m.media_lyrics_saving() : m.media_lyrics_save_button()}
                    </button>
                {/if}
            </div>
        {:else}
            <!-- Empty state -->
            <div class="flex flex-col items-center gap-4 py-10 text-center">
                <p class="text-surface-400 text-sm">{m.media_lyrics_empty_state()}</p>
                <button
                    type="button"
                    onclick={fetchFromLrclib}
                    disabled={fetching}
                    class="flex items-center gap-2 px-4 py-2 rounded text-sm font-medium bg-surface-700/60 hover:bg-surface-700 text-surface-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                    <Icon src={ArrowPath} class="w-4 h-4 {fetching ? 'animate-spin' : ''}" />
                    {m.media_lyrics_fetch_button()}
                </button>
                <button
                    type="button"
                    onclick={() => setTab('edit')}
                    class="px-4 py-2 rounded text-sm font-medium text-surface-300 hover:text-surface-100 hover:bg-surface-700/40 transition-colors">
                    {m.media_lyrics_add_manually()}
                </button>
            </div>
        {/if}
    {/if}
</div>
