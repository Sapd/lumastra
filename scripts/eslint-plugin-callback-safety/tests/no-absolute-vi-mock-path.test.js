// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for no-absolute-vi-mock-path.
 *
 * We exercise:
 *  - the real defect shape (the 52 `/Users/someone/...` specifiers that took main red)
 *  - the two conventions that must stay allowed: alias and sibling-relative
 *  - Windows and file:// spellings of the same mistake
 *  - the computed form, where no literal exists to grep for
 *  - non-mock `vi.*` calls and non-`vi` objects, which must never be touched
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/no-absolute-vi-mock-path');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2020,
        sourceType: 'module',
    },
});

const TEST_FILE = '/repo/src/lib/server/services/transcoding/ffmpeg.test.ts';

ruleTester.run('no-absolute-vi-mock-path', rule, {
    valid: [
        // ── the repo's dominant convention: alias + .js extension ──
        {
            code: `vi.mock('$lib/server/config.js', () => ({ config: {} }));`,
            filename: TEST_FILE,
        },
        {
            code: `vi.mock('$app/environment', () => ({ dev: false }));`,
            filename: TEST_FILE,
        },
        // ── sibling-relative, used when mocking a neighbour module ──
        {
            code: `vi.mock('./client.js', () => ({ apiGet: () => null }));`,
            filename: TEST_FILE,
        },
        {
            code: `vi.mock('../fixtures/task-config-mock.js');`,
            filename: TEST_FILE,
        },
        // ── a bare package name is portable ──
        {
            code: `vi.mock('postgres', () => ({ default: () => ({}) }));`,
            filename: TEST_FILE,
        },
        // ── other vi.* helpers take no specifier and must not be inspected ──
        {
            code: `const spy = vi.spyOn(obj, 'method'); vi.fn(); vi.hoisted(() => ({}));`,
            filename: TEST_FILE,
        },
        // ── a same-named method on some other object is not vitest ──
        {
            code: `jest.mock('/Users/someone/thing.js');`,
            filename: TEST_FILE,
        },
        // ── a dynamic specifier that is not an absolute-path builder is left alone;
        //    the rule reports what it can prove, not everything it cannot ──
        {
            code: `vi.mock(moduleUnderTest, () => ({}));`,
            filename: TEST_FILE,
        },
    ],

    invalid: [
        // ── the exact shape that took main red on 2026-08-28 ──
        {
            code: `vi.mock('/home/someone/checkouts/lumastra/src/lib/server/services/transcoding/persistence.ts', () => ({}));`,
            filename: TEST_FILE,
            errors: [{ messageId: 'absoluteLiteral' }],
        },
        {
            code: `vi.mock('/home/runner/work/repo/src/lib/server/db.ts');`,
            filename: TEST_FILE,
            errors: [{ messageId: 'absoluteLiteral' }],
        },
        // ── same mistake, other spellings ──
        {
            code: `vi.mock('C:\\\\Users\\\\testuser\\\\repo\\\\src\\\\lib\\\\thing.ts');`,
            filename: TEST_FILE,
            errors: [{ messageId: 'absoluteLiteral' }],
        },
        {
            code: `vi.mock('C:/Users/someone/repo/src/lib/thing.ts');`,
            filename: TEST_FILE,
            errors: [{ messageId: 'absoluteLiteral' }],
        },
        {
            code: `vi.mock('file:///Users/someone/repo/src/lib/thing.ts');`,
            filename: TEST_FILE,
            errors: [{ messageId: 'absoluteLiteral' }],
        },
        // ── a template literal with no interpolation is the same string ──
        {
            code: 'vi.mock(`/Users/someone/repo/src/lib/thing.ts`);',
            filename: TEST_FILE,
            errors: [{ messageId: 'absoluteLiteral' }],
        },
        // ── the other mocking entry points share the resolution rule ──
        {
            code: `vi.doMock('/Users/someone/repo/src/lib/thing.ts');`,
            filename: TEST_FILE,
            errors: [{ messageId: 'absoluteLiteral' }],
        },
        {
            code: `vi.unmock('/Users/someone/repo/src/lib/thing.ts');`,
            filename: TEST_FILE,
            errors: [{ messageId: 'absoluteLiteral' }],
        },
        // ── computed: absolute at runtime, with no literal to search for ──
        {
            code: `vi.mock(path.resolve(__dirname, './persistence.ts'), () => ({}));`,
            filename: TEST_FILE,
            errors: [{ messageId: 'computedAbsolute' }],
        },
        {
            code: 'vi.mock(`${__dirname}/persistence.ts`, () => ({}));',
            filename: TEST_FILE,
            errors: [{ messageId: 'computedAbsolute' }],
        },
        {
            code: `vi.mock(join(__dirname, 'persistence.ts'));`,
            filename: TEST_FILE,
            errors: [{ messageId: 'computedAbsolute' }],
        },
        {
            code: `vi.mock(__filename);`,
            filename: TEST_FILE,
            errors: [{ messageId: 'computedAbsolute' }],
        },
    ],
});

console.log('✓ no-absolute-vi-mock-path tests passed');
