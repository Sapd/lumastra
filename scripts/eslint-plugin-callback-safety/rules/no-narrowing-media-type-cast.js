// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: no-narrowing-media-type-cast
 *
 * Flags `x as 'movie' | 'tv'` (and the single-token `as 'movie'` / `as 'tv'`).
 *
 * Media types in this codebase span FIVE tokens, not two. `parseMediaId`
 * returns `ParsedMediaTypeToken` = `'movie' | 'series' | 'episode' | 'season'
 * | 'tv'` — both the TMDB (`'tv'`) and API (`'series'`) conventions — and
 * `media_items.media_type` / `external_ids.media_type` store `'episode'` and
 * `'season'` rows. Asserting such a value down to two tokens does not convert
 * it; it just silences the compiler while the wrong string flows on.
 *
 * The failure is quiet and downstream. A consumer writing
 * `mediaType === 'tv' ? seriesPath : moviePath` sends episodes down the movie
 * branch, and nothing errors. Real instances found in this codebase:
 *
 *   - `social-watch-activity.ts` cast a composite `tmdb:123:episode` token to
 *     `'movie' | 'tv'`, so episode modals rendered the generic
 *     "{name} has watched this" instead of "...this episode".
 *   - `media-id-resolver.ts` put the same cast value into
 *     `ResolvedIds.mediaType`, handing every `[id]` route an `'episode'`
 *     disguised as `'movie' | 'tv'`.
 *   - `media-lookup.queries.ts` selected `media_type` from `external_ids`
 *     with no type filter and declared the result `'movie' | 'tv'`.
 *
 * Fix, in order of preference:
 *   1. Widen the destination type — often it should have been
 *      `ParsedMediaTypeToken` all along.
 *   2. Narrow with a runtime check instead of an assertion: the helpers in
 *      `$lib/server/utils/media-types` (`isMovie`, `isSeries`, `isEpisode`,
 *      `isSeason`) accept every convention and actually inspect the value.
 *   3. Reject explicitly, as `for-you/similar.ts` does — validate with
 *      `isMovie() || isSeries()` and return a 400 otherwise.
 *
 * Override: when the value provably cannot be an episode/season/series (for
 * example it came from a query already filtered to movie/tv rows), add
 * `// eslint-disable-next-line callback-safety/no-narrowing-media-type-cast`
 * with a comment saying WHY it is constrained. The disable comment is the
 * record that someone checked.
 *
 * @see docs/dev/eslint-exceptions.md
 */

/** The two-token convention this rule guards. */
const NARROW_TOKENS = new Set(['movie', 'tv']);

/**
 * Path-scoped, like no-direct-sql-begin and require-route-authz.
 *
 * These are the surfaces where a parsed composite token or a raw
 * `media_type` column actually reaches a narrowing assertion — the seam that
 * produced every real bug listed above. There are ~78 such casts repo-wide; the
 * rest are a tracked burn-down rather than a reason to leave this off, since a
 * rule that fires everywhere on day one gets disabled everywhere on day two.
 *
 * Widen this list as the burn-down progresses. Do not add a path here without
 * clearing its existing violations in the same change.
 */
const APPLICABLE_PATH_FRAGMENTS = [
    '/src/lib/server/api/defs/',
    '/src/lib/server/services/',
    '/src/lib/server/utils/',
    '/src/lib/server/database/',
    '/src/lib/components/',
    '/src/lib/stores/',
    '/src/lib/utils/',
    // Supersedes the narrower '/src/routes/api/' the burn-down started with.
    '/src/routes/',
];

/**
 * Same scope, for the shapes a substring cannot express.
 *
 * The top-level `src/lib/*.svelte` pages (Search, Watchlist, ForYou, …) are
 * page-sized components that build API payloads, so they belong in scope, but
 * '/src/lib/' as a fragment would pull in every subtree at once.
 */
const APPLICABLE_PATH_PATTERNS = [/\/src\/lib\/[^/]+\.svelte$/];

/**
 * Collect the string-literal members of a type annotation, ignoring
 * `undefined` / `null` which are orthogonal to the media-type question.
 * Returns null when the annotation contains anything else — a type reference,
 * a wider union, `string` — because those are not the narrowing this rule is
 * about.
 */
function stringLiteralMembers(typeNode) {
    if (!typeNode) return null;

    // Unwrap `as ('movie' | 'tv')`
    if (typeNode.type === 'TSParenthesizedType') {
        return stringLiteralMembers(typeNode.typeAnnotation);
    }

    if (typeNode.type === 'TSLiteralType') {
        const lit = typeNode.literal;
        if (lit && lit.type === 'Literal' && typeof lit.value === 'string') {
            return [lit.value];
        }
        return null;
    }

    if (typeNode.type === 'TSUnionType') {
        const out = [];
        for (const member of typeNode.types) {
            // `undefined` / `null` members do not change the media-type shape.
            if (member.type === 'TSUndefinedKeyword' || member.type === 'TSNullKeyword') continue;
            const nested = stringLiteralMembers(member);
            if (nested === null) return null;
            out.push(...nested);
        }
        return out;
    }

    return null;
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                "Disallow asserting a media type down to 'movie' | 'tv'; the real union has five tokens",
            recommended: true,
        },
        schema: [],
        messages: {
            narrowingCast:
                "Asserting to {{shape}} does not convert the value — media types span 'movie' | 'series' | 'episode' | 'season' | 'tv'. " +
                'If the value can be an episode or season this silently mislabels it. ' +
                'Widen the destination type (often ParsedMediaTypeToken), or narrow with isMovie/isSeries/isEpisode from $lib/server/utils/media-types. ' +
                'If it provably cannot be one of the other tokens, add an eslint-disable-next-line for this rule explaining why.',
        },
    },

    create(context) {
        const filename = (context.filename || context.getFilename() || '').replace(/\\/g, '/');
        const inScope =
            APPLICABLE_PATH_FRAGMENTS.some((frag) => filename.includes(frag)) ||
            APPLICABLE_PATH_PATTERNS.some((re) => re.test(filename));
        if (!inScope) return {};

        return {
            TSAsExpression(node) {
                const members = stringLiteralMembers(node.typeAnnotation);
                if (!members || members.length === 0) return;

                // Only flag assertions whose entire string-literal content sits
                // inside the two-token convention. `as 'movie' | 'episode'` is
                // someone being explicit about a wider set — not this hazard.
                const allNarrow = members.every((m) => NARROW_TOKENS.has(m));
                if (!allNarrow) return;

                context.report({
                    node,
                    messageId: 'narrowingCast',
                    data: { shape: members.map((m) => `'${m}'`).join(' | ') },
                });
            },
        };
    },
};
