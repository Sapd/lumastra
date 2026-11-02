// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for validate-callback-parameters rule
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/validate-callback-parameters');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2020,
        sourceType: 'module',
    },
});

ruleTester.run('validate-callback-parameters', rule, {
    valid: [
        {
            // With validation
            code: `
        export let onclick: (item: MediaItem) => void;

        function handleClick(item: MediaItem) {
          validateCallback(onclick, item, isMediaItem, 'onclick expects MediaItem');
          onclick(item);
        }
      `,
        },
        {
            // Built-in handler (exempted)
            code: `
        button.addEventListener('click', handleClick);
      `,
            options: [{ exemptBuiltIns: true }],
        },
        {
            // Not a callback prop
            code: `
        function process(item: MediaItem) {
          doSomething(item);
        }
      `,
        },
        {
            // Optional chaining without type annotation
            code: `
        export let onclick;

        function handleClick(item) {
          onclick?.(item);
        }
      `,
        },
    ],
    invalid: [
        {
            // Missing validation
            code: `
        export let onclick: (item: MediaItem) => void;

        function handleClick(item: MediaItem) {
          onclick(item);
        }
      `,
            errors: [
                {
                    messageId: 'missingValidation',
                    data: {
                        propName: 'onclick',
                    },
                },
            ],
        },
        {
            // Optional chaining without validation
            code: `
        export let onselect: (item: MediaItem) => void;

        function handleSelect(item: MediaItem) {
          onselect?.(item);
        }
      `,
            errors: [
                {
                    messageId: 'missingValidation',
                },
            ],
        },
        {
            // Multiple callback calls without validation
            code: `
        export let onchange: (value: string) => void;

        function handleChange(newValue: string) {
          onchange(newValue);
        }
      `,
            errors: [
                {
                    messageId: 'missingValidation',
                    data: {
                        propName: 'onchange',
                    },
                },
            ],
        },
    ],
});

console.log('✅ All tests passed for validate-callback-parameters');
