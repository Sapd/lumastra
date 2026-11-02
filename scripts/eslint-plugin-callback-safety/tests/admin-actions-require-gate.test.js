// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for admin-actions-require-gate.
 *
 * We exercise:
 *  - the real defect shape (an admin page action that reads the form and saves, no gate)
 *  - the accepted shapes: gate as first statement; direct delegation to a gated helper
 *    (expression body and `return`); `satisfies Actions` wrapping
 *  - a gate that is present but NOT first (must still fail — the work before it ran)
 *  - files outside src/routes/admin, which must never be touched
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/admin-actions-require-gate');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2020,
        sourceType: 'module',
    },
});

const ADMIN = '/repo/src/routes/admin/settings/music/+page.server.ts';
const NOT_ADMIN = '/repo/src/routes/settings/+page.server.ts';

ruleTester.run('admin-actions-require-gate', rule, {
    valid: [
        {
            filename: ADMIN,
            code: `export const actions = {
                save: async ({ request, locals }) => {
                    const denied = denyUnlessAdmin(locals);
                    if (denied) return denied;
                    await saveConfig(await request.formData());
                    return { success: true };
                },
            };`,
        },
        {
            filename: ADMIN,
            code: `export const actions = {
                save: async ({ request, locals }) => saveSettingsAction(request, locals),
                reload: async ({ locals }) => reloadSettingsAction(locals),
            };`,
        },
        {
            filename: ADMIN,
            code: `export const actions = {
                reload: async ({ locals }) => { return reloadSettingsAction(locals); },
            } satisfies Actions;`,
        },
        {
            // the inline verdict check the audiobookshelf page uses
            filename: ADMIN,
            code: `export const actions = {
                revoke: async ({ request, locals }) => {
                    if (!localsIsAdmin(locals)) {
                        return fail(403, { revokeError: 'Admin access required' });
                    }
                    const form = await request.formData();
                    return { ok: true };
                },
            };`,
        },
        {
            // outside src/routes/admin: the layout there is not the concern of this rule
            filename: NOT_ADMIN,
            code: `export const actions = { save: async ({ request }) => { await saveConfig(request); } };`,
        },
        {
            // factory pages: no object literal to inspect (the factory gates)
            filename: ADMIN,
            code: `const { load, actions } = createSettingsPageServer(['music']); export { load, actions };`,
        },
        {
            filename: ADMIN,
            code: `export const actions = {
                save: async (event) => {
                    if (localsIsAdmin(event.locals) === false) throw error(403, 'no');
                    return { ok: true };
                },
            };`,
        },
        {
            filename: ADMIN,
            code: `export const actions = {
                save: async ({ locals }) => {
                    const denied = await denyUnlessAdmin(locals);
                    if (denied) {
                        return denied;
                    }
                    return { ok: true };
                },
            };`,
        },
    ],
    invalid: [
        {
            // positive branch: the work runs inside the admin check, nothing denies
            filename: ADMIN,
            code: `export const actions = {
                save: async ({ locals }) => {
                    if (localsIsAdmin(locals)) {
                        return { ok: true };
                    }
                    return { ok: false };
                },
            };`,
            errors: [{ messageId: 'ungated' }],
        },
        {
            // double negation is a positive check
            filename: ADMIN,
            code: `export const actions = {
                save: async ({ locals }) => {
                    if (!!localsIsAdmin(locals)) return { ok: true };
                    return { ok: false };
                },
            };`,
            errors: [{ messageId: 'ungated' }],
        },
        {
            // an .isAdmin on another object is not the caller's verdict
            filename: ADMIN,
            code: `export const actions = {
                save: async ({ locals, request }) => {
                    if (!(await load(request)).isAdmin) return fail(400);
                    return { ok: true };
                },
            };`,
            errors: [{ messageId: 'ungated' }],
        },
        {
            // the check returns something other than the 403
            filename: ADMIN,
            code: `export const actions = {
                save: async ({ locals }) => {
                    const denied = denyUnlessAdmin(locals);
                    if (denied) return { ok: true };
                    return { ok: true };
                },
            };`,
            errors: [{ messageId: 'ungated' }],
        },
        {
            // the 403 is computed but never returned
            filename: ADMIN,
            code: `export const actions = {
                save: async ({ locals }) => {
                    const denied = denyUnlessAdmin(locals);
                    return { ok: true };
                },
            };`,
            errors: [{ messageId: 'ungated' }],
        },
        {
            // the 2026-09-12 defect, verbatim shape
            filename: ADMIN,
            code: `export const actions = {
                save: async ({ request, locals }) => {
                    const formData = await request.formData();
                    await saveConfig(JSON.parse(String(formData.get('updates'))));
                    auditLog('settings.save', 'config', locals.user?.username ?? null, {});
                    return { success: true };
                },
            };`,
            errors: [{ messageId: 'ungated', data: { name: 'save' } }],
        },
        {
            // gate present but not first: the form was already read and saved
            filename: ADMIN,
            code: `export const actions = {
                save: async ({ request, locals }) => {
                    const formData = await request.formData();
                    const denied = denyUnlessAdmin(locals);
                    if (denied) return denied;
                    await saveConfig(formData);
                },
            };`,
            errors: [{ messageId: 'ungated', data: { name: 'save' } }],
        },
        {
            // reads isAdmin but only logs — not a gate
            filename: ADMIN,
            code: `export const actions = {
                save: async ({ request, locals }) => {
                    if (!locals.user?.isAdmin) { console.warn('non-admin'); }
                    await saveConfig(await request.formData());
                },
            };`,
            errors: [{ messageId: 'ungated', data: { name: 'save' } }],
        },
        {
            filename: ADMIN,
            code: `export const actions = {
                clear: async ({ locals }) => { await saveConfig({ LICENSE_KEY: '' }); return { ok: true }; },
            } satisfies Actions;`,
            errors: [{ messageId: 'ungated', data: { name: 'clear' } }],
        },
    ],
});

console.log('✓ admin-actions-require-gate tests passed');
