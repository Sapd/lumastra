<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Sound Search page — /music/text-search
  Gated by features.textToSound (enforced server-side by +page.server.ts).
-->

<script lang="ts">
    import { page } from '$app/stores';
    import { MagnifyingGlass } from 'svelte-hero-icons';
    import MusicSubpageHeader from '$lib/components/music/MusicSubpageHeader.svelte';
    import EmbeddingSearchPage from '$lib/components/music/EmbeddingSearchPage.svelte';
    import * as m from '$lib/paraglide/messages.js';

    const textToSoundEnabled = $derived($page.data?.features?.textToSound === true);

    const EXAMPLE_PROMPTS = [
        'calm piano',
        'aggressive metal',
        'summer party',
        'sad ballad',
        'smooth jazz',
        'energetic electronic',
    ];
</script>

<svelte:head>
    <title>Sound Search</title>
</svelte:head>

<MusicSubpageHeader title={m.music_feature_sound_search_label()} icon={MagnifyingGlass} />

<EmbeddingSearchPage
    kind="sound"
    endpoint="/api/music/text-search"
    subtitle="Describe a sound or mood to find matching tracks — powered by CLAP audio+text embeddings."
    inputAriaLabel="Sound search query"
    placeholder="Describe a sound, mood, or genre…"
    badgeTitle="Sound similarity score"
    emptyTextPrefix="No sonic matches found for"
    emptyHintText="Sonic embeddings must be computed first"
    emptyHintAction="Sonic Embedding Backfill"
    gateMessage="Sound Search is not enabled on this server."
    idleAlwaysVisible={false}
    idleText="Press Enter or click Search to find matching tracks."
    examplePrompts={EXAMPLE_PROMPTS}
    featureEnabled={textToSoundEnabled} />
