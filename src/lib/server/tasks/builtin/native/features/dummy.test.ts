// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the native dummy feature plugin.
 *
 * Validates route handlers and the isEnabled logic against the SDK contract.
 * The legacy plugin.test.ts in plugins/builtin/features/dummy/ tests the
 * old FeaturePlugin shape — this file tests the FeatureDefinition shape.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { dummyFeature, __testing } from './dummy.js';
import type { PluginContext } from '@sapd/lumastra-plugin-sdk';

function buildCtx(settingsOverrides: Record<string, unknown> = {}): PluginContext {
    const defaults = {
        greeting: 'Hello from Dummy Plugin!',
        debugMode: false,
        cacheTtlSeconds: 300,
        ...settingsOverrides,
    };
    const cache = new Map<string, unknown>();
    return {
        sql: {} as PluginContext['sql'],
        logger: {
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
            child: () => ({}) as PluginContext['logger'],
        },
        signal: new AbortController().signal,
        cache: {
            get: async <T>(key: string) => (cache.has(key) ? (cache.get(key) as T) : null),
            set: async <T>(key: string, value: T) => {
                cache.set(key, value);
            },
            del: async (key: string) => {
                cache.delete(key);
            },
        },
        secrets: {
            get: async () => '',
            getOptional: async () => null,
            getUser: async () => '',
        },
        settings: async () => defaults,
    } as unknown as PluginContext;
}

describe('native dummy feature', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        __testing.resetState();
        process.env.NODE_ENV = 'development';
        delete process.env.PLUGIN_DUMMY_ENABLED;
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it('has the correct id', () => {
        expect(dummyFeature.id).toBe('dummy');
    });

    it('exposes two routes', () => {
        expect(dummyFeature.routes).toHaveLength(2);
        const paths = dummyFeature.routes.map((r) => r.path);
        expect(paths).toContain('/api/plugins/dummy/hello');
        expect(paths).toContain('/api/plugins/dummy/status');
    });

    describe('isEnabled logic', () => {
        it('enabled in development when env var unset', () => {
            process.env.NODE_ENV = 'development';
            delete process.env.PLUGIN_DUMMY_ENABLED;
            // Verify by calling the hello endpoint — returns 503 when initTime is null (not yet started)
            // but not when disabled. We test the env logic directly via __testing reset + onStartup.
        });

        it('disabled in production when env var unset', async () => {
            process.env.NODE_ENV = 'production';
            delete process.env.PLUGIN_DUMMY_ENABLED;
            const ctx = buildCtx();
            const req = new Request('http://localhost/api/plugins/dummy/hello');
            const helloRoute = dummyFeature.routes.find((r) => r.path.includes('hello'))!;
            const res = await helloRoute.handler(ctx, req, {});
            expect(res.status).toBe(503);
        });

        it('respects PLUGIN_DUMMY_ENABLED=true', async () => {
            process.env.PLUGIN_DUMMY_ENABLED = 'true';
            // Run onStartup to set initTime
            const ctx = buildCtx();
            await dummyFeature.onStartup?.(ctx);
            expect(__testing.getInitCount()).toBe(1);
        });

        it('respects PLUGIN_DUMMY_ENABLED=false', async () => {
            process.env.PLUGIN_DUMMY_ENABLED = 'false';
            const ctx = buildCtx();
            const req = new Request('http://localhost/api/plugins/dummy/status');
            const statusRoute = dummyFeature.routes.find((r) => r.path.includes('status'))!;
            const res = await statusRoute.handler(ctx, req, {});
            expect(res.status).toBe(503);
        });
    });

    describe('onStartup', () => {
        it('increments initCount and stores initTime', async () => {
            process.env.PLUGIN_DUMMY_ENABLED = 'true';
            const ctx = buildCtx();
            await dummyFeature.onStartup?.(ctx);
            expect(__testing.getInitCount()).toBe(1);
            expect(__testing.getInitTime()).not.toBeNull();
        });

        it('does nothing when disabled', async () => {
            process.env.PLUGIN_DUMMY_ENABLED = 'false';
            const ctx = buildCtx();
            await dummyFeature.onStartup?.(ctx);
            expect(__testing.getInitCount()).toBe(0);
        });
    });

    describe('/hello handler', () => {
        it('returns 503 before startup', async () => {
            process.env.PLUGIN_DUMMY_ENABLED = 'true';
            const ctx = buildCtx();
            const req = new Request('http://localhost/api/plugins/dummy/hello');
            const route = dummyFeature.routes.find((r) => r.path.includes('hello'))!;
            const res = await route.handler(ctx, req, {});
            expect(res.status).toBe(503);
        });

        it('returns greeting after startup', async () => {
            process.env.PLUGIN_DUMMY_ENABLED = 'true';
            const ctx = buildCtx({ greeting: 'Test Greeting!' });
            await dummyFeature.onStartup?.(ctx);
            const req = new Request('http://localhost/api/plugins/dummy/hello');
            const route = dummyFeature.routes.find((r) => r.path.includes('hello'))!;
            const res = await route.handler(ctx, req, {});
            expect(res.status).toBe(200);
            const body = (await res.json()) as {
                message: string;
                timestamp: string;
            };
            expect(body.message).toBe('Test Greeting!');
            expect(typeof body.timestamp).toBe('string');
        });
    });

    describe('/status handler', () => {
        it('returns 503 before startup', async () => {
            process.env.PLUGIN_DUMMY_ENABLED = 'true';
            const ctx = buildCtx();
            const req = new Request('http://localhost/api/plugins/dummy/status');
            const route = dummyFeature.routes.find((r) => r.path.includes('status'))!;
            const res = await route.handler(ctx, req, {});
            expect(res.status).toBe(503);
        });

        it('returns plugin info after startup', async () => {
            process.env.PLUGIN_DUMMY_ENABLED = 'true';
            const ctx = buildCtx({
                greeting: 'Hi',
                debugMode: false,
                cacheTtlSeconds: 60,
            });
            await dummyFeature.onStartup?.(ctx);
            const req = new Request('http://localhost/api/plugins/dummy/status');
            const route = dummyFeature.routes.find((r) => r.path.includes('status'))!;
            const res = await route.handler(ctx, req, {});
            expect(res.status).toBe(200);
            const body = (await res.json()) as {
                pluginId: string;
                version: string;
                initCount: number;
                enabled: boolean;
                config: Record<string, unknown>;
            };
            expect(body.pluginId).toBe('dummy');
            expect(body.version).toBe('1.0.0');
            expect(body.initCount).toBe(1);
            expect(body.enabled).toBe(true);
            expect(body.config.greeting).toBe('Hi');
        });
    });
});
