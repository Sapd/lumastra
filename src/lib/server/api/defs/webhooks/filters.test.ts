// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { WebhookCreateSchema, WebhookUpdateSchema } from '$lib/schemas/api-v1.js';

const mocks = vi.hoisted(() => ({ insert: vi.fn(), update: vi.fn(), get: vi.fn() }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/webhook.queries.js', () => ({
    insertWebhookHook: mocks.insert,
    updateWebhookHookWithoutSecret: mocks.update,
    updateWebhookHookWithSecret: mocks.update,
    getWebhookHookById: mocks.get,
    listWebhookHooks: vi.fn(),
    deleteWebhookHook: vi.fn(),
}));
vi.mock('$lib/server/tasks/secrets.js', () => ({
    encrypt: () => Buffer.from('encrypted'),
    deriveMasterKey: () => Buffer.alloc(32),
}));
vi.mock('$lib/server/crypto/master-key.js', () => ({ resolveMasterKey: () => 'test-key' }));
vi.mock('$lib/server/tasks/url-safety.js', () => ({ assertWebhookTargetUrl: vi.fn() }));
vi.mock('$lib/server/cache/valkey.js', () => ({ publishMessage: vi.fn() }));
vi.mock('$lib/server/tasks/webhook-outbox.js', () => ({
    WEBHOOK_HOOKS_INVALIDATE_CHANNEL: 'hooks',
    operatorWebhookSecretContext: (id: string) => id,
}));

const { def: create, rowToWebhook } = await import('./index.js');
const { def: update } = await import('./[id].js');
const id = '11111111-1111-4111-8111-111111111111';
const groups = ['22222222-2222-4222-8222-222222222222'];
const payload = {
    url: 'https://example.com/hook',
    secret: 'a-secret-with-enough-characters',
    eventFilter: ['org.lumastra.task.run.completed'] as const,
    libraryGroupIds: groups,
};
beforeEach(() => {
    vi.clearAllMocks();
    mocks.insert.mockResolvedValue(id);
    mocks.update.mockResolvedValue(id);
    mocks.get.mockResolvedValue({
        id,
        url: payload.url,
        event_filter: payload.eventFilter,
        library_group_filter: groups,
        active: true,
        include_progress: false,
        secret_encrypted: Buffer.from('encrypted'),
        created_by: 'admin',
        created_at: new Date().toISOString(),
        batch_window_seconds: 60,
        max_batch_size: 25,
    });
});

describe('webhook libraryGroupIds subscriptions', () => {
    it.each(['internal', 'v1'] as const)(
        'preserves storage and response on %s',
        async (surface) => {
            const event = {
                params: { id },
                locals: { user: { username: 'admin' } },
            } as unknown as RequestEvent;
            const created = await create.handlers.POST!(event, {
                surface,
                input: { body: WebhookCreateSchema.parse(payload) },
            } as never);
            expect(created.status).toBe(201);
            expect(mocks.insert).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({
                    libraryGroupFilter: groups,
                    eventFilter: payload.eventFilter,
                }),
            );
            const { secret: _secret, ...edit } = payload;
            const changed = await update.handlers.PUT!(event, {
                surface,
                input: { body: WebhookUpdateSchema.parse(edit) },
            } as never);
            expect(changed.status).toBe(200);
            expect(mocks.update).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({
                    libraryGroupFilter: groups,
                    eventFilter: payload.eventFilter,
                }),
            );
            for (const response of [created, changed]) {
                const body = await response.json();
                expect(body.libraryGroupIds).toEqual(groups);
                expect(body.eventFilter).toEqual(payload.eventFilter);
                expect(body).not.toHaveProperty('libraryGroupFilter');
                expect(response.headers.get('Location')).toBe(
                    `${surface === 'v1' ? '/api/v1' : '/api'}/webhooks/${id}`,
                );
            }
        },
    );
    it('rejects the retired spelling instead of clearing the subscription', () => {
        const { libraryGroupIds: _groups, ...rest } = payload;
        for (const schema of [WebhookCreateSchema, WebhookUpdateSchema]) {
            expect(schema.safeParse({ ...rest, libraryGroupFilter: groups }).success).toBe(false);
        }
    });
});

it('serializes delivery state and discards secret-bearing historical error bodies', () => {
    const row = {
        id,
        url: payload.url,
        event_filter: [],
        created_at: new Date(),
        last_status: 401,
        last_error: 'private-key https://user:pass@example.com/?token=secret',
        last_delivered_at: new Date('2026-01-01'),
        dead_count: 3,
    };
    const result = rowToWebhook(row as never);
    expect(result).toMatchObject({
        lastStatus: 401,
        deadCount: 3,
        lastDeliveredAt: row.last_delivered_at,
    });
    expect(result.lastError).toMatch(/401.*Authentication rejected/);
    expect(JSON.stringify(result)).not.toMatch(/private-key|user:|pass@|token=secret/);
});
