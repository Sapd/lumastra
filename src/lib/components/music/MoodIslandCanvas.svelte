<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  MoodIslandCanvas — self-halting Canvas2D mood island visualisation.

  - Anchors are fixed positions derived from the brew response.
  - Dots only fade/resize between brews; they never teleport.
  - The rAF loop halts automatically once all animations have settled.
  - No external dependencies; uses only the Web Canvas2D API.
  - Animation state is kept in plain mutable objects (not $state) because
    the rAF loop updates them 60 times/sec — Svelte reactivity is not needed
    inside the animation loop.
-->

<script lang="ts">
    import type { MoodIslandAnchor } from '$lib/schemas/music-alchemy';
    import { onDestroy } from 'svelte';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        anchors: MoodIslandAnchor[];
        /** Canvas width (pixels, default 280) */
        width?: number;
        /** Canvas height (pixels, default 180) */
        height?: number;
        /**
         * Whether a brew has completed. Distinguishes the "you haven't brewed
         * yet" empty state from the "brewed but these tracks carry no mood
         * data" empty state, so an empty anchor set is never a silent black box.
         */
        hasBrewed?: boolean;
    }

    let { anchors, width = 280, height = 180, hasBrewed = false }: Props = $props();

    let canvasEl: HTMLCanvasElement | undefined = $state();

    // Internal animation state per anchor — plain objects, NOT $state, because
    // the draw loop mutates them 60fps and we don't want Svelte tracking.
    interface DotState {
        label: string;
        x: number;
        y: number;
        color: string;
        targetRadius: number;
        currentRadius: number;
        targetAlpha: number;
        currentAlpha: number;
    }

    // Module-level mutable arrays (not reactive)
    let activeDots: DotState[] = [];
    let rafId: number | null = null;
    let destroyed = false;

    const BASE_RADIUS = 14;
    const MAX_RADIUS = 36;
    const LERP_SPEED = 0.08;
    const SETTLE_EPSILON = 0.01;

    function radiusFromSize(size: number): number {
        return Math.min(MAX_RADIUS, BASE_RADIUS + Math.log1p(size) * 3);
    }

    function lerp(a: number, b: number, t: number): number {
        return a + (b - a) * t;
    }

    function syncDots(nextAnchors: MoodIslandAnchor[]): void {
        const anchorLabels = new Set(nextAnchors.map((a) => a.label));

        // Update or create dots for current anchors
        const nextDots: DotState[] = nextAnchors.map((a) => {
            const existing = activeDots.find((d) => d.label === a.label);
            return {
                label: a.label,
                x: a.x * width,
                y: a.y * height,
                color: a.color,
                targetRadius: radiusFromSize(a.size),
                currentRadius: existing?.currentRadius ?? 0,
                targetAlpha: 1,
                currentAlpha: existing?.currentAlpha ?? 0,
            };
        });

        // Keep fading-out dots for removed anchors
        const fadingDots: DotState[] = activeDots
            .filter((d) => !anchorLabels.has(d.label))
            .map((d) => ({ ...d, targetAlpha: 0, targetRadius: 0 }));

        activeDots = [...nextDots, ...fadingDots];
    }

    function draw(): void {
        if (!canvasEl) {
            // Canvas not mounted yet (it lives inside an {#if} that only renders
            // once anchors are non-empty). Release the frame handle so a later
            // startLoop() — fired when canvasEl actually binds — can restart the
            // loop. Without this reset rafId stays non-null and the loop is dead.
            rafId = null;
            return;
        }
        const ctx = canvasEl.getContext('2d');
        if (!ctx) return;

        ctx.clearRect(0, 0, width, height);

        let allSettled = true;

        for (let i = 0; i < activeDots.length; i++) {
            const d = activeDots[i];
            d.currentRadius = lerp(d.currentRadius, d.targetRadius, LERP_SPEED);
            d.currentAlpha = lerp(d.currentAlpha, d.targetAlpha, LERP_SPEED);

            if (
                Math.abs(d.currentRadius - d.targetRadius) > SETTLE_EPSILON ||
                Math.abs(d.currentAlpha - d.targetAlpha) > SETTLE_EPSILON
            ) {
                allSettled = false;
            }
        }

        // Remove fully faded-out removed dots
        activeDots = activeDots.filter((d) => !(d.targetAlpha === 0 && d.currentAlpha < 0.02));

        for (const d of activeDots) {
            if (d.currentAlpha < 0.01 || d.currentRadius < 1) continue;
            ctx.save();

            const safe = /^#[0-9a-f]{6}$/i.test(d.color) ? d.color : '#64748b';

            // Glow layer
            ctx.shadowColor = safe;
            ctx.shadowBlur = d.currentRadius * 1.4;
            ctx.globalAlpha = d.currentAlpha * 0.3;
            ctx.beginPath();
            ctx.arc(d.x, d.y, d.currentRadius * 1.3, 0, Math.PI * 2);
            ctx.fillStyle = safe;
            ctx.fill();

            // Dot body
            ctx.shadowBlur = 0;
            ctx.globalAlpha = d.currentAlpha;
            ctx.beginPath();
            ctx.arc(d.x, d.y, d.currentRadius, 0, Math.PI * 2);
            const gradient = ctx.createRadialGradient(
                d.x - d.currentRadius * 0.3,
                d.y - d.currentRadius * 0.3,
                0,
                d.x,
                d.y,
                d.currentRadius,
            );
            gradient.addColorStop(0, safe + 'ee');
            gradient.addColorStop(1, safe + '88');
            ctx.fillStyle = gradient;
            ctx.fill();

            // Label (only when large enough)
            if (d.currentRadius > 10) {
                ctx.globalAlpha = d.currentAlpha * 0.9;
                ctx.fillStyle = '#fff';
                ctx.font = `600 ${Math.round(d.currentRadius * 0.4)}px system-ui,sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(d.label, d.x, d.y, d.currentRadius * 1.8);
            }

            ctx.restore();
        }

        if (allSettled || activeDots.length === 0) {
            rafId = null;
            return; // loop self-halts
        }

        if (!destroyed) {
            rafId = requestAnimationFrame(draw);
        }
    }

    function startLoop(): void {
        if (rafId !== null || destroyed) return;
        rafId = requestAnimationFrame(draw);
    }

    // Sync animation targets whenever anchors prop changes.
    $effect(() => {
        // Depend on BOTH `anchors` and `canvasEl`. The <canvas> lives inside an
        // {#if anchors.length} block, so on the first brew it binds a tick AFTER
        // anchors flip from empty → populated. Reading canvasEl here re-runs this
        // effect once the element actually mounts, guaranteeing the loop starts
        // with a live canvas instead of racing the first rAF against the bind.
        const snapshot = anchors.slice();
        const el = canvasEl;
        syncDots(snapshot);
        if (el) startLoop();
    });

    onDestroy(() => {
        destroyed = true;
        if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
    });
</script>

<div class="island-wrap" style="width:{width}px;height:{height}px;">
    {#if anchors.length === 0}
        <p class="empty-hint">
            {hasBrewed ? m.music_alchemy_islands_no_mood() : m.music_alchemy_islands_empty()}
        </p>
    {:else}
        <canvas
            bind:this={canvasEl}
            {width}
            {height}
            class="island-canvas"
            aria-label="Mood island map with {anchors.length} clusters"></canvas>
    {/if}
</div>

<style>
    .island-wrap {
        position: relative;
        background: rgb(2 6 23 / 0.8);
        border-radius: 0.75rem;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .island-canvas {
        display: block;
    }

    .empty-hint {
        font-size: 0.65rem;
        color: rgb(71 85 105);
        text-align: center;
        padding: 0.5rem;
    }
</style>
