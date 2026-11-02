// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `handleSecretsRotate`'s audit-actor attribution (security review 2026-09-13,
 * R5 follow-through).
 *
 * Before this fix, `auditLog('secret.rotate', ...)` passed
 * `{ username: auth.userId, kind, credentialId }` — already an object, but
 * `auth.userId` is NOT the username for a service-token caller:
 * `authenticate()` sets it to `validated.actAsUser ?? 'service:' + validated.id`
 * (a raw `users.id` UUID for an impersonating token, or a synthetic
 * `service:<id>` string otherwise), so the audit row's `adminUsername` field
 * held a UUID or a synthetic id instead of a human-readable name.
 *
 * Group A's `ApiAuth.identity` addition (`src/lib/server/tasks/api-auth.ts`,
 * commits 7c8021de5/be1fe12c6) now resolves a real `identity.username` for
 * service tokens too. This handler should prefer the request's resolved
 * Principal (`auditActor(event)`, populated by mount.ts's `{kind:'scope'}`
 * outer-gate fallback / forward-auth on both the v1 Bearer surface and the
 * internal cookie surface) and fall back to building the actor from `auth`
 * (using `auth.identity.username` over the synthetic `auth.userId`) only when
 * no Principal was materialized.
 *
 * Only the audit-actor seam is exercised here — every other store rotation
 * is mocked to a no-op success so the test stays about attribution, not about
 * the rotation machinery itself (covered by `secrets-rotate-coverage.test.ts`
 * and the individual store rotation functions' own tests).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAuditLog = vi.fn();
vi.mock('$lib/server/utils/audit-log.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/audit-log.js')>();
    return {
        ...actual,
        auditLog: (...args: unknown[]) => mockAuditLog(...args),
    };
});

const mockAuthenticate = vi.fn();
const mockRequireScope = vi.fn();
vi.mock('$lib/server/tasks/api-auth.js', () => ({
    authenticate: (...args: unknown[]) => mockAuthenticate(...args),
    requireScope: (...args: unknown[]) => mockRequireScope(...args),
}));

const mockGetDb = vi.fn();
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => mockGetDb(),
}));

const mockValkeyClient = {
    customCommand: vi.fn(async () => 'OK'),
    del: vi.fn(async () => {}),
};
vi.mock('$lib/server/cache/valkey.js', () => ({
    getCoordinationClient: () => mockValkeyClient,
}));

const NOOP_ROTATION = { rotated: 0, skipped: 0, legacyUpgraded: 0, reasons: [] };

vi.mock('$lib/server/tasks/secrets.js', () => ({
    PluginSecrets: class {
        async getCurrentMaxVersion() {
            return 1;
        }
        async rotate() {
            return { rotated: 0, skipped: 0, legacyUpgraded: 0, failedRows: [] };
        }
    },
    deriveMasterKey: (s: string) => Buffer.from(s.padEnd(32, '0').slice(0, 32)),
    rotateJellyfinClientPasswords: async () => NOOP_ROTATION,
}));
vi.mock('$lib/server/config/config.service.js', () => ({
    rotateConfigSecrets: async () => NOOP_ROTATION,
}));
vi.mock('$lib/server/subsonic-compat/auth.js', () => ({
    rotateSubsonicTokens: async () => NOOP_ROTATION,
}));
vi.mock('$lib/server/tasks/webhook-outbox.js', () => ({
    rotateWebhookSecrets: async () => NOOP_ROTATION,
}));
vi.mock('$lib/server/database/queries/livetv-sources.queries.js', () => ({
    rotateLiveTvCredentials: async () => NOOP_ROTATION,
}));

const { handleSecretsRotate } = await import('./secrets-rotate.handler.js');
const { PluginSecrets: PluginSecretsMock } = await import('$lib/server/tasks/secrets.js');

function makeEvent(locals: Record<string, unknown> = {}) {
    return {
        request: new Request('http://localhost/api/v1/admin/secrets/rotate', {
            method: 'POST',
            body: JSON.stringify({
                oldMasterKey: 'a'.repeat(32),
                newMasterKey: 'b'.repeat(32),
                confirmation: 'I_UNDERSTAND_THIS_RE_ENCRYPTS_ALL_SECRETS',
            }),
        }),
        locals,
        url: new URL('http://localhost/api/v1/admin/secrets/rotate'),
    };
}

function auditRotateCall() {
    return mockAuditLog.mock.calls.find((c) => c[0] === 'secret.rotate');
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({} as never);
    mockValkeyClient.customCommand.mockResolvedValue('OK');
    mockRequireScope.mockImplementation(() => {});
});

describe('handleSecretsRotate — audit actor attribution', () => {
    it('prefers the request Principal (locals.principal) over auth.userId', async () => {
        mockAuthenticate.mockResolvedValue({
            tokenKind: 'pat',
            tokenId: 'pat-1',
            userId: 'alice',
            scopes: ['tasks:admin'],
        });
        const event = makeEvent({
            principal: { username: 'alice', kind: 'pat', credentialId: 'pat-1', isAdmin: true },
        });

        await handleSecretsRotate(event as never);

        expect(auditRotateCall()?.[2]).toEqual({
            username: 'alice',
            kind: 'pat',
            credentialId: 'pat-1',
        });
    });

    it('falls back to auth.identity.username for a service token when no Principal was materialized — NOT the synthetic userId', async () => {
        mockAuthenticate.mockResolvedValue({
            tokenKind: 'svc',
            tokenId: 'svc-42',
            // The bug: userId is a synthetic id, not a username.
            userId: 'service:svc-42',
            scopes: ['tasks:admin'],
            identity: {
                userId: 'u-1',
                username: 'rotation-bot',
                userGroups: ['admin'],
                ownerIsAdmin: true,
            },
        });
        const event = makeEvent({});

        await handleSecretsRotate(event as never);

        expect(auditRotateCall()?.[2]).toEqual({
            username: 'rotation-bot',
            kind: 'service_token',
            credentialId: 'svc-42',
        });
    });

    it('falls back to auth.userId for a PAT with no Principal and no identity.username', async () => {
        mockAuthenticate.mockResolvedValue({
            tokenKind: 'pat',
            tokenId: 'pat-9',
            userId: 'bob',
            scopes: ['tasks:admin'],
        });
        const event = makeEvent({});

        await handleSecretsRotate(event as never);

        expect(auditRotateCall()?.[2]).toEqual({
            username: 'bob',
            kind: 'pat',
            credentialId: 'pat-9',
        });
    });
});

describe('handleSecretsRotate — rotation lock', () => {
    const adminAuth = {
        tokenKind: 'session',
        userId: 'alice',
        scopes: ['tasks:admin'],
    };

    function lockCalls(): string[][] {
        return (mockValkeyClient.customCommand.mock.calls as unknown as string[][][]).map(
            (c) => c[0],
        );
    }

    it('takes the lock with a per-run token and releases only that token', async () => {
        mockAuthenticate.mockResolvedValue(adminAuth);

        await handleSecretsRotate(makeEvent() as never);

        const [set, release] = lockCalls();
        expect(set[0]).toBe('SET');
        const token = set[2];
        expect(token).not.toBe('alice');
        // Compare-and-delete with the same token, never a blind DEL that could
        // drop a lock another rotation took after ours expired.
        expect(release[0]).toBe('EVAL');
        expect(release.at(-1)).toBe(token);
        expect(mockValkeyClient.del).not.toHaveBeenCalled();
    });

    it('releases the lock when reading the current version fails', async () => {
        mockAuthenticate.mockResolvedValue(adminAuth);
        const spy = vi
            .spyOn(PluginSecretsMock.prototype, 'getCurrentMaxVersion')
            .mockRejectedValueOnce(new Error('db down'));

        await expect(handleSecretsRotate(makeEvent() as never)).rejects.toThrow('db down');

        expect(lockCalls().map((c) => c[0])).toEqual(['SET', 'EVAL']);
        spy.mockRestore();
    });
});
