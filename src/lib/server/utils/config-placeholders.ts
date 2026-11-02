// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `.env.example` used to ship ~25 optional integration keys/URLs as live
 * placeholder values (`TMDB_API_KEY=your_tmdb_api_key`,
 * `OPENAI_API_KEY=sk-your_openai_api_key`, `KAVITAURL=https://kavita.example.com`,
 * `DATABASE_PASSWORD=changeme_generate_a_strong_password`, …). A user who ran
 * `cp .env.example .env` and only changed the three documented secrets got
 * every one of these treated as real configuration: TMDB/MDBList/Voyage calls
 * failed with 401s, Jellyfin/Sonarr/Radarr/Jellyseerr/Audiobookshelf/
 * Kavita all logged connection errors, and "configured" checks (e.g.
 * `plugin-setup-status.ts`) showed green.
 *
 * `.env.example` itself has since been fixed to comment out every optional
 * value, but this is defense in depth for anyone who un-comments a line
 * without replacing the sample value, or copies an older copy of the file.
 * Getters for optional integration keys/URLs should route through
 * {@link isPlaceholderValue} (see `getOptionalIntegrationString` in
 * `config.ts`) so a leftover placeholder is treated as unset rather than as a
 * real credential/endpoint.
 *
 * Deliberately NOT applied to `DATABASE_PASSWORD` / `CACHE_PASSWORD` /
 * `SONIC_READER_PASSWORD` — those stay live placeholders that
 * docker-compose's `:?required` interpolation (or the app itself) must
 * reject loudly, not silently swap for a default.
 */

const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
    /^your_/i,
    /^changeme/i,
    /^sk-your_/i,
    /^sk-ant-your_/i,
];

/**
 * True when `value` looks like an unedited sample from `.env.example` rather
 * than a real credential/URL: a `your_…` / `changeme…` / `sk-your_…` token,
 * or a URL whose host is (a subdomain of) `example.com`.
 *
 * An empty string is NOT a placeholder — that's just "unset" and already
 * handled by the normal env-fallback/default chain.
 */
export function isPlaceholderValue(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed === '') return false;
    if (PLACEHOLDER_PATTERNS.some((re) => re.test(trimmed))) return true;

    // Sample URLs like https://kavita.example.com or https://dashboard.example.com
    try {
        const url = new URL(trimmed);
        const host = url.hostname.toLowerCase();
        if (host === 'example.com' || host.endsWith('.example.com')) return true;
    } catch {
        // Not a URL — fall through, already checked the token patterns above.
    }
    return false;
}

// Boot-time collection so operators see ONE warning listing every ignored
// placeholder, not one log line per key (a fresh install with several
// untouched optional integrations would otherwise scroll a lot of near-
// duplicate warnings on first boot).
const ignoredPlaceholderKeys = new Set<string>();
let flushScheduled = false;

/** Test-only: reset accumulated state between test cases. */
export function _resetPlaceholderWarningStateForTests(): void {
    ignoredPlaceholderKeys.clear();
    flushScheduled = false;
}

export function noteIgnoredPlaceholder(key: string, warn: (msg: string) => void): void {
    if (ignoredPlaceholderKeys.has(key)) return;
    ignoredPlaceholderKeys.add(key);
    if (flushScheduled) return;
    flushScheduled = true;
    setImmediate(() => {
        const keys = [...ignoredPlaceholderKeys].sort();
        warn(
            `[config] Ignoring ${keys.length} placeholder value(s) left over from .env.example (treated as unset): ${keys.join(', ')}`,
        );
    });
}
