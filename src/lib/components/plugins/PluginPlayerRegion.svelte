<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Plugin widgets inside the video player.

  The riskiest surface in the system, so the containment is structural rather
  than advisory:

  * The region sits BELOW the host controls layer. A plugin cannot cover
    pause, seek or the back button, whatever it renders or however it styles
    itself — there is no z-index it can set from inside that wins.
  * `pointer-events: none` on the container; a plugin opts individual elements
    back in. So the default state of plugin DOM is "does not intercept the
    click the viewer is aiming at the video".
  * `contain: layout style paint` — a plugin's layout cannot thrash the
    player's.
  * Playback state arrives only through the pull/observe bridge. No video
    element, no hls instance, no stream URL.

  A `panel` widget renders nothing at all until the viewer opens it, so an
  installed player plugin costs nothing during ordinary playback.
-->
<script lang="ts">
    import PluginWidgetSlot from './PluginWidgetSlot.svelte';
    import type { PlaybackBridge } from '../player/plugin-playback-bridge.js';

    interface WidgetMeta {
        id: string;
        featureId: string;
        widgetId: string;
        title: string;
        entry: string;
        placement: string;
        playerRegion?: string;
        minHeightPx?: number;
    }

    interface Props {
        widgets: WidgetMeta[];
        user: { userId: string; username: string; groups: string[]; isAdmin: boolean } | null;
        playback: PlaybackBridge;
        /** Which region to render. */
        region: 'panel' | 'top-right';
        /** `panel` only: whether the viewer has it open. */
        open?: boolean;
    }

    let { widgets, user, playback, region, open = false }: Props = $props();

    let regionWidgets = $derived(
        widgets.filter((w) => w.placement === 'player' && (w.playerRegion ?? 'panel') === region),
    );

    let visible = $derived(regionWidgets.length > 0 && (region !== 'panel' || open));
</script>

{#if visible}
    <div class="plugin-player-region plugin-player-region-{region}">
        {#each regionWidgets as w (w.id)}
            <PluginWidgetSlot
                widget={{
                    featureId: w.featureId,
                    id: w.id,
                    title: w.title,
                    entry: w.entry,
                }}
                {user}
                minHeight={`${w.minHeightPx ?? 0}px`}
                context={{ surface: 'player', playback }} />
        {/each}
    </div>
{/if}

<style>
    .plugin-player-region {
        position: absolute;
        /* BELOW the host controls layer. Not a convention a plugin could
           override from inside — its DOM is nested here. */
        z-index: 5;
        /* A plugin's layout cannot reflow the player's. */
        contain: layout style paint;
        /* Plugin DOM must not eat a click aimed at the video. Individual
           elements opt back in with `pointer-events: auto`. */
        pointer-events: none;
        color: var(--text);
    }

    .plugin-player-region-top-right {
        top: 4.5rem;
        right: 1rem;
        max-width: min(22rem, 40vw);
        max-height: 40vh;
        overflow: hidden;
    }

    .plugin-player-region-panel {
        top: 0;
        right: 0;
        bottom: 0;
        width: min(24rem, 90vw);
        overflow-y: auto;
        background: rgb(var(--color-surface-950-rgb) / 0.92);
        backdrop-filter: blur(6px);
        padding: 1rem;
        /* An opened panel IS the thing the viewer is interacting with. */
        pointer-events: auto;
    }
</style>
