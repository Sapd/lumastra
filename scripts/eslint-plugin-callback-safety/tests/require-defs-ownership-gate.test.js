// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for require-defs-ownership-gate.
 *
 * The rule's value is entirely in its NARROWNESS — a version that also covered
 * `admin` and `scope` flagged 104 files, nearly all admin surfaces, which is the
 * noise that gets a rule disabled. So the invalid cases here are one shape, and
 * most of the file is the list of things that must keep passing:
 *
 *  - every sanctioned gate the real defs actually import
 *  - a handler that threads the caller in by hand instead of using a gate
 *  - admin/scope endpoints, where the scope IS the authorization
 *  - a static path, where there is no id to confuse with someone else's
 *  - the `// ownership:` escape, and its rejection when it carries no reason
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/require-defs-ownership-gate');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2020,
        sourceType: 'module',
    },
});

const DYNAMIC = '/repo/src/lib/server/api/defs/media/[id]/files.ts';
const STATIC = '/repo/src/lib/server/api/defs/media/files.ts';
const OUTSIDE = '/repo/src/routes/api/media/[id]/+server.ts';

/** A def with no caller reference at all — the shape the rule exists for. */
const BARE = `
export const def = defineEndpoint({
    auth: { kind: 'user' },
    handlers: {
        GET: async (event) => json(await getFiles(event.params.id)),
    },
});
`;

ruleTester.run('require-defs-ownership-gate', rule, {
    valid: [
        // ── gates, as the real defs import them ──
        ...[
            'getUserRole',
            'getPlaylistContext',
            'getPlaylistItemContext',
            'canEdit',
            'checkMediaAccess',
            'withMediaAccess',
            'resolveAndGate',
            'buildSearchAccessContext',
            'searchAccessBoundary',
            'toLibraryAccessUser',
            'filterAccessibleRows',
            'moduleGateResponse',
            'getEffectiveUser',
        ].map((gate) => ({
            filename: DYNAMIC,
            code: `
                import { ${gate} } from '$lib/server/utils/x.js';
                export const def = defineEndpoint({
                    auth: { kind: 'user' },
                    handlers: { GET: async (e) => ${gate}(e) },
                });
            `,
        })),

        // ── the caller threaded in by hand, with no named gate ──
        {
            filename: DYNAMIC,
            code: `
                export const def = defineEndpoint({
                    auth: { kind: 'user' },
                    handlers: {
                        GET: async ({ locals, params }) =>
                            json(await getRow(params.id, locals.user?.userId)),
                    },
                });
            `,
        },
        {
            filename: DYNAMIC,
            code: `
                export const def = defineEndpoint({
                    auth: { kind: 'user' },
                    handlers: { GET: async ({ locals }) => json(locals.principal) },
                });
            `,
        },

        // ── admin and scope: the scope is the authorization, not ownership ──
        {
            filename: DYNAMIC,
            code: `export const def = defineEndpoint({ auth: { kind: 'admin' }, handlers: {} });`,
        },
        {
            filename: DYNAMIC,
            code: `export const def = defineEndpoint({ auth: { kind: 'scope', scope: 'tasks:run' }, handlers: {} });`,
        },

        // ── no dynamic segment: no id to address someone else's resource by ──
        { filename: STATIC, code: BARE },

        // ── not a def ──
        { filename: OUTSIDE, code: BARE },

        // ── the declared exception ──
        {
            filename: DYNAMIC,
            code: `
                // ownership: none — library-group gate, not ownership; pending a
                // product call.
                ${BARE}
            `,
        },
        // …also accepted inside a block comment, which is where route headers live.
        {
            filename: DYNAMIC,
            code: `
                /**
                 * ownership: none — public artwork, no per-user dimension.
                 */
                ${BARE}
            `,
        },
    ],

    invalid: [
        {
            filename: DYNAMIC,
            code: BARE,
            errors: [{ messageId: 'missingGate' }],
        },
        {
            // Formatting must not be a way out.
            filename: DYNAMIC,
            code: `
                export const def = defineEndpoint({
                    auth: {
                        kind: 'user',
                    },
                    handlers: { GET: async (e) => json(e.params.id) },
                });
            `,
            errors: [{ messageId: 'missingGate' }],
        },
        {
            // A bare label with no reason is not a declaration.
            filename: DYNAMIC,
            code: `
                // ownership:
                ${BARE}
            `,
            errors: [{ messageId: 'missingGate' }],
        },
    ],
});

console.log('✓ require-defs-ownership-gate tests passed');
