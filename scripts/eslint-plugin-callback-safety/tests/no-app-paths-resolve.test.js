// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for no-app-paths-resolve.
 *
 * We exercise:
 *  - the real defect shape (the six modules that blew the type-relation budget)
 *  - the wrapper itself, which MUST stay allowed or the narrowing has nowhere to live
 *  - `base` / `assets`, which are plain strings and must never be flagged
 *  - aliasing and namespace imports, so the check is about provenance not spelling
 *  - the autofix, which only fires when `resolve` is the sole specifier
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/no-app-paths-resolve');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2020,
        sourceType: 'module',
    },
});

const COMPONENT = '/repo/src/lib/components/livetv/ChannelGrid.svelte';
const ROUTE = '/repo/src/routes/livetv/+page.svelte';
const WRAPPER = '/repo/src/lib/paths.ts';

ruleTester.run('no-app-paths-resolve', rule, {
    valid: [
        // ── the wrapper is the one place the generic may be imported and narrowed ──
        {
            code: `
                import { base, resolve } from '$app/paths';
                const resolveDynamic = resolve as unknown as (path: string) => string;
                export function resolveRoute(path: string): string { return resolveDynamic(path); }
            `,
            filename: WRAPPER,
        },
        // ── base / assets are plain strings: cheap, and ~23 modules use them ──
        {
            code: `import { base } from '$app/paths';\nconst href = base + '/livetv';`,
            filename: COMPONENT,
        },
        {
            code: `import { base, assets } from '$app/paths';`,
            filename: ROUTE,
        },
        // ── the prescribed import ──
        {
            code: `import { resolve } from '$lib/paths';\ngoto(resolve('/livetv'));`,
            filename: ROUTE,
        },
        // ── a namespace import that never touches .resolve is fine ──
        {
            code: `import * as paths from '$app/paths';\nconst b = paths.base;`,
            filename: COMPONENT,
        },
        // ── an unrelated local named resolve is not our business ──
        {
            code: `function resolve(p: string) { return p; }\nresolve('/livetv');`,
            filename: COMPONENT,
        },
    ],

    invalid: [
        // ── the exact shape that caused the 25,773-error blowup ──
        {
            code: `import { resolve } from '$app/paths';\ngoto(resolve(\`/watch/\${channel.id}\`));`,
            filename: COMPONENT,
            output: `import { resolve } from '$lib/paths';\ngoto(resolve(\`/watch/\${channel.id}\`));`,
            errors: [{ messageId: 'directResolve' }],
        },
        // ── a static literal is just as expensive: the constraint is instantiated either way ──
        {
            code: `import { resolve } from '$app/paths';\nconst h = resolve('/livetv/guide');`,
            filename: ROUTE,
            output: `import { resolve } from '$lib/paths';\nconst h = resolve('/livetv/guide');`,
            errors: [{ messageId: 'directResolve' }],
        },
        // ── aliasing does not launder it ──
        {
            code: `import { resolve as r } from '$app/paths';\nconst h = r('/livetv');`,
            filename: ROUTE,
            output: `import { resolve as r } from '$lib/paths';\nconst h = r('/livetv');`,
            errors: [{ messageId: 'directResolve' }],
        },
        // ── mixed import: reported but NOT auto-fixed, since base must keep its source ──
        {
            code: `import { base, resolve } from '$app/paths';`,
            filename: COMPONENT,
            output: null,
            errors: [{ messageId: 'directResolve' }],
        },
        // ── namespace access reaches the same generic ──
        {
            code: `import * as paths from '$app/paths';\nconst h = paths.resolve('/livetv');`,
            filename: COMPONENT,
            errors: [{ messageId: 'namespaceResolve' }],
        },
        // ── a path that merely ends in paths.ts elsewhere is NOT the wrapper ──
        {
            code: `import { resolve } from '$app/paths';`,
            filename: '/repo/src/lib/server/paths.ts',
            output: `import { resolve } from '$lib/paths';`,
            errors: [{ messageId: 'directResolve' }],
        },
    ],
});
