// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the jellyseerr integration's circuit-breaker wrapping (H21).
 *
 * `sendNotification`'s outbound call is wrapped in
 * `getBreaker('jellyseerr-tasks').execute(...)`. After FAILURE_THRESHOLD (5)
 * consecutive transient failures the breaker opens and subsequent calls
 * fast-fail without invoking `ctx.http`.
 *
 * The circuit-breaker registry is a module-level singleton, so each test
 * resets the module graph (`vi.resetModules()`) and re-imports fresh via
 * dynamic `import()` to get an isolated breaker registry per test.
 *
 * Run: npx vitest run src/lib/server/tasks/builtin/native/integrations/jellyseerr.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PluginContext, NotificationEvent } from '@sapd/lumastra-plugin-sdk';

// The connection comes from the host config (Settings → Providers), not the
// integration's own settings. The registry is stubbed so the partial config
// mock is all the module graph needs.
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { registerIntegration: vi.fn() },
}));
vi.mock('$lib/server/config.js', () => ({
    config: {
        SEERRURL: 'https://jellyseerr.example.com',
        SEERRAPIKEY: 'test-key',
    },
}));

// FAILURE_THRESHOLD from utils/circuit-breaker.ts module constants.
const FAILURE_THRESHOLD = 5;

function makeCtx(
    postImpl: () => Promise<Response>,
    settingsOverrides: Record<string, unknown> = {},
): { ctx: PluginContext; post: ReturnType<typeof vi.fn> } {
    const post = vi.fn(postImpl);
    const ctx = {
        sql: {} as PluginContext['sql'],
        logger: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            child: () => ctx.logger,
        },
        http: {
            get: vi.fn(),
            post,
        },
        signal: new AbortController().signal,
        settings: async () => ({ ...settingsOverrides }),
        secrets: {
            get: async () => {
                throw new Error('not mocked');
            },
            getOptional: async () => null,
            getUser: async () => {
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
    } as unknown as PluginContext;
    return { ctx, post };
}

const testEvent: NotificationEvent = {
    type: 'media.added',
    payload: {},
};

describe('jellyseerr integration — circuit breaker (H21)', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('opens after N consecutive failures; subsequent calls fast-fail without calling ctx.http', async () => {
        const { jellyseerrIntegration } = await import('./jellyseerr.js');
        const { ctx, post: postFn } = makeCtx(async () => {
            throw new Error('ECONNREFUSED');
        });

        for (let i = 0; i < FAILURE_THRESHOLD; i++) {
            await expect(jellyseerrIntegration.sendNotification!(ctx, testEvent)).rejects.toThrow(
                /jellyseerr notification network error/,
            );
        }
        expect(postFn).toHaveBeenCalledTimes(FAILURE_THRESHOLD);

        // Breaker is now OPEN — the next call must fast-fail without hitting ctx.http.
        await expect(jellyseerrIntegration.sendNotification!(ctx, testEvent)).rejects.toThrow(
            /Circuit open for dependency 'jellyseerr-tasks'/,
        );
        expect(postFn).toHaveBeenCalledTimes(FAILURE_THRESHOLD);
    });

    it('succeeds and calls ctx.http when the circuit is closed', async () => {
        const { jellyseerrIntegration } = await import('./jellyseerr.js');
        const { ctx, post } = makeCtx(async () => new Response(null, { status: 200 }));

        await expect(
            jellyseerrIntegration.sendNotification!(ctx, testEvent),
        ).resolves.toBeUndefined();
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('a single transient failure below the threshold still calls ctx.http next time (breaker stays closed)', async () => {
        const { jellyseerrIntegration } = await import('./jellyseerr.js');
        let call = 0;
        const { ctx, post } = makeCtx(async () => {
            call++;
            if (call === 1) throw new Error('ECONNREFUSED');
            return new Response(null, { status: 200 });
        });

        await expect(jellyseerrIntegration.sendNotification!(ctx, testEvent)).rejects.toThrow(
            /jellyseerr notification network error/,
        );
        await expect(
            jellyseerrIntegration.sendNotification!(ctx, testEvent),
        ).resolves.toBeUndefined();
        expect(post).toHaveBeenCalledTimes(2);
    });
});
