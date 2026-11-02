// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for no-empty-catch rule
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/no-empty-catch');

const ruleTester = new RuleTester({
    languageOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
    },
});

ruleTester.run('no-empty-catch', rule, {
    valid: [
        {
            // Catch with error handling
            code: `try { doSomething(); } catch (e) { console.error(e); }`,
        },
        {
            // Catch with justification comment (block)
            code: `try { doSomething(); } catch { /* expected: optional feature */ }`,
        },
        {
            // Catch with justification comment (line)
            code: `try { doSomething(); } catch {
                // expected: audio node may already be disconnected
            }`,
        },
        {
            // Catch with fallback statement
            code: `try { value = JSON.parse(str); } catch { value = defaultVal; }`,
        },
        {
            // Catch with error variable used in body
            code: `try { doSomething(); } catch (e) { logger.warn('failed', { error: e }); }`,
        },
        {
            // Catch with return statement
            code: `function f() { try { doSomething(); } catch { return null; } }`,
        },
    ],
    invalid: [
        {
            // Bare catch with no variable, no comment, no body
            code: `try { doSomething(); } catch {}`,
            errors: [{ messageId: 'emptyCatch' }],
        },
        {
            // Catch with unused error variable and empty body
            code: `try { doSomething(); } catch (e) {}`,
            errors: [{ messageId: 'unusedCatchError', data: { name: 'e' } }],
        },
        {
            // Catch with unused error variable (different name)
            code: `try { doSomething(); } catch (err) {}`,
            errors: [{ messageId: 'unusedCatchError', data: { name: 'err' } }],
        },
    ],
});

console.log('  ✅ no-empty-catch: all tests passed');
