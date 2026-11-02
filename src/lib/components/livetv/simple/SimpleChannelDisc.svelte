<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    // Logo of a simple-mode channel, or a coloured disc with the name's
    // initials when there is no logo (or it fails to load). The channel number
    // is always shown next to it, so the disc does not repeat it.
    import type { LiveTvStation } from '$lib/schemas/livetv.js';
    import { discColor, initials } from './simple-lineup.js';

    interface Props {
        channel: LiveTvStation;
        /** Edge length in rem. */
        size?: number;
    }

    let { channel, size = 5 }: Props = $props();

    let failedUrl = $state<string | undefined>(undefined);
    let logo = $derived(
        channel.images?.primary?.href && channel.images?.primary?.href !== failedUrl
            ? channel.images?.primary?.href
            : null,
    );
</script>

<span
    class="disc"
    style:width="{size}rem"
    style:height="{size}rem"
    style:background={logo ? '#111827' : discColor(channel.name)}
    aria-hidden="true">
    {#if logo}
        <img
            src={logo}
            alt=""
            loading="lazy"
            decoding="async"
            onerror={() => (failedUrl = channel.images?.primary?.href)} />
    {:else}
        <span class="num" style:font-size="{size * 0.4}rem">{initials(channel.name)}</span>
    {/if}
</span>

<style>
    .disc {
        display: inline-flex;
        flex-shrink: 0;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        border-radius: 1rem;
        border: 2px solid rgb(255 255 255 / 0.35);
    }
    img {
        width: 86%;
        height: 86%;
        object-fit: contain;
    }
    .num {
        color: #fff;
        font-weight: 800;
        line-height: 1;
        font-variant-numeric: tabular-nums;
    }
</style>
