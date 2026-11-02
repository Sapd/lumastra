// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Dummy integration native tests (Wave 6.5-G).
 *
 * Ported from plugins/builtin/integrations/dummy-integration.plugin.test.ts
 * using the SDK PluginContext shape instead of the legacy plugin shape.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mockLogger, mockHttpClient } from '@sapd/lumastra-plugin-sdk-testing';
import { dummyIntegration, __testing } from './dummy-integration.js';
import type { PluginContext } from '@sapd/lumastra-plugin-sdk';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePluginContext(
    settingsOverrides: Record<string, unknown> = {},
    http = mockHttpClient(),
): PluginContext {
    const logger = mockLogger();
    const signal = new AbortController().signal;

    return {
        sql: {} as PluginContext['sql'],
        logger,
        http,
        signal,
        settings: async () => ({
            notificationLatencyMs: 0, // zero latency in tests
            simulateNotificationFailure: false,
            simulateSignatureFailure: false,
            ...settingsOverrides,
        }),
        secrets: {
            get: async (_key: string) => {
                throw new Error('not mocked');
            },
            getOptional: async (_key: string) => null,
            getUser: async (_userId: string, _key: string) => {
                throw new Error('not mocked');
            },
        },
        userCredentials: {
            get: async () => null,
            set: async () => undefined,
            delete: async () => undefined,
            listKeys: async () => [],
            listLinkedUsers: async () => [],
            listUsersWithKey: async () => [],
        },
        catalog: {
            upsertExternalId: async () => undefined,
            findByExternalId: async () => null,
        },
        mediaItems: {
            getById: async () => null,
            search: async () => [],
        },
        mediaFiles: {
            findByPath: async () => null,
        },
        playlists: {
            listOwned: async () => [],
            create: async () => 1,
            replaceItems: async () => 0,
        },
        mediaSegments: {
            list: async () => [],
            upsert: async () => undefined,
            clear: async () => undefined,
        },
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dummyIntegration (native)', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = {
            ...originalEnv,
            PLUGIN_DUMMY_INTEGRATION_ENABLED: 'true',
        };
        __testing.resetState();
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe('defineIntegration contract', () => {
        it('has correct id', () => {
            expect(dummyIntegration.id).toBe('dummy-integration');
        });

        it('has settings fields', () => {
            expect(dummyIntegration.settings?.fields.length).toBeGreaterThan(0);
        });

        it('has handleWebhook and sendNotification', () => {
            expect(typeof dummyIntegration.handleWebhook).toBe('function');
            expect(typeof dummyIntegration.sendNotification).toBe('function');
        });
    });

    describe('isEnabled', () => {
        it('respects PLUGIN_DUMMY_INTEGRATION_ENABLED=true', () => {
            expect(__testing.isEnabled()).toBe(true);
        });

        it('respects PLUGIN_DUMMY_INTEGRATION_ENABLED=false', () => {
            process.env.PLUGIN_DUMMY_INTEGRATION_ENABLED = 'false';
            expect(__testing.isEnabled()).toBe(false);
        });

        it('respects DISABLE_DUMMY_INTEGRATION=true', () => {
            process.env.DISABLE_DUMMY_INTEGRATION = 'true';
            expect(__testing.isEnabled()).toBe(false);
        });

        it('defaults to dev-only when env var absent', () => {
            delete process.env.PLUGIN_DUMMY_INTEGRATION_ENABLED;
            delete process.env.DISABLE_DUMMY_INTEGRATION;
            const expected = process.env.NODE_ENV === 'development';
            expect(__testing.isEnabled()).toBe(expected);
        });
    });

    describe('handleWebhook', () => {
        it('returns success with extracted eventType from event field', async () => {
            const ctx = makePluginContext();
            const result = await dummyIntegration.handleWebhook!(ctx, {
                event: 'test.event',
                data: { foo: 'bar' },
            });

            expect((result as Record<string, unknown>)['success']).toBe(true);
            const events = (result as Record<string, unknown>)['events'] as Array<
                Record<string, unknown>
            >;
            expect(events[0]['type']).toBe('test.event');
        });

        it('extracts eventType from type field', async () => {
            const ctx = makePluginContext();
            const result = await dummyIntegration.handleWebhook!(ctx, {
                type: 'media.added',
            });

            const events = (result as Record<string, unknown>)['events'] as Array<
                Record<string, unknown>
            >;
            expect(events[0]['type']).toBe('media.added');
        });

        it('tracks webhooks received', async () => {
            const ctx = makePluginContext();
            await dummyIntegration.handleWebhook!(ctx, {});
            expect(__testing.getWebhooksReceived()).toBe(1);

            await dummyIntegration.handleWebhook!(ctx, {});
            expect(__testing.getWebhooksReceived()).toBe(2);
        });

        it('returns failure on signature simulation', async () => {
            const ctx = makePluginContext({ simulateSignatureFailure: true });
            const result = await dummyIntegration.handleWebhook!(ctx, {
                event: 'x',
            });

            expect((result as Record<string, unknown>)['success']).toBe(false);
            expect((result as Record<string, unknown>)['error']).toMatch(/signature/i);
        });

        it('returns disabled error when not enabled', async () => {
            process.env.PLUGIN_DUMMY_INTEGRATION_ENABLED = 'false';
            const ctx = makePluginContext();
            const result = await dummyIntegration.handleWebhook!(ctx, {});

            expect((result as Record<string, unknown>)['success']).toBe(false);
        });

        it('handles non-object payload gracefully', async () => {
            const ctx = makePluginContext();
            const result = await dummyIntegration.handleWebhook!(ctx, 'not-an-object');
            // non-object is treated as empty body — eventType defaults to 'unknown'
            const events = (result as Record<string, unknown>)['events'] as Array<
                Record<string, unknown>
            >;
            expect(events[0]['type']).toBe('unknown');
        });
    });

    describe('sendNotification', () => {
        it('sends notification successfully', async () => {
            const ctx = makePluginContext({ notificationLatencyMs: 0 });
            await expect(
                dummyIntegration.sendNotification!(ctx, {
                    type: 'media.added',
                    payload: {},
                }),
            ).resolves.toBeUndefined();
        });

        it('tracks notifications sent', async () => {
            const ctx = makePluginContext({ notificationLatencyMs: 0 });
            await dummyIntegration.sendNotification!(ctx, {
                type: 'test',
                payload: {},
            });
            expect(__testing.getNotificationsSent()).toBe(1);

            await dummyIntegration.sendNotification!(ctx, {
                type: 'test',
                payload: {},
            });
            expect(__testing.getNotificationsSent()).toBe(2);
        });

        it('throws when simulating notification failure', async () => {
            const ctx = makePluginContext({
                notificationLatencyMs: 0,
                simulateNotificationFailure: true,
            });
            await expect(
                dummyIntegration.sendNotification!(ctx, {
                    type: 'test',
                    payload: {},
                }),
            ).rejects.toThrow(/simulated/i);
        });

        it('is a no-op when disabled', async () => {
            process.env.PLUGIN_DUMMY_INTEGRATION_ENABLED = 'false';
            const ctx = makePluginContext();
            await expect(
                dummyIntegration.sendNotification!(ctx, {
                    type: 'test',
                    payload: {},
                }),
            ).resolves.toBeUndefined();
            expect(__testing.getNotificationsSent()).toBe(0);
        });
    });
});
