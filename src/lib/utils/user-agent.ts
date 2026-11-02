// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * User-agent parsing into friendly client labels (e.g., "Chrome 147 on macOS").
 *
 * Shared across client and server — runs at display time so database rows
 * that stored the raw UA string (e.g., `play_sessions.device_name`) are
 * rendered the same way for both legacy and new sessions. Raw strings stay
 * in the DB for forensics; only the presentation is normalized.
 */

interface BrowserMatch {
    name: string;
    /** Regex with one capture group for the version */
    version: RegExp;
}

const BROWSERS: BrowserMatch[] = [
    // Order matters: Edge/Opera/Brave ship UA strings containing "Chrome" so
    // they must be checked before the generic Chrome pattern.
    { name: 'Edge', version: /Edg\/([\d.]+)/ },
    { name: 'Opera', version: /OPR\/([\d.]+)/ },
    { name: 'Firefox', version: /Firefox\/([\d.]+)/ },
    { name: 'Chrome', version: /Chrome\/([\d.]+)/ },
    // Safari version lives in the "Version/" token, not "Safari/".
    { name: 'Safari', version: /Version\/([\d.]+).*Safari\// },
];

interface OsMatch {
    label: string;
    regex: RegExp;
}

const OPERATING_SYSTEMS: OsMatch[] = [
    { label: 'iPhone', regex: /iPhone/ },
    { label: 'iPad', regex: /iPad/ },
    { label: 'iOS', regex: /iPod/ },
    { label: 'Android', regex: /Android/ },
    { label: 'macOS', regex: /Macintosh|Mac OS X/ },
    { label: 'Windows', regex: /Windows NT/ },
    { label: 'Linux', regex: /Linux/ },
    { label: 'Apple TV', regex: /AppleTV|tvOS/ },
    { label: 'Smart TV', regex: /SmartTV|Tizen|webOS/ },
];

/** Extract the major version (first dotted component) from a version string. */
function majorVersion(version: string | undefined): string | null {
    if (!version) return null;
    const major = version.split('.')[0];
    return major.length > 0 ? major : null;
}

function detectBrowser(ua: string): { name: string; version: string | null } | null {
    for (const { name, version } of BROWSERS) {
        const match = version.exec(ua);
        if (match) {
            return { name, version: majorVersion(match[1]) };
        }
    }
    return null;
}

function detectOs(ua: string): string | null {
    for (const { label, regex } of OPERATING_SYSTEMS) {
        if (regex.test(ua)) return label;
    }
    return null;
}

export type FormFactor = 'desktop' | 'mobile' | 'tablet' | 'tv' | 'unknown';

/**
 * Case-insensitive pattern SOURCES for `detectFormFactor`, shared verbatim with
 * the playback-analytics SQL (`formFactorSql` in playback-analytics.queries.ts,
 * which runs them through Postgres `~*`). They are written in the regex subset
 * both engines agree on — no `\b` (Postgres spells a word boundary `\y`), so a
 * whole-word token is fenced with letter lookarounds instead. Change a pattern
 * here and both classifiers change together.
 */
const WORD = (token: string): string => `(?<![A-Za-z])${token}(?![A-Za-z])`;
export const FORM_FACTOR_PATTERNS = {
    // TV runs before mobile because Android TV / Google TV / Fire TV / NVIDIA
    // Shield / Sony Bravia all ship `Android` in their UA, which the mobile
    // branch would otherwise claim. Tokens cover the generic markers, device
    // codenames that omit them (SHIELD, AFT* for Fire TV, BRAVIA), and the
    // names TV clients report for themselves ("Apple TV", "4K Hybrid STB",
    // "Example TV App" — any standalone "TV" word).
    tv: `Android ?TV|Google ?TV|SHIELD|${WORD('AFT[A-Z]{1,6}')}|BRAVIA|Apple ?TV|tvOS|Smart ?TV|Tizen|webOS|Roku|${WORD('TV')}|${WORD('STB')}`,
    // iPads identify themselves; Android tablets generally omit `Mobile`.
    tablet: 'iPad|Tablet|Kindle|Silk/',
    android: 'Android',
    mobileToken: WORD('Mobile'),
    mobile: `iPhone|iPod|Android|${WORD('Mobile')}|${WORD('iOS')}`,
    desktop: `Macintosh|Mac OS X|${WORD('Mac')}|Windows NT|X11|Linux|CrOS`,
} as const;

const FORM_FACTOR_REGEX = Object.fromEntries(
    Object.entries(FORM_FACTOR_PATTERNS).map(([k, v]) => [k, new RegExp(v, 'i')]),
) as Record<keyof typeof FORM_FACTOR_PATTERNS, RegExp>;

/**
 * Categorize a user-agent / client-name pair into a coarse form factor.
 *
 * Looks at OS tokens in the UA string and falls back to recognizable hints in
 * the client name (e.g. "Lumastra iOS", "Lumastra TV") and the device's
 * reported name ("iPad Pro", "Apple TV"). Conservative — anything we can't
 * classify returns 'unknown' rather than guessing.
 *
 * `Mac OS X` matches both desktop macOS and modern iPadOS (which spoofs
 * Macintosh since iPadOS 13). When the UA explicitly carries `iPad` or a
 * tablet hint, it is classified as `tablet` before the desktop fallback.
 */
export function detectFormFactor(
    ua: string | null | undefined,
    clientName?: string | null | undefined,
    deviceName?: string | null | undefined,
): FormFactor {
    const haystack = `${ua ?? ''} ${clientName ?? ''} ${deviceName ?? ''}`;
    if (!haystack.trim()) return 'unknown';
    if (FORM_FACTOR_REGEX.tv.test(haystack)) return 'tv';
    if (FORM_FACTOR_REGEX.tablet.test(haystack)) return 'tablet';
    if (FORM_FACTOR_REGEX.android.test(haystack) && !FORM_FACTOR_REGEX.mobileToken.test(haystack))
        return 'tablet';
    if (FORM_FACTOR_REGEX.mobile.test(haystack)) return 'mobile';
    if (FORM_FACTOR_REGEX.desktop.test(haystack)) return 'desktop';
    return 'unknown';
}

/**
 * Parse a user-agent string into a short, human-readable label.
 *
 * Examples:
 * - `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/... Chrome/147.0`
 *   → `"Chrome 147 on macOS"`
 * - `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)... Version/17.0 Safari/605.1.15`
 *   → `"Safari 17 on iPhone"`
 * - unknown/empty → `"Unknown"`
 *
 * For already-friendly values (e.g., "Lumastra iOS 1.2") that aren't full UA
 * strings, returns them unchanged when they don't look like a UA.
 */
export function parseUserAgent(ua: string | null | undefined): string {
    if (!ua) return 'Unknown';
    const trimmed = ua.trim();
    if (!trimmed) return 'Unknown';

    // Not a standard browser UA — return as-is if short, truncate if long.
    const isBrowserUa = /Mozilla\/|AppleWebKit\/|Gecko\//.test(trimmed);
    if (!isBrowserUa) {
        return trimmed.length > 40 ? trimmed.substring(0, 40) + '…' : trimmed;
    }

    const browser = detectBrowser(trimmed);
    const os = detectOs(trimmed);

    if (browser) {
        const browserLabel = browser.version ? `${browser.name} ${browser.version}` : browser.name;
        return os ? `${browserLabel} on ${os}` : browserLabel;
    }

    if (os) return os;

    return trimmed.length > 40 ? trimmed.substring(0, 40) + '…' : trimmed;
}
