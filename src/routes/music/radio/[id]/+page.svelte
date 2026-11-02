<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { onMount } from 'svelte';
    import type { RadioNowPlaying } from '$lib/schemas/radio';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import { musicTrackFromCard } from '$lib/utils/music-track';
    import type { MusicTrack } from '$lib/schemas/music';
    import { getRadioNowPlaying } from '$lib/api/music.js';

    type Props = {
        data: {
            station: {
                id: string;
                type: 'radio';
                name: string;
                genre?: string;
                images?: {
                    poster: { href: string; thumb: string; card: string; full: string };
                    backdrop: { href: string; card: string; wide: string; full: string };
                };
                description?: string;
            };
            nowPlaying: RadioNowPlaying;
        };
    };
    let { data }: Props = $props();

    let np = $derived(data.nowPlaying);
    let polling = $state(true);
    let pollVersion = 0;

    async function poll(): Promise<void> {
        if (!polling) return;
        const stationId = data.station.id;
        const version = ++pollVersion;
        const { data: envelope } = await getRadioNowPlaying(stationId);
        if (envelope && version === pollVersion && stationId === data.station.id) np = envelope;
    }

    onMount(() => {
        const iv = setInterval(poll, 20_000);
        const onVis = (): void => {
            polling = !document.hidden;
            if (polling) void poll();
        };
        document.addEventListener('visibilitychange', onVis);
        return () => {
            pollVersion++;
            clearInterval(iv);
            document.removeEventListener('visibilitychange', onVis);
        };
    });

    function play(): void {
        const track: MusicTrack = musicTrackFromCard({
            id: data.station.id,
            title: data.station.name,
            artists: [{ id: null, title: data.station.genre ?? 'Internet Radio' }],
            images: data.station.images
                ? {
                      primary: {
                          href: data.station.images.poster.href,
                          revision: '1',
                          source: 'self',
                          variants: {
                              thumb: data.station.images.poster.thumb,
                              card: data.station.images.poster.card,
                              full: data.station.images.poster.full,
                          },
                      },
                      backdrop: {
                          href: data.station.images.backdrop.href,
                          revision: '1',
                          source: 'self',
                          variants: {
                              card: data.station.images.backdrop.card,
                              wide: data.station.images.backdrop.wide,
                              full: data.station.images.backdrop.full,
                          },
                      },
                  }
                : {},
            type: 'track',
            isRadio: true,
        });
        musicPlayerStore.play(track);
    }

    const elapsedLabel = $derived.by(() => {
        const d = np.track.durationMs;
        const e = np.track.elapsedMs;
        if (d === undefined || e === undefined) return null;
        const fmt = (s: number): string =>
            `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        return `${fmt(Math.floor(e / 1000))} / ${fmt(Math.floor(d / 1000))}`;
    });
</script>

<div class="mx-auto max-w-3xl p-4">
    <div class="flex flex-col gap-4 rounded-xl bg-surface-50 p-6 dark:bg-surface-900">
        {#if np.show.imageUrl || data.station.images?.poster?.card}
            <img
                src={np.show.imageUrl ?? data.station.images?.poster?.card}
                alt={data.station.name}
                class="h-48 w-full rounded-lg object-cover transition-opacity duration-150" />
        {/if}
        <h1 class="text-2xl font-bold">{data.station.name}</h1>

        {#if np.track.title}
            <section>
                <p class="text-xs uppercase text-surface-500">
                    {m.music_now_playing_label()}
                </p>
                <p class="text-xl font-semibold">{np.track.title}</p>
                {#if np.track.artist}
                    <p class="text-surface-600 dark:text-surface-400">
                        {np.track.artist}
                    </p>
                {/if}
                {#if elapsedLabel}
                    <p class="text-xs text-surface-500">{elapsedLabel}</p>
                {/if}
            </section>
        {/if}

        {#if np.dj.name}
            <section class="flex items-center gap-2">
                {#if np.dj.imageUrl}
                    <img src={np.dj.imageUrl} alt="" class="h-8 w-8 rounded-full" />
                {/if}
                <span>
                    <span class="text-xs uppercase text-surface-500">{m.music_on_air()}</span>
                    <span class="ml-1">{np.dj.name}</span>
                </span>
            </section>
        {/if}

        {#if np.show.name}
            <section>
                <p class="font-medium">{np.show.name}</p>
                {#if np.show.description}
                    <p class="text-xs text-surface-500">
                        {np.show.description}
                    </p>
                {/if}
            </section>
        {/if}

        {#if np.upNext.title}
            <section>
                <p class="text-xs uppercase text-surface-500">{m.music_up_next()}</p>
                <p>
                    {np.upNext.artist ? `${np.upNext.artist} – ` : ''}{np.upNext.title}
                </p>
            </section>
        {/if}

        {#if np.source === 'icy'}
            <p class="text-xs text-surface-400">ICY fallback</p>
        {/if}

        <button class="variant-filled-primary btn" onclick={play}>▶ Play</button>
    </div>
</div>
