// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reject inline media-type projections that invent a final media-type default.
 *
 * The dangerous shape is a multi-branch chain such as:
 *
 *     isEpisode(x) ? 'episode' : isSeries(x) ? 'series' : 'movie'
 *
 * The final literal silently relabels every future or unsupported type. Simple
 * two-way movie/TV mappings remain valid because many callers intentionally
 * target a binary provider vocabulary.
 */

const MEDIA_TYPE_TOKENS = new Set([
    'movie',
    'tv',
    'series',
    'episode',
    'season',
    'audiobook',
    'track',
    'album',
    'artist',
    'music',
    'tvchannel',
]);

const NULLABLE_MEDIA_TYPE_CONVERTERS = new Set([
    'toPublicMediaType',
    'toUniversalMediaType',
    'toMovieOrSeries',
    'toDetailMediaType',
    'toApiMediaType',
    'toTmdbMediaType',
    'toTmdbType',
]);

const IMPLEMENTATION_PATHS = [
    '/src/lib/shared/media-types.ts',
    '/src/lib/shared/media-type-domain.ts',
    '/src/lib/server/utils/media-types.ts',
    '/src/lib/utils/media-types.ts',
];

function isTestFile(filename) {
    return (
        /\.(test|spec)\.[cm]?[jt]sx?$/.test(filename) ||
        /\.svelte\.(test|spec)\.[cm]?[jt]s$/.test(filename) ||
        filename.includes('/tests/') ||
        filename.includes('/e2e/')
    );
}

function isImplementationFile(filename) {
    return IMPLEMENTATION_PATHS.some((path) => filename.endsWith(path));
}

function mediaLiteral(node) {
    if (!node) return null;
    if (node.type === 'Literal' && typeof node.value === 'string') {
        const value = node.value.toLowerCase();
        return MEDIA_TYPE_TOKENS.has(value) ? value : null;
    }
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
        const value = node.quasis[0]?.value?.cooked?.toLowerCase();
        return value && MEDIA_TYPE_TOKENS.has(value) ? value : null;
    }
    return null;
}

function collectConditionalLiterals(node, values) {
    if (!node) return;
    if (node.type === 'ConditionalExpression') {
        collectConditionalLiterals(node.consequent, values);
        collectConditionalLiterals(node.alternate, values);
        return;
    }
    const value = mediaLiteral(node);
    if (value) values.add(value);
}

function isTypeIdentifier(node) {
    return node?.type === 'Identifier' && /^(?:type|[a-z]+Type|[a-z]+_type)$/.test(node.name);
}

function isMediaTypeContext(node, context) {
    const ancestors = context.sourceCode.getAncestors(node);
    for (const ancestor of ancestors) {
        if (ancestor.type === 'VariableDeclarator' && isTypeIdentifier(ancestor.id)) {
            return true;
        }
        if (
            (ancestor.type === 'Property' || ancestor.type === 'MethodDefinition') &&
            isTypeIdentifier(ancestor.key)
        ) {
            return true;
        }
        if (ancestor.type === 'AssignmentExpression' && isTypeIdentifier(ancestor.left)) {
            return true;
        }
    }
    return false;
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Disallow multi-branch media-type conditionals and nullable converter fallbacks that invent a media type',
            recommended: true,
        },
        schema: [],
        messages: {
            inlineDefault:
                'This media-type conditional has multiple branches and a fabricated default. Use a domain converter that returns null, or document a deliberately binary projection.',
            converterDefault:
                '{{converter}}() returns null for unsupported media types; do not replace that with a fabricated {{fallback}} value.',
        },
    },

    create(context) {
        const filename = (context.filename || context.getFilename() || '').replace(/\\/g, '/');
        if (isTestFile(filename) || isImplementationFile(filename)) return {};
        const reportedRanges = [];

        return {
            ConditionalExpression(node) {
                // Only report chains with at least three distinct media-type
                // outputs. This intentionally leaves binary movie/TV adapters
                // alone; their target vocabulary is explicit at the call site.
                if (!isMediaTypeContext(node, context)) return;
                const values = new Set();
                collectConditionalLiterals(node, values);
                if (values.size < 3) return;

                let cursor = node;
                while (cursor.alternate?.type === 'ConditionalExpression') {
                    cursor = cursor.alternate;
                }
                if (!mediaLiteral(cursor.alternate)) return;

                if (
                    reportedRanges.some(
                        ([start, end]) => node.range[0] >= start && node.range[1] <= end,
                    )
                ) {
                    return;
                }
                reportedRanges.push(node.range);

                context.report({ node, messageId: 'inlineDefault' });
            },

            LogicalExpression(node) {
                if (node.operator !== '??' && node.operator !== '||') return;
                const fallback = mediaLiteral(node.right);
                if (!fallback || node.left.type !== 'CallExpression') return;
                if (node.left.callee.type !== 'Identifier') return;

                const converter = node.left.callee.name;
                if (!NULLABLE_MEDIA_TYPE_CONVERTERS.has(converter)) return;
                context.report({
                    node,
                    messageId: 'converterDefault',
                    data: { converter, fallback: `'${fallback}'` },
                });
            },
        };
    },
};

module.exports.NULLABLE_MEDIA_TYPE_CONVERTERS = NULLABLE_MEDIA_TYPE_CONVERTERS;
