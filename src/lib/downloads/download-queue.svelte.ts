// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * download-queue.svelte.ts - client-side queue for "download a season / series".
 *
 * Lives in module scope so it survives closing the modal (not the tab).
 *
 * Two modes:
 *  - folder: Chromium's File System Access API. The user picks a folder once
 *    (a USB stick); each file is fetched and streamed into
 *    `Show (Year)/Season 01/<name>`. A file that already has the expected size is
 *    skipped, a shorter one (interrupted run) is rewritten.
 *  - links: every other browser. A hidden `<a download>` per item, one after
 *    another with a short gap. The browser's download manager does the transfer,
 *    so there is no progress and no way to see a 403/429 here (the server's
 *    limits still apply to each request).
 */

import { base } from '$app/paths';
import { SvelteMap, SvelteSet, SvelteURLSearchParams } from 'svelte/reactivity';
import { sanitizePathSegment } from './path-sanitize';

export interface DownloadListItem {
    mediaItemId: string;
    fileId: string;
    season: number | null;
    episode: number | null;
    seasonFolder: string | null;
    fileName: string;
    sizeBytes: number;
    available: boolean;
}

export interface DownloadList {
    allowed: boolean;
    /** 0 = unlimited */
    maxParallel: number;
    seriesFolder: string;
    missingCount: number;
    items: DownloadListItem[];
}

export interface EnqueueOptions {
    season?: number;
    specials?: boolean;
}

export type QueueItemStatus = 'queued' | 'active' | 'done' | 'skipped' | 'failed' | 'handed';
export type QueueState = 'idle' | 'running' | 'done' | 'stopped';

export interface QueueItem extends DownloadListItem {
    /** Path under the chosen folder, already sanitised */
    path: string[];
    status: QueueItemStatus;
    bytesDone: number;
}

export interface PendingDownload {
    mediaItemId: string;
    opts: EnqueueOptions;
    list: DownloadList;
}

export interface QueueDeps {
    fetch: typeof fetch;
    sleep: (ms: number) => Promise<void>;
    /** null = browser has no folder picker */
    pickDirectory: (() => Promise<FileSystemDirectoryHandle>) | null;
    triggerLink: (url: string, fileName: string) => void;
}

export interface DownloadInfo {
    allowed: boolean;
    sizeBytes: number;
}
const NO_DOWNLOAD: DownloadInfo = { allowed: false, sizeBytes: 0 };

const LINK_GAP_MS = 1500;
const DEFAULT_RETRY_MS = 5000;
const MAX_RETRY_MS = 60_000;

function defaultDeps(): QueueDeps {
    const hasPicker = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
    return {
        fetch: (...args) => globalThis.fetch(...args),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        pickDirectory: hasPicker
            ? () =>
                  (
                      window as unknown as {
                          showDirectoryPicker: (o: {
                              mode: 'readwrite';
                          }) => Promise<FileSystemDirectoryHandle>;
                      }
                  ).showDirectoryPicker({ mode: 'readwrite' })
            : null,
        triggerLink: (url, fileName) => {
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            a.rel = 'noopener';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            a.remove();
        },
    };
}

export function downloadUrl(mediaItemId: string, fileId: string): string {
    return `${base}/api/media/${encodeURIComponent(mediaItemId)}/download?fileId=${encodeURIComponent(fileId)}`;
}

function listUrl(mediaItemId: string, opts: EnqueueOptions): string {
    const q = new SvelteURLSearchParams();
    if (opts.season !== undefined) q.set('season', String(opts.season));
    if (opts.specials) q.set('specials', '1');
    const qs = q.toString();
    return `${base}/api/media/${encodeURIComponent(mediaItemId)}/download-list${qs ? `?${qs}` : ''}`;
}

function retryDelayMs(res: Response): number {
    const raw = Number(res.headers.get('retry-after'));
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_RETRY_MS;
    return Math.min(raw * 1000, MAX_RETRY_MS);
}

function isNotFound(e: unknown): boolean {
    return e instanceof DOMException && e.name === 'NotFoundError';
}

export class DownloadQueue {
    items = $state<QueueItem[]>([]);
    current = $state<QueueItem | null>(null);
    bytesDone = $state(0);
    bytesTotal = $state(0);
    /** bytes per second, folder mode only */
    speed = $state(0);
    state = $state<QueueState>('idle');
    error = $state<string | undefined>(undefined);
    mode = $state<'folder' | 'links' | null>(null);
    /** Set by enqueue(); the confirm sheet shows it */
    pending = $state<PendingDownload | null>(null);
    folderName = $state<string | null>(null);
    loading = $state(false);

    private deps: QueueDeps;
    private dirHandle: FileSystemDirectoryHandle | null = null;
    private abort: AbortController | null = null;
    private stopRequested = false;
    private windowStart = 0;
    private windowBytes = 0;
    private infoCache = new SvelteMap<string, { at: number; value: Promise<DownloadInfo> }>();

    constructor(deps?: Partial<QueueDeps>) {
        this.deps = { ...defaultDeps(), ...deps };
    }

    get supportsFolderPicker(): boolean {
        return this.deps.pickDirectory !== null;
    }

    /**
     * Whether download buttons should show for this item, and how big it is
     * (a movie's file; a series' total). One list call, cached for a minute;
     * any failure (feature off, 404, 403) means "no".
     */
    downloadInfo(mediaItemId: string): Promise<DownloadInfo> {
        const hit = this.infoCache.get(mediaItemId);
        if (hit && Date.now() - hit.at < 60_000) return hit.value;
        const value: Promise<DownloadInfo> = this.deps
            .fetch(listUrl(mediaItemId, {}))
            .then(async (res) => {
                if (!res.ok) return NO_DOWNLOAD;
                const list = (await res.json()) as DownloadList;
                return {
                    allowed: list.allowed === true && list.items.length > 0,
                    sizeBytes: list.items.reduce((s, i) => s + i.sizeBytes, 0),
                };
            })
            .catch(() => NO_DOWNLOAD);
        this.infoCache.set(mediaItemId, { at: Date.now(), value });
        return value;
    }

    /** Fetch the list for a title/season and open the confirm sheet. */
    async enqueue(mediaItemId: string, opts: EnqueueOptions = {}): Promise<void> {
        if (this.state === 'running') {
            this.error = 'busy';
            return;
        }
        this.error = undefined;
        this.loading = true;
        try {
            const res = await this.deps.fetch(listUrl(mediaItemId, opts));
            if (res.status === 403 || res.status === 404) {
                this.error = 'downloads_not_allowed';
                return;
            }
            if (!res.ok) {
                this.error = 'list_failed';
                return;
            }
            const list = (await res.json()) as DownloadList;
            if (!list.allowed) {
                this.error = 'downloads_not_allowed';
                return;
            }
            if (list.items.length === 0) {
                this.error = 'nothing_to_download';
                return;
            }
            this.pending = { mediaItemId, opts, list };
        } catch {
            this.error = 'list_failed';
        } finally {
            this.loading = false;
        }
    }

    /** Sheet checkbox: re-list the same series with or without season 0. */
    async setSpecials(include: boolean): Promise<void> {
        const p = this.pending;
        if (!p) return;
        await this.enqueue(p.mediaItemId, { ...p.opts, specials: include });
    }

    /** Must be called from a click handler (user activation). */
    async chooseFolder(): Promise<boolean> {
        if (!this.deps.pickDirectory) return false;
        try {
            this.dirHandle = await this.deps.pickDirectory();
            this.folderName = this.dirHandle.name || null;
            return true;
        } catch {
            // AbortError: the user closed the picker
            return false;
        }
    }

    forgetFolder(): void {
        this.dirHandle = null;
        this.folderName = null;
    }

    dismissPending(): void {
        this.pending = null;
    }

    /** Clear a finished/stopped run so the panel goes away. */
    reset(): void {
        if (this.state === 'running') return;
        this.items = [];
        this.current = null;
        this.bytesDone = 0;
        this.bytesTotal = 0;
        this.speed = 0;
        this.state = 'idle';
        this.error = undefined;
        this.mode = null;
    }

    cancel(): void {
        this.stopRequested = true;
        this.abort?.abort();
    }

    async start(): Promise<void> {
        const pending = this.pending;
        if (!pending || this.state === 'running') return;
        this.pending = null;

        const { list } = pending;
        this.mode = this.dirHandle ? 'folder' : 'links';
        this.items = this.buildItems(list);
        this.bytesDone = 0;
        this.bytesTotal = this.items.reduce((s, i) => s + i.sizeBytes, 0);
        this.speed = 0;
        this.error = undefined;
        this.current = null;
        this.stopRequested = false;
        this.abort = new AbortController();
        this.state = 'running';
        this.windowStart = Date.now();
        this.windowBytes = 0;
        this.addUnloadGuard();

        try {
            if (this.mode === 'folder') await this.runFolder(list);
            else await this.runLinks();
        } finally {
            this.removeUnloadGuard();
            this.current = null;
            this.speed = 0;
            this.state = this.stopRequested || this.error ? 'stopped' : 'done';
        }
    }

    // ---- internals ---------------------------------------------------------------

    private buildItems(list: DownloadList): QueueItem[] {
        const usedByDir = new SvelteMap<string, SvelteSet<string>>();
        const unique = (dir: string[], name: string) => {
            const key = dir.join('/');
            let used = usedByDir.get(key);
            if (!used) usedByDir.set(key, (used = new SvelteSet()));
            return sanitizePathSegment(name, used);
        };
        return list.items
            .filter((i) => i.available)
            .map((i) => {
                const dir: string[] = [];
                if (i.seasonFolder !== null) {
                    // Folders are shared by many items: sanitise, never de-duplicate.
                    dir.push(sanitizePathSegment(list.seriesFolder));
                    dir.push(sanitizePathSegment(i.seasonFolder));
                }
                return {
                    ...i,
                    path: [...dir, unique(dir, i.fileName)],
                    status: 'queued' as QueueItemStatus,
                    bytesDone: 0,
                };
            });
    }

    private fail(reason: string): void {
        if (!this.error) this.error = reason;
        this.stopRequested = true;
        this.abort?.abort();
    }

    private addBytes(item: QueueItem, n: number): void {
        item.bytesDone += n;
        this.bytesDone += n;
        this.windowBytes += n;
        const now = Date.now();
        const dt = now - this.windowStart;
        if (dt >= 1000) {
            this.speed = (this.windowBytes * 1000) / dt;
            this.windowStart = now;
            this.windowBytes = 0;
        }
    }

    private async runFolder(list: DownloadList): Promise<void> {
        const root = this.dirHandle as FileSystemDirectoryHandle;
        const queue = this.items;
        const limit =
            list.maxParallel > 0 ? Math.min(list.maxParallel, queue.length) : queue.length;
        let next = 0;
        const worker = async () => {
            while (!this.stopRequested) {
                const item = queue[next++];
                if (!item) return;
                await this.downloadToFolder(root, item);
            }
        };
        await Promise.all(Array.from({ length: limit }, worker));
    }

    private async downloadToFolder(
        root: FileSystemDirectoryHandle,
        item: QueueItem,
    ): Promise<void> {
        const view =
            this.items.find(
                (i) => i.mediaItemId === item.mediaItemId && i.fileId === item.fileId,
            ) ?? item;
        try {
            let dir = root;
            for (const part of item.path.slice(0, -1)) {
                dir = await dir.getDirectoryHandle(part, { create: true });
            }
            const fileName = item.path[item.path.length - 1];

            // Same size = already done (re-run after an interruption); shorter = redo.
            try {
                const existing = await (await dir.getFileHandle(fileName)).getFile();
                if (existing.size === item.sizeBytes) {
                    view.status = 'skipped';
                    this.bytesDone += item.sizeBytes;
                    return;
                }
            } catch (e) {
                if (!isNotFound(e)) throw e;
            }

            view.status = 'active';
            this.current = view;
            while (true) {
                if (this.stopRequested) return;
                const res = await this.deps.fetch(downloadUrl(item.mediaItemId, item.fileId), {
                    signal: this.abort?.signal,
                });
                if (res.status === 429) {
                    await res.body?.cancel();
                    await this.deps.sleep(retryDelayMs(res));
                    continue;
                }
                if (res.status === 403) {
                    await res.body?.cancel();
                    this.fail('downloads_not_allowed');
                    view.status = 'failed';
                    return;
                }
                if (!res.ok || !res.body) {
                    await res.body?.cancel();
                    view.status = 'failed';
                    return;
                }
                const handle = await dir.getFileHandle(fileName, { create: true });
                const writable = await handle.createWritable();
                const counter = new TransformStream<Uint8Array, Uint8Array>({
                    transform: (chunk, controller) => {
                        this.addBytes(view, chunk.byteLength);
                        controller.enqueue(chunk);
                    },
                });
                await res.body.pipeThrough(counter).pipeTo(writable as unknown as WritableStream);
                view.status = 'done';
                return;
            }
        } catch {
            // Aborted by cancel()/403, or a disk/network error for this item.
            view.status = 'failed';
        } finally {
            if (this.current === view) this.current = null;
        }
    }

    private async runLinks(): Promise<void> {
        for (let i = 0; i < this.items.length; i++) {
            if (this.stopRequested) return;
            const item = this.items[i];
            this.current = item;
            this.deps.triggerLink(downloadUrl(item.mediaItemId, item.fileId), item.fileName);
            item.status = 'handed';
            this.bytesDone += item.sizeBytes;
            if (i < this.items.length - 1) await this.deps.sleep(LINK_GAP_MS);
        }
    }

    private onBeforeUnload = (e: BeforeUnloadEvent) => {
        e.preventDefault();
        e.returnValue = '';
    };

    private addUnloadGuard(): void {
        if (typeof window !== 'undefined')
            window.addEventListener('beforeunload', this.onBeforeUnload);
    }

    private removeUnloadGuard(): void {
        if (typeof window !== 'undefined')
            window.removeEventListener('beforeunload', this.onBeforeUnload);
    }
}

export const downloadQueue = new DownloadQueue();
