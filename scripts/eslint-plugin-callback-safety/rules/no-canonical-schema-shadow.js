// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * no-canonical-schema-shadow
 *
 * GUARD F (in the spirit of GUARD A). Forbids an API def under
 * `src/lib/server/api/defs/**` from declaring a LOCAL response schema that
 * re-implements a shape a canonical `$lib/schemas` module already owns.
 *
 * WHY
 * ---
 * This is the exact drift class the response-contract hardening fixed: a def
 * declared its own local `z.object()` copy of a shape a mapper already emits
 * (e.g. a local `AccessGroupSchema` with a numeric id and no `capabilities`,
 * while `mapGroupRow` emits a UUID id + capabilities and the canonical
 * `AccessGroupSchema` in `$lib/schemas/api-admin-access.ts` declares both). The
 * two parallel declarations silently disagreed, and the stale local one reached
 * clients — a strict decoder then rejected the whole response because the
 * generated spec carries `additionalProperties: false`.
 *
 * The fix is "one declaration per shape": import the canonical schema, never
 * hand-copy it into a def. This rule prevents the local copy from coming back.
 *
 * It matches by identifier name against a curated list of schemas that are
 * owned by `$lib/schemas` and were previously shadowed by def-local copies. A
 * def MUST import these, not re-declare them. (Deliberately conservative — it
 * lists specific canonical names rather than banning every inline `z.object`,
 * because route-specific one-off response shapes defined inline are a legitimate
 * and common pattern.)
 */

'use strict';

/** Canonical schema identifiers owned by $lib/schemas — never redeclare in a def. */
const CANONICAL_SCHEMA_NAMES = new Set([
    'AccessGroupSchema',
    'AccessGroupMemberSchema',
    'AccessGroupCapabilitySchema',
    'LibraryGroupDataSchema',
    'LibraryPathSchema',
    'LiveTvChannelSchema',
    'LiveTvProgramSchema',
    'WebhookRowSchema',
    'ApiUserSchema',
    'AdminCategoryResponseSchema',
    'RunSchema',
]);

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Disallow re-declaring a canonical $lib/schemas response schema locally in an API def',
        },
        schema: [],
        messages: {
            shadow:
                "'{{name}}' is a canonical schema owned by $lib/schemas — import it, do not " +
                're-declare it locally. A hand-copied response schema drifts from the shape the ' +
                'handler emits, and additionalProperties:false in the generated spec then fails ' +
                'the whole response for strict clients (the tvOS search-bug class).',
        },
    },
    create(context) {
        const filename = (context.filename || context.getFilename()).replace(/\\/g, '/');
        // Only guard the def layer; schema modules themselves legitimately
        // define these, and colocated *.schemas.ts sidecars are the sanctioned
        // single-source pattern (see GUARD A).
        if (!filename.includes('/server/api/defs/')) return {};
        if (/\.test\.ts$/.test(filename) || /\.schemas\.ts$/.test(filename)) return {};

        return {
            VariableDeclarator(node) {
                if (
                    node.id &&
                    node.id.type === 'Identifier' &&
                    CANONICAL_SCHEMA_NAMES.has(node.id.name)
                ) {
                    context.report({
                        node: node.id,
                        messageId: 'shadow',
                        data: { name: node.id.name },
                    });
                }
            },
        };
    },
};
