<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
     SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
    import { onMount, untrack } from 'svelte';
    import { SvelteMap, SvelteSet } from 'svelte/reactivity';
    import { page } from '$app/stores';
    import * as m from '$lib/paraglide/messages.js';
    import { get } from 'svelte/store';
    import { resolve } from '$lib/paths';
    import { getMusicSmartMixes, getMusicClusters, getMusicClusterMembers } from '$lib/api/music';
    import { musicTrackFromCard } from '$lib/utils/music-track';
    import type { MusicTrack } from '$lib/schemas/music';
    import type { MusicCluster } from '$lib/schemas/api-music-responses';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import { toasts } from '$lib/stores/toast.store';
    import { openMusicPreview, closeMusicPreview } from '$lib/utils/music-preview-navigation';
    import { collectionLabels } from '$lib/utils/music-mix';
    import MixPreview from './MixPreview.svelte';
    import SaveMixButton from './SaveMixButton.svelte';
    import MixCard from './MixCard.svelte';

    interface Mix {
        id: string;
        title: string;
        description: string;
        covers: string[];
        tracks?: MusicTrack[];
        cluster?: MusicCluster;
    }
    let smart = $state<Mix[]>([]);
    let collections = $state<Mix[]>([]);
    let smartLoading = $state(true);
    let collectionsLoading = $state(true);
    let smartError = $state(false);
    let collectionsError = $state(false);
    let disposed = false;
    const clustersEnabled = $derived($page.data?.features?.musicClusters === true);
    const snapshots = new SvelteMap<string, MusicTrack[]>();
    const pending = new SvelteMap<string, Promise<MusicTrack[]>>();

    async function loadSmart(): Promise<void> {
        smartLoading = true;
        smartError = false;
        try {
            const result = await getMusicSmartMixes();
            if (result.error || !result.data) throw new Error('mixes unavailable');
            if (disposed) return;
            smart = result.data.sections
                .map((section): Mix => {
                    const seen = new SvelteSet<string>();
                    const tracks = section.items.flatMap((item): MusicTrack[] => {
                        const id = item.id;
                        if (!id || seen.has(id)) return [];
                        seen.add(id);
                        return [
                            musicTrackFromCard({
                                id,
                                title: item.title,
                                artists: [{ id: null, title: item.subtitle ?? '' }],
                                // Keep the card's artwork: the mix cover and the preview rows use it.
                                images:
                                    item.images && !Array.isArray(item.images) ? item.images : {},
                            }),
                        ];
                    });
                    return {
                        id: section.id,
                        title: section.title ?? 'Smart Mix',
                        description: `${tracks.length} tracks`,
                        covers: [
                            ...new Set(
                                tracks.flatMap(
                                    (track) => track.images?.primary?.variants?.thumb ?? [],
                                ),
                            ),
                        ].slice(0, 4),
                        tracks,
                    };
                })
                .filter((mix) => mix.tracks?.length);
        } catch {
            if (!disposed) smartError = true;
        } finally {
            if (!disposed) smartLoading = false;
        }
    }
    async function loadCollections(): Promise<void> {
        collectionsLoading = true;
        collectionsError = false;
        try {
            const result = await getMusicClusters();
            if (result.error || !result.data) throw new Error('collections unavailable');
            if (disposed) return;
            const labels = collectionLabels(result.data.items);
            collections = result.data.items.map((cluster): Mix => {
                const cover =
                    cluster.images?.primary?.variants?.card ??
                    cluster.images?.primary?.variants?.thumb ??
                    cluster.images?.primary?.href;
                return {
                    id: String(cluster.id),
                    title: labels.get(cluster.id) ?? 'Mix',
                    description: cluster.topArtists.slice(0, 3).join(', ') ?? 'Library selection',
                    covers: cover ? [cover] : [],
                    cluster,
                };
            });
        } catch {
            if (!disposed) collectionsError = true;
        } finally {
            if (!disposed) collectionsLoading = false;
        }
    }
    onMount(() => {
        void loadSmart();
        return () => {
            disposed = true;
        };
    });
    $effect(() => {
        if (clustersEnabled) untrack(() => void loadCollections());
    });

    // Cache the resolved collection while this home view is mounted: quick play,
    // preview and save all refer to the same selection, even after Back/Forward.
    async function tracksFor(mix: Mix): Promise<MusicTrack[]> {
        if (mix.tracks) return mix.tracks;
        const cached = snapshots.get(mix.id);
        if (cached) return cached;
        const inFlight = pending.get(mix.id);
        if (inFlight) return inFlight;
        const cluster = mix.cluster;
        if (!cluster) return [];
        const request = (async (): Promise<MusicTrack[]> => {
            const result = await getMusicClusterMembers(cluster.id, 200);
            if (result.error || !result.data) throw new Error('tracks unavailable');
            const tracks = [
                ...new Map(result.data.items.map((track) => [track.id, track])).values(),
            ];
            if (tracks.length) snapshots.set(mix.id, tracks);
            return tracks;
        })();
        pending.set(mix.id, request);
        try {
            return await request;
        } finally {
            pending.delete(mix.id);
        }
    }
    const previewUrl = $derived(new URL($page.state.musicPreviewUrl ?? $page.url.href));
    const previewKey = $derived(previewUrl.searchParams.has('mix') ? 'mix' : 'collection');
    const previewId = $derived(previewUrl.searchParams.get(previewKey));
    const selected = $derived(
        (previewKey === 'mix' ? smart : collections).find((mix) => mix.id === previewId),
    );
    let previewTracks = $state<MusicTrack[]>([]);
    let previewLoading = $state(false);
    let previewError = $state<string | null>(null);
    let previewVersion = 0;
    async function loadPreview(mix: Mix): Promise<void> {
        const version = ++previewVersion;
        previewLoading = true;
        previewError = null;
        previewTracks = [];
        try {
            const tracks = await tracksFor(mix);
            if (version === previewVersion && !disposed) previewTracks = tracks;
        } catch {
            if (version === previewVersion && !disposed) previewError = 'Unable to load this mix.';
        } finally {
            if (version === previewVersion && !disposed) previewLoading = false;
        }
    }
    $effect(() => {
        const mix = selected;
        untrack(() => {
            previewVersion++;
            if (mix) void loadPreview(mix);
        });
    });
    function mixHref(mix: Mix): string {
        const key = mix.cluster ? 'collection' : 'mix';
        return resolve(`/music?${key}=${encodeURIComponent(mix.id)}`);
    }
    async function play(mix: Mix, tracks: MusicTrack[]): Promise<void> {
        await musicPlayerStore.enqueueFromBrew(tracks);
        musicPlayerStore.setPlaybackContext({
            type: 'mix',
            name: mix.title,
            trackCount: tracks.length,
            href: mixHref(mix),
        });
    }
    let starting = $state<string | null>(null);
    async function quickPlay(mix: Mix): Promise<void> {
        if (starting !== null) return;
        starting = mixHref(mix);
        const previousTrack = get(musicPlayerStore).currentTrack;
        try {
            const tracks = await tracksFor(mix);
            if (disposed || previousTrack !== get(musicPlayerStore).currentTrack) return;
            if (!tracks.length) {
                toasts.info('No accessible tracks in this mix.');
                return;
            }
            await play(mix, tracks);
        } catch {
            toasts.error('Unable to play this mix. Open its preview to retry.');
        } finally {
            starting = null;
        }
    }
</script>

{#snippet rail(
    title: string,
    subtitle: string,
    mixes: Mix[],
    loading: boolean,
    error: boolean,
    retry: () => Promise<void>,
    isCollection = false,
)}
    {#if loading || error || mixes.length}
        <section aria-label={title} class="mix-section">
            <header>
                <div>
                    <h2>{title}</h2>
                    <p>{subtitle}</p>
                </div>
                {#if isCollection}<a href={resolve('/music/collections')}>View all</a>{/if}
            </header>
            {#if loading}
                <div class="mix-rail" role="status" aria-label="Loading {title}">
                    {#each [0, 1, 2, 3] as placeholder (placeholder)}<div
                            class="skeleton"
                            aria-hidden="true">
                        </div>{/each}
                </div>
            {:else if error}
                <p role="alert">
                    Unable to load {title.toLowerCase()}.
                    <button class="retry" onclick={retry}>Retry</button>
                </p>
            {:else}
                <ul class="mix-rail">
                    {#each mixes as mix (mix.id)}
                        <li class="rail-item">
                            <MixCard
                                title={mix.title}
                                detail={mix.description}
                                covers={mix.covers}
                                playing={starting === mixHref(mix)}
                                playDisabled={starting !== null}
                                onopen={() =>
                                    openMusicPreview(mix.cluster ? 'collection' : 'mix', mix.id)}
                                onplay={() => quickPlay(mix)} />
                        </li>
                    {/each}
                </ul>
            {/if}
        </section>
    {/if}
{/snippet}

{@render rail(
    m.music_smart_mixes_title(),
    m.music_smart_mixes_subtitle(),
    smart,
    smartLoading,
    smartError,
    loadSmart,
)}
{#if clustersEnabled}
    {@render rail(
        m.music_feature_collections_label(),
        m.music_library_mixes_subtitle(),
        collections,
        collectionsLoading,
        collectionsError,
        loadCollections,
        true,
    )}
{/if}
{#if selected}
    {#key `${previewKey}:${selected.id}`}
        <MixPreview
            title={selected.title}
            tracks={previewTracks}
            total={selected.cluster?.trackCount}
            description={selected.cluster
                ? m.music_library_mixes_subtitle()
                : m.music_smart_mixes_subtitle()}
            loading={previewLoading}
            error={previewError}
            onclose={() => closeMusicPreview(previewKey)}
            onretry={() => selected && void loadPreview(selected)}
            onplay={(tracks) => (selected ? play(selected, tracks) : Promise.resolve())}>
            <SaveMixButton title={selected.title} tracks={previewTracks} />
        </MixPreview>
    {/key}
{:else if previewId && !(previewKey === 'mix' ? smartLoading || smartError : collectionsLoading || collectionsError)}
    <MixPreview
        title="Mix unavailable"
        tracks={[]}
        error="This mix is no longer available."
        onclose={() => closeMusicPreview(previewKey)}
        onretry={previewKey === 'mix' ? loadSmart : loadCollections} />
{/if}

<style>
    .mix-section {
        min-width: 0;
        margin-block: 1.5rem;
    }
    header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        margin-bottom: 1rem;
    }
    h2 {
        font-size: 1.2rem;
        font-weight: 700;
        color: #f1f5f9;
    }
    p {
        color: #94a3b8;
        font-size: 0.85rem;
    }
    header a {
        flex-shrink: 0;
        color: #c4b5fd;
        min-height: 44px;
        display: flex;
        align-items: center;
    }
    .mix-rail {
        display: flex;
        gap: 1rem;
        overflow-x: auto;
        padding: 0.25rem 0.25rem 0.75rem;
        scroll-snap-type: x proximity;
    }
    .rail-item,
    .skeleton {
        flex: 0 0 10.5rem;
        min-width: 0;
        scroll-snap-align: start;
    }
    button:focus-visible,
    a:focus-visible {
        outline: 2px solid #c4b5fd;
        outline-offset: 3px;
    }
    .retry {
        padding: 0.5rem;
        text-decoration: underline;
        min-height: 44px;
    }
    .skeleton {
        height: 14rem;
        background: #1e293b;
        border-radius: 0.75rem;
    }
    @media (min-width: 1024px) {
        .rail-item,
        .skeleton {
            flex-basis: 12rem;
        }
    }
</style>
