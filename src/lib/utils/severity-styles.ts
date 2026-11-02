// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared severity → Tailwind class mapping for badges, alerts, and status pills.
 *
 * The `-400` text + `-500/20` bg + `-500/30` border palette is the dashboard
 * convention used by metric cards and FFmpeg/proxy health badges. It is
 * intentionally lighter than the rich `-300` text + `-900/30` bg palette
 * used by play-method pills (see `playback-method.ts`); the two palettes
 * coexist and should not be unified — different visual contexts.
 */

export type Severity = 'success' | 'info' | 'warning' | 'error' | 'neutral';

export function getSeverityTextClass(severity: Severity): string {
    switch (severity) {
        case 'success':
            return 'text-green-400';
        case 'info':
            return 'text-blue-400';
        case 'warning':
            return 'text-yellow-400';
        case 'error':
            return 'text-red-400';
        case 'neutral':
            return 'text-gray-400';
    }
}

export function getSeverityBgClass(severity: Severity): string {
    switch (severity) {
        case 'success':
            return 'bg-green-500/20';
        case 'info':
            return 'bg-blue-500/20';
        case 'warning':
            return 'bg-yellow-500/20';
        case 'error':
            return 'bg-red-500/20';
        case 'neutral':
            return 'bg-gray-500/20';
    }
}

export function getSeverityBorderClass(severity: Severity): string {
    switch (severity) {
        case 'success':
            return 'border-green-500/30';
        case 'info':
            return 'border-blue-500/30';
        case 'warning':
            return 'border-yellow-500/30';
        case 'error':
            return 'border-red-500/30';
        case 'neutral':
            return 'border-gray-500/30';
    }
}

/** Single-shot text + bg classes — for badge/pill use without a border. */
export function getSeverityBadgeClasses(severity: Severity): string {
    return `${getSeverityBgClass(severity)} ${getSeverityTextClass(severity)}`;
}

/** Single-shot text + bg + border classes — for outlined cards/pills. */
export function getSeverityOutlineClasses(severity: Severity): string {
    return `${getSeverityBgClass(severity)} ${getSeverityTextClass(severity)} ${getSeverityBorderClass(severity)}`;
}
