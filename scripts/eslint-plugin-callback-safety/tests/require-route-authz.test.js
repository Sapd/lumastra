// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for require-route-authz rule.
 *
 * The rule is path-scoped to src/routes/api/ ** /+server.{ts,js}. It fires when
 * such a file exports an HTTP handler body but references no authorization
 * primitive and carries no `// authz:` annotation. Re-export shims, non-+server
 * files, and files outside /api are exempt.
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/require-route-authz');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2022,
        sourceType: 'module',
    },
});

const API = '/repo/src/routes/api/foo/+server.ts';
const API_V1 = '/repo/src/routes/api/v1/tasks/[taskId]/run/+server.ts';
const JELLYFIN = '/repo/src/routes/j/Items/+server.ts';
const NON_SERVER = '/repo/src/routes/api/foo/helpers.ts';
const LIB = '/repo/src/lib/server/services/foo.ts';

ruleTester.run('require-route-authz', rule, {
    valid: [
        {
            code: `import { mount } from '$lib/server/api/mount.js';
export const GET = mount(def, { surface: 'internal' }).GET!;`,
            filename: API,
        },
        {
            code: `import { mount as apiMount } from '$lib/server/api/mount.js';
import { withAISuggestionRateLimit as limit } from '$lib/server/middleware/valkey-rate-limit.js';
export const GET = limit(apiMount(def, { surface: 'internal' }).GET!);`,
            filename: API,
        },
        // ── a negated admin verdict that returns is a guard ──
        {
            code: `export const POST = withErrorHandler(async ({ locals: l }) => { if (!localsIsAdmin(l)) { return new Response(null, { status: 403 }); } return new Response('ok'); });`,
            filename: API,
        },
        {
            code: `export const GET = withErrorHandler(async ({ locals: l }) => { if (a || !localsIsAdmin(l)) throw error(403); return new Response('ok'); });`,
            filename: API,
        },
        // ── references a recognized authz primitive ──
        {
            code: `export const GET = requireAdmin(async () => new Response('ok'));`,
            filename: API,
        },
        {
            code: `export const POST = requireAuth(withErrorHandler(async () => new Response('ok')));`,
            filename: API,
        },
        {
            code: `export const GET = withErrorHandler(async (event) => { const r = await getPlaylistContext(event); return new Response('ok'); });`,
            filename: API,
        },
        {
            code: `export const POST = withErrorHandler(async (event) => { const a = await authenticate(event); requireScope(a, 'tasks:run'); return new Response('ok'); });`,
            filename: API_V1,
        },
        {
            // inline identity decision counts (coarse, on purpose)
            code: `export const GET = withErrorHandler(async ({ locals }) => { if (!locals.user) return new Response(null, { status: 401 }); return new Response('ok'); });`,
            filename: API,
        },
        // ── explicit authz annotation escape hatch ──
        {
            code: `// authz: public — branding only, intentionally unauthenticated\nexport const GET = withErrorHandler(async () => new Response('ok'));`,
            filename: API,
        },
        {
            code: `// authz: authenticated — artwork proxy, no user data\nexport const GET = async () => new Response('ok');`,
            filename: API,
        },
        // ── exempt: outside /api ──
        {
            code: `export const GET = async () => new Response('ok');`,
            filename: JELLYFIN,
        },
        {
            code: `export const GET = async () => new Response('ok');`,
            filename: LIB,
        },
        // ── exempt: not a +server file ──
        {
            code: `export const GET = async () => new Response('ok');`,
            filename: NON_SERVER,
        },
        // ── exempt: re-export shim (no handler body) ──
        {
            code: `export { GET } from '../../bar/+server.js';`,
            filename: API,
        },
    ],
    invalid: [
        {
            code: `import { withAISuggestionRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
export const GET = withAISuggestionRateLimit(async () => new Response('ok'));`,
            filename: API,
            errors: [{ messageId: 'missingAuthz' }],
        },
        {
            code: `import { mount } from './unrelated.js';
export const GET = mount(def).GET;`,
            filename: API,
            errors: [{ messageId: 'missingAuthz' }],
        },
        {
            code: `import { mount } from '$lib/server/api/mount.js';
import { withAISuggestionRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
export const GET = withAISuggestionRateLimit(mount(def).GET!);
export const POST = async () => new Response('ok');`,
            filename: API,
            errors: [{ messageId: 'missingAuthz' }],
        },
        {
            code: `import { mount } from '$lib/server/api/mount.js';
const unused = mount(def);
export const GET = async () => new Response('ok');`,
            filename: API,
            errors: [{ messageId: 'missingAuthz' }],
        },
        // the verdict computed for an option, not a guard
        {
            code: `export const GET = withErrorHandler(async ({ locals: l }) => { const opts = { admin: localsIsAdmin(l) }; return new Response(JSON.stringify(opts)); });`,
            filename: API,
            errors: [{ messageId: 'missingAuthz' }],
        },
        // a guarded GET does not cover an unguarded POST
        {
            code: `export const GET = withErrorHandler(async ({ locals: l }) => { if (!localsIsAdmin(l)) return new Response(null, { status: 403 }); return new Response('ok'); });
export const POST = withErrorHandler(async () => new Response('ok'));`,
            filename: API,
            errors: [{ messageId: 'missingAuthz' }],
        },
        // a guard in a helper outside the handler covers nothing
        {
            code: `function check(l) { if (!localsIsAdmin(l)) { return false; } return true; }
export const GET = withErrorHandler(async () => new Response('ok'));`,
            filename: API,
            errors: [{ messageId: 'missingAuthz' }],
        },
        // positive branch: nothing is denied
        {
            code: `export const GET = withErrorHandler(async ({ locals: l }) => { if (localsIsAdmin(l)) { return new Response('admin'); } return new Response('ok'); });`,
            filename: API,
            errors: [{ messageId: 'missingAuthz' }],
        },
        // handler body, no authz primitive, no annotation
        {
            code: `export const GET = withErrorHandler(async ({ url }) => new Response(url.search));`,
            filename: API,
            errors: [{ messageId: 'missingAuthz' }],
        },
        // bare `export async function` handler, unguarded
        {
            code: `export async function POST() { return new Response('ok'); }`,
            filename: API,
            errors: [{ messageId: 'missingAuthz' }],
        },
        // a bare `// authz:` with no label must NOT satisfy the escape hatch
        {
            code: `// authz:\nexport const GET = async () => new Response('ok');`,
            filename: API,
            errors: [{ messageId: 'missingAuthz' }],
        },
    ],
});

console.log('✅ require-route-authz tests passed');
