// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for no-locals-user-is-admin: every spelling of reading the OWNER's
 * admin flag off `locals.user` is flagged; the principal and content-access
 * helpers that take `locals.user` are not; the allowlist needs a reason.
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/no-locals-user-is-admin');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2022,
        sourceType: 'module',
    },
});

const DEF = '/repo/src/lib/server/api/defs/stats/username.ts';
const PAGE = '/repo/src/routes/admin/users/+page.server.ts';
const err = [{ messageId: 'userIsAdmin' }];

ruleTester.run('no-locals-user-is-admin', rule, {
    valid: [
        { code: 'const a = locals.principal?.isAdmin === true;', filename: DEF },
        { code: 'const a = event.locals.principal?.isAdmin === true;', filename: DEF },
        { code: 'if (!localsIsAdmin(locals)) redirect(303, "/");', filename: PAGE },
        // content-access helpers get the user; they are reviewed separately
        { code: 'await checkMediaAccess(sql, id, locals.user);', filename: DEF },
        {
            code: 'const lu = toLibraryAccessUser(event.locals.user); if (lu?.isAdmin) throw e;',
            filename: DEF,
        },
        // other users' rows are data, not the caller
        { code: 'const row = await getUser(sql, id); if (row.isAdmin) x();', filename: DEF },
        { code: 'function f(user) { return user.isAdmin; }', filename: DEF },
        // other fields of locals.user are fine
        { code: 'const n = locals.user?.username;', filename: DEF },
        // allowlisted file
        {
            code: 'const a = locals.user.isAdmin;',
            filename: DEF,
            options: [
                {
                    allow: [
                        { file: 'defs/stats/username.ts', reason: 'test-only exception reason' },
                    ],
                },
            ],
        },
    ],
    invalid: [
        { code: 'const a = locals.user.isAdmin;', filename: DEF, errors: err },
        { code: 'const a = locals.user?.ownerIsAdmin;', filename: DEF, errors: err },
        { code: 'const { ownerIsAdmin } = locals.user;', filename: DEF, errors: err },
        // Page loads and actions are server code too (GUARD N covers src/**).
        { code: 'if (!locals.user?.isAdmin) redirect(303, "/");', filename: PAGE, errors: err },
        { code: 'const a = locals.user?.isAdmin ?? false;', filename: DEF, errors: err },
        { code: 'const a = event.locals.user?.isAdmin === true;', filename: DEF, errors: err },
        { code: 'const a = event.locals.user!.isAdmin;', filename: DEF, errors: err },
        {
            code: 'const a = event.locals.principal?.isAdmin ?? event.locals.user?.isAdmin ?? false;',
            filename: DEF,
            errors: err,
        },
        { code: "const a = locals.user['isAdmin'];", filename: DEF, errors: err },
        {
            code: 'const user = event.locals.user; const a = user?.isAdmin;',
            filename: DEF,
            errors: err,
        },
        { code: 'const { user } = locals; if (user.isAdmin) x();', filename: DEF, errors: err },
        {
            code: 'const { user: u } = event.locals; if (u?.isAdmin) x();',
            filename: DEF,
            errors: err,
        },
        { code: 'const { isAdmin } = locals.user;', filename: DEF, errors: err },
        {
            code: 'export const GET = async ({ locals }) => locals.user.isAdmin;',
            filename: '/repo/src/routes/api/v1/watch-together/parties/+server.ts',
            errors: err,
        },
        {
            code: 'const u = locals.user ?? undefined; if (u?.isAdmin) x();',
            filename: DEF,
            errors: err,
        },
        { code: 'const { isAdmin } = locals.user ?? {};', filename: DEF, errors: err },
        { code: 'const a = (event.locals.user || fallback).isAdmin;', filename: DEF, errors: err },
        {
            code: 'export const GET = ({ locals: { user } }) => user.isAdmin;',
            filename: DEF,
            errors: err,
        },
        {
            code: "function can(user: App.Locals['user']) { return user?.isAdmin === true; }",
            filename: DEF,
            errors: err,
        },
        {
            code: "function can(user: App.Locals['user'] | undefined) { return !!user?.isAdmin; }",
            filename: DEF,
            errors: err,
        },
        { code: 'function can(u: UserContext) { return u.isAdmin; }', filename: DEF, errors: err },
        // another file's allowlist entry does not cover this one
        {
            code: 'const a = locals.user.isAdmin;',
            filename: DEF,
            options: [{ allow: [{ file: 'defs/other.ts', reason: 'test-only exception reason' }] }],
            errors: err,
        },
    ],
});

// The allowlist must carry a reason.
// Under vitest, RuleTester hands each case to the runner's describe/it, so a schema error
// becomes a failing case instead of throwing here. Run this one case synchronously.
const runnerDescribe = RuleTester.describe;
const runnerIt = RuleTester.it;
RuleTester.describe = (_title, fn) => fn();
RuleTester.it = (_title, fn) => fn();
let threw = false;
try {
    ruleTester.run('no-locals-user-is-admin (allow without reason)', rule, {
        valid: [{ code: 'x;', filename: DEF, options: [{ allow: [{ file: 'a.ts' }] }] }],
        invalid: [],
    });
} catch {
    threw = true;
} finally {
    RuleTester.describe = runnerDescribe;
    RuleTester.it = runnerIt;
}
if (!threw) throw new Error('an allow entry without a reason must be rejected by the schema');

console.log('no-locals-user-is-admin: all tests passed');
