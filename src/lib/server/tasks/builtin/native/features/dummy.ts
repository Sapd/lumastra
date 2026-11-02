// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Dummy feature plugin.
 *
 * A minimal reference implementation demonstrating all feature-plugin
 * capabilities against the SDK's FeatureDefinition contract. Use as a
 * template for new feature plugins.
 *
 * Controlled via PLUGIN_DUMMY_ENABLED env var:
 *   - unset → enabled in development, disabled in production
 *   - 'true' → always enabled
 *   - 'false' / anything else → always disabled
 *
 * Routes: GET /api/plugins/dummy/hello · GET /api/plugins/dummy/status
 */

import { defineFeature } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../../registry.js';
import { config } from '$lib/server/config.js';

// Module-level state shared across handler calls within the same process.
let initTime: number | null = null;
let initCount = 0;

function isEnabled(): boolean {
    return config.PLUGIN_DUMMY_ENABLED;
}

export const dummyFeature = defineFeature({
    id: 'dummy',

    settings: {
        fields: [
            {
                key: 'greeting',
                type: 'string',
                label: 'Greeting',
                description: 'Greeting message to return from the hello endpoint',
                default: 'Hello from Dummy Plugin!',
            },
            {
                key: 'debugMode',
                type: 'boolean',
                label: 'Debug Mode',
                description: 'Whether to log debug messages',
                default: false,
            },
            {
                key: 'cacheTtlSeconds',
                type: 'number',
                label: 'Cache TTL (seconds)',
                description: 'Cache TTL in seconds for plugin state',
                default: 300,
            },
        ],
    },

    async onStartup(ctx) {
        if (!isEnabled()) return;

        initCount++;
        initTime = Date.now();

        // ctx.settings() rejection must not abort startup — fall back to defaults.
        let settings: Record<string, unknown> = {};
        try {
            settings = await ctx.settings();
        } catch (err) {
            ctx.logger.warn('Dummy plugin: ctx.settings() failed, using defaults', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
        // Clamp non-positive TTL so cache.set never receives a nonsensical TTL.
        const rawTtl =
            typeof settings.cacheTtlSeconds === 'number' ? settings.cacheTtlSeconds : 300;
        const cacheTtlSeconds = rawTtl > 0 ? rawTtl : 300;
        const debugMode = settings.debugMode === true;

        ctx.logger.info('Dummy plugin initializing', { initCount });
        await ctx.cache?.set('dummy:init-time', String(initTime), cacheTtlSeconds * 1000);
        if (debugMode) {
            ctx.logger.debug('Dummy plugin debug mode enabled');
        }
    },

    routes: [
        {
            method: 'GET',
            path: '/api/plugins/dummy/hello',
            handler: async (ctx, _req) => {
                if (!isEnabled()) {
                    return Response.json({ error: 'Plugin not initialized' }, { status: 503 });
                }
                if (initTime === null) {
                    return Response.json({ error: 'Plugin not initialized' }, { status: 503 });
                }

                let settings: Record<string, unknown> = {};
                try {
                    settings = await ctx.settings();
                } catch (err) {
                    ctx.logger.warn('Dummy /hello: ctx.settings() failed, using defaults', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
                const greeting =
                    typeof settings.greeting === 'string'
                        ? settings.greeting
                        : 'Hello from Dummy Plugin!';

                return Response.json({
                    message: greeting,
                    timestamp: new Date().toISOString(),
                });
            },
        },
        {
            method: 'GET',
            path: '/api/plugins/dummy/status',
            handler: async (ctx, _req) => {
                if (!isEnabled()) {
                    return Response.json({ error: 'Plugin not initialized' }, { status: 503 });
                }
                if (initTime === null) {
                    return Response.json({ error: 'Plugin not initialized' }, { status: 503 });
                }

                let settings: Record<string, unknown> = {};
                try {
                    settings = await ctx.settings();
                } catch (err) {
                    ctx.logger.warn('Dummy /status: ctx.settings() failed, using defaults', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
                const cachedInitTime = (await ctx.cache?.get<string>('dummy:init-time')) ?? null;

                // parseInt('') / parseInt('not-a-number') is NaN; `new Date(NaN).toISOString()`
                // throws RangeError. Guard the conversion.
                let initTimeStr: string | null = null;
                if (cachedInitTime) {
                    const ts = parseInt(cachedInitTime, 10);
                    if (Number.isFinite(ts)) {
                        initTimeStr = new Date(ts).toISOString();
                    }
                }

                return Response.json({
                    pluginId: 'dummy',
                    version: '1.0.0',
                    enabled: isEnabled(),
                    initCount,
                    initTime: initTimeStr,
                    config: {
                        greeting: settings.greeting ?? 'Hello from Dummy Plugin!',
                        debugMode: settings.debugMode ?? false,
                        cacheTtlSeconds: settings.cacheTtlSeconds ?? 300,
                    },
                });
            },
        },
    ],
});

// Self-register so loadBuiltins() import is sufficient.
registry.registerFeature(dummyFeature);

// Exposed for tests only.
export const __testing = {
    getInitCount: () => initCount,
    getInitTime: () => initTime,
    resetState: () => {
        initCount = 0;
        initTime = null;
    },
};
