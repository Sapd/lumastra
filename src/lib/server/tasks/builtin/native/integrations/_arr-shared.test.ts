// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@sapd/lumastra-plugin-sdk';

vi.mock('$lib/server/config.js', () => ({
    config: { SONARRURL: 'http://sonarr:8989/', SONARRAPIKEY: 'host-key' },
}));

import { sendArrTestNotification } from './_arr-shared';

function ctx(post: ReturnType<typeof vi.fn>): PluginContext {
    return {
        // A plugin-level copy must NOT be used — the host config is the one store.
        settings: async () => ({ SONARRURL: 'http://stale:1', SONARRAPIKEY: 'stale' }),
        http: { post },
        logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    } as unknown as PluginContext;
}

describe('sendArrTestNotification', () => {
    it('uses the host connection settings, not the integration settings', async () => {
        const post = vi.fn(async () => new Response('', { status: 200 }));
        await sendArrTestNotification(ctx(post), { type: 'test', payload: {} } as never, {
            id: 'sonarr',
            urlKey: 'SONARRURL',
            apiKeyKey: 'SONARRAPIKEY',
        });
        expect(post).toHaveBeenCalledWith(
            'http://sonarr:8989/api/v3/notification/test',
            expect.anything(),
            { headers: { 'X-Api-Key': 'host-key', 'Content-Type': 'application/json' } },
        );
    });
});
