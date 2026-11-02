<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Song Paths page — /music/path

  Gated by features.sonicEmbeddings (enforced server-side by +page.server.ts).
  Client-side guard mirrors the server check so the UI degrades gracefully if
  the route is somehow reached while the feature is toggled off mid-session.
-->

<script lang="ts">
    import { page } from '$app/stores';
    import SongPath from '$lib/components/music/SongPath.svelte';
    import MusicSubpageHeader from '$lib/components/music/MusicSubpageHeader.svelte';
    import { ArrowsRightLeft } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';

    const sonicEnabled = $derived($page.data?.features?.sonicEmbeddings === true);
</script>

<svelte:head>
    <title>{m.music_feature_path_label()}</title>
</svelte:head>

<MusicSubpageHeader title={m.music_feature_path_label()} icon={ArrowsRightLeft} />

<div class="page-wrapper">
    <SongPath enabled={sonicEnabled} />
</div>

<style>
    .page-wrapper {
        /* pt-20 is owned by MusicSubpageHeader — only horizontal/bottom padding here */
        padding: 1.5rem 1rem;
        max-width: 52rem;
        margin: 0 auto;
    }
</style>
