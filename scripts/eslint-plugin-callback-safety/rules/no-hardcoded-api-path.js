// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: no-hardcoded-api-path
 *
 * Makes the "wrong API prefix on one of the two surfaces" defect unrepresentable
 * inside the API def layer (`src/lib/server/api/defs/**`).
 *
 * ## Why
 *
 * A def is mounted on BOTH surfaces — `/api` (internal) and `/api/v1` — by
 * separate route files. Any prefix a def writes as a literal is therefore wrong
 * on one of them by construction:
 *
 *  - `/api/v1/series/${id}` leaked v1 links into internal responses (~9 hrefs).
 *  - `/api/image/catalog/{id}/{type}` (emitted by the client-side
 *    `getCatalogPosterUrl()` / `getCatalogImageUrl()` helpers) has **no**
 *    `/api/v1` counterpart at all — `src/routes/api/v1/image/` does not exist,
 *    so v1 clients got a 404 they had to special-case.
 *  - `toEntityImageBase()` mapped a hand-written `imageBase` string
 *    (`/…/image` → `/…/media`). That string was passed at ~825 mount sites with
 *    no invariant tying it to the surface and drifted to three different values
 *    for the SAME surface.
 *
 * The single fix is to derive every prefix from `ctx.surface`, via
 * `src/lib/shared/api-urls.ts`:
 *
 *     apiBase(surface)                          -> '/api' | '/api/v1'
 *     apiUrl(surface, '/series/' + id)          -> prefixed path
 *     entityImageUrl(mediaId, role, surface, { size })
 *     buildImageRefs(mediaId, surface)
 *
 * Those helpers also prepend SvelteKit's `base` (`kit.paths.base`), so a literal
 * additionally breaks subpath installations (`https://host/lumastra/`).
 *
 * ## What is flagged
 *
 * 1. `hardcodedPath` — a string chunk (plain literal, or one quasi of a template
 *    literal) that STARTS with an `/api` path prefix: `'/api'`, `'/api/...'`,
 *    `` `/api/v1/series/${id}` ``, `` `${base}/api/media/...` `` (the quasi after
 *    the expression still starts with `/api/`).
 *
 *    Deliberately NOT flagged: any string that merely *contains* "api"
 *    (`'openapi'`, `'api_key'`, `'/api-docs'`, `'https://api.themoviedb.org/3'`).
 *    The rule anchors on a leading `/api` followed by `/`, `?`, `#` or the end of
 *    the chunk, so third-party hosts and prose keep passing.
 *
 * 2. `catalogUrlHelper` — importing `getCatalog*Url` / `getCatalog*SrcSet` from
 *    `$lib/utils/image-utils` (or anywhere). These hardcode
 *    `/api/image/catalog/{id}/{type}`, the form with no v1 route.
 *
 * 3. `entityImageBaseMapper` — importing `toEntityImageBase` from
 *    `$lib/server/utils/api-transforms`. It is the retired `imageBase`-string
 *    mapper; the whole `imageBase` concept is being deleted from SurfaceContext.
 *
 * ## Scope
 *
 * Only files under `src/lib/server/api/defs/**`. Test files
 * (`*.test.ts`, `*.integration.test.ts`, `*.spec.ts`) are EXEMPT: a def's test
 * legitimately asserts on the concrete emitted path — that assertion is exactly
 * what proves the surface derivation works — and `api-urls.test.ts` is built
 * entirely out of `/api/v1/...` string expectations. This mirrors how the
 * existing def-layer guards (GUARD D/E/F) are scoped in `eslint.config.cjs`,
 * which `ignores: ['**\/*.test.ts', '**\/*.integration.test.ts']`. The exemption
 * is enforced twice on purpose (config `ignores` + this internal check) so the
 * rule stays correct if it is ever enabled from another config block.
 *
 * Escape hatch: `// eslint-disable-next-line callback-safety/no-hardcoded-api-path`
 * with a reason — e.g. a doc/`describe()` string that is documenting the literal
 * route path rather than emitting a link.
 *
 * @see src/lib/shared/api-urls.ts
 * @see docs/dev/eslint-exceptions.md
 */

const APPLICABLE_PATH_FRAGMENTS = ['/src/lib/server/api/defs/'];

// Tests legitimately assert on literal paths — see the "Scope" note above.
const EXEMPT_PATH_FRAGMENTS = ['.test.ts', '.integration.test.ts', '.spec.ts'];

/**
 * A leading `/api` path prefix, bounded so that only real path segments match.
 * `/api-docs`, `openapi`, `api_key` and `https://api.example.com/x` do NOT match.
 */
const API_PATH_PREFIX = /^\/api(?=$|[/?#])/;

/** `getCatalogPosterUrl`, `getCatalogImageUrl`, `getCatalogBackdropUrl`, …SrcSet. */
const CATALOG_URL_HELPER = /^getCatalog[A-Za-z0-9]*(Url|SrcSet)$/;

const ENTITY_IMAGE_BASE_MAPPER = 'toEntityImageBase';

/** Trim a long literal so the message stays readable. */
function preview(text) {
    const oneLine = text.replace(/\s+/g, ' ');
    return oneLine.length > 48 ? `${oneLine.slice(0, 45)}…` : oneLine;
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Disallow hardcoded /api path prefixes (and the helpers that hardcode them) in API defs; derive every URL from ctx.surface via api-urls.ts',
            category: 'Possible Errors',
            recommended: true,
        },
        schema: [],
        messages: {
            hardcodedPath:
                'Hardcoded API path "{{path}}" in a def. A def is mounted on BOTH /api and /api/v1, so a literal prefix is wrong on one surface by construction (and breaks subpath installs). Derive it from `ctx.surface` via `$lib/shared/api-urls`: apiUrl(ctx.surface, path) for entity/collection links, entityImageUrl(mediaId, role, ctx.surface) or buildImageRefs(mediaId, ctx.surface) for media images. The entity image route accepts a UUID OR a composite provider key (`tmdb:603:movie`) and takes an optional `path` hint, so the retired /api/image/** proxy family has a surface-aware equivalent in every case.',
            catalogUrlHelper:
                '`{{name}}` hardcodes /api/image/catalog/{id}/{type}, which has NO /api/v1 route — v1 clients get a 404. Use entityImageUrl(mediaId, role, ctx.surface) or buildImageRefs(mediaId, ctx.surface) from `$lib/shared/api-urls` instead.',
            nonFetchSink:
                'Root-absolute "{{path}}" passed to {{sink}}, which the global fetch interceptor CANNOT rewrite (it patches window.fetch only, and only in the browser). On a subpath install this resolves against the origin and 404s. Wrap it: apiUrl(\'internal\', path) from `$lib/shared/api-urls`.',
            entityImageBaseMapper:
                '`toEntityImageBase` is the retired imageBase-string mapper (imageBase is being deleted from SurfaceContext — it drifted to three values for the same surface). Derive the prefix from `ctx.surface` via apiBase/apiUrl/entityImageUrl in `$lib/shared/api-urls`.',
        },
    },

    create(context) {
        const filename = context.filename || context.getFilename?.() || '';

        // Normalise to forward slashes for cross-platform path matching.
        const normalised = filename.replace(/\\/g, '/');

        const isExempt = EXEMPT_PATH_FRAGMENTS.some((frag) => normalised.endsWith(frag));
        if (isExempt) {
            return {};
        }

        const inDefs = APPLICABLE_PATH_FRAGMENTS.some((frag) => normalised.includes(frag));

        // ------------------------------------------------------------------
        // App-wide check: sinks the global fetch interceptor cannot reach.
        //
        // src/lib/fetch-interceptor.ts patches window.fetch and prefixes `base`,
        // which is why a bare fetch('/api/...') in a component is fine. It is
        // ALSO the reason these are not: EventSource / WebSocket / Audio /
        // sendBeacon are not fetch, an <img>.src load is not fetch, and the
        // interceptor is `browser`-gated so a *.server.ts fetch() never sees it.
        // Every one of those was a live subpath break found in this codebase.
        // ------------------------------------------------------------------
        const isServerModule = /\.server\.ts$|\/hooks\.server\.ts$/.test(normalised);

        function sinkFor(node) {
            const p = node.parent;
            if (!p) return null;
            if (p.type === 'NewExpression' && p.arguments[0] === node) {
                const n = p.callee.type === 'Identifier' ? p.callee.name : '';
                if (n === 'EventSource' || n === 'WebSocket' || n === 'Audio') return `new ${n}()`;
            }
            if (p.type === 'CallExpression' && p.arguments[0] === node) {
                const c = p.callee;
                if (c.type === 'MemberExpression' && c.property.type === 'Identifier') {
                    if (c.property.name === 'sendBeacon') return 'navigator.sendBeacon()';
                }
                if (
                    isServerModule &&
                    c.type === 'Identifier' &&
                    c.callee !== node &&
                    c.name === 'fetch'
                ) {
                    return 'fetch() in a server module';
                }
            }
            if (
                p.type === 'AssignmentExpression' &&
                p.right === node &&
                p.left.type === 'MemberExpression' &&
                p.left.property.type === 'Identifier' &&
                p.left.property.name === 'src'
            ) {
                return '.src (an image/media load, not fetch)';
            }
            return null;
        }

        function checkSink(node, text) {
            if (typeof text !== 'string' || !API_PATH_PREFIX.test(text)) return;
            const sink = sinkFor(node);
            if (!sink) return;
            context.report({
                node,
                messageId: 'nonFetchSink',
                data: { path: preview(text), sink },
            });
        }

        if (!inDefs) {
            return {
                Literal(node) {
                    checkSink(node, node.value);
                },
                TemplateLiteral(node) {
                    const first = node.quasis[0];
                    if (first) checkSink(node, first.value?.raw);
                },
            };
        }

        /** Report `node` when `text` opens with an /api path prefix. */
        function checkChunk(node, text) {
            if (typeof text !== 'string') return;
            if (!API_PATH_PREFIX.test(text)) return;
            context.report({
                node,
                messageId: 'hardcodedPath',
                data: { path: preview(text) },
            });
        }

        return {
            Literal(node) {
                if (typeof node.value !== 'string') return;
                // Module specifiers can never be an /api path, but skipping them
                // keeps the rule honest about only inspecting value positions.
                const parent = node.parent;
                if (
                    parent &&
                    (parent.type === 'ImportDeclaration' ||
                        parent.type === 'ExportNamedDeclaration' ||
                        parent.type === 'ExportAllDeclaration')
                ) {
                    return;
                }
                checkChunk(node, node.value);
            },

            // Each quasi is checked independently: `${base}/api/v1/x` has its
            // /api chunk in the SECOND quasi, and that is the common shape.
            TemplateElement(node) {
                checkChunk(node, node.value?.raw);
            },

            ImportDeclaration(node) {
                for (const spec of node.specifiers) {
                    if (spec.type !== 'ImportSpecifier') continue;
                    const imported = spec.imported;
                    const name =
                        imported && imported.type === 'Identifier'
                            ? imported.name
                            : imported?.value;
                    if (typeof name !== 'string') continue;

                    if (CATALOG_URL_HELPER.test(name)) {
                        context.report({
                            node: spec,
                            messageId: 'catalogUrlHelper',
                            data: { name },
                        });
                    } else if (name === ENTITY_IMAGE_BASE_MAPPER) {
                        context.report({ node: spec, messageId: 'entityImageBaseMapper' });
                    }
                }
            },
        };
    },
};
