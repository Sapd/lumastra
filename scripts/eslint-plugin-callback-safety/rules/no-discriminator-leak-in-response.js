// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: no-discriminator-leak-in-response (WARN)
 *
 * Flags legacy non-canonical keys in object literals handed to `json()` or
 * `typedJson()` in the API def layer (`src/lib/server/api/defs/**`):
 *
 *   - `mediaType:`  → the public contract uses `type:` (canonical 'series',
 *                     never raw internal sonarr/radarr/tv/mediaType).
 *   - `imageUrl:` / `posterPath:`
 *                   → these are internal image fields; the public contract uses
 *                     an `images: { ... }` href map. (`posterUrl` is the
 *                     contract-blessed flat field on thin items — matching
 *                     `GET /media/{id}` — and is intentionally NOT banned.)
 *
 * SUPPLEMENTARY GUARD: this rule is a cheap, best-effort backstop, NOT the
 * authoritative contract check. It only inspects object LITERALS passed directly
 * to `json()` / `typedJson()`; it does NOT see items built via `.map(...)`,
 * spreads, or helper functions (e.g. `paginate(items.map(toItem))`). The
 * authoritative divergence guard is the runtime OpenAPI contract test
 * (tests/integration/openapi-contract.integration.test.ts), which parses real
 * handler output against the documented zod schemas.
 *
 * Scope is deliberately narrow — only response-construction sites, i.e. an
 * object literal passed directly as an argument to `json(...)` or
 * `typedJson(...)`. Zod schema property defs, request bodies, and internal
 * locals are NOT flagged (those legitimately mirror DB / input names), which
 * is why this ships as a WARN: the call-site heuristic can still false-
 * positive when one of these keys names a passthrough value.
 *
 * Escape hatch (per occurrence):
 *   // eslint-disable-next-line callback-safety/no-discriminator-leak-in-response
 */

const DEF_PATH_RE = /\/src\/lib\/server\/api\/defs\//;
// `posterUrl` is intentionally NOT banned: it is the contract-blessed flat
// image field on thin items (matching GET /media/{id}). Only the internal
// `imageUrl` / `posterPath` fields and the legacy `mediaType` discriminator leak.
const BANNED_KEYS = new Set(['mediaType', 'imageUrl', 'posterPath']);
const RESPONSE_CALLEES = new Set(['json', 'typedJson']);

function calleeName(node) {
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'MemberExpression' && node.property.type === 'Identifier') {
        return node.property.name;
    }
    return null;
}

function keyName(prop) {
    if (prop.type !== 'Property') return null;
    if (prop.key.type === 'Identifier') return prop.key.name;
    if (prop.key.type === 'Literal') return String(prop.key.value);
    return null;
}

module.exports = {
    meta: {
        type: 'suggestion',
        docs: {
            description:
                'Flag legacy mediaType/imageUrl/posterPath keys in json()/typedJson() responses in the def layer',
            category: 'API Contract',
            recommended: false,
        },
        schema: [],
        messages: {
            leak:
                "Response key '{{key}}' is not in the public /api/v1 contract. Use `type:` (canonical " +
                "'series') and an `images: {}` href map instead of flat mediaType/imageUrl/" +
                'posterPath. If this is a deliberate passthrough, add ' +
                '`// eslint-disable-next-line callback-safety/no-discriminator-leak-in-response`.',
        },
    },
    create(context) {
        const filename = (context.filename || context.getFilename()).replace(/\\/g, '/');
        if (!DEF_PATH_RE.test(filename)) return {};

        return {
            CallExpression(node) {
                if (!RESPONSE_CALLEES.has(calleeName(node.callee))) return;
                for (const arg of node.arguments) {
                    if (!arg || arg.type !== 'ObjectExpression') continue;
                    for (const prop of arg.properties) {
                        const key = keyName(prop);
                        if (key && BANNED_KEYS.has(key)) {
                            context.report({ node: prop, messageId: 'leak', data: { key } });
                        }
                    }
                }
            },
        };
    },
};
