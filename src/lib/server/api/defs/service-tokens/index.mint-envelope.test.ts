// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Mint-side envelope validation (fix-plan-5 Task 4, security review 5 §9
 * hardening item 3): `POST /api/v1/service-tokens`'s `CreateTokenBody` used
 * to declare `allowedPathPrefixes`/`allowedMethods` as free-form
 * `z.array(z.string())` — nothing on the server rejected `''`, a `..`
 * traversal segment, or a non-`/api/v1/` prefix (including a well-formed
 * `/api/admin/...` prefix) at create time. The only schema that DID enforce
 * these rules, `serviceTokenCreateBodySchema`, had no server importer (and
 * could not be imported, since it also defaulted `scopes` to `['admin']` —
 * the 2026-09-12 C3 defect) and has been deleted.
 *
 * This test drives a real invalid body through the actual production
 * entry point — `mount(def, {surface:'v1'})`'s request-validation step —
 * rather than calling `CreateTokenBody.safeParse()` in isolation, so a
 * regression that re-widens the schema OR stops wiring it into `mount()`
 * shows up here. The rejection is `validation_failed`, which this codebase's
 * problem+json taxonomy maps to HTTP 422 (`problem.ts`'s `STATUS_FOR_CODE`)
 * — not literally 400 — verified at HEAD before asserting on it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';
import { buildPrincipal } from '$lib/server/api/principal.js';

const mockCreate = vi.fn();
vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({
        create: (...args: unknown[]) => mockCreate(...args),
        listAll: vi.fn(),
    }),
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserById: vi.fn(),
    getUserIdByUsername: vi.fn(),
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/auth/resolve-owner-admin-status.js', () => ({
    resolveOwnerAdminStatus: vi.fn(),
}));
// Step 1 (enforce()) reads the RAW `config.FEATURE_DEVICE_AUTH` flag via
// mount.ts's isFeatureEnabled(), not the composed `features.deviceAuth`
// getter — both are stubbed true so this file's requests reach Step 2
// (request validation), the thing under test.
vi.mock('$lib/server/config.js', () => ({
    features: { deviceAuth: true },
    config: { FEATURE_DEVICE_AUTH: true },
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

import { def } from './index.js';
import { mount } from '$lib/server/api/mount.js';

const USER_ID = toUserId('00000000-0000-0000-0000-0000000000aa');

// `tokens:admin` alone lets the caller mint tokens, but `denyUnlessMayMint()`
// also requires the caller to itself HOLD every scope being minted (fix
// round 1 discovered this by tightening the control-case assertion, Minor
// f) — every test below mints `scopes: ['read']`, so the caller needs
// `read` too, not just the minting-ceiling scope.
const tokensAdmin = buildPrincipal({
    kind: 'pat',
    userId: USER_ID,
    username: 'ops',
    userGroups: [],
    tokenScopes: ['tokens:admin', 'read'],
    // Owner currently admin — otherwise buildPrincipal() strips 'tokens:admin'
    // (2026-10-02, stripsAdminScopesForToken()). Still not `isAdmin`:
    // deriveIsAdmin() needs the literal 'admin'/'tasks:admin' scope.
    ownerIsAdmin: true,
});

function makeEvent(body: unknown): RequestEvent {
    const url = new URL('http://localhost/api/v1/service-tokens');
    const request = new Request(url, {
        method: 'POST',
        headers: { authorization: 'Bearer irrelevant', 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return {
        request,
        url,
        params: {},
        route: { id: null },
        locals: { principal: tokensAdmin, user: undefined },
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: vi.fn(),
            delete: vi.fn(),
            serialize: vi.fn(),
        },
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const { POST } = mount(def, { surface: 'v1' });

describe('POST /service-tokens: mint-side envelope validation (fix-plan-5 Task 4)', () => {
    beforeEach(() => {
        // `create()` returns the `service_tokens` serial as a NUMBER, and
        // `CreateServiceTokenResponseSchema` declares it as one.
        mockCreate.mockReset().mockResolvedValue({ id: 1, token: 'svc_deadbeef' });
    });

    it('rejects an empty-string allowedPathPrefixes entry', async () => {
        const response = await POST!(
            makeEvent({ name: 'svc', scopes: ['read'], allowedPathPrefixes: [''] }),
        );
        expect(response.status).toBe(422);
        const bodyJson = (await response.json()) as { code?: string };
        expect(bodyJson.code).toBe('validation_failed');
    });

    it('rejects a /api/admin/* prefix', async () => {
        const response = await POST!(
            makeEvent({ name: 'svc', scopes: ['read'], allowedPathPrefixes: ['/api/admin/x'] }),
        );
        expect(response.status).toBe(422);
        const bodyJson = (await response.json()) as { code?: string };
        expect(bodyJson.code).toBe('validation_failed');
    });

    it('rejects a ".." traversal segment', async () => {
        const response = await POST!(
            makeEvent({ name: 'svc', scopes: ['read'], allowedPathPrefixes: ['/api/v1/../etc'] }),
        );
        expect(response.status).toBe(422);
    });

    it('accepts a well-formed /api/v1/ prefix (control — must not over-reject)', async () => {
        const response = await POST!(
            makeEvent({ name: 'svc', scopes: ['read'], allowedPathPrefixes: ['/api/v1/health'] }),
        );
        // Fix round 1, Minor f: assert the ACTUAL expected outcome (reaches
        // the handler, mints, 201) rather than the weaker `not.toBe(422)`,
        // which a 500 (e.g. an unimplemented mocked create() returning
        // undefined and crashing on `result.id`) would also satisfy.
        expect(response.status).toBe(201);
        expect(mockCreate).toHaveBeenCalledWith(
            expect.objectContaining({ allowedPathPrefixes: ['/api/v1/health'] }),
        );
    });

    // Fix round 1, Minor d (controller ruling): the envelope is enforced
    // case-insensitively at request time (token-identity.ts's
    // tokenEnvelopeDenial() uppercases both sides before comparing), so
    // mint-time validation must normalize rather than reject a lowercase
    // method.
    it('normalizes a lowercase allowedMethods entry to uppercase instead of rejecting it', async () => {
        const response = await POST!(
            makeEvent({ name: 'svc', scopes: ['read'], allowedMethods: ['get'] }),
        );
        expect(response.status).toBe(201);
        expect(mockCreate).toHaveBeenCalledWith(
            expect.objectContaining({ allowedMethods: ['GET'] }),
        );
    });

    it('still rejects a method outside the enum regardless of case', async () => {
        const response = await POST!(
            makeEvent({ name: 'svc', scopes: ['read'], allowedMethods: ['trace'] }),
        );
        expect(response.status).toBe(422);
    });

    // API package 15: the matcher compares literally, so a non-IP entry would
    // make the token silently never work.
    it('rejects an allowedIps entry that is not an IPv4/IPv6 literal', async () => {
        const response = await POST!(
            makeEvent({ name: 'svc', scopes: ['read'], allowedIps: ['10.0.0.0/8'] }),
        );
        expect(response.status).toBe(422);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('accepts IPv4 and IPv6 literals', async () => {
        const response = await POST!(
            makeEvent({ name: 'svc', scopes: ['read'], allowedIps: ['192.168.1.10', 'fd00::1'] }),
        );
        expect(response.status).toBe(201);
    });
});
