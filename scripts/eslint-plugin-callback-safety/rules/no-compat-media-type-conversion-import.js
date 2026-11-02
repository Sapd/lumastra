// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keep media-type conversions on the domain module. The media-types files are
 * compatibility facades for guards and legacy imports; importing converters
 * through them makes the boundary easy to reintroduce accidentally.
 */

const CONVERTERS = new Set([
    'toTmdbType',
    'toTmdbMediaType',
    'toPublicMediaType',
    'toUniversalMediaType',
    'toMovieOrSeries',
    'toDetailMediaType',
    'toApiMediaType',
    'toProviderMediaType',
]);

function isTestFile(filename) {
    return /\.(test|spec)\.[cm]?[jt]sx?$/.test(filename) || filename.includes('/tests/');
}

function isFacadeFile(filename) {
    return (
        filename.endsWith('/src/lib/shared/media-types.ts') ||
        filename.endsWith('/src/lib/utils/media-types.ts') ||
        filename.endsWith('/src/lib/server/utils/media-types.ts')
    );
}

function isCompatibilityModule(source) {
    return (
        source === '$lib/shared/media-types' ||
        source === '$lib/shared/media-types.js' ||
        source === '$lib/utils/media-types' ||
        source === '$lib/utils/media-types.js' ||
        source === '$lib/server/utils/media-types' ||
        source === '$lib/server/utils/media-types.js' ||
        /(?:^|\/)media-types(?:\.js)?$/.test(source)
    );
}

module.exports = {
    meta: {
        type: 'problem',
        fixable: 'code',
        docs: {
            description:
                'Import media-type converters from the domain module, not compatibility facades',
            recommended: true,
        },
        schema: [],
        messages: {
            converter:
                "Import '{{name}}' from '$lib/shared/media-type-domain'; media-types modules are compatibility facades.",
        },
    },

    create(context) {
        const filename = (context.filename || context.getFilename() || '').replace(/\\/g, '/');
        if (isTestFile(filename) || isFacadeFile(filename)) return {};

        return {
            ImportDeclaration(node) {
                if (node.source.value === '$lib/shared/media-type-domain') {
                    return;
                }
                if (!isCompatibilityModule(node.source.value)) return;
                const converters = node.specifiers.filter(
                    (specifier) =>
                        specifier.type === 'ImportSpecifier' &&
                        CONVERTERS.has(specifier.imported.name),
                );
                if (converters.length === 0) return;

                context.report({
                    node,
                    messageId: 'converter',
                    data: {
                        name: converters.map((specifier) => specifier.imported.name).join(', '),
                    },
                    fix(fixer) {
                        const remaining = node.specifiers.filter(
                            (specifier) => !converters.includes(specifier),
                        );
                        // The fixer deliberately handles named imports only;
                        // preserving a default or namespace import requires
                        // reconstructing a different import grammar.
                        if (remaining.some((specifier) => specifier.type !== 'ImportSpecifier')) {
                            return null;
                        }
                        const converterImports = converters.map((specifier) => {
                            const imported =
                                specifier.imported.name === 'toTmdbType'
                                    ? 'toTmdbMediaType'
                                    : specifier.imported.name;
                            const local = specifier.local.name;
                            return local === imported ? imported : `${imported} as ${local}`;
                        });
                        const replacement = [];
                        if (remaining.length > 0) {
                            replacement.push(
                                `import { ${remaining
                                    .map((specifier) => context.sourceCode.getText(specifier))
                                    .join(
                                        ', ',
                                    )} } from ${context.sourceCode.getText(node.source)};`,
                            );
                        }
                        replacement.push(
                            `import { ${converterImports.join(', ')} } from '$lib/shared/media-type-domain';`,
                        );
                        return fixer.replaceText(node, replacement.join('\n'));
                    },
                });
            },
        };
    },
};
