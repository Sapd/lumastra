// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The single XML-escaping implementation.
 *
 * This lives here because the codebase previously had TWO copies — one for the
 * tvOS Top Shelf SVG overlays and one for the OpenSubsonic serializer — and
 * they drifted: the overlay copy learned to strip XML-illegal control
 * characters (a real bug that permanently stuck overlay renders), the Subsonic
 * copy did not, leaving it able to emit malformed XML. Anything that builds XML
 * by hand must import from here rather than write its own.
 */

/**
 * C0 control chars that are illegal in XML 1.0 *as characters* — entity-escaping
 * cannot rescue them, because they are not a syntax problem. `&#11;` is just as
 * invalid as a raw `\x0B`, so the only correct handling is removal.
 *
 * Excludes \t \n \r, which XML 1.0 permits.
 *
 * These reach us for real, from two directions: malformed scan/NFO metadata and
 * ID3 tags (a title carrying `\x0B` or `\x1F`), and request parameters echoed
 * back into error messages, where a client can send one percent-encoded.
 */
// eslint-disable-next-line no-control-regex -- intentional: matching XML-1.0-illegal C0 control chars is the whole point.
export const XML_ILLEGAL_CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

/**
 * Escape a string for embedding in XML, as element text or as a
 * double-or-single-quoted attribute value.
 *
 * Strips XML-1.0-illegal control characters FIRST (see above — escaping cannot
 * make them legal), then replaces the five XML entities. Order matters among
 * the entity replacements: `&` MUST go first, or the `&` in the entities
 * produced by the later replacements would themselves be escaped.
 */
export function escapeXml(value: string): string {
    return value
        .replace(XML_ILLEGAL_CONTROL_CHARS_RE, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
