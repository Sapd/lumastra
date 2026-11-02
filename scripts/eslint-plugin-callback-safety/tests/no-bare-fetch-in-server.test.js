// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for no-bare-fetch-in-server (C22 fix-plan finding).
 *
 * We exercise:
 *  - the real defect shape (a bare fetch() carrying a credential/admin URL)
 *  - the two guard-module exemptions (fetch-utils.ts, fetch-timeout.ts) and
 *    the third guard module (tasks/url-safety.ts)
 *  - test files, which are never linted by this rule
 *  - the false-positive traps this codebase actually has: a local `fetch`
 *    PARAMETER (feed-watching-section.ts's exact shape) and a MemberExpression
 *    callee (`ctx.dep('x').fetch()`, `strategy.fetch()`) — neither is a call
 *    to the global and must never be flagged
 *  - `fetchWithTimeout(...)` itself is obviously never flagged (different
 *    callee name entirely) — included for completeness
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/no-bare-fetch-in-server');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2020,
        sourceType: 'module',
    },
});

const SERVICE = '/repo/src/lib/server/services/some-integration.service.ts';
const FETCH_UTILS = '/repo/src/lib/server/utils/fetch-utils.ts';
const FETCH_TIMEOUT = '/repo/src/lib/server/utils/fetch-timeout.ts';
const URL_SAFETY = '/repo/src/lib/server/tasks/url-safety.ts';
const TEST_FILE = '/repo/src/lib/server/services/some-integration.service.test.ts';
const INTEGRATION_TEST_FILE =
    '/repo/src/lib/server/services/some-integration.service.integration.test.ts';

ruleTester.run('no-bare-fetch-in-server', rule, {
    valid: [
        // ── the prescribed replacement ──
        {
            code: `import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';\nfetchWithTimeout(url, {});`,
            filename: SERVICE,
        },
        // ── the guard modules themselves must call the real global fetch ──
        {
            code: `async function fetchWithTimeout(url) { return fetch(url, { redirect: 'manual' }); }`,
            filename: FETCH_UTILS,
        },
        {
            code: `async function fetchWithTimeout(url) { return fetch(url, { redirect: 'manual' }); }`,
            filename: FETCH_TIMEOUT,
        },
        {
            code: `async function safeFetch(url) { return fetch(url, { redirect: 'manual' }); }`,
            filename: URL_SAFETY,
        },
        // ── test files are out of scope for this rule entirely ──
        {
            code: `fetch(url, {});`,
            filename: TEST_FILE,
        },
        {
            code: `fetch(url, {});`,
            filename: INTEGRATION_TEST_FILE,
        },
        // ── the real false-positive trap: a `fetch` PARAMETER, not the global ──
        {
            code: `
                export async function fetchExactWatchingCandidates(
                    fetch,
                    targetSize,
                ) {
                    const buckets = await fetch(targetSize);
                    return buckets;
                }
            `,
            filename: SERVICE,
        },
        // ── a MemberExpression callee is never the global, however it's spelled ──
        {
            code: `ctx.dep('tmdb').fetch(url, {});`,
            filename: SERVICE,
        },
        {
            code: `strategy.fetch(ctx, opts);`,
            filename: SERVICE,
        },
        // ── an interface/method signature named fetch is not a call at all ──
        {
            code: `interface RecommenderStrategy { fetch(ctx: unknown, opts: unknown): Promise<unknown>; }`,
            filename: SERVICE,
        },
        // ── a local const named fetch (however unlikely) also shadows the global ──
        {
            code: `const fetch = makeMyOwnFetch();\nfetch(url);`,
            filename: SERVICE,
        },
    ],

    invalid: [
        // ── the exact defect shape: a credentialed bare fetch() in a service ──
        {
            code: `const res = await fetch(\`\${config.SOME_ADMIN_URL}/status\`, { headers: { 'X-Api-Key': key } });`,
            filename: SERVICE,
            errors: [{ messageId: 'bareFetch' }],
        },
        // ── no options object at all — still the global, still flagged ──
        {
            code: `const res = await fetch(url);`,
            filename: SERVICE,
            errors: [{ messageId: 'bareFetch' }],
        },
        // ── a path that merely CONTAINS "fetch-utils" as a substring is not the module ──
        {
            code: `fetch(url, {});`,
            filename: '/repo/src/lib/server/services/my-fetch-utils-wrapper.service.ts',
            errors: [{ messageId: 'bareFetch' }],
        },
    ],
});
