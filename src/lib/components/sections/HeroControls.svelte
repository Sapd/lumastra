<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	HeroControls.svelte

	Presentational control cluster for the home-page hero carousel. Lifted out of
	HeroSection so it can render as its OWN row in the page layout (between the nav
	buttons and the footer) rather than absolutely positioned inside the hero box.

	Holds the slide DOTS (with a per-active progress ring), the WCAG 2.2.2 pause/play
	autoplay toggle, and the trailer MUTE toggle. All state is driven by props and all
	actions are routed back through callbacks — this component owns no carousel state.

	@example
	<HeroControls
		{slideCount}
		{currentIndex}
		{slideTitles}
		{autoplayActive}
		{autoplayIntervalMs}
		{paused}
		{showMute}
		{muted}
		onGoTo={(i) => hero.goTo(i)}
		onTogglePause={() => hero.togglePause()}
		onToggleMute={() => hero.toggleMute()} />
-->
<script lang="ts">
    import { Icon, PlayCircle, Pause, SpeakerWave, SpeakerXMark } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        /** Total number of slides (drives the dot count). */
        slideCount: number;
        /** Index of the currently-active slide. */
        currentIndex: number;
        /** Per-slide display titles, used for the dot aria-labels. */
        slideTitles: string[];
        /** Whether autoplay is actively rotating — gates the progress ring. */
        autoplayActive: boolean;
        /** Autoplay interval in ms — sets the progress-ring fill duration. */
        autoplayIntervalMs: number;
        /** Whether the user has explicitly paused (drives the play/pause icon). */
        paused: boolean;
        /** Whether to render the mute toggle (only when a preview has audio). */
        showMute: boolean;
        /** Current muted state of the trailer/preview. */
        muted: boolean;
        /** Jump to slide i. */
        onGoTo: (i: number) => void;
        /** Toggle the user-paused autoplay state. */
        onTogglePause: () => void;
        /** Toggle the shared trailer/preview mute state. */
        onToggleMute: () => void;
    }

    let {
        slideCount,
        currentIndex,
        slideTitles,
        autoplayActive,
        autoplayIntervalMs,
        paused,
        showMute,
        muted,
        onGoTo,
        onTogglePause,
        onToggleMute,
    }: Props = $props();

    function titleFor(index: number): string {
        return slideTitles[index] ?? '';
    }
</script>

<div class="hero-controls">
    {#if showMute}
        <button
            type="button"
            class="hero-mute"
            aria-label={muted ? m.hero_unmute_trailer() : m.hero_mute_trailer()}
            onclick={onToggleMute}>
            <Icon src={muted ? SpeakerXMark : SpeakerWave} class="h-5 w-5" aria-hidden="true" />
        </button>
    {/if}

    {#if slideCount > 1}
        <!-- WCAG 2.2.2: visible pause/play control for auto-advancing carousel -->
        <button
            type="button"
            class="hero-pause"
            aria-label={paused ? m.hero_autoplay_play() : m.hero_autoplay_pause()}
            onclick={onTogglePause}>
            <Icon src={paused ? PlayCircle : Pause} class="h-5 w-5" aria-hidden="true" />
        </button>
        <!-- role="group" (not tablist) — carousel dots have no tabpanels, so tab
             semantics would be a broken ARIA pattern. Plain buttons + aria-current
             mark the active slide while staying keyboard-operable. -->
        <div class="hero-dots" role="group" aria-label={m.hero_slides_label()}>
            {#each Array.from({ length: slideCount }, (_, i) => i) as index (index)}
                <!-- Button is the ≥24px WCAG 2.5.8 hit target; the visible dot is the
                     inner 8px span. -->
                <button
                    type="button"
                    class="hero-dot"
                    aria-current={index === currentIndex ? 'true' : undefined}
                    aria-label={m.hero_go_to_slide({ n: index + 1, title: titleFor(index) })}
                    onclick={() => onGoTo(index)}>
                    <span class="hero-dot-visual" class:is-active={index === currentIndex}>
                        {#if index === currentIndex && autoplayActive}
                            <span
                                class="hero-dot-progress"
                                style={`animation-duration:${autoplayIntervalMs}ms`}></span>
                        {/if}
                    </span>
                </button>
            {/each}
        </div>
    {/if}
</div>

<!-- svelte-ignore css_unused_selector -->
<style lang="postcss">
    /* ---- Control cluster: dots + pause/play + mute on one baseline ---- */
    .hero-controls {
        display: flex;
        align-items: center;
        gap: 0.75rem;
    }

    /* ---- Mute/unmute control ---- */
    .hero-mute {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: 9999px;
        background: rgba(0, 0, 0, 0.45);
        border: 1px solid rgba(255, 255, 255, 0.3);
        color: rgba(255, 255, 255, 0.85);
        cursor: pointer;
        padding: 0;
        transition: background 0.15s ease;
    }

    .hero-mute:hover {
        background: rgba(0, 0, 0, 0.7);
        color: #fff;
    }

    .hero-mute:focus-visible {
        outline: 2px solid rgb(var(--color-primary-400-rgb));
        outline-offset: 2px;
    }

    /* ---- Pause/play control (WCAG 2.2.2) ---- */
    .hero-pause {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: 9999px;
        background: rgba(0, 0, 0, 0.45);
        border: 1px solid rgba(255, 255, 255, 0.3);
        color: rgba(255, 255, 255, 0.85);
        cursor: pointer;
        padding: 0;
        transition: background 0.15s ease;
    }

    .hero-pause:hover {
        background: rgba(0, 0, 0, 0.7);
        color: #fff;
    }

    .hero-pause:focus-visible {
        outline: 2px solid rgb(var(--color-primary-400-rgb));
        outline-offset: 2px;
    }

    /* ---- Slide dots + progress ring ---- */
    .hero-dots {
        display: flex;
        /* Tight gap: the 24px hit targets already space the 8px visual dots apart. */
        gap: 0.125rem;
    }

    /* The BUTTON is the interactive hit target — ≥24px in both axes to satisfy
       WCAG 2.5.8 (Target Size, Minimum). It's transparent; the visible dot is the
       inner .hero-dot-visual span. */
    .hero-dot {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 24px;
        min-height: 24px;
        background: none;
        border: none;
        padding: 0;
        cursor: pointer;
    }

    .hero-dot:focus-visible {
        outline: 2px solid rgb(var(--color-primary-400-rgb));
        outline-offset: 2px;
        border-radius: 9999px;
    }

    .hero-dot-visual {
        width: 8px;
        height: 8px;
        border-radius: 9999px;
        background: rgba(255, 255, 255, 0.4);
        position: relative;
        overflow: hidden;
        transition:
            width 0.2s ease,
            background 0.2s ease;
    }

    .hero-dot-visual.is-active {
        /* Dim TRACK so the bright progress fill is visible against it (was 0.9
           white → the white fill was invisible, white-on-white). The 24px width
           still marks the dot active even when autoplay is paused (no fill). */
        background: rgba(255, 255, 255, 0.3);
        width: 24px;
    }

    .hero-dot-progress {
        position: absolute;
        inset: 0;
        background: #fff;
        border-radius: inherit;
        transform-origin: left;
        animation: hero-fill linear forwards;
    }

    @keyframes hero-fill {
        from {
            transform: scaleX(0);
        }
        to {
            transform: scaleX(1);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .hero-dot-progress {
            display: none;
        }
    }
</style>
