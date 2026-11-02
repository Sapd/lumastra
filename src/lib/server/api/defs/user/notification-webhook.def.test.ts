// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Save-time behaviour of `POST /me/notification-webhook`.
 *
 * The one that matters: **the SSRF guard runs before anything is stored.**
 * Without it a user pastes `http://192.168.1.5/hook`, the save succeeds, and
 * their first indication of a problem is a dead outbox row on an admin screen
 * they cannot open. The assertion is therefore not just "it 422s" but "nothing
 * reached the database" — a guard that rejects the response while persisting the
 * row would be worse than no guard at all.
 *
 * Deliberately NOT re-testing what the guard classifies as private: that is
 * `tasks/url-safety.ts`'s own coverage, and duplicating its table here would
 * create a second place to update when a range is added.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockConfig = { FEATURE_USER_NOTIFICATION_WEBHOOKS: true };
const mockUpsert = vi.fn();
const mockDelete = vi.fn();
const mockGet = vi.fn();

vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
    LUMASTRA_MASTER_KEY: 'a'.repeat(64),
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => ({}) as unknown),
}));

vi.mock('$lib/server/tasks/secrets.js', () => ({
    encrypt: vi.fn(() => Buffer.from('encrypted')),
    deriveMasterKey: vi.fn(() => Buffer.alloc(32)),
}));

vi.mock('$lib/server/database/queries/user-notification-webhooks.queries.js', () => ({
    getUserNotificationWebhook: (...args: unknown[]) => mockGet(...args),
    upsertUserNotificationWebhook: (...args: unknown[]) => mockUpsert(...args),
    deleteUserNotificationWebhook: (...args: unknown[]) => mockDelete(...args),
}));

const { def } = await import('./notification-webhook.js');

function makeEvent(): RequestEvent {
    return {
        locals: {
            user: { userId: 'user-1', username: 'alice' },
            // Set/clear need an interactive session (credential mutation).
            principal: { kind: 'session', userId: 'user-1', username: 'alice', scopes: [] },
        },
        url: new URL('http://localhost/api/me/notification-webhook'),
        params: {},
        request: {} as unknown as Request,
    } as unknown as RequestEvent;
}

/** The def's handlers take (event, ctx); ctx.input.body is what mount() parses. */
function ctxWith(url: string): { input: { body: { url: string } } } {
    return { input: { body: { url } } };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.FEATURE_USER_NOTIFICATION_WEBHOOKS = true;
    mockUpsert.mockResolvedValue({
        id: 'hook-1',
        user_id: 'user-1',
        url: 'https://ntfy.example.com/lumastra',
        created_at: new Date('2026-08-05T00:00:00Z'),
        updated_at: new Date('2026-08-05T00:00:00Z'),
    });
    mockDelete.mockResolvedValue(true);
    mockGet.mockResolvedValue(null);
});

describe('POST /me/notification-webhook — SSRF guard at save time', () => {
    const rejected = [
        ['loopback', 'http://127.0.0.1:8080/hook'],
        ['localhost by name', 'http://localhost:4000/hook'],
        ['RFC1918', 'http://192.168.1.5/hook'],
        ['link-local / cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
        ['IPv6 loopback', 'http://[::1]/hook'],
        ['non-http scheme', 'file:///etc/passwd'],
        ['embedded credentials', 'https://user:pass@example.com/hook'],
    ] as const;

    for (const [label, url] of rejected) {
        it(`rejects ${label} and stores nothing`, async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test ctx stub
            const res = await def.handlers.POST!(makeEvent(), ctxWith(url) as any);

            expect(res.status).toBe(422);
            expect(mockUpsert).not.toHaveBeenCalled();
        });
    }

    it('accepts a public https URL and returns the secret exactly once', async () => {
        const res = await def.handlers.POST!(
            makeEvent(),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test ctx stub
            ctxWith('https://ntfy.example.com/lumastra') as any,
        );

        expect(res.status).toBe(200);
        expect(mockUpsert).toHaveBeenCalledTimes(1);

        const body = (await res.json()) as Record<string, unknown>;
        expect(body.configured).toBe(true);
        expect(typeof body.secret).toBe('string');
        expect((body.secret as string).length).toBeGreaterThan(0);
    });

    it('never returns the secret on a read', async () => {
        mockGet.mockResolvedValue({
            id: 'hook-1',
            user_id: 'user-1',
            url: 'https://ntfy.example.com/lumastra',
            created_at: new Date(),
            updated_at: new Date(),
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test ctx stub
        const res = await def.handlers.GET!(makeEvent(), {} as any);
        const body = (await res.json()) as Record<string, unknown>;

        expect(body.url).toBe('https://ntfy.example.com/lumastra');
        expect(body.secret).toBeUndefined();
    });
});

describe('POST /me/notification-webhook — admin gate', () => {
    it('refuses to store an endpoint while the feature is disabled', async () => {
        // Otherwise a disabled install quietly accumulates endpoints that all
        // start firing the moment an operator flips the switch on.
        mockConfig.FEATURE_USER_NOTIFICATION_WEBHOOKS = false;

        const res = await def.handlers.POST!(
            makeEvent(),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test ctx stub
            ctxWith('https://ntfy.example.com/lumastra') as any,
        );

        expect(res.status).toBe(404);
        expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('declares a body schema that accepts {} so DELETE survives mount() validation', () => {
        // mount() body-validates POST/PUT/PATCH **and DELETE**, against the def's
        // single `request.body`. A DELETE arrives with no body, which decodes to
        // `{}` — so a required `url` here would 422 every clear attempt before
        // the handler ran, and the handler tests above (which call the handler
        // directly) cannot see that. This assertion is the guard for it.
        const parsed = def.request?.body?.safeParse({});
        expect(parsed?.success).toBe(true);
    });

    it('still lets a user clear their endpoint while the feature is disabled', async () => {
        mockConfig.FEATURE_USER_NOTIFICATION_WEBHOOKS = false;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test ctx stub
        const res = await def.handlers.DELETE!(makeEvent(), {} as any);

        expect(res.status).toBe(200);
        expect(mockDelete).toHaveBeenCalledTimes(1);
    });
});

describe('P3 replacement secret semantics', () => {
    it('rotates the secret even when the URL is unchanged', async () => {
        const secrets: string[] = [];
        for (let i = 0; i < 2; i++) {
            const response = await def.handlers.POST!(
                makeEvent(),
                ctxWith('https://ntfy.example.com/lumastra') as never,
            );
            expect(response.status).toBe(200);
            secrets.push(((await response.json()) as { secret: string }).secret);
        }
        expect(secrets[0]).toMatch(/^[a-f0-9]{64}$/);
        expect(secrets[1]).not.toBe(secrets[0]);
        expect(mockUpsert).toHaveBeenCalledTimes(2);
    });
    it('requires url in the POST-specific schema and accepts body-less DELETE', () => {
        expect(def.docs!.POST!.body!.safeParse({}).success).toBe(false);
        expect(def.docs!.POST!.body!.parse({ url: 'https://example.com/hook' })).toEqual({
            url: 'https://example.com/hook',
        });
        expect(def.request!.body!.safeParse({}).success).toBe(true);
        expect(def.request!.bodyMethods).toEqual(['POST']);
    });
});
