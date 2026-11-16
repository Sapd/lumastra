// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test, vi } from 'vitest';
import type { BrowserEnv } from './browser-profile';
import {
    DownloadQueue,
    retryDelayMs,
    type DownloadList,
    type DownloadListItem,
} from './download-queue.svelte';

vi.mock('$app/paths', () => ({ base: '' }));

// ---- fake File System Access API -------------------------------------------------

class FakeFs {
    failWrites = false;
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
                        if (fs.failWrites) throw new DOMException('disk', 'NotAllowedError');
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
    opts: {
        fs?: FakeFs;
        noPicker?: boolean;
        sleep?: (ms: number) => Promise<void>;
        pick?: () => Promise<FileSystemDirectoryHandle>;
        env?: BrowserEnv;
        /** Answers GET /api/me/downloads/slots[?fileId=]; default: free slots, every file started */
        slots?: (fileId: string | null, call: number) => Response | Promise<Response>;
    } = {},
) {
    const fs = opts.fs ?? new FakeFs();
    const calls: string[] = [];
    const sleeps: number[] = [];
    const links: Array<{ url: string; fileName: string }> = [];
    const counts = new Map<string, number>();
    const slotCalls: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/download-list')) return json(l);
        if (url.includes('/downloads/slots')) {
            slotCalls.push(url);
            const f = new URL(url, 'http://x').searchParams.get('fileId');
            if (opts.slots) return opts.slots(f, slotCalls.length);
            return json({ maxParallel: l.maxParallel, inUse: 0, ...(f ? { started: true } : {}) });
        }
        const fileId = new URL(url, 'http://x').searchParams.get('fileId') ?? '';
        calls.push(fileId);
        const c = (counts.get(fileId) ?? 0) + 1;
        counts.set(fileId, c);
        return onDownload(fileId, c);
    });
    const q = new DownloadQueue({
        fetch: fetchFn as unknown as typeof fetch,
        sleep:
            opts.sleep ??
            (async (ms) => {
                sleeps.push(ms);
                // yield a macrotask so a polling loop cannot starve the test's own waits
                await new Promise((r) => setTimeout(r, 0));
            }),
        pickDirectory: opts.noPicker ? null : (opts.pick ?? (async () => fs.root())),
        ...(opts.env ? { env: () => opts.env as BrowserEnv } : {}),
        triggerLink: (url, fileName) => links.push({ url, fileName }),
    });
    return { q, fs, calls, sleeps, links, fetchFn, slotCalls };
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
        // a 1 s confirmation poll after each hand-off, and the gap between the two
        expect(sleeps).toEqual([1000, 1500, 1000]);
        expect(q.state).toBe('done');
        expect(q.mode).toBe('links');
        // only the list and the slot probes were fetched, the browser does the downloads
        expect(fetchFn.mock.calls.filter((c) => !String(c[0]).includes('/downloads/slots'))).toHaveLength(1);
    });
});

describe('DownloadQueue folder picker errors', () => {
    test('AbortError (user cancelled) keeps the picker available', async () => {
        const { q } = setup(list([item(1)]), () => fileResponse(5), {
            pick: async () => {
                throw new DOMException('cancelled', 'AbortError');
            },
        });
        expect(await q.chooseFolder()).toBe(false);
        expect(q.supportsFolderPicker).toBe(true);
        expect(q.pickerReason).toBeNull();
    });

    test('SecurityError disables the picker for the session and sets blocked', async () => {
        const { q } = setup(list([item(1)]), () => fileResponse(5), {
            pick: async () => {
                throw new DOMException('blocked', 'SecurityError');
            },
        });
        expect(await q.chooseFolder()).toBe(false);
        expect(q.supportsFolderPicker).toBe(false);
        expect(q.pickerReason).toBe('blocked');
    });

    test('TypeError also disables it', async () => {
        const { q } = setup(list([item(1)]), () => fileResponse(5), {
            pick: async () => {
                throw new TypeError('nope');
            },
        });
        await q.chooseFolder();
        expect(q.supportsFolderPicker).toBe(false);
    });
});

describe('DownloadQueue picker error after a successful pick', () => {
    test('falls back to link hand-off and forgets the folder', async () => {
        const fs = new FakeFs();
        let n = 0;
        const { q, links, fetchFn } = setup(list([item(1)]), () => fileResponse(5), {
            fs,
            pick: async () => {
                if (n++ === 0) return fs.root();
                throw new DOMException('blocked', 'SecurityError');
            },
        });
        expect(await q.chooseFolder()).toBe(true);
        expect(await q.chooseFolder()).toBe(false);
        expect(q.folderName).toBeNull();
        await q.enqueue('series-1');
        await q.start();
        expect(q.mode).toBe('links');
        expect(links).toHaveLength(1);
        expect(
            fetchFn.mock.calls.filter((c) => !String(c[0]).includes('/downloads/slots')),
        ).toHaveLength(1); // list only, no file fetch
    });
});

describe('DownloadQueue iOS link profile', () => {
    const ios: BrowserEnv = {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Safari/604.1',
        maxTouchPoints: 5,
        brave: false,
    };

    test('hands off one file per "next" click', async () => {
        const { q, links } = setup(
            list([item(1), item(2), item(3)], { maxParallel: 3 }),
            () => fileResponse(5),
            { noPicker: true, env: ios },
        );
        await q.enqueue('series-1');
        await q.start();
        expect(links).toHaveLength(1);
        expect(q.linksRemaining).toBe(2);
        await q.startNextLinks();
        expect(links).toHaveLength(2);
        await q.startNextLinks();
        expect(links).toHaveLength(3);
        expect(q.linksRemaining).toBe(0);
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

describe('DownloadQueue failures and limits', () => {
    test('enqueue during a run does not change the final state or error', async () => {
        const { q } = setup(list([item(1), item(2)], { maxParallel: 1 }), (fileId) => {
            if (fileId === 'f-1') void q.enqueue('other-series');
            return fileResponse(5);
        });
        await q.enqueue('s');
        await q.chooseFolder();
        await q.start();
        expect(q.state).toBe('done');
        expect(q.error).toBeUndefined();
        expect(q.notice).toBe('busy');
        expect(q.pending).toBeNull();
    });

    test('a failed item is recorded with a reason and the run still ends done', async () => {
        const { q } = setup(list([item(1), item(2)], { maxParallel: 1 }), (fileId) =>
            fileId === 'f-1' ? json({}, 500) : fileResponse(5),
        );
        await q.enqueue('s');
        await q.chooseFolder();
        await q.start();
        expect(q.state).toBe('done');
        expect(q.failedCount).toBe(1);
        expect(q.items[0]).toMatchObject({ status: 'failed', reason: 'http' });
        expect(q.items[1].status).toBe('done');
        expect(q.bytesDone).toBe(5);
    });

    test('a short body is a size mismatch, not done, and its bytes are given back', async () => {
        const { q } = setup(list([item(1)]), () => fileResponse(3));
        await q.enqueue('s');
        await q.chooseFolder();
        await q.start();
        expect(q.items[0]).toMatchObject({
            status: 'failed',
            reason: 'size_mismatch',
            bytesDone: 0,
        });
        expect(q.bytesDone).toBe(0);
        expect(q.state).toBe('done');
    });

    test('a failing write cancels the response body and fails the item', async () => {
        const fs = new FakeFs();
        fs.failWrites = true;
        let cancelled = false;
        const { q } = setup(
            list([item(1)]),
            () =>
                new Response(
                    new ReadableStream({
                        pull(c) {
                            c.enqueue(new Uint8Array(5));
                        },
                        cancel() {
                            cancelled = true;
                        },
                    }),
                ),
            { fs },
        );
        await q.enqueue('s');
        await q.chooseFolder();
        await q.start();
        expect(cancelled).toBe(true);
        expect(q.items[0]).toMatchObject({ status: 'failed', reason: 'write' });
    });

    test('a failed write of a 4 GiB+ file says FAT32', async () => {
        const fs = new FakeFs();
        fs.failWrites = true;
        const big = item(1, 5 * 1024 ** 3);
        const { q } = setup(list([big]), () => fileResponse(1), { fs });
        await q.enqueue('s');
        await q.chooseFolder();
        await q.start();
        expect(q.items[0]).toMatchObject({ status: 'failed', reason: 'fat32' });
    });

    test('429 backs off, honours Retry-After as a floor and gives up after 10 attempts', async () => {
        const { q, calls, sleeps } = setup(
            list([item(1), item(2)], { maxParallel: 1 }),
            (fileId) =>
                fileId === 'f-1' ? json({}, 429, { 'retry-after': '3' }) : fileResponse(5),
        );
        await q.enqueue('s');
        await q.chooseFolder();
        await q.start();
        expect(calls.filter((c) => c === 'f-1')).toHaveLength(10);
        expect(sleeps).toHaveLength(9);
        expect(sleeps[0]).toBe(3000); // Retry-After floor beats 1 s backoff
        expect(sleeps.slice(1, 4)).toEqual([3000, 4000, 8000]);
        expect(sleeps.every((ms, i) => i === 0 || ms >= sleeps[i - 1])).toBe(true);
        expect(Math.max(...sleeps)).toBeLessThanOrEqual(60_000);
        expect(q.items[0]).toMatchObject({ status: 'failed', reason: 'limit' });
        // the queue goes on with the next item
        expect(q.items[1].status).toBe('done');
        expect(q.state).toBe('done');
    });

    test('retryDelayMs caps at 60 s', () => {
        const res = new Response(null, { status: 429, headers: { 'retry-after': '120' } });
        expect(retryDelayMs(res, 1)).toBe(60_000);
        expect(retryDelayMs(new Response(null, { status: 429 }), 9)).toBe(60_000);
        expect(retryDelayMs(new Response(null, { status: 429 }), 1)).toBe(1000);
    });

    test('shows a waiting state during the 429 wait and cancel() ends the wait', async () => {
        let q!: DownloadQueue;
        let waitingSeen = false;
        const s = setup(list([item(1)]), () => json({}, 429), {
            sleep: () => {
                waitingSeen = q.items[0].status === 'waiting';
                return new Promise<void>(() => {}); // never resolves on its own
            },
        });
        q = s.q;
        await q.enqueue('s');
        await q.chooseFolder();
        const run = q.start();
        await vi.waitFor(() => expect(waitingSeen).toBe(true));
        q.cancel();
        await run;
        expect(q.state).toBe('stopped');
        expect(q.items[0].status).toBe('cancelled');
        expect(q.failedCount).toBe(0);
    });

    test('maxParallel 0 is capped at 4 concurrent fetches', async () => {
        let open = 0;
        let max = 0;
        const releases: Array<() => void> = [];
        const items = [1, 2, 3, 4, 5, 6].map((n) => item(n));
        const { q } = setup(list(items, { maxParallel: 0 }), () => {
            open += 1;
            max = Math.max(max, open);
            return new Promise<Response>((resolve) =>
                releases.push(() => {
                    open -= 1;
                    resolve(fileResponse(5));
                }),
            );
        });
        await q.enqueue('s');
        await q.chooseFolder();
        const run = q.start();
        for (let i = 0; i < 6; i++) {
            await vi.waitFor(() => expect(releases.length).toBeGreaterThan(i));
            releases[i]();
        }
        await run;
        expect(max).toBe(4);
    });

    test('downloadInfo probes with summary=1 and never fetches the item list', async () => {
        const f = vi.fn(async (_url: string) => json({ allowed: true, maxParallel: 2 }));
        const q = new DownloadQueue({ fetch: f as unknown as typeof fetch, pickDirectory: null });
        expect(await q.downloadInfo('movie-1')).toEqual({ allowed: true, maxParallel: 2 });
        expect(String(f.mock.calls[0][0])).toBe('/api/media/movie-1/download-list?summary=1');
        expect(f).toHaveBeenCalledTimes(1);
    });
});

describe('DownloadQueue link batches', () => {
    test('hands over at most maxParallel links, then "Start next" does the rest', async () => {
        const { q, links } = setup(
            list([1, 2, 3, 4, 5].map((n) => item(n)), { maxParallel: 2 }),
            () => fileResponse(5),
            { noPicker: true },
        );
        await q.enqueue('s');
        await q.start();
        expect(links).toHaveLength(2);
        expect(q.linksRemaining).toBe(3);
        expect(q.linkBatch).toBe(2);
        await q.startNextLinks();
        expect(links).toHaveLength(4);
        expect(q.linksRemaining).toBe(1);
        await q.startNextLinks();
        expect(links.map((l) => l.fileName)).toHaveLength(5);
        expect(q.linksRemaining).toBe(0);
        expect(q.state).toBe('done');
        await q.startNextLinks(); // nothing left: a no-op
        expect(links).toHaveLength(5);
    });

    test('unlimited (0) hands over 4 at a time', async () => {
        const { q, links } = setup(
            list([1, 2, 3, 4, 5, 6].map((n) => item(n)), { maxParallel: 0 }),
            () => fileResponse(5),
            { noPicker: true },
        );
        await q.enqueue('s');
        await q.start();
        expect(links).toHaveLength(4);
        expect(q.linksRemaining).toBe(2);
    });
});

describe('DownloadQueue size check and network errors', () => {
    test('compares against the response Content-Length when present', async () => {
        const { q } = setup(list([item(1, 5)]), () => {
            // the file changed since the list: 7 bytes, and it says so
            return new Response(new Uint8Array(7), { headers: { 'content-length': '7' } });
        });
        await q.enqueue('s');
        await q.chooseFolder();
        await q.start();
        expect(q.items[0]).toMatchObject({ status: 'done' });
    });

    test('a short body against its own Content-Length is a size mismatch', async () => {
        const { q } = setup(list([item(1, 5)]), () => {
            const body = new ReadableStream<Uint8Array>({
                start(c) {
                    c.enqueue(new Uint8Array(3));
                    c.close();
                },
            });
            return new Response(body, { headers: { 'content-length': '5' } });
        });
        await q.enqueue('s');
        await q.chooseFolder();
        await q.start();
        expect(q.items[0]).toMatchObject({ status: 'failed', reason: 'size_mismatch' });
    });

    test('a fetch network failure is retried twice from the start, then fails as network', async () => {
        const { q, calls, sleeps } = setup(list([item(1)]), () => {
            throw new TypeError('Failed to fetch');
        });
        await q.enqueue('s');
        await q.chooseFolder();
        await q.start();
        expect(calls).toHaveLength(3);
        expect(sleeps).toEqual([1000, 2000]);
        expect(q.items[0]).toMatchObject({ status: 'failed', reason: 'network' });
        expect(q.bytesDone).toBe(0);
    });

    test('a body that drops mid-stream is retried and can then succeed', async () => {
        const { q, calls, fs } = setup(list([item(1, 5)]), (_f, call) => {
            if (call === 1) {
                const body = new ReadableStream<Uint8Array>({
                    start(c) {
                        c.enqueue(new Uint8Array(2));
                        c.error(new TypeError('network error'));
                    },
                });
                return new Response(body);
            }
            return fileResponse(5);
        });
        await q.enqueue('s');
        await q.chooseFolder();
        await q.start();
        expect(calls).toHaveLength(2);
        expect(q.items[0]).toMatchObject({ status: 'done', bytesDone: 5 });
        expect(q.bytesDone).toBe(5);
        expect([...fs.files.values()]).toEqual([5]);
    });

    test('a file-system error is not retried', async () => {
        const fs = new FakeFs();
        fs.failWrites = true;
        const { q, calls } = setup(list([item(1, 5)]), () => fileResponse(5), { fs });
        await q.enqueue('s');
        await q.chooseFolder();
        await q.start();
        expect(calls).toHaveLength(1);
        expect(q.items[0]).toMatchObject({ status: 'failed', reason: 'write' });
    });

    test('cancel during a network back-off ends the file as cancelled', async () => {
        let release!: () => void;
        const { q } = setup(
            list([item(1)]),
            () => {
                throw new TypeError('Failed to fetch');
            },
            { sleep: () => new Promise<void>((r) => (release = r)) },
        );
        await q.enqueue('s');
        await q.chooseFolder();
        const run = q.start();
        await vi.waitFor(() => expect(q.items[0].status).toBe('waiting'));
        q.cancel();
        release?.();
        await run;
        expect(q.items[0].status).toBe('cancelled');
    });
});

describe('DownloadQueue permission probe cache', () => {
    test('a failed probe is not cached', async () => {
        let n = 0;
        const f = vi.fn(async (_url: string) =>
            ++n === 1 ? new Response('x', { status: 500 }) : json({ allowed: true, maxParallel: 1 }),
        );
        const q = new DownloadQueue({ fetch: f as unknown as typeof fetch, pickDirectory: null });
        expect(await q.downloadInfo('series-1')).toEqual({ allowed: false, maxParallel: 0 });
        expect(await q.downloadInfo('series-1')).toEqual({ allowed: true, maxParallel: 1 });
        expect(f).toHaveBeenCalledTimes(2);
    });

    test('a network error is not cached either', async () => {
        let n = 0;
        const f = vi.fn(async (_url: string) => {
            if (++n === 1) throw new TypeError('offline');
            return json({ allowed: true, maxParallel: 1 });
        });
        const q = new DownloadQueue({ fetch: f as unknown as typeof fetch, pickDirectory: null });
        expect((await q.downloadInfo('series-1')).allowed).toBe(false);
        expect((await q.downloadInfo('series-1')).allowed).toBe(true);
    });

    test('many episode buttons keyed by one series id share one probe', async () => {
        const f = vi.fn(async (_url: string) => json({ allowed: true, maxParallel: 1 }));
        const q = new DownloadQueue({ fetch: f as unknown as typeof fetch, pickDirectory: null });
        await Promise.all(Array.from({ length: 30 }, () => q.downloadInfo('series-1')));
        expect(f).toHaveBeenCalledTimes(1);
    });

    test('keeps at most 200 probes, dropping the oldest', async () => {
        const f = vi.fn(async (_url: string) => json({ allowed: true, maxParallel: 1 }));
        const q = new DownloadQueue({ fetch: f as unknown as typeof fetch, pickDirectory: null });
        for (let i = 0; i < 205; i++) await q.downloadInfo(`id-${i}`);
        expect(f).toHaveBeenCalledTimes(205);
        await q.downloadInfo('id-204'); // still cached
        expect(f).toHaveBeenCalledTimes(205);
        await q.downloadInfo('id-0'); // evicted: probed again
        expect(f).toHaveBeenCalledTimes(206);
    });
});


describe('DownloadQueue link mode watches the server', () => {
    const linkSetup = (
        n: number,
        slots: (f: string | null, call: number) => Response | Promise<Response>,
        maxParallel = 2,
    ) =>
        setup(list(Array.from({ length: n }, (_, i) => item(i + 1)), { maxParallel }), () => fileResponse(5), {
            noPicker: true,
            slots,
        });

    test('waits for a free slot before handing over, polling every 3 s', async () => {
        let inUse = 2; // another device holds both slots
        const { q, links, sleeps } = linkSetup(1, (f) =>
            json({ maxParallel: 2, inUse, ...(f ? { started: true } : {}) }),
        );
        await q.enqueue('s');
        const run = q.start();
        await vi.waitFor(() => expect(sleeps).toContain(3000));
        expect(links).toHaveLength(0);
        expect(q.items[0].status).toBe('waiting');
        inUse = 1; // a slot frees up
        await vi.waitFor(() => expect(links).toHaveLength(1));
        await run;
        expect(q.items[0].status).toBe('handed');
    });

    test('unlimited (maxParallel 0) never waits', async () => {
        const { q, links, sleeps } = linkSetup(
            1,
            (f) => json({ maxParallel: 0, inUse: 9, ...(f ? { started: true } : {}) }),
            0,
        );
        await q.enqueue('s');
        await q.start();
        expect(links).toHaveLength(1);
        expect(sleeps).not.toContain(3000);
    });

    test('a hand-off the server never saw is retried, then marked failed as not_started', async () => {
        const { q, links, sleeps } = linkSetup(1, (f) =>
            json({ maxParallel: 2, inUse: 0, ...(f ? { started: false } : {}) }),
        );
        await q.enqueue('s');
        await q.start();
        expect(links).toHaveLength(3); // the first hand-off plus two retries
        expect(sleeps.filter((ms) => ms === 1000)).toHaveLength(30); // 10 polls per attempt
        expect(q.items[0]).toMatchObject({ status: 'failed', reason: 'not_started' });
        expect(q.bytesDone).toBe(0);
        expect(q.failedCount).toBe(1);
    });

    test('a retry that the server then sees ends as handed', async () => {
        let seen = 0;
        const { q, links } = linkSetup(1, (f) => {
            if (!f) return json({ maxParallel: 2, inUse: 0 });
            seen += 1;
            return json({ maxParallel: 2, inUse: 0, started: seen > 10 }); // second attempt succeeds
        });
        await q.enqueue('s');
        await q.start();
        expect(links).toHaveLength(2);
        expect(q.items[0].status).toBe('handed');
        expect(q.bytesDone).toBe(5);
    });

    test('a download that already finished (log row) counts as started', async () => {
        // inUse never rose, but the server has the transfer in the log: started = true
        const { q, links } = linkSetup(1, (f) =>
            json({ maxParallel: 2, inUse: 0, ...(f ? { started: true } : {}) }),
        );
        await q.enqueue('s');
        await q.start();
        expect(links).toHaveLength(1);
        expect(q.items[0].status).toBe('handed');
    });

    test('when the slots endpoint fails, hand-offs are trusted as before', async () => {
        const { q, links } = linkSetup(2, () => new Response('nope', { status: 500 }));
        await q.enqueue('s');
        await q.start();
        expect(links).toHaveLength(2);
        expect(q.items.map((i) => i.status)).toEqual(['handed', 'handed']);
    });

    test('cancelling while waiting for a slot hands nothing over', async () => {
        const { q, links, sleeps } = linkSetup(1, (f) =>
            json({ maxParallel: 1, inUse: 1, ...(f ? { started: true } : {}) }),
            1,
        );
        await q.enqueue('s');
        const run = q.start();
        await vi.waitFor(() => expect(sleeps).toContain(3000));
        q.cancel();
        await run;
        expect(links).toHaveLength(0);
        expect(q.state).toBe('stopped');
        expect(q.items[0].status).toBe('queued');
    });

    test('the browser-profile batch size still caps one run', async () => {
        const { q, links } = linkSetup(5, (f) =>
            json({ maxParallel: 2, inUse: 0, ...(f ? { started: true } : {}) }),
        );
        await q.enqueue('s');
        await q.start();
        expect(links).toHaveLength(2);
        expect(q.linksRemaining).toBe(3);
    });
});
