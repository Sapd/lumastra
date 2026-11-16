// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/media/{id}/download-zip: a season or series as one STORE ZIP with an exact Content-Length.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { RequestEvent } from '@sveltejs/kit';

const mockCheckBatch = vi.fn();
const mockCheckAccess = vi.fn();
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...a: unknown[]) => mockCheckAccess(...a),
    checkMediaAccessBatch: (...a: unknown[]) => mockCheckBatch(...a),
}));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../catalog/resolve-id.js', () => ({
    resolveCatalogInternalId: async (e: RequestEvent) => e.params.id ?? null,
}));

const mockRoot = vi.fn();
const mockEpisodes = vi.fn();
const mockSingle = vi.fn();
vi.mock('$lib/server/database/queries/download-list.queries.js', () => ({
    getDownloadListRoot: (...a: unknown[]) => mockRoot(...a),
    listEpisodeDownloadRows: (...a: unknown[]) => mockEpisodes(...a),
    getSingleDownloadRow: (...a: unknown[]) => mockSingle(...a),
}));

const mockDenied = vi.fn();
const revokedFiles = new Set<string>();
vi.mock('$lib/server/services/download-file-scope.js', () => ({
    deniedLibraryGroupsFor: (...a: unknown[]) => mockDenied(...a),
    allowedFileIds: async (_s: unknown, ids: string[]) =>
        new Set(ids.filter((id) => !revokedFiles.has(id))),
}));

const mockCanDownload = vi.fn();
vi.mock('$lib/server/services/download-access.service.js', () => ({
    canDownload: (...a: unknown[]) => mockCanDownload(...a),
    userMayDownload: vi.fn(),
}));

const feature = vi.hoisted(() => ({ on: true }));
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: new Proxy(actual.config, {
            get: (t, k, r) => (k === 'FEATURE_MEDIA_DOWNLOAD' ? feature.on : Reflect.get(t, k, r)),
        }),
    };
});

// Disk: every path "exists" with the size in `disk`, content is `disk[path]` zero bytes
// unless `contentOverride` says otherwise.
const disk: Record<string, number> = {};
const outsideRoots = new Set<string>();
const contentOverride: Record<string, Buffer> = {};
// A test can stall the file checks (an NFS that does not answer) by setting `gate.wait`.
const gate: { wait: Promise<void> | null } = { wait: null };
vi.mock('$lib/server/utils/media-path-resolver.js', () => ({
    resolveMediaPath: async (p: string) =>
        (await gate.wait, p in disk)
            ? { providerPath: p, containerPath: p, isAccessible: true, fileSize: disk[p] }
            : { providerPath: p, containerPath: p, isAccessible: false, reason: 'not_found' },
}));
vi.mock('$lib/server/utils/download-path.js', () => ({
    resolveDownloadablePath: async (_s: unknown, p: string) => (outsideRoots.has(p) ? null : p),
    openDownloadableFile: async (_s: unknown, p: string) => {
        if (outsideRoots.has(p)) return null;
        const data = contentOverride[p] ?? Buffer.alloc(disk[p] ?? 0, p.length % 251);
        return {
            size: disk[p] ?? 0,
            mtimeMs: null,
            handle: {
                close: async () => {},
                createReadStream: () => Readable.from([data]),
            },
        };
    },
}));
const handoff = vi.hoisted(() => ({ noted: vi.fn() }));
vi.mock('$lib/server/services/download-handoff.js', () => ({
    parseHandoffNonce: (raw: string | null) =>
        raw && /^[A-Za-z0-9_-]{8,64}$/.test(raw) ? raw : null,
    noteHandoff: handoff.noted,
}));

const mockTrack = vi.fn();
const mockRefused = vi.fn();
const tracker = {
    rate: () => 0,
    observer: { onBytes: vi.fn(), onEnd: vi.fn(), setCancel: vi.fn() },
    onBytes: vi.fn(),
    onEnd: vi.fn(),
    served: vi.fn(),
    setBytesTotal: vi.fn(),
    isFinished: vi.fn(() => false),
    discard: vi.fn(),
};
vi.mock('$lib/server/services/download-tracking.js', () => ({
    trackDownload: (...a: unknown[]) => mockTrack(...a),
    recordDownloadRefused: (...a: unknown[]) => mockRefused(...a),
    untrackedDownload: () => tracker,
}));

const { def, resetPreparationCacheForTests, MAX_ARCHIVE_ENTRIES } =
    await import('./download-zip.js');
const { resetDownloadPreparationForTests, acquirePreparation } =
    await import('$lib/server/services/download-preparation.js');

function ep(
    id: string,
    season: number | null,
    episode: number | null,
    over: Record<string, unknown> = {},
) {
    return {
        id,
        title: `Ep ${id}`,
        year: null,
        media_type: 'episode',
        season_number: season,
        episode_number: episode,
        series_title: 'Café: Show',
        file_id: `f-${id}`,
        file_path: `/media/x/${id}.mkv`,
        file_size_bytes: 1000,
        is_missing: false,
        ...over,
    };
}

async function call(
    query = '',
    id = 'series1',
    opts: {
        method?: string;
        headers?: Record<string, string>;
        signal?: AbortSignal;
        bareHeaders?: boolean;
    } = {},
) {
    const url = `http://localhost/api/media/${id}/download-zip${query}`;
    return def.handlers.GET!(
        {
            locals: {
                user: { userId: 'u1', username: 'alice', mediaAccessIsAdmin: true },
                principal: { isAdmin: false },
            },
            url: new URL(url),
            params: { id },
            request: new Request(url, {
                method: opts.method ?? 'GET',
                headers: opts.bareHeaders
                    ? opts.headers
                    : { 'Sec-Fetch-Site': 'same-origin', ...opts.headers },
                signal: opts.signal,
            }),
        } as unknown as RequestEvent,
        { surface: 'internal' } as never,
    );
}

function zipNames(bytes: Buffer): string[] | null {
    if (spawnSync('unzip', ['-v']).status !== 0) return null;
    const dir = mkdtempSync(join(tmpdir(), 'zip-ep-'));
    try {
        const p = join(dir, 'a.zip');
        writeFileSync(p, bytes);
        const t = spawnSync('unzip', ['-t', p], { encoding: 'utf8' });
        expect(t.stdout).toContain('No errors detected');
        const r = spawnSync('unzip', ['-Z1', p], { encoding: 'utf8' });
        return r.stdout.split('\n').filter(Boolean);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe('media/{id}/download-zip', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetPreparationCacheForTests();
        resetDownloadPreparationForTests();
        gate.wait = null;
        revokedFiles.clear();
        tracker.isFinished.mockReturnValue(false);
        mockDenied.mockResolvedValue(null);
        feature.on = true;
        for (const k of Object.keys(disk)) delete disk[k];
        for (const k of Object.keys(contentOverride)) delete contentOverride[k];
        outsideRoots.clear();
        mockCanDownload.mockResolvedValue(true);
        mockCheckAccess.mockResolvedValue(true);
        mockCheckBatch.mockImplementation(async (_s: unknown, ids: string[]) => new Set(ids));
        mockTrack.mockResolvedValue({ ok: true, tracker });
        mockRoot.mockResolvedValue({
            id: 'series1',
            title: 'Café: Show',
            year: 2004,
            media_type: 'tv',
        });
        mockEpisodes.mockResolvedValue([
            ep('e2-1', 2, 1),
            ep('s0-1', 0, 1),
            ep('e1-2', 1, 2),
            ep('e1-1', 1, 1),
        ]);
        for (const id of ['e2-1', 's0-1', 'e1-2', 'e1-1']) disk[`/media/x/${id}.mkv`] = 1000;
    });

    it('streams a series: Content-Length equals the bytes, entries named like download-list', async () => {
        const res = await call();
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('application/zip');
        expect(res.headers.get('Accept-Ranges')).toBe('none');
        const disposition = res.headers.get('Content-Disposition')!;
        expect(disposition).toContain('attachment');
        expect(decodeURIComponent(disposition)).toContain('Café Show (2004).zip');
        const body = Buffer.from(await res.arrayBuffer());
        expect(body.length).toBe(Number(res.headers.get('Content-Length')));
        const names = zipNames(body);
        if (names) {
            expect(names).toEqual([
                'Café Show (2004)/Season 01/Café Show - S01E01 - Ep e1-1.mkv',
                'Café Show (2004)/Season 01/Café Show - S01E02 - Ep e1-2.mkv',
                'Café Show (2004)/Season 02/Café Show - S02E01 - Ep e2-1.mkv',
            ]);
        }
        expect(mockTrack).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                mediaItemId: 'series1',
                archive: true,
                surface: 'web',
            }),
        );
        expect(tracker.setBytesTotal).toHaveBeenCalledWith(body.length);
        expect(tracker.served).toHaveBeenCalledWith(200);
    });

    it('specials=1 adds the Specials folder', async () => {
        const res = await call('?specials=1');
        const names = zipNames(Buffer.from(await res.arrayBuffer()));
        if (names) expect(names[0]).toContain('/Specials/');
    });

    it('season=2 names the file after the season and holds only it', async () => {
        const res = await call('?season=2');
        expect(decodeURIComponent(res.headers.get('Content-Disposition')!)).toContain(
            'Café Show (2004) - Season 02.zip',
        );
        const names = zipNames(Buffer.from(await res.arrayBuffer()));
        if (names) expect(names).toHaveLength(1);
    });

    it('a season id downloads that season, named after it', async () => {
        mockRoot.mockResolvedValue({
            id: 'season1',
            title: 'Season 1',
            year: null,
            media_type: 'season',
        });
        mockEpisodes.mockResolvedValue([ep('e1-1', 1, 1), ep('e1-2', 1, 2)]);
        const res = await call('', 'season1');
        expect(res.status).toBe(200);
        expect(decodeURIComponent(res.headers.get('Content-Disposition')!)).toContain(
            'Café Show - Season 01.zip',
        );
    });

    it('records the hand-off nonce only once the 200 is ready', async () => {
        const ok = await call('?h=abcdefgh12345678');
        expect(ok.status).toBe(200);
        await ok.arrayBuffer();
        expect(handoff.noted).toHaveBeenCalledWith('u1', 'abcdefgh12345678');
    });

    it('records no nonce for a refused request (409), a HEAD or a bad nonce', async () => {
        delete disk['/media/x/e1-2.mkv'];
        expect((await call('?h=abcdefgh12345678')).status).toBe(409);
        disk['/media/x/e1-2.mkv'] = 1000;
        expect((await call('?h=abcdefgh12345678', 'series1', { method: 'HEAD' })).status).toBe(200);
        await (await call('?h=short')).arrayBuffer();
        expect(handoff.noted).not.toHaveBeenCalled();
    });

    it('a descriptor that no longer matches the announced size aborts the stream', async () => {
        disk['/media/x/e1-1.mkv'] = 1000;
        contentOverride['/media/x/e1-1.mkv'] = Buffer.alloc(900);
        const res = await call();
        await expect(res.arrayBuffer()).rejects.toThrow();
    });

    it('a Range request gets the full 200', async () => {
        const res = await call('', 'series1', { headers: { Range: 'bytes=10-20' } });
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Range')).toBeNull();
        expect(Buffer.from(await res.arrayBuffer()).length).toBe(
            Number(res.headers.get('Content-Length')),
        );
    });

    it('HEAD: same headers, no body, no lease, no log', async () => {
        const get = await call();
        const head = await call('', 'series1', { method: 'HEAD' });
        expect(head.status).toBe(200);
        expect(head.body).toBeNull();
        expect(head.headers.get('Content-Length')).toBe(get.headers.get('Content-Length'));
        expect(head.headers.get('Content-Disposition')).toBe(
            get.headers.get('Content-Disposition'),
        );
        expect(head.headers.get('Content-Type')).toBe('application/zip');
        await get.arrayBuffer();
        expect(mockTrack).toHaveBeenCalledTimes(1); // the GET only
        expect(mockRefused).not.toHaveBeenCalled();
    });

    it('403 when the user may not download, and a denied row is logged', async () => {
        mockCanDownload.mockResolvedValue(false);
        const res = await call();
        expect(res.status).toBe(403);
        expect(mockRefused).toHaveBeenCalledWith(
            expect.anything(),
            { mediaItemId: 'series1', archive: true, surface: 'web' },
            'denied',
        );
        expect(mockTrack).not.toHaveBeenCalled();
    });

    it('404 when the feature is off', async () => {
        feature.on = false;
        expect((await call()).status).toBe(404);
        expect(mockTrack).not.toHaveBeenCalled();
    });

    it('404 for an invisible item, before any download check', async () => {
        mockCheckAccess.mockResolvedValue(false);
        expect((await call()).status).toBe(404);
        expect(mockCanDownload).not.toHaveBeenCalled();
    });

    it('same-site GET is refused too, and so is one with no Sec-Fetch-Site, Origin or Referer', async () => {
        const sameSite = await call('', 'series1', { headers: { 'Sec-Fetch-Site': 'same-site' } });
        expect(sameSite.status).toBe(403);
        const bare = await call('', 'series1', { bareHeaders: true });
        expect(bare.status).toBe(403);
        expect(mockCheckAccess).not.toHaveBeenCalled();
    });

    it('cross-site GET is 403', async () => {
        const res = await call('', 'series1', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
        expect(res.status).toBe(403);
        expect(mockCheckAccess).not.toHaveBeenCalled();
    });

    it('400 for a movie', async () => {
        mockRoot.mockResolvedValue({ id: 'm1', title: 'Movie', year: 1999, media_type: 'movie' });
        mockSingle.mockResolvedValue(
            ep('m1', null, null, { media_type: 'movie', series_title: null }),
        );
        disk['/media/x/m1.mkv'] = 10;
        expect((await call('', 'm1')).status).toBe(400);
        expect(tracker.served).not.toHaveBeenCalled();
    });

    it('400 for a single episode', async () => {
        mockRoot.mockResolvedValue({ id: 'e1', title: 'Ep', year: null, media_type: 'episode' });
        mockSingle.mockResolvedValue(ep('e1-1', 1, 1));
        expect((await call('', 'e1-1')).status).toBe(400);
    });

    it('404 when no item is available', async () => {
        mockEpisodes.mockResolvedValue([ep('x', 1, 1, { file_id: null, file_path: null })]);
        expect((await call()).status).toBe(404);
        for (const k of Object.keys(disk)) delete disk[k];
        mockEpisodes.mockResolvedValue([ep('e1-1', 1, 1)]);
        expect((await call()).status).toBe(409); // advertised, but not on disk
    });

    it('leaves out an episode the user may not access (it is not advertised to them)', async () => {
        mockCheckBatch.mockImplementation(
            async (_s: unknown, ids: string[]) => new Set(ids.filter((i) => i !== 'e2-1')),
        );
        const res = await call();
        expect(res.status).toBe(200);
        const names = zipNames(Buffer.from(await res.arrayBuffer()));
        if (names) expect(names).toHaveLength(2);
    });

    it('an item the list marks unavailable (missing flag) is not part of the archive, not an error', async () => {
        mockEpisodes.mockResolvedValue([ep('e1-1', 1, 1), ep('e1-2', 1, 2, { is_missing: true })]);
        const res = await call();
        expect(res.status).toBe(200);
        const names = zipNames(Buffer.from(await res.arrayBuffer()));
        if (names) expect(names).toHaveLength(1);
    });

    it('409 files_unavailable when an advertised-available file is gone, nothing is streamed', async () => {
        delete disk['/media/x/e1-2.mkv'];
        const res = await call();
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.reason).toBe('files_unavailable');
        expect(JSON.stringify(body)).toContain('1 of 3');
        expect(tracker.served).not.toHaveBeenCalled();
        expect(tracker.discard).toHaveBeenCalled();
    });

    it('409 when an advertised file is outside the library roots', async () => {
        outsideRoots.add('/media/x/e1-1.mkv');
        const res = await call();
        expect(res.status).toBe(409);
        expect((await res.json()).reason).toBe('files_unavailable');
    });

    it('takes the lease BEFORE listing or statting anything', async () => {
        const res = await call();
        await res.arrayBuffer();
        expect(mockTrack.mock.invocationCallOrder[0]).toBeLessThan(
            mockRoot.mock.invocationCallOrder[0]!,
        );
    });

    it('a refused lease (429) never reaches the listing', async () => {
        mockTrack.mockResolvedValue({ ok: false, response: new Response('x', { status: 429 }) });
        expect((await call()).status).toBe(429);
        expect(mockRoot).not.toHaveBeenCalled();
    });

    it('gives the slot back (no log row) on 404, 400 and 413', async () => {
        mockEpisodes.mockResolvedValue([]);
        expect((await call()).status).toBe(404);
        expect(tracker.discard).toHaveBeenCalledTimes(1);
        mockRoot.mockResolvedValue({ id: 'm1', title: 'M', year: 1, media_type: 'movie' });
        mockSingle.mockResolvedValue(null);
        expect((await call('', 'm1')).status).toBe(400);
        expect(tracker.discard).toHaveBeenCalledTimes(2);
    });

    it('413 above the entry cap, before any file is statted', async () => {
        mockEpisodes.mockResolvedValue(
            Array.from({ length: MAX_ARCHIVE_ENTRIES + 1 }, (_, i) => ep(`x${i}`, 1, i + 1)),
        );
        const res = await call();
        expect(res.status).toBe(413);
        expect((await res.json()).reason).toBe('too_many_entries');
        expect(tracker.discard).toHaveBeenCalled();
    });

    it('stops preparing when the client already disconnected (no stream, slot released)', async () => {
        const ac = new AbortController();
        ac.abort();
        const res = await call('', 'series1', { signal: ac.signal });
        expect(res.status).toBe(499);
        expect(tracker.served).not.toHaveBeenCalled();
        expect(tracker.discard).toHaveBeenCalled();
    });

    it('a HEAD takes no lease; its authorized result is reused by the GET (prepared once)', async () => {
        const head = await call('', 'series1', { method: 'HEAD' });
        expect(head.status).toBe(200);
        expect(mockTrack).not.toHaveBeenCalled();
        const get = await call();
        expect(get.status).toBe(200);
        expect(get.headers.get('Content-Length')).toBe(head.headers.get('Content-Length'));
        await get.arrayBuffer();
        expect(mockRoot).toHaveBeenCalledTimes(1); // listed and stat-ed once
    });

    it('the cache is per user, title, season and specials', async () => {
        await (await call('?season=1')).arrayBuffer();
        await (await call('?season=2')).arrayBuffer();
        await (await call('?specials=1')).arrayBuffer();
        expect(mockRoot).toHaveBeenCalledTimes(3);
    });

    it('a second preparation of the same user is refused with 429 + Retry-After while one runs', async () => {
        let open!: () => void;
        gate.wait = new Promise<void>((r) => (open = r));
        const first = call();
        await vi.waitFor(() => expect(mockRoot).toHaveBeenCalled());
        const second = await call('?season=2', 'series1', { method: 'HEAD' });
        expect(second.status).toBe(429);
        expect(Number(second.headers.get('Retry-After'))).toBeGreaterThan(0);
        expect((await second.json()).reason).toBe('preparation_busy');
        open();
        const res = await first;
        expect(res.status).toBe(200);
        await res.arrayBuffer();
        // the slot is free again
        expect((await call('?season=2', 'series1', { method: 'HEAD' })).status).toBe(200);
    });

    it('the server-wide preparation limit refuses too', async () => {
        const held = [];
        for (let i = 0; i < 4; i++) held.push(await acquirePreparation(`other-${i}`));
        expect(held.every((h) => h.ok)).toBe(true);
        const res = await call();
        expect(res.status).toBe(429);
        expect(tracker.discard).toHaveBeenCalled();
    });

    it('a preparation over the 60 s deadline answers 503 preparation_timeout and gives the slot back', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            gate.wait = new Promise<void>(() => {}); // never answers
            const pending = call();
            await vi.advanceTimersByTimeAsync(60_000);
            const res = await pending;
            expect(res.status).toBe(503);
            expect((await res.json()).reason).toBe('preparation_timeout');
            expect(tracker.discard).toHaveBeenCalled();
            expect(tracker.served).not.toHaveBeenCalled();
            // the hung stat is still pending, yet the admission slot is free right now (not at 90 s)
            const again = await acquirePreparation('u1');
            expect(again.ok).toBe(true);
            if (again.ok) await again.release();
        } finally {
            vi.useRealTimers();
        }
    });

    it('an abort that lands while the admission acquire is pending frees the slot at once and starts no work', async () => {
        const ac = new AbortController();
        const prep = await import('$lib/server/services/download-preparation.js');
        const spy = vi.spyOn(prep, 'acquirePreparation');
        let resolveAcquire!: (v: Awaited<ReturnType<typeof acquirePreparation>>) => void;
        let released = 0;
        spy.mockImplementationOnce(
            () =>
                new Promise((r) => {
                    resolveAcquire = r;
                }),
        );
        const pending = call('', 'series1', { signal: ac.signal });
        await vi.waitFor(() => expect(spy).toHaveBeenCalled());
        ac.abort(); // while the acquire is pending
        resolveAcquire({
            ok: true,
            release: async () => {
                released += 1;
            },
        });
        const res = await pending;
        expect(res.status).toBe(499);
        expect(released).toBe(1); // released as soon as the acquire resolved
        expect(mockRoot).not.toHaveBeenCalled(); // no work started
        expect(tracker.discard).toHaveBeenCalled();
        spy.mockRestore();
    });

    it('the tracker ending DURING preparation aborts it through the registered cancel hook', async () => {
        let open!: () => void;
        gate.wait = new Promise<void>((r) => (open = r));
        const pending = call();
        await vi.waitFor(() => expect(tracker.observer.setCancel).toHaveBeenCalled());
        const cancel = tracker.observer.setCancel.mock.calls[0]![0] as () => void;
        cancel(); // stall watchdog / revoked lease
        const res = await pending;
        expect(res.status).toBe(503);
        expect((await res.json()).reason).toBe('download_ended');
        open();
    });

    it('never starts streaming with a finished tracker', async () => {
        tracker.isFinished.mockReturnValue(true);
        const res = await call();
        expect(res.status).toBe(503);
        expect((await res.json()).reason).toBe('download_ended');
        expect(tracker.served).not.toHaveBeenCalled();
        expect(tracker.discard).toHaveBeenCalled();
    });

    it('the client leaving mid-preparation stops it (499, slot released)', async () => {
        let open!: () => void;
        gate.wait = new Promise<void>((r) => (open = r));
        const ac = new AbortController();
        const pending = call('', 'series1', { signal: ac.signal });
        await vi.waitFor(() => expect(mockRoot).toHaveBeenCalled());
        ac.abort();
        expect((await pending).status).toBe(499);
        expect(tracker.discard).toHaveBeenCalled();
        open();
    });

    describe('the preparation cache follows the CURRENT access scope', () => {
        it('a HEAD caches; the same scope reuses it (listed once)', async () => {
            expect((await call('', 'series1', { method: 'HEAD' })).status).toBe(200);
            await (await call()).arrayBuffer();
            expect(mockRoot).toHaveBeenCalledTimes(1);
        });

        it('a changed library scope (denied groups) is a different cache entry', async () => {
            await call('', 'series1', { method: 'HEAD' });
            mockDenied.mockResolvedValue(['revoked-group']);
            await (await call()).arrayBuffer();
            expect(mockRoot).toHaveBeenCalledTimes(2);
        });

        it('a file revoked after the HEAD is not served from the cache: the list is rebuilt', async () => {
            const head = await call('', 'series1', { method: 'HEAD' });
            // the library of one file is revoked; the rebuilt list no longer carries it
            revokedFiles.add('f-e1-2');
            mockEpisodes.mockResolvedValue([
                ep('e2-1', 2, 1),
                ep('s0-1', 0, 1),
                ep('e1-2', 1, 2, { file_id: null, file_path: null }),
                ep('e1-1', 1, 1),
            ]);
            const get = await call();
            expect(get.status).toBe(200);
            expect(mockRoot).toHaveBeenCalledTimes(2); // re-prepared, not a cache hit
            expect(get.headers.get('Content-Length')).not.toBe(head.headers.get('Content-Length'));
            const names = zipNames(Buffer.from(await get.arrayBuffer()));
            if (names) expect(names.some((n) => n.includes('S01E02'))).toBe(false);
        });

        it('an item whose access was revoked after the HEAD is not served from the cache', async () => {
            await call('', 'series1', { method: 'HEAD' });
            mockCheckBatch.mockImplementation(
                async (_s: unknown, ids: string[]) => new Set(ids.filter((i) => i !== 'e1-1')),
            );
            const get = await call();
            expect(mockRoot).toHaveBeenCalledTimes(2);
            const names = zipNames(Buffer.from(await get.arrayBuffer()));
            if (names) expect(names.some((n) => n.includes('S01E01'))).toBe(false);
        });

        it('a changed age restriction is a different cache entry', async () => {
            await call('', 'series1', { method: 'HEAD' });
            // the same user, now age restricted (a different scope key)
            const url = 'http://localhost/api/media/series1/download-zip';
            const res = await def.handlers.GET!(
                {
                    locals: {
                        user: {
                            userId: 'u1',
                            username: 'alice',
                            mediaAccessIsAdmin: true,
                            isAgeRestricted: true,
                            maxAgeRating: 12,
                        },
                        principal: { isAdmin: false },
                    },
                    url: new URL(url),
                    params: { id: 'series1' },
                    request: new Request(url, { headers: { 'Sec-Fetch-Site': 'same-origin' } }),
                } as unknown as RequestEvent,
                { surface: 'internal' } as never,
            );
            await res.arrayBuffer();
            expect(mockRoot).toHaveBeenCalledTimes(2);
        });
    });

    it('lists files with the library scope of the caller (denied groups reach the queries)', async () => {
        mockDenied.mockResolvedValue(['group-denied']);
        const res = await call();
        await res.arrayBuffer();
        expect(mockEpisodes).toHaveBeenCalledWith({}, 'series1', ['group-denied']);
    });

    it('uses the size on disk, not the database size, for the Content-Length', async () => {
        disk['/media/x/e1-1.mkv'] = 4321;
        mockEpisodes.mockResolvedValue([ep('e1-1', 1, 1, { file_size_bytes: 1000 })]);
        const res = await call();
        expect(Buffer.from(await res.arrayBuffer()).length).toBe(
            Number(res.headers.get('Content-Length')),
        );
    });

    it('two files with the same archive name both go in (second one suffixed)', async () => {
        mockEpisodes.mockResolvedValue([
            ep('a', 1, 1, { title: 'Same' }),
            ep('b', 1, 1, { title: 'Same' }),
        ]);
        disk['/media/x/a.mkv'] = 5;
        disk['/media/x/b.mkv'] = 5;
        const res = await call();
        const names = zipNames(Buffer.from(await res.arrayBuffer()));
        if (names) {
            expect(names).toHaveLength(2);
            expect(new Set(names).size).toBe(2);
        }
    });

    it('a file that changed size after the check makes the stream error (no silent corrupt archive)', async () => {
        contentOverride['/media/x/e1-2.mkv'] = Buffer.alloc(10); // disk says 1000
        const res = await call();
        expect(res.status).toBe(200);
        await expect(res.arrayBuffer()).rejects.toThrow();
        expect(tracker.observer.onEnd).toHaveBeenCalledWith('error');
    });

    it('passes the 429 of a refused lease through', async () => {
        mockTrack.mockResolvedValue({
            ok: false,
            response: new Response('slow down', { status: 429 }),
        });
        expect((await call()).status).toBe(429);
    });

    it('an invalid season is rejected', async () => {
        expect((await call('?season=abc')).status).toBe(422);
    });
});
