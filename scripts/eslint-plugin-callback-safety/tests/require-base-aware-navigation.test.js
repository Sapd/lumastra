// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for GUARD H — require-base-aware-navigation.
 *
 * Same RuleTester shape as the sibling rule suites. The Svelte-attribute half of
 * the rule needs svelte-eslint-parser, so those cases run in a second RuleTester
 * configured with it; the JS half runs on plain espree.
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/require-base-aware-navigation');

const ruleTester = new RuleTester({
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

ruleTester.run('require-base-aware-navigation', rule, {
    valid: [
        // Wrapped in a helper IMPORTED from a base-aware module.
        `import { resolve } from '$lib/paths'; goto(resolve('/watch/1'));`,
        `import { appPath } from '$lib/shared/api-urls.js'; goto(appPath('/watch/1'));`,
        `import { navigateTo } from '$lib/paths'; navigateTo('/x');`,
        `import { appPath } from '$lib/shared/api-urls.js'; redirect(302, appPath('/'));`,
        `import { resolve } from '$lib/paths'; redirect(302, resolve('/admin'));`,
        "import { appPath } from '$lib/shared/api-urls.js'; goto(appPath(`/watch/${id}`));",
        // Aliased import — the LOCAL name is what gets tracked.
        `import { url as u } from '$lib/paths'; goto(u('/watch/1'));`,
        // Namespace import.
        `import * as paths from '$lib/paths'; goto(paths.url('/watch/1'));`,
        // Not root-absolute, so not in-app navigation.
        `goto('https://example.com/x');`,
        `goto('//cdn.example.com/x');`,
        `goto(someVariable);`,
        // A same-named function that is not navigation.
        `myThing.push('/not-navigation');`,
    ],

    invalid: [
        {
            code: `goto('/watch/1');`,
            errors: [{ messageId: 'navCall' }],
        },
        {
            code: 'goto(`/watch/${id}`);',
            errors: [{ messageId: 'navCall' }],
        },
        {
            code: `redirect(302, '/');`,
            errors: [{ messageId: 'navCall' }],
        },
        {
            code: `redirect(307, '/settings/sessions');`,
            errors: [{ messageId: 'navCall' }],
        },
        {
            code: `pushState('/shallow');`,
            errors: [{ messageId: 'navCall' }],
        },
        {
            code: `goto('/a'); goto('/b');`,
            errors: [{ messageId: 'navCall' }, { messageId: 'navCall' }],
        },
        {
            // REGRESSION: an earlier version matched the callee NAME only, so a
            // local no-op called `resolve` silently satisfied the rule. It must
            // now be treated as unwrapped, because it is not imported from a
            // base-aware module.
            code: `const resolve = (s) => s; goto(resolve('/watch/1'));`,
            errors: [{ messageId: 'navCall' }],
        },
        {
            // Same name, WRONG module.
            code: `import { url } from './my-local-utils'; goto(url('/watch/1'));`,
            errors: [{ messageId: 'navCall' }],
        },
    ],
});

// ---------------------------------------------------------------------------
// Svelte attribute half
// ---------------------------------------------------------------------------

let svelteParser;
try {
    svelteParser = require('svelte-eslint-parser');
} catch {
    svelteParser = null;
}

if (svelteParser) {
    const svelteTester = new RuleTester({
        languageOptions: {
            parser: svelteParser,
            ecmaVersion: 2022,
            sourceType: 'module',
        },
    });

    svelteTester.run('require-base-aware-navigation (svelte)', rule, {
        valid: [
            // REGRESSION: imports live inside a SvelteScriptElement, not on
            // Program.body. A Program-only walk saw no imports here and reported
            // this correct call as unwrapped (54 false positives, all .svelte).
            {
                code:
                    `<script>` +
                    `import { goto } from '$app/navigation';` +
                    `import { resolve } from '$lib/paths';` +
                    'function go(k) { goto(resolve(`/watch/${k}`)); }' +
                    `</script><button onclick={() => go(1)}>x</button>`,
                filename: 'A.svelte',
            },
            {
                code: `<script>import { resolve } from '$lib/paths';</script><a href={resolve('/browse')}>x</a>`,
                filename: 'A.svelte',
            },
            {
                code: `<script>import { resolve } from '$lib/paths';</script><a href={resolve(\`/watch/\${id}\`)}>x</a>`,
                filename: 'A.svelte',
            },
            { code: `<a href="https://example.com">x</a>`, filename: 'A.svelte' },
            { code: `<a href="#section">x</a>`, filename: 'A.svelte' },
            { code: `<a href="relative/path">x</a>`, filename: 'A.svelte' },
            // Not a URL-bearing attribute.
            { code: `<div title="/browse"></div>`, filename: 'A.svelte' },
        ],
        invalid: [
            {
                code:
                    `<script>` +
                    `import { goto } from '$app/navigation';` +
                    'function go(k) { goto(`/watch/${k}`); }' +
                    `</script><button onclick={() => go(1)}>x</button>`,
                filename: 'A.svelte',
                errors: [{ messageId: 'navCall' }],
            },
            {
                code: `<a href="/browse">x</a>`,
                filename: 'A.svelte',
                errors: [{ messageId: 'navAttr' }],
            },
            {
                code: `<img src="/static/x.png" alt="" />`,
                filename: 'A.svelte',
                errors: [{ messageId: 'navAttr' }],
            },
            {
                // The interpolated form this codebase had 25 of.
                code: `<a href="/admin/library/media/{item.id}?tab=pipeline">x</a>`,
                filename: 'A.svelte',
                errors: [{ messageId: 'navAttr' }],
            },
        ],
    });
    console.log('  ✅ require-base-aware-navigation: all tests passed (incl. svelte)');
} else {
    console.log('  ✅ require-base-aware-navigation: JS tests passed (svelte parser absent)');
}
