// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Chat utilities for the Lt. Commander Data chat interface
 */

import * as m from '$lib/paraglide/messages';
import { escapeHtml } from './escape-html';

/**
 * Get a random Star Trek themed loading message
 */
export function getRandomLoadingMessage(): string {
    const loadingMessages = [
        m.assistant_loading_1(),
        m.assistant_loading_2(),
        m.assistant_loading_3(),
        m.assistant_loading_4(),
        m.assistant_loading_5(),
        m.assistant_loading_6(),
        m.assistant_loading_7(),
        m.assistant_loading_8(),
        m.assistant_loading_9(),
        m.assistant_loading_10(),
        m.assistant_loading_11(),
        m.assistant_loading_12(),
        m.assistant_loading_13(),
        m.assistant_loading_14(),
    ];
    return loadingMessages[Math.floor(Math.random() * loadingMessages.length)];
}

export { escapeHtml };

/**
 * Unescape HTML entities back to characters (for URLs)
 */
function unescapeHtml(str: string): string {
    // `&amp;` last: decoding it first would turn `&amp;quot;` into `"` (double decode).
    return str
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&amp;/g, '&');
}

/**
 * The normalised href of an http(s) URL or a same-origin path (one leading
 * slash, never `//host` or `/\host`), or null for anything else (other schemes,
 * protocol-relative or malformed URLs). `URL#href` percent-encodes quotes,
 * spaces and angle brackets, so the result cannot carry markup either.
 */
function safeExternalHref(raw: string): string | null {
    const trimmed = raw.trim();
    try {
        if (/^\/(?![/\\])/.test(trimmed)) {
            const url = new URL(trimmed, 'https://same-origin.invalid');
            return url.pathname + url.search + url.hash;
        }
        const url = new URL(trimmed);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
        /* expected: not a usable URL */
        return null;
    }
}

/**
 * Parse URL and extract internal link data if it's a Jellyfin or Jellyseerr URL
 * Returns link metadata for internal handling, or null for external links
 */
interface InternalLinkData {
    type: 'jellyfin' | 'jellyseerr';
    jellyfinId?: string;
    /** TMDB ID extracted from Jellyseerr URLs (Jellyseerr uses TMDB IDs in URLs) */
    externalId?: string;
    externalIdProvider?: 'tmdb';
    mediaType?: string;
}

function parseInternalUrl(url: string): InternalLinkData | null {
    try {
        // Check for Jellyfin URLs (contains /web/ and id= parameter)
        const jellyfinMatch = url.match(/\/web\/.*[?&]id=([a-f0-9]+)/i);
        if (jellyfinMatch) {
            return {
                type: 'jellyfin',
                jellyfinId: jellyfinMatch[1],
            };
        }

        // Check for Jellyseerr URLs (ends with /movie/123 or /tv/123)
        // Note: Jellyseerr uses TMDB IDs in their URL structure
        const jellyseerrMatch = url.match(/\/(movie|tv)\/(\d+)\/?$/);
        if (jellyseerrMatch) {
            return {
                type: 'jellyseerr',
                mediaType: jellyseerrMatch[1],
                externalId: jellyseerrMatch[2],
                externalIdProvider: 'tmdb',
            };
        }

        return null;
    } catch {
        /* expected: URL parsing may fail on malformed strings */
        return null;
    }
}

/**
 * Convert markdown links to HTML links
 * Handles [text](url) format, **bold**, and newlines
 * Escapes HTML to prevent XSS while preserving markdown features
 * Internal Jellyfin/Jellyseerr links get data attributes for interception
 */
export function parseMarkdownLinks(text: string): string {
    // Step 1: Escape all HTML to prevent XSS
    let result = escapeHtml(text).replaceAll('\u0000', '');
    // Protect escaped code from link/emphasis processing. Input cannot contain
    // these placeholders, and only already-escaped text is restored below.
    const code: string[] = [];
    result = result.replace(
        /```(?:[^\n`]*\n)?([\s\S]*?)```|`([^`\n]+)`/g,
        (_match, block: string | undefined, inline: string | undefined) => {
            const html =
                block !== undefined
                    ? `<pre class="overflow-x-auto whitespace-pre-wrap"><code>${block}</code></pre>`
                    : `<code>${inline}</code>`;
            return `\u0000${code.push(html) - 1}\u0000`;
        },
    );

    // Step 2: Convert markdown links [text](url) to HTML links
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText, url) => {
        // URL was escaped, unescape it for the href
        const unescapedUrl = unescapeHtml(url);

        // Model-emitted reference to a tool-returned title:
        // [Title](ref:562:movie) -> modal link resolved against the cards.
        if (unescapedUrl.startsWith('ref:')) {
            const ref = escapeHtml(unescapedUrl.slice(4).trim());
            return `<a href="#" data-internal-link="modal" data-ref="${ref}" class="text-primary-400 hover:text-primary-300 underline cursor-pointer">${linkText}</a>`;
        }

        // Check if this is an internal link
        const internalData = parseInternalUrl(unescapedUrl);

        if (internalData) {
            // Create button-like link for internal handling
            if (internalData.type === 'jellyfin' && internalData.jellyfinId) {
                return `<a href="#" data-internal-link="jellyfin" data-jellyfin-id="${internalData.jellyfinId}" class="text-primary-400 hover:text-primary-300 underline cursor-pointer">${linkText}</a>`;
            } else if (internalData.type === 'jellyseerr' && internalData.externalId) {
                // Jellyseerr uses TMDB IDs - store as external-id with provider info
                return `<a href="#" data-internal-link="jellyseerr" data-external-id="${internalData.externalId}" data-external-provider="${internalData.externalIdProvider}" data-media-type="${internalData.mediaType}" class="text-primary-400 hover:text-primary-300 underline cursor-pointer">${linkText}</a>`;
            }
        }

        // External link - open in new tab. The href is rebuilt from the PARSED
        // URL and escaped for the attribute: pasting the unescaped capture into
        // `href="…"` let a `"` in the model's text close the attribute and add
        // attributes of its own (class, data-internal-link, …).
        const href = safeExternalHref(unescapedUrl);
        if (!href) return linkText;
        return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="text-primary-400 hover:text-primary-300 underline">${linkText}</a>`;
    });

    // Step 2.5: Markdown headers (#..######) -> bold lines, and bullet markers
    // (- / *) -> a bullet glyph. The renderer's allowed tags are limited, so
    // headers map to <strong> rather than <h*>. Runs per-line (before newline
    // conversion below).
    result = result.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*$/gm, '<strong>$1</strong>');
    result = result.replace(/^\s{0,3}[-*]\s+(.+?)\s*$/gm, '• $1');

    // Step 3: Convert **bold** to <strong>
    result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Step 3b: Convert *italic* to <em>. Runs AFTER bold so ** is already gone;
    // the [^*] inside prevents spanning across any remaining asterisks.
    result = result.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

    // Step 4: Convert newlines to <br> tags
    result = result.replace(/\n/g, '<br>');

    return result
        .split('\u0000')
        .map((part, index) => (index % 2 === 0 ? part : (code[Number(part)] ?? '')))
        .join('');
}

/**
 * Wrap the first plain-text occurrence of `needle` (already HTML-escaped) in a
 * modal link carrying `data-movie-index`. Skips matches inside tags or inside
 * an existing `<a>…</a>`, and requires word-ish boundaries so short titles
 * don't match inside longer words. Returns the input unchanged if not found.
 */
function wrapFirstPlainOccurrence(html: string, needle: string, index: number): string {
    let inTag = false;
    let anchorDepth = 0;
    for (let i = 0; i < html.length; i++) {
        const c = html[i];
        if (c === '<') {
            inTag = true;
            if (html.startsWith('<a', i)) anchorDepth++;
            else if (html.startsWith('</a', i)) anchorDepth = Math.max(0, anchorDepth - 1);
            continue;
        }
        if (c === '>') {
            inTag = false;
            continue;
        }
        if (inTag || anchorDepth > 0) continue;
        if (!html.startsWith(needle, i)) continue;

        const before = html[i - 1];
        const after = html[i + needle.length];
        const okBefore = !before || /[\s>("'[]/.test(before);
        const okAfter = !after || /[\s<)\].,!?:;"']/.test(after);
        if (!okBefore || !okAfter) continue;

        const link = `<a href="#" data-internal-link="modal" data-movie-index="${index}" class="text-primary-400 hover:text-primary-300 underline cursor-pointer">${needle}</a>`;
        return html.slice(0, i) + link + html.slice(i + needle.length);
    }
    return html;
}

/**
 * Make recommended-movie titles clickable inside already-parsed assistant
 * message HTML. Each title is matched (HTML-escaped, like the surrounding
 * markup) and wrapped in a `data-internal-link="modal"` anchor whose
 * `data-movie-index` points back into `movies`, so the click handler can open
 * the media modal for the exact recommended item. Run AFTER parseMarkdownLinks.
 */
/**
 * Resolve a model-cited `ref` (e.g. "562:movie") to one of the recommended
 * movies by matching its primary external id + media type. Returns undefined
 * when the ref doesn't correspond to a real card — this is the validation that
 * stops a hallucinated/garbled ref from opening anything.
 */
export function resolveMovieByRef<
    M extends { externalIds?: Record<string, unknown>; mediaType: string },
>(movies: ReadonlyArray<M>, ref: string): M | undefined {
    if (!ref) return undefined;
    return movies.find((mv) =>
        // Match any PROVIDER id (skip the internal UUID, which isn't what the
        // model's ref encodes) against `${id}:${mediaType}`.
        Object.entries(mv.externalIds ?? {}).some(
            ([key, value]) =>
                key !== 'internal' &&
                value != null &&
                value !== '' &&
                `${String(value)}:${mv.mediaType}` === ref,
        ),
    );
}

export function linkifyTitles(html: string, movies: ReadonlyArray<{ title: string }>): string {
    if (!movies || movies.length === 0) return html;
    let result = html;
    movies.forEach((movie, index) => {
        const needle = escapeHtml((movie.title ?? '').trim());
        if (needle.length < 2) return;
        result = wrapFirstPlainOccurrence(result, needle, index);
    });
    return result;
}
