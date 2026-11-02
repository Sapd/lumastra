<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * ForYou - thin shell for the personalised home-page widget.
     *
     * Composes two concern components:
     *
     * - <WatchingStrip> owns the Continue-Watching strip, the new-episode
     *   banner, the SSE/lifecycle refresh path, and the mark-watched /
     *   dismiss interactions on CW cards.
     * - <RecommendationFeed> owns the long-tail recommendation rows,
     *   featured pick, mood selector, and the dismiss/refresh-with-
     *   steering flow on "because you watched" rows.
     *
     * The shell itself only renders the page header (refresh + collapse
     * buttons) and mounts the ClearHistoryModal — both children are
     * self-contained, the shell just wires the refresh button to call
     * each child's exposed `refresh()` and bubbles the CW "Clear all"
     * button into modal state.
     */
    import { Icon, Sparkles, ArrowPath, ChevronDown, ChevronUp } from 'svelte-hero-icons';
    import { toasts } from '$lib/stores/toast.store';
    import * as forYouApi from '$lib/api/for-you';
    import * as m from '$lib/paraglide/messages';
    import ClearHistoryModal from '$lib/components/foryou/ClearHistoryModal.svelte';
    import WatchingStrip from '$lib/components/foryou/WatchingStrip.svelte';
    import RecommendationFeed from '$lib/components/foryou/RecommendationFeed.svelte';
    import AudiobookActivityRail from '$lib/components/audiobook/AudiobookActivityRail.svelte';

    // Refs to children for shell-level orchestration. Each child exports
    // a `refresh()` instance method via Svelte 5's `export function`,
    // which is exposed on the bind:this target. We type the refs
    // structurally to avoid coupling the shell to either component's
    // full export shape.
    interface WatchingStripExports {
        refresh: (bustCache?: boolean) => void;
    }
    interface RecommendationFeedExports {
        refresh: () => void;
    }
    interface AudiobookActivityRailExports {
        refresh: () => void;
    }
    let watchingStrip = $state<WatchingStripExports | undefined>(undefined);
    let recommendationFeed = $state<RecommendationFeedExports | undefined>(undefined);
    let audiobookActivityRail = $state<AudiobookActivityRailExports | undefined>(undefined);

    // Shell-level UI state.
    let isCollapsed = $state(false);
    let feedLoading = $state(false);
    let hasContinueWatching = $state(false);

    // Clear modal state — the shell mounts the modal so it lives outside
    // both child concerns.
    let showClearModal = $state(false);
    let clearType: 'movies' | 'episodes' | 'both' = $state('both');
    let isClearing = $state(false);

    // Set when a feed refresh is requested while the widget is collapsed, so the
    // heavy ~18-endpoint recommendation fan-out is deferred until the user
    // actually expands the feed again (the rows aren't visible while collapsed).
    let pendingFeedRefresh = $state(false);

    function handleRefresh(): void {
        // Manual refresh: bust cache for the watching strip (the user
        // clicked the button) AND reload the recommendation feed.
        watchingStrip?.refresh(true);
        audiobookActivityRail?.refresh();
        if (isCollapsed) {
            // Defer the feed fan-out — it would fetch content the user can't
            // see. Flag it so expanding the widget re-loads with fresh data.
            pendingFeedRefresh = true;
        } else {
            recommendationFeed?.refresh();
        }
    }

    function handleToggleCollapse(): void {
        isCollapsed = !isCollapsed;
        // On expand, flush any refresh that was deferred while collapsed.
        if (!isCollapsed && pendingFeedRefresh) {
            pendingFeedRefresh = false;
            recommendationFeed?.refresh();
        }
    }

    function handleHasContinueWatchingChange(next: boolean): void {
        hasContinueWatching = next;
    }

    function handleClearAllRequested(): void {
        // Open the clear modal — default to clearing both movies + episodes,
        // which matches the prior in-line behaviour.
        clearType = 'both';
        showClearModal = true;
    }

    function handleFeedLoadingChange(next: boolean): void {
        feedLoading = next;
    }

    async function clearContinueWatching(detail?: {
        clearType: 'movies' | 'episodes' | 'both';
    }): Promise<void> {
        if (isClearing) return;
        isClearing = true;
        // Get clearType from detail if available, otherwise use component state
        const typeToDelete = detail?.clearType || clearType;
        try {
            const { data: clearData, error: clearErr } =
                await forYouApi.clearContinueWatching(typeToDelete);
            if (!clearErr && clearData) {
                const typed = clearData as {
                    success?: boolean;
                    cleared?: number;
                    total?: number;
                    message?: string;
                };
                if (typed?.success || (typed?.cleared !== undefined && typed.cleared >= 0)) {
                    // Show success message
                    const clearedCount = typed.cleared ?? 0;
                    if (clearedCount > 0) {
                        toasts.success(
                            m.foryou_clear_success({
                                count: clearedCount.toString(),
                            }),
                        );
                    } else {
                        toasts.info(m.foryou_clear_no_items());
                    }
                    // Re-pull the watching strip so the row reflects the
                    // server state after the clear.
                    watchingStrip?.refresh(true);
                } else {
                    toasts.error(m.foryou_clear_error());
                }
            } else {
                toasts.error(m.foryou_clear_error());
            }
        } catch (e) {
            console.error('[ForYou] Error clearing continue watching:', e);
            toasts.error(m.foryou_clear_error());
        } finally {
            isClearing = false;
            // Always close the modal after the operation completes
            showClearModal = false;
        }
    }

    // hasContinueWatching is currently used only as a hook for future
    // shell-level UI (e.g. a top-level "Clear history" button gated on
    // CW presence). Today there's no consumer, but the callback wiring
    // is in place so the eventual UI can read it without round-tripping
    // through the child component.
</script>

<div class="space-y-8">
    <!-- Header -->
    <div class="between">
        <div class="flex items-center gap-2">
            <Icon src={Sparkles} class="h-5 w-5 text-primary-400" />
            <span class="tracking-tight text-lg font-semibold text-primary-400"
                >{m.foryou_for_you()}</span>
        </div>
        <div class="flex items-center gap-2">
            <button
                class="p-1 hover:bg-gray-700 rounded-full transition-colors"
                onclick={handleRefresh}
                disabled={feedLoading}
                title={m.foryou_refresh_tooltip()}
                aria-label={m.foryou_refresh_tooltip()}>
                <Icon
                    src={ArrowPath}
                    class="w-4 h-4 text-gray-400 hover:text-white {feedLoading
                        ? 'animate-spin'
                        : ''}" />
            </button>
            <button
                class="p-1 hover:bg-gray-700 rounded-full transition-colors"
                onclick={handleToggleCollapse}
                aria-label={isCollapsed ? m.section_expand() : m.section_collapse()}>
                <Icon
                    src={isCollapsed ? ChevronDown : ChevronUp}
                    class="w-4 h-4 text-gray-400 hover:text-white" />
            </button>
        </div>
    </div>

    <!-- Both children stay mounted while collapsed, hidden via CSS — pre-
         decomposition the shell owned `loadForYou` directly so the header
         refresh button worked while collapsed. Unmounting via {#if} would
         null the bind:this refs and turn refresh into a silent no-op, and
         would also tear down the SSE/visibility lifecycle WatchingStrip
         relies on. -->
    <div class="space-y-8" class:hidden={isCollapsed}>
        <WatchingStrip
            bind:this={watchingStrip}
            onhasContinueWatchingChange={handleHasContinueWatchingChange}
            onclearAllRequested={handleClearAllRequested} />

        <AudiobookActivityRail bind:this={audiobookActivityRail} />

        <RecommendationFeed
            bind:this={recommendationFeed}
            onloadingChange={handleFeedLoadingChange} />
    </div>
</div>

<!-- Clear Continue Watching Modal -->
<ClearHistoryModal
    show={showClearModal}
    bind:clearType
    {isClearing}
    onclose={() => (showClearModal = false)}
    onconfirm={clearContinueWatching} />
