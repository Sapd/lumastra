// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

const ts = require('typescript');

/**
 * ESLint Rule: no-comparator-on-narrowed-media-type  (the dead-guard rule)
 *
 * Flags a media-type comparator applied to a value that a narrowing function
 * has ALREADY collapsed, where the comparator's token is outside that
 * function's range — i.e. a guard that reads correctly, type-checks, and can
 * never be true.
 *
 * The shipped bug (`src/lib/stores/modal-url-sync.ts`):
 *
 *     const mediaType = normalizeType(String(props.mediaType)); // 'movie'|'tv'|'episode'
 *     …
 *     const slugKind = isSeries(mediaType)
 *         ? 'tv'
 *         : isAudiobook(mediaType)   // DEAD — 'audiobook' is not in the range
 *           ? 'audiobook'
 *           : 'movie';
 *
 * `isAudiobook()` takes `string | undefined | null`, and the narrowed union IS
 * a string, so the compiler is happy. `normalizeType` defaults every unknown
 * token to `'movie'`, so the audiobook branch is unreachable — the audiobook
 * slug fix shipped and did nothing, and defeated a subsequent fix attempt
 * because the code looked right in review. Three production fixes on
 * 2026-07-30 went past it.
 *
 * ── What it flags ───────────────────────────────────────────────────────────
 *
 *   (a) direct:    `isAudiobook(normalizeType(x))`,
 *                  `isTrack(toPublicMovieOrSeries(x))`
 *   (b) via local: a single-assignment variable initialized from a narrowing
 *                  call, then passed to a comparator anywhere in scope.
 *
 * Only the provably-dead combination reports. `isSeries(toPublicMovieOrSeries(x))`
 * is fine — `'series'` is in that function's range. The rule intersects the
 * comparator's accepted tokens with the narrowing function's range and reports
 * only when the intersection is EMPTY.
 *
 * A comparator applied to a RAW value (`isAudiobook(row.media_type)`,
 * `isAudiobook(props.mediaType)`) is the correct use and is never flagged: the
 * rule requires a recognized narrowing call in the chain.
 *
 * ── Keeping the table in step (IMPORTANT) ───────────────────────────────────
 *
 * `NARROWING_FUNCTIONS` and `COMPARATOR_TOKENS` below are the rule's whole
 * knowledge of the domain, derived by reading `src/lib/shared/media-types.ts`,
 * `src/lib/server/utils/media-types.ts`, `src/lib/server/utils/api-transforms.ts`,
 * `src/lib/server/utils/media-key-parser.ts`,
 * `src/lib/stores/modal-url-sync.ts` and the consolidated
 * `src/lib/shared/media-type-domain.ts` on 2026-07-30. The media-type domain is
 * under active refactor — when a narrowing function is added, renamed, or its
 * return union changes, UPDATE THE TABLE. Both constants are exported for that
 * reason (and so the tests can assert against them).
 *
 * The rule degrades safely in two directions, so a stale table under-reports
 * rather than false-positives:
 *
 *   - A callee declared in the SAME file wins over the table: its range is read
 *     from its return-type annotation when that annotation is a union of string
 *     literals. So a locally renamed narrower keeps working, and one annotated
 *     with a type REFERENCE (`InternalMediaType`, `ApiMediaType`) is treated as
 *     unknown range and never reported — which is why
 *     `context-primitives.ts::normalizeMediaType` (a passthrough `as` cast, not
 *     a collapse) does not misfire.
 *   - An unknown name is simply not a narrowing call.
 *
 * Escape hatch: there isn't a legitimate one. A dead guard is dead. If the rule
 * fires, either the predicate belongs on the RAW value (usually the fix — keep
 * `rawMediaType` around, as `modal-url-sync.ts` now does) or the narrowing
 * function's range needs widening.
 *
 * @see docs/dev/eslint-exceptions.md
 */

/**
 * Media-type narrowing functions → the canonical tokens they can RETURN
 * (UPPERCASE, matching `normalizeForComparison`).
 *
 * A name mapping to several implementations (`normalizeMediaType` exists in
 * `api-transforms.ts` and `media-key-parser.ts`) gets the UNION of their ranges,
 * so the rule only reports what is dead under every implementation.
 *
 * ⚠️ Keep in step with the media-type domain — see the docblock.
 */
const NARROWING_FUNCTIONS = {
    // src/lib/stores/modal-url-sync.ts — the `?modal=` composite vocabulary.
    normalizeType: ['MOVIE', 'TV', 'EPISODE'],
    // src/lib/server/utils/api-transforms.ts  → ApiMediaType
    //   ∪ src/lib/server/utils/media-key-parser.ts → ParsedMediaTypeToken | null
    normalizeMediaType: ['MOVIE', 'SERIES', 'TV', 'EPISODE', 'SEASON'],
    // src/lib/shared/media-types.ts
    toPublicMediaType: [
        'MOVIE',
        'SERIES',
        'SEASON',
        'EPISODE',
        'TRACK',
        'ALBUM',
        'ARTIST',
        'AUDIOBOOK',
    ],
    toPublicMovieOrSeries: ['MOVIE', 'SERIES'],
    toPublicDetailType: ['MOVIE', 'SERIES', 'AUDIOBOOK'],
    toTmdbType: ['MOVIE', 'TV'],
    toImageMediaType: ['MOVIE', 'TV'],
    // src/lib/server/utils/media-types.ts — Jellyfin vocabulary only.
    jellyfinToUIType: ['MOVIE', 'TV', 'EPISODE', 'SEASON', 'AUDIO', 'TVCHANNEL'],
    // src/lib/server/api/defs/requests/[id]/index.ts (file-local; the same name
    // in ingest-map.constants.ts returns plain `string` and is resolved from its
    // own annotation instead — see the docblock).
    canonicalMediaType: ['MOVIE', 'SERIES'],

    // ── src/lib/shared/media-type-domain.ts ─────────────────────────────────
    // The consolidated domain module (exhaustive `Record<MediaTypeInternal, …>`
    // tables + `assertNever`) that replaces the four `normalizeMediaType()`
    // copies above. Ranges are read straight off its tables; each accessor is
    // nullable, and `isX(null)` is false, which does not change the verdict.
    //
    // `toInternalMediaType` is deliberately ABSENT: it parses INTO the full
    // 24-member internal vocabulary, so it collapses nothing and no comparator
    // is dead against it. Same for `isInternalMediaType` / `assertNever`.
    publicTypeOf: ['MOVIE', 'SERIES', 'EPISODE', 'SEASON', 'AUDIOBOOK', 'ARTIST', 'ALBUM', 'TRACK'],
    universalTypeOf: [
        'MOVIE',
        'SERIES',
        'EPISODE',
        'AUDIOBOOK',
        'ARTIST',
        'ALBUM',
        'TRACK',
        'MUSIC',
        'TVCHANNEL',
    ],
    movieOrSeriesOf: ['MOVIE', 'SERIES'],
    detailTypeOf: ['MOVIE', 'SERIES', 'AUDIOBOOK'],
    apiTypeOf: ['MOVIE', 'SERIES', 'EPISODE', 'SEASON'],
    tmdbTypeOf: ['MOVIE', 'TV'],
    providerTypeOf: ['MOVIE', 'TV', 'EPISODE', 'SEASON', 'ARTIST', 'ALBUM', 'TRACK', 'AUDIOBOOK'],
    // The string-in wrappers around the accessors above.
    toUniversalMediaType: [
        'MOVIE',
        'SERIES',
        'EPISODE',
        'AUDIOBOOK',
        'ARTIST',
        'ALBUM',
        'TRACK',
        'MUSIC',
        'TVCHANNEL',
    ],
    toMovieOrSeries: ['MOVIE', 'SERIES'],
    toDetailMediaType: ['MOVIE', 'SERIES', 'AUDIOBOOK'],
    toApiMediaType: ['MOVIE', 'SERIES', 'EPISODE', 'SEASON'],
    toTmdbMediaType: ['MOVIE', 'TV'],
    toProviderMediaType: [
        'MOVIE',
        'TV',
        'EPISODE',
        'SEASON',
        'ARTIST',
        'ALBUM',
        'TRACK',
        'AUDIOBOOK',
    ],
};

/**
 * Comparators → the canonical tokens for which they return true (UPPERCASE).
 * Read off `src/lib/shared/media-types.ts`.
 *
 * ⚠️ Keep in step with the media-type domain — see the docblock.
 */
const COMPARATOR_TOKENS = {
    isMovie: ['MOVIE'],
    isSeries: ['SERIES', 'TV'],
    isEpisode: ['EPISODE'],
    isSeason: ['SEASON'],
    isExtra: ['EXTRA'],
    isAudiobook: ['AUDIOBOOK'],
    isTvChannel: ['TVCHANNEL'],
    isTrack: ['TRACK'],
    isAlbum: ['ALBUM'],
    isArtist: ['ARTIST'],
    isMusic: ['MUSIC', 'ARTIST'],
    isMusicType: ['ARTIST', 'ALBUM', 'TRACK'],
    isAudio: ['AUDIO', 'TRACK'],
    isAudioTrack: ['AUDIO', 'TRACK'],
    isHomeVideo: ['HOME_VIDEO'],
    isTraining: ['TRAINING'],
    isEducational: ['EDUCATIONAL'],
    isPersonal: ['PERSONAL'],
    isNonEntertainment: ['HOME_VIDEO', 'TRAINING', 'EDUCATIONAL', 'PERSONAL'],
};

function isTestFile(filename) {
    return (
        /\.(test|spec)\.[cm]?[jt]sx?$/.test(filename) ||
        /\.svelte\.(test|spec)\.[cm]?[jt]s$/.test(filename) ||
        filename.includes('/tests/') ||
        filename.includes('/e2e/')
    );
}

/** Strip the wrappers that do not change the value. */
function unwrap(node) {
    let cur = node;
    while (
        cur &&
        (cur.type === 'TSAsExpression' ||
            cur.type === 'TSNonNullExpression' ||
            cur.type === 'ChainExpression')
    ) {
        cur = cur.expression;
    }
    return cur;
}

/**
 * Look through a Svelte 5 rune wrapper: `$derived(expr)` and
 * `$derived.by(() => expr)` both evaluate to `expr`.
 *
 * Without this, every narrowed value in a `.svelte` component hides behind
 * `$derived` and the rule silently under-reports — which matters, because
 * `ModalActions.svelte` (the other half of this bug) is exactly such a
 * component.
 */
function unwrapDerived(node) {
    let cur = unwrap(node);
    for (let depth = 0; depth < 4 && cur && cur.type === 'CallExpression'; depth += 1) {
        const callee = cur.callee;
        const isDerived =
            (callee.type === 'Identifier' && callee.name === '$derived') ||
            (callee.type === 'MemberExpression' &&
                !callee.computed &&
                callee.object.type === 'Identifier' &&
                callee.object.name === '$derived' &&
                callee.property.type === 'Identifier' &&
                callee.property.name === 'by');
        if (!isDerived || cur.arguments.length !== 1) return cur;
        let inner = unwrap(cur.arguments[0]);
        // `$derived.by(() => expr)` — an expression-bodied arrow.
        if (
            inner &&
            inner.type === 'ArrowFunctionExpression' &&
            inner.body &&
            inner.body.type !== 'BlockStatement'
        ) {
            inner = unwrap(inner.body);
        }
        cur = inner;
    }
    return cur;
}

/**
 * Collect the string-literal members of a return-type annotation.
 * Returns null when the annotation is anything else (a type reference, `string`,
 * a generic) — "unknown range", which the rule treats as not-narrowing.
 */
function literalUnionMembers(typeNode) {
    if (!typeNode) return null;
    if (typeNode.type === 'TSTypeAnnotation') return literalUnionMembers(typeNode.typeAnnotation);
    if (typeNode.type === 'TSParenthesizedType')
        return literalUnionMembers(typeNode.typeAnnotation);
    if (typeNode.type === 'TSLiteralType') {
        const lit = typeNode.literal;
        if (lit && lit.type === 'Literal' && typeof lit.value === 'string') return [lit.value];
        return null;
    }
    if (typeNode.type === 'TSUnionType') {
        const out = [];
        for (const member of typeNode.types) {
            // `| null` / `| undefined` do not widen the token set.
            if (
                member.type === 'TSNullKeyword' ||
                member.type === 'TSUndefinedKeyword' ||
                (member.type === 'TSLiteralType' && member.literal?.value === null)
            )
                continue;
            const nested = literalUnionMembers(member);
            if (nested === null) return null;
            out.push(...nested);
        }
        return out.length > 0 ? out : null;
    }
    return null;
}

/** Walk up the scope chain for a variable by name. */
function findVariable(scope, name) {
    let cur = scope;
    while (cur) {
        const variable = cur.set.get(name);
        if (variable) return variable;
        cur = cur.upper;
    }
    return null;
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Disallow a media-type comparator on a value an earlier narrowing function already collapsed (a guard that can never be true)',
            recommended: true,
        },
        schema: [],
        messages: {
            deadGuard:
                '{{comparator}}() can never be true here: {{subject}} comes from {{narrower}}(), whose range is {{range}}. ' +
                'This guard type-checks (the narrowed union is still a string) but is dead code — exactly the shape that made the ' +
                'audiobook slug fix ship and do nothing. Apply the predicate to the RAW media type instead (keep it in a separate ' +
                "variable, e.g. `rawMediaType`), or widen {{narrower}}()'s range.",
            typedDeadGuard:
                '{{comparator}}() can never be true here: {{subject}} has the finite media-type range {{range}}, which does not include any of the comparator tokens. ' +
                'Apply the predicate to the raw media type before converting it.',
        },
    },

    create(context) {
        const filename = (context.filename || context.getFilename() || '').replace(/\\/g, '/');
        if (isTestFile(filename)) return {};
        const sourceCode = context.sourceCode || context.getSourceCode();
        const parserServices = context.parserServices || sourceCode.parserServices || {};
        const typeChecker = parserServices.program?.getTypeChecker();
        const esTreeNodeToTsNodeMap = parserServices.esTreeNodeToTSNodeMap;

        /** Read a finite string-literal range from the TypeScript checker. */
        function literalTypeMembers(type, seen = new Set()) {
            if (!type || seen.has(type)) return null;
            seen.add(type);

            if (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) return [];
            if (type.flags & ts.TypeFlags.StringLiteral) return [type.value];

            if (type.isUnion?.()) {
                const members = [];
                for (const member of type.types) {
                    const nested = literalTypeMembers(member, seen);
                    if (nested === null) return null;
                    members.push(...nested);
                }
                return members;
            }

            if (type.isIntersection?.()) {
                const members = [];
                for (const member of type.types) {
                    const nested = literalTypeMembers(member, seen);
                    if (nested) members.push(...nested);
                }
                return members.length > 0 ? members : null;
            }

            return null;
        }

        function rangeFromType(node) {
            if (!typeChecker || !esTreeNodeToTsNodeMap) return null;
            const tsNode = esTreeNodeToTsNodeMap.get(node);
            if (!tsNode) return null;
            const members = literalTypeMembers(typeChecker.getTypeAtLocation(tsNode));
            if (!members || members.length === 0) return null;
            return [...new Set(members.map((member) => member.toUpperCase()))];
        }

        /**
         * The token range of a narrowing callee, or null when the name is not a
         * known narrower / its range cannot be established.
         *
         * A same-file declaration wins over the table: its return-type
         * annotation is the ground truth and survives renames.
         */
        function rangeOfNarrower(calleeNode, scope) {
            const callee = unwrap(calleeNode);
            if (!callee || callee.type !== 'Identifier') return null;
            const name = callee.name;

            const variable = findVariable(scope, name);
            if (variable) {
                for (const def of variable.defs) {
                    if (!def.node) continue;
                    if (def.node.type === 'FunctionDeclaration') {
                        const members = literalUnionMembers(def.node.returnType);
                        return members ? members.map((m) => m.toUpperCase()) : null;
                    }
                    if (def.node.type === 'VariableDeclarator') {
                        const init = def.node.init;
                        if (
                            init &&
                            (init.type === 'ArrowFunctionExpression' ||
                                init.type === 'FunctionExpression')
                        ) {
                            const members = literalUnionMembers(init.returnType);
                            return members ? members.map((m) => m.toUpperCase()) : null;
                        }
                        // Not a function — cannot be the narrowing call.
                        return null;
                    }
                    // ImportBinding (and anything else) falls through to the table.
                }
            }

            return Object.prototype.hasOwnProperty.call(NARROWING_FUNCTIONS, name)
                ? NARROWING_FUNCTIONS[name]
                : null;
        }

        /**
         * `{ range, narrower }` when the expression is (a) a narrowing call, or
         * (b) an identifier bound once to one. Null otherwise — including for
         * every raw DB / external value, which is the correct use.
         */
        function narrowedSource(argNode, scope) {
            const arg = unwrapDerived(argNode);
            if (!arg) return null;

            const typedRange = rangeFromType(arg);
            if (typedRange) return { range: typedRange, typed: true };

            if (arg.type === 'CallExpression') {
                const range = rangeOfNarrower(arg.callee, scope);
                const callee = unwrap(arg.callee);
                return range ? { range, narrower: callee.name } : null;
            }

            if (arg.type !== 'Identifier') return null;

            const variable = findVariable(scope, arg.name);
            if (!variable || variable.defs.length !== 1) return null;
            const def = variable.defs[0];
            if (!def.node || def.node.type !== 'VariableDeclarator') return null;

            // A reassigned local could hold anything by the time it is read.
            const writes = variable.references.filter((ref) => ref.isWrite());
            if (writes.length > 1) return null;

            const init = unwrapDerived(def.node.init);
            if (!init || init.type !== 'CallExpression') return null;
            // The declarator's own scope is the right lookup context for its init.
            const declScope = def.node.init ? sourceCode.getScope(def.node.init) : scope;
            const range = rangeOfNarrower(init.callee, declScope);
            if (!range) return null;
            return { range, narrower: unwrap(init.callee).name };
        }

        return {
            CallExpression(node) {
                const callee = unwrap(node.callee);
                if (!callee || callee.type !== 'Identifier') return;
                const accepted = COMPARATOR_TOKENS[callee.name];
                if (!accepted) return;
                if (node.arguments.length !== 1) return;

                const argNode = node.arguments[0];
                if (argNode.type === 'SpreadElement') return;

                const scope = sourceCode.getScope(node);
                const source = narrowedSource(argNode, scope);
                if (!source) return;

                // Provably dead only when NO accepted token is in range.
                const inRange = accepted.some((token) => source.range.includes(token));
                if (inRange) return;

                const arg = unwrap(argNode);
                context.report({
                    node,
                    messageId: source.typed ? 'typedDeadGuard' : 'deadGuard',
                    data: {
                        comparator: callee.name,
                        subject:
                            arg.type === 'Identifier'
                                ? `\`${arg.name}\``
                                : `this ${source.narrower}() result`,
                        narrower: source.narrower,
                        range: source.range.map((t) => `'${t.toLowerCase()}'`).join(' | '),
                    },
                });
            },
        };
    },
};

module.exports.NARROWING_FUNCTIONS = NARROWING_FUNCTIONS;
module.exports.COMPARATOR_TOKENS = COMPARATOR_TOKENS;
