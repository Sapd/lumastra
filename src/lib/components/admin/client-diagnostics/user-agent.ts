// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure UA/device-name parser for the client diagnostics admin page.
 *
 * `client_diagnostics.device_name` (`COALESCE(custom_name, reported_name)`) holds a raw
 * browser User-Agent string for web sessions, since a browser has no meaningful device
 * model to report — the "Device" column otherwise shows that raw string verbatim. This
 * turns it into a short human label ("Firefox 156 · Windows", "Safari 18 · iOS 18") while
 * the full string stays available as a tooltip. Native app device names (e.g. "Test's
 * iPhone") already read fine and are passed through unchanged.
 */

export interface ParsedUserAgent {
    /** Short human label, e.g. "Firefox 156 · Windows" — always non-empty. */
    label: string;
    /** True when `label` was derived from a recognized browser/native-app UA string
     *  rather than being the input passed through unchanged. */
    recognized: boolean;
    /** True when the recognized UA belongs to a browser (as opposed to a native app's
     *  own UA string) — used to derive a "web" platform display. */
    isBrowser: boolean;
}

const BROWSER_PATTERNS: { name: string; re: RegExp }[] = [
    // Order matters: Edge/Opera/Firefox UAs also contain "Safari/"; some (Edge, Opera,
    // Samsung Internet) also contain "Chrome/" — so those must be checked first.
    { name: 'Edge', re: /Edg(?:A|iOS)?\/([\d.]+)/ },
    { name: 'Opera', re: /(?:OPR|Opera)\/([\d.]+)/ },
    { name: 'Samsung Internet', re: /SamsungBrowser\/([\d.]+)/ },
    { name: 'Firefox', re: /Firefox\/([\d.]+)/ },
    { name: 'Chrome', re: /Chrome\/([\d.]+)/ },
    { name: 'Safari', re: /Version\/([\d.]+).*Safari\// },
];

function detectBrowser(ua: string): string | null {
    for (const { name, re } of BROWSER_PATTERNS) {
        const match = re.exec(ua);
        if (match) return `${name} ${match[1].split('.')[0]}`;
    }
    // A bare "Safari/xxx" with no "Version/" token (rare, old UAs) — still Safari.
    if (/Safari\//.test(ua) && !/Chrome\/|Chromium\//.test(ua)) return 'Safari';
    return null;
}

function detectOs(ua: string): string | null {
    if (/AppleTV|tvOS/i.test(ua)) return 'tvOS';
    const iosMatch = /(?:iPhone|iPad|iPod)(?:[^)]*OS ([\d_]+))?/.exec(ua);
    if (iosMatch) {
        const version = iosMatch[1]?.replace(/_/g, '.').split('.')[0];
        return version ? `iOS ${version}` : 'iOS';
    }
    const androidMatch = /Android ([\d.]+)/.exec(ua);
    if (androidMatch) return `Android ${androidMatch[1].split('.')[0]}`;
    // Only "Macintosh" is real macOS — iPhone/iPad UAs also contain
    // "like Mac OS X" and must not be misread as desktop macOS.
    if (/Macintosh/.test(ua)) {
        const macMatch = /Mac OS X ([\d_]+)/.exec(ua);
        const version = macMatch?.[1]?.replace(/_/g, '.').split('.').slice(0, 2).join('.');
        return version ? `macOS ${version}` : 'macOS';
    }
    const winMatch = /Windows NT ([\d.]+)/.exec(ua);
    if (winMatch) return 'Windows';
    if (/CrOS/.test(ua)) return 'ChromeOS';
    if (/Linux/.test(ua)) return 'Linux';
    return null;
}

/** A native app's own UA, e.g. "Lumastra/1.4 (tvOS 18.0; AppleTV14,1)" — not a browser
 *  (no leading "Mozilla/"), self-identifying as "<Product>/<version> (<device info>)". */
function parseNativeAppUa(ua: string): ParsedUserAgent | null {
    const match = /^([A-Za-z][\w.-]*)\/([\d.]+)\s*\(([^)]*)\)/.exec(ua);
    if (!match) return null;
    const [, product, version, paren] = match;
    const os = detectOs(paren) ?? detectOs(ua);
    const device = /AppleTV/i.test(paren) ? 'Apple TV' : null;
    const trailing = [os, device].filter((v): v is string => Boolean(v));
    const label =
        trailing.length > 0
            ? `${product} ${version} · ${trailing.join(' · ')}`
            : `${product} ${version}`;
    return { label, recognized: true, isBrowser: false };
}

/** Parses a raw device-name/User-Agent string into a short label. Returns the input
 *  unchanged (with `recognized: false`) when nothing is recognized, so callers can
 *  always render `label` directly. */
export function parseUserAgent(ua: string): ParsedUserAgent {
    const trimmed = ua.trim();
    if (!trimmed) return { label: ua, recognized: false, isBrowser: false };

    const isMozillaStyle = /^Mozilla\/\d/.test(trimmed);
    if (!isMozillaStyle) {
        const native = parseNativeAppUa(trimmed);
        if (native) return native;
        return { label: ua, recognized: false, isBrowser: false };
    }

    const browser = detectBrowser(trimmed);
    const os = detectOs(trimmed);
    if (!browser && !os) return { label: ua, recognized: false, isBrowser: false };

    const label = [browser, os].filter((v): v is string => Boolean(v)).join(' · ');
    return { label, recognized: true, isBrowser: true };
}

/** A raw browser User-Agent starts with "Mozilla/<digit>" — cheap check used to decide
 *  whether a `deviceName` value needs parsing at all (native app device names, e.g.
 *  "Test's iPhone", never match this). */
export function looksLikeUserAgent(value: string): boolean {
    return /^Mozilla\/\d/.test(value.trim()) || /^[A-Za-z][\w.-]*\/[\d.]+\s*\(/.test(value.trim());
}

export interface DeviceLabel {
    label: string;
    /** Full raw string to show as a tooltip — only set when `label` differs from it. */
    tooltip?: string;
}

/** Combines a diagnostic row's `deviceName`/`deviceId` into what the "Device" column
 *  should render: a parsed short label with the raw UA kept as a tooltip when the raw
 *  value looked like one, or the value as-is otherwise. */
export function deviceLabel(deviceName: string | null, deviceId: string | null): DeviceLabel {
    const raw = deviceName ?? deviceId;
    if (!raw) return { label: '—' };
    if (!looksLikeUserAgent(raw)) return { label: raw };
    const parsed = parseUserAgent(raw);
    if (!parsed.recognized) return { label: raw };
    return { label: parsed.label, tooltip: raw };
}

/** Whether a raw device-name/UA string reads as a browser — used to derive a "web"
 *  platform display when the server recorded `platform: "other"` for a browser
 *  session (see the display-only platform derivation in +page.svelte). */
export function isBrowserUserAgent(value: string): boolean {
    return parseUserAgent(value).isBrowser;
}
