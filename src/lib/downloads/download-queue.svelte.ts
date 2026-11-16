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
 *    limits still apply to each request). Only `linkBatchSize` links are handed
 *    over at a time (the user's parallel limit, 4 when unlimited) so a long
 *    season does not run into 429s; the panel offers "Start next N" for the rest.
 */

import { base } from '$app/paths';
import { SvelteMap, SvelteSet, SvelteURLSearchParams } from 'svelte/reactivity';
import { sanitizePathSegment } from './path-sanitize';
import {
    detectBrowserEnv,
    linkBatchSize,
    linkModeProfile,
    UNLIMITED_PARALLEL_CEILING,
    type BrowserEnv,
    type LinkModeProfile,
} from './browser-profile';

export { linkBatchSize };

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

export type QueueItemStatus =
    'queued' | 'active' | 'waiting' | 'done' | 'skipped' | 'failed' | 'cancelled' | 'handed';

/** Why an item failed. The panel shows a message per reason. */
export type FailureReason =
    | 'limit'
    | 'http'
    | 'network'
    | 'size_mismatch'
    | 'write'
    | 'fat32'
    | 'forbidden'
    /** Link mode: the server never saw the handed-over download start. */
    | 'not_started';

/** FAT32 cannot hold a file of 4 GiB or more. */
export const FAT32_LIMIT_BYTES = 4 * 1024 ** 3;
export type QueueState = 'idle' | 'running' | 'done' | 'stopped';

export interface QueueItem extends DownloadListItem {
    /** Path under the chosen folder, already sanitised */
    path: string[];
    status: QueueItemStatus;
    bytesDone: number;
    reason?: FailureReason;
}

export interface PendingDownload {
    mediaItemId: string;
    opts: EnqueueOptions;
    list: DownloadList;
}

export interface QueueDeps {
    fetch: typeof fetch;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** null = browser has no folder picker */
    pickDirectory: (() => Promise<FileSystemDirectoryHandle>) | null;
    triggerLink: (url: string, fileName: string) => void;
    /** Read lazily: decides the link-mode profile and the Brave hint */
    env: () => BrowserEnv;
}

export interface DownloadInfo {
    allowed: boolean;
    maxParallel: number;
}
const NO_DOWNLOAD: DownloadInfo = { allowed: false, maxParallel: 0 };

const MAX_RETRY_MS = 60_000;
const BACKOFF_BASE_MS = 1000;
const MAX_429_ATTEMPTS = 10;
/** A dropped connection is retried this many times, from the start of the file. */
const MAX_NETWORK_RETRIES = 2;
/** Permission probes kept; the oldest is dropped beyond this. */
const MAX_INFO_CACHE = 200;
/** Link mode: how often to ask for a free slot while the user's limit is reached. */
const SLOT_POLL_MS = 3_000;
/** Link mode: how long a handed-over download has to show up on the server. */
const START_CONFIRM_MS = 10_000;
const START_CONFIRM_POLL_MS = 1_000;
/** Link mode: extra hand-offs for a download the server did not see start. */
const MAX_HANDOFF_RETRIES = 2;

function defaultDeps(): QueueDeps {
    const hasPicker = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
    return {
        env: detectBrowserEnv,
        fetch: (...args) => globalThis.fetch(...args),
        sleep: (ms, signal) =>
            new Promise((resolve) => {
                const t = setTimeout(resolve, ms);
                signal?.addEventListener(
                    'abort',
                    () => {
                        clearTimeout(t);
                        resolve();
                    },
                    { once: true },
                );
            }),
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

function slotsUrl(fileId?: string): string {
    return `${base}/api/me/downloads/slots${fileId ? `?fileId=${encodeURIComponent(fileId)}` : ''}`;
}

function listUrl(mediaItemId: string, opts: EnqueueOptions & { summary?: boolean }): string {
    const q = new SvelteURLSearchParams();
    if (opts.summary) q.set('summary', '1');
    if (opts.season !== undefined) q.set('season', String(opts.season));
    if (opts.specials) q.set('specials', '1');
    const qs = q.toString();
    return `${base}/api/media/${encodeURIComponent(mediaItemId)}/download-list${qs ? `?${qs}` : ''}`;
}

/** Exponential backoff; the server's Retry-After is a floor. Max 60 s. */
export function retryDelayMs(res: Response, attempt: number): number {
    const backoff = BACKOFF_BASE_MS * 2 ** (attempt - 1);
    const raw = Number(res.headers.get('retry-after'));
    const floor = Number.isFinite(raw) && raw > 0 ? raw * 1000 : 0;
    return Math.min(Math.max(backoff, floor), MAX_RETRY_MS);
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
    /** Transient message that never changes the run's outcome (e.g. 'busy') */
    notice = $state<string | undefined>(undefined);
    mode = $state<'folder' | 'links' | null>(null);
    /** Set by enqueue(); the confirm sheet shows it */
    pending = $state<PendingDownload | null>(null);
    folderName = $state<string | null>(null);
    loading = $state(false);

    /** Why the folder picker is off despite being present: it threw something other than a cancel */
    pickerReason = $state<'blocked' | null>(null);

    private deps: QueueDeps;
    private dirHandle: FileSystemDirectoryHandle | null = null;
    private abort: AbortController | null = null;
    private stopRequested = false;
    private maxParallel = 0;
    private windowStart = 0;
    private windowBytes = 0;
    private infoCache = new SvelteMap<string, { at: number; value: Promise<DownloadInfo> }>();

    constructor(deps?: Partial<QueueDeps>) {
        this.deps = { ...defaultDeps(), ...deps };
    }

    get supportsFolderPicker(): boolean {
        return this.deps.pickDirectory !== null && this.pickerReason === null;
    }

    /** Brave blocks the File System Access API by default. */
    get isBrave(): boolean {
        return this.deps.env().brave;
    }

    /** Link-mode settings for this browser. */
    get profile(): LinkModeProfile {
        return linkModeProfile(this.deps.env());
    }

    /**
     * Whether download buttons should show for this item. Uses the server's
     * `summary=1` probe (no item queries), cached for a minute; any failure
     * (feature off, 404, 403) means "no". The full list is fetched on click.
     */
    downloadInfo(mediaItemId: string): Promise<DownloadInfo> {
        const hit = this.infoCache.get(mediaItemId);
        if (hit && Date.now() - hit.at < 60_000) return hit.value;
        const forget = () => {
            // A failure is not remembered: the next button gets a fresh probe.
            if (this.infoCache.get(mediaItemId)?.value === value) this.infoCache.delete(mediaItemId);
        };
        const value: Promise<DownloadInfo> = this.deps
            .fetch(listUrl(mediaItemId, { summary: true }))
            .then(async (res) => {
                if (!res.ok) {
                    forget();
                    return NO_DOWNLOAD;
                }
                const body = (await res.json()) as Partial<DownloadInfo>;
                return {
                    allowed: body.allowed === true,
                    maxParallel: Number(body.maxParallel ?? 0),
                };
            })
            .catch(() => {
                forget();
                return NO_DOWNLOAD;
            });
        this.infoCache.delete(mediaItemId);
        while (this.infoCache.size >= MAX_INFO_CACHE) {
            const oldest = this.infoCache.keys().next().value;
            if (oldest === undefined) break;
            this.infoCache.delete(oldest);
        }
        this.infoCache.set(mediaItemId, { at: Date.now(), value });
        return value;
    }

    /** Fetch the list for a title/season and open the confirm sheet. */
    async enqueue(mediaItemId: string, opts: EnqueueOptions = {}): Promise<void> {
        if (this.state === 'running') {
            // Never touch `error`/`state`: they describe the run in progress.
            this.notice = 'busy';
            return;
        }
        this.notice = undefined;
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
        if (!this.supportsFolderPicker || !this.deps.pickDirectory) return false;
        try {
            this.dirHandle = await this.deps.pickDirectory();
            this.folderName = this.dirHandle.name || null;
            return true;
        } catch (e) {
            // AbortError: the user closed the picker, nothing changes.
            if (e instanceof DOMException && e.name === 'AbortError') return false;
            if ((e as { name?: string } | null)?.name === 'AbortError') return false;
            // Anything else (SecurityError, NotAllowedError, TypeError...): the picker does
            // not work here, fall back to links for the rest of the session.
            this.pickerReason = 'blocked';
            this.forgetFolder();
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
        this.notice = undefined;
        this.mode = null;
    }

    /** Link mode: items not handed to the browser yet (after the first batch). */
    get linksRemaining(): number {
        return this.mode === 'links' ? this.items.filter((i) => i.status === 'queued').length : 0;
    }

    /** Link mode: how many links one batch hands over. */
    get linkBatch(): number {
        return this.profile.batchSize(this.maxParallel);
    }

    /** Items that ended in 'failed' (a finished run can still be 'done'). */
    get failedCount(): number {
        return this.items.filter((i) => i.status === 'failed').length;
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
        this.maxParallel = list.maxParallel;
        this.mode = this.dirHandle ? 'folder' : 'links';
        this.items = this.buildItems(list);
        this.bytesDone = 0;
        this.bytesTotal = this.items.reduce((s, i) => s + i.sizeBytes, 0);
        this.speed = 0;
        this.error = undefined;
        this.current = null;
        this.stopRequested = false;
        this.notice = undefined;
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

    /** Link mode: hand the next batch to the browser (a click, so popup rules stay happy). */
    async startNextLinks(): Promise<void> {
        if (this.state === 'running' || this.mode !== 'links' || this.linksRemaining === 0) return;
        this.stopRequested = false;
        this.notice = undefined;
        this.abort = new AbortController();
        this.state = 'running';
        this.addUnloadGuard();
        try {
            await this.runLinks();
        } finally {
            this.removeUnloadGuard();
            this.current = null;
            this.state = this.stopRequested ? 'stopped' : 'done';
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
        const cap = list.maxParallel > 0 ? list.maxParallel : UNLIMITED_PARALLEL_CEILING;
        const limit = Math.max(1, Math.min(cap, queue.length));
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
        // Give back what this attempt counted, so totals stay honest.
        const giveBack = () => {
            this.bytesDone -= view.bytesDone;
            view.bytesDone = 0;
        };
        const fail = (reason: FailureReason) => {
            giveBack();
            view.status = 'failed';
            view.reason = reason;
        };
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
            let limited = 0;
            let networkFails = 0;
            // A dropped connection restarts this file (no Range resume); false = give up.
            const retryNetwork = async (): Promise<boolean> => {
                networkFails += 1;
                if (networkFails > MAX_NETWORK_RETRIES) {
                    fail('network');
                    return false;
                }
                giveBack();
                view.status = 'waiting';
                await this.sleep(BACKOFF_BASE_MS * networkFails);
                if (this.stopRequested) {
                    view.status = 'cancelled';
                    return false;
                }
                view.status = 'active';
                return true;
            };
            while (true) {
                if (this.stopRequested) {
                    view.status = 'cancelled';
                    return;
                }
                let res: Response;
                try {
                    res = await this.deps.fetch(downloadUrl(item.mediaItemId, item.fileId), {
                        signal: this.abort?.signal,
                    });
                } catch {
                    if (this.stopRequested) {
                        view.status = 'cancelled';
                        return;
                    }
                    if (await retryNetwork()) continue;
                    return;
                }
                if (res.status === 429) {
                    await res.body?.cancel();
                    limited += 1;
                    if (limited >= MAX_429_ATTEMPTS) {
                        fail('limit');
                        return;
                    }
                    view.status = 'waiting';
                    await this.sleep(retryDelayMs(res, limited));
                    if (this.stopRequested) {
                        view.status = 'cancelled';
                        return;
                    }
                    view.status = 'active';
                    continue;
                }
                if (res.status === 403) {
                    await res.body?.cancel();
                    this.fail('downloads_not_allowed');
                    fail('forbidden');
                    return;
                }
                if (!res.ok || !res.body) {
                    await res.body?.cancel();
                    fail('http');
                    return;
                }
                let writable: FileSystemWritableFileStream;
                try {
                    const handle = await dir.getFileHandle(fileName, { create: true });
                    writable = await handle.createWritable();
                } catch (e) {
                    await res.body.cancel();
                    throw e;
                }
                const counter = new TransformStream<Uint8Array, Uint8Array>({
                    transform: (chunk, controller) => {
                        this.addBytes(view, chunk.byteLength);
                        controller.enqueue(chunk);
                    },
                });
                // The response's own length wins over the list's (the file may have changed
                // since the list was built); the list size is the fallback.
                const headerLength = Number(res.headers.get('content-length'));
                const expected =
                    Number.isFinite(headerLength) && headerLength > 0
                        ? headerLength
                        : item.sizeBytes;
                try {
                    await res.body
                        .pipeThrough(counter)
                        .pipeTo(writable as unknown as WritableStream);
                } catch (e) {
                    if (this.stopRequested) throw e;
                    // A TypeError is the body stream dropping; a DOMException is the file system.
                    if (e instanceof TypeError) {
                        if (await retryNetwork()) continue;
                        return;
                    }
                    throw e;
                }
                if (view.bytesDone !== expected) {
                    fail('size_mismatch');
                    return;
                }
                view.status = 'done';
                return;
            }
        } catch {
            // Aborted by cancel()/403, or a disk error for this item.
            if (this.stopRequested) {
                giveBack();
                view.status = 'cancelled';
            } else fail(item.sizeBytes >= FAT32_LIMIT_BYTES ? 'fat32' : 'write');
        } finally {
            if (this.current === view) this.current = null;
        }
    }

    /** Sleep that cancel() cuts short. */
    private async sleep(ms: number): Promise<void> {
        const signal = this.abort?.signal;
        if (!signal || signal.aborted) return;
        await Promise.race([
            this.deps.sleep(ms, signal),
            new Promise<void>((resolve) =>
                signal.addEventListener('abort', () => resolve(), { once: true }),
            ),
        ]);
    }

    /** The user's own slots, or null when they cannot be read (then nothing can be observed). */
    private async slotsInfo(
        fileId?: string,
    ): Promise<{ maxParallel: number; inUse: number; started: boolean } | null> {
        try {
            const res = await this.deps.fetch(slotsUrl(fileId), { signal: this.abort?.signal });
            if (!res.ok) return null;
            const b = (await res.json()) as {
                maxParallel?: number;
                inUse?: number;
                started?: boolean;
            };
            if (typeof b.maxParallel !== 'number' || typeof b.inUse !== 'number') return null;
            return { maxParallel: b.maxParallel, inUse: b.inUse, started: b.started === true };
        } catch {
            return null;
        }
    }

    /**
     * Link mode: wait (polling, abortable) until the user has a free download slot, so the
     * next hand-off is not refused with a 429 that nothing here could see. False = stopped.
     */
    private async waitForFreeSlot(item: QueueItem): Promise<boolean> {
        for (;;) {
            if (this.stopRequested) return false;
            const info = await this.slotsInfo();
            if (this.stopRequested) return false;
            if (!info || info.maxParallel === 0 || info.inUse < info.maxParallel) {
                if (item.status === 'waiting') item.status = 'queued';
                return true;
            }
            item.status = 'waiting';
            await this.sleep(SLOT_POLL_MS);
        }
    }

    /** Link mode: true once the server reports the file's download running or logged. */
    private async confirmStarted(item: QueueItem): Promise<boolean> {
        for (let waited = 0; waited < START_CONFIRM_MS; waited += START_CONFIRM_POLL_MS) {
            await this.sleep(START_CONFIRM_POLL_MS);
            if (this.stopRequested) return true;
            const info = await this.slotsInfo(item.fileId);
            // Cannot be observed (old server, endpoint failing): trust the hand-off.
            if (!info) return true;
            if (info.started) return true;
        }
        return false;
    }

    /** Hands over the next `linkBatch` queued items, one after another with a gap. */
    private async runLinks(): Promise<void> {
        const { gapMs } = this.profile;
        const batch = this.items.filter((i) => i.status === 'queued').slice(0, this.linkBatch);
        for (let i = 0; i < batch.length; i++) {
            if (this.stopRequested) return;
            const item = batch[i];
            this.current = item;
            let started = false;
            for (let attempt = 0; attempt <= MAX_HANDOFF_RETRIES; attempt++) {
                if (!(await this.waitForFreeSlot(item))) return;
                this.deps.triggerLink(downloadUrl(item.mediaItemId, item.fileId), item.fileName);
                started = await this.confirmStarted(item);
                if (started || this.stopRequested) break;
            }
            if (this.stopRequested) {
                if (item.status === 'waiting') item.status = 'queued';
                return;
            }
            if (started) {
                item.status = 'handed';
                this.bytesDone += item.sizeBytes;
            } else {
                item.status = 'failed';
                item.reason = 'not_started';
            }
            if (i < batch.length - 1) await this.sleep(gapMs);
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
