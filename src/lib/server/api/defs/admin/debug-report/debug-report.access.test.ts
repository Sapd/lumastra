// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The debug report defs: access and response contract (spec 2026-10-21 §6, §7).
 *
 * Drives the REAL auth gate (`{kind:'scope', anyOf:['diagnostics:read']}` through
 * mount) and the handler's `diagnosticsAccessDenial()` with real principals. Only
 * the data builder and the rate limiter are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { DebugReportConfigurationError } from '$lib/server/debug-report/errors.js';
import { buildPrincipal } from '$lib/server/api/principal.js';

const mocks = vi.hoisted(() => ({
    buildDebugReport: vi.fn(),
    buildRunDetail: vi.fn(),
    buildClientDiagnosticGroup: vi.fn(),
    buildClusterNodeDetail: vi.fn(),
    buildHealthDetail: vi.fn(),
    checkRateLimit: vi.fn(),
}));

vi.mock('$lib/server/database/connection.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/database/connection.js')>();
    return { ...actual, getAdminDb: () => ({}) };
});
vi.mock('$lib/server/middleware/valkey-rate-limit.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/middleware/valkey-rate-limit.js')>();
    return { ...actual, checkRateLimit: (...args: unknown[]) => mocks.checkRateLimit(...args) };
});
vi.mock('$lib/server/debug-report/build.js', () => ({
    buildDebugReport: (...args: unknown[]) => mocks.buildDebugReport(...args),
    buildRunDetail: (...args: unknown[]) => mocks.buildRunDetail(...args),
    buildClientDiagnosticGroup: (...args: unknown[]) => mocks.buildClientDiagnosticGroup(...args),
    buildClusterNodeDetail: (...args: unknown[]) => mocks.buildClusterNodeDetail(...args),
    buildHealthDetail: (...args: unknown[]) => mocks.buildHealthDetail(...args),
}));

import { def as reportDef } from './index.js';
import { def as healthDef } from './health.js';
import { def as runDef } from './runs/[runId].js';
import { def as groupDef } from './client-diagnostics/[fingerprint].js';
import { def as nodeDef } from './cluster/nodes/[instanceId].js';

const REPORT_PATH = '/api/v1/admin/debug-report';
const RUN_ID = '11111111-2222-4333-8444-555555555555';
const FINGERPRINT = '0123456789abcdef0123456789abcdef';
const NODE_ID = 'web-abcdef12-3456';

const COUNTS = {
    secret: 0,
    token: 0,
    url: 0,
    host: 0,
    ip: 0,
    email: 0,
    path: 0,
    file: 0,
    opaque: 0,
    sweep: 0,
};

const REPORT = {
    schemaVersion: 1 as const,
    generatedAt: '2026-10-21T10:00:00.000Z',
    redaction: {
        options: { includeHostnames: false, includePaths: false },
        counts: COUNTS,
        secretSweepHits: 0,
        notes: ['Secrets are removed.'],
    },
    links: {
        self: REPORT_PATH,
        markdown: `${REPORT_PATH}?format=md`,
        health: `${REPORT_PATH}/health`,
        run: `${REPORT_PATH}/runs/{runId}`,
        clientDiagnosticGroup: `${REPORT_PATH}/client-diagnostics/{fingerprint}`,
        clusterNode: `${REPORT_PATH}/cluster/nodes/{instanceId}`,
        llmsTxt: '/llms.txt',
        apiDocs: '/api-docs?format=md',
    },
    instance: { status: 'ok' as const, version: '0.1.0' },
    health: { status: 'ok' as const, href: `${REPORT_PATH}/health` },
    cluster: { status: 'ok' as const, nodes: [], sidecars: [] },
    tasks: { status: 'ok' as const, failedRuns: [], lastScans: [], pluginFailures: [] },
    library: { status: 'ok' as const },
    serverErrors: { status: 'unavailable' as const, note: 'Read the container log.' },
    clientDiagnostics: { status: 'ok' as const, windowHours: 24, groups: [] },
    settings: { status: 'ok' as const, entries: [] },
    integrations: { status: 'ok' as const, items: [] },
};

const HEALTH = { status: 'ok' as const, href: `${REPORT_PATH}/health` };
const RUN = { run: { id: RUN_ID, taskId: 'sonic', state: 'failed' }, logs: [], pasteSafe: false };
const GROUP = { fingerprint: FINGERPRINT, windowHours: 24, items: [], pasteSafe: false };
const NODE = {
    name: 'web-web-abcd',
    instanceId: NODE_ID,
    role: 'web',
    live: false,
    restarts24h: 0,
    uncleanExits24h: 0,
    events: [],
};

function makeEvent(path: string, principal: unknown): RequestEvent {
    const url = new URL(`http://localhost${path}`);
    return {
        url,
        params: {},
        route: { id: REPORT_PATH as never },
        request: new Request(url.toString()),
        locals: { principal },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

function eventWithParams(
    path: string,
    principal: unknown,
    params: Record<string, string | undefined>,
): RequestEvent {
    const event = makeEvent(path, principal);
    return { ...event, params } as unknown as RequestEvent;
}

function session(isAdmin: boolean) {
    return buildPrincipal({
        kind: 'forward_auth',
        userId: (isAdmin ? 'usr_admin' : 'usr_1') as never,
        username: isAdmin ? 'root' : 'alice',
        userGroups: [],
        sessionIsAdmin: isAdmin,
    });
}

/** A `diagnostics:read` service token; `ownerIsAdmin` is the owner verdict at request time. */
function grantToken(ownerIsAdmin: boolean) {
    return buildPrincipal({
        kind: 'service_token',
        userId: 'usr_owner' as never,
        username: 'svc-debug',
        userGroups: [],
        credentialId: 'credential-9',
        tokenScopes: ['diagnostics:read'],
        ownerIsAdmin: false,
        tokenOwnerIsAdmin: ownerIsAdmin,
    });
}

function readPat() {
    return buildPrincipal({
        kind: 'pat',
        userId: 'usr_1' as never,
        username: 'alice',
        userGroups: [],
        tokenScopes: ['read'],
        ownerIsAdmin: true,
    });
}

const { GET: reportGet } = mount(reportDef, { surface: 'v1' });
const { GET: healthGet } = mount(healthDef, { surface: 'v1' });
const { GET: runGet } = mount(runDef, { surface: 'v1' });
const { GET: groupGet } = mount(groupDef, { surface: 'v1' });
const { GET: nodeGet } = mount(nodeDef, { surface: 'v1' });

beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 1, resetAt: 0, total: 1 });
    mocks.buildDebugReport.mockResolvedValue(REPORT);
    mocks.buildHealthDetail.mockResolvedValue(HEALTH);
    mocks.buildRunDetail.mockResolvedValue(RUN);
    mocks.buildClientDiagnosticGroup.mockResolvedValue(GROUP);
    mocks.buildClusterNodeDetail.mockResolvedValue(NODE);
});

describe('GET /api/v1/admin/debug-report: who may read it', () => {
    it('serves an administrator session, uncached', async () => {
        const res = await reportGet!(makeEvent(REPORT_PATH, session(true)));
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('content-type')).toContain('application/json');
        expect(mocks.buildDebugReport).toHaveBeenCalledTimes(1);
    });

    it('serves a diagnostics:read token whose owner is still an administrator', async () => {
        const res = await reportGet!(makeEvent(REPORT_PATH, grantToken(true)));
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('403s a diagnostics:read token whose owner is no longer an administrator', async () => {
        const res = await reportGet!(makeEvent(REPORT_PATH, grantToken(false)));
        expect(res.status).toBe(403);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(mocks.buildDebugReport).not.toHaveBeenCalled();
    });

    it('403s a plain non-admin session', async () => {
        const res = await reportGet!(makeEvent(REPORT_PATH, session(false)));
        expect(res.status).toBe(403);
        expect(mocks.buildDebugReport).not.toHaveBeenCalled();
    });

    it('403s a read PAT', async () => {
        const res = await reportGet!(makeEvent(REPORT_PATH, readPat()));
        expect(res.status).toBe(403);
        expect(mocks.buildDebugReport).not.toHaveBeenCalled();
    });

    it('403s a grant token that asks for an include toggle', async () => {
        const res = await reportGet!(
            makeEvent(`${REPORT_PATH}?include=hostnames`, grantToken(true)),
        );
        expect(res.status).toBe(403);
        expect(mocks.buildDebugReport).not.toHaveBeenCalled();
    });

    it('lets an administrator ask for an include toggle', async () => {
        const res = await reportGet!(
            makeEvent(`${REPORT_PATH}?include=hostnames,paths`, session(true)),
        );
        expect(res.status).toBe(200);
        expect(mocks.buildDebugReport).toHaveBeenCalledWith(expect.anything(), {
            options: { includeHostnames: true, includePaths: true },
        });
    });
});

describe('GET /api/v1/admin/debug-report: query and format', () => {
    it('returns Markdown with format=md', async () => {
        const res = await reportGet!(makeEvent(`${REPORT_PATH}?format=md`, session(true)));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.text()).toContain('# Lumastra debug report');
    });

    it.each([['?include=emails'], ['?include=paths,paths']])(
        'rejects an invalid include (%s) as validation_failed',
        async (query) => {
            const res = await reportGet!(makeEvent(`${REPORT_PATH}${query}`, session(true)));
            expect(res.status).toBe(422);
            expect(await res.text()).toContain('validation_failed');
            expect(mocks.buildDebugReport).not.toHaveBeenCalled();
        },
    );
});

describe('drill-downs: same gate, no include', () => {
    it('serves a grant token whose owner is an administrator on every drill-down', async () => {
        const token = grantToken(true);
        const health = await healthGet!(makeEvent(`${REPORT_PATH}/health`, token));
        expect(health.status).toBe(200);
        expect(health.headers.get('cache-control')).toBe('no-store');

        const run = await runGet!(
            eventWithParams(`${REPORT_PATH}/runs/${RUN_ID}`, token, { runId: RUN_ID }),
        );
        expect(run.status).toBe(200);

        const group = await groupGet!(
            eventWithParams(`${REPORT_PATH}/client-diagnostics/${FINGERPRINT}`, token, {
                fingerprint: FINGERPRINT,
            }),
        );
        expect(group.status).toBe(200);

        const node = await nodeGet!(
            eventWithParams(`${REPORT_PATH}/cluster/nodes/${NODE_ID}`, token, {
                instanceId: NODE_ID,
            }),
        );
        expect(node.status).toBe(200);
    });

    it('403s a grant token whose owner is no longer an administrator, on every drill-down', async () => {
        const token = grantToken(false);
        expect((await healthGet!(makeEvent(`${REPORT_PATH}/health`, token)))?.status).toBe(403);
        expect(
            (
                await runGet!(
                    eventWithParams(`${REPORT_PATH}/runs/${RUN_ID}`, token, { runId: RUN_ID }),
                )
            ).status,
        ).toBe(403);
        expect(mocks.buildRunDetail).not.toHaveBeenCalled();
    });

    it('404s an unknown run and an unknown node', async () => {
        mocks.buildRunDetail.mockResolvedValueOnce(null);
        const run = await runGet!(
            eventWithParams(`${REPORT_PATH}/runs/${RUN_ID}`, session(true), { runId: RUN_ID }),
        );
        expect(run.status).toBe(404);
        expect(run.headers.get('cache-control')).toBe('no-store');

        mocks.buildClusterNodeDetail.mockResolvedValueOnce(null);
        const node = await nodeGet!(
            eventWithParams(`${REPORT_PATH}/cluster/nodes/${NODE_ID}`, session(true), {
                instanceId: NODE_ID,
            }),
        );
        expect(node.status).toBe(404);
    });

    it('403s a non-admin session on the drill-downs', async () => {
        const res = await groupGet!(
            eventWithParams(`${REPORT_PATH}/client-diagnostics/${FINGERPRINT}`, session(false), {
                fingerprint: FINGERPRINT,
            }),
        );
        expect(res.status).toBe(403);
    });
});

describe('rate limits', () => {
    it('answers 429 when the report budget of the credential is spent', async () => {
        mocks.checkRateLimit.mockResolvedValueOnce({
            allowed: false,
            remaining: 0,
            resetAt: Math.floor(Date.now() / 1000) + 10,
            total: 1,
        });
        const res = await reportGet!(makeEvent(REPORT_PATH, session(true)));
        expect(res.status).toBe(429);
        expect(mocks.buildDebugReport).not.toHaveBeenCalled();
    });
});

describe('configuration fail-closed responses', () => {
    it.each([
        {
            name: 'report',
            get: reportGet!,
            builder: mocks.buildDebugReport,
            path: REPORT_PATH,
            params: {},
        },
        {
            name: 'health',
            get: healthGet!,
            builder: mocks.buildHealthDetail,
            path: `${REPORT_PATH}/health`,
            params: {},
        },
        {
            name: 'run',
            get: runGet!,
            builder: mocks.buildRunDetail,
            path: `${REPORT_PATH}/runs/${RUN_ID}`,
            params: { runId: RUN_ID },
        },
        {
            name: 'client group',
            get: groupGet!,
            builder: mocks.buildClientDiagnosticGroup,
            path: `${REPORT_PATH}/client-diagnostics/${FINGERPRINT}`,
            params: { fingerprint: FINGERPRINT },
        },
        {
            name: 'cluster node',
            get: nodeGet!,
            builder: mocks.buildClusterNodeDetail,
            path: `${REPORT_PATH}/cluster/nodes/${NODE_ID}`,
            params: { instanceId: NODE_ID },
        },
    ])('returns an uncached 503 for $name', async ({ get, builder, path, params }) => {
        builder.mockRejectedValueOnce(new DebugReportConfigurationError());
        const res = await get(eventWithParams(path, session(true), params));
        expect(res.status).toBe(503);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('content-type')).toContain('application/problem+json');
        expect(await res.text()).toContain('Configuration not loaded');
    });
});

describe('credential-specific rate limits', () => {
    it.each([
        {
            name: 'report',
            get: reportGet!,
            path: REPORT_PATH,
            params: {},
            endpoint: 'debug-report',
            window: 10,
        },
        {
            name: 'health',
            get: healthGet!,
            path: `${REPORT_PATH}/health`,
            params: {},
            endpoint: 'debug-report-health',
            window: 5,
        },
        {
            name: 'run',
            get: runGet!,
            path: `${REPORT_PATH}/runs/${RUN_ID}`,
            params: { runId: RUN_ID },
            endpoint: 'debug-report-run',
            window: 2,
        },
        {
            name: 'client group',
            get: groupGet!,
            path: `${REPORT_PATH}/client-diagnostics/${FINGERPRINT}`,
            params: { fingerprint: FINGERPRINT },
            endpoint: 'debug-report-client-group',
            window: 2,
        },
        {
            name: 'cluster node',
            get: nodeGet!,
            path: `${REPORT_PATH}/cluster/nodes/${NODE_ID}`,
            params: { instanceId: NODE_ID },
            endpoint: 'debug-report-cluster-node',
            window: 5,
        },
    ])(
        'charges $name against the expected credential key and window',
        async ({ get, path, params, endpoint, window }) => {
            const res = await get(eventWithParams(path, grantToken(true), params));
            expect(res.status).toBe(200);
            expect(mocks.checkRateLimit).toHaveBeenCalledExactlyOnceWith(
                `service_token:credential-9:${endpoint}`,
                1,
                window,
            );
        },
    );

    it('uses the session user id when there is no credential id', async () => {
        await reportGet!(makeEvent(REPORT_PATH, session(true)));
        expect(mocks.checkRateLimit).toHaveBeenCalledExactlyOnceWith(
            'forward_auth:usr_admin:debug-report',
            1,
            10,
        );
    });

    it('rejects an admin-scoped service token after its owner is demoted', async () => {
        const principal = buildPrincipal({
            kind: 'service_token',
            userId: 'owner' as never,
            username: 'svc-admin',
            userGroups: [],
            tokenScopes: ['admin'],
            ownerIsAdmin: false,
        });
        expect(principal.isAdmin).toBe(false);
        expect((await reportGet!(makeEvent(REPORT_PATH, principal))).status).toBe(403);
        expect(mocks.buildDebugReport).not.toHaveBeenCalled();
    });
});

describe('cookie mirror: index def mounted on the internal surface', () => {
    const { GET: internalGet } = mount(reportDef, { surface: 'internal' });

    it.each([true, false])('returns the admin-session verdict for admin=%s', async (isAdmin) => {
        const principal = buildPrincipal({
            kind: 'session',
            userId: 'cookie-user' as never,
            username: 'cookie-user',
            userGroups: [],
            sessionIsAdmin: isAdmin,
        });
        const res = await internalGet!(makeEvent('/api/admin/debug-report', principal));
        expect(res.status).toBe(isAdmin ? 200 : 403);
        if (isAdmin) {
            expect(res.headers.get('cache-control')).toBe('no-store');
            expect(mocks.buildDebugReport).toHaveBeenCalledTimes(1);
        } else {
            expect(mocks.buildDebugReport).not.toHaveBeenCalled();
        }
    });
});
