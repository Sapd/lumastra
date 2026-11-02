<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  PlayerSurface — the shared AGPL player primitive used by all viewing shells.

  This is a thin passthrough wrapper over VideoPlayer.svelte that adds the
  `rail` and `belowFold` snippet injection points (now in VideoPlayer) while
  keeping the name stable for shells that import it.

  Shells (WatchShell, EducationalShell, PersonalShell on the AGPL side;
  LessonShell, ShowcaseShell on the proprietary side) import PlayerSurface
  rather than VideoPlayer so the injection-point API is clearly named.

  AGPL invariant: this file must never import from **/proprietary/**.
-->

<script lang="ts">
    import VideoPlayer from './VideoPlayer.svelte';
    import type { VideoPlayerProps } from './player-controller.svelte';
    import type { Snippet } from 'svelte';

    interface PlayerSurfaceProps extends VideoPlayerProps {
        /** Optional rail rendered inside the player container (lesson list, clip strip, etc.) */
        rail?: Snippet;
        /** Optional content rendered below the player fold (metadata strip, tabs, etc.) */
        belowFold?: Snippet;
    }

    let { rail, belowFold, ...playerProps }: PlayerSurfaceProps = $props();
</script>

<VideoPlayer {...playerProps} {rail} {belowFold} />
