// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Build a `Content-Disposition: attachment` header value safely.
 *
 * The naive form — `attachment; filename="${name}"` — breaks on any name
 * containing a double quote, because the quote closes the quoted-string early
 * and whatever follows is parsed as further header parameters. Names reaching
 * these headers are not trusted: media filenames come from disk (anyone who can
 * add files to a library controls them verbatim) and export filenames embed
 * usernames.
 *
 * Node's `Headers` rejects raw CR/LF, so full response-splitting is already
 * blocked — but quote-breaking and parameter injection are not, and clients
 * disagree wildly about how to recover from a malformed value.
 *
 * Emits both forms per RFC 6266:
 *   filename="..."            ASCII fallback, for older clients
 *   filename*=UTF-8''...      the real name, percent-encoded
 * which also fixes non-ASCII names (previously mangled or dropped, since a raw
 * UTF-8 byte is not valid in the quoted form).
 */

/** Control chars are illegal in a header value; `"` and `\` break the quoting. */
// eslint-disable-next-line no-control-regex -- stripping control chars is the point
const UNSAFE_HEADER_CHARS = /[\u0000-\u001F\u007F]/g;

/**
 * Reduce a name to the quoted-string-safe ASCII subset.
 * Non-ASCII becomes `_` — the `filename*` parameter carries the true name.
 */
function asciiFallback(name: string): string {
    return name
        .replace(UNSAFE_HEADER_CHARS, '')
        .replace(/[^\u0020-\u007E]/g, '_')
        .replace(/["\\]/g, '_');
}

/**
 * @param filename Desired name. Path components are stripped by the caller;
 *   anything left that would break the header is neutralised here.
 * @param fallback Used when `filename` sanitises down to nothing (e.g. a name
 *   made entirely of control characters).
 */
export function attachmentDisposition(filename: string, fallback = 'download'): string {
    const trimmed = filename.trim();
    const ascii = asciiFallback(trimmed).trim() || fallback;
    // encodeURIComponent leaves !'()*~-._ raw. Of those, RFC 8187's attr-char
    // grammar permits only ! - . _ ~ — so ' ( ) * must be escaped by hand or
    // the ext-value is invalid. This is not exotic: "Track (Live).mp3" and
    // "Guns N' Roses - Song.mp3" are ordinary music-library filenames.
    const encoded =
        encodeURIComponent(trimmed.replace(UNSAFE_HEADER_CHARS, '')).replace(
            /['()*]/g,
            (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase(),
        ) || fallback;
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
