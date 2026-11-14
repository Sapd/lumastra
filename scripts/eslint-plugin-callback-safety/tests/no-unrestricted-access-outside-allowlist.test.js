// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for no-unrestricted-access-outside-allowlist.
 *
 * The rule flags `unrestrictedAccess()` (and a bare `UNRESTRICTED` value) in
 * server files that are NOT on the admin/scanner/compat allowlist. Exercises:
 * applicable paths where it fires, allowlisted paths where it stays silent,
 * non-server paths, and the eslint-disable override.
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/no-unrestricted-access-outside-allowlist');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2020,
        sourceType: 'module',
    },
});

// Applicable (non-allowlisted) server paths — rule SHOULD fire here.
const ROUTE_PATH = '/repo/src/routes/music/albums-x/+page.server.ts';
const SERVICE_PATH = '/repo/src/lib/server/services/some-user-facing.service.ts';
const API_DEF_PATH = '/repo/src/lib/server/api/defs/catalog/some-list.ts';
const SONIC_TASK_PATH = '/repo/src/lib/server/tasks/builtin/native/sonic-clustering.ts';

// Allowlisted / non-applicable paths — rule must stay SILENT.
const ADMIN_PATH = '/repo/src/lib/server/api/defs/admin/thing.ts';
const SUBSONIC_PATH = '/repo/src/lib/server/subsonic-compat/handlers/browse.ts';
const J_COMPAT_PATH = '/repo/src/routes/(modules)/j/Items/+server.ts';
const ASSISTANT_PATH = '/repo/src/lib/server/assistant/assistant-tools/get-playlists.tool.ts';
const WARMING_PATH = '/repo/src/lib/server/cache/warming.ts';
const BOUNDARY_PATH = '/repo/src/lib/server/database/queries/builders/media-access-boundary.ts';
const CATALOGUED_PATH = '/repo/src/routes/music/+page.server.ts';
const CLIENT_PATH = '/repo/src/lib/components/Foo.svelte.ts';
const TEST_PATH = '/repo/src/lib/server/services/some.service.test.ts';

ruleTester.run('no-unrestricted-access-outside-allowlist', rule, {
    valid: [
        // ── allowlisted server paths ──
        { code: `const a = unrestrictedAccess();`, filename: ADMIN_PATH },
        { code: `const a = unrestrictedAccess();`, filename: SUBSONIC_PATH },
        { code: `const a = unrestrictedAccess();`, filename: J_COMPAT_PATH },
        { code: `const a = unrestrictedAccess();`, filename: ASSISTANT_PATH },
        { code: `const a = unrestrictedAccess();`, filename: WARMING_PATH },
        { code: `export function unrestrictedAccess() { return {}; }`, filename: BOUNDARY_PATH },
        // ── file catalogued on the allowlist (pre-existing audited read) ──
        { code: `const a = unrestrictedAccess();`, filename: CATALOGUED_PATH },
        // ── non-server (client) code is out of scope ──
        { code: `const a = unrestrictedAccess();`, filename: CLIENT_PATH },
        // ── tests are exempt ──
        { code: `const a = unrestrictedAccess();`, filename: TEST_PATH },
        // ── eslint-disable override at an applicable path ──
        {
            code: `
                // eslint-disable-next-line rule-to-test/no-unrestricted-access-outside-allowlist
                const a = unrestrictedAccess();
            `,
            filename: ROUTE_PATH,
        },
        // ── a same-named local property/declaration named UNRESTRICTED is not a value use ──
        { code: `const obj = { UNRESTRICTED: 1 };`, filename: SERVICE_PATH },
    ],
    invalid: [
        // A one-call cache-warming exception must not exempt later calls in the task.
        {
            filename: SONIC_TASK_PATH,
            code: `
                // Cache warming intentionally reads all clusters.
                // eslint-disable-next-line rule-to-test/no-unrestricted-access-outside-allowlist
                const warm = unrestrictedAccess();
                const other = unrestrictedAccess();
            `,
            errors: [{ messageId: 'unrestricted' }],
        },
        // ── unrestrictedAccess() call at applicable, non-allowlisted paths ──
        {
            code: `const a = unrestrictedAccess();`,
            filename: ROUTE_PATH,
            errors: [{ messageId: 'unrestricted', data: { name: 'unrestrictedAccess()' } }],
        },
        {
            code: `const rows = await getX(sql, unrestrictedAccess());`,
            filename: SERVICE_PATH,
            errors: [{ messageId: 'unrestricted' }],
        },
        {
            code: `const opts = { access: unrestrictedAccess() };`,
            filename: API_DEF_PATH,
            errors: [{ messageId: 'unrestricted' }],
        },
        // ── member form `boundary.unrestrictedAccess()` ──
        {
            code: `const a = mod.unrestrictedAccess();`,
            filename: ROUTE_PATH,
            errors: [{ messageId: 'unrestricted' }],
        },
        // ── bare UNRESTRICTED constant used as a value ──
        {
            code: `const opts = { access: UNRESTRICTED };`,
            filename: SERVICE_PATH,
            errors: [{ messageId: 'unrestricted', data: { name: 'UNRESTRICTED' } }],
        },
    ],
});

console.log('  ✅ no-unrestricted-access-outside-allowlist: all tests passed');
