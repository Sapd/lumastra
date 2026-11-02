// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for no-custom-event-in-callback-prop rule
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/no-custom-event-in-callback-prop');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2020,
        sourceType: 'module',
    },
});

ruleTester.run('no-custom-event-in-callback-prop', rule, {
    valid: [
        {
            code: `export let onclick: (event: MouseEvent) => void;`,
            filename: 'Component.svelte',
        },
        {
            code: `export let onselect: (item: MediaItem) => void;`,
            filename: 'Component.svelte',
        },
        {
            code: `export let onkeypress: (event: KeyboardEvent) => void = () => {};`,
            filename: 'Component.svelte',
        },
        {
            code: `export let onchange: (value: string) => void;`,
            filename: 'Component.svelte',
        },
        {
            code: `export let onclick = wrapCustomEventHandler<MediaItem>();`,
            filename: 'Component.svelte',
            options: [{ allowWithValidation: true }],
        },
        {
            // Not a callback prop (doesn't start with 'on')
            code: `export let handler: (event: CustomEvent<Data>) => void;`,
            filename: 'Component.svelte',
        },
        {
            // Private variable, not exported
            code: `let onclick: (event: CustomEvent<Data>) => void;`,
            filename: 'Component.svelte',
        },
    ],
    invalid: [
        {
            code: `export let onclick: (event: CustomEvent<MediaItem>) => void;`,
            filename: 'Component.svelte',
            errors: [
                {
                    messageId: 'customEventInCallback',
                    data: {
                        propName: 'onclick',
                        dataType: 'MediaItem',
                    },
                },
            ],
        },
        {
            // Note: `export let onselect?:` was a Svelte-only optional-prop
            // shorthand the standalone @typescript-eslint parser does NOT
            // accept ("',' expected"). We use Svelte 5 now (`$props()`), so
            // any legacy `export let` patterns in the codebase use the
            // assigned-default form below — which both parses cleanly under
            // the rule tester and is semantically equivalent.
            code: `export let onselect: (e: CustomEvent<Data>) => void = () => {};`,
            filename: 'Component.svelte',
            errors: [
                {
                    messageId: 'customEventInCallback',
                },
            ],
        },
        {
            code: `export let onitemclick: (event: CustomEvent<Item>) => void = () => {};`,
            filename: 'Component.svelte',
            errors: [
                {
                    messageId: 'customEventInCallback',
                    data: {
                        propName: 'onitemclick',
                        dataType: 'Item',
                    },
                },
            ],
        },
        {
            // Union type with CustomEvent
            code: `export let onclick: ((event: CustomEvent<MediaItem>) => void) | undefined;`,
            filename: 'Component.svelte',
            errors: [
                {
                    messageId: 'customEventInCallback',
                },
            ],
        },
    ],
});

console.log('✅ All tests passed for no-custom-event-in-callback-prop');
