// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const mocks = vi.hoisted(() => ({
    sql: vi.fn(async () => []),
    handler: vi.fn(async () => new Response('segment')),
}));
vi.mock('$lib/server/database', () => ({ getDb: () => mocks.sql }));
vi.mock('$lib/server/database/queries/media-items.queries.js', () => ({
    mediaItemExistsById: async () => true,
}));
vi.mock('$lib/server/cache/library-group-permissions-cache.js', async (original) => ({
    ...(await original<typeof import('$lib/server/cache/library-group-permissions-cache.js')>()),
    isMediaAccessible: async () => true,
}));
vi.mock('$lib/server/cache/valkey.js', () => ({
    publishMessage: async () => true,
    subscribeToChannel: async () => undefined,
}));
vi.mock('$lib/server/handlers/hls/lumastra-segment-handler.js', () => ({
    handleHlsSegment: mocks.handler,
}));
vi.mock('./silent-start', () => ({ disarmSilentStart: async () => undefined }));
import { serveJellyfinHlsSegment } from './hls-segment-route';

describe('HLS segment access hot path', () => {
    it('does not add a retirement read to the existing file-backed access checks', async () => {
        const url = new URL(
            'http://localhost/j/Videos/00000000-0000-4000-8000-000000000001/hls/0.ts',
        );
        const event = {
            url,
            request: new Request(url),
            locals: {
                user: {
                    userId: 'viewer',
                    username: 'viewer',
                    ownerIsAdmin: false,
                    isAgeRestricted: false,
                },
            },
        } as unknown as RequestEvent;
        expect(
            (await serveJellyfinHlsSegment(event, '00000000-0000-4000-8000-000000000001', '0.ts'))
                .status,
        ).toBe(200);
        expect(mocks.handler).toHaveBeenCalled();
        expect(mocks.sql).not.toHaveBeenCalled();
    });
});
