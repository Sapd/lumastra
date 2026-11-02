// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Explicit identities for route-sweep specs.
 *
 * Identity is intentionally opt-in per imported test, matching the ordinary
 * e2e auth fixture. This prevents a write from accidentally inheriting admin
 * rights merely because it was added to a test file with shared defaults.
 */
import { test as base, expect } from '@playwright/test';
import type { BrowserContextOptions } from 'playwright-core';
import type * as PlaywrightCore from 'playwright-core';
import { sweepBrowserOrigin } from './browser-origin';

export type SweepPrincipal = 'admin' | 'nonAdmin' | 'anonymous';
export type SweepIdentityMode = 'forward-auth' | 'native-session';

type SweepPlaywright = typeof PlaywrightCore;
type SweepStorageState = Exclude<BrowserContextOptions['storageState'], undefined>;
type SweepWorkerFixtures = { sweepStorageState: SweepStorageState };

const IDENTITY_MODE = readIdentityMode();
const BASE_URL = readRequiredEnvironment('SWEEP_BASE_URL');
/** Where Node request contexts go. A browser project's baseURL may be a mapped host name. */
export const SWEEP_API_BASE_URL = BASE_URL;
const BROWSER_MAPPED = sweepBrowserOrigin(BASE_URL, process.env.SWEEP_CSRF_ORIGIN).mapped;

const ADMIN_USERNAME = readUsername('SWEEP_ADMIN_USERNAME', 'sweep-admin');
const NON_ADMIN_USERNAME = readUsername('SWEEP_NON_ADMIN_USERNAME', 'sweep-non-admin');
const ADMIN_GROUPS = readGroups('SWEEP_ADMIN_GROUPS', 'Users|admin');
const NON_ADMIN_GROUPS = readGroups('SWEEP_NON_ADMIN_GROUPS', 'Users');

const ADMIN_PASSWORD = process.env.SWEEP_ADMIN_PASSWORD;
const NON_ADMIN_PASSWORD = process.env.SWEEP_NON_ADMIN_PASSWORD;

/*
 * The header NAMES are deployment configuration, not a convention.
 *
 * The app reads whatever `USERHEADER` / `GROUPHEADER` name the deployment sets.
 * CI and local dev use X-Forwarded-*, but preprod is fronted by authentik and
 * sets `USERHEADER=x-authentik-username`, `GROUPHEADER=X-authentik-groups`.
 * Hardcoding X-Forwarded-* would send preprod two headers it ignores, and every
 * request would arrive unauthenticated while the sweep believed it was admin.
 */
const USER_HEADER = process.env.SWEEP_USER_HEADER?.trim() || 'X-Forwarded-User';
const GROUP_HEADER = process.env.SWEEP_GROUP_HEADER?.trim() || 'X-Forwarded-Groups';

/** Forward-auth headers matching the identity proxy's pipe-separated format. */
export const ADMIN_FORWARD_AUTH_HEADERS: Record<string, string> = {
    [USER_HEADER]: ADMIN_USERNAME,
    [GROUP_HEADER]: ADMIN_GROUPS,
};

export const NON_ADMIN_FORWARD_AUTH_HEADERS: Record<string, string> = {
    [USER_HEADER]: NON_ADMIN_USERNAME,
    [GROUP_HEADER]: NON_ADMIN_GROUPS,
};

/**
 * Blank forward-auth headers are not anonymous: internal `/api/*` resolves
 * them to DEFAULT_USER with ADMIN_GROUPS. Therefore anonymous is only a
 * meaningful assertion on `/api/v1`, where bearer auth is evaluated.
 */
export const ANONYMOUS_FORWARD_AUTH_HEADERS: Record<string, string> = {};

function readIdentityMode(): SweepIdentityMode {
    const mode = process.env.SWEEP_IDENTITY_MODE;
    if (mode === 'forward-auth' || mode === 'native-session') return mode;
    throw new Error(
        'SWEEP_IDENTITY_MODE is required and must be either "forward-auth" or "native-session".',
    );
}

function readRequiredEnvironment(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required for the route sweep.`);
    return value;
}

function readUsername(name: string, fallback: string): string {
    // Native auth and forward-auth normalize usernames differently in older
    // paths; using one lowercase spelling avoids asserting against a second row.
    return (process.env[name]?.trim() || fallback).toLowerCase();
}

function readGroups(name: string, fallback: string): string {
    const groups = (process.env[name]?.trim() || fallback)
        .split('|')
        .map((group) => group.trim())
        .filter((group) => group.length > 0);
    if (groups.length === 0) throw new Error(`${name} must contain at least one group.`);
    return groups.join('|');
}

/*
 * Which group confers admin is ALSO deployment configuration.
 *
 * This was hardcoded to the literal 'admin', which is right for CI and wrong for
 * any deployment with e.g. `ADMIN_GROUPS=Librarians`. The consequences ran in both
 * directions and the dangerous one is silent: the admin principal would not have
 * been admin (loud, easy to spot), while the "non-admin" principal carrying
 * Librarians would have passed the not-an-admin check and then been served as a
 * FULL ADMIN — so every negative-auth assertion in Tier C would have passed
 * while proving nothing at all.
 *
 * Read it from the target's own ADMIN_GROUPS, e.g.
 * `docker exec <app-container> env | grep ADMIN_GROUPS`.
 */
const ADMIN_GROUP = process.env.SWEEP_ADMIN_GROUP?.trim() || 'admin';

function assertIdentityConfiguration(principal: SweepPrincipal): void {
    const isAdminGroup = (group: string): boolean =>
        group.toLowerCase() === ADMIN_GROUP.toLowerCase();

    if (principal === 'admin' && !ADMIN_GROUPS.split('|').some(isAdminGroup)) {
        throw new Error(
            `SWEEP_ADMIN_GROUPS must include the target's admin group ("${ADMIN_GROUP}"). ` +
                "Set SWEEP_ADMIN_GROUP to match the target deployment's ADMIN_GROUPS.",
        );
    }
    if (principal === 'nonAdmin' && NON_ADMIN_GROUPS.split('|').some(isAdminGroup)) {
        throw new Error(
            `SWEEP_NON_ADMIN_GROUPS must not include the admin group ("${ADMIN_GROUP}").`,
        );
    }
    if (IDENTITY_MODE === 'native-session' && BROWSER_MAPPED) {
        // The session cookie is issued for SWEEP_BASE_URL's host; a browser
        // running under the mapped host name would never send it.
        throw new Error(
            'native-session sweeps cannot use a mapped browser host: unset SWEEP_CSRF_ORIGIN or ' +
                'point SWEEP_BASE_URL at the host the app is configured for.',
        );
    }
    if (IDENTITY_MODE === 'native-session' && principal !== 'anonymous') {
        const password = principal === 'admin' ? ADMIN_PASSWORD : NON_ADMIN_PASSWORD;
        if (!password) {
            const variable =
                principal === 'admin' ? 'SWEEP_ADMIN_PASSWORD' : 'SWEEP_NON_ADMIN_PASSWORD';
            throw new Error(`${variable} is required for native-session route sweeps.`);
        }
    }
}

async function nativeSessionState(
    playwright: SweepPlaywright,
    principal: Exclude<SweepPrincipal, 'anonymous'>,
): Promise<SweepStorageState> {
    const username = principal === 'admin' ? ADMIN_USERNAME : NON_ADMIN_USERNAME;
    const password = principal === 'admin' ? ADMIN_PASSWORD : NON_ADMIN_PASSWORD;
    if (!password) throw new Error(`No password configured for native ${principal} identity.`);

    const context = await playwright.request.newContext({ baseURL: BASE_URL });
    try {
        const response = await context.post('/api/auth/native/login', {
            data: { username, password, redirect: '/' },
        });
        if (!response.ok()) {
            throw new Error(
                `Native ${principal} login failed with HTTP ${response.status()} at ${BASE_URL}.`,
            );
        }
        const state = await context.storageState();
        if (!state.cookies.some((cookie) => cookie.name === 'lumastra_session')) {
            throw new Error(
                `Native ${principal} login returned no lumastra_session cookie; refusing a false-green sweep.`,
            );
        }
        return state;
    } finally {
        await context.dispose();
    }
}

function createPrincipalTest(principal: SweepPrincipal) {
    assertIdentityConfiguration(principal);

    return base.extend<Record<never, never>, SweepWorkerFixtures>({
        // Playwright PARSES this parameter list to discover fixture dependencies,
        // so the first argument must be a destructuring pattern even when nothing
        // is destructured. Renaming it to `_options` satisfies ESLint's
        // no-empty-pattern rule and then throws at collection time
        // ("First argument must use the object destructuring pattern"), taking
        // every spec in the project down to 0 tests. Keep the empty pattern.
        // eslint-disable-next-line no-empty-pattern
        extraHTTPHeaders: async ({}, use): Promise<void> => {
            const headers =
                IDENTITY_MODE === 'forward-auth'
                    ? principal === 'admin'
                        ? ADMIN_FORWARD_AUTH_HEADERS
                        : principal === 'nonAdmin'
                          ? NON_ADMIN_FORWARD_AUTH_HEADERS
                          : ANONYMOUS_FORWARD_AUTH_HEADERS
                    : {};
            await use(headers);
        },
        sweepStorageState: [
            async ({ playwright }, use): Promise<void> => {
                if (IDENTITY_MODE === 'native-session' && principal !== 'anonymous') {
                    // Worker scope logs in once per principal per worker, rather
                    // than churning the target's session table once per test.
                    await use(await nativeSessionState(playwright, principal));
                    return;
                }
                // Anonymous must start without a cookie; forward-auth principals
                // do not use storage state, so an empty state is safest in either mode.
                await use({ cookies: [], origins: [] });
            },
            { scope: 'worker' },
        ],
        storageState: async ({ sweepStorageState }, use): Promise<void> => {
            await use(sweepStorageState);
        },
        // In a browser project the baseURL may be the target's mapped host name,
        // which only Chromium resolves to the tunnel. The `request` fixture runs
        // in Node, so there it must keep SWEEP_BASE_URL. Unchanged everywhere the
        // two agree (every API project).
        request: async (
            { request, baseURL, playwright, extraHTTPHeaders, storageState },
            use,
        ): Promise<void> => {
            if (baseURL === BASE_URL) {
                await use(request);
                return;
            }
            const context = await playwright.request.newContext({
                baseURL: BASE_URL,
                extraHTTPHeaders,
                storageState,
            });
            try {
                await use(context);
            } finally {
                await context.dispose();
            }
        },
    });
}

export const adminTest = createPrincipalTest('admin');
export const nonAdminTest = createPrincipalTest('nonAdmin');
export const anonymousTest = createPrincipalTest('anonymous');

export { expect };
