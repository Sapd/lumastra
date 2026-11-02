// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { parseTokens, stripTokens, makeToken } from './tokens.js';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
/**
 * Matches a pasted media URL and captures its UUID. Recognizes both host link
 * shapes — `?modal=<uuid>` / `&modal=<uuid>` (the detail-modal deep link, e.g.
 * `https://example.com/?modal=<uuid>`) and `/watch/<uuid>`. The leading/trailing
 * `\S*` make the whole whitespace-delimited URL the match (so it's fully
 * replaced), regardless of host/scheme (a example.com link works in dev too).
 */
const MEDIA_URL_RE = new RegExp(`\\S*(?:[?&]modal=|/watch/)(${UUID})\\S*`, 'gi');

/**
 * Auto-convert pasted media URLs in `body` into `{{media:<uuid>:<type>}}` tokens
 * so a user can simply drop a `/?modal=<uuid>` or `/watch/<uuid>` link and have
 * it render as a chip. The UUID's media type is looked up via `ctx.mediaItems`,
 * and the link is only converted when the AUTHOR may actually see the item
 * (per-viewer access via `ctx.media`) — otherwise the original URL is left as
 * plain text (no token, so no chip and no access leak). Run at POST time before
 * `sanitizeOutgoing`.
 */
export async function linkifyMediaUrls(ctx, body) {
    if (typeof body !== 'string' || !ctx?.media || !ctx?.mediaItems) return body;
    const matches = [...body.matchAll(MEDIA_URL_RE)];
    if (matches.length === 0) return body;

    // Resolve each distinct UUID → media type (dedupe), then access-check the
    // author against the real (id, type) composite. Hard cap on distinct lookups
    // (defense in depth — the POST route already bounds the body to maxLength
    // before calling this, so at most a handful of URLs fit, but never trust that).
    const MAX_LINKS = 12;
    const refs = [];
    const seen = new Set();
    for (const m of matches) {
        if (seen.size >= MAX_LINKS) break;
        const id = String(m[1]).toLowerCase();
        if (seen.has(id)) continue;
        seen.add(id);
        let summary;
        try {
            summary = await ctx.mediaItems.getById(id);
        } catch {
            summary = null;
        }
        if (summary && summary.mediaType) refs.push({ id, mediaType: summary.mediaType });
    }
    if (refs.length === 0) return body;

    let resolved;
    try {
        resolved = await ctx.media.resolveForViewer(refs);
    } catch {
        resolved = [];
    }
    const allowed = new Map(
        (Array.isArray(resolved) ? resolved : [])
            .filter((c) => c && c.allowed)
            .map((c) => [String(c.id).toLowerCase(), c.mediaType]),
    );
    if (allowed.size === 0) return body;

    return body.replace(MEDIA_URL_RE, (full, id) => {
        const type = allowed.get(String(id).toLowerCase());
        if (!type) return full; // unknown or not author-accessible → leave URL as plain text
        try {
            return makeToken(String(id).toLowerCase(), type);
        } catch {
            return full; // makeToken rejects a malformed id/type → keep the URL
        }
    });
}

/** Resolve every token in `body` for the current viewer → { chips } map. */
export async function enrichChips(ctx, body) {
    const refs = parseTokens(body);
    if (refs.length === 0 || !ctx?.media) return { chips: {} };
    const resolved = await ctx.media.resolveForViewer(refs);
    const chips = {};
    for (const c of Array.isArray(resolved) ? resolved : []) chips[`${c.id}:${c.mediaType}`] = c;
    return { chips };
}

/** Strip tokens the AUTHOR can't access (author-side, at post time). */
export async function sanitizeOutgoing(ctx, body) {
    const refs = parseTokens(body);
    if (refs.length === 0 || !ctx?.media) return body;
    const resolved = await ctx.media.resolveForViewer(refs);
    const list = Array.isArray(resolved) ? resolved : [];
    const allowed = new Set(list.filter((c) => c.allowed).map((c) => `${c.id}:${c.mediaType}`));
    return stripTokens(body, allowed)
        .replace(/\s{2,}/g, ' ')
        .trim();
}
