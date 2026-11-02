// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: no-base-path-in-url
 *
 * `config.BASE_PATH` (`src/lib/server/config.ts`) is a FILESYSTEM directory —
 * seven call sites default it to `/data`, `/config`, or `/tmp`
 * (`album-enrichment.ts`, `music-scanner-utils.ts`, `media-path-resolver.ts`,
 * `artwork-volume-headroom.ts`, `video-frame-extractor.service.ts`), and
 * `docker-compose.example.yml` sets it to `/config` to match the config volume
 * mount. It is NOT a URL prefix.
 *
 * Three call sites nonetheless interpolated it directly in front of an
 * `/api`/`/v1` path (`watch-together.service.ts`, and twice in
 * `routes/api/v1/watch-together/parties/+server.ts`), which emitted
 * `/config/api/v1/...` hrefs on any install following
 * `docker-compose.example.yml` — a live production bug (watch-together poster
 * and host-avatar links). This rule makes that shape unrepresentable.
 *
 * The correct source of a URL prefix is `$lib/shared/api-urls.ts`
 * (`apiUrl`, `entityImageUrl`, `buildImageRefs`, `appPath`) — it derives from
 * SvelteKit's configured `base`, not from this config key.
 *
 * ## What is flagged
 *
 * A template literal where an interpolated expression is `<local>.BASE_PATH`
 * (where `<local>` is bound to the `config` export of a module ending in
 * `/config`, e.g. `$lib/server/config`, `../config`) and the quasi
 * immediately following it starts with `/api` or `/v1`.
 *
 * Deliberately NOT flagged: `config.BASE_PATH` used to build a filesystem path
 * (`path.join(config.BASE_PATH || '/data', '.metadata')`) — nothing there
 * starts with `/api` or `/v1`, so the two legitimate meanings do not collide
 * under this check. A local variable that happens to be named `config` but was
 * never imported from a `.../config` module is not tracked either — provenance
 * matters, not just the name (same approach as
 * `require-base-aware-navigation`).
 *
 * Escape hatch: `// eslint-disable-next-line callback-safety/no-base-path-in-url`
 * with a reason, for the rare case a literal genuinely documents the shape
 * rather than emitting a link.
 *
 * @see src/lib/shared/api-urls.ts
 * @see scripts/resolve-url-base-path.js
 * @see docs/dev/eslint-exceptions.md
 */

/** Modules whose `config` export is `src/lib/server/config.ts` (or an alias of it). */
const CONFIG_MODULE_SOURCE = /(^|\/)config$/;

/** A URL path prefix, bounded so only real path segments match (not `/apikey`, `/v10`). */
const URL_PATH_PREFIX = /^\/(api|v1)(?=$|[/?#])/;

/** Strip a `.js`/`.ts` suffix so `$lib/server/config.js` matches too. */
function normaliseSource(value) {
    return String(value).replace(/\.(js|ts)$/, '');
}

/**
 * Local names bound to the `config` export of a `.../config` module by an
 * import in this file. Keyed by LOCAL name so aliases
 * (`import { config as serverConfig }`) are honoured.
 */
function collectConfigLocals(programBody) {
    const locals = new Set();
    for (const stmt of programBody) {
        if (stmt.type !== 'ImportDeclaration') continue;
        if (!CONFIG_MODULE_SOURCE.test(normaliseSource(stmt.source.value))) continue;
        for (const spec of stmt.specifiers) {
            if (spec.type !== 'ImportSpecifier') continue;
            const imported =
                spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value;
            if (imported === 'config') locals.add(spec.local.name);
        }
    }
    return locals;
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Disallow interpolating config.BASE_PATH (a filesystem directory) directly in front of an /api or /v1 URL path',
            category: 'Possible Errors',
            recommended: true,
        },
        schema: [],
        messages: {
            basePathUrl:
                '`{{name}}.BASE_PATH` is the FILESYSTEM config/data directory (docker-compose.example.yml sets it to "/config"), not a URL prefix. Interpolating it in front of "{{path}}" emits e.g. "/config{{path}}" on any install following the example compose file. Build the URL with apiUrl()/entityImageUrl()/buildImageRefs() from `$lib/shared/api-urls` instead — those derive the prefix from SvelteKit\'s configured `base`.',
        },
    },

    create(context) {
        let locals = new Set();

        return {
            Program(node) {
                locals = collectConfigLocals(node.body);
            },

            TemplateLiteral(node) {
                if (locals.size === 0) return;

                node.expressions.forEach((expr, i) => {
                    if (
                        expr.type !== 'MemberExpression' ||
                        expr.computed ||
                        expr.object.type !== 'Identifier' ||
                        !locals.has(expr.object.name) ||
                        expr.property.type !== 'Identifier' ||
                        expr.property.name !== 'BASE_PATH'
                    ) {
                        return;
                    }

                    const nextQuasi = node.quasis[i + 1];
                    const raw = nextQuasi?.value?.raw;
                    if (typeof raw !== 'string' || !URL_PATH_PREFIX.test(raw)) return;

                    context.report({
                        node: expr,
                        messageId: 'basePathUrl',
                        data: { name: expr.object.name, path: raw.match(URL_PATH_PREFIX)[0] },
                    });
                });
            },
        };
    },
};
