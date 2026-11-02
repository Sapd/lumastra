// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

vi.mock('$lib/server/database/queries/image-descriptor.queries.js', async () => {
    const { musicImageOwnerFixture } =
        await import('$lib/server/services/music/__tests__/image-fixtures.js');
    return {
        getImageDescriptorOwners: vi.fn(async (_sql: unknown, ids: string[]) =>
            ids.map((id) => musicImageOwnerFixture(id)),
        ),
    };
});

import { describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from '@sveltejs/kit';
import { MusicTrackDetailResponseSchema } from '$lib/schemas/api-music-responses';

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => ({})) },
}));
vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getTrackDetail: vi.fn(async () => ({
        id: 'track',
        title: 'Track',
        custom_metadata: {},
        custom_poster_url: '/cover.jpg',
        custom_backdrop_url: '/backdrop.jpg',
    })),
}));
vi.mock('$lib/server/database/queries/music-interactions.queries.js', () => ({
    getTrackFeedback: vi.fn(async () => null),
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn(async () => true),
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ debug: vi.fn() }) },
}));

import { GET } from './+server';
import { def } from '$lib/server/api/defs/music/tracks/[id]';

describe('track detail artwork surface', () => {
    it.each(['internal', 'v1'] as const)('keeps every artwork href on %s', async (surface) => {
        const base = surface === 'v1' ? '/api/v1' : '/api';
        const event = {
            params: { id: 'track' },
            locals: { user: { userId: 'user', username: 'listener' } },
            url: new URL(`https://example.test${base}/music/tracks/track`),
        } as unknown as Parameters<typeof GET>[0];
        // Exercise the public delegate too: it must preserve the v1 request path.
        const response =
            surface === 'v1'
                ? await def.handlers.GET!(event, { surface } as never)
                : await GET(event);
        expect(response.status).toBe(200);
        const { track } = MusicTrackDetailResponseSchema.parse(await response.json());
        expect(track.images.primary?.href).toContain(`${base}/media/track/images/poster?`);
        for (const image of Object.values(track.images)) {
            if (!image) continue;
            for (const href of [image.href, ...Object.values(image.variants ?? {})]) {
                expect(href).toMatch(new RegExp(`^${base}/media/`));
                if (surface === 'v1') expect(href).not.toMatch(/^\/api\/media\//);
            }
        }
    });
});
