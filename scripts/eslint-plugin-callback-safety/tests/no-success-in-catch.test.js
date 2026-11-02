// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for no-success-in-catch rule.
 *
 * The rule flags a `return { success: true }`-shaped result whose nearest
 * enclosing control construct is a catch block (a swallowed failure reported
 * as success). It must stay silent on honest failure reports, computed
 * success, happy-path success, and re-throws.
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/no-success-in-catch');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2020,
        sourceType: 'module',
    },
});

ruleTester.run('no-success-in-catch', rule, {
    valid: [
        // ── happy path: success:true returned from the try / normal flow ──
        {
            code: `
                async function run() {
                    const data = await load();
                    return { success: true, data };
                }
            `,
        },
        // ── success:true after a real success, inside try (not catch) ──
        {
            code: `
                async function run() {
                    try {
                        await doWork();
                        return { success: true };
                    } catch (e) {
                        throw e;
                    }
                }
            `,
        },
        // ── honest failure report in catch (success:false) ──
        {
            code: `
                async function run() {
                    try {
                        await doWork();
                        return { success: true };
                    } catch (e) {
                        return { success: false, error: String(e) };
                    }
                }
            `,
        },
        // ── computed / non-literal success in catch is not flagged ──
        {
            code: `
                async function run() {
                    try {
                        await doWork();
                    } catch (e) {
                        const success = shouldSwallow(e);
                        return { success, error: e };
                    }
                }
            `,
        },
        // ── shorthand success (a variable, not literal true) ──
        {
            code: `
                function run(success) {
                    try {
                        return risky();
                    } catch (e) {
                        return { success };
                    }
                }
            `,
        },
        // ── re-throw in catch (no success return) ──
        {
            code: `
                async function run() {
                    try {
                        await doWork();
                    } catch (e) {
                        throw new Error('wrapped: ' + e);
                    }
                }
            `,
        },
        // ── success:true returned by a NESTED function declared in the catch:
        //    that return exits the inner arrow, not the catch itself ──
        {
            code: `
                async function run() {
                    try {
                        await doWork();
                    } catch (e) {
                        const build = () => ({ success: true });
                        register(build);
                        return { success: false };
                    }
                }
            `,
        },
    ],
    invalid: [
        // ── the core bug: return { success: true } straight out of a catch ──
        {
            code: `
                async function run() {
                    try {
                        await refresh();
                        return { success: true };
                    } catch (e) {
                        return { success: true };
                    }
                }
            `,
            errors: [{ messageId: 'successInCatch' }],
        },
        // ── success:true with extra payload keys ──
        {
            code: `
                async function run() {
                    try {
                        return await refresh();
                    } catch (e) {
                        return { success: true, itemsProcessed: 0, error: e };
                    }
                }
            `,
            errors: [{ messageId: 'successInCatch' }],
        },
        // ── `true as const` is unwrapped and still flagged ──
        {
            code: `
                async function run() {
                    try {
                        return await refresh();
                    } catch (e) {
                        return { success: true as const, data: null };
                    }
                }
            `,
            errors: [{ messageId: 'successInCatch' }],
        },
        // ── success:true reachable through a conditional branch in the return ──
        {
            code: `
                async function run() {
                    try {
                        return await refresh();
                    } catch (e) {
                        return isBenign(e) ? { success: true } : { success: false, error: e };
                    }
                }
            `,
            errors: [{ messageId: 'successInCatch' }],
        },
    ],
});

console.log('  ✅ no-success-in-catch: all tests passed');
