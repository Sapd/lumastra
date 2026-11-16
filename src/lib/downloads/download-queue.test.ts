// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test, vi } from 'vitest';
import { DownloadQueue, type DownloadList, type DownloadListItem } from './download-queue.svelte';

vi.mock('$app/paths', () => ({ base: '' }));

// ---- fake File System Access API -------------------------------------------------

class FakeFs {
    files = new Map<string, number>(); // 'a/b/c.mkv' -> size
    dirs = new Set<string>();
    root(): FileSystemDirectoryHandle {
        return this.dir('');
    }
    private dir(path: string): FileSystemDirectoryHandle {
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- handles outlive the method call
        const fs = this;
        const join = (n: string) => (path ? `${path}/${n}` : n);
        return {
            kind: 'directory',
            name: path.split('/').pop() ?? '',
            async getDirectoryHandle(name: string, o?: { create?: boolean }) {
                const p = join(name);
                if (!fs.dirs.has(p)) {
                    if (!o?.create) throw new DOMException('nope', 'NotFoundError');
                    fs.dirs.add(p);
                }
                return fs.dir(p);
            },
            async getFileHandle(name: string, o?: { create?: boolean }) {
                const p = join(name);
                if (!fs.files.has(p)) {
                    if (!o?.create) throw new DOMException('nope', 'NotFoundError');
                    fs.files.set(p, 0);
                }
                return {
                    kind: 'file',
                    name,
                    async getFile() {
                        return { size: fs.files.get(p) ?? 0 };
                    },
                    async createWritable() {
                        let size = 0;
                        fs.files.set(p, 0);
                        return new WritableStream<Uint8Array>({
                            write(chunk) {
                                size += chunk.byteLength;
                                fs.files.set(p, size);
                            },
                        });
                    },
                };
            },
        } as unknown as FileSystemDirectoryHandle;
    }
}

function item(n: number, size = 5): DownloadListItem {
    return {
        mediaItemId: `ep-${n}`,
        fileId: `f-${n}`,
        season: 1,
        episode: n,
        seasonFolder: 'Season 01',
        fileName: `Show - S01E0${n} - T${n}.mkv`,
        sizeBytes: size,
        available: true,
    };
}

function list(items: DownloadListItem[], over: Partial<DownloadList> = {}): DownloadList {
    return {
        allowed: true,
        maxParallel: 3,
        seriesFolder: 'Show (2020)',
        missingCount: 0,
        items,
        ...over,
    };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}

function fileResponse(size: number) {
    return new Response(new Uint8Array(size), { status: 200 });
}

function setup(
    l: DownloadList,
    onDownload: (fileId: string, call: number) => Response | Promise<Response>,
    opts: { fs?: FakeFs; noPicker?: boolean } = {},
) {
    const fs = opts.fs ?? new FakeFs();
    const calls: string[] = [];
    const sleeps: number[] = [];
    const links: Array<{ url: string; fileName: string }> = [];
    const counts = new Map<string, number>();
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/download-list')) return json(l);
        const fileId = new URL(url, 'http://x').searchParams.get('fileId') ?? '';
        calls.push(fileId);
        const c = (counts.get(fileId) ?? 0) + 1;
        counts.set(fileId, c);
        return onDownload(fileId, c);
    });
    const q = new DownloadQueue({
        fetch: fetchFn as unknown as typeof fetch,
        sleep: async (ms) => {
            sleeps.push(ms);
        },
        pickDirectory: opts.noPicker ? null : async () => fs.root(),
        triggerLink: (url, fileName) => links.push({ url, fileName }),
    });
    return { q, fs, calls, sleeps, links, fetchFn };
}

describe('DownloadQueue folder mode', () => {
    test('writes Show (Year)/Season 01/<name> and finishes', async () => {
        const { q, fs } = setup(list([item(1), item(2)]), () => fileResponse(5));
        await q.enqueue('series-1');
        expect(q.pending?.list.items).toHaveLength(2);
        await q.chooseFolder();
        await q.start();
        expect([...fs.files.keys()].sort()).toEqual([
            'Show (2020)/Season 01/Show - S01E01 - T1.mkv',
            'Show (2020)/Season 01/Show - S01E02 - T2.mkv',
        ]);
        expect(q.state).toBe('done');
        expect(q.bytesDone).toBe(10);
        expect(q.bytesTotal).toBe(10);
    });

    test('movies land directly in the chosen folder', async () => {
        const movie: DownloadListItem = {
            ...item(1, 7),
            season: null,
            episode: null,
            seasonFolder: null,
            fileName: 'Film (2019).mkv',
        };
        const { q, fs } = setup(list([movie], { seriesFolder: 'Film (2019)' }), () =>
            fileResponse(7),
        );
        await q.enqueue('movie-1');
        await q.chooseFolder();
        await q.start();
        expect([...fs.files.keys()]).toEqual(['Film (2019).mkv']);
    });

    test('skips same-size, rewrites short', async () => {
        const fs = new FakeFs();
        fs.dirs.add('Show (2020)');
        fs.dirs.add('Show (2020)/Season 01');
        fs.files.set('Show (2020)/Season 01/Show - S01E01 - T1.mkv', 5); // complete
        fs.files.set('Show (2020)/Season 01/Show - S01E02 - T2.mkv', 2); // interrupted
        const { q, calls } = setup(list([item(1), item(2)]), () => fileResponse(5), { fs });
        await q.enqueue('series-1');
        await q.chooseFolder();
        await q.start();
        expect(calls).toEqual(['f-2']);
        expect(fs.files.get('Show (2020)/Season 01/Show - S01E02 - T2.mkv')).toBe(5);
        expect(q.items.map((i) => i.status)).toEqual(['skipped', 'done']);
        expect(q.bytesDone).toBe(10);
    });

    test('stops queue on 403', async () => {
        const { q, calls } = setup(list([item(1), item(2), item(3)], { maxParallel: 1 }), () =>
            json({ reason: 'downloads_not_allowed' }, 403),
        );
        await q.enqueue('series-1');
        await q.chooseFolder();
        await q.start();
        expect(calls).toEqual(['f-1']);
        expect(q.state).toBe('stopped');
        expect(q.error).toBe('downloads_not_allowed');
    });

    test('429 waits Retry-After and retries the same item', async () => {
        const { q, calls, sleeps, fs } = setup(list([item(1)]), (_f, call) =>
            call === 1 ? json({}, 429, { 'retry-after': '2' }) : fileResponse(5),
        );
        await q.enqueue('series-1');
        await q.chooseFolder();
        await q.start();
        expect(calls).toEqual(['f-1', 'f-1']);
        expect(sleeps).toEqual([2000]);
        expect(fs.files.size).toBe(1);
        expect(q.state).toBe('done');
    });

    test('never more than maxParallel fetches open', async () => {
        let open = 0;
        let max = 0;
        const releases: Array<() => void> = [];
        const l = list([item(1), item(2), item(3), item(4), item(5)], { maxParallel: 2 });
        const { q } = setup(l, () => {
            open += 1;
            max = Math.max(max, open);
            return new Promise<Response>((resolve) => {
                releases.push(() => {
                    open -= 1;
                    resolve(fileResponse(5));
                });
            });
        });
        await q.enqueue('series-1');
        await q.chooseFolder();
        const run = q.start();
        for (let done = 0; done < 5; done++) {
            await vi.waitFor(() => expect(releases.length).toBeGreaterThan(done));
            expect(open).toBeLessThanOrEqual(2);
            releases[done]();
        }
        await run;
        expect(max).toBe(2);
        expect(q.state).toBe('done');
    });

    test('maxParallel 0 means unlimited', async () => {
        let open = 0;
        let max = 0;
        const releases: Array<() => void> = [];
        const { q } = setup(list([item(1), item(2), item(3)], { maxParallel: 0 }), () => {
            open += 1;
            max = Math.max(max, open);
            return new Promise<Response>((resolve) =>
                releases.push(() => resolve(fileResponse(5))),
            );
        });
        await q.enqueue('s');
        await q.chooseFolder();
        const run = q.start();
        await vi.waitFor(() => expect(releases).toHaveLength(3));
        releases.forEach((r) => r());
        await run;
        expect(max).toBe(3);
    });

    test('names that sanitize to the same file do not overwrite each other', async () => {
        const a = { ...item(1), fileName: 'Show: A.mkv' };
        const b = { ...item(2), fileName: 'Show? A.mkv' };
        const { q, fs } = setup(list([a, b]), () => fileResponse(5));
        await q.enqueue('s');
        await q.chooseFolder();
        await q.start();
        expect([...fs.files.keys()].sort()).toEqual([
            'Show (2020)/Season 01/Show_ A (2).mkv',
            'Show (2020)/Season 01/Show_ A.mkv',
        ]);
    });
});

describe('DownloadQueue link mode', () => {
    test('hands each item to the browser one after another with a gap', async () => {
        const { q, links, sleeps, fetchFn } = setup(
            list([item(1), item(2)]),
            () => fileResponse(5),
            { noPicker: true },
        );
        await q.enqueue('series-1');
        expect(q.supportsFolderPicker).toBe(false);
        await q.start();
        expect(links).toEqual([
            { url: '/api/media/ep-1/download?fileId=f-1', fileName: 'Show - S01E01 - T1.mkv' },
            { url: '/api/media/ep-2/download?fileId=f-2', fileName: 'Show - S01E02 - T2.mkv' },
        ]);
        expect(sleeps).toEqual([1500]);
        expect(q.state).toBe('done');
        expect(q.mode).toBe('links');
        // only the list was fetched, the browser does the downloads
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });
});

describe('DownloadQueue enqueue', () => {
    test('not allowed: no sheet, error set', async () => {
        const { q } = setup(list([item(1)], { allowed: false }), () => fileResponse(5));
        await q.enqueue('series-1');
        expect(q.pending).toBeNull();
        expect(q.error).toBe('downloads_not_allowed');
    });

    test('cancel stops a running queue', async () => {
        const { q, calls } = setup(list([item(1), item(2)], { maxParallel: 1 }), () => {
            q.cancel();
            return fileResponse(5);
        });
        await q.enqueue('s');
        await q.chooseFolder();
        await q.start();
        expect(calls).toEqual(['f-1']);
        expect(q.state).toBe('stopped');
    });
});
