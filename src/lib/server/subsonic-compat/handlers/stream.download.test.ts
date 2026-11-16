// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Subsonic download.view: same permission, lease, log and naming pipeline as the other
// original-file download routes.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const m = vi.hoisted(() => ({
    canDownload: vi.fn(),
    refused: vi.fn(),
    track: vi.fn(),
    serve: vi.fn(),
    preflight: vi.fn(),
    naming: vi.fn(),
    tracker: {
        rate: () => 9,
        observer: { onBytes() {}, onEnd() {} },
        onBytes() {},
        onEnd() {},
        served: vi.fn(),
        discard: vi.fn(),
    },
}));

vi.mock('$lib/server/services/download-access.service.js', () => ({
    canDownload: (...a: unknown[]) => m.canDownload(...a),
}));
vi.mock('$lib/server/services/download-tracking.js', () => ({
    parseRangeStart: () => null,
    recordDownloadRefused: (...a: unknown[]) => m.refused(...a),
    trackDownload: (...a: unknown[]) => m.track(...a),
    untrackedDownload: () => ({
        rate: () => 0,
        observer: {},
        onBytes() {},
        onEnd() {},
        served() {},
        discard() {},
    }),
}));
vi.mock('$lib/server/utils/file-streaming.js', () => ({
    serveContainedMediaFile: (...a: unknown[]) => m.serve(...a),
    preflightFile: (...a: unknown[]) => m.preflight(...a),
}));
vi.mock('$lib/server/database/queries/media-file-resolution.queries.js', () => ({
    resolvePlaybackSelection: async () => ({ files: [], fileId: 'file-1' }),
}));
vi.mock('$lib/server/database/queries/catalog-operations.queries.js', () => ({
    getMediaItemForDownloadNaming: (...a: unknown[]) => m.naming(...a),
}));
vi.mock('$lib/server/handlers/media-download-handler.js', () => ({
    buildDownloadFilename: (n: { title: string }, ext: string) => `${n.title}${ext}`,
}));
vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getTrackDetail: async () => ({
        id: '11111111-1111-4111-8111-111111111111',
        file_path: '/music/Artist.Name-Album-2011-GRP/01.group.release.flac',
    }),
}));
vi.mock('$lib/server/subsonic-compat/media-access.js', () => ({
    checkSubsonicMediaAccess: async () => true,
}));
vi.mock('$lib/server/utils/media-path-resolver.js', () => ({
    resolveMediaPath: async () => ({
        isAccessible: true,
        containerPath: '/music/Artist.Name-Album-2011-GRP/01.group.release.flac',
        fileSize: 100,
    }),
}));
vi.mock('$lib/server/database/queries/play-sessions.queries.js', () => ({
    refreshExternalSessionPresence: async () => {},
}));
vi.mock('$lib/server/subsonic-compat/utils/transcode-session.js', () => ({
    upsertTranscodeSession: async () => null,
}));
vi.mock('$lib/server/services/image-proxy/index.js', () => ({ getImageProxyService: () => ({}) }));
vi.mock('$lib/server/services/music/lyrics.service.js', () => ({ readStoredLyrics: () => null }));
vi.mock('$lib/server/services/music-transcode/index.js', () => ({
    getMusicTranscodeService: () => ({}),
}));
vi.mock('$lib/server/services/music-transcode/source-metadata.js', () => ({
    probeAudioSource: async () => ({}),
}));
vi.mock('$lib/server/config.js', () => ({ config: { FEATURE_MUSIC_TRANSCODE: false } }));

const { handleDownload } = await import('./stream.js');

const auth = {
    userId: 'u1',
    username: 'alice',
    ownerIsAdmin: false,
    displayName: null,
    clientName: 'DSub',
    format: 'json',
    userGroups: [],
    maxAgeRating: null,
    isAgeRestricted: false,
} as never;

function ev(method = 'GET'): RequestEvent {
    const url = new URL('http://localhost/rest/download.view?id=t1');
    return {
        url,
        request: new Request(url, { method }),
        locals: { subsonicBodyParams: new URLSearchParams() },
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    m.canDownload.mockResolvedValue(true);
    m.naming.mockResolvedValue({ title: 'Clean Title' });
    m.track.mockResolvedValue({ ok: true, tracker: m.tracker });
    m.serve.mockResolvedValue(new Response('x', { status: 200 }));
    m.preflight.mockResolvedValue({ kind: 'proceed' });
});

describe('download.view', () => {
    it('refuses a user who may not download with a Subsonic "not authorized" error and logs a denied row', async () => {
        m.canDownload.mockResolvedValue(false);
        const res = await handleDownload(ev(), auth, {} as never);
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body['subsonic-response'].error.code).toBe(50);
        expect(m.serve).not.toHaveBeenCalled();
        expect(m.track).not.toHaveBeenCalled();
        expect(m.refused).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ mediaItemId: '11111111-1111-4111-8111-111111111111' }),
            'denied',
        );
        expect(m.canDownload).toHaveBeenCalledWith({
            userId: 'u1',
            username: 'alice',
            isAdmin: false,
        });
    });

    it('an allowed download is tracked (lease + log), throttled by the tracker and named from the catalog', async () => {
        const res = await handleDownload(ev(), auth, {} as never);
        expect(res.status).toBe(200);
        expect(m.track).toHaveBeenCalledTimes(1);
        const [trackEvent, target] = m.track.mock.calls[0]!;
        expect(trackEvent.locals.user.userId).toBe('u1');
        expect(target).toMatchObject({
            mediaItemId: '11111111-1111-4111-8111-111111111111',
            fileId: 'file-1',
            surface: 'api',
            bytesTotal: 100,
        });
        const opts = m.serve.mock.calls[0]![2];
        expect(opts.observer).toBe(m.tracker.observer);
        expect(opts.throttleBytesPerSec()).toBe(9);
        expect(m.tracker.served).toHaveBeenCalledWith(200);
        expect(m.tracker.discard).not.toHaveBeenCalled();
    });

    it('the Content-Disposition never carries the on-disk name', async () => {
        await handleDownload(ev(), auth, {} as never);
        const disposition: string = m.serve.mock.calls[0]![2].disposition;
        expect(disposition).toContain('Clean Title.flac');
        expect(disposition).not.toContain('Artist.Name');
        expect(disposition).not.toContain('group.release');
        expect(disposition).not.toContain('GRP');
    });

    it('falls back to download<ext> when there is no catalog row, never the on-disk name', async () => {
        m.naming.mockResolvedValue(null);
        await handleDownload(ev(), auth, {} as never);
        const disposition: string = m.serve.mock.calls[0]![2].disposition;
        expect(disposition).toContain('download.flac');
        expect(disposition).not.toContain('group.release');
    });

    it('a refused lease (429) is returned and nothing is served', async () => {
        m.track.mockResolvedValue({ ok: false, response: new Response('slow down', { status: 429 }) });
        const res = await handleDownload(ev(), auth, {} as never);
        expect(res.status).toBe(429);
        expect(m.serve).not.toHaveBeenCalled();
    });

    it('a 416 discards the lease and answers a Subsonic error', async () => {
        m.serve.mockResolvedValue(new Response(null, { status: 416 }));
        const res = await handleDownload(ev(), auth, {} as never);
        expect(res.status).toBe(416);
        expect(m.tracker.discard).toHaveBeenCalledTimes(1);
    });

    it('a HEAD is answered by the preflight: no lease and no stream opened', async () => {
        m.preflight.mockResolvedValue({
            kind: 'response',
            response: new Response(null, { status: 200 }),
        });
        const res = await handleDownload(ev('HEAD'), auth, {} as never);
        expect(res.status).toBe(200);
        expect(m.preflight.mock.calls[0]![1]).toMatchObject({ method: 'HEAD', contained: true });
        expect(m.track).not.toHaveBeenCalled();
        expect(m.serve).not.toHaveBeenCalled();
    });

    it('a matching conditional GET is a 304 with no lease and no stream', async () => {
        m.preflight.mockResolvedValue({
            kind: 'response',
            response: new Response(null, { status: 304 }),
        });
        const res = await handleDownload(ev('GET'), auth, {} as never);
        expect(res.status).toBe(304);
        expect(m.track).not.toHaveBeenCalled();
        expect(m.serve).not.toHaveBeenCalled();
    });
});
