// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unified play-method labels and styling.
 *
 * Canonical form is the lowercase enum from `PlayMethodSchema`:
 *   'direct' | 'remux' | 'audio_transcode' | 'full_transcode' | 'audio_only'.
 *
 * Inputs from Jellyfin (`'DirectPlay' | 'DirectStream' | 'Transcode'`)
 * and the player controller's PascalCase shorthand are coerced via
 * `toPlayMethod`. The player's coarser `'Transcode'` collapses onto
 * `full_transcode` (the safer default — matches `play-session-reporter`).
 */

import type { PlayMethod } from '$lib/schemas/play-sessions';

export type { PlayMethod };

export type PlayMethodInput = string | null | undefined;

/** Normalize any incoming variant to canonical form. Returns null if unknown. */
export function toPlayMethod(value: PlayMethodInput): PlayMethod | null {
    if (!value) return null;
    switch (value.trim().toLowerCase()) {
        case 'direct':
        case 'directplay':
            return 'direct';
        case 'remux':
        case 'directstream':
            return 'remux';
        case 'audio_transcode':
            return 'audio_transcode';
        case 'transcode':
        case 'full_transcode':
            return 'full_transcode';
        // The audio-only quality rung. `audioonly` is the player's PascalCase
        // `'AudioOnly'` lowercased. Without these the reporter's
        // toPlayMethodOrDefault() silently recorded the rung as 'direct' —
        // a wrong row rather than a loud failure.
        case 'audio_only':
        case 'audioonly':
            return 'audio_only';
        default:
            return null;
    }
}

/** Same as `toPlayMethod` but falls back to `'direct'` for unknown input. */
export function toPlayMethodOrDefault(value: PlayMethodInput): PlayMethod {
    return toPlayMethod(value) ?? 'direct';
}

/** Compact pill label — `Audio TC` instead of the full form. */
export function getPlayMethodShortLabel(method: PlayMethod): string {
    switch (method) {
        case 'direct':
            return 'Direct';
        case 'remux':
            return 'Remux';
        case 'audio_transcode':
            return 'Audio TC';
        case 'full_transcode':
            return 'Transcode';
        case 'audio_only':
            return 'Audio';
    }
}

/** Verbose display label — for tables, detail panels, transcode-info strings. */
export function getPlayMethodLabel(method: PlayMethod): string {
    switch (method) {
        case 'direct':
            return 'Direct';
        case 'remux':
            return 'Remux';
        case 'audio_transcode':
            return 'Audio Transcode';
        case 'full_transcode':
            return 'Transcode';
        case 'audio_only':
            return 'Audio only';
    }
}

/** Tailwind text color class — for the rich pill style (panels/modals). */
export function getPlayMethodPillTextClass(method: PlayMethod): string {
    switch (method) {
        case 'direct':
            return 'text-emerald-300';
        case 'remux':
            return 'text-blue-300';
        case 'audio_transcode':
        case 'audio_only':
            return 'text-amber-300';
        case 'full_transcode':
            return 'text-red-300';
    }
}

/** Tailwind background + border classes — pairs with `getPlayMethodPillTextClass`. */
export function getPlayMethodPillBgClass(method: PlayMethod): string {
    switch (method) {
        case 'direct':
            return 'border-emerald-700/40 bg-emerald-900/30';
        case 'remux':
            return 'border-blue-700/40 bg-blue-900/30';
        case 'audio_transcode':
        case 'audio_only':
            return 'border-amber-700/40 bg-amber-900/30';
        case 'full_transcode':
            return 'border-red-700/40 bg-red-900/30';
    }
}

/** Single-shot pill classes — text + border + bg, suitable for inline pills. */
export function getPlayMethodPillClasses(method: PlayMethod): string {
    return `${getPlayMethodPillTextClass(method)} ${getPlayMethodPillBgClass(method)}`;
}

/** Tailwind text color — flatter palette used by the playback-quality dashboard. */
export function getPlayMethodStatTextClass(method: PlayMethod): string {
    switch (method) {
        case 'direct':
            return 'text-green-400';
        case 'remux':
            return 'text-blue-400';
        case 'audio_transcode':
        case 'full_transcode':
        case 'audio_only':
            return 'text-orange-400';
    }
}

/** Tailwind bg + border — pairs with `getPlayMethodStatTextClass` for stat cards. */
export function getPlayMethodStatBgClass(method: PlayMethod): string {
    switch (method) {
        case 'direct':
            return 'bg-green-500/20 border-green-500/30';
        case 'remux':
            return 'bg-blue-500/20 border-blue-500/30';
        case 'audio_transcode':
        case 'full_transcode':
        case 'audio_only':
            return 'bg-orange-500/20 border-orange-500/30';
    }
}

/** Player CSS-class system. The player coarsens audio/full transcode into `badge-transcode`. */
export function getPlayMethodBadgeClass(method: PlayMethod): string {
    switch (method) {
        case 'direct':
            return 'badge-direct';
        case 'remux':
            return 'badge-remux';
        case 'audio_transcode':
        case 'full_transcode':
        case 'audio_only':
            return 'badge-transcode';
    }
}
