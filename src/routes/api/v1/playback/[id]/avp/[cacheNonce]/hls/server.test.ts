// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.mock('$lib/server/middleware/auth.js', () => ({ requireAuth: (handler: unknown) => handler }));
vi.mock('$lib/server/middleware/id-resolution.js', () => ({
    withIdResolution: (handler: unknown) => handler,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    withMediaAccess: (handler: unknown) => handler,
}));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (handler: unknown) => handler,
}));
import { GET } from './+server';

describe('AVPlayer HLS redirect', () => {
    it('preserves grant, playback session and seek parameters in its 307 Location', async () => {
        const url = new URL(
            'https://player.test/api/v1/playback/item/avp/nonce/hls?grant=stream_secret&PlaySessionId=session&StartTimeTicks=120000',
        );
        const response = await GET({ url } as RequestEvent as Parameters<typeof GET>[0]);
        expect(response.status).toBe(307);
        const target = new URL(response.headers.get('Location')!);
        expect(target.pathname).toBe('/api/v1/playback/item/hls');
        expect(target.searchParams.get('grant')).toBe('stream_secret');
        expect(target.search).toBe(url.search);
    });
});
