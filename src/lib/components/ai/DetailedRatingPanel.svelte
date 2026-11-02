<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * DetailedRatingPanel - Slider and star-based rating UI
     * Extracted from AIRatingButton for reuse and cleaner separation
     */

    import * as m from '$lib/paraglide/messages';

    interface Props {
        initialRating?: number;
        disabled?: boolean;
        // Callbacks
        onsubmit?: (detail: { rating: number }) => void;
    }

    let { initialRating = 10, disabled = false, onsubmit }: Props = $props();

    let detailedRating = $derived(initialRating);
    let hoveredStar = $state(0);

    const starLabels = $derived([
        { rating: 1, label: m.star_label_1(), emoji: '😤' },
        { rating: 2, label: m.star_label_2(), emoji: '😠' },
        { rating: 3, label: m.star_label_3(), emoji: '😕' },
        { rating: 4, label: m.star_label_4(), emoji: '😐' },
        { rating: 5, label: m.star_label_5(), emoji: '😶' },
        { rating: 6, label: m.star_label_6(), emoji: '🙂' },
        { rating: 7, label: m.star_label_7(), emoji: '😊' },
        { rating: 8, label: m.star_label_8(), emoji: '😁' },
        { rating: 9, label: m.star_label_9(), emoji: '🤩' },
        { rating: 10, label: m.star_label_10(), emoji: '😍' },
    ]);

    function getStarLabel(rating: number) {
        return starLabels.find((s) => s.rating === rating) || starLabels[4];
    }

    function submitRating() {
        onsubmit?.({ rating: detailedRating });
    }

    function handleStarClick(starIndex: number) {
        detailedRating = starIndex + 1;
        submitRating();
    }
</script>

<div class="detailed-rating-panel">
    <!-- Slider UI for 10-star rating -->
    <div class="slider-container">
        <input
            type="range"
            min="1"
            max="10"
            bind:value={detailedRating}
            oninput={() => (hoveredStar = detailedRating)}
            onmouseup={submitRating}
            ontouchend={submitRating}
            class="rating-slider"
            aria-label="Rating slider (1-10 stars)"
            {disabled} />
        <div class="slider-labels">
            <span class="slider-label-left">1</span>
            <span class="slider-label-center">5</span>
            <span class="slider-label-right">10</span>
        </div>
    </div>

    <div class="rating-feedback">
        {#if hoveredStar > 0}
            {@const starInfo = getStarLabel(hoveredStar)}
            <span class="rating-text">
                {starInfo.emoji}
                {starInfo.label} ({hoveredStar}/10)
            </span>
        {:else if detailedRating > 0}
            {@const starInfo = getStarLabel(detailedRating)}
            <span class="rating-text">
                {starInfo.emoji}
                {starInfo.label} ({detailedRating}/10)
            </span>
        {/if}
    </div>

    <!-- Clickable Star display showing current rating -->
    <div
        class="stars-display"
        onmouseleave={() => (hoveredStar = 0)}
        role="group"
        aria-label="Star rating">
        {#each Array(10) as _, i (i)}
            <button
                type="button"
                class="star-icon {i < detailedRating ? 'filled' : ''} {hoveredStar > 0 &&
                i < hoveredStar
                    ? 'hovered'
                    : ''}"
                onclick={() => handleStarClick(i)}
                onmouseenter={() => (hoveredStar = i + 1)}
                aria-label="Rate {i + 1} stars"
                {disabled}>
                ⭐
            </button>
        {/each}
    </div>
</div>

<style>
    .detailed-rating-panel {
        padding: 0.75rem;
        background: rgba(0, 0, 0, 0.2);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 0.5rem;
        animation: slideDown 0.3s ease-out;
    }

    @keyframes slideDown {
        from {
            opacity: 0;
            transform: translateY(-5px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }

    .slider-container {
        width: 100%;
        padding: 1rem 0.5rem;
    }

    .rating-slider {
        width: 100%;
        height: 8px;
        border-radius: 4px;
        background: linear-gradient(to right, #ef4444 0%, #f59e0b 30%, #10b981 60%, #3b82f6 100%);
        outline: none;
        -webkit-appearance: none;
        appearance: none;
        cursor: pointer;
    }

    .rating-slider:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .rating-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: white;
        border: 3px solid rgba(59, 130, 246, 0.8);
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        transition: all 0.2s ease;
    }

    .rating-slider::-webkit-slider-thumb:hover {
        transform: scale(1.2);
        box-shadow: 0 3px 12px rgba(0, 0, 0, 0.4);
    }

    .rating-slider::-moz-range-thumb {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: white;
        border: 3px solid rgba(59, 130, 246, 0.8);
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        transition: all 0.2s ease;
    }

    .rating-slider::-moz-range-thumb:hover {
        transform: scale(1.2);
        box-shadow: 0 3px 12px rgba(0, 0, 0, 0.4);
    }

    @media (max-width: 640px) {
        .rating-slider {
            height: 12px;
        }
        .rating-slider::-webkit-slider-thumb {
            width: 36px;
            height: 36px;
        }
        .rating-slider::-moz-range-thumb {
            width: 36px;
            height: 36px;
        }
    }

    .slider-labels {
        display: flex;
        justify-content: space-between;
        margin-top: 0.25rem;
        font-size: 0.75rem;
        color: rgba(255, 255, 255, 0.6);
    }

    .stars-display {
        display: flex;
        gap: 0.125rem;
        justify-content: center;
        margin-top: 0.5rem;
    }

    .star-icon {
        font-size: 1.25rem;
        opacity: 0.3;
        transition: all 0.2s ease;
        background: none;
        border: none;
        padding: 0.25rem;
        cursor: pointer;
        border-radius: 0.25rem;
    }

    .star-icon:disabled {
        cursor: not-allowed;
    }

    @media (max-width: 640px) {
        .stars-display {
            gap: 0;
        }
        .star-icon {
            font-size: 1rem;
            padding: 0.125rem;
        }
    }

    .star-icon:hover:not(:disabled) {
        opacity: 0.8;
        transform: scale(1.2);
        background: rgba(255, 255, 255, 0.1);
    }

    .star-icon.filled {
        opacity: 1;
    }

    .star-icon.filled:hover:not(:disabled) {
        transform: scale(1.3);
    }

    .star-icon.hovered {
        opacity: 0.7;
        transform: scale(1.15);
    }

    .rating-feedback {
        text-align: center;
    }

    .rating-text {
        font-size: 0.875rem;
        color: rgba(255, 255, 255, 0.9);
        font-weight: 500;
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
    }
</style>
