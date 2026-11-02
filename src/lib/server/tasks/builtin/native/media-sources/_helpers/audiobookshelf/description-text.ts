// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * AudiobookShelf ships `media.metadata.description` as an HTML fragment (its
 * own editor produces `<p>…</p>` bodies), not plain text. Verified against a
 * live server: a real book's description starts
 * `'<p>\xa0Der neueste Auftrag an die sieben Detektive…'` — an opening `<p>`
 * immediately followed by a non-breaking space. Lumastra's `overview` column
 * is plain text end to end (browse cards, the media modal, Active Streams,
 * section builders, and the public `/api/v1` surface a tvOS-style client
 * reads), so writing the fragment straight through renders literal `<p>`
 * tags to end users instead of a paragraph break.
 *
 * NOT an XSS sanitiser. AudiobookShelf is the operator's own server (not a
 * trust boundary the way user-submitted HTML would be), and every consumer
 * of `overview` renders it as **text**, never as `innerHTML`. The only goal
 * here is readability — turning markup into the plain-text equivalent a
 * person would read. Do not reuse this to "sanitise" untrusted HTML destined
 * for a DOM sink; it does not attempt to be safe for that job (e.g. it does
 * not defang `<script>` bodies, it just strips the tag and drops the
 * enclosed text like any other element).
 *
 * `dompurify` is already a dependency (see `package.json`), but it was not
 * reused here: it needs a DOM (typically via `jsdom`, which is not a
 * dependency of this project) to run outside a browser, and its job is
 * "produce safe HTML for rendering" — the opposite shape of what is needed,
 * which is "produce plain text with sensible paragraph/line breaks". Pulling
 * in a DOM implementation for a handful of regex substitutions was judged
 * not worth the new dependency.
 */

/** Non-breaking space — shows up raw in ABS descriptions, not just as `&nbsp;`. */
const NBSP = ' ';

/**
 * Tags whose start/end marks a paragraph-like boundary. Replaced with a
 * space (not deleted) so `…harmlos an:</p><p>Doch kaum…` becomes
 * `…harmlos an: Doch kaum…` rather than the words gluing together as
 * `an:Doch`. Both the opening and closing form are matched (and `<br>`'s
 * self-closing variants) since malformed upstream HTML is not guaranteed to
 * close every element it opens.
 */
const BLOCK_BOUNDARY_TAG = /<\s*\/?\s*(?:p|div|li|br)(?:\s[^>]*)?\s*\/?\s*>/gi;

/** Any tag left after the block-boundary pass (inline formatting, spans, etc). */
const ANY_TAG = /<[^>]*>/g;

/**
 * The named entities this data actually contains, plus the two numeric forms
 * called out by the bug report (`&#8217;`/`&#x2019;`, a right single quote).
 * Matched as one alternation so each entity is decoded exactly once — no
 * multi-pass re-decoding that could turn a literal `&amp;lt;` into `<`.
 */
const ENTITY = /&amp;|&lt;|&gt;|&quot;|&#39;|&apos;|&nbsp;|&#x[0-9a-fA-F]+;|&#[0-9]+;/g;

const NAMED_ENTITIES: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
};

function decodeEntity(match: string): string {
    const named = NAMED_ENTITIES[match];
    if (named !== undefined) return named;

    const hex = /^&#x([0-9a-fA-F]+);$/.exec(match);
    if (hex) return String.fromCodePoint(Number.parseInt(hex[1], 16));

    const decimal = /^&#([0-9]+);$/.exec(match);
    if (decimal) return String.fromCodePoint(Number.parseInt(decimal[1], 10));

    // Unreachable given ENTITY's alternation, but returning the raw match
    // (rather than throwing) keeps this a total function.
    return match;
}

/**
 * Turn an AudiobookShelf HTML description into readable plain text.
 *
 * Pure and idempotent: sanitising already-clean text returns it unchanged.
 * Idempotence matters operationally, not just cosmetically — the reconcile
 * sweep in `sweep.ts` rewrites `overview` on every observed ABS revision
 * change, so this function reprocesses its own prior output on every later
 * revision bump of the same book. A non-idempotent transform (e.g. one that
 * re-escaped or progressively mangled whitespace) would drift a little more
 * on every sync instead of converging.
 *
 * Returns `null` for `null`/`undefined`/whitespace-only input — the column
 * this feeds (`media_items.overview`) is nullable, and callers must not see
 * the literal string `"null"` or an empty string standing in for "no
 * description".
 */
export function sanitizeAudiobookDescription(html: string | null | undefined): string | null {
    if (typeof html !== 'string') return null;

    const withoutTags = html
        .replace(BLOCK_BOUNDARY_TAG, ' ')
        .replace(ANY_TAG, ' ')
        .replace(ENTITY, decodeEntity)
        .replaceAll(NBSP, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return withoutTags.length > 0 ? withoutTags : null;
}
