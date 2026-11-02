// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure decisions behind ModalMovie.svelte, kept out of the component so they
 * can be unit-tested without mounting the modal and its data layer.
 */

import { toPublicMediaType } from '$lib/shared/media-type-domain';

/**
 * The series "Watched" button may toggle the WHOLE series only when no specific
 * episode is in context. Season 0 (specials) and episode 0 are real episodes,
 * so this checks for absence, never falsiness.
 */
export function shouldBulkToggleSeries(
    seasonNumber: number | null | undefined,
    episodeNumber: number | null | undefined,
): boolean {
    return seasonNumber == null || episodeNumber == null;
}

/** Year prop (string or number) → finite number, or undefined. */
export function parseYear(year: string | number | null | undefined): number | undefined {
    if (year == null || year === '') return undefined;
    const n = typeof year === 'number' ? year : Number(year);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Display string for one non-entertainment custom-metadata value. Structured
 * values (objects, arrays of non-strings) are formatted rather than handed to
 * the template, which would render them as "[object Object]".
 */
export function formatCustomMetadataValue(
    value: unknown,
    fieldType: string,
    labels: { yes: string; no: string },
): string {
    if (fieldType === 'boolean') return value ? labels.yes : labels.no;
    if (Array.isArray(value)) {
        return value
            .filter((v) => v != null && v !== '')
            .map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v)))
            .join(', ');
    }
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === 'object' && value !== null) return JSON.stringify(value);
    return String(value);
}

export type SwipeType = 'none' | 'down' | 'back';

/** Movement below this (px, both axes) is not yet a gesture. */
export const SWIPE_DEADZONE = 8;
/** Past this distance (px) a movement that is no swipe is final: a scroll. */
export const SWIPE_DECIDE_DISTANCE = 16;
/** Swipe-back must start within this many px of the left edge. */
export const SWIPE_BACK_EDGE = 25;

/**
 * Classify a touch gesture ONCE, on its first movement past the dead zone.
 *
 * `null` means "still inside the dead zone, decide later". `'none'` is a final
 * answer for this touch: the caller must not re-classify, or a scroll that
 * reaches the top mid-drag turns into a swipe-down-to-close. Swipe-down needs
 * the scroll area to have been at the top when the touch STARTED.
 */
export function classifySwipe(input: {
    startX: number;
    dx: number;
    dy: number;
    hasHistory: boolean;
    scrollTopAtStart: number;
}): SwipeType | null {
    const absDx = Math.abs(input.dx);
    const absDy = Math.abs(input.dy);
    if (absDx < SWIPE_DEADZONE && absDy < SWIPE_DEADZONE) return null;
    if (input.startX < SWIPE_BACK_EDGE && input.hasHistory && absDx > absDy && input.dx > 0) {
        return 'back';
    }
    if (input.dy > 0 && absDy > absDx && input.scrollTopAtStart <= 0) return 'down';
    // A jittery first sample must not latch "scroll" for the whole touch: only
    // decide 'none' once the movement is clearly past the dead zone.
    if (Math.max(absDx, absDy) < SWIPE_DECIDE_DISTANCE) return null;
    return 'none';
}

/**
 * True when a keydown is the bare `T` trailer shortcut. Modified (browser/OS
 * shortcuts such as Cmd+T), auto-repeated and already-handled presses are not.
 */
export function isTrailerShortcut(e: {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    repeat: boolean;
    defaultPrevented: boolean;
}): boolean {
    if (e.key !== 't' && e.key !== 'T') return false;
    return !(e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.defaultPrevented);
}

/** Identity handed to plugin detail widgets (ModalBody `pluginItem`). */
export interface PluginDetailItem {
    id: string;
    mediaType: string;
    title: string;
    year: number | null;
    externalIds: { tmdb?: string; imdb?: string; tvdb?: string };
}

/**
 * Build the plugin detail identity. Null until there is an internal id — the
 * only stable key a plugin may store. `mediaType` is converted to the PUBLIC
 * vocabulary ('movie' | 'series' | …) that widgets declare in `forMediaTypes`;
 * the modal receives it upper-cased ('MOVIE', 'TV').
 */
export function buildPluginDetailItem(input: {
    internalId: string | null | undefined;
    mediaType: string | null | undefined;
    title: string;
    year: string | number | null | undefined;
    externalIds: { tmdb?: unknown; imdb?: unknown; tvdb?: unknown } | null | undefined;
}): PluginDetailItem | null {
    if (!input.internalId) return null;
    const ids = input.externalIds;
    return {
        id: input.internalId,
        mediaType: toPublicMediaType(input.mediaType) ?? (input.mediaType ?? '').toLowerCase(),
        title: input.title,
        year: parseYear(input.year) ?? null,
        externalIds: {
            tmdb: ids?.tmdb ? String(ids.tmdb) : undefined,
            imdb: ids?.imdb ? String(ids.imdb) : undefined,
            tvdb: ids?.tvdb ? String(ids.tvdb) : undefined,
        },
    };
}

/**
 * In-app href for playing a movie chapter. Same shape as `navigateToWatch`
 * builds for a plain click, so a new-tab click and a plain click open the same
 * URL. Keys are UUIDs or `provider:id:type` composites, which need no encoding.
 */
export function chapterWatchPath(mediaKey: string, startSeconds: number): string {
    return `/watch/${mediaKey}?t=${Math.max(0, Math.floor(startSeconds))}`;
}

/** A plain left click (no modifier, primary button) — anything else keeps the browser default. */
export function isPlainLeftClick(e: {
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
}): boolean {
    return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
