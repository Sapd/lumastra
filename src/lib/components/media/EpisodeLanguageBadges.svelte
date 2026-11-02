<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	EpisodeLanguageBadges.svelte

	Audio and subtitle language badges for an episode, shared by the picker row
	and the hover panel.

	`showSeparator` renders the leading `·` the row needs when runtime or air date
	precedes the badges — that separator lives in the caller's flex row, so it has
	to be carried across explicitly rather than assumed.
-->
<script lang="ts">
    import { onMount } from 'svelte';
    import {
        playbackPreferences,
        initializePreferences,
    } from '$lib/components/player/preferences-sync.svelte';
    import LanguageBadges from './LanguageBadges.svelte';

    onMount(() => {
        if (!playbackPreferences.ready || playbackPreferences.storageUnavailable) {
            void initializePreferences();
        }
    });

    interface Props {
        originalLanguage?: string;
        audioLanguages?: string[];
        subtitleLanguages?: string[];
        /** Leading `·` separator, when other metadata precedes these badges. */
        showSeparator?: boolean;
        /** Cap per kind — the row is width-constrained, the panel less so. */
        max?: number;
        /** Hover panels are descriptions, so must not contain interactive controls. */
        interactive?: boolean;
    }

    let {
        originalLanguage = undefined,
        audioLanguages = [],
        subtitleLanguages = [],
        showSeparator = false,
        max = 2,
        interactive = true,
    }: Props = $props();

    let hasAny = $derived(audioLanguages.length > 0 || subtitleLanguages.length > 0);
</script>

{#if playbackPreferences.ready && playbackPreferences.showEpisodeLanguages && hasAny}
    {#if showSeparator}
        <span class="text-surface-700">·</span>
    {/if}
    <LanguageBadges {originalLanguage} {audioLanguages} {subtitleLanguages} {max} {interactive} />
{/if}
