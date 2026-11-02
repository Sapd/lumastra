// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: require-has-files-with-active-status
 *
 * Flags any `sql`...`` tagged template literal that selects movie/tv rows
 * from `media_items` without also filtering by `has_files = true`. This is
 * the rule that would have caught the 2026-05-22 "ghost Recently Added"
 * bug: getRecentlyAddedItems returned 18-of-20 TMDB-synced catalog rows
 * that had no local files, surfaced as user-facing cards.
 *
 * Why this matters:
 *   `media_items` is a unified catalog + library table. Catalog rows
 *   exist for TMDB-only entries (no local files) so that embeddings,
 *   watchlist, ratings, requests, and similarity search all key off the
 *   same internal UUID. User-facing lists ("Recently Added", "Random
 *   Picks", "Continue Watching", etc.) need the LIBRARY-scope view —
 *   rows with actual files. Without `has_files = true`, those lists
 *   leak catalog ghosts as clickable cards.
 *
 * Bug shape (the regression to catch):
 *     SELECT mi.id, mi.title, mi.media_type, ...
 *     FROM media_items mi
 *     WHERE mi.status = 'active'
 *       AND mi.media_type IN ('movie', 'tv')
 *   --  ^^^ no `AND mi.has_files = true` — ghosts leak through
 *     ORDER BY ...
 *
 * The trigger is intentionally narrow:
 *   1. Template references `FROM media_items` or `JOIN media_items`.
 *   2. Template contains the literal string `'movie'` — the tell of a
 *      user-facing list filtered to top-level playable items. We
 *      intentionally do NOT key on `'tv'` alone, because joined-ancestor
 *      filters use it for parent series rows
 *      (`series.media_type IN ('tv', 'series')`); movies have no
 *      children, so `'movie'` as a literal is a clean signal.
 *   3. Template does NOT contain `has_files` in executable position (a
 *      literal filter or a conditional fragment satisfies it; a mention in
 *      a JS comment or in a SQL `--` / block comment does NOT).
 *
 * Catalog/admin/sync queries don't typically filter by `'movie'`
 * literals — they read the whole table or use `media_type = ANY(...)`
 * driven by a parameter. So narrow scope keeps false positives low.
 * Search and browse queries that include `has_files` conditionally
 * (`${availableOnly ? sql`AND mi.has_files = true` : sql``}`) still pass
 * because the substring `has_files` is present in the template.
 *
 * Override per-line when discovery/search semantics intentionally
 * include items without files (e.g. a "Trending today" row that mixes
 * available and requestable items):
 *   // eslint-disable-next-line callback-safety/require-has-files-with-active-status
 *
 * @see docs/dev/database-architecture.md
 */

// Files under these path fragments are checked.
const APPLICABLE_PATH_FRAGMENTS = [
    '/src/routes/',
    '/src/lib/server/database/queries/',
    '/src/lib/server/services/',
];

// Files that are catalog-scope by design — catalog mutations, sync
// pipelines, search/discovery surfaces that intentionally surface
// requestable items, embedding/metadata maintenance, admin routes.
const EXEMPT_PATH_FRAGMENTS = [
    '.test.ts',
    '.spec.ts',
    '.integration.test.ts',
    '/migrations/',
    // Catalog mutation & lookup — own the full media_items lifecycle.
    '/src/lib/server/database/queries/catalog-operations.queries.ts',
    '/src/lib/server/database/queries/media-upsert.ts',
    '/src/lib/server/database/queries/media-queries.ts',
    '/src/lib/server/database/queries/media-items.queries.ts',
    '/src/lib/server/database/queries/media-lookup.queries.ts',
    '/src/lib/server/database/queries/media-hierarchy.queries.ts',
    '/src/lib/server/database/queries/external-ids.queries.ts',
    '/src/lib/server/database/queries/resolvers/',
    // Admin / integrity / cleanup queries.
    '/src/lib/server/database/queries/admin-media.queries.ts',
    '/src/lib/server/database/queries/admin-stats.queries.ts',
    '/src/lib/server/database/queries/ai-admin.queries.ts',
    '/src/lib/server/database/queries/ai-sync.queries.ts',
    '/src/lib/server/database/queries/integrity.queries.ts',
    '/src/lib/server/database/queries/database-cleanup.queries.ts',
    '/src/lib/server/database/queries/metadata-aggregation.queries.ts',
    '/src/lib/server/database/queries/ingest-map.queries.ts',
    '/src/lib/server/database/queries/cluster-nodes.queries.ts',
    // Embedding / suggestion engine — work on the full catalog.
    '/src/lib/server/database/queries/embeddings.queries.ts',
    '/src/lib/server/database/queries/latest-embeddings.queries.ts',
    '/src/lib/server/database/queries/suggestion-engine.queries.ts',
    '/src/lib/server/database/queries/suggestion-search.queries.ts',
    '/src/lib/server/database/queries/suggestion-management.queries.ts',
    // Search & discovery — intentionally surface requestable items.
    // (They still gate has_files conditionally via `availableOnly` flags;
    //  this exemption is belt-and-suspenders.)
    '/src/lib/server/database/queries/search.queries.ts',
    // Jellyfin compat queries — must mirror what Jellyfin would return,
    // including items that aren't yet in the Lumastra library.
    '/src/lib/server/database/queries/jellyfin-browse.queries.ts',
    '/src/lib/server/database/queries/jellyfin-item-detail.queries.ts',
    // Music queries — different media_type universe, no ghost rows.
    '/src/lib/server/database/queries/music.queries.ts',
    '/src/lib/server/database/queries/music-recommendations.queries.ts',
    '/src/lib/server/database/queries/music-quick-picks.queries.ts',
    '/src/lib/server/database/queries/album-art.queries.ts',
    '/src/lib/server/database/queries/artist-enrichment.queries.ts',
    // LiveTV / non-entertainment — different surface.
    '/src/lib/server/database/queries/livetv-programs.queries.ts',
    '/src/lib/server/database/queries/livetv-setup.queries.ts',
    '/src/lib/server/database/queries/non-entertainment-browse.queries.ts',
    // Misc maintenance / pipeline.
    '/src/lib/server/database/queries/popularity.queries.ts',
    '/src/lib/server/database/queries/image-sync.queries.ts',
    '/src/lib/server/database/queries/episode-orderings.queries.ts',
    '/src/lib/server/database/queries/episode-reorder.queries.ts',
    '/src/lib/server/database/queries/media-files.queries.ts',
    '/src/lib/server/database/queries/media-artwork.queries.ts',
    '/src/lib/server/database/queries/media-type-cache.queries.ts',
    '/src/lib/server/database/queries/user-media-flags.queries.ts',
    '/src/lib/server/database/queries/stage-state.queries.ts',
    '/src/lib/server/database/queries/library-groups.queries.ts',
    // Background/scanner services.
    '/src/lib/server/services/catalog.service.ts',
    '/src/lib/server/services/media-deletion.service.ts',
    '/src/lib/server/services/media-lifecycle.service.ts',
    '/src/lib/server/services/embedding-operations.service.ts',
    '/src/lib/server/services/jellyfin-sync.service.ts',
    '/src/lib/server/services/suggestion-engine.service.ts',
    '/src/lib/server/services/personal-stats.service.ts',
    '/src/lib/server/services/playback-analytics.service.ts',
    // Admin-only routes.
    '/src/routes/admin/',
    '/src/routes/api/admin/',
    // ─────────────────────────────────────────────────────────────────────
    // Audited 2026-06-05 while bringing lint:typed to green. Each of these
    // CANNOT leak catalog ghosts as user-facing cards, for one of two
    // structural reasons:
    //
    //   1. The query reads FROM the user's own watch state / history
    //      (`user_media_state`, `user_watch_history`, `watch_history`) and
    //      JOINs media_items — a row can only exist there if the user
    //      actually watched it, which requires a local file. So has_files is
    //      structurally implied. (watch-state, user-watch-history, mood-vector,
    //      and the watched-item helpers inside for-you.service.)
    //   2. The query is an intentional discovery/admin surface:
    //      - browse.queries gates has_files conditionally via the
    //        `availableOnly` flag (the route decides); when false it
    //        deliberately includes requestable items.
    //      - for-you.service is an explicit available+requestable mix
    //        (computes is_available / canRequest; config 70/30 ratio).
    //      - embedding-stats is the admin embedding dashboard (full catalog).
    //      - library-backdrop only selects rows that JOIN media_files, i.e.
    //        items that definitionally HAVE files.
    //
    // featured-pick.queries.ts: every candidate row carries `is_available`
    // (isAvailableExpr) and the transform sets `canRequest = !is_available`,
    // so the featured strip is an intentional available+requestable surface
    // (same discovery pattern as trending / for-you / onboarding-movies). A
    // file-less candidate renders with a "request" affordance, not a broken
    // play link — so the ghost-card hazard this rule guards against does not
    // apply. Access-scoped via buildLibraryAccessFilter(deniedGroupIds).
    '/src/lib/server/database/queries/featured-pick.queries.ts',
    '/src/lib/server/database/queries/browse.queries.ts',
    '/src/lib/server/database/queries/embedding-stats.queries.ts',
    '/src/lib/server/database/queries/user-watch-history.queries.ts',
    '/src/lib/server/database/queries/watch-state.queries.ts',
    '/src/lib/server/services/for-you.service.ts',
    '/src/lib/server/services/library-backdrop.service.ts',
    '/src/lib/server/services/mood-vector.service.ts',
];

// Regex matching SQL that reads from or joins media_items.
const MEDIA_ITEMS_SQL = /\b(?:from|join)\s+(?:[\w$]+\.)?"?media_items"?\b/i;

// The "user-facing list filtered to top-level playable items" tell:
// a literal `'movie'` quoted string. Catalog mutations / scanner queries
// don't use this literal — they read the whole table or parametrize
// media_type via `= ANY(${types})`. We intentionally do NOT match `'tv'`
// because joined-ancestor filters use it for parent series rows
// (`series.media_type IN ('tv', 'series')`); that would yield false
// positives in routes that walk episode→season→series chains. Movies
// have no children, so `'movie'` as a literal stays a clean signal.
const MOVIE_LITERAL = /['"]movie['"]/;

// Marker that says "this query intentionally addresses library scope".
// Any occurrence in the template's EXECUTABLE text is enough — a literal
// filter or a conditional fragment. Comments are blanked before this runs
// (both JS comments and SQL `--` / block comments), so naming the column in
// prose does not satisfy it.
const HAS_FILES_MARKER = /\bhas_files\b/;

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Require `has_files = true` filter when a sql template selects movie/tv rows from media_items',
            category: 'Possible Errors',
            recommended: true,
        },
        schema: [],
        messages: {
            missingHasFiles:
                'sql template selects movie/tv rows from `media_items` ' +
                'without `has_files = true`. Catalog rows for TMDB-only ' +
                'items (no local files) will leak through as user-facing ' +
                'cards, and clicking one navigates to a non-playable ' +
                'watch URL. Add `AND mi.has_files = true` to the WHERE, ' +
                'or use `// eslint-disable-next-line ' +
                'callback-safety/require-has-files-with-active-status` ' +
                'when discovery semantics intentionally include ' +
                'requestable items.',
        },
    },

    create(context) {
        const filename = context.filename || context.getFilename?.() || '';
        const normalised = filename.replace(/\\/g, '/');

        const isApplicable = APPLICABLE_PATH_FRAGMENTS.some((frag) => normalised.includes(frag));
        if (!isApplicable) return {};

        const isExempt = EXEMPT_PATH_FRAGMENTS.some((frag) => normalised.includes(frag));
        if (isExempt) return {};

        /**
         * Source text of `node` with every comment inside it replaced by
         * spaces. Offsets are preserved so the result stays positionally
         * aligned with the original; only comment CONTENT is removed.
         */
        function blankComments(node) {
            const sourceCode = context.sourceCode;
            const [start, end] = node.range;
            let text = sourceCode.getText(node);
            for (const c of sourceCode.getCommentsInside(node)) {
                if (c.range[0] < start || c.range[1] > end) continue;
                const s = c.range[0] - start;
                const e = c.range[1] - start;
                text = text.slice(0, s) + ' '.repeat(e - s) + text.slice(e);
            }
            return text;
        }

        /**
         * Blanks SQL comments (`-- to end of line`, `/* … *\/`) out of `text`,
         * leaving quoted SQL string bodies alone so an apostrophe or a `--`
         * inside a literal cannot swallow real filter text.
         *
         * `blankComments` only removes JS comments: it uses
         * `getCommentsInside()`, and the lexer sees no comments inside a
         * template literal. A `-- has_files is applied by the caller` line in
         * the SQL is plain template TEXT, so before this the rule's own doc
         * comment was accurate when it said "commented hint" satisfied the
         * filter requirement. That is the same false-negative shape as the
         * prose hole fixed in no-unscoped-media-items on 2026-07-30 — prose
         * standing in for enforcement — so it is closed the same way.
         * Measured: 0 new reports tree-wide, i.e. nothing relied on it.
         */
        function blankSqlComments(text) {
            let out = '';
            let i = 0;
            let quote = null;
            while (i < text.length) {
                const ch = text[i];
                if (quote) {
                    out += ch;
                    if (ch === quote) quote = null;
                    i += 1;
                } else if (ch === "'" || ch === '"') {
                    quote = ch;
                    out += ch;
                    i += 1;
                } else if (ch === '-' && text[i + 1] === '-') {
                    // Line comment: blank to EOL, preserving offsets.
                    while (i < text.length && text[i] !== '\n') {
                        out += ' ';
                        i += 1;
                    }
                } else if (ch === '/' && text[i + 1] === '*') {
                    // Block comment: blank through the terminator, keeping
                    // newlines so reported line numbers stay correct.
                    while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
                        out += text[i] === '\n' ? '\n' : ' ';
                        i += 1;
                    }
                    if (i < text.length) {
                        out += '  ';
                        i += 2;
                    }
                } else {
                    out += ch;
                    i += 1;
                }
            }
            return out;
        }

        return {
            TaggedTemplateExpression(node) {
                const tag = node.tag;
                const isSqlTag =
                    (tag.type === 'Identifier' &&
                        /^(sql|db|client|sqlClient|tx|trx|transaction)$/i.test(tag.name)) ||
                    (tag.type === 'MemberExpression' &&
                        tag.property &&
                        tag.property.type === 'Identifier' &&
                        /^(sql|unsafe)$/i.test(tag.property.name));
                if (!isSqlTag) return;

                // Use the full source range of the tagged template, including
                // substitution expressions. This is the only way to see
                // conditionally-composed fragments like
                //   ${availableOnly ? sql`AND has_files = true` : sql``}
                // where the marker lives in a nested template that
                // template-quasis extraction would miss.
                //
                // Comments inside that range are blanked out first: a comment
                // merely *naming* has_files must not satisfy the filter
                // requirement. Same false-negative class as the prose hole
                // fixed in no-unscoped-media-items on 2026-07-30 — narrower
                // here (the prose has to sit inside the template) and not
                // currently exploited anywhere, but closed for the same reason.
                const text = blankSqlComments(blankComments(node));
                if (!MEDIA_ITEMS_SQL.test(text)) return;
                if (!MOVIE_LITERAL.test(text)) return;
                if (HAS_FILES_MARKER.test(text)) return;

                context.report({
                    node,
                    messageId: 'missingHasFiles',
                });
            },
        };
    },
};
