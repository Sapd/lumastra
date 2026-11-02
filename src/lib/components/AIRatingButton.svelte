<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- AI Rating Button Component -->
<script lang="ts">
    /**
     * AIRatingButton - Quick rating buttons with optional detailed rating panel
     * Uses DetailedRatingPanel for slider/star-based ratings
     */
    import DetailedRatingPanel from './ai/DetailedRatingPanel.svelte';
    import { Icon, HandThumbUp, HandThumbDown, Heart } from 'svelte-hero-icons';
    import type { ExternalIds } from '$lib/types/api-common';
    import { hasValidExternalId, mediaCompositeKey } from '$lib/utils/media-id-helpers';
    import * as m from '$lib/paraglide/messages';
    import * as aiApi from '$lib/api/ai';
    import { toasts } from '$lib/stores/toast.store';

    interface Props {
        externalIds: ExternalIds;
        mediaType?: 'movie' | 'tv';
        title?: string;
        currentRating?: number | null;
        disabled?: boolean;
        context?: 'for-you' | 'rate-mode' | 'onboarding' | 'grid';
        source?: 'watched' | 'tmdb';
        /**
         * Whether the user has seen this item. Drives the rating layout:
         *  - seen (quality rating): Dislike / Meh / Like / Love (2/5/8/10) + 10-star toggle.
         *  - unseen (interest rating): Not for me / Interested / Must-watch (2/8/10), no Meh, no 10-star toggle.
         */
        seen?: boolean;
        initialDetailedMode?: boolean;
        // Callbacks
        onrated?: (detail: {
            externalIds: ExternalIds;
            mediaType: 'movie' | 'tv';
            rating: number;
            title: string;
        }) => void;
        /** Fired when an existing rating is cleared (re-tapping the already-active button). */
        oncleared?: (detail: {
            externalIds: ExternalIds;
            mediaType: 'movie' | 'tv';
            title: string;
        }) => void;
        ondetailedModeChanged?: (detail: { detailedMode: boolean }) => void;
    }

    let {
        externalIds,
        mediaType = 'movie',
        title = '',
        currentRating = null,
        disabled = false,
        context = 'for-you',
        source = 'tmdb',
        seen = true,
        initialDetailedMode = $bindable(false),
        onrated,
        oncleared,
        ondetailedModeChanged,
    }: Props = $props();

    let loading = $state(false);
    let showToast = $state(false);
    let toastMessage = $state('');
    let showDetailedRating = $derived(initialDetailedMode);
    let resetKey = $derived.by(() =>
        hasValidExternalId(externalIds) ? mediaCompositeKey(externalIds, mediaType, title) : '',
    );
    let detailedRating = $derived.by(() => {
        resetKey;
        return 10;
    });
    let localRating: number | null = $derived.by(() => {
        resetKey;
        return null;
    });
    let hoveredStar = $state(0); // For compact star hover effect

    // Rating descriptions (using i18n)
    const ratingDescriptions = [
        m.rating_terrible(), // 1
        m.rating_very_bad(), // 2
        m.rating_bad(), // 3
        m.rating_meh(), // 4
        m.rating_average(), // 5
        m.rating_ok(), // 6
        m.rating_good(), // 7
        m.rating_very_good(), // 8
        m.rating_great(), // 9
        m.rating_masterpiece(), // 10
    ];

    // Combined rating for display (local takes precedence)
    // Ensure we get null (not undefined) when no rating exists
    let effectiveRating = $derived(localRating ?? currentRating ?? null);

    async function rateContent(rating: number, ratingContext = '') {
        if (loading || disabled || (!hasValidExternalId(externalIds) && !externalIds?.internal))
            return;

        loading = true;
        try {
            const finalContext = ratingContext || `User rated "${title}" from dashboard`;
            const { error: ratingError } = await aiApi.submitRating(
                externalIds,
                mediaType,
                rating,
                finalContext,
            );

            if (!ratingError) {
                localRating = rating;

                // Brief success feedback — the button's active state alone is too
                // subtle to confirm the rate landed. One toast per rate action.
                toasts.success(m.card_rate_saved({ rating }), 2000);

                // Hide detailed rating panel after successful rating (but keep open in rate mode)
                if (context !== 'rate-mode') {
                    initialDetailedMode = false;
                }

                // Dispatch event for parent components
                onrated?.({ externalIds, mediaType, rating, title });
            } else {
                console.warn('Rating failed:', ratingError);
            }
        } catch (error) {
            console.error('Rating error:', error);
            // toastMessage = 'Network error. Please try again.';
            // showToast = true;
            // setTimeout(() => showToast = false, 3000);
        } finally {
            loading = false;
        }
    }

    async function clearContent() {
        if (loading || disabled || (!hasValidExternalId(externalIds) && !externalIds?.internal))
            return;

        loading = true;
        try {
            const { error: clearError } = await aiApi.clearRating(externalIds, mediaType);

            if (!clearError) {
                localRating = null;
                toasts.success(m.card_rating_cleared(), 2000);

                if (context !== 'rate-mode') {
                    initialDetailedMode = false;
                }

                oncleared?.({ externalIds, mediaType, title });
            } else {
                console.warn('Clear rating failed:', clearError);
            }
        } catch (error) {
            console.error('Clear rating error:', error);
        } finally {
            loading = false;
        }
    }

    /** Re-tapping the already-active rating clears it; otherwise sets it. */
    function rateOrClear(rating: number, ratingContext: string) {
        if (effectiveRating === rating) {
            clearContent();
        } else {
            rateContent(rating, ratingContext);
        }
    }

    function handleQuickRating(type: 'thumbs-down' | 'meh' | 'thumbs-up' | 'love') {
        if (type === 'thumbs-down') {
            rateOrClear(2, `User gave thumbs down to "${title}" - Don't suggest similar content`);
        } else if (type === 'meh') {
            rateOrClear(5, `User rated "${title}" as average`);
        } else if (type === 'thumbs-up') {
            rateOrClear(8, `User gave thumbs up to "${title}" - Suggest more like this`);
        } else if (type === 'love') {
            rateOrClear(10, `User loved "${title}" - Definitely suggest more like this`);
        }
    }

    function handleDetailedSubmit(detail: { rating: number }) {
        detailedRating = detail.rating;
        submitDetailedRating();
    }

    function toggleDetailedRating() {
        initialDetailedMode = !initialDetailedMode;
        // When opening detailed mode, pre-fill with existing rating if available
        if (initialDetailedMode && effectiveRating !== null) {
            detailedRating = effectiveRating;
        }
        ondetailedModeChanged?.({ detailedMode: initialDetailedMode });
    }

    function submitDetailedRating() {
        // All contexts now use actual 10-star detailed rating
        const ratingContext = `User gave detailed rating (${detailedRating}/10) to "${title}"`;
        rateOrClear(detailedRating, ratingContext);
    }

    // Seen-aware button labels. `seen` drives the score-set + visible labels;
    // `source` is only used to pick the richer aria wording.
    //  - seen (quality):  HandThumbDown Dislike (2) · 😐 Meh (5) · HandThumbUp Like (8) · Heart Love (10)
    //  - unseen (interest): HandThumbDown Not for me (2) · HandThumbUp Interested (8) · Heart Must-watch (10)
    let buttonLabels = $derived(
        seen
            ? {
                  thumbsDown: {
                      text: m.rating_dislike(),
                      aria: source === 'watched' ? m.rating_dislike_watched() : m.rating_dislike(),
                  },
                  meh: { text: m.rating_meh(), aria: m.rating_meh() },
                  thumbsUp: {
                      text: m.rating_like(),
                      aria: source === 'watched' ? m.rating_like_watched() : m.rating_like(),
                  },
                  love: {
                      text: m.rating_love(),
                      aria: source === 'watched' ? m.rating_love_watched() : m.rating_love(),
                  },
              }
            : {
                  thumbsDown: {
                      text: m.rating_not_for_me(),
                      aria: m.rating_dislike_suggest(),
                  },
                  meh: { text: m.rating_meh(), aria: m.rating_meh() },
                  thumbsUp: { text: m.rating_interested(), aria: m.rating_like_suggest() },
                  love: { text: m.rating_must_watch(), aria: m.rating_love_suggest() },
              },
    );
</script>

<div class="ai-rating-container">
    {#if !showDetailedRating}
        {#if context === 'for-you'}
            <!-- Single row compact layout for modal -->
            <div class="compact-rating-buttons">
                <button
                    class="compact-btn thumbs-down {effectiveRating !== null && effectiveRating <= 3
                        ? 'active'
                        : ''}"
                    onclick={() => handleQuickRating('thumbs-down')}
                    disabled={loading || disabled}
                    aria-label={buttonLabels.thumbsDown.aria}
                    title={buttonLabels.thumbsDown.text}>
                    <Icon
                        src={HandThumbDown}
                        class="w-5 h-5"
                        solid={effectiveRating !== null && effectiveRating <= 3} />
                </button>

                <!-- No standalone "Meh" here: this compact layout is used in the
                     space-constrained modal/for-you footer. For seen items the ⭐
                     10-star toggle below already covers middle ratings (5), so we
                     keep the cluster tight (the explicit 😐 Meh button only appears
                     in the roomier rate-mode card). -->

                <button
                    class="compact-btn thumbs-up {effectiveRating !== null &&
                    effectiveRating >= 6 &&
                    effectiveRating <= 8
                        ? 'active'
                        : ''}"
                    onclick={() => handleQuickRating('thumbs-up')}
                    disabled={loading || disabled}
                    aria-label={buttonLabels.thumbsUp.aria}
                    title={buttonLabels.thumbsUp.text}>
                    <Icon
                        src={HandThumbUp}
                        class="w-5 h-5"
                        solid={effectiveRating !== null &&
                            effectiveRating >= 6 &&
                            effectiveRating <= 8} />
                </button>

                <button
                    class="compact-btn love {effectiveRating !== null && effectiveRating >= 9
                        ? 'active'
                        : ''}"
                    onclick={() => handleQuickRating('love')}
                    disabled={loading || disabled}
                    aria-label={buttonLabels.love.aria}
                    title={buttonLabels.love.text}>
                    <Icon
                        src={Heart}
                        class="w-5 h-5"
                        solid={effectiveRating !== null && effectiveRating >= 9} />
                </button>

                {#if seen}
                    <!-- Toggle to 10-star mode — only for seen items (can't precisely score unseen) -->
                    <button
                        class="compact-btn toggle-detailed {effectiveRating !== null
                            ? 'has-rating'
                            : ''}"
                        onclick={toggleDetailedRating}
                        disabled={loading || disabled}
                        aria-label={effectiveRating !== null
                            ? m.rating_current_click_to_change({
                                  rating: effectiveRating,
                              })
                            : m.rating_10_star()}
                        title={effectiveRating !== null
                            ? `${effectiveRating}/10`
                            : m.rating_10_star()}>
                        {#if effectiveRating !== null}
                            <span class="star-with-rating"
                                >⭐<span class="rating-number">{effectiveRating}</span></span>
                        {:else}
                            ⭐
                        {/if}
                    </button>
                {/if}
            </div>
        {:else if context === 'rate-mode'}
            <!-- Rate mode layout: Love on top, thumbs below, star toggle -->
            <div class="rate-mode-buttons">
                <!-- Love button centered on top -->
                <div class="rate-mode-top">
                    <button
                        class="rate-btn love {effectiveRating !== null && effectiveRating >= 9
                            ? 'active'
                            : ''}"
                        onclick={() => handleQuickRating('love')}
                        disabled={loading || disabled}
                        aria-label={buttonLabels.love.aria}>
                        <Icon
                            src={Heart}
                            class="w-6 h-6"
                            solid={effectiveRating !== null && effectiveRating >= 9} />
                        <span class="rate-btn-label">{buttonLabels.love.text}</span>
                    </button>
                </div>

                <!-- Thumbs row below -->
                <div class="rate-mode-bottom">
                    <button
                        class="rate-btn thumbs-down {effectiveRating !== null &&
                        effectiveRating <= 3
                            ? 'active'
                            : ''}"
                        onclick={() => handleQuickRating('thumbs-down')}
                        disabled={loading || disabled}
                        aria-label={buttonLabels.thumbsDown.aria}>
                        <Icon
                            src={HandThumbDown}
                            class="w-5 h-5"
                            solid={effectiveRating !== null && effectiveRating <= 3} />
                        <span class="rate-btn-label">{buttonLabels.thumbsDown.text}</span>
                    </button>

                    {#if seen}
                        <!-- Meh (5) only available for seen items (quality rating) -->
                        <button
                            class="rate-btn meh {effectiveRating === 4 || effectiveRating === 5
                                ? 'active'
                                : ''}"
                            onclick={() => handleQuickRating('meh')}
                            disabled={loading || disabled}
                            aria-label={buttonLabels.meh.aria}>
                            😐 <span class="rate-btn-label">{buttonLabels.meh.text}</span>
                        </button>

                        <!-- Star toggle in middle — only for seen items -->
                        <button
                            class="rate-btn toggle-detailed {effectiveRating !== null
                                ? 'has-rating'
                                : ''}"
                            onclick={toggleDetailedRating}
                            disabled={loading || disabled}
                            aria-label={effectiveRating !== null
                                ? m.rating_current({ rating: effectiveRating })
                                : m.rating_10_star()}
                            title={effectiveRating !== null
                                ? `${effectiveRating}/10`
                                : m.rating_10_star()}>
                            {#if effectiveRating !== null}
                                <span class="star-with-rating"
                                    >⭐<span class="rating-number">{effectiveRating}</span></span>
                            {:else}
                                ⭐
                            {/if}
                        </button>
                    {/if}

                    <button
                        class="rate-btn thumbs-up {effectiveRating !== null &&
                        effectiveRating >= 6 &&
                        effectiveRating <= 8
                            ? 'active'
                            : ''}"
                        onclick={() => handleQuickRating('thumbs-up')}
                        disabled={loading || disabled}
                        aria-label={buttonLabels.thumbsUp.aria}>
                        <Icon
                            src={HandThumbUp}
                            class="w-5 h-5"
                            solid={effectiveRating !== null &&
                                effectiveRating >= 6 &&
                                effectiveRating <= 8} />
                        <span class="rate-btn-label">{buttonLabels.thumbsUp.text}</span>
                    </button>
                </div>
            </div>
        {:else}
            <!-- Compact layout for onboarding and grid -->
            <!-- Super button on top row -->
            <div class="super-button-row">
                <button
                    class="super-btn {effectiveRating !== null && effectiveRating >= 9
                        ? 'active'
                        : ''}"
                    onclick={() => handleQuickRating('love')}
                    disabled={loading || disabled}
                    aria-label={buttonLabels.love.aria}>
                    <Icon
                        src={Heart}
                        class="w-3.5 h-3.5"
                        solid={effectiveRating !== null && effectiveRating >= 9} />
                    <span class="primary-btn-label">{buttonLabels.love.text}</span>
                </button>
            </div>

            <!-- Dislike, Meh (seen only) and Like buttons on same row -->
            <div class="primary-rating-buttons">
                <button
                    class="primary-btn thumbs-down {effectiveRating !== null && effectiveRating <= 3
                        ? 'active'
                        : ''}"
                    onclick={() => handleQuickRating('thumbs-down')}
                    disabled={loading || disabled}
                    aria-label={buttonLabels.thumbsDown.aria}>
                    <Icon
                        src={HandThumbDown}
                        class="w-5 h-5"
                        solid={effectiveRating !== null && effectiveRating <= 3} />
                    <span class="primary-btn-label">{buttonLabels.thumbsDown.text}</span>
                </button>

                {#if seen}
                    <button
                        class="primary-btn meh {effectiveRating === 4 || effectiveRating === 5
                            ? 'active'
                            : ''}"
                        onclick={() => handleQuickRating('meh')}
                        disabled={loading || disabled}
                        aria-label={buttonLabels.meh.aria}>
                        😐 <span class="primary-btn-label">{buttonLabels.meh.text}</span>
                    </button>
                {/if}

                <button
                    class="primary-btn thumbs-up {effectiveRating !== null &&
                    effectiveRating >= 6 &&
                    effectiveRating <= 8
                        ? 'active'
                        : ''}"
                    onclick={() => handleQuickRating('thumbs-up')}
                    disabled={loading || disabled}
                    aria-label={buttonLabels.thumbsUp.aria}>
                    <Icon
                        src={HandThumbUp}
                        class="w-5 h-5"
                        solid={effectiveRating !== null &&
                            effectiveRating >= 6 &&
                            effectiveRating <= 8} />
                    <span class="primary-btn-label">{buttonLabels.thumbsUp.text}</span>
                </button>
            </div>
        {/if}
    {/if}

    {#if showDetailedRating}
        {#if context === 'for-you' || context === 'rate-mode'}
            <!-- Compact inline 10-star for modal and rate-mode -->
            <div class="compact-stars-row">
                <button
                    class="back-to-simple"
                    onclick={toggleDetailedRating}
                    aria-label={m.rating_back_to_simple()}
                    title={m.back()}>
                    ←
                </button>
                <div
                    class="compact-stars"
                    onmouseleave={() => (hoveredStar = 0)}
                    role="group"
                    aria-label={m.rating_10_star()}>
                    {#each Array(10) as _, i (i)}
                        <button
                            type="button"
                            class="compact-star {i < (hoveredStar || detailedRating)
                                ? 'filled'
                                : ''}"
                            onclick={() => {
                                detailedRating = i + 1;
                                submitDetailedRating();
                            }}
                            onmouseenter={() => (hoveredStar = i + 1)}
                            disabled={loading || disabled}
                            aria-label="{i + 1} - {ratingDescriptions[i]}"
                            title="{i + 1} - {ratingDescriptions[i]}">
                            ★
                        </button>
                    {/each}
                </div>
                {#if hoveredStar > 0 || detailedRating > 0}
                    <span class="compact-rating-label">{hoveredStar || detailedRating}/10</span>
                {/if}
                <!-- Quick rating buttons in detailed mode -->
                <div class="quick-buttons-mini">
                    <button
                        class="mini-btn thumbs-down"
                        onclick={() => handleQuickRating('thumbs-down')}
                        disabled={loading || disabled}
                        aria-label={m.rating_dislike_short()}
                        title={m.rating_dislike_short()}>
                        <Icon src={HandThumbDown} class="w-3 h-3" />
                    </button>
                    <button
                        class="mini-btn thumbs-up"
                        onclick={() => handleQuickRating('thumbs-up')}
                        disabled={loading || disabled}
                        aria-label={m.rating_like_short()}
                        title={m.rating_like_short()}>
                        <Icon src={HandThumbUp} class="w-3 h-3" />
                    </button>
                    <button
                        class="mini-btn love"
                        onclick={() => handleQuickRating('love')}
                        disabled={loading || disabled}
                        aria-label={m.rating_love_short()}
                        title={m.rating_love_short()}>
                        <Icon src={Heart} class="w-3 h-3" />
                    </button>
                </div>
            </div>
        {:else}
            <div class="stars-below">
                <DetailedRatingPanel
                    initialRating={detailedRating}
                    disabled={loading || disabled}
                    onsubmit={handleDetailedSubmit} />
            </div>
        {/if}
    {/if}

    {#if loading}
        <div class="loading-indicator">
            <div class="spinner"></div>
        </div>
    {/if}

    {#if showToast}
        <div class="toast {showToast ? 'show' : ''}">
            {toastMessage}
        </div>
    {/if}
</div>

<style>
    .ai-rating-container {
        position: relative;
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        gap: 0.75rem;
    }

    .super-button-row {
        display: flex;
        justify-content: center;
        align-items: center;
    }

    .primary-rating-buttons {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
        justify-content: center;
        align-items: center;
    }

    .compact-rating-buttons {
        display: flex;
        gap: 0.5rem;
        justify-content: center;
        align-items: center;
        /* Wrap instead of overflowing in the narrow modal/for-you footer. */
        flex-wrap: wrap;
    }

    .compact-btn {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 0.5rem;
        padding: 0.5rem;
        font-size: 1.25rem;
        cursor: pointer;
        transition: all 0.2s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 2.5rem;
        height: 2.5rem;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    }

    .compact-btn:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.2);
        border-color: rgba(255, 255, 255, 0.3);
        transform: translateY(-1px);
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
    }

    .compact-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .compact-btn.active {
        color: white;
        font-weight: 500;
    }

    .compact-btn.thumbs-down.active {
        background: #ef4444;
        border-color: #ef4444;
    }

    .compact-btn.thumbs-up.active {
        background: #3b82f6;
        border-color: #3b82f6;
    }

    .compact-btn.love.active {
        background: #ec4899;
        border-color: #ec4899;
    }

    .compact-btn.toggle-detailed {
        background: rgba(234, 179, 8, 0.15);
        border-color: rgba(234, 179, 8, 0.3);
    }

    .compact-btn.toggle-detailed:hover:not(:disabled) {
        background: rgba(234, 179, 8, 0.25);
        border-color: rgba(234, 179, 8, 0.5);
    }

    .compact-btn.toggle-detailed.has-rating {
        background: rgba(234, 179, 8, 0.2);
        border-color: rgba(234, 179, 8, 0.4);
    }

    .star-with-rating {
        display: flex;
        align-items: center;
        gap: 0.125rem;
        font-size: 1rem;
    }

    .rating-number {
        font-size: 0.625rem;
        font-weight: 600;
        color: #fbbf24;
        min-width: 0.75rem;
        text-align: center;
    }

    .primary-btn {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 0.75rem;
        padding: 0.5rem 1rem;
        font-size: 1.25rem;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.3s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        white-space: nowrap;
        color: rgba(255, 255, 255, 0.9);
        min-width: 3.5rem;
        min-height: 2.75rem;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    }

    /* Larger touch targets on mobile */
    @media (max-width: 640px) {
        .primary-btn {
            min-width: 4rem;
            min-height: 3rem;
            font-size: 1.5rem;
            padding: 0.5rem 0.75rem;
        }
    }

    .primary-btn:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.2);
        border-color: rgba(255, 255, 255, 0.3);
        transform: translateY(-2px);
        box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
    }

    .primary-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .primary-btn.active {
        color: white;
        font-weight: 500;
    }

    .thumbs-down.active {
        background: #ef4444;
        border-color: #ef4444;
    }

    .thumbs-up.active {
        background: #3b82f6;
        border-color: #3b82f6;
    }

    .primary-btn.meh.active {
        background: #6b7280;
        border-color: #6b7280;
    }

    .love.active {
        background: #ec4899;
        border-color: #ec4899;
    }

    /* Visible text labels next to emoji */
    .primary-btn-label,
    .rate-btn-label {
        font-size: 0.875rem;
        font-weight: 600;
        margin-left: 0.25rem;
    }

    .super-btn {
        background: linear-gradient(135deg, rgba(236, 72, 153, 0.15), rgba(168, 85, 247, 0.15));
        border: 1px solid rgba(236, 72, 153, 0.3);
        border-radius: 0.5rem;
        padding: 0.5rem 1rem;
        font-size: 0.875rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        white-space: nowrap;
        color: rgba(255, 255, 255, 0.8);
        min-width: 4rem;
        box-shadow: 0 1px 3px rgba(236, 72, 153, 0.1);
    }

    .super-btn:hover:not(:disabled) {
        background: linear-gradient(135deg, rgba(236, 72, 153, 0.25), rgba(168, 85, 247, 0.25));
        border-color: rgba(236, 72, 153, 0.4);
        transform: translateY(-1px);
        box-shadow: 0 3px 6px rgba(236, 72, 153, 0.15);
    }

    .super-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .super-btn.active {
        background: linear-gradient(135deg, rgba(236, 72, 153, 0.4), rgba(168, 85, 247, 0.4));
        border-color: rgba(236, 72, 153, 0.6);
        color: white;
        font-weight: 600;
        box-shadow: 0 2px 8px rgba(236, 72, 153, 0.2);
    }

    .stars-below {
        margin-top: 0.75rem;
    }

    .loading-indicator {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 1.5rem;
        height: 1.5rem;
    }

    .spinner {
        width: 1rem;
        height: 1rem;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top: 2px solid white;
        border-radius: 50%;
        animation: spin 1s linear infinite;
    }

    @keyframes spin {
        0% {
            transform: rotate(0deg);
        }
        100% {
            transform: rotate(360deg);
        }
    }

    .toast {
        position: absolute;
        top: 100%;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.9);
        color: white;
        padding: 0.5rem 1rem;
        border-radius: 0.375rem;
        font-size: 0.875rem;
        white-space: nowrap;
        z-index: 1000;
        opacity: 0;
        transition: opacity 0.2s ease;
        pointer-events: none;
        margin-top: 0.5rem;
    }

    .toast.show {
        opacity: 1;
    }

    .toast::before {
        content: '';
        position: absolute;
        bottom: 100%;
        left: 50%;
        transform: translateX(-50%);
        width: 0;
        height: 0;
        border-left: 5px solid transparent;
        border-right: 5px solid transparent;
        border-bottom: 5px solid rgba(0, 0, 0, 0.9);
    }

    /* Compact 10-star row for modal context */
    .compact-stars-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 0.5rem;
        padding: 0.375rem 0.5rem;
    }

    .back-to-simple {
        background: none;
        border: none;
        color: rgba(255, 255, 255, 0.5);
        font-size: 1rem;
        cursor: pointer;
        padding: 0.25rem;
        border-radius: 0.25rem;
        transition: all 0.2s ease;
        line-height: 1;
    }

    .back-to-simple:hover {
        background: rgba(255, 255, 255, 0.1);
        color: rgba(255, 255, 255, 0.8);
    }

    .compact-stars {
        display: flex;
        gap: 0;
    }

    .compact-star {
        background: none;
        border: none;
        color: rgba(255, 255, 255, 0.2);
        font-size: 0.875rem;
        cursor: pointer;
        padding: 0.125rem;
        transition: all 0.15s ease;
        line-height: 1;
    }

    .compact-star:hover:not(:disabled) {
        transform: scale(1.2);
    }

    .compact-star:disabled {
        cursor: not-allowed;
        opacity: 0.5;
    }

    .compact-star.filled {
        color: #fbbf24;
        text-shadow: 0 0 4px rgba(251, 191, 36, 0.4);
    }

    .compact-rating-label {
        font-size: 0.75rem;
        color: rgba(255, 255, 255, 0.6);
        min-width: 2rem;
        text-align: right;
    }

    /* Mini quick buttons in detailed mode */
    .quick-buttons-mini {
        display: flex;
        gap: 0.25rem;
        margin-left: 0.25rem;
        padding-left: 0.5rem;
        border-left: 1px solid rgba(255, 255, 255, 0.1);
    }

    .mini-btn {
        background: none;
        border: none;
        font-size: 0.75rem;
        cursor: pointer;
        padding: 0.125rem 0.25rem;
        border-radius: 0.25rem;
        transition: all 0.15s ease;
        opacity: 0.5;
    }

    .mini-btn:hover:not(:disabled) {
        opacity: 1;
        background: rgba(255, 255, 255, 0.1);
        transform: scale(1.1);
    }

    .mini-btn:disabled {
        cursor: not-allowed;
        opacity: 0.3;
    }

    /* Smaller stars on mobile */
    @media (max-width: 640px) {
        .compact-star {
            font-size: 0.75rem;
            padding: 0.0625rem;
        }

        .compact-stars-row {
            padding: 0.25rem 0.375rem;
            gap: 0.375rem;
            flex-wrap: wrap;
        }

        .compact-rating-label {
            font-size: 0.625rem;
            min-width: 1.5rem;
        }

        .quick-buttons-mini {
            margin-left: 0;
            padding-left: 0;
            border-left: none;
            padding-top: 0.25rem;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            width: 100%;
            justify-content: center;
        }
    }

    /* Rate Mode Layout - Love on top, thumbs + star below */
    .rate-mode-buttons {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.5rem;
    }

    .rate-mode-top {
        display: flex;
        justify-content: center;
    }

    .rate-mode-bottom {
        display: flex;
        gap: 0.375rem;
        justify-content: center;
        align-items: center;
        /* Wrap instead of overflowing the narrow rate-mode column (lg:w-48 = 192px).
           Long localized labels (e.g. DE "Nichts für mich" + "Interessiert", or the
           4-button seen row) exceed the column width and would otherwise be clipped
           by the card's overflow-hidden. */
        flex-wrap: wrap;
    }

    .rate-btn {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 0.5rem;
        padding: 0.5rem 0.75rem;
        font-size: 1.25rem;
        cursor: pointer;
        transition: all 0.3s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 2.75rem;
        min-height: 2.5rem;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    }

    .rate-btn:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.2);
        border-color: rgba(255, 255, 255, 0.3);
        transform: translateY(-1px);
        box-shadow: 0 3px 6px rgba(0, 0, 0, 0.15);
    }

    .rate-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .rate-btn.active {
        color: white;
        font-weight: 500;
    }

    .rate-btn.thumbs-down.active {
        background: #ef4444;
        border-color: #ef4444;
    }

    .rate-btn.thumbs-up.active {
        background: #3b82f6;
        border-color: #3b82f6;
    }

    .rate-btn.meh.active {
        background: #6b7280;
        border-color: #6b7280;
    }

    .rate-btn.love {
        background: linear-gradient(135deg, rgba(236, 72, 153, 0.15), rgba(168, 85, 247, 0.15));
        border: 1px solid rgba(236, 72, 153, 0.3);
        font-size: 1.5rem;
        min-width: 3.5rem;
        min-height: 3rem;
    }

    .rate-btn.love:hover:not(:disabled) {
        background: linear-gradient(135deg, rgba(236, 72, 153, 0.25), rgba(168, 85, 247, 0.25));
        border-color: rgba(236, 72, 153, 0.4);
        box-shadow: 0 3px 8px rgba(236, 72, 153, 0.2);
    }

    .rate-btn.love.active {
        background: linear-gradient(135deg, rgba(236, 72, 153, 0.4), rgba(168, 85, 247, 0.4));
        border-color: rgba(236, 72, 153, 0.6);
        box-shadow: 0 2px 8px rgba(236, 72, 153, 0.2);
    }

    .rate-btn.toggle-detailed {
        background: rgba(234, 179, 8, 0.15);
        border-color: rgba(234, 179, 8, 0.3);
        font-size: 1rem;
        min-width: 2.5rem;
        min-height: 2.25rem;
    }

    .rate-btn.toggle-detailed:hover:not(:disabled) {
        background: rgba(234, 179, 8, 0.25);
        border-color: rgba(234, 179, 8, 0.5);
    }

    .rate-btn.toggle-detailed.has-rating {
        background: rgba(234, 179, 8, 0.2);
        border-color: rgba(234, 179, 8, 0.4);
    }

    .rate-btn .star-with-rating {
        display: flex;
        align-items: center;
        gap: 0.125rem;
        font-size: 0.875rem;
    }

    .rate-btn .rating-number {
        font-size: 0.625rem;
        font-weight: 600;
        color: #fbbf24;
    }

    /* Rate mode mobile adjustments */
    @media (max-width: 640px) {
        .rate-mode-buttons {
            gap: 0.375rem;
        }

        .rate-mode-bottom {
            gap: 0.25rem;
        }

        .rate-btn {
            padding: 0.375rem 0.5rem;
            font-size: 1.125rem;
            min-width: 2.5rem;
            min-height: 2.25rem;
        }

        .rate-btn.love {
            font-size: 1.25rem;
            min-width: 3rem;
            min-height: 2.5rem;
        }

        .rate-btn.toggle-detailed {
            font-size: 0.875rem;
            min-width: 2.25rem;
            min-height: 2rem;
        }
    }
</style>
