<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  ConsoleKnob — a rotary knob controlled by vertical pointer drag.

  Value range [0, 1]. Drag up to increase, drag down to decrease.
  The knob rotates from -135° (0) to +135° (1).
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        /** Knob value [0, 1] */
        value?: number;
        /** Knob label */
        label?: string;
        /** Low-end label (left) */
        labelMin?: string;
        /** High-end label (right) */
        labelMax?: string;
        /** Accent color hex (default uses CSS variable) */
        color?: string;
        /** Called when value changes */
        onchange?: (v: number) => void;
        /** Pixels of drag needed to traverse the full range */
        sensitivity?: number;
    }

    let {
        value = $bindable(0.5),
        label = '',
        labelMin = '',
        labelMax = '',
        color = 'var(--color-primary-500, #7c3aed)',
        onchange,
        sensitivity = 120,
    }: Props = $props();

    const valueId = $props.id();

    // Rotate knob: -135deg at 0, +135deg at 1 → total 270deg sweep
    const MIN_DEG = -135;
    const MAX_DEG = 135;
    const deg = $derived(MIN_DEG + value * (MAX_DEG - MIN_DEG));

    let dragging = $state(false);
    let activePointerId: number | null = null;
    let startY = 0;
    let startValue = 0;
    function clamp(v: number): number {
        return Math.max(0, Math.min(1, v));
    }

    function adjustValue(delta: number): void {
        const next = clamp(value + delta);
        value = next;
        onchange?.(next);
    }

    function onPointerDown(e: PointerEvent): void {
        if (e.button !== 0 || dragging) return;
        e.preventDefault();
        dragging = true;
        activePointerId = e.pointerId;
        startY = e.clientY;
        startValue = value;
        const knob = e.currentTarget as HTMLElement;
        knob.focus();
        knob.setPointerCapture(e.pointerId);
    }

    function onPointerMove(e: PointerEvent): void {
        if (!dragging || e.pointerId !== activePointerId) return;
        e.preventDefault();
        // drag up → increase (negative dy), drag down → decrease (positive dy)
        const delta = -(e.clientY - startY) / sensitivity;
        const next = clamp(startValue + delta);
        value = next;
        onchange?.(next);
    }

    function onPointerUp(e: PointerEvent): void {
        if (!dragging || e.pointerId !== activePointerId) return;
        dragging = false;
        activePointerId = null;
        const knob = e.currentTarget as HTMLElement;
        if (knob.hasPointerCapture(e.pointerId)) knob.releasePointerCapture(e.pointerId);
    }

    function onLostPointerCapture(): void {
        dragging = false;
        activePointerId = null;
    }

    function onKeydown(e: KeyboardEvent): void {
        let next: number;
        switch (e.key) {
            case 'ArrowUp':
            case 'ArrowRight':
                next = clamp(value + 0.05);
                break;
            case 'ArrowDown':
            case 'ArrowLeft':
                next = clamp(value - 0.05);
                break;
            case 'Home':
                next = 0;
                break;
            case 'End':
                next = 1;
                break;
            default:
                return;
        }
        e.preventDefault();
        value = next;
        onchange?.(next);
    }

    // Double-click to reset to center
    function onDblClick(): void {
        value = 0.5;
        onchange?.(0.5);
    }

    // Display value as percentage
    const displayPct = $derived(Math.round(value * 100));
</script>

<div class="knob-container" title="{label}: {displayPct}%">
    <!-- Label row -->
    <div class="knob-label">{label}</div>

    <!-- The knob itself -->
    <div
        class={['knob-outer', { dragging }]}
        role="slider"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={displayPct}
        tabindex="0"
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
        onlostpointercapture={onLostPointerCapture}
        ondblclick={onDblClick}
        onkeydown={onKeydown}>
        <div class="knob-body" style="transform: rotate({deg}deg);">
            <!-- Tick indicator -->
            <div class="knob-tick" style="background: {color};"></div>
        </div>
        <!-- Value ring -->
        <svg class="knob-ring" viewBox="0 0 48 48" aria-hidden="true">
            <!-- Background arc -->
            <circle
                class="ring-bg"
                cx="24"
                cy="24"
                r="20"
                fill="none"
                stroke-width="3"
                stroke-dasharray="94.2 251"
                stroke-dashoffset="-78.5" />
            <!-- Value arc — 270° sweep, start at -135°  -->
            <circle
                class="ring-value"
                cx="24"
                cy="24"
                r="20"
                fill="none"
                stroke={color}
                stroke-width="3"
                stroke-linecap="round"
                stroke-dasharray="{value * 94.2} 251"
                stroke-dashoffset="-78.5" />
        </svg>
    </div>

    <!-- Min / Max labels -->
    <div class="knob-range">
        <span>{labelMin}</span>
        <span id={valueId} class="knob-pct" role="status" aria-live="polite" aria-atomic="true">
            <span class="sr-only">{label}: </span>{displayPct}%
        </span>
        <span>{labelMax}</span>
    </div>
    <div class="knob-adjustments">
        <button
            type="button"
            class="knob-step"
            aria-label={m.music_alchemy_knob_decrease({ label })}
            aria-describedby={valueId}
            onclick={() => adjustValue(-0.05)}>−</button>
        <button
            type="button"
            class="knob-step"
            aria-label={m.music_alchemy_knob_increase({ label })}
            aria-describedby={valueId}
            onclick={() => adjustValue(0.05)}>+</button>
    </div>
</div>

<style>
    .knob-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.25rem;
        width: 7rem;
        flex-shrink: 0;
        user-select: none;
        -webkit-user-select: none;
    }

    .knob-label {
        font-size: 0.75rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: rgb(226 232 240); /* slate-200 */
        text-align: center;
    }

    .knob-outer {
        position: relative;
        width: 4rem;
        height: 4rem;
        cursor: grab;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        outline: none;
        touch-action: none;
    }

    .knob-outer.dragging {
        cursor: grabbing;
    }

    .knob-outer:focus-visible {
        outline: 2px solid #c4b5fd;
        outline-offset: 3px;
    }

    .knob-body {
        position: relative;
        width: 2.5rem;
        height: 2.5rem;
        border-radius: 50%;
        background: radial-gradient(circle at 35% 35%, rgb(71 85 105), rgb(30 41 59));
        box-shadow:
            0 2px 8px rgb(0 0 0 / 0.5),
            inset 0 1px 0 rgb(255 255 255 / 0.08);
        display: flex;
        align-items: center;
        justify-content: center;
        transition: box-shadow 0.15s;
    }

    .knob-tick {
        position: absolute;
        top: 6px;
        left: 50%;
        transform: translateX(-50%);
        width: 3px;
        height: 8px;
        border-radius: 2px;
    }

    .knob-ring {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        transform: rotate(-135deg);
        pointer-events: none;
    }

    .ring-bg {
        stroke: rgb(51 65 85); /* slate-700 */
    }

    .knob-range {
        display: flex;
        justify-content: space-between;
        align-items: center;
        width: 100%;
        gap: 0.35rem;
        font-size: 0.75rem;
        color: rgb(203 213 225); /* slate-300 */
    }

    .knob-pct {
        font-size: 0.75rem;
        font-weight: 600;
        color: rgb(226 232 240); /* slate-200 */
    }

    .knob-adjustments {
        display: flex;
        justify-content: center;
        gap: 0.5rem;
        margin-top: 0.25rem;
    }

    .knob-step {
        display: grid;
        place-items: center;
        min-width: 44px;
        min-height: 44px;
        border: 1px solid rgb(100 116 139);
        border-radius: 0.5rem;
        background: rgb(30 41 59);
        color: rgb(226 232 240);
        font-size: 1.25rem;
        line-height: 1;
        cursor: pointer;
    }

    .knob-step:hover {
        background: rgb(51 65 85);
    }

    .knob-step:focus-visible {
        outline: 2px solid #c4b5fd;
        outline-offset: 3px;
    }
</style>
