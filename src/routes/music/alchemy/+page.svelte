<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Music Alchemy page — /music/alchemy

  Gated by features.musicAlchemy (enforced server-side by +page.server.ts).
  Client-side guard mirrors the server check so the UI degrades gracefully if
  the route is somehow reached while the feature is toggled off mid-session.
-->

<script lang="ts">
    import { page } from '$app/stores';
    import MixingDesk from '$lib/components/music/MixingDesk.svelte';
    import MusicSubpageHeader from '$lib/components/music/MusicSubpageHeader.svelte';
    import { Beaker } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';

    const alchemyEnabled = $derived($page.data?.features?.musicAlchemy === true);
</script>

<svelte:head>
    <title>{m.music_feature_mixing_desk_label()}</title>
</svelte:head>

<MusicSubpageHeader title={m.music_feature_mixing_desk_label()} icon={Beaker} />

{#if alchemyEnabled}
    <MixingDesk />
{:else}
    <div class="gate-msg">
        <p>{m.music_alchemy_not_enabled()}</p>
    </div>
{/if}

<style>
    .gate-msg {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 2rem 1rem 4rem;
        color: rgb(100 116 139);
        font-size: 0.875rem;
    }
</style>
