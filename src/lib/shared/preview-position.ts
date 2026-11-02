// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Preview start-position heuristic — SHARED between client and server.
 *
 * Lives in `shared/` deliberately: the web player computes this locally, and
 * the preview API computes it for clients that don't (tvOS, and any future
 * client). Two implementations of this heuristic WILL drift — the hero and the
 * hover card already diverged once, and that divergence was the bug where every
 * unwatched movie preview opened on the distributor logo reel. One copy only.
 *
 * @module shared/preview-position
 */

/**
 * Blind start offset for previews when runtime is unknown, so no
 * runtime-proportional guard can be computed.
 *
 * Distributor/studio logo cards routinely run 30-90s on movies, so the previous
 * 30s default dropped the viewer squarely onto a studio ident. This is
 * deliberately past that window while staying inside the body of anything
 * longer than a few minutes.
 */
export const PREVIEW_FALLBACK_START_SECONDS = 120;

const SMART_PREVIEW_FRACTIONS = [0.22, 0.28, 0.34, 0.4, 0.46, 0.52] as const;

export type SmartPreviewPositionInput = {
    progress?: number;
    runtimeMinutes?: number;
    itemKey?: string;
    fallbackSeconds?: number;
};

function hashString(value: string): number {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
        hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
    }
    return hash;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

/**
 * Calculates resume position in seconds from progress percentage.
 *
 * @param progress        Progress percentage (0-100)
 * @param runtimeMinutes  Total runtime in minutes
 * @param fallbackSeconds Fallback if no progress (e.g., startOffset)
 */
export function calculateResumePosition(
    progress: number | undefined,
    runtimeMinutes: number | undefined,
    fallbackSeconds = 0,
): number {
    if (progress && progress > 0 && runtimeMinutes) {
        const durationSeconds = runtimeMinutes * 60;
        return Math.floor((progress / 100) * durationSeconds);
    }
    return fallbackSeconds;
}

/**
 * Calculates the start position for hover/hero previews.
 *
 * Resume items start at the user's progress; unwatched items start at a
 * deterministic mid-content point so previews avoid logos and opening credits.
 * Deterministic in `itemKey` so the same title always previews from the same
 * spot (and so a shared preview artifact stays cache-coalescable).
 */
export function calculateSmartPreviewPosition({
    progress,
    runtimeMinutes,
    itemKey,
    fallbackSeconds = PREVIEW_FALLBACK_START_SECONDS,
}: SmartPreviewPositionInput): number {
    const resumePosition = calculateResumePosition(progress, runtimeMinutes, -1);
    if (resumePosition >= 0) return resumePosition;

    const runtimeSeconds =
        typeof runtimeMinutes === 'number' && Number.isFinite(runtimeMinutes)
            ? runtimeMinutes * 60
            : 0;

    if (runtimeSeconds <= 0) return Math.max(0, fallbackSeconds);

    const hash = itemKey ? hashString(itemKey) : 0;
    const fraction = SMART_PREVIEW_FRACTIONS[hash % SMART_PREVIEW_FRACTIONS.length];

    const introGuardSeconds = clamp(runtimeSeconds * 0.12, 60, 10 * 60);
    const outroGuardSeconds = clamp(runtimeSeconds * 0.15, 2 * 60, 15 * 60);
    const maxStart = Math.max(introGuardSeconds, runtimeSeconds - outroGuardSeconds);
    const candidate = Math.floor(runtimeSeconds * fraction);

    return Math.floor(clamp(candidate, introGuardSeconds, maxStart));
}
