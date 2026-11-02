<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Presentational action bar for the /rate trainer: the four semantic quick
  buttons (Not for me / Meh / Liked / Loved), Skip, Undo (shown only while
  `undoable`), and a stars toggle that reveals a 1-10 exact-rating row.
  Props in, events out — no API/store imports.
-->
<script lang="ts">
    import {
        Icon,
        HandThumbDown,
        Minus,
        HandThumbUp,
        Heart,
        ChevronDoubleRight,
        ArrowUturnLeft,
        Star,
    } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        /** Show the Undo button (a completed rating is available to undo). */
        undoable?: boolean;
        /** Gate all input (e.g. while a rate/skip/undo request is in flight). */
        disabled?: boolean;
        /**
         * Whether the 1-10 star row is expanded (bindable). The page binds
         * this to suppress its own global shortcuts (arrows/M) while the
         * user is mid-star-interaction — otherwise a stray arrow key would
         * rate the front card behind the picker.
         */
        starsOpen?: boolean;
        onrate: (rating: number, style: 'quick' | 'stars') => void;
        onskip: () => void;
        onundo?: () => void;
    }

    let {
        undoable = false,
        disabled = false,
        starsOpen = $bindable(false),
        onrate,
        onskip,
        onundo,
    }: Props = $props();

    const STAR_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

    function quickRate(rating: number): void {
        if (disabled) return;
        onrate(rating, 'quick');
    }

    function starRate(rating: number): void {
        if (disabled) return;
        onrate(rating, 'stars');
        starsOpen = false;
    }

    function toggleStars(): void {
        if (disabled) return;
        starsOpen = !starsOpen;
    }

    function handleSkip(): void {
        if (disabled) return;
        onskip();
    }

    function handleUndo(): void {
        if (disabled) return;
        onundo?.();
    }

    // While the stars row is open, digit keys 1-9 map to ratings 1-9 and 0
    // maps to 10 — a faster path than clicking for keyboard users.
    function handleStarsKeydown(e: KeyboardEvent): void {
        if (disabled) return;
        // Never swallow browser/OS shortcuts (Cmd/Ctrl+1..9 tab switching etc.).
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            starsOpen = false;
            return;
        }
        if (!/^[0-9]$/.test(e.key)) return;
        const target = e.target as HTMLElement | null;
        if (target && target.closest('input, textarea, select, [contenteditable="true"]')) {
            return;
        }
        e.preventDefault();
        const digit = Number(e.key);
        starRate(digit === 0 ? 10 : digit);
    }
</script>

<svelte:window onkeydown={starsOpen ? handleStarsKeydown : undefined} />

<div class="rate-action-bar">
    <div class="rate-quick-actions">
        <button
            type="button"
            class="rate-action rate-negative flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"
            {disabled}
            onclick={() => quickRate(2)}>
            <Icon src={HandThumbDown} class="h-4 w-4" />
            {m.rating_not_for_me()}
        </button>
        <button
            type="button"
            class="rate-action rate-neutral flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"
            {disabled}
            onclick={() => quickRate(5)}>
            <Icon src={Minus} class="h-4 w-4" />
            {m.rating_meh()}
        </button>
        <button
            type="button"
            class="rate-action rate-positive flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"
            {disabled}
            onclick={() => quickRate(8)}>
            <Icon src={HandThumbUp} class="h-4 w-4" />
            {m.rating_liked()}
        </button>
        <button
            type="button"
            class="rate-action rate-loved flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"
            {disabled}
            onclick={() => quickRate(10)}>
            <Icon src={Heart} class="h-4 w-4" solid />
            {m.rating_loved()}
        </button>
    </div>

    <div class="rate-secondary-actions">
        <button
            type="button"
            class="rate-action rate-secondary flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"
            {disabled}
            onclick={handleSkip}>
            <Icon src={ChevronDoubleRight} class="h-4 w-4" />
            {m.rating_skip()}
        </button>

        {#if undoable}
            <button
                type="button"
                class="rate-action rate-secondary flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"
                {disabled}
                onclick={handleUndo}>
                <Icon src={ArrowUturnLeft} class="h-4 w-4" />
                {m.rate_undo()}
            </button>
        {/if}

        <button
            type="button"
            class="rate-action rate-secondary flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"
            {disabled}
            aria-pressed={starsOpen}
            onclick={toggleStars}>
            <Icon src={Star} class="h-4 w-4" solid={starsOpen} />
            {m.rate_show_stars()}
        </button>
    </div>

    {#if starsOpen}
        <div
            class="flex flex-wrap items-center justify-center gap-1.5"
            role="group"
            aria-label={m.rate_show_stars()}>
            {#each STAR_VALUES as value (value)}
                <button
                    type="button"
                    class="flex h-11 w-11 min-h-11 min-w-11 items-center justify-center rounded-full bg-surface-700 text-sm font-semibold text-surface-100 hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
                    {disabled}
                    onclick={() => starRate(value)}
                    aria-label={m.ui_star_rating_aria({ current: String(value), max: '10' })}>
                    {value}
                </button>
            {/each}
        </div>
    {/if}
</div>

<style>
    .rate-action-bar {
        display: flex;
        width: 100%;
        max-width: 36rem;
        flex-direction: column;
        align-items: center;
        gap: 0.75rem;
    }

    .rate-quick-actions {
        display: grid;
        width: 100%;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 0.5rem;
    }

    .rate-secondary-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 0.5rem;
    }

    .rate-action {
        min-height: 44px;
        justify-content: center;
        border: 1px solid;
        border-radius: 0.75rem;
        padding: 0.625rem 0.75rem;
        font-size: 0.875rem;
        font-weight: 600;
        line-height: 1.25;
    }

    .rate-negative {
        background: #401c26;
        border-color: #be6074;
        color: #ffe4e6;
    }
    .rate-neutral {
        background: #293548;
        border-color: #8292a9;
        color: #f1f5f9;
    }
    .rate-positive {
        background: #153e30;
        border-color: #53a88a;
        color: #d1fae5;
    }
    .rate-loved {
        background: #382552;
        border-color: #a78bda;
        color: #f3e8ff;
    }
    .rate-secondary {
        background: #253044;
        border-color: #64748b;
        color: #f1f5f9;
    }

    .rate-action:hover:not(:disabled) {
        filter: brightness(1.2);
    }

    .rate-action-bar button:focus-visible {
        outline: 3px solid #bae6fd;
        outline-offset: 3px;
    }

    @media (max-width: 479px) {
        .rate-quick-actions {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }
    }
</style>
