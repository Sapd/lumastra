// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every session-authenticated /j/Audio media route refuses PATs: the exported
 * GET (or, for stream.{container}, each of its two branches) must run behind
 * `withJellyfinAuth(…, { pat: 'deny' })`. The stand-in wrapper stamps the
 * options it was built with onto the response, so the assertion is on the
 * wrapper that actually served the request, not on a list of calls.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (_handler: unknown, options?: unknown) => async (): Promise<Response> =>
        new Response(null, {
            status: 204,
            headers: { 'x-auth-options': JSON.stringify(options ?? null) },
        }),
}));
vi.mock('$lib/server/jellyfin-compat/audio-hls', () => ({
    handleAudioMasterPlaylist: vi.fn(),
    handleAudioMediaPlaylist: vi.fn(),
}));
vi.mock('$lib/server/jellyfin-compat/hls-segment-route', () => ({
    serveJellyfinHlsSegment: vi.fn(),
}));
vi.mock('$lib/server/handlers/hls/lumastra-segment-handler.js', () => ({
    handleHlsOptions: vi.fn(),
}));
vi.mock('$lib/server/jellyfin-compat/audio-stream', () => ({
    // No play token: the Static branch falls through to the session wrapper.
    serveAudioPlayToken: vi.fn(async () => null),
    serveAuthenticatedAudioStream: vi.fn(),
}));
vi.mock('$lib/server/jellyfin-compat/audio-stream-container', async (orig) => {
    const actual =
        await orig<
            typeof import('$lib/server/jellyfin-compat/audio-stream-container')
        >();
    return { ...actual, serveAudioStreamByContainer: vi.fn() };
});

const ITEM = '00000000-0000-4000-a000-000000000001';

function event(path: string, params: Record<string, string>): RequestEvent {
    const url = new URL(`https://app.example/j/Audio/${ITEM}/${path}`);
    return {
        url,
        request: new Request(url),
        params: { itemId: ITEM, ...params },
        locals: {},
    } as unknown as RequestEvent;
}

async function authOptions(handler: unknown, e: RequestEvent): Promise<unknown> {
    const res = await (handler as (e: RequestEvent) => Promise<Response>)(e);
    return JSON.parse(res.headers.get('x-auth-options') ?? 'null');
}

describe('/j/Audio session routes refuse PATs', () => {
    it('stream.{container}: the Static branch and the direct/transcode branch', async () => {
        const { GET } = await import('./stream.[container]/+server');
        expect(
            await authOptions(GET, event('stream.mp3?Static=true', { container: 'mp3' })),
        ).toEqual({ pat: 'deny' });
        expect(await authOptions(GET, event('stream.mp3', { container: 'mp3' }))).toEqual({
            pat: 'deny',
        });
    });

    it('master.m3u8', async () => {
        const { GET } = await import('./master.m3u8/+server');
        expect(await authOptions(GET, event('master.m3u8', {}))).toEqual({ pat: 'deny' });
    });

    it('main.m3u8', async () => {
        const { GET } = await import('./main.m3u8/+server');
        expect(await authOptions(GET, event('main.m3u8', {}))).toEqual({ pat: 'deny' });
    });

    it('hls1/{playlistId}/{segment}', async () => {
        const { GET } = await import('./hls1/[playlistId]/[...segment]/+server');
        expect(
            await authOptions(
                GET,
                event('hls1/main/0.ts', { playlistId: 'main', segment: '0.ts' }),
            ),
        ).toEqual({ pat: 'deny' });
    });
});
