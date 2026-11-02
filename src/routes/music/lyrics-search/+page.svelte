<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Lyrics Search page — /music/lyrics-search
  Gated by features.lyricsSearch (enforced server-side by +page.server.ts).
-->

<script lang="ts">
    import { page } from '$app/stores';
    import { MagnifyingGlass } from 'svelte-hero-icons';
    import MusicSubpageHeader from '$lib/components/music/MusicSubpageHeader.svelte';
    import EmbeddingSearchPage from '$lib/components/music/EmbeddingSearchPage.svelte';
    import * as m from '$lib/paraglide/messages.js';

    const lyricsEnabled = $derived($page.data?.features?.lyricsSearch === true);
</script>

<svelte:head>
    <title>Lyrics Search</title>
</svelte:head>

<MusicSubpageHeader title={m.music_feature_lyrics_search_label()} icon={MagnifyingGlass} />

<EmbeddingSearchPage
    kind="lyrics"
    endpoint="/api/music/lyrics-search"
    subtitle="Find tracks by what they say — semantic search over embedded lyrics."
    inputAriaLabel="Lyrics search query"
    placeholder="Describe a lyric, theme, or line…"
    badgeTitle="Lyrics similarity score"
    emptyTextPrefix="No lyrics matches found for"
    emptyHintText="Lyrics must be ingested first"
    emptyHintAction="Lyrics Ingestion Backfill"
    gateMessage="Lyrics Search is not enabled on this server."
    idleAlwaysVisible={true}
    idleText="Enter a lyric phrase, theme, or line to find matching tracks."
    featureEnabled={lyricsEnabled} />
