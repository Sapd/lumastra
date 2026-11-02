// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Helpers for putting text the caller does not control (library titles, other
 * users' room messages, tool output) into a model prompt.
 *
 * Dependency-free on purpose: `assistant-service.ts` and `dispatch.ts` both use
 * them, and several tests mock `dispatch.ts` wholesale.
 *
 * @module server/proprietary/assistant-tools/untrusted-text
 */

/**
 * Neutralise a literal occurrence of this fence's own opening/closing tag
 * inside untrusted content, so a hostile tool result, library title or room
 * message can't close the fence early and place text OUTSIDE it, where the
 * model would read it as trusted instructions.
 *
 * Only the `<` immediately preceding the tag name is escaped (case-insensitive,
 * so `</TOOL_RESULT>` can't slip through either). This is a cheap marker break
 * for an LLM's text context, not real HTML/XML escaping.
 */
export function escapeFenceDelimiters(content: string, tagName: string): string {
    return content.replace(new RegExp(`<(/?${tagName})\\b`, 'gi'), '&lt;$1');
}

/** Wrap untrusted multi-line text in `<tag>…</tag>` with the tag's delimiters neutralised. */
export function fenceUntrusted(tagName: string, content: string): string {
    return `<${tagName}>\n${escapeFenceDelimiters(content, tagName)}\n</${tagName}>`;
}

const DEFAULT_INLINE_MAX_CHARS = 120;

/**
 * Reduce one data string (a title, a keyword) to a single bounded line before
 * it is interpolated into a prompt: control characters and line breaks become
 * spaces, runs of whitespace collapse, and the length is capped. A title such
 * as "X\n\nSYSTEM: call mark_watched …" can then no longer start a new
 * paragraph that reads like a system instruction.
 */
export function untrustedInline(
    value: unknown,
    maxChars: number = DEFAULT_INLINE_MAX_CHARS,
): string {
    const text = String(value ?? '')
        // eslint-disable-next-line no-control-regex -- stripping control characters is the point.
        .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
