// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const mocks = vi.hoisted(() => ({
    select: vi.fn(),
    serve: vi.fn(),
    preflight: vi.fn(),
    track: vi.fn(),
    tracker: {
        rate: () => 7,
        observer: { onBytes() {}, onEnd() {} },
        onBytes() {},
        onEnd() {},
        served: vi.fn(),
        discard: vi.fn(),
    },
}));
vi.mock('$lib/server/config', () => ({ config: { FEATURE_MEDIA_DOWNLOAD: true } }));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/media-file-resolution.queries', () => ({
    resolvePlaybackSelection: mocks.select,
}));
vi.mock('$lib/server/database/queries/catalog-operations.queries', () => ({
    getMediaItemForDownloadNaming: async () => null,
}));
vi.mock('$lib/server/utils/media-path-resolver', () => ({
    resolveMediaPath: async () => ({
        isAccessible: true,
        containerPath: '/media/source.mkv',
        fileSize: 4,
    }),
    isPathWithinLibraryRoots: async () => true,
}));
vi.mock('$lib/server/utils/file-streaming', () => ({
    serveContainedMediaFile: mocks.serve,
    preflightFile: (...a: unknown[]) => mocks.preflight(...a),
}));
vi.mock('$lib/server/services/download-access-guard.js', () => ({
    downloadForbiddenResponse: async () => null,
    mediaAccessUserOf: (l: { user?: unknown }) => l?.user,
}));
const scope = vi.hoisted(() => ({
    denied: null as string[] | null,
    allowed: new Set<string>(),
}));
vi.mock('$lib/server/services/download-file-scope.js', () => ({
    deniedLibraryGroupsFor: async () => scope.denied,
    allowedFileIds: async () => scope.allowed,
    scopeSelection: (sel: { files: { id: string }[]; fileId: string | null }, ok: Set<string>) => {
        const files = sel.files.filter((f) => ok.has(f.id));
        if (!files.length) return { files: [], fileId: null };
        return { files, fileId: sel.fileId && ok.has(sel.fileId) ? sel.fileId : files[0]!.id };
    },
}));
vi.mock('$lib/server/services/download-tracking.js', () => ({
    parseRangeStart: () => null,
    recordDownloadRefused: () => {},
    untrackedDownload: () => ({
        rate: () => 0,
        observer: {},
        onBytes() {},
        onEnd() {},
        served() {},
        discard() {},
    }),
    trackDownload: (...a: unknown[]) => mocks.track(...a),
}));
import { handleDownloadFile } from './media-download-handler.js';
const selected = '22222222-2222-4222-8222-222222222222';
const file = { id: selected, file_path: '/media/source.mkv' };
function event(path: string): RequestEvent {
    const url = new URL(path, 'https://test.invalid');
    return {
        url,
        params: { id: 'media', itemId: 'media' },
        request: new Request(url),
    } as unknown as RequestEvent;
}
beforeEach(() => {
    vi.clearAllMocks();
    scope.denied = null;
    scope.allowed = new Set();
    mocks.serve.mockResolvedValue(new Response('data'));
    mocks.preflight.mockResolvedValue({ kind: 'proceed' });
    mocks.track.mockResolvedValue({ ok: true, tracker: mocks.tracker });
});
describe('attachment selected file', () => {
    it('uses fileId and never falls back for a foreign selection', async () => {
        mocks.select.mockResolvedValue({ files: [], fileId: null });
        expect(
            (
                await handleDownloadFile(event(`/api/v1/media/media/download?fileId=${selected}`), {
                    surface: 'api',
                })
            ).status,
        ).toBe(404);
        expect(mocks.select).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'media', {
            fileId: selected,
        });
        expect(mocks.serve).not.toHaveBeenCalled();
    });
    it.each(['bad', ''])(
        'invalid explicit selector %j returns 404 without default bytes',
        async (value) => {
            expect(
                (
                    await handleDownloadFile(
                        event(`/api/v1/media/media/download?fileId=${value}`),
                        { surface: 'api' },
                    )
                ).status,
            ).toBe(404);
            expect(mocks.select).not.toHaveBeenCalled();
        },
    );
    it('an omitted selector asks for the default once', async () => {
        mocks.select.mockResolvedValue({ files: [file], fileId: selected });
        expect(
            (await handleDownloadFile(event('/api/v1/media/media/download'), { surface: 'api' }))
                .status,
        ).toBe(200);
        expect(mocks.select).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'media', {
            fileId: undefined,
        });
    });
    it('Jellyfin retains its own mediaSourceId adapter and stale-source fallback', async () => {
        mocks.select
            .mockResolvedValueOnce({ files: [], fileId: null })
            .mockResolvedValueOnce({ files: [file], fileId: selected });
        expect(
            (
                await handleDownloadFile(
                    event(`/j/Items/media/Download?mediaSourceId=${selected}`),
                    { surface: 'jellyfin' },
                )
            ).status,
        ).toBe(200);
        expect(mocks.select).toHaveBeenNthCalledWith(1, expect.anything(), 'media', {
            fileId: selected,
        });
        expect(mocks.select).toHaveBeenNthCalledWith(2, expect.anything(), 'media');
    });
});

describe('surface decides the adapter, not the URL', () => {
    it('an api request on a /j-looking path does not use the Jellyfin mediaSourceId adapter', async () => {
        mocks.select.mockResolvedValue({ files: [file], fileId: selected });
        await handleDownloadFile(event(`/j/Items/media/Download?mediaSourceId=${selected}`), {
            surface: 'api',
        });
        expect(mocks.select).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'media', {
            fileId: undefined,
        });
    });
    it('a jellyfin request on a non-/j path uses the adapter', async () => {
        mocks.select.mockResolvedValue({ files: [file], fileId: selected });
        await handleDownloadFile(event(`/x?mediaSourceId=${selected}`), { surface: 'jellyfin' });
        expect(mocks.select).toHaveBeenCalledWith(expect.anything(), 'media', {
            fileId: selected,
        });
    });
});

describe('tracker wiring', () => {
    beforeEach(() => {
        mocks.select.mockResolvedValue({ files: [file], fileId: selected });
    });
    it('serves with the tracker observer and a throttle function bound to the tracker rate', async () => {
        await handleDownloadFile(event('/api/v1/media/media/download'), { surface: 'api' });
        const opts = mocks.serve.mock.calls[0]![2];
        expect(opts.observer).toBe(mocks.tracker.observer);
        expect(typeof opts.throttleBytesPerSec).toBe('function');
        expect(opts.throttleBytesPerSec()).toBe(7);
        expect(mocks.tracker.served).toHaveBeenCalledWith(200);
        expect(mocks.tracker.discard).not.toHaveBeenCalled();
    });
    it('a 416 discards the lease', async () => {
        mocks.serve.mockResolvedValue(new Response(null, { status: 416 }));
        await handleDownloadFile(event('/api/v1/media/media/download'), { surface: 'api' });
        expect(mocks.tracker.discard).toHaveBeenCalledTimes(1);
    });
    it('a refused path (null) discards the lease and answers 404', async () => {
        mocks.serve.mockResolvedValue(null);
        const res = await handleDownloadFile(event('/api/v1/media/media/download'), {
            surface: 'api',
        });
        expect(res.status).toBe(404);
        expect(mocks.tracker.discard).toHaveBeenCalledTimes(1);
    });
    it('a throw discards the lease', async () => {
        mocks.serve.mockRejectedValue(new Error('disk'));
        const res = await handleDownloadFile(event('/api/v1/media/media/download'), {
            surface: 'api',
        });
        expect(res.status).toBe(500);
        expect(mocks.tracker.discard).toHaveBeenCalledTimes(1);
    });
    it('tracks the catalog row id from the naming row, falling back to the item id', async () => {
        await handleDownloadFile(event('/api/v1/media/media/download'), { surface: 'api' });
        expect(mocks.track.mock.calls[0]![1]).toMatchObject({ mediaItemId: 'media', fileId: selected });
    });
});

describe('HEAD and conditional requests', () => {
    const headEvent = (extra: Record<string, string> = {}, method = 'HEAD') => {
        const url = new URL('/api/v1/media/media/download', 'https://test.invalid');
        return {
            url,
            params: { id: 'media', itemId: 'media' },
            request: new Request(url, { method, headers: extra }),
        } as unknown as RequestEvent;
    };
    beforeEach(() => {
        mocks.select.mockResolvedValue({ files: [file], fileId: selected });
    });

    it('a HEAD is answered by the preflight: no lease, no log row, no stream', async () => {
        mocks.preflight.mockResolvedValue({
            kind: 'response',
            response: new Response(null, { status: 200, headers: { 'Content-Length': '4' } }),
        });
        const res = await handleDownloadFile(headEvent(), { surface: 'api' });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-length')).toBe('4');
        expect(mocks.preflight.mock.calls[0]![1]).toMatchObject({ method: 'HEAD', contained: true });
        expect(mocks.track).not.toHaveBeenCalled();
        expect(mocks.serve).not.toHaveBeenCalled();
    });

    it('a matching conditional GET is a 304 before any lease or stream', async () => {
        mocks.preflight.mockResolvedValue({
            kind: 'response',
            response: new Response(null, { status: 304 }),
        });
        const res = await handleDownloadFile(
            headEvent({ 'if-none-match': '"4-1"', 'if-modified-since': 'x' }, 'GET'),
            { surface: 'api' },
        );
        expect(res.status).toBe(304);
        expect(mocks.preflight.mock.calls[0]![1]).toMatchObject({
            ifNoneMatch: '"4-1"',
            ifModifiedSince: 'x',
        });
        expect(mocks.track).not.toHaveBeenCalled();
        expect(mocks.serve).not.toHaveBeenCalled();
    });

    it('a refused path is a 404 without a lease', async () => {
        mocks.preflight.mockResolvedValue({ kind: 'refused' });
        const res = await handleDownloadFile(headEvent({}, 'GET'), { surface: 'api' });
        expect(res.status).toBe(404);
        expect(mocks.track).not.toHaveBeenCalled();
    });

    it('a GET does take a lease', async () => {
        await handleDownloadFile(event('/api/v1/media/media/download'), { surface: 'api' });
        expect(mocks.track).toHaveBeenCalledTimes(1);
    });
});

describe('file-level library scope', () => {
    const other = '44444444-4444-4444-8444-444444444444';
    const otherFile = { id: other, file_path: '/media/other.mkv' };

    it('an explicit fileId in a denied library is a 404 with no lease and no bytes', async () => {
        scope.denied = ['g-denied'];
        scope.allowed = new Set(); // the named file is denied
        mocks.select.mockResolvedValue({ files: [file], fileId: selected });
        const res = await handleDownloadFile(event(`/api/v1/media/media/download?fileId=${selected}`), {
            surface: 'api',
        });
        expect(res.status).toBe(404);
        expect(mocks.track).not.toHaveBeenCalled();
        expect(mocks.serve).not.toHaveBeenCalled();
    });

    it('the default falls to the allowed file when the default one is denied', async () => {
        scope.denied = ['g-denied'];
        scope.allowed = new Set([other]); // item has two files, only `other` is allowed
        mocks.select.mockResolvedValue({ files: [file, otherFile], fileId: selected });
        const res = await handleDownloadFile(event('/api/v1/media/media/download'), { surface: 'api' });
        expect(res.status).toBe(200);
        expect(mocks.track.mock.calls[0]![1]).toMatchObject({ fileId: other });
    });

    it('a Jellyfin mediaSourceId (play token) naming a denied file is a 404 too', async () => {
        scope.denied = ['g-denied'];
        scope.allowed = new Set();
        mocks.select.mockResolvedValue({ files: [file], fileId: selected });
        const res = await handleDownloadFile(
            event(`/j/Items/media/Download?mediaSourceId=${selected}`),
            { surface: 'jellyfin' },
        );
        expect(res.status).toBe(404);
        expect(mocks.serve).not.toHaveBeenCalled();
    });

    it('without a denied library the selection is untouched', async () => {
        mocks.select.mockResolvedValue({ files: [file], fileId: selected });
        expect(
            (await handleDownloadFile(event('/api/v1/media/media/download'), { surface: 'api' })).status,
        ).toBe(200);
    });
});
