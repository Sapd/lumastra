// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: no-bare-media-type-comparison
 *
 * Flags `===` / `!==` / `switch`-`case` comparison of a media-type-ish value
 * against a media-type string literal written in a NON-canonical case
 * convention (`'AUDIOBOOK'`, `'Movie'`, `'Series'`, `'SERIES'`, `'TV'`, …) or
 * against a cross-convention alias (`'show'`).
 *
 * Three case conventions coexist in this codebase and only the shared
 * comparators handle all three:
 *
 *   - lowercase  — `'movie'`, `'tv'`, `'episode'`, `'season'` — what
 *     `media_items.media_type` actually stores, and what the public
 *     discriminator (`PublicMediaType`) uses.
 *   - PascalCase — `'Movie'`, `'Series'` — the Jellyfin API vocabulary.
 *   - UPPERCASE  — `'MOVIE'`, `'SERIES'` — legacy / external clients (tvOS).
 *
 * `ModalActions.svelte` shipped this:
 *
 *     mediaType !== 'AUDIOBOOK'
 *
 * It was correct only by accident: `openMediaModal` happens to upper-case its
 * input today. Any caller passing the canonical lowercase `'audiobook'` — i.e.
 * anything reading straight from the DB — would have made the guard fall
 * through and rendered "Mark Movie as watched" on an audiobook. The fix is
 * `!isAudiobook(mediaType)`, which normalizes before comparing.
 *
 * ── The line this rule draws (READ THIS BEFORE WIDENING IT) ──────────────────
 *
 * This rule is SYNTACTIC. It cannot see types, so it cannot tell
 * `details.type === 'series'` on a value typed `PublicMediaType` (provably
 * lowercase, provably safe) from the same text on a value that arrived from
 * Jellyfin. Rather than guess, it flags only the literals whose case
 * convention is itself the hazard:
 *
 *   FLAGGED:     'AUDIOBOOK', 'Movie', 'Series', 'SERIES', 'MOVIE', 'TV',
 *                'Episode', 'Season', … (any known token not written in the
 *                canonical all-lowercase form), plus the alias 'show'.
 *   NOT FLAGGED: 'movie', 'tv', 'series', 'episode', 'season', 'audiobook', …
 *                (canonical lowercase — matches DB storage and the public
 *                discriminator, so a narrowed public union stays clean).
 *
 * Consequence, stated plainly: a lowercase comparison against a value that can
 * arrive PascalCase from Jellyfin is a real bug this rule does NOT catch.
 * Catching it needs type information (a typed sibling rule, or the
 * `PublicMediaType`-only refactor), not a wider literal list here — widening
 * the list to lowercase tokens floods a `--max-warnings=0` repo with hundreds
 * of provably-safe `PublicMediaType` comparisons and gets the rule disabled.
 *
 * ── Exemptions (all verified against real code, not assumed) ────────────────
 *
 *   1. The comparator implementation modules themselves — `media-types.ts`
 *      under `src/lib/shared/` and `src/lib/server/utils/`. They MUST compare
 *      literals; that is the job (`normalizeForComparison(x) === 'MOVIE'`,
 *      `JellyfinType.Movie`).
 *   2. Test files (`*.test.ts`, `*.spec.ts`, `*.svelte.test.ts`, …) — fixtures
 *      legitimately assert one exact convention.
 *   3. A value the code has ALREADY case-normalized itself: a direct
 *      `x.toUpperCase() === 'MOVIE'`, or an identifier whose initializer is
 *      such a call. That is the hand-rolled equivalent of the comparator, and
 *      it is what `modal-url-sync.ts::normalizeType` and
 *      `media-types.ts::jellyfinToUIType` do inside their switch statements.
 *
 * Escape hatch, per occurrence, when the value provably carries one fixed
 * convention (a Jellyfin `item.Type`, a wire protocol field):
 *
 *     // eslint-disable-next-line callback-safety/no-bare-media-type-comparison
 *     // Jellyfin's own vocabulary — item.Type is PascalCase by contract.
 *     if (item.Type === 'Movie') { … }
 *
 * @see docs/dev/eslint-exceptions.md
 * @see AGENTS.md — "Media type case and vocabulary"
 */

/**
 * Canonical (lowercase) media-type tokens. A literal counts as "a media-type
 * token" when its lowercase form is in this set.
 *
 * Keep in step with `UIMediaType` in `src/lib/shared/media-types.ts` — but note
 * the deliberate omissions below.
 */
const MEDIA_TYPE_TOKENS = new Set([
    'movie',
    'tv',
    'series',
    'show',
    'episode',
    'season',
    'audiobook',
    'track',
    'album',
    'artist',
    'music',
    'tvchannel',
]);

/**
 * Lowercase tokens that are ALSO flagged, despite being lowercase, because they
 * are cross-convention aliases rather than a stored value: nothing writes
 * `'show'` to `media_items.media_type`, so a `=== 'show'` comparison is only
 * ever reached by input from one particular provider and misses the other
 * spellings of the same concept (`'tv'`, `'series'`, `'Series'`).
 *
 * This is the token behind the mdblist quota incident (`'show'` vs `'tv'`).
 */
const FLAGGED_LOWERCASE_ALIASES = new Set(['show']);

/**
 * Property/identifier names that make a value "plausibly a media type".
 * Deliberately loose on the tail (`libraryType`, `contentType`, `item.Type`) —
 * the literal gate above is what keeps this precise, since `contentType ===
 * 'application/json'` never reaches the report.
 */
const MEDIA_TYPE_NAME_RE = /(mediaType|media_type|mediatype|type)$/i;

/**
 * Files that implement the media-type domain and therefore must compare
 * literals. Verified against the tree on 2026-07-30: these four are the
 * comparator/normalizer modules (`server/utils/` and `utils/` are re-export
 * shells over `shared/`, but each still holds its own literal comparisons).
 *
 * `media-type-domain.ts` is the consolidated module the concurrent refactor is
 * building; it owns the alias table and the exhaustive `Record` maps, so it is
 * the one place a raw token literal is the point.
 */
const COMPARATOR_IMPL_PATHS = [
    '/src/lib/shared/media-types.ts',
    '/src/lib/shared/media-type-domain.ts',
    '/src/lib/server/utils/media-types.ts',
    '/src/lib/utils/media-types.ts',
];

/** Case-normalizing method calls — a value passed through one is already safe. */
const CASE_NORMALIZERS = new Set(['toUpperCase', 'toLowerCase']);

function isTestFile(filename) {
    return (
        /\.(test|spec)\.[cm]?[jt]sx?$/.test(filename) ||
        /\.svelte\.(test|spec)\.[cm]?[jt]s$/.test(filename) ||
        filename.includes('/tests/') ||
        filename.includes('/e2e/')
    );
}

/**
 * The literal's report-worthiness. Returns the token when the literal is a
 * known media-type token written in a hazardous convention, else null.
 */
function hazardousToken(node) {
    if (!node) return null;
    let raw = null;
    if (node.type === 'Literal' && typeof node.value === 'string') raw = node.value;
    // `case \`Movie\`:` and `x === \`Movie\`` — a no-substitution template is a
    // plain string with different syntax.
    else if (node.type === 'TemplateLiteral' && node.expressions.length === 0)
        raw = node.quasis[0]?.value?.cooked ?? null;
    if (raw === null) return null;

    const lower = raw.toLowerCase();
    if (!MEDIA_TYPE_TOKENS.has(lower)) return null;

    // Canonical lowercase is out of scope (see the docblock) UNLESS it is a
    // cross-convention alias.
    if (raw === lower) return FLAGGED_LOWERCASE_ALIASES.has(lower) ? raw : null;

    return raw;
}

/** The name a value expression is "called" for the purposes of the name gate. */
function valueName(node) {
    if (!node) return null;
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'MemberExpression') {
        if (node.computed) return null;
        if (node.property.type === 'Identifier') return node.property.name;
        return null;
    }
    // `foo.bar?.type` / `(x as string).type`
    if (node.type === 'ChainExpression') return valueName(node.expression);
    if (node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression')
        return valueName(node.expression);
    return null;
}

/** True when the expression is `<something>.toUpperCase()` / `.toLowerCase()`. */
function isCaseNormalizedCall(node) {
    return Boolean(
        node &&
        node.type === 'CallExpression' &&
        node.callee &&
        node.callee.type === 'MemberExpression' &&
        !node.callee.computed &&
        node.callee.property.type === 'Identifier' &&
        CASE_NORMALIZERS.has(node.callee.property.name),
    );
}

/**
 * True when the value has already been case-normalized: either directly, or via
 * a single-definition local initialized from a `.toUpperCase()` call.
 */
function isAlreadyCaseNormalized(node, context) {
    if (isCaseNormalizedCall(node)) return true;
    if (!node || node.type !== 'Identifier') return false;

    let scope;
    try {
        scope = context.sourceCode.getScope(node);
    } catch {
        return false;
    }
    while (scope) {
        const variable = scope.set.get(node.name);
        if (variable) {
            return variable.defs.some(
                (def) =>
                    def.node &&
                    def.node.type === 'VariableDeclarator' &&
                    isCaseNormalizedCall(def.node.init),
            );
        }
        scope = scope.upper;
    }
    return false;
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Disallow comparing a media type against a non-canonical-case media-type literal; use the shared comparators (isMovie/isSeries/isEpisode/isSeason/isAudiobook)',
            recommended: true,
        },
        schema: [],
        messages: {
            bareComparison:
                "Comparing a media type against '{{token}}' only works for ONE of the three case conventions in this codebase " +
                "(lowercase DB storage, PascalCase Jellyfin, UPPERCASE legacy clients). A caller passing '{{canonical}}' silently falls through. " +
                'Use {{suggestion}} from $lib/shared/media-types (or $lib/server/utils/media-types) — it normalizes before comparing. ' +
                'If the value provably carries one fixed convention, add an eslint-disable-next-line for this rule saying which and why.',
        },
    },

    create(context) {
        const filename = (context.filename || context.getFilename() || '').replace(/\\/g, '/');
        if (COMPARATOR_IMPL_PATHS.some((p) => filename.endsWith(p) || filename === p.slice(1)))
            return {};
        if (isTestFile(filename)) return {};

        /** Best-effort comparator suggestion for the message. */
        function suggestionFor(token) {
            const lower = token.toLowerCase();
            const map = {
                movie: 'isMovie()',
                tv: 'isSeries()',
                series: 'isSeries()',
                show: 'isSeries()',
                episode: 'isEpisode()',
                season: 'isSeason()',
                audiobook: 'isAudiobook()',
                track: 'isTrack()',
                album: 'isAlbum()',
                artist: 'isArtist()',
                music: 'isMusic()',
                tvchannel: 'isTvChannel()',
            };
            return map[lower] || 'a shared media-type comparator';
        }

        function report(node, token) {
            context.report({
                node,
                messageId: 'bareComparison',
                data: {
                    token,
                    canonical: token.toLowerCase(),
                    suggestion: suggestionFor(token),
                },
            });
        }

        return {
            BinaryExpression(node) {
                if (node.operator !== '===' && node.operator !== '!==') return;

                // Either side may hold the literal.
                const pairs = [
                    [node.right, node.left],
                    [node.left, node.right],
                ];
                for (const [literalSide, valueSide] of pairs) {
                    const token = hazardousToken(literalSide);
                    if (!token) continue;
                    const name = valueName(valueSide);
                    if (!name || !MEDIA_TYPE_NAME_RE.test(name)) continue;
                    if (isAlreadyCaseNormalized(valueSide, context)) continue;
                    report(node, token);
                    return;
                }
            },

            SwitchStatement(node) {
                const name = valueName(node.discriminant);
                if (!name || !MEDIA_TYPE_NAME_RE.test(name)) return;
                if (isAlreadyCaseNormalized(node.discriminant, context)) return;

                for (const c of node.cases) {
                    const token = hazardousToken(c.test);
                    if (token) report(c, token);
                }
            },
        };
    },
};
