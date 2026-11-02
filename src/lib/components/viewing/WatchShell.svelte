<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  WatchShell — default VOD viewing shell (movies / TV episodes).

  Full-bleed immersive player. Passes no rail or belowFold snippets — the
  PlayerSurface's own EpisodeBrowser / PlaylistBrowser rails handle
  on-demand episode/playlist navigation, which is the correct VOD behavior.

  This shell is the baseline: all other shells diverge from it.
-->

<script lang="ts">
    import PlayerSurface from '$lib/components/player/PlayerSurface.svelte';
    import type { VideoPlayerProps } from '$lib/components/player/player-controller.svelte';

    interface Props extends VideoPlayerProps {
        // All VideoPlayerProps pass through; no extras for the VOD shell.
    }

    let props: Props = $props();
</script>

<!-- VOD: no extra chrome, just the full-bleed player surface -->
<PlayerSurface {...props} />
