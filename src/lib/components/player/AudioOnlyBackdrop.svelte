<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { getCatalogBackdropUrl } from '$lib/utils/image-utils';

    interface Props {
        artworkId: string;
        title: string;
        subtitle?: string;
    }
    let { artworkId, title, subtitle }: Props = $props();
    let src = $derived(getCatalogBackdropUrl(artworkId, { size: 'card' }));
</script>

<div class="audio-only-backdrop">
    {#if artworkId}
        <img {src} alt="" aria-hidden="true" />
    {/if}
    <div class="scrim"></div>
    <div class="meta">
        <h2>{title}</h2>
        {#if subtitle}<p>{subtitle}</p>{/if}
    </div>
</div>

<style>
    .audio-only-backdrop {
        position: absolute;
        inset: 0;
        overflow: hidden;
        /* Paint behind <video class="video-element"> (VideoPlayer.svelte),
           including its native <track> cue layer, instead of the reverse.
           `.video-element` is `position: relative; z-index: 1` specifically
           so both elements are positioned descendants of `.player-container`
           and compare via a normal (non-negative) z-index: this backdrop at
           stack level 0, the video at 1. No stacking context is needed on
           `.player-container` for this — negative z-index would have required
           one (and did, in an earlier version of this fix; see git history),
           which changed how `.player-container`'s children compare against
           siblings OUTSIDE it (e.g. +page.svelte's fullscreen-restore
           prompt). Keeping both values non-negative avoids that outward
           side effect entirely. */
        z-index: 0;
    }
    .audio-only-backdrop img {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }
    .scrim {
        position: absolute;
        inset: 0;
        background: linear-gradient(to top, rgba(0, 0, 0, 0.85), rgba(0, 0, 0, 0.45));
    }
    .meta {
        position: absolute;
        inset-inline: 0;
        bottom: 18%;
        text-align: center;
        color: white;
    }
    .meta h2 {
        font-size: 1.5rem;
        font-weight: 600;
        margin: 0;
    }
    .meta p {
        font-size: 0.95rem;
        opacity: 0.7;
        margin: 0.25rem 0 0;
    }
</style>
