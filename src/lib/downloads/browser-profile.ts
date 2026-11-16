// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * browser-profile.ts - per-browser settings for the download queue's link mode
 * (the path every browser without a usable folder picker takes).
 *
 * Pure: `linkModeProfile` only looks at the `BrowserEnv` it is given.
 */

/** Client-side ceiling when the server's limit is "unlimited" (0). */
export const UNLIMITED_PARALLEL_CEILING = 4;
const DEFAULT_LINK_GAP_MS = 1500;
const SAFARI_LINK_GAP_MS = 2000;

export interface BrowserEnv {
    userAgent: string;
    maxTouchPoints: number;
    /** `navigator.brave` exists */
    brave: boolean;
}

export type LinkHint = 'safari' | 'firefox' | 'ios' | 'generic';

export interface LinkModeProfile {
    batchSize(maxParallel: number): number;
    gapMs: number;
    hint: LinkHint;
}

/** Links handed to the browser per batch when nothing browser-specific applies. */
export function linkBatchSize(maxParallel: number): number {
    return maxParallel > 0 ? maxParallel : UNLIMITED_PARALLEL_CEILING;
}

export function detectBrowserEnv(): BrowserEnv {
    if (typeof navigator === 'undefined') return { userAgent: '', maxTouchPoints: 0, brave: false };
    const nav = navigator as Navigator & { brave?: unknown };
    return {
        userAgent: nav.userAgent ?? '',
        maxTouchPoints: nav.maxTouchPoints ?? 0,
        brave: 'brave' in nav && nav.brave != null,
    };
}

/** iPhone/iPod/iPad, including iPadOS with the desktop (Macintosh) user agent. */
export function isIos(env: BrowserEnv): boolean {
    return (
        /iPhone|iPad|iPod/.test(env.userAgent) ||
        (env.maxTouchPoints > 1 && /Macintosh/.test(env.userAgent))
    );
}

function isSafariMac(env: BrowserEnv): boolean {
    const ua = env.userAgent;
    return (
        /Macintosh/.test(ua) &&
        /Version\/[\d.]+.*Safari\//.test(ua) &&
        !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS|Android/.test(ua)
    );
}

export function linkModeProfile(env: BrowserEnv): LinkModeProfile {
    if (isIos(env)) {
        return { batchSize: () => 1, gapMs: DEFAULT_LINK_GAP_MS, hint: 'ios' };
    }
    if (isSafariMac(env)) {
        return {
            batchSize: (p) => Math.min(2, linkBatchSize(p)),
            gapMs: SAFARI_LINK_GAP_MS,
            hint: 'safari',
        };
    }
    if (/Firefox\//.test(env.userAgent)) {
        return { batchSize: linkBatchSize, gapMs: DEFAULT_LINK_GAP_MS, hint: 'firefox' };
    }
    return { batchSize: linkBatchSize, gapMs: DEFAULT_LINK_GAP_MS, hint: 'generic' };
}
