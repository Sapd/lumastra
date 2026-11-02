// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Explicit forward-auth identity for e2e specs.
 *
 * The shared `use` block in playwright.config.ts deliberately no longer sets
 * forward-auth identity headers. A spec that imports `test` straight from
 * `@playwright/test` is therefore UNAUTHENTICATED: any write it attempts fails
 * closed (401) instead of silently succeeding with ambient admin rights.
 *
 * That holds only because playwright.config.ts sets LUMASTRA_DEV_NO_DEFAULT_USER
 * on the dev server: without it, `vite dev` turns a request with no identity
 * header into `DEFAULT_USER` with `ADMIN_GROUPS`, i.e. admin. global-setup.ts
 * checks that a header-less request gets 401.
 *
 * That default matters because the app trusts `USERHEADER`/`GROUPHEADER` on the
 * internal `/api/*` surface. Ambient headers therefore authorise writes regardless of any
 * `Authorization: Bearer` token on the request — a read-scope PAT attached to a
 * mutation would appear to "work" while its scope was never consulted, because
 * only `/api/v1/*` validates bearer tokens.
 *
 * Specs that genuinely need an identity opt in explicitly:
 *
 *     import { adminTest as test, expect } from './fixtures/auth';
 *
 * Per-request overrides still work: passing `'X-Forwarded-User': ''` and
 * `'X-Forwarded-Groups': ''` in a single request's `headers` blanks the identity
 * for that call only. That is how the PAT/service-token scope specs exercise
 * bearer-only auth while still using this fixture for their admin setup calls.
 */
import { test as base, expect, type Page } from '@playwright/test';

import { observeNetworkChanges } from '../helpers/network-changes';

const observedBrowserTest = base.extend({
    context: async ({ context }, use, info) => {
        // Specs opening sibling tabs use context.newPage(), so observing only
        // Playwright's default page leaves those tabs without transport recovery.
        const observed = new Set<Page>();
        const finishers: Array<() => Promise<void>> = [];
        const observe = (page: Page): void => {
            if (observed.has(page)) return;
            observed.add(page);
            finishers.push(observeNetworkChanges(page, info));
        };
        context.on('page', observe);
        for (const page of context.pages()) observe(page);
        try {
            await use(context);
        } finally {
            context.off('page', observe);
            await Promise.all(finishers.map((finish) => finish()));
        }
    },
});

/** Forward-auth headers matching the Authentik format the app expects. */
export const ADMIN_FORWARD_AUTH_HEADERS: Record<string, string> = {
    'X-Forwarded-User': process.env.TEST_USER || 'TestUser',
    // Pipe-separated, and includes an ADMIN_GROUPS member so admin API specs work.
    'X-Forwarded-Groups': process.env.TEST_GROUPS || 'Users|Librarians|admin',
};

/**
 * A `test` object carrying admin forward-auth identity on every request.
 * Overrides the built-in `extraHTTPHeaders` option.
 */
// No generic parameter here on purpose: adding one (even `Record<string, never>`)
// narrows the test-args type and breaks specs that call `test.use({ ... })` with
// other built-in options, e.g. tests/watch-together-sync.ui.spec.ts (launchOptions).
export const adminTest = observedBrowserTest.extend({
    extraHTTPHeaders: ADMIN_FORWARD_AUTH_HEADERS,
});

/**
 * `adminTest` that also sends a same-origin `Origin`, as a browser's fetch does
 * on a POST/DELETE.
 *
 * The CSRF guard (src/lib/server/middleware/csrf.ts) treats a request with no
 * body, no content type and no Origin as a form submission and refuses it 403
 * before routing. Under plain `adminTest` every body-less DELETE/POST therefore
 * proved nothing: a "non-admin is refused" assertion was met by the CSRF guard
 * instead of the authorization check, and the `DELETE /api/me/pats/{id}`
 * cleanups never landed, so the leaked PATs ran the test user into the
 * 10-active-token cap and every later spec that mints one skipped.
 *
 * A request that sets its own `Origin` (the CORS specs) still overrides this.
 */
export const sameOriginAdminTest = observedBrowserTest.extend({
    extraHTTPHeaders: async ({ baseURL }, use) => {
        await use({
            ...ADMIN_FORWARD_AUTH_HEADERS,
            ...(baseURL ? { Origin: new URL(baseURL).origin } : {}),
        });
    },
});

export { expect };
