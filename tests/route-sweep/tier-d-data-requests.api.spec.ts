// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tier D route sweep: a page's access gate must hold for SvelteKit's client
 * data requests, not only for document navigations.
 *
 * `GET <page>/__data.json?x-sveltekit-invalidated=<mask>` runs only the load
 * functions whose bit in the mask is `1`; a `0` (or a missing bit) makes
 * SvelteKit answer `{"type":"skip"}` for that node WITHOUT calling its load.
 * A gate that lives in a layout load is therefore skippable: until 6f7f5a4f93
 * `/admin/settings/__data.json?x-sveltekit-invalidated=0011111` served the
 * full admin config to any signed-in user while a plain GET of the same page
 * redirected (Tier C's admin-page check passed throughout).
 *
 * For every page in the inventory and every principal the page should deny,
 * this tier sends the data request with no mask and with each single-node
 * mask (`1`, `01`, `001`, …), so each load runs once on its own. A denied
 * principal must never receive load data from a node below the root layout
 * (which answers everyone by design). Allowed principals
 * only have to avoid a 5xx.
 */
import { readFileSync } from 'node:fs';
import { test, type APIRequestContext } from '@playwright/test';
import {
    ADMIN_FORWARD_AUTH_HEADERS,
    adminTest,
    anonymousTest,
    expect,
    nonAdminTest,
} from './identity';
import {
    resolveParamFixtures,
    type ParamFixtureInventory,
    type ResolvedParamFixtures,
} from './param-fixtures';

type Gate = 'admin' | 'user' | 'public';
type Principal = 'admin' | 'nonAdmin' | 'anonymous';

interface InventoryPage {
    routeId: string;
    url: string;
    params: Array<{ raw: string; name: string; kind: 'required' | 'optional' }>;
    inPublicBuild: boolean;
    gate: Gate;
    hasPageServer: boolean;
}

interface Inventory {
    pages: InventoryPage[];
    paramFixtures: ParamFixtureInventory;
}

/** No route in the tree is nested deeper than this many layouts + page. */
const MAX_NODES = 8;
const MASKS: Array<string | null> = [
    null,
    ...Array.from({ length: MAX_NODES }, (_, i) => `${'0'.repeat(i)}1`),
];
const PLACEHOLDER = 'sweep-missing';

const inventory = JSON.parse(
    readFileSync(new URL('./inventory.generated.json', import.meta.url), 'utf8'),
) as Inventory;
const build = process.env.SWEEP_BUILD === 'public' ? 'public' : 'full';
const pages = inventory.pages.filter((page) => build === 'full' || page.inPublicBuild);

function denies(gate: Gate, principal: Principal): boolean {
    if (gate === 'admin') return principal !== 'admin';
    if (gate === 'user') return principal === 'anonymous';
    return false;
}

let fixtures: Promise<ResolvedParamFixtures> | undefined;

/** Ids are resolved as the admin (who can list everything), once per worker. */
function adminFixtures(adminRequest: APIRequestContext): Promise<ResolvedParamFixtures> {
    // A failed discovery must not be cached for the rest of the worker.
    fixtures ??= resolveParamFixtures(adminRequest, inventory.paramFixtures).catch((err) => {
        fixtures = undefined;
        throw err;
    });
    return fixtures;
}

function concreteUrl(page: InventoryPage, resolved: ResolvedParamFixtures): string {
    let url = page.url;
    for (const param of page.params) {
        const value =
            param.name === 'libraryType'
                ? resolved.libraryTypes[0]
                : resolved.routes[page.routeId]?.[param.name]?.valid;
        if (param.kind === 'optional') {
            url = url.replace(`/${param.raw}`, '');
            continue;
        }
        // An unresolved id still exercises the gate: a denied principal must be
        // turned away before the load looks the id up.
        url = url.replace(param.raw, encodeURIComponent(value ?? PLACEHOLDER));
    }
    return url;
}

function dataUrl(url: string, mask: string | null): string {
    const path = url === '/' ? '/__data.json' : `${url.replace(/\/$/, '')}/__data.json`;
    return mask === null ? path : `${path}?x-sveltekit-invalidated=${mask}`;
}

/** The node types SvelteKit sent back, or null when the body is not a data response. */
function dataNodeTypes(body: string): string[] | null {
    // A streamed response is newline-delimited; the first line is the envelope.
    const first = body.split('\n', 1)[0] ?? '';
    try {
        const parsed = JSON.parse(first) as { type?: string; nodes?: Array<{ type?: string }> };
        if (parsed.type !== 'data') return null;
        return (parsed.nodes ?? []).map((node) => node?.type ?? 'null');
    } catch {
        return null;
    }
}

async function sweepPage(
    page: InventoryPage,
    principal: Principal,
    request: APIRequestContext,
    resolved: ResolvedParamFixtures,
): Promise<void> {
    const url = concreteUrl(page, resolved);
    const denied = denies(page.gate, principal);
    const serverErrors: string[] = [];
    const leaks: string[] = [];
    let sawLoadData = false;
    let sawRedirect = false;
    for (const mask of MASKS) {
        const target = dataUrl(url, mask);
        const response = await request.get(target, { maxRedirects: 0 });
        const body = await response.text();
        if (response.status() >= 500) serverErrors.push(`${response.status()} ${target}`);
        // Node 0 is the root layout. It answers every principal by design
        // (anonymous visitors get its trimmed payload), so only the nodes below
        // it carry the page's gated data.
        const nodes = dataNodeTypes(body);
        const belowRootData = nodes?.slice(1).some((type) => type === 'data') ?? false;
        sawLoadData ||= belowRootData;
        sawRedirect ||= response.status() >= 300 && response.status() < 400;
        sawRedirect ||= body.startsWith('{"type":"redirect"');
        if (denied && belowRootData) leaks.push(`${target} nodes=${JSON.stringify(nodes)}`);
    }
    expect(serverErrors, `${principal}: server errors`).toEqual([]);
    expect(leaks, `${principal} (page gate ${page.gate}) received load data`).toEqual([]);

    // Positive control: the admin must actually reach a server load of a
    // param-free page through these URLs. Without it a wrong data-URL scheme
    // (every request a 404) would read as "nobody leaked anything".
    // A page that is switched off on this target (a feature flag answering 404
    // to the document request too) is not a scheme failure.
    if (principal === 'admin' && page.hasPageServer && page.params.length === 0 && !sawRedirect) {
        if (!sawLoadData) {
            const documentStatus = (await request.get(url, { maxRedirects: 0 })).status();
            if (documentStatus === 404) {
                test.info().annotations.push({
                    type: 'BLOCKED',
                    description: `${url} answers 404 on this target (feature off)`,
                });
                return;
            }
        }
        expect(sawLoadData, `admin got no load data from any data request for ${url}`).toBe(true);
    }
}

const PRINCIPAL_TESTS = [
    ['admin', adminTest],
    ['nonAdmin', nonAdminTest],
    ['anonymous', anonymousTest],
] as const;

for (const [principal, principalTest] of PRINCIPAL_TESTS) {
    principalTest.describe(`Tier D: page data requests as ${principal}`, () => {
        for (const page of pages) {
            principalTest(`${page.gate} ${page.url}`, async ({ request, playwright }) => {
                // Fixture discovery needs admin visibility regardless of who is
                // being swept, so it gets its own admin context.
                const admin = await playwright.request.newContext({
                    baseURL: process.env.SWEEP_BASE_URL,
                    extraHTTPHeaders:
                        process.env.SWEEP_IDENTITY_MODE === 'forward-auth'
                            ? ADMIN_FORWARD_AUTH_HEADERS
                            : {},
                });
                try {
                    const resolved = await adminFixtures(admin);
                    await sweepPage(page, principal, request, resolved);
                } finally {
                    await admin.dispose();
                }
            });
        }
    });
}
