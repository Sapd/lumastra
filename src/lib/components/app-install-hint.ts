// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Visibility rules for the "Get the app" hint (AppInstallHint.svelte).
 *
 * Shown only to Safari on iPhone/iPad, over HTTPS (the Apple apps refuse plain
 * HTTP / untrusted certificates, so pointing an HTTP install at the app would
 * strand the user), outside the installed PWA, while the admin setting
 * WEB_APP_INSTALL_HINT is on, and until the user dismisses it once (forever —
 * per browser; bump DISMISS_KEY to re-show it to everyone, e.g. at the App
 * Store launch).
 */

export const DISMISS_KEY = 'lumastra.appInstallHint.dismissed.v1';

/** The browser facts the decision depends on — injected so tests can fake every device. */
export interface InstallHintEnv {
    userAgent: string;
    platform: string;
    maxTouchPoints: number;
    protocol: string;
    /** `display-mode: standalone` matched, or iOS `navigator.standalone`. */
    standalone: boolean;
}

/**
 * iPhone/iPod/iPad Safari. iPadOS 13+ Safari sends a desktop-Mac UA by default,
 * so an iPad is "Mac + more than one touch point" (a real Mac reports 0).
 * Other iOS browsers (all WebKit) tag their UA (CriOS, FxiOS, EdgiOS, …) and
 * in-app web views (WKWebView) omit the `Safari/` token — both are excluded.
 */
export function isIosSafari(
    env: Pick<InstallHintEnv, 'userAgent' | 'platform' | 'maxTouchPoints'>,
): boolean {
    const ua = env.userAgent;
    const iPhoneOrIPad = /iPhone|iPad|iPod/.test(ua);
    const iPadAsMac = /Macintosh/.test(ua) && /Mac/.test(env.platform) && env.maxTouchPoints > 1;
    if (!iPhoneOrIPad && !iPadAsMac) return false;
    if (!/Safari\//.test(ua) || !/Version\//.test(ua)) return false;
    // Third-party browsers and in-app browsers that keep the Safari token.
    if (
        /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|YaBrowser|DuckDuckGo|GSA\/|FBAN|FBAV|Instagram|Line\/|Snapchat/.test(
            ua,
        )
    ) {
        return false;
    }
    return true;
}

export function shouldShowInstallHint(
    env: InstallHintEnv,
    enabled: boolean,
    dismissed: boolean,
): boolean {
    return (
        enabled && !dismissed && env.protocol === 'https:' && !env.standalone && isIosSafari(env)
    );
}

/** Reads the live browser. Call only in the browser (after mount). */
export function readInstallHintEnv(): InstallHintEnv {
    let standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
    try {
        standalone ||= window.matchMedia('(display-mode: standalone)').matches;
    } catch {
        // matchMedia missing — treat as a browser tab.
    }
    return {
        userAgent: navigator.userAgent,
        platform: navigator.platform ?? '',
        maxTouchPoints: navigator.maxTouchPoints ?? 0,
        protocol: location.protocol,
        standalone,
    };
}

/** Storage can throw (Safari private mode, blocked site data) — never let that break the page. */
export function isInstallHintDismissed(): boolean {
    try {
        return localStorage.getItem(DISMISS_KEY) !== null;
    } catch {
        return false;
    }
}

export function dismissInstallHint(): void {
    try {
        localStorage.setItem(DISMISS_KEY, new Date().toISOString());
    } catch {
        // Not persisted — the hint stays closed for this page view only.
    }
}
