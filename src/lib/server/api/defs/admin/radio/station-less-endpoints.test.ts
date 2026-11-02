// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The station-less admin radio endpoints the create form uses before a
 * station exists: metadata preview and stream info (ICY prefill).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const previewNowPlaying = vi.fn();
vi.mock('$lib/server/services/radio-metadata/index.js', () => ({
    previewNowPlaying: (...args: unknown[]) => previewNowPlaying(...args),
}));
const getStreamInfo = vi.fn();
vi.mock('$lib/server/services/icy-metadata.service.js', () => ({
    getStreamInfo: (...args: unknown[]) => getStreamInfo(...args),
}));

import { def as previewDef } from './metadata/preview.js';
import { def as streamInfoDef } from './stream-info.js';

const NIL = '00000000-0000-0000-0000-000000000000';
const SOURCE = {
    url: 'https://radio.example/now.json',
    format: 'json' as const,
    jsonPaths: { title: '$.title' },
};

const event = {} as RequestEvent;
function ctx(body: unknown): never {
    return { surface: 'internal', input: { body } } as never;
}

describe('POST /api/admin/radio/metadata/preview', () => {
    beforeEach(() => previewNowPlaying.mockReset());

    it('previews against the nil station id and the given stream URL', async () => {
        previewNowPlaying.mockResolvedValue({
            stationId: NIL,
            fetchedAt: '2026-10-06T00:00:00.000Z',
            source: 'url',
            track: { title: 'Song' },
        });
        const res = await previewDef.handlers.POST!(
            event,
            ctx({ streamUrl: 'https://radio.example/stream', metadataSource: SOURCE }),
        );
        expect(res.status).toBe(200);
        expect(previewNowPlaying).toHaveBeenCalledWith({
            id: NIL,
            streamUrl: 'https://radio.example/stream',
            metadataSource: SOURCE,
        });
        expect(((await res.json()) as { track: { title: string } }).track.title).toBe('Song');
    });

    it('passes an empty stream URL when none is given (no ICY fallback)', async () => {
        previewNowPlaying.mockResolvedValue({
            stationId: NIL,
            fetchedAt: '2026-10-06T00:00:00.000Z',
            source: null,
        });
        await previewDef.handlers.POST!(event, ctx({ metadataSource: SOURCE }));
        expect(previewNowPlaying).toHaveBeenCalledWith(expect.objectContaining({ streamUrl: '' }));
    });

    it('declares a body schema that rejects a non-http stream URL', () => {
        const body = previewDef.request!.body!;
        expect(
            body.safeParse({ streamUrl: 'ftp://radio.example/s', metadataSource: SOURCE }).success,
        ).toBe(false);
        expect(body.safeParse({ metadataSource: SOURCE }).success).toBe(true);
    });
});

describe('POST /api/admin/radio/stream-info', () => {
    beforeEach(() => getStreamInfo.mockReset());

    it('reports the ICY fields of a reachable stream', async () => {
        getStreamInfo.mockResolvedValue({ name: 'Station', genre: 'Techno' });
        const res = await streamInfoDef.handlers.POST!(
            event,
            ctx({ streamUrl: 'https://radio.example/stream' }),
        );
        expect(getStreamInfo).toHaveBeenCalledWith('https://radio.example/stream');
        expect(await res.json()).toEqual({ reachable: true, name: 'Station', genre: 'Techno' });
    });

    it('reports reachable: false when the stream cannot be read', async () => {
        getStreamInfo.mockResolvedValue(null);
        const res = await streamInfoDef.handlers.POST!(
            event,
            ctx({ streamUrl: 'https://radio.example/stream' }),
        );
        expect(await res.json()).toEqual({ reachable: false });
    });

    it('is admin-only and requires an http(s) stream URL', () => {
        expect(streamInfoDef.auth).toEqual({ kind: 'admin' });
        expect(previewDef.auth).toEqual({ kind: 'admin' });
        const body = streamInfoDef.request!.body!;
        expect(body.safeParse({ streamUrl: 'file:///etc/passwd' }).success).toBe(false);
        expect(body.safeParse({ streamUrl: 'https://radio.example/s' }).success).toBe(true);
    });
});
