// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `diagnostics:read` grant (debug report, spec 2026-10-21 §6): the built-in
 * path/method envelope and the handler-side access check. Mint rules are in
 * defs/service-tokens/index.mint-ceiling.test.ts; owner verdicts in
 * token-identity.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { buildPrincipal, type Principal } from '$lib/server/api/principal.js';
import {
    DEBUG_REPORT_PATH,
    DIAGNOSTICS_GRANT,
    diagnosticsAccessDenial,
    diagnosticsGrantPathDenial,
    isDiagnosticsGrantPath,
    isDiagnosticsGrantPrincipal,
} from './diagnostics-grant.js';

const REPORT = '/api/v1/admin/debug-report';

function serviceToken(scopes: string[], tokenOwnerIsAdmin?: boolean): Principal {
    return buildPrincipal({
        kind: 'service_token',
        userId: 'usr_owner' as never,
        username: 'service:debug-bot',
        userGroups: [],
        tokenScopes: scopes,
        ownerIsAdmin: tokenOwnerIsAdmin ?? false,
        tokenOwnerIsAdmin,
    });
}

function pat(scopes: string[], ownerIsAdmin: boolean): Principal {
    return buildPrincipal({
        kind: 'pat',
        userId: 'usr_owner' as never,
        username: 'leon',
        userGroups: [],
        tokenScopes: scopes,
        ownerIsAdmin,
    });
}

function session(isAdmin: boolean): Principal {
    return buildPrincipal({
        kind: 'forward_auth',
        userId: (isAdmin ? 'usr_admin' : 'usr_1') as never,
        username: isAdmin ? 'root' : 'alice',
        userGroups: [],
        sessionIsAdmin: isAdmin,
    });
}

describe('DEBUG_REPORT_PATH and the grant name', () => {
    it('names the report route and the grant', () => {
        expect(DEBUG_REPORT_PATH).toBe(REPORT);
        expect(DIAGNOSTICS_GRANT).toBe('diagnostics:read');
    });
});

describe('isDiagnosticsGrantPath', () => {
    it.each([
        REPORT,
        `${REPORT}/`,
        `${REPORT}/health`,
        `${REPORT}/runs/abc`,
        `${REPORT}/client-diagnostics/fp1`,
        `${REPORT}/cluster/nodes/n1`,
    ])('accepts %s', (path) => {
        expect(isDiagnosticsGrantPath(path)).toBe(true);
    });

    it.each([
        `${REPORT}/runs`,
        `${REPORT}/runs/a/b`,
        `${REPORT}/unknown/x`,
        `${REPORT}/..`,
        `${REPORT}/runs/..`,
        `${REPORT}/runs/.`,
        `${REPORT}-x`,
        '/api/v1/admin/users',
        '/api/admin/debug-report',
        '/de/api/v1/admin/debug-report',
        '/api/%76%31/admin/debug-report',
    ])('refuses %s', (path) => {
        expect(isDiagnosticsGrantPath(path)).toBe(false);
    });
});

describe('diagnosticsGrantPathDenial', () => {
    const TOKEN = [DIAGNOSTICS_GRANT];

    it.each([
        REPORT,
        `${REPORT}/`,
        `${REPORT}/health`,
        `${REPORT}/runs/abc`,
        `${REPORT}/client-diagnostics/fp1`,
        `${REPORT}/cluster/nodes/n1`,
    ])('GET and HEAD on %s are allowed', (path) => {
        expect(diagnosticsGrantPathDenial(TOKEN, path, 'GET')).toBeNull();
        expect(diagnosticsGrantPathDenial(TOKEN, path, 'HEAD')).toBeNull();
        expect(diagnosticsGrantPathDenial(TOKEN, path, 'get')).toBeNull();
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('%s on the report is 403', (method) => {
        expect(diagnosticsGrantPathDenial(TOKEN, REPORT, method)).toEqual({
            status: 403,
            error: 'Token not permitted on this endpoint',
        });
    });

    it.each([
        `${REPORT}-x`,
        `${REPORT}/runs`,
        `${REPORT}/runs/a/b`,
        `${REPORT}/unknown/x`,
        `${REPORT}/..`,
        '/api/v1/admin/users',
        '/api/admin/debug-report',
        '/de/api/v1/admin/debug-report',
        '/api/%76%31/admin/debug-report',
    ])('GET on %s is 403', (path) => {
        expect(diagnosticsGrantPathDenial(TOKEN, path, 'GET')?.status).toBe(403);
    });

    it('a token without the grant is never denied by this envelope', () => {
        expect(diagnosticsGrantPathDenial(['read'], '/api/v1/admin/users', 'POST')).toBeNull();
        expect(diagnosticsGrantPathDenial(['integrations:read'], REPORT, 'POST')).toBeNull();
    });
});

describe('isDiagnosticsGrantPrincipal', () => {
    it('is true only for a service token with the grant and an admin owner verdict', () => {
        expect(isDiagnosticsGrantPrincipal(serviceToken([DIAGNOSTICS_GRANT], true))).toBe(true);
        expect(isDiagnosticsGrantPrincipal(serviceToken([DIAGNOSTICS_GRANT], false))).toBe(false);
        expect(isDiagnosticsGrantPrincipal(serviceToken([DIAGNOSTICS_GRANT]))).toBe(false);
        expect(isDiagnosticsGrantPrincipal(pat([DIAGNOSTICS_GRANT], true))).toBe(false);
        expect(isDiagnosticsGrantPrincipal(undefined)).toBe(false);
    });
});

describe('diagnosticsAccessDenial', () => {
    it('lets an administrator session through', () => {
        expect(diagnosticsAccessDenial(session(true))).toBeNull();
    });

    it('lets a grant token whose owner is still an administrator through', () => {
        expect(diagnosticsAccessDenial(serviceToken([DIAGNOSTICS_GRANT], true))).toBeNull();
    });

    it('refuses a grant token whose owner is not an administrator (false or unknown)', () => {
        for (const verdict of [false, undefined]) {
            const res = diagnosticsAccessDenial(serviceToken([DIAGNOSTICS_GRANT], verdict));
            expect(res?.status).toBe(403);
        }
    });

    it('refuses a non-admin session', () => {
        expect(diagnosticsAccessDenial(session(false))?.status).toBe(403);
    });

    it('refuses a PAT that carries the grant name (a PAT is never a grant credential)', () => {
        expect(diagnosticsAccessDenial(pat([DIAGNOSTICS_GRANT], true))?.status).toBe(403);
    });

    it('refuses with no principal', () => {
        expect(diagnosticsAccessDenial(undefined)?.status).toBe(403);
    });
});
