// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `safeFlip` — a drop-in replacement for Svelte's `flip` animation that
 * no-ops on zero-area elements.
 *
 * Svelte's `flip` derives its keyframes from the element's measured geometry:
 * it divides by `to.width` / `to.height` for the scale factor and reads
 * `getComputedStyle(node).transformOrigin`. When the flipped element is
 * `display: none` (e.g. a dashboard widget-container toggled off via
 * `class:hidden` because its section reported no content), that geometry is
 * `0 × 0` and `transformOrigin` is empty — so the scale becomes `0 / 0 = NaN`
 * and the origin parses to `NaN`. The result is keyframes like
 * `transform: translate(0px, NaNpx) scale(1, NaN)`, which the browser rejects
 * with `Invalid keyframe value for property transform` (one warning per
 * animating hidden element — 21+ on a full dashboard).
 *
 * The animation is purely cosmetic for these elements (they aren't visible),
 * so we skip it entirely when either the source or target rect has no area.
 * Non-hidden reorders fall through to the real `flip` unchanged.
 */
import { flip, type FlipParams } from 'svelte/animate';
import type { AnimationConfig } from 'svelte/animate';

export function safeFlip(
    node: Element,
    timing: { from: DOMRect; to: DOMRect },
    params: FlipParams = {},
): AnimationConfig {
    const { from, to } = timing;
    if (!from.width || !from.height || !to.width || !to.height) {
        // Zero-area (display:none / not laid out) — the real flip would emit
        // NaN keyframes. Return an empty config = no animation.
        return {};
    }
    return flip(node, timing, params);
}
