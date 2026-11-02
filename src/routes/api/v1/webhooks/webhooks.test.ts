// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for /api/v1/webhooks/* endpoints.
 *
 * All external dependencies are mocked — no live infrastructure required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mockValidatePat = vi.hoisted(() => vi.fn());
const mockValidateSvc = vi.hoisted(() => vi.fn());
const mockListWebhookHooks = vi.hoisted(() => vi.fn());
const mockInsertWebhookHook = vi.hoisted(() => vi.fn());
const mockUpdateWebhookHookWithSecret = vi.hoisted(() => vi.fn());
const mockUpdateWebhookHookWithoutSecret = vi.hoisted(() => vi.fn());
const mockDeleteWebhookHook = vi.hoisted(() => vi.fn());
const mockGetWebhookHookById = vi.hoisted(() => vi.fn());

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: mockValidatePat }),
}));

vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: mockValidateSvc }),
}));

const mockSql = vi.hoisted(() => Object.assign(vi.fn(), { json: (v: unknown) => v }));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => mockSql,
}));

vi.mock('$lib/server/database/queries/webhook.queries.js', () => ({
    listWebhookHooks: (...args: unknown[]) => mockListWebhookHooks(...args),
    insertWebhookHook: (...args: unknown[]) => mockInsertWebhookHook(...args),
    updateWebhookHookWithSecret: (...args: unknown[]) => mockUpdateWebhookHookWithSecret(...args),
    updateWebhookHookWithoutSecret: (...args: unknown[]) =>
        mockUpdateWebhookHookWithoutSecret(...args),
    deleteWebhookHook: (...args: unknown[]) => mockDeleteWebhookHook(...args),
    getWebhookHookById: (...args: unknown[]) => mockGetWebhookHookById(...args),
}));

vi.mock('$lib/server/config.js', () => ({
    config: {
        FEATURE_DEVICE_AUTH: true,
        FEATURE_USER_PATS: true,
    },
    LUMASTRA_MASTER_KEY: 'a'.repeat(64), // 64 hex chars = valid 32-byte key
    BACKEND_ONLY_FEATURES: new Set([]),
}));

vi.mock('$lib/server/tasks/secrets.js', () => ({
    encrypt: () => Buffer.from('encrypted'),
    decrypt: () => 'decrypted-secret',
    deriveMasterKey: () => Buffer.alloc(32),
}));

vi.mock('$lib/server/tasks/url-safety.js', () => ({
    assertPublicHttpUrl: vi.fn(),
    assertWebhookTargetUrl: vi.fn((url: string) => new URL(url)),
    isAllowlistedPrivateHost: vi.fn(() => false),
    safeFetch: vi.fn().mockResolvedValue(new Response('ok', { status: 200 })),
    UrlSafetyError: class extends Error {
        constructor(m: string) {
            super(m);
        }
    },
}));

vi.mock('$lib/server/tasks/webhook-signature.js', () => ({
    signatureHeader: vi.fn().mockReturnValue('sig=abc123'),
    sanitizeWebhookHeaders: vi.fn().mockReturnValue({}),
}));

vi.mock('$lib/server/cache/valkey.js', () => ({
    publishMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/server/tasks/webhook-outbox.js', () => ({
    WEBHOOK_HOOKS_INVALIDATE_CHANNEL: 'webhooks:invalidate',
    // POST builds the secret's AAD with this. Missing from the factory, the
    // property access threw INSIDE the def's encrypt try/catch, which reports
    // any failure as 503 dependency_unavailable — so the create tests saw 503
    // instead of 201, and the DB-failure test saw 503 instead of 500.
    operatorWebhookSecretContext: (id: string) => `webhook:${id}`,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

vi.mock('$lib/server/tasks/api-auth.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/tasks/api-auth.js')>();
    return {
        ...actual,
        // authenticate throws 401 when no valid bearer — this is the correct default
        authenticate: async (event: {
            request: { headers: { get: (k: string) => string | null } };
        }) => {
            const raw = event.request.headers.get('authorization') ?? '';
            if (!raw) throw new actual.ApiAuthError(401, 'Bearer token required');
            return { tokenKind: 'pat', scopes: ['webhooks:write'] };
        },
        requireScope: vi.fn(),
        scopeGranted: (scopes: string[], required: string) => scopes.includes(required),
    };
});

vi.mock('$lib/server/auth.js', () => ({ isUserAdmin: () => false }));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(
    opts: {
        authHeader?: string;
        params?: Record<string, string>;
        body?: unknown;
        method?: string;
        principalScopes?: string[];
    } = {},
): RequestEvent {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (opts.authHeader) headers.set('Authorization', opts.authHeader);

    const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;

    const principal =
        opts.principalScopes !== undefined
            ? {
                  kind: 'pat' as const,
                  userId: 'user-1' as ReturnType<
                      (typeof import('$lib/shared/user-id.js'))['toUserId']
                  >,
                  username: 'alice',
                  userGroups: [],
                  scopes: opts.principalScopes,
                  isAdmin: opts.principalScopes.includes('admin'),
              }
            : undefined;

    return {
        request: new Request('http://localhost/api/v1/webhooks', {
            method,
            headers,
            body: bodyStr,
        }),
        params: opts.params ?? {},
        url: new URL('http://localhost/api/v1/webhooks'),
        route: { id: '/api/v1/webhooks' as const },
        locals: {
            user: null,
            principal,
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const adminPat = {
    id: 1,
    username: 'alice',
    name: 'test',
    scopes: ['webhooks:write'],
    groups: [],
    jellyfinUserId: null,
    tokenPrefix: 'pat_aaa',
};

const stubHookRow = {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    url: 'https://example.com/hook',
    event_filter: ['org.lumastra.task.run.completed'],
    task_filter: null,
    library_group_filter: null,
    headers: null,
    active: true,
    include_progress: false,
    created_by: 'alice',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    secret_encrypted: Buffer.alloc(32), // non-empty placeholder
    media_type_filter: null,
    batch_window_seconds: 60,
    max_batch_size: 25,
};

// ── GET /api/v1/webhooks ──────────────────────────────────────────────────────

describe('GET /api/v1/webhooks', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockValidatePat.mockResolvedValue(adminPat);
        mockListWebhookHooks.mockResolvedValue([stubHookRow]);
    });

    it('returns webhook list for valid PAT', async () => {
        const { GET } = await import('./+server.js');
        // use principal with webhooks:write scope
        const event = makeEvent({ principalScopes: ['webhooks:write'] });
        const resp = await GET!(event as Parameters<NonNullable<typeof GET>>[0]);
        expect(resp.status).toBe(200);
        // D10: response is { items, page } (was { webhooks })
        const body = (await resp.json()) as { items: unknown[]; page: unknown };
        expect(body.items).toHaveLength(1);
        expect(body.page).toBeDefined();
    });

    it('does not return secret value — only hasSecret flag', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({ principalScopes: ['webhooks:write'] });
        const resp = await GET!(event as Parameters<NonNullable<typeof GET>>[0]);
        // D10: response is { items, page }
        const body = (await resp.json()) as {
            items: Record<string, unknown>[];
        };
        const hook = body.items[0];
        expect(hook).not.toHaveProperty('secret');
        expect(hook).not.toHaveProperty('secret_encrypted');
        expect(hook).toHaveProperty('hasSecret', true);
    });

    it('returns 401 with no bearer', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent(); // no principal, no auth
        const resp = await GET!(event as Parameters<NonNullable<typeof GET>>[0]);
        expect(resp.status).toBe(401);
    });

    it('returns 403 when scope insufficient', async () => {
        const { GET } = await import('./+server.js');
        // D10: scope checked against principal.scopes
        const event = makeEvent({ principalScopes: ['read'] }); // no webhooks:write
        const resp = await GET!(event as Parameters<NonNullable<typeof GET>>[0]);
        expect(resp.status).toBe(403);
    });
});

// ── POST /api/v1/webhooks ─────────────────────────────────────────────────────

describe('POST /api/v1/webhooks', () => {
    const validBody = {
        url: 'https://example.com/hook',
        secret: 'a-secure-secret-of-16-chars-or-more',
        eventFilter: ['org.lumastra.task.run.completed'],
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockValidatePat.mockResolvedValue(adminPat);
        mockInsertWebhookHook.mockResolvedValue('new-hook-uuid');
        mockGetWebhookHookById.mockResolvedValue({ ...stubHookRow, id: 'new-hook-uuid' });
    });

    it('creates webhook and returns resource + Location header', async () => {
        const { POST } = await import('./+server.js');
        const event = makeEvent({
            principalScopes: ['webhooks:write'],
            body: validBody,
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(201);
        // D10: returns full resource (not just { id })
        const body = (await resp.json()) as { id: string; url: string };
        expect(body.id).toBe('new-hook-uuid');
        expect(body.url).toBe(validBody.url);
        // D10: Location header
        expect(resp.headers.get('Location')).toBe('/api/v1/webhooks/new-hook-uuid');
    });

    // D10: Validation errors are 422 problem+json (was 400 bare { error })
    it('returns 422 for missing url (was 400)', async () => {
        const { POST } = await import('./+server.js');
        const event = makeEvent({
            principalScopes: ['webhooks:write'],
            body: { secret: 'valid-secret-long-enough', eventFilter: [] },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(422);
        const body = (await resp.json()) as { code: string };
        expect(body.code).toBe('validation_failed');
    });

    it('returns 422 for short secret (< 16 chars) — was 400', async () => {
        const { POST } = await import('./+server.js');
        const event = makeEvent({
            principalScopes: ['webhooks:write'],
            body: {
                url: 'https://example.com/hook',
                secret: 'short',
                eventFilter: [],
            },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(422);
    });

    it('returns 422 for invalid url — was 400', async () => {
        const { POST } = await import('./+server.js');
        const event = makeEvent({
            principalScopes: ['webhooks:write'],
            body: {
                url: 'not-a-url',
                secret: 'valid-secret-long-enough',
                eventFilter: [],
            },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(422);
    });

    it('returns 401 with no bearer', async () => {
        const { POST } = await import('./+server.js');
        const event = makeEvent({ body: validBody }); // no principal
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(401);
    });

    it('returns 403 when scope insufficient', async () => {
        const { POST } = await import('./+server.js');
        const event = makeEvent({
            principalScopes: ['read'], // no webhooks:write
            body: validBody,
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(403);
    });
});

// ── DELETE /api/v1/webhooks/{id} ──────────────────────────────────────────────

describe('DELETE /api/v1/webhooks/{id}', () => {
    const hookId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    beforeEach(() => {
        vi.clearAllMocks();
        mockValidatePat.mockResolvedValue(adminPat);
        mockDeleteWebhookHook.mockResolvedValue(hookId);
    });

    it('deletes hook and returns 204 no-content (D10: was 200 {deleted})', async () => {
        const { DELETE } = await import('./[id]/+server.js');
        const event = makeEvent({
            principalScopes: ['webhooks:write'],
            method: 'DELETE',
            params: { id: hookId },
        });
        const resp = await DELETE!(event as Parameters<NonNullable<typeof DELETE>>[0]);
        // D10: DELETE returns 204 (was 200 { deleted })
        expect(resp.status).toBe(204);
    });

    it('returns 404 when hook not found', async () => {
        mockDeleteWebhookHook.mockResolvedValue(null);
        const { DELETE } = await import('./[id]/+server.js');
        const event = makeEvent({
            principalScopes: ['webhooks:write'],
            method: 'DELETE',
            params: { id: hookId },
        });
        const resp = await DELETE!(event as Parameters<NonNullable<typeof DELETE>>[0]);
        expect(resp.status).toBe(404);
        const body = (await resp.json()) as { code: string };
        expect(body.code).toBe('not_found');
    });

    it('returns 401 with no bearer', async () => {
        const { DELETE } = await import('./[id]/+server.js');
        const event = makeEvent({ method: 'DELETE', params: { id: hookId } }); // no principal
        const resp = await DELETE!(event as Parameters<NonNullable<typeof DELETE>>[0]);
        expect(resp.status).toBe(401);
    });

    it('returns 403 when scope insufficient', async () => {
        const { DELETE } = await import('./[id]/+server.js');
        const event = makeEvent({
            principalScopes: ['read'], // no webhooks:write
            method: 'DELETE',
            params: { id: hookId },
        });
        const resp = await DELETE!(event as Parameters<NonNullable<typeof DELETE>>[0]);
        expect(resp.status).toBe(403);
    });
});

// ── POST /api/v1/webhooks/{id}/test ──────────────────────────────────────────

describe('POST /api/v1/webhooks/{id}/test', () => {
    const hookId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    beforeEach(() => {
        vi.clearAllMocks();
        mockValidatePat.mockResolvedValue(adminPat);
    });

    it.each(['http', 'network'] as const)('redacts webhook test %s failures', async (kind) => {
        const { safeFetch } = await import('$lib/server/tasks/url-safety.js');
        const leak = 'decrypted-secret https://user:password@example.com/?key=private-key';
        if (kind === 'http')
            vi.mocked(safeFetch).mockResolvedValueOnce(new Response(leak, { status: 401 }));
        else vi.mocked(safeFetch).mockRejectedValueOnce(new Error(leak));
        mockSql.mockResolvedValue([
            {
                id: hookId,
                url: 'https://example.com/hook',
                secret_encrypted: Buffer.from('encrypted'),
                headers: {},
            },
        ]);
        const { POST } = await import('./[id]/test/+server.js');
        const resp = await POST!(
            makeEvent({
                principalScopes: ['webhooks:write'],
                method: 'POST',
                params: { id: hookId },
            }),
        );
        const body = await resp.json();
        expect(resp.status).toBe(200);
        expect(body.delivered).toBe(false);
        expect(JSON.stringify(body)).not.toMatch(/decrypted-secret|password|private-key/);
        expect(body.error).toMatch(kind === 'http' ? /401/ : /[Cc]heck/);
    });

    it('returns 404 when hook not found', async () => {
        // The /test handler does a raw SQL query (not getWebhookHookById)
        mockSql.mockResolvedValue([]);
        const { POST } = await import('./[id]/test/+server.js');
        const event = makeEvent({
            principalScopes: ['webhooks:write'],
            method: 'POST',
            params: { id: hookId },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(404);
    });

    it('returns 401 with no bearer', async () => {
        const { POST } = await import('./[id]/test/+server.js');
        const event = makeEvent({ method: 'POST', params: { id: hookId } }); // no principal
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(401);
    });

    it('returns 403 when scope insufficient', async () => {
        const { POST } = await import('./[id]/test/+server.js');
        const event = makeEvent({
            principalScopes: ['read'], // no webhooks:write
            method: 'POST',
            params: { id: hookId },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(403);
    });
});

describe('GET /api/v1/webhooks/events', () => {
    it('returns exactly the production delivery catalogue without querying the database', async () => {
        vi.clearAllMocks();
        const { GET } = await import('./events/+server.js');
        const { WEBHOOK_EVENTS } = await import('$lib/shared/webhook-events.js');
        const response = await GET!(makeEvent({ principalScopes: ['webhooks:write'] }));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ items: WEBHOOK_EVENTS });
        expect(mockListWebhookHooks).not.toHaveBeenCalled();
    });

    it('requires the same scope as the webhook list', async () => {
        const { GET } = await import('./events/+server.js');
        const response = await GET!(makeEvent({ principalScopes: ['tasks:read'] }));
        expect(response.status).toBe(403);
    });

    it('requires authentication', async () => {
        const { GET } = await import('./events/+server.js');
        const response = await GET!(makeEvent());
        expect(response.status).toBe(401);
    });
});

describe('webhook eventFilter validation', () => {
    for (const method of ['POST', 'PUT'] as const) {
        for (const eventType of ['unknown.event', '*', 'org.lumastra.task.run.progress']) {
            it(`${method} rejects ${eventType} with 422 before writing`, async () => {
                vi.clearAllMocks();
                const handler =
                    method === 'POST'
                        ? (await import('./+server.js')).POST!
                        : (await import('./[id]/+server.js')).PUT!;
                const response = await handler(
                    makeEvent({
                        principalScopes: ['webhooks:write'],
                        method,
                        params: { id: stubHookRow.id },
                        body: {
                            url: stubHookRow.url,
                            secret: 'valid-secret-long-enough',
                            eventFilter: [eventType],
                        },
                    }),
                );
                expect(response.status).toBe(422);
                expect(response.headers.get('content-type')).toContain('application/problem+json');
                expect(mockInsertWebhookHook).not.toHaveBeenCalled();
                expect(mockUpdateWebhookHookWithSecret).not.toHaveBeenCalled();
                expect(mockUpdateWebhookHookWithoutSecret).not.toHaveBeenCalled();
            });
        }
    }

    it('keeps the existing empty-filter match-all semantics', async () => {
        const { WebhookCreateSchema, WebhookUpdateSchema } = await import('$lib/schemas/api-v1.js');
        const body = { url: stubHookRow.url, secret: 'valid-secret-long-enough', eventFilter: [] };
        expect(WebhookCreateSchema.parse(body).eventFilter).toEqual([]);
        expect(WebhookUpdateSchema.parse(body).eventFilter).toEqual([]);
    });
});
