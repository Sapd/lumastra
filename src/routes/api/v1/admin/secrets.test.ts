// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for /api/v1/admin/secrets/rotate endpoint.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockValidatePat = vi.fn();

vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: mockValidatePat }),
}));

// fix-plan-5 Task 3: authenticate()'s pat_ branch now resolves identity via
// resolveTokenUserAccess() (Formula A) instead of trusting the raw
// validate() row directly. This suite is about the route's own business
// logic, not identity-resolution correctness (that has its own coverage in
// resolve-token-user-access.test.ts / tasks/api-auth.test.ts), so derive the
// mock's answer from whatever mockValidatePat is configured with per test,
// rather than hitting a real (unconfigured here) Postgres connection.
vi.mock('$lib/server/auth/resolve-token-user-access.js', () => ({
    resolveTokenUserAccess: async (username: string) => {
        const validated = await mockValidatePat();
        if (!validated || validated.username !== username) return null;
        return {
            userGroups: validated.groups ?? [],
            disabled: false,
            deleted: false,
            permissions: {
                hasWatchPermission: true,
                hasLiveTvPermission: true,
                hasRequestPermission: false,
                hasReviewPermission: false,
                hasMediaAnnotationPermission: false,
                ownerIsAdmin: (validated.scopes ?? []).includes('admin'),
                maxAgeRating: null,
                isAgeRestricted: false,
                isModerator: false,
                liveTvPriority: 'low',
            },
        };
    },
    computeOwnerMaxAge: () => null,
    mergeMaxAge: (a: number | null, b: number | null) =>
        a === null ? b : b === null ? a : Math.min(a, b),
    MOST_RESTRICTIVE_AGE_RATING: 0,
}));

vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: vi.fn() }),
}));

const mockRotate = vi.fn();
const mockSql = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => mockSql,
}));

// The rotate endpoint also acquires a Valkey lock; without a mocked client
// it returns 503 ("Rotation lock unavailable") before reaching `rotate()`.
// Return a client whose SETNX wins and whose DEL is a no-op.
vi.mock('$lib/server/cache/valkey.js', () => ({
    getCoordinationClient: () => ({
        customCommand: vi.fn(async (cmd: string[]) => {
            return cmd[0] === 'SET' ? 'OK' : null;
        }),
        del: vi.fn().mockResolvedValue(1),
    }),
}));

// Every non-plugin store the rotation covers (security review 2026-09-12, C9).
// Each returns "nothing to move" so the rotate case proves the handler REACHES
// every store; a missing mock here would surface as a `notRotated` entry.
const storeResult = { rotated: 0, skipped: 0, reasons: [] as string[], legacyUpgraded: 0 };
const mockRotateJellyfin = vi.fn().mockResolvedValue(storeResult);
const mockRotateConfig = vi.fn().mockResolvedValue(storeResult);
const mockRotateSubsonic = vi.fn().mockResolvedValue(storeResult);
const mockRotateWebhooks = vi.fn().mockResolvedValue(storeResult);
const mockRotateLiveTv = vi.fn().mockResolvedValue(storeResult);

vi.mock('$lib/server/tasks/secrets.js', () => ({
    PluginSecrets: class {
        rotate: typeof mockRotate = mockRotate;
        getCurrentMaxVersion = vi.fn().mockResolvedValue(2);
    },
    deriveMasterKey: (key: string) => {
        if (!key) throw new Error('LUMASTRA_MASTER_KEY not set');
        // Accept 64-char hex or any passphrase ≥ 32 chars.
        return Buffer.alloc(32);
    },
    rotateJellyfinClientPasswords: (...args: unknown[]) => mockRotateJellyfin(...args),
}));
vi.mock('$lib/server/config/config.service.js', () => ({
    rotateConfigSecrets: (...args: unknown[]) => mockRotateConfig(...args),
}));
vi.mock('$lib/server/subsonic-compat/auth.js', () => ({
    rotateSubsonicTokens: (...args: unknown[]) => mockRotateSubsonic(...args),
}));
vi.mock('$lib/server/tasks/webhook-outbox.js', () => ({
    rotateWebhookSecrets: (...args: unknown[]) => mockRotateWebhooks(...args),
}));
vi.mock('$lib/server/database/queries/livetv-sources.queries.js', () => ({
    rotateLiveTvCredentials: (...args: unknown[]) => mockRotateLiveTv(...args),
}));

vi.mock('$lib/server/config.js', () => ({
    LUMASTRA_MASTER_KEY: 'a'.repeat(64),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), info: vi.fn() }) },
}));

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (evt: unknown) => Promise<Response>) => async (evt: unknown) => {
        try {
            return await fn(evt);
        } catch (err) {
            if (err && typeof err === 'object' && 'statusCode' in err) {
                const e = err as { statusCode: number; message: string };
                return new Response(JSON.stringify({ error: e.message }), {
                    status: e.statusCode,
                });
            }
            throw err;
        }
    },
}));

vi.mock('$lib/server/utils/api-responses.js', () => ({
    ApiResponses: {
        unauthorized: (msg: string) =>
            new Response(JSON.stringify({ error: msg }), { status: 401 }),
        forbidden: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 403 }),
        badRequest: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 400 }),
    },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(
    opts: {
        headers?: Record<string, string>;
        body?: unknown;
    } = {},
) {
    return {
        // A real Request: the handler reads the body with readBoundedJson (a
        // capped stream read), not request.json().
        request: new Request('http://localhost/api/v1/admin/secrets/rotate', {
            method: 'POST',
            headers: opts.headers ?? {},
            body: JSON.stringify(opts.body ?? {}),
        }),
        params: {},
        url: new URL('http://localhost/api/v1/admin/secrets/rotate'),
        // authenticate() reads event.locals.user; empty locals routes
        // through the bearer-only path.
        locals: {},
    };
}

const adminPat = {
    id: 1,
    userId: '11111111-1111-4111-8111-111111111111',
    username: 'alice',
    name: 'test',
    scopes: ['admin'],
    groups: [],
    jellyfinUserId: null,
    tokenPrefix: 'pat_aaa',
};

const validBody = {
    oldMasterKey: 'a'.repeat(64),
    newMasterKey: 'b'.repeat(64), // 64-char hex key
    confirmation: 'I_UNDERSTAND_THIS_RE_ENCRYPTS_ALL_SECRETS',
};

// ── POST /api/v1/admin/secrets/rotate ─────────────────────────────────────────

describe('POST /api/v1/admin/secrets/rotate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockValidatePat.mockResolvedValue(adminPat);
        // `PluginSecrets.rotate` returns failedRows alongside the counts so
        // the endpoint can report unrecoverable rows; mock the full shape.
        mockRotate.mockResolvedValue({
            rotated: 5,
            skipped: 0,
            legacyUpgraded: 0,
            failedRows: [],
        });
        // mockSql for version query
        mockSql.mockResolvedValue([{ max_version: 1 }]);
    });

    it('rotates secrets and returns count', async () => {
        const { POST } = await import('./secrets/rotate/+server.js');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            body: validBody,
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as {
            rotated: number;
            newVersion: number;
            notRotated: unknown[];
            legacyUpgraded: Record<string, number>;
        };
        expect(body.rotated).toBe(5);
        expect(body.newVersion).toBe(2);
        // Every store was reached and none was left behind.
        expect(body.notRotated).toEqual([]);
        // Nothing needed the enc:v1 → enc:v2 upgrade, so no store is listed.
        expect(body.legacyUpgraded).toEqual({});
        for (const store of [
            mockRotateConfig,
            mockRotateSubsonic,
            mockRotateWebhooks,
            mockRotateJellyfin,
            mockRotateLiveTv,
        ]) {
            expect(store).toHaveBeenCalledTimes(1);
        }
    });

    it('reports a store that could not be rotated instead of hiding it', async () => {
        mockRotateSubsonic.mockRejectedValueOnce(new Error('subsonic table locked'));
        const { POST } = await import('./secrets/rotate/+server.js');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            body: validBody,
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        const body = (await resp.json()) as {
            notRotated: Array<{ store: string; reason: string }>;
            warning?: string;
        };
        expect(body.notRotated.map((n) => n.store)).toEqual(['subsonic_client_passwords']);
        expect(body.notRotated[0].reason).toContain('subsonic table locked');
        expect(body.warning).toMatch(/Do NOT swap LUMASTRA_MASTER_KEY/);
    });

    it('reports, per store, how many values it bound to their row', async () => {
        // security review 2026-09-13, C19. The upgrade binds each value to
        // whatever row it is sitting in, so the operator has to SEE it happen —
        // a silent count is how a transplanted secret becomes permanent.
        mockRotate.mockResolvedValueOnce({
            rotated: 5,
            skipped: 0,
            legacyUpgraded: 2,
            failedRows: [],
        });
        mockRotateSubsonic.mockResolvedValueOnce({
            rotated: 3,
            skipped: 0,
            reasons: [],
            legacyUpgraded: 3,
        });

        const { POST } = await import('./secrets/rotate/+server.js');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            body: validBody,
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        const body = (await resp.json()) as { legacyUpgraded: Record<string, number> };

        expect(body.legacyUpgraded).toEqual({
            'plugin_secrets + plugin_user_credentials': 2,
            subsonic_client_passwords: 3,
        });
        // Stores that upgraded nothing are absent, not zero-valued noise.
        expect(Object.keys(body.legacyUpgraded)).toHaveLength(2);
    });

    it('rejects missing confirmation string', async () => {
        const { POST } = await import('./secrets/rotate/+server.js');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            body: { oldMasterKey: 'a'.repeat(64), newMasterKey: 'b'.repeat(64) }, // no confirmation
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(422);
    });

    it('rejects wrong confirmation string', async () => {
        const { POST } = await import('./secrets/rotate/+server.js');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            body: {
                oldMasterKey: 'a'.repeat(64),
                newMasterKey: 'b'.repeat(64),
                confirmation: 'yes please',
            },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(422);
    });

    it('rejects newMasterKey shorter than 32 chars', async () => {
        const { POST } = await import('./secrets/rotate/+server.js');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            body: {
                oldMasterKey: 'a'.repeat(64),
                newMasterKey: 'short',
                confirmation: 'I_UNDERSTAND_THIS_RE_ENCRYPTS_ALL_SECRETS',
            },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(422);
    });

    it('returns 401 with no bearer', async () => {
        const { POST } = await import('./secrets/rotate/+server.js');
        const event = makeEvent({ body: validBody });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(401);
    });

    it('returns 403 when scope insufficient (tasks:admin required)', async () => {
        mockValidatePat.mockResolvedValue({ ...adminPat, scopes: ['write'] });
        const { POST } = await import('./secrets/rotate/+server.js');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            body: validBody,
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(403);
    });

    it('calls PluginSecrets.rotate with derived keys', async () => {
        const { POST } = await import('./secrets/rotate/+server.js');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            body: validBody,
        });
        await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(mockRotate).toHaveBeenCalledOnce();
        const [oldKeyArg, newKeyArg, versionArg] = mockRotate.mock.calls[0] as [
            Buffer,
            Buffer,
            number,
        ];
        expect(Buffer.isBuffer(oldKeyArg)).toBe(true);
        expect(Buffer.isBuffer(newKeyArg)).toBe(true);
        expect(typeof versionArg).toBe('number');
    });
});
