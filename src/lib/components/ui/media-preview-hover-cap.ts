/*
 * SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { isRecord } from '$lib/utils/data-extraction';

/**
 * media-preview-hover-cap.ts
 *
 * Pure decision logic for MediaPreviewPlayer's hover-loop total-time cap
 * (`PREVIEW_HOVER_MAX_SECONDS`). Extracted out of the component so the
 * cap/rearm/expire branch can be unit-tested without mounting a component,
 * faking `<video>` playback, or faking timers.
 *
 * The (non-hero) hover preview is allowed to keep looping its short
 * transcoded snippet indefinitely UNTIL its cumulative elapsed play time
 * reaches `hoverMaxSeconds`. At that point:
 *  - if the pointer is still resting on the preview, the window re-arms
 *    (the viewer is actively engaged, so keep looping);
 *  - otherwise the preview should stop and hand off to the existing
 *    error/backdrop-transition path (MediaPreviewPlayer's
 *    `handleErrorWithCleanup`, which is what the parent `MediaHoverCard`
 *    already uses to swap the video back to a still backdrop image).
 */

export type HoverLoopCapDecision = 'continue' | 'rearm' | 'expire';

/**
 * @param elapsedSeconds Wall-clock seconds since the current hover-cap
 *   window started (reset to 0 each time the window re-arms).
 * @param hoverMaxSeconds The configured cap (`PREVIEW_HOVER_MAX_SECONDS`).
 *   A non-positive value disables the cap entirely (always `'continue'`) —
 *   callers should also gate whether this function is consulted at all via
 *   a separate "is capping active" check, but the guard here keeps the
 *   function safe to call unconditionally.
 * @param isPointerOverPreview Whether the pointer is currently resting on
 *   the preview's own DOM. This is the component's own, narrower hover
 *   signal — distinct from the parent popup's coarser "still open" state,
 *   which can remain true even after the pointer has left the video area
 *   (e.g. resting on the title/actions region below it).
 */
export function decideHoverLoopCap(
    elapsedSeconds: number,
    hoverMaxSeconds: number,
    isPointerOverPreview: boolean,
): HoverLoopCapDecision {
    if (hoverMaxSeconds <= 0 || elapsedSeconds < hoverMaxSeconds) {
        return 'continue';
    }
    return isPointerOverPreview ? 'rearm' : 'expire';
}

/**
 * Reads `PREVIEW_HOVER_MAX_SECONDS` off the hydrated `page.data.hover` blob,
 * falling back to `fallback` only when the value hasn't hydrated yet (not a
 * record, missing, or not a finite number) — NOT when it is a real `0`.
 * `decideHoverLoopCap` already treats a non-positive cap as "disabled"
 * (always `'continue'`), so a genuine `PREVIEW_HOVER_MAX_SECONDS=0` must be
 * allowed to pass through as `0` rather than being silently coerced back up
 * to the default 60s — otherwise there is no way for an operator to disable
 * the hover loop cap.
 *
 * @param hoverData `page.data.hover`, expected shape `{ maxSeconds: number }`.
 * @param fallback Value to use only while `hoverData` hasn't hydrated yet.
 */
export function readHoverMaxSeconds(hoverData: unknown, fallback: number): number {
    if (
        isRecord(hoverData) &&
        typeof hoverData.maxSeconds === 'number' &&
        Number.isFinite(hoverData.maxSeconds)
    ) {
        return hoverData.maxSeconds;
    }
    return fallback;
}
