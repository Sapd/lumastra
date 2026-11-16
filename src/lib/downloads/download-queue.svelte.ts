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
 *  - zip: links mode for a season or series with ONE hand-off of
 *    /api/media/{id}/download-zip (the server builds an uncompressed ZIP that keeps
 *    the Show/Season folders). Offered by the confirm sheet when there is no folder
 *    picker. A HEAD probe first surfaces what a link cannot (409 files unavailable,
 *    403, 429); the hand-off is then confirmed through the slots endpoint like a link.
 */

import { base } from '$app/paths';
import { SvelteMap, SvelteSet, SvelteURLSearchParams } from 'svelte/reactivity';
import { sanitizePathSegment } from './path-sanitize';
import { toasts } from '$lib/stores/toast.store';
import * as m from '$lib/paraglide/messages';
import {
    initialSeriesScope,
    missingForScope,
    scopeItems,
    scopeQuery,
    type DownloadScope,
    type SeriesScope,
} from './download-scope';
import {
    detectBrowserEnv,
    linkBatchSize,
    linkModeProfile,
    UNLIMITED_PARALLEL_CEILING,
    type BrowserEnv,
    type LinkModeProfile,
} from './browser-profile';

export { linkBatchSize };
export type { DownloadScope, SeriesScope };

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
    /** Missing count per season ("0" = specials); absent on an older server. */
    missingBySeason?: Record<string, number>;
    items: DownloadListItem[];
}

export interface EnqueueOptions {
    season?: number;
    specials?: boolean;
    /** ZIP only: a subset of the series (max `MAX_ZIP_EPISODES`). The list call ignores it. */
    episodeIds?: string[];
}

/** The server takes at most this many ids in `?episodes=`. */
export const MAX_ZIP_EPISODES = 200;

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
    | 'not_started'
    /** ZIP: a file of the season is missing or unreadable on the server (409). */
    | 'files_unavailable'
    /** ZIP: too many files or too large for one archive (413). */
    | 'too_large';

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
    /** What will be downloaded: for a series sheet, the items of the chosen scope. */
    list: DownloadList;
    /** Series sheet only: the whole series list and the scope choice `list`/`opts` follow. */
    series?: SeriesScope;
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
/**
 * ZIP hand-off: the server lists and stats every file before it answers (up to ~60 s), so ONE
 * hand-off is observed this long. The GET is never re-issued while it may still be preparing.
 */
const ZIP_CONFIRM_MS = 180_000;
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

/** `handoff` is the link mode's per-hand-off nonce: the server echoes it back through the slots endpoint. */
export function downloadUrl(mediaItemId: string, fileId: string, handoff?: string): string {
    return `${base}/api/media/${encodeURIComponent(mediaItemId)}/download?fileId=${encodeURIComponent(fileId)}${handoff ? `&h=${encodeURIComponent(handoff)}` : ''}`;
}

/** The ZIP of a season or series (`opts` as for the list). */
export function archiveUrl(mediaItemId: string, opts: EnqueueOptions, handoff?: string): string {
    const q = new SvelteURLSearchParams();
    if (opts.season !== undefined) q.set('season', String(opts.season));
    if (opts.specials) q.set('specials', '1');
    if (opts.episodeIds?.length) q.set('episodes', opts.episodeIds.join(','));
    if (handoff) q.set('h', handoff);
    const qs = q.toString();
    return `${base}/api/media/${encodeURIComponent(mediaItemId)}/download-zip${qs ? `?${qs}` : ''}`;
}

function slotsUrl(handoff?: string): string {
    return `${base}/api/me/downloads/slots${handoff ? `?h=${encodeURIComponent(handoff)}` : ''}`;
}

/** A fresh random id for one hand-off (URL-safe, 22+ chars). */
function newHandoffNonce(): string {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
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
    mode = $state<'folder' | 'links' | 'zip' | null>(null);
    /** The sheet's choice (browsers without a folder picker): one ZIP instead of separate files */
    archive = $state(false);
    /** Set by enqueue(); the confirm sheet shows it */
    pending = $state<PendingDownload | null>(null);
    folderName = $state<string | null>(null);
    /**
     * The series and season the episode picker shows right now, for the modal's "Download
     * season N" menu item (the picker and the action row are different components).
     */
    pickerContext = $state<{ seriesId: string; season: number | undefined } | null>(null);
    loading = $state(false);
    /** Generation of the latest sheet request; see fetchForSheet. */
    private sheetGen = 0;

    /** Why the folder picker is off despite being present: it threw something other than a cancel */
    pickerReason = $state<'blocked' | null>(null);

    private deps: QueueDeps;
    private lastArchive: PendingDownload | null = null;
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
            if (this.infoCache.get(mediaItemId)?.value === value)
                this.infoCache.delete(mediaItemId);
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

    /**
     * The full list for a title/season/series without opening the sheet (size hints, menu
     * counts). Null on any failure or when downloads are not allowed.
     */
    async fetchList(mediaItemId: string, opts: EnqueueOptions = {}): Promise<DownloadList | null> {
        try {
            const res = await this.deps.fetch(listUrl(mediaItemId, opts));
            if (!res.ok) return null;
            const list = (await res.json()) as DownloadList;
            return list.allowed ? list : null;
        } catch {
            return null;
        }
    }

    /** A method, so TypeScript does not keep an earlier `state` check's narrowing across an await. */
    private isRunning(): boolean {
        return this.state === 'running';
    }

    /**
     * The list for the sheet, or null after a toast: busy, not allowed, empty, failed. Outcomes
     * without a run are toasts, never queue state.
     */
    private async fetchForSheet(
        mediaItemId: string,
        opts: EnqueueOptions,
    ): Promise<DownloadList | null> {
        const polite = { ariaLive: 'polite' } as const;
        const busy = () => {
            // Never touch `error`/`state`: they describe the run in progress.
            toasts.info(m.downloads_error_busy(), polite);
            return null;
        };
        if (this.state === 'running') return busy();
        // Each open takes a generation; a dismissal, a start or a newer open invalidates the
        // older ones, whose late answers are dropped without a toast.
        const gen = ++this.sheetGen;
        const stale = () => gen !== this.sheetGen;
        this.error = undefined;
        this.archive = false;
        this.loading = true;
        const failed = () => {
            toasts.error(m.downloads_error_list(), {
                diagnosticKey: 'downloads_error_list',
                ...polite,
            });
            return null;
        };
        try {
            const res = await this.deps.fetch(listUrl(mediaItemId, opts));
            if (stale()) return null;
            if (res.status === 403 || res.status === 404) {
                toasts.warning(m.downloads_error_not_allowed(), polite);
                return null;
            }
            if (!res.ok) return failed();
            const list = (await res.json()) as DownloadList;
            if (stale()) return null;
            if (!list.allowed) {
                toasts.warning(m.downloads_error_not_allowed(), polite);
                return null;
            }
            if (list.items.length === 0) {
                toasts.info(m.downloads_error_empty(), polite);
                return null;
            }
            // A run may have started while the list was loading: never open a sheet over it.
            if (this.isRunning()) return busy();
            return list;
        } catch {
            return stale() ? null : failed();
        } finally {
            if (!stale()) this.loading = false;
        }
    }

    /** Fetch the list of a movie or single episode and open the confirm sheet. */
    async enqueue(mediaItemId: string, opts: EnqueueOptions = {}): Promise<void> {
        const list = await this.fetchForSheet(mediaItemId, opts);
        if (list) this.pending = { mediaItemId, opts, list };
    }

    /**
     * Open the confirm sheet for a series with a scope preselected. ONE list of the whole series
     * (season 0 included) is fetched; every scope, count and size is derived from it, so
     * switching scope never calls the server. `season` is the season the user is looking at;
     * `episodeId` the episode the sheet was opened from.
     */
    async enqueueSeries(
        seriesId: string,
        want: { scope: DownloadScope; season?: number; episodeId?: string },
    ): Promise<void> {
        const all = await this.fetchForSheet(seriesId, { specials: true });
        if (!all) return;
        const series = initialSeriesScope(all, want);
        if (!series) {
            toasts.info(m.downloads_error_empty(), { ariaLive: 'polite' });
            return;
        }
        this.pending = this.seriesPending(seriesId, series);
    }

    /** The pending download a series scope stands for. */
    private seriesPending(seriesId: string, series: SeriesScope): PendingDownload {
        const chosen = scopeItems(series);
        const all = series.all;
        return {
            mediaItemId: seriesId,
            opts: scopeQuery(series),
            list: {
                ...all,
                missingCount: missingForScope(series),
                items: chosen,
            },
            series,
        };
    }

    private updateSeries(change: Partial<SeriesScope>): void {
        const p = this.pending;
        if (!p?.series) return;
        this.pending = this.seriesPending(p.mediaItemId, { ...p.series, ...change });
    }

    /**
     * Whether the sheet offers "One ZIP file": no folder picker, and a season or series with
     * at least two downloadable files (a movie or a single episode is one file already).
     */
    get zipOffered(): boolean {
        const p = this.pending;
        if (!p || this.supportsFolderPicker) return false;
        if ((p.opts.episodeIds?.length ?? 0) > MAX_ZIP_EPISODES) return false;
        const available = p.list.items.filter((i) => i.available);
        return available.length >= 2 && available.some((i) => i.seasonFolder !== null);
    }

    setArchive(on: boolean): void {
        this.archive = on;
    }

    /** Sheet checkbox (series scope): with or without season 0. */
    setSpecials(include: boolean): void {
        this.updateSeries({ specials: include });
    }

    /** Sheet radio. Choosing the checklist keeps what was checked before. */
    setScope(scope: DownloadScope): void {
        this.updateSeries({ scope });
    }

    /** Checklist: one episode on or off. */
    toggleEpisode(id: string): void {
        const p = this.pending?.series;
        if (!p) return;
        const on = p.custom.includes(id);
        this.updateSeries({ custom: on ? p.custom.filter((c) => c !== id) : [...p.custom, id] });
    }

    /** Checklist: every available episode of the season, or none. */
    setAllEpisodes(on: boolean, ids: string[]): void {
        this.updateSeries({ custom: on ? ids : [] });
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

    setPickerContext(seriesId: string, season: number | undefined): void {
        this.pickerContext = { seriesId, season };
    }

    /** Only the picker that set it may clear it (two pickers can be alive during a swap). */
    clearPickerContext(seriesId: string): void {
        if (this.pickerContext?.seriesId === seriesId) this.pickerContext = null;
    }

    dismissPending(): void {
        this.sheetGen++;
        this.loading = false;
        this.pending = null;
        this.archive = false;
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
        const zip = this.archive && this.zipOffered;
        this.sheetGen++;
        this.loading = false;
        this.pending = null;

        const { list } = pending;
        this.archive = false;
        this.maxParallel = list.maxParallel;
        this.mode = zip ? 'zip' : this.dirHandle ? 'folder' : 'links';
        this.items = zip ? this.buildArchiveItem(pending) : this.buildItems(list);
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
            else if (this.mode === 'zip') await this.runArchive(pending);
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

    /** One pseudo item standing for the whole archive. */
    private buildArchiveItem(p: PendingDownload): QueueItem[] {
        const files = p.list.items.filter((i) => i.available);
        const folders = new SvelteSet(files.map((i) => i.seasonFolder));
        const [only] = [...folders];
        // Same names as the server's Content-Disposition: a subset is "Selection".
        const suffix = p.opts.episodeIds
            ? ' - Selection'
            : folders.size === 1 && only
              ? ` - ${sanitizePathSegment(only)}`
              : '';
        const fileName = `${sanitizePathSegment(p.list.seriesFolder)}${suffix}.zip`;
        return [
            {
                mediaItemId: p.mediaItemId,
                fileId: 'archive',
                season: p.opts.season ?? null,
                episode: null,
                seasonFolder: null,
                fileName,
                sizeBytes: files.reduce((s, i) => s + i.sizeBytes, 0),
                available: true,
                path: [fileName],
                status: 'queued',
                bytesDone: 0,
            },
        ];
    }

    /**
     * HEAD probe of the archive URL: the server does its whole preparation (access, every file
     * checked) and answers with the status a plain link would hide. 'ok' carries the exact size.
     */
    private async probeArchive(
        url: string,
    ): Promise<{ ok: true; size: number | null } | { ok: false; reason: FailureReason }> {
        let res: Response;
        try {
            res = await this.deps.fetch(url, { method: 'HEAD', signal: this.abort?.signal });
        } catch {
            return { ok: false, reason: 'network' };
        }
        if (res.ok) {
            const len = Number(res.headers.get('content-length'));
            return { ok: true, size: Number.isFinite(len) && len > 0 ? len : null };
        }
        if (res.status === 409) return { ok: false, reason: 'files_unavailable' };
        if (res.status === 403) return { ok: false, reason: 'forbidden' };
        if (res.status === 429) return { ok: false, reason: 'limit' };
        if (res.status === 413) return { ok: false, reason: 'too_large' };
        return { ok: false, reason: 'http' };
    }

    /**
     * ZIP mode: probe, then ONE link hand-off confirmed through the slots endpoint. The same
     * nonce is observed for up to ZIP_CONFIRM_MS (preparation can take a minute); the GET is
     * not issued again, a second one would only start a second preparation. Not seen in time
     * is a failure the user can retry explicitly (`retryArchive`).
     */
    private async runArchive(p: PendingDownload): Promise<void> {
        this.lastArchive = p;
        const item = this.items[0];
        if (!item) return;
        this.current = item;
        if (!(await this.waitForFreeSlot(item))) return;
        const probe = await this.probeArchive(archiveUrl(p.mediaItemId, p.opts));
        if (this.stopRequested) {
            if (item.status === 'waiting') item.status = 'queued';
            return;
        }
        if (!probe.ok) {
            item.status = 'failed';
            item.reason = probe.reason;
            if (probe.reason === 'forbidden') this.error = 'downloads_not_allowed';
            return;
        }
        if (probe.size) {
            item.sizeBytes = probe.size;
            this.bytesTotal = probe.size;
        }
        const handoff = newHandoffNonce();
        this.deps.triggerLink(archiveUrl(p.mediaItemId, p.opts, handoff), item.fileName);
        const started = await this.confirmStarted(handoff, ZIP_CONFIRM_MS);
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
    }

    /** ZIP mode: the user's explicit "Retry" after a failed archive (a fresh probe and hand-off). */
    async retryArchive(): Promise<void> {
        const p = this.lastArchive;
        if (this.state === 'running' || this.mode !== 'zip' || !p) return;
        const item = this.items[0];
        if (!item || item.status !== 'failed') return;
        item.status = 'queued';
        item.reason = undefined;
        this.error = undefined;
        this.stopRequested = false;
        this.abort = new AbortController();
        this.state = 'running';
        this.addUnloadGuard();
        try {
            await this.runArchive(p);
        } finally {
            this.removeUnloadGuard();
            this.current = null;
            this.state = this.stopRequested || this.error ? 'stopped' : 'done';
        }
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
        handoff?: string,
    ): Promise<{ maxParallel: number; inUse: number; started: boolean } | null> {
        try {
            const res = await this.deps.fetch(slotsUrl(handoff), { signal: this.abort?.signal });
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
            if (this.stopRequested) {
                if (item.status === 'waiting') item.status = 'queued';
                return false;
            }
            const info = await this.slotsInfo();
            if (this.stopRequested) {
                if (item.status === 'waiting') item.status = 'queued';
                return false;
            }
            if (!info || info.maxParallel === 0 || info.inUse < info.maxParallel) {
                if (item.status === 'waiting') item.status = 'queued';
                return true;
            }
            item.status = 'waiting';
            await this.sleep(SLOT_POLL_MS);
        }
    }

    /**
     * Link mode: true once the server reports THIS hand-off (its nonce) as started. A failing
     * slots endpoint or network is not success: the observation is retried within the window.
     */
    private async confirmStarted(
        handoff: string,
        windowMs: number = START_CONFIRM_MS,
    ): Promise<boolean> {
        for (let waited = 0; waited < windowMs; waited += START_CONFIRM_POLL_MS) {
            await this.sleep(START_CONFIRM_POLL_MS);
            if (this.stopRequested) return true;
            const info = await this.slotsInfo(handoff);
            if (info?.started) return true;
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
                const handoff = newHandoffNonce();
                this.deps.triggerLink(
                    downloadUrl(item.mediaItemId, item.fileId, handoff),
                    item.fileName,
                );
                started = await this.confirmStarted(handoff);
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
