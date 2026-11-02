// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for auditLog()'s object-actor form and auditActor() (R5 — audit rows
 * must record the credential kind and id, not just a username, so a stolen
 * PAT/service token is attributable).
 *
 * `auditActor()` at the delegation seam is covered separately below via
 * `delegateToAdmin()` — the same shim exercised by `delegate.test.ts` — so a
 * delegated admin action is proven to keep the OUTER (pre-delegation)
 * credential's kind/id, not the synthetic elevated identity.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';

const { insertAdminAuditEvent, loggerInfo, loggerWarn } = vi.hoisted(() => ({
    insertAdminAuditEvent: vi.fn().mockResolvedValue(undefined),
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ info: loggerInfo, warn: loggerWarn, error: vi.fn(), debug: vi.fn() }),
    },
}));
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => ({ json: (v: unknown) => v })),
}));
vi.mock('$lib/server/config.js', () => ({
    config: { INSTANCE_ID: 'test-instance' },
    features: {},
}));
vi.mock('$lib/server/database/queries/admin-audit.queries.js', () => ({
    insertAdminAuditEvent,
}));
// Pulled in transitively by mount.js (via tasks/api-auth.js) for the
// delegation-seam test below — enforce({kind:'admin'}) short-circuits on
// `locals.principal.isAdmin` before any of these run, but the module graph
// still needs to load without touching a real DB/oauth service.
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: vi.fn().mockResolvedValue(null) }),
}));
vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: vi.fn().mockResolvedValue(null) }),
}));
vi.mock('$lib/server/auth.js', () => ({ isUserAdmin: vi.fn().mockReturnValue(false) }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: vi.fn().mockResolvedValue(null),
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn().mockResolvedValue({}) },
}));

import { auditLog, auditActor } from './audit-log.js';
import { buildPrincipal } from '$lib/server/api/principal.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import { enforce } from '$lib/server/api/mount.js';

const UID = toUserId('00000000-0000-0000-0000-000000000042');

/** Flush the fire-and-forget async DB sink inside auditLog(). */
async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
    insertAdminAuditEvent.mockClear();
    loggerInfo.mockClear();
    loggerWarn.mockClear();
});

describe('auditLog — legacy string actor form', () => {
    it('writes actor as-is and leaves principalKind/credentialId null', async () => {
        auditLog('user.delete', 'alice', 'admin-bob', { reason: 'test' });
        await flush();

        expect(insertAdminAuditEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                actor: 'admin-bob',
                principalKind: null,
                credentialId: null,
                action: 'user.delete',
                target: 'alice',
                outcome: 'ok',
            }),
        );
    });

    it('falls back to actor "system" when the username is null', async () => {
        auditLog('queue.pause.global', 'global', null);
        await flush();

        expect(insertAdminAuditEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ actor: 'system', principalKind: null, credentialId: null }),
        );
    });
});

describe('auditLog — object actor form', () => {
    it('writes principalKind and credentialId from the actor object', async () => {
        auditLog(
            'secret.rotate',
            '*',
            { username: 'ci-token', kind: 'pat', credentialId: 'pat_abc123' },
            { rotated: 5 },
        );
        await flush();

        expect(insertAdminAuditEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                actor: 'ci-token',
                principalKind: 'pat',
                credentialId: 'pat_abc123',
            }),
        );
    });

    it('records delegated:true on the structured log line when the actor is delegated', () => {
        auditLog('media.rescan', 'abc', {
            username: 'ci-token',
            kind: 'pat',
            credentialId: 'pat_abc123',
            delegated: true,
        });

        expect(loggerInfo).toHaveBeenCalledWith(
            '[AUDIT] media.rescan',
            expect.objectContaining({ delegated: true, principalKind: 'pat' }),
        );
    });
});

describe('auditActor — building the actor from a RequestEvent', () => {
    it('prefers locals.principal, carrying kind and credentialId', () => {
        const principal = buildPrincipal({
            kind: 'pat',
            userId: UID,
            username: 'ci-token',
            userGroups: [],
            tokenScopes: ['admin'],
            sessionIsAdmin: false,
            ownerIsAdmin: true,
            credentialId: 'pat_42',
        });
        const event = {
            locals: { principal, user: undefined },
        } as unknown as RequestEvent;

        expect(auditActor(event)).toEqual({
            username: 'ci-token',
            kind: 'pat',
            credentialId: 'pat_42',
        });
    });

    it('falls back to locals.user (username only, no kind/credentialId) when there is no Principal', () => {
        const event = {
            locals: { principal: undefined, user: { username: 'legacy-admin' } },
        } as unknown as RequestEvent;

        expect(auditActor(event)).toEqual({ username: 'legacy-admin' });
    });

    it('returns {username: null} when neither a Principal nor a user resolved', () => {
        const event = { locals: {} } as unknown as RequestEvent;
        expect(auditActor(event)).toEqual({ username: null });
    });
});

describe('auditActor at the delegation seam — a delegated admin action keeps the ORIGINAL credential', () => {
    it('kind/credentialId stay the outer PAT, with delegated:true, inside delegateToAdmin()', async () => {
        const principal = buildPrincipal({
            kind: 'pat',
            userId: UID,
            username: 'ci-token',
            userGroups: [],
            tokenScopes: ['media:admin'],
            sessionIsAdmin: false,
            ownerIsAdmin: false,
            credentialId: 'pat_777',
        });
        const event = {
            locals: { principal, user: undefined, authMethod: 'pat' },
            params: {},
            request: new Request('https://x/api/v1/media/abc/rescan', { method: 'POST' }),
            url: new URL('https://x/api/v1/media/abc/rescan'),
        } as unknown as RequestEvent;

        // Outer scope gate passes (media:admin), but the token is not admin itself.
        expect(event.locals.principal!.isAdmin).toBe(false);

        let capturedActor: ReturnType<typeof auditActor> | undefined;
        const innerAdminHandler = async (e: RequestEvent): Promise<Response> => {
            const denied = await enforce({ kind: 'admin' }, e);
            if (denied) return denied;
            // What the inner admin handler would pass to auditLog().
            capturedActor = auditActor(e);
            return new Response('ok', { status: 200 });
        };

        const res = await delegateToAdmin(event, innerAdminHandler);
        expect(res.status).toBe(200);

        // The audited actor is the OUTER pre-delegation PAT — kind 'pat',
        // its own credentialId — NOT the synthetic elevated admin identity,
        // and marked delegated so the row is distinguishable in the feed.
        expect(capturedActor).toEqual({
            username: 'ci-token',
            kind: 'pat',
            credentialId: 'pat_777',
            delegated: true,
        });
    });
});
