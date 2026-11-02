<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
     SPDX-License-Identifier: AGPL-3.0-only -->
<!--
  Square-collage mix card shared by the /music rails and /music/collections.
  The card's width comes ONLY from its container (rail flex-basis or grid
  column) — `min-width: 0` plus clamped/ellipsised text keep long titles,
  artist lists and large cover images from stretching it.

  The whole card opens the preview (stretched ::after on the title button);
  the Play pill sits above that overlay so the two stay separate buttons.
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';

    let {
        title,
        detail,
        meta,
        covers,
        playing = false,
        playDisabled = false,
        playLabel,
        onopen,
        onplay,
    }: {
        title: string;
        detail?: string;
        meta?: string;
        covers: string[];
        playing?: boolean;
        playDisabled?: boolean;
        playLabel?: string;
        onopen: () => void;
        onplay: () => void;
    } = $props();

    const artwork = $derived(covers.filter(Boolean).slice(0, 4));
</script>

<div class="mix-card">
    <div class="art">
        <span class="collage" data-cover-count={artwork.length} aria-hidden="true">
            {#if artwork.length === 0}
                <span class="cover-placeholder">♫</span>
            {:else}
                {#each artwork as cover, index (index)}
                    <img src={cover} alt="" loading="lazy" />
                {/each}
            {/if}
        </span>
        <button
            type="button"
            class="quick-play"
            aria-label={playLabel ?? m.music_mix_play_aria({ title })}
            disabled={playDisabled}
            onclick={onplay}>{playing ? m.music_mix_loading() : `▶ ${m.music_mix_play()}`}</button>
    </div>
    <button
        type="button"
        class="open"
        aria-label={m.music_mix_open_aria({ title })}
        onclick={onopen}>
        <strong>{title}</strong>
    </button>
    {#if meta}<span class="line meta">{meta}</span>{/if}
    {#if detail}<span class="line detail" title={detail}>{detail}</span>{/if}
</div>

<style>
    .mix-card {
        position: relative;
        display: flex;
        flex-direction: column;
        min-width: 0;
        width: 100%;
    }
    .mix-card:hover .collage {
        filter: brightness(1.1);
        transform: translateY(-2px);
    }
    .art {
        position: relative;
    }
    .collage {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        grid-template-rows: repeat(2, minmax(0, 1fr));
        aspect-ratio: 1;
        width: 100%;
        overflow: hidden;
        border-radius: 0.75rem;
        background: #312e81;
        box-shadow: 0 6px 20px rgb(0 0 0 / 0.35);
        transition:
            filter 0.15s,
            transform 0.15s;
    }
    .collage[data-cover-count='0'],
    .collage[data-cover-count='1'] {
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: minmax(0, 1fr);
    }
    .collage[data-cover-count='2'] {
        grid-template-rows: minmax(0, 1fr);
    }
    .collage[data-cover-count='3'] img:first-child {
        grid-row: span 2;
    }
    @media (prefers-reduced-motion: reduce) {
        .mix-card:hover .collage {
            transform: none;
        }
    }
    .collage img,
    .cover-placeholder {
        width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
        object-fit: cover;
        display: block;
    }
    .cover-placeholder {
        display: grid;
        place-items: center;
        color: #c4b5fd;
        font-size: 3rem;
        background: linear-gradient(135deg, #312e81, #0f172a);
    }
    /* Stretched hit area: the title button covers the whole card. */
    .open {
        position: static;
        display: block;
        width: 100%;
        min-width: 0;
        margin-top: 0.6rem;
        padding: 0;
        text-align: left;
        color: inherit;
        background: none;
        border: 0;
    }
    .open::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 0.75rem;
    }
    strong {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        overflow-wrap: anywhere;
        font-size: 0.95rem;
        line-height: 1.3rem;
        min-height: 2.6rem;
        font-weight: 600;
        color: #f1f5f9;
    }
    .line {
        display: block;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: 0.8rem;
        color: #94a3b8;
    }
    .meta {
        color: #64748b;
        font-size: 0.75rem;
    }
    .quick-play {
        position: absolute;
        right: 0.5rem;
        bottom: 0.5rem;
        z-index: 1;
        min-height: 44px;
        padding: 0.5rem 0.9rem;
        border-radius: 2rem;
        color: white;
        font-size: 0.875rem;
        font-weight: 600;
        background: #0f172ae8;
        border: 1px solid #64748b;
        opacity: 0.92;
        transition:
            background 0.15s,
            opacity 0.15s;
    }
    .quick-play:hover:not(:disabled) {
        background: #6d28d9;
        opacity: 1;
    }
    .quick-play:disabled {
        opacity: 0.6;
    }
    .open:focus-visible {
        outline: none;
    }
    .open:focus-visible::after,
    .quick-play:focus-visible {
        outline: 2px solid #c4b5fd;
        outline-offset: 2px;
    }
</style>
