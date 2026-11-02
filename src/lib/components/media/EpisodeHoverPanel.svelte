<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	EpisodeHoverPanel.svelte

	Ephemeral episode detail panel docked in the dead gutter to the RIGHT of the
	media modal, shown on row hover / keyboard focus. Renders only where a gutter
	genuinely exists (>=1908px viewports); see hover-panel-placement.ts.

	Uses only data the picker already fetched — no network requests.

	Two deliberate divergences from the MusicEntityHoverCard precedent:
	  * The panel root sets `pointer-events: auto`. The shared over-modal portal is
	    `pointer-events: none`, and the music card relies on that. Here the panel
	    must be hoverable so crossing into it cancels the close grace timer.
	  * No internal scroll region. The overview is line-clamped instead: a scroll
	    area would be unreachable by keyboard (tabbing in fires focusout on the row,
	    closing the panel) and would invalidate role="tooltip".
-->
<script lang="ts">
    import type { ImageSet } from '$lib/schemas/api-image-descriptor';
    import { autoUpdate } from '@floating-ui/dom';
    import { SvelteDate } from 'svelte/reactivity';
    import { mediaHoverCoordinator } from '$lib/components/ui/media-hover-coordinator.svelte';
    import {
        computePanelPlacement,
        resolveCssLengthPx,
        type PanelPlacement,
    } from '$lib/utils/hover-panel-placement';
    import { formatEpisodeNumber } from '$lib/utils/media-display';
    import { classifyEpisodeAvailability } from '$lib/shared/episode-availability';
    import { getLocale } from '$lib/paraglide/runtime';
    import * as m from '$lib/paraglide/messages';
    import { Icon, Check } from 'svelte-hero-icons';
    import EpisodeStill from './EpisodeStill.svelte';
    import EpisodeLanguageBadges from './EpisodeLanguageBadges.svelte';

    interface PanelEpisode {
        id: string;
        name?: string;
        episodeNumber: number;
        episodeNumberEnd?: number;
        seasonNumber: number;
        overview?: string;
        imageTag?: string;
        images?: ImageSet;
        hasOwnStill?: boolean;
        runTimeTicks?: number;
        premiereDate?: string;
        externalIds?: Record<string, string | undefined>;
        originalLanguage?: string;
        audioLanguages?: string[];
        subtitleLanguages?: string[];
        played?: boolean;
        hasFile?: boolean;
        segments?: { episodeNumber: number; title: string }[];
    }

    interface Props {
        /** The episode to describe, or null to render nothing. */
        episode: PanelEpisode | null;
        /** The hovered row, used as the vertical anchor and to locate `.modal-root`. */
        anchorEl: HTMLElement | null;
        resolvedSeriesId: string | undefined;
        /** DOM id, referenced by the row's aria-describedby. */
        panelId: string;
        onpointerenter?: () => void;
        onpointerleave?: () => void;
    }

    let { episode, anchorEl, resolvedSeriesId, panelId, onpointerenter, onpointerleave }: Props =
        $props();

    let panelEl: HTMLDivElement | undefined = $state();
    let placement = $state<PanelPlacement>({ visible: false });

    /**
     * Bottom space reserved by the music mini-player and bottom nav — the same
     * CSS vars ModalContainer insets its positioner by. Read from the document
     * element so the panel never lands on top of the player.
     *
     * Both vars are written in rem (see `MiniPlayer.svelte`'s `--miniplayer-height`
     * effect), and there is no `@property` declaration registering them as
     * `<length>`, so `getComputedStyle().getPropertyValue()` returns the literal
     * source text (e.g. `"6.5rem"`) rather than a resolved pixel value —
     * `resolveCssLengthPx` converts using the root font size.
     */
    function readBottomInset(): number {
        if (typeof window === 'undefined') return 0;
        const styles = getComputedStyle(document.documentElement);
        const rootPx = Number.parseFloat(styles.fontSize) || 16;
        const read = (name: string): number =>
            resolveCssLengthPx(styles.getPropertyValue(name), rootPx);
        return read('--miniplayer-height') + read('--music-bottom-nav-h');
    }

    /**
     * Computed once per panel open (keyed on `episode` identity) rather than
     * on every `reposition()` call — `reposition()` runs on every `autoUpdate`
     * tick (i.e. every scroll event while the panel is open), and re-running
     * `getComputedStyle` that often forces a style recalc for a value that
     * only changes on track/up-next transitions.
     */
    let bottomInset = $derived(episode ? readBottomInset() : 0);

    function reposition(): void {
        if (!anchorEl || !panelEl) {
            placement = { visible: false };
            return;
        }
        const anchorRect = anchorEl.getBoundingClientRect();

        // Anchor scrolled out of view — hide rather than float somewhere arbitrary.
        if (anchorRect.bottom < 0 || anchorRect.top > window.innerHeight) {
            placement = { visible: false };
            return;
        }

        const modalEl = anchorEl.closest('.modal-root');
        placement = computePanelPlacement({
            // Null on surfaces with no modal — the search overlay mounts this
            // picker inside a plain fixed container.
            modalRect: modalEl ? modalEl.getBoundingClientRect() : null,
            anchorRect,
            // clientWidth excludes the classic scrollbar (unlike innerWidth),
            // matching modalRect.right's layout coordinates — up to ~17px
            // matters in the 1908-1925px band this feature is tuned around.
            viewportWidth: document.documentElement.clientWidth,
            viewportHeight: window.innerHeight,
            panelHeight: panelEl.offsetHeight,
            bottomInset,
        });
    }

    // autoUpdate covers all three ancestor scroll containers (.episodes-list,
    // .split-right-pane, .modal-scroll-area), window resize, and the scale(0.95)
    // transform stacked modals apply — none of which a hand-rolled listener set
    // would catch reliably.
    $effect(() => {
        if (!episode || !anchorEl || !panelEl) return;
        return autoUpdate(anchorEl, panelEl, reposition);
    });

    /**
     * Move the panel into the coordinator's over-modal body portal. `.modal-root`
     * is `overflow: hidden` and establishes a stacking context, so an in-tree
     * panel would be clipped and could not out-paint the modal regardless of its
     * own z-index.
     */
    function portal(node: HTMLElement): { destroy(): void } {
        mediaHoverCoordinator.getOverlayPortal()?.appendChild(node);
        // Re-measure immediately after the move. `use:` actions are user effects
        // created during template render, so they run LATER in the effect tree
        // than the script-body $effect above — meaning autoUpdate's first
        // reposition() measured offsetHeight while this node was still inside
        // `.modal-root` (overflow: hidden). Without this the first frame lands
        // using a height from the wrong container.
        reposition();
        return {
            destroy(): void {
                node.remove();
            },
        };
    }

    function formatRuntime(ticks: number): string {
        const minutes = Math.round(ticks / 10_000_000 / 60);
        return m.time_minutes_short({ count: String(minutes) });
    }

    function formatDate(dateStr: string): string {
        return new Date(dateStr).toLocaleDateString(getLocale());
    }

    /** Same classification as the picker row — shared so the two cannot drift. */
    let availability = $derived(
        episode ? classifyEpisodeAvailability(episode, new SvelteDate()) : 'available',
    );
    let unreleased = $derived(availability === 'unreleased');
    /** Aired but not on disk. `true` and `undefined` both mean present. */
    let missingOnDisk = $derived(availability === 'missing');
    /** No air date known at all — do not claim it aired. */
    let undated = $derived(availability === 'undated');
</script>

{#if episode}
    <div
        bind:this={panelEl}
        use:portal
        id={panelId}
        role="tooltip"
        class="episode-hover-panel rounded-lg bg-surface-800 shadow-2xl ring-1 ring-surface-700/60 p-3"
        style:position="fixed"
        style:pointer-events="auto"
        style:left={placement.visible ? `${placement.left}px` : '0px'}
        style:top={placement.visible ? `${placement.top}px` : '0px'}
        style:width={placement.visible ? `${placement.width}px` : 'auto'}
        style:visibility={placement.visible ? 'visible' : 'hidden'}
        onpointerenter={() => onpointerenter?.()}
        onpointerleave={() => onpointerleave?.()}>
        <EpisodeStill
            {episode}
            {resolvedSeriesId}
            size="card"
            class="w-full aspect-video"
            width={480}
            height={270} />

        <div class="mt-2 flex items-start gap-2">
            {#if episode.segments && episode.segments.length > 1}
                <div class="flex-1 min-w-0 space-y-0.5 text-sm font-medium text-white">
                    {#each episode.segments as seg, segIdx (seg.episodeNumber + '-' + segIdx)}
                        <div class="flex items-baseline gap-2 min-w-0">
                            <span class="text-surface-400 whitespace-nowrap shrink-0"
                                >E{seg.episodeNumber}</span>
                            <span class="break-words">{seg.title}</span>
                        </div>
                    {/each}
                </div>
            {:else}
                <h4 class="flex-1 min-w-0 text-sm font-medium text-white break-words">
                    <span class="text-surface-400"
                        >{formatEpisodeNumber(
                            episode.episodeNumber,
                            episode.episodeNumberEnd,
                        )}</span>
                    {episode.name || `Episode ${episode.episodeNumber}`}
                </h4>
            {/if}
            {#if episode.played}
                <Icon src={Check} class="w-4 h-4 text-green-400 shrink-0 mt-0.5" solid />
            {/if}
        </div>

        {#if unreleased}
            <span
                class="mt-1.5 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide bg-amber-500/15 text-amber-300 border border-amber-500/30">
                {m.episode_picker_unreleased_badge()}
            </span>
        {:else if missingOnDisk}
            <span
                class="mt-1.5 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide bg-rose-500/15 text-rose-300 border border-rose-500/30">
                {m.episode_picker_missing_badge()}
            </span>
        {:else if undated}
            <span
                class="mt-1.5 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide bg-surface-500/20 text-surface-300 border border-surface-500/40">
                {m.episode_picker_undated_badge()}
            </span>
        {/if}

        {#if episode.overview}
            <p class="mt-1.5 text-xs text-surface-300 break-words overview-clamp">
                {episode.overview}
            </p>
        {/if}

        <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-surface-500 min-w-0">
            {#if episode.runTimeTicks}
                <span>{formatRuntime(episode.runTimeTicks)}</span>
            {/if}
            {#if episode.premiereDate}
                <span>{formatDate(episode.premiereDate)}</span>
            {/if}
            <EpisodeLanguageBadges
                originalLanguage={episode.originalLanguage}
                audioLanguages={episode.audioLanguages}
                subtitleLanguages={episode.subtitleLanguages}
                showSeparator={!!(episode.runTimeTicks || episode.premiereDate)}
                max={2}
                interactive={false} />
        </div>
    </div>
{/if}

<style lang="postcss">
    /* Clamp rather than scroll: a scroll region here would be unreachable by
       keyboard (tabbing in closes the panel via focusout on the row) and would
       make role="tooltip" invalid. */
    .overview-clamp {
        display: -webkit-box;
        -webkit-line-clamp: 14;
        line-clamp: 14;
        -webkit-box-orient: vertical;
        overflow: hidden;
    }

    .episode-hover-panel {
        transition: opacity 120ms ease-out;
    }

    @media (prefers-reduced-motion: reduce) {
        .episode-hover-panel {
            transition: none;
        }
    }
</style>
