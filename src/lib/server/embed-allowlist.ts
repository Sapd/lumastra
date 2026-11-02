// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Allowlist logic for the `/app/[url]` external-service iframe embed route.
 *
 * The embed page frames an arbitrary URL taken from the path. Without a guard
 * that is an open-framing / phishing vector: an attacker-crafted
 * `…/app/https%3A%2F%2Fevil.example%2F` link wraps hostile content in the
 * trusted app chrome (logo + nav, our hostname in the address bar).
 *
 * The only URLs we should ever frame are the external services an admin
 * configured in the navigation (sidebar / user-menu / footer links). We match
 * by ORIGIN, not exact URL, so navigation WITHIN an allowed app
 * (e.g. `https://game.example.com/server/123`) still works while arbitrary hosts
 * are rejected.
 *
 * The same origin set also feeds the GLOBAL CSP `frame-src` (hooks.server.ts):
 * a document's CSP is fixed when the document loads, so a per-route header only
 * reaches the browser on a full page load — never on a client-side `goto()` from
 * the dock, which then had the frame blocked until the user reloaded.
 */

/** The navigation lists whose external links may be framed by `/app/[url]`. */
export const EMBED_LINK_CONFIG_KEYS = ['SIDEBAR_LINKS', 'USER_MENU_LINKS', 'FOOTER_LINKS'] as const;

/** Minimal shape of a configured navigation link relevant to the allowlist. */
export interface ConfiguredLink {
    url?: string;
    external?: boolean;
}

/**
 * Collect the set of origins (`https://host[:port]`) an admin has configured as
 * external links across one or more navigation lists. Relative URLs, non-http(s)
 * schemes, internal (`external !== true`) links, and unparseable URLs are skipped.
 */
export function collectAllowedOrigins(...lists: Array<ConfiguredLink[] | undefined>): Set<string> {
    const origins = new Set<string>();
    for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
            if (!item || item.external !== true || !item.url) continue;
            try {
                const u = new URL(item.url);
                if (u.protocol === 'http:' || u.protocol === 'https:') {
                    origins.add(u.origin);
                }
            } catch {
                /* expected: relative/invalid configured URLs are simply not embeddable */
            }
        }
    }
    return origins;
}

/**
 * The embeddable origins from the live config, read through `read` (the config
 * service's `get`) so this module stays free of server state and testable.
 */
export function configuredEmbedOrigins(
    read: (key: string) => ConfiguredLink[] | undefined,
): Set<string> {
    return collectAllowedOrigins(...EMBED_LINK_CONFIG_KEYS.map((key) => read(key)));
}

/**
 * Validate a decoded embed target against the configured allowlist.
 *
 * @returns the normalized absolute URL when the target is an http(s) URL whose
 *   origin is in `allowedOrigins`; otherwise `null` (caller should 404).
 */
export function resolveAllowedEmbedUrl(
    decoded: string,
    allowedOrigins: Set<string>,
): string | null {
    let target: URL;
    try {
        target = new URL(decoded);
    } catch {
        return null;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
    if (!allowedOrigins.has(target.origin)) return null;
    return target.href;
}
