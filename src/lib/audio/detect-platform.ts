// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export type { PlatformType } from './types';

/**
 * Detect the current platform for audio backend selection.
 *
 * Uses capability checks (not just UA sniffing) to handle:
 * - iPads in desktop mode (return Mac UA but have maxTouchPoints > 1)
 * - All iOS browsers use WebKit (same audio behavior)
 * - Android Chrome, Samsung Internet, Firefox (all Chromium-based on Android)
 */
export function detectPlatform(): 'desktop' | 'ios' | 'android' {
    if (typeof navigator === 'undefined') return 'desktop'; // SSR guard

    const ua = navigator.userAgent;

    // iOS: iPhone/iPod explicitly, or iPad in desktop mode
    // iPad desktop mode returns Mac UA, but maxTouchPoints > 1 distinguishes
    // it from a real Mac (which has maxTouchPoints === 0 or 1)
    const isIPhone = /iPhone|iPod/.test(ua);
    const isIPadDesktopMode = /Mac/.test(navigator.platform ?? '') && navigator.maxTouchPoints > 1;
    if (isIPhone || isIPadDesktopMode) return 'ios';

    // Android: any browser on Android
    if (/Android/.test(ua)) return 'android';

    return 'desktop';
}

/**
 * Detect if the current browser is Safari on macOS (not iOS, not Chrome/Firefox/Edge).
 *
 * Safari desktop has unfixable Web Audio API bugs with MediaElementAudioSourceNode
 * (WebKit #221334, #293891, #212125) that corrupt audio during A/B deck crossfade.
 * This flag routes Safari desktop to a dedicated backend that avoids Web Audio entirely.
 */
export function isSafariDesktop(): boolean {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent;
    // Safari includes "Safari/" but so does Chrome. Chrome also includes "Chrome/".
    // Exclude Chrome, Edge, Firefox, and other Chromium-based browsers.
    const hasSafari = /Safari\//.test(ua);
    const hasChrome = /Chrome\/|Chromium\//.test(ua);
    const hasFirefox = /Firefox\//.test(ua);
    const hasEdge = /Edg\//.test(ua);
    if (!hasSafari || hasChrome || hasFirefox || hasEdge) return false;
    // Exclude iOS (iPhone/iPod) and iPad in desktop mode (maxTouchPoints > 1)
    if (/iPhone|iPod/.test(ua)) return false;
    if (/Mac/.test(navigator.platform ?? '') && navigator.maxTouchPoints > 1) return false;
    // Must be on a Mac-like platform
    return /Mac/.test(navigator.platform ?? '');
}
