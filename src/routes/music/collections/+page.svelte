<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Sonic Collections page — /music/collections
  Gated by features.musicClusters (enforced server-side by +page.server.ts).
  Lists auto-generated KMeans cluster playlists with 'save as playlist' support.
-->

<script lang="ts">
    import { untrack } from 'svelte';
    import { resolve } from '$lib/paths';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import MixPreview from '$lib/components/music/MixPreview.svelte';
    import { openMusicPreview, closeMusicPreview } from '$lib/utils/music-preview-navigation';
    import { page } from '$app/stores';
    import { Icon, QueueList } from 'svelte-hero-icons';
    import MixCard from '$lib/components/music/MixCard.svelte';
    import MusicSubpageHeader from '$lib/components/music/MusicSubpageHeader.svelte';
    import * as m from '$lib/paraglide/messages.js';
    import type { MusicTrack } from '$lib/schemas/music';
    import { toasts } from '$lib/stores/toast.store';
    import { getMusicClusters, getMusicClusterMembers } from '$lib/api/music';
    import SaveMixButton from '$lib/components/music/SaveMixButton.svelte';
    import { collectionLabels } from '$lib/utils/music-mix';
    import type { MusicCluster } from '$lib/schemas/api-music-responses';

    // =========================================================================
    // Feature gate
    // =========================================================================

    const musicClustersEnabled = $derived($page.data?.features?.musicClusters === true);

    // =========================================================================
    // State
    // =========================================================================

    let clusters = $state<MusicCluster[]>([]);
    let hasClusters = $state(false);
    let loadingClusters = $state(false);
    let clusterError = $state<string | null>(null);

    // Selected cluster for detail view
    const previewId = $derived(
        new URL($page.state.musicPreviewUrl ?? $page.url.href).searchParams.get('collection'),
    );
    const selectedCluster = $derived(
        clusters.find((cluster) => String(cluster.id) === previewId) ?? null,
    );
    let loadVersion = 0;
    $effect(() => {
        const cluster = selectedCluster;
        if (cluster) untrack(() => void loadCluster(cluster));
        else {
            untrack(() => {
                loadVersion++;
            });
            clusterTracks = [];
            tracksError = null;
        }
    });
    let clusterTracks = $state<MusicTrack[]>([]);
    let loadingTracks = $state(false);
    let tracksError = $state<string | null>(null);

    let startingCollection = $state<number | null>(null);
    async function playSelection(tracks: MusicTrack[], cluster: MusicCluster): Promise<void> {
        await musicPlayerStore.enqueueFromBrew(tracks);
        musicPlayerStore.setPlaybackContext({
            type: 'mix',
            name: displayLabel(cluster),
            trackCount: tracks.length,
            href: resolve(`/music/collections?collection=${cluster.id}`),
        });
    }
    async function quickPlay(cluster: MusicCluster): Promise<void> {
        if (startingCollection !== null) return;
        startingCollection = cluster.id;
        try {
            const result = await getMusicClusterMembers(cluster.id, 200);
            if (result.error || !result.data) {
                toasts.error('Unable to load this collection. Open its preview to retry.');
                return;
            }
            if (!result.data.items.length) {
                toasts.info('No accessible tracks in this collection.');
                return;
            }
            await playSelection(result.data.items, cluster);
        } catch {
            toasts.error('Unable to play this collection. Please try again.');
        } finally {
            startingCollection = null;
        }
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    $effect(() => {
        if (musicClustersEnabled) {
            void loadClusters();
        }
    });

    // =========================================================================
    // Data loading
    // =========================================================================

    async function loadClusters(): Promise<void> {
        loadingClusters = true;
        clusterError = null;

        try {
            const { data, error } = await getMusicClusters();
            if (error || !data) {
                clusterError = error ?? 'Failed to load collections';
                return;
            }
            clusters = data.items;
            hasClusters = data.items.length > 0;
        } catch (err) {
            clusterError =
                err instanceof Error ? err.message : 'Unexpected error loading collections';
        } finally {
            loadingClusters = false;
        }
    }

    function selectCluster(cluster: MusicCluster): void {
        openMusicPreview('collection', cluster.id);
    }

    async function loadCluster(cluster: MusicCluster): Promise<void> {
        const version = ++loadVersion;
        clusterTracks = [];
        tracksError = null;
        loadingTracks = true;

        try {
            const { data, error } = await getMusicClusterMembers(cluster.id, 200);
            if (version !== loadVersion) return;
            if (error || !data) {
                tracksError = error ?? 'Failed to load tracks';
                return;
            }
            clusterTracks = data.items;
        } catch (err) {
            if (version === loadVersion)
                tracksError =
                    err instanceof Error ? err.message : 'Unexpected error loading tracks';
        } finally {
            if (version === loadVersion) loadingTracks = false;
        }
    }

    const disambiguatedLabels = $derived(collectionLabels(clusters));

    function displayLabel(cluster: MusicCluster): string {
        return disambiguatedLabels.get(cluster.id) ?? cluster.label ?? 'Unnamed';
    }

    function formatTrackCount(n: number): string {
        return n === 1 ? '1 track' : `${n.toLocaleString()} tracks`;
    }

    function coverUrls(cluster: MusicCluster): string[] {
        const cover =
            cluster.images?.primary?.variants?.card ??
            cluster.images?.primary?.variants?.thumb ??
            cluster.images?.primary?.href;
        return cover ? [cover] : [];
    }
</script>

<svelte:head>
    <title>{m.music_feature_collections_label()}</title>
</svelte:head>

<MusicSubpageHeader title={m.music_feature_collections_label()} icon={QueueList} />

{#if musicClustersEnabled}
    <div class="collections-page">
        <p class="page-subtitle">
            {m.music_collections_intro()}
        </p>

        {#if loadingClusters}
            <div class="loading-state">
                <span class="spinner" aria-hidden="true"></span>
                <span>Loading collections…</span>
            </div>
        {:else if clusterError}
            <div class="error-banner" role="alert">
                {clusterError}<button onclick={loadClusters}>Retry</button>
            </div>
        {:else if !hasClusters}
            <div class="empty-state">
                <Icon src={QueueList} class="empty-icon" />
                <p class="empty-text">No library mixes yet.</p>
            </div>
        {:else}
            <ul class="cluster-grid" aria-label="Mixes for You">
                {#each clusters as cluster (cluster.id)}
                    <li class="cluster-item">
                        <MixCard
                            title={displayLabel(cluster)}
                            meta={formatTrackCount(cluster.trackCount)}
                            detail={cluster.topArtists?.length
                                ? cluster.topArtists.slice(0, 3).join(', ')
                                : undefined}
                            covers={coverUrls(cluster)}
                            playing={startingCollection === cluster.id}
                            playDisabled={startingCollection !== null}
                            onopen={() => selectCluster(cluster)}
                            onplay={() => quickPlay(cluster)} />
                    </li>
                {/each}
            </ul>
        {/if}
    </div>
{:else}
    <div class="gate-msg">
        <p>Library mixes are not enabled on this server.</p>
    </div>
{/if}

{#if selectedCluster}
    <MixPreview
        title={displayLabel(selectedCluster)}
        description={m.music_library_mixes_subtitle()}
        tracks={clusterTracks}
        total={selectedCluster.trackCount}
        loading={loadingTracks}
        error={tracksError}
        onplay={(tracks) =>
            selectedCluster ? playSelection(tracks, selectedCluster) : Promise.resolve()}
        onclose={() => closeMusicPreview('collection')}
        onretry={() => selectedCluster && void loadCluster(selectedCluster)}>
        {#key selectedCluster.id}
            <SaveMixButton title={displayLabel(selectedCluster)} tracks={clusterTracks} />
        {/key}
    </MixPreview>
{/if}

<style>
    .collections-page {
        max-width: 80rem;
        margin: 0 auto;
        /* top padding owned by MusicSubpageHeader — only sides + bottom here */
        padding: 1.5rem 1rem 2rem;
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
    }

    .page-subtitle {
        font-size: 0.875rem;
        color: rgb(148 163 184);
        max-width: 42rem;
        margin: 0;
    }

    /* Loading */
    .loading-state {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 3rem 1rem;
        justify-content: center;
        color: rgb(100 116 139);
        font-size: 0.875rem;
    }

    /* Error */
    .error-banner {
        padding: 0.75rem 1rem;
        border-radius: 0.5rem;
        background: rgb(127 29 29 / 0.4);
        border: 1px solid rgb(185 28 28 / 0.5);
        color: rgb(252 165 165);
        font-size: 0.875rem;
    }

    /* Empty state */
    .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.75rem;
        padding: 4rem 1rem;
        text-align: center;
        color: rgb(100 116 139);
    }
    :global(.empty-icon) {
        width: 2.5rem;
        height: 2.5rem;
        opacity: 0.4;
    }
    .empty-text {
        font-size: 0.875rem;
        margin: 0;
    }

    /* Cluster grid — MixCard owns the card look; the grid owns the width. */
    .cluster-grid {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 9.5rem), 1fr));
        gap: 1.75rem 1.25rem;
    }
    .cluster-item {
        min-width: 0;
        display: flex;
    }
    @media (min-width: 1024px) {
        .cluster-grid {
            grid-template-columns: repeat(auto-fill, minmax(min(100%, 11.5rem), 1fr));
        }
    }

    .spinner {
        width: 1.125rem;
        height: 1.125rem;
        border: 2px solid rgba(255, 255, 255, 0.2);
        border-top-color: rgb(129 140 248);
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
        display: inline-block;
        flex-shrink: 0;
    }
    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }

    /* Gate message */
    .gate-msg {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 4rem 1rem;
        color: rgb(100 116 139);
        font-size: 0.875rem;
    }
</style>
