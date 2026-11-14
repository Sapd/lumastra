// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sanitiser for assistant message HTML (`parseMarkdownLinks` output, injected
 * with `{@html}`).
 *
 * The producer emits a closed vocabulary: <a>, <strong>, <em>, <br>, with two
 * fixed anchor classes and a fixed set of `data-*` attributes that
 * `AssistantMessage`'s click handler reads. The model's text is
 * attacker-influenced, so the sanitiser enforces that vocabulary itself instead
 * of trusting the producer: free `class` and arbitrary `data-*` are what let a
 * crafted link become an invisible full-screen overlay or a forged
 * `data-internal-link` click.
 */
import DOMPurify from 'dompurify';

/** The `data-*` attributes the click handler reads — nothing else is allowed. */
export const ASSISTANT_DATA_ATTRS = [
    'data-internal-link',
    'data-jellyfin-id',
    'data-external-id',
    'data-external-provider',
    'data-media-type',
    'data-movie-index',
    'data-ref',
] as const;

/** The only `class` values the producer emits. */
const ALLOWED_CLASSES: ReadonlySet<string> = new Set([
    'text-primary-400 hover:text-primary-300 underline',
    'text-primary-400 hover:text-primary-300 underline cursor-pointer',
]);

export const ASSISTANT_PURIFY_CONFIG = {
    // pre/code: parseMarkdownLinks renders fenced blocks as <pre><code> and keeps
    // their newlines; stripping the tags would collapse a code block to one line.
    ALLOWED_TAGS: ['a', 'strong', 'em', 'p', 'br', 'span', 'pre', 'code'],
    ALLOWED_ATTR: ['href', 'class', ...ASSISTANT_DATA_ATTRS],
    ALLOW_DATA_ATTR: false,
};

const DATA_VALUE_PATTERNS: Record<string, RegExp> = {
    'data-internal-link': /^(modal|jellyfin|jellyseerr)$/,
    'data-jellyfin-id': /^[a-f0-9]{1,64}$/i,
    'data-external-id': /^\d{1,12}$/,
    'data-external-provider': /^tmdb$/,
    'data-media-type': /^(movie|tv)$/,
    'data-movie-index': /^\d{1,4}$/,
    'data-ref': /^[^\s"'<>]{1,200}$/,
};

/** A same-origin path: one leading slash, never `//host` or `/\host`. */
export const SAME_ORIGIN_PATH = /^\/(?![/\\])[^\s]*$/;

const stripDataAttrs = (el: Element): void => {
    for (const name of ASSISTANT_DATA_ATTRS) el.removeAttribute(name);
};

/**
 * Normalise one element after DOMPurify's own attribute pass. Exported for
 * tests; registered as an `afterSanitizeAttributes` hook by
 * {@link sanitizeAssistantHtml}.
 */
export function enforceAssistantVocabulary(el: Element): void {
    const className = el.getAttribute('class');
    if (className !== null && !ALLOWED_CLASSES.has(className)) el.removeAttribute('class');

    // Non-anchors never carry a link, a target or a data-* hook.
    if (el.tagName !== 'A') {
        stripDataAttrs(el);
        el.removeAttribute('href');
        return;
    }

    for (const attr of Array.from(el.attributes)) {
        const pattern = DATA_VALUE_PATTERNS[attr.name];
        if (pattern && !pattern.test(attr.value)) el.removeAttribute(attr.name);
    }
    el.removeAttribute('target');
    el.removeAttribute('rel');

    if (el.hasAttribute('data-internal-link')) {
        // Internal links are handled in-app: inert href, no new tab.
        el.setAttribute('href', '#');
        return;
    }

    // External or same-origin link: http(s) or a single-slash path only, always
    // a new tab without opener access.
    stripDataAttrs(el);
    const href = el.getAttribute('href') ?? '';
    if (!/^https?:\/\//i.test(href) && !SAME_ORIGIN_PATH.test(href)) {
        el.removeAttribute('href');
        return;
    }
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
}

/**
 * Without a DOM (SSR) DOMPurify returns its input unchanged, so never use it
 * there. Assistant messages are loaded client-side in `onMount` and are not
 * server-rendered today; if one ever is, this renders its text: the producer
 * already entity-escaped the model's text, so dropping the generated tags and
 * escaping any stray `<` leaves safe, readable text with no markup.
 */
export function assistantHtmlToSafeText(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]*>/g, '')
        .replace(/</g, '&lt;');
}

/** Sanitise assistant message HTML for `{@html}`. Fails closed when no DOM is available. */
export function sanitizeAssistantHtml(html: string): string {
    if (!DOMPurify.isSupported) return assistantHtmlToSafeText(html);
    const hook = (node: Element): void => enforceAssistantVocabulary(node);
    DOMPurify.addHook('afterSanitizeAttributes', hook);
    try {
        return DOMPurify.sanitize(html, ASSISTANT_PURIFY_CONFIG);
    } finally {
        DOMPurify.removeHook('afterSanitizeAttributes', hook);
    }
}
