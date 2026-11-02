<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
     SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
    type Episode = { id: string; name: string; seasonNumber: number; episodeNumber: number };
    let {
        onaddEpisode,
        onaddSeason,
        playlistEpisodeKeys,
        onback,
    }: {
        onaddEpisode: (episode: Episode) => void;
        onaddSeason: (detail: { season: { seasonNumber: number }; episodes: Episode[] }) => void;
        playlistEpisodeKeys: Set<string>;
        onback: () => void;
    } = $props();
    const episodes: Episode[] = [1, 2, 3].map((number) => ({
        id: String(number),
        name: `Episode ${number}`,
        seasonNumber: 1,
        episodeNumber: number,
    }));
</script>

<button type="button" onclick={() => onaddSeason({ season: { seasonNumber: 1 }, episodes })}
    >Add season</button>
<button type="button" onclick={onback}>Back to results</button>
{#each episodes as episode (episode.id)}
    <button type="button" onclick={() => onaddEpisode(episode)}>Add {episode.name}</button>
    {#if playlistEpisodeKeys.has(`1:${episode.episodeNumber}`)}<span>Confirmed {episode.name}</span
        >{/if}
{/each}
