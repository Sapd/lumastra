// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ start: vi.fn() }));

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return { ...actual, features: { ...actual.features, ffmpegAvailable: true } };
});
vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/middleware/id-resolution.js', () => ({
    withIdResolution: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    withMediaAccess: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => ({})) },
}));
vi.mock('$lib/server/services/session-kill.service.js', () => ({
    checkSessionKickCooldown: vi.fn(async () => ({ kicked: false })),
}));
vi.mock('$lib/server/utils/client-ip.js', () => ({ getClientIpFromRequest: () => '203.0.113.1' }));
vi.mock('$lib/server/services/hls/playback.service.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/services/hls/playback.service.js')>()),
    startHlsPlayback: h.start,
}));

import { HlsPlaybackError } from '$lib/server/services/hls/playback.service.js';
import { GET } from './+server.js';
import { GET as v1GET } from '../../../../api/v1/playback/[id]/hls/+server.js';

const ITEM = '00000000-0000-4000-a000-000000000001';

function event(surface: 'web' | 'v1'): Parameters<typeof GET>[0] {
    const url = new URL(
        `https://app.example/api/${surface === 'v1' ? 'v1/' : ''}playback/${ITEM}/hls?PlaySessionId=ps-1`,
    );
    return {
        url,
        request: new Request(url),
        params: surface === 'v1' ? { id: ITEM } : { itemId: ITEM },
        locals: {
            resolvedIds: { internalId: ITEM },
            user: { username: 'alice', userId: 'uid-alice', ownerIsAdmin: false },
        },
        getClientAddress: () => '203.0.113.1',
    } as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
    h.start.mockReset();
});

describe.each([
    ['web', GET],
    ['v1', v1GET],
] as const)('%s HLS admission response', (surface, handler) => {
    it.each(['transcode_capacity', 'transcode_load_shed'])(
        'forwards the retry delay and refusal diagnostic for %s',
        async (code) => {
            h.start.mockRejectedValue(
                new HlsPlaybackError(JSON.stringify({ error: code, retry_after: 30 }), 503, 30),
            );
            const res = await handler(event(surface));
            expect(res.status).toBe(503);
            expect(res.headers.get('Retry-After')).toBe('30');
            expect(res.headers.get('Content-Type')).toBe('application/problem+json');
            expect(res.headers.get('X-Lumastra-Diagnostic-Code')).toBe('concurrency-limit');
            expect(await res.json()).toMatchObject({
                code: 'dependency_unavailable',
                reason: code,
                retryAfter: 30,
                status: 503,
            });
        },
    );
});
