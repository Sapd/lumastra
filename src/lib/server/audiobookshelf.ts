// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import { readSetting, type SettingSource } from '$lib/server/utils/live-setting.js';
import {
    isRecord,
    parseBooleanOr,
    toNumber,
    toString,
    toStringArray,
} from '$lib/utils/data-extraction';
import { config } from './config.js';
import { Logger } from './utils/logger';
import { fetchWithTimeout as upstreamFetchWithTimeout } from './utils/fetch-timeout.js';
import { withProviderCallScope } from './utils/provider-calls.js';

import { encodePathSegment, isSafePathSegment } from '$lib/server/utils/upstream-path';
import { scrubConnectionText } from '$lib/server/utils/fetch-error-cause.js';
const fetchWithTimeout: typeof upstreamFetchWithTimeout = (...args) =>
    withProviderCallScope('audiobookshelf', () => upstreamFetchWithTimeout(...args));

const logger = Logger.for('Audiobookshelf');

export interface AudiobookMetadata {
    title: string;
    subtitle?: string;
    authorName?: string;
    description?: string;
    publishedYear?: string;
}

export interface AudiobookMedia {
    metadata: AudiobookMetadata;
    duration: number;
}

export interface AudiobookItem {
    id: string;
    media: AudiobookMedia;
    /** Library ID this item belongs to */
    libraryId?: string;
    /** Library name this item belongs to */
    libraryName?: string;
}

export interface AudiobookSession {
    id: string;
    /**
     * Owning ABS account. Present on the real payload (verified against
     * `/api/sessions/open` and `/api/sessions`) even though the display
     * surfaces only ever used `user.username`.
     *
     * Optional because existing callers construct this shape without it; the
     * freeze derivation keys on `user.username` for that reason, which is also
     * what the pull already matches Lumastra accounts by.
     */
    userId?: string;
    libraryItemId: string;
    displayTitle: string;
    displayAuthor: string;
    mediaMetadata: AudiobookMetadata;
    currentTime: number;
    duration: number;
    chapters: Array<{
        title: string;
        start: number;
        end: number;
    }>;
    updatedAt: number;
    user: {
        username: string;
    };
    mediaPlayer: string;
    deviceInfo: {
        browserName: string;
    };
}

/**
 * One row of a user's `mediaProgress` array.
 *
 * Field shapes verified against the live server — the units are NOT uniform and
 * getting them wrong is silent:
 *  - `currentTime` / `duration` are **seconds** (floats)
 *  - `lastUpdate` / `startedAt` / `finishedAt` are **epoch milliseconds**
 *
 * `currentTime` can also slightly EXCEED `duration` on a finished row (observed:
 * 104747.898 vs 104747.180), so any ratio derived from the pair must be clamped.
 */
export interface AudiobookMediaProgress {
    id: string;
    libraryItemId: string;
    /** `'book'` for audiobooks; `'podcastEpisode'` rows are out of scope. */
    mediaItemType?: string;
    episodeId: string | null;
    /** Seconds. */
    currentTime: number;
    /** Seconds. */
    duration: number;
    /** Fraction 0..1. */
    progress: number;
    isFinished: boolean;
    hideFromContinueListening?: boolean;
    /** Epoch ms. */
    lastUpdate: number;
    /** Epoch ms. */
    startedAt: number | null;
    /** Epoch ms; null while unfinished. */
    finishedAt: number | null;
}

/** `GET /api/me` — the authenticated user's own account, progress included. */
export interface AudiobookMe {
    id: string;
    username: string;
    type?: string;
    mediaProgress: AudiobookMediaProgress[];
}

/**
 * One entry of a play session's `audioTracks[]`, as the live server sends it.
 *
 * Deliberately loose: this is the raw wire shape, narrowed and projected by
 * `audiobook-session.service.ts`. `duration` and `codec` are genuinely `null`
 * on the live server — `duration` when the file could not be probed, `codec` on
 * the single synthetic track of a transcode session (measured 2026-07-29).
 */
export interface AudiobookPlaySessionTrack {
    index?: number | null;
    ino?: string | null;
    /** SECONDS, accumulated from the start of the book. */
    startOffset?: number | null;
    /** SECONDS. */
    duration?: number | null;
    mimeType?: string | null;
    codec?: string | null;
    title?: string | null;
    /** `/api/items/:id/file/:ino`, or `/hls/:sessionId/output.m3u8`. */
    contentUrl?: string | null;
}

/** One entry of a play session's `chapters[]`. SECONDS. */
export interface AudiobookPlaySessionChapter {
    id?: number | null;
    title?: string | null;
    start?: number | null;
    end?: number | null;
}

/**
 * `POST /api/items/:id/play` — an open AudiobookShelf playback session.
 *
 * Two measured facts about this endpoint that its shape does not advertise:
 *
 *  1. **`startTime` is derived from the caller's own saved progress, not from
 *     the request.** Sending `startTime` in the body is ignored — measured both
 *     ways on the live server (progress 0 → `startTime: 0` despite requesting
 *     3600; progress 7200 → `startTime: 7200` while requesting nothing).
 *  2. **A transcode session's playlist spans the WHOLE book**: one track with
 *     `startOffset: 0` and the book's full `duration`, 4355 segments summing to
 *     the full length, regardless of `startTime`. So the element's clock on the
 *     transcode path IS book time — there is no per-session offset to add.
 */
export interface AudiobookPlaySession {
    id: string;
    userId?: string;
    libraryItemId?: string;
    /** ABS `PlayMethod`: 0 DIRECT_PLAY, 1 DIRECT_STREAM, 2 TRANSCODE, 3 LOCAL. */
    playMethod?: number | null;
    displayTitle?: string | null;
    displayAuthor?: string | null;
    /** SECONDS. */
    duration?: number | null;
    /** SECONDS — where ABS says this listener left off. */
    startTime?: number | null;
    currentTime?: number | null;
    audioTracks?: AudiobookPlaySessionTrack[] | null;
    chapters?: AudiobookPlaySessionChapter[] | null;
    mediaMetadata?: {
        title?: string | null;
        authors?: Array<{ name?: string | null }> | null;
        narrators?: Array<string | null> | null;
    } | null;
}

/** Body of `POST /api/session/:id/sync` and `/close`. */
export interface AudiobookSessionSyncBody {
    /** SECONDS. */
    currentTime: number;
    /** SECONDS of audio actually heard since the previous sync. */
    timeListened: number;
    /** SECONDS. */
    duration: number;
}

/** One ABS account as returned by `GET /api/users`. */
export interface AudiobookUserSummary {
    id: string;
    username: string;
    type?: string;
}

/**
 * One row of `GET /api/api-keys` — metadata ONLY.
 *
 * Separate from {@link AudiobookApiKey} because the listing has no `apiKey`
 * field. Keeping them distinct means a caller cannot accidentally read key
 * material off a listed key and get `undefined`.
 */
export interface AudiobookApiKeyInfo {
    id: string;
    name?: string;
    userId?: string;
    isActive: boolean;
    createdAt?: string;
    lastUsedAt?: string | null;
}

/** `POST /api/api-keys` / `PATCH /api/api-keys/:id` result row. */
export interface AudiobookApiKey {
    id: string;
    /** The bearer token itself — only ever returned at creation time. */
    apiKey: string;
    isActive: boolean;
    name?: string;
    userId?: string;
}

/**
 * A per-user `GET /api/me` failed.
 *
 * Carries the terminal-vs-transient verdict, because the two must be handled
 * oppositely and the distinction is per-USER, not per-cycle:
 *
 *  - **401 / 403** — that user's key was revoked or deactivated. Terminal: it
 *    will never succeed again without a re-mint, so surface "not linked" for
 *    them and carry on with everybody else. Never fail the cycle.
 *  - **anything else** (5xx, 429, network) — transient. Retry next cycle.
 */
export class AudiobookshelfUserAuthError extends Error {
    readonly status: number;
    /** True when re-trying with the same credential cannot possibly help. */
    readonly terminal: boolean;
    /** True specifically for 401/403 — the credential itself was rejected. */
    readonly credentialRejected: boolean;

    constructor(status: number, operation = '/api/me') {
        super(`Audiobookshelf ${operation} failed: HTTP ${status}`);
        this.name = 'AudiobookshelfUserAuthError';
        this.status = status;
        this.credentialRejected = status === 401 || status === 403;
        // 404/410 are terminal too, and NOT because of the credential: the
        // library item is gone upstream (deleted, or a stale `external_ids`
        // row). Retrying such an item forever head-of-line-blocks every newer
        // item in the push queue, which is the exact failure the drain path
        // exists to prevent.
        this.terminal = this.credentialRejected || status === 404 || status === 410;
    }
}

export interface AudiobookLibraryResponse {
    results: AudiobookItem[];
}

export interface AudiobookSessionResponse {
    sessions: AudiobookSession[];
}

export interface AudiobookLibrary {
    id: string;
    name: string;
    mediaType: string;
}

export interface AudiobookLibrariesResponse {
    libraries: AudiobookLibrary[];
}

export interface AudiobookSearchResponse {
    results: AudiobookItem[];
}

// ---------------------------------------------------------------------------
// Ingest sweep types
//
// The reconcile sweep pages every ABS library, diffs `{id → (updatedAt,
// mtimeMs, isMissing)}` against Lumastra, and dismisses rows that are absent
// upstream. That makes "the request failed" and "the library is empty"
// catastrophically different answers, so — unlike the display-oriented methods
// above, which log and return `[]` — every sweep method returns a discriminated
// result and never fabricates an empty page. A swallowed error here would
// dismiss an entire catalog.
// ---------------------------------------------------------------------------

/**
 * Why a sweep request could not produce a trustworthy answer.
 *
 * - `not-configured` — no base URL/API key, or the client has already latched a
 *   connection failure. Distinct from `network` because it is not transient.
 * - `network` — `fetch` itself rejected (DNS, refused, TLS, abort).
 * - `http` — the server answered with a non-2xx status.
 * - `malformed` — the body was not JSON, or was JSON that does not carry the
 *   fields the diff depends on. Treated as a hard failure rather than
 *   best-effort parsed, because a silently dropped item reads as
 *   "absent upstream" to the differ.
 * - `incomplete` — pagination could not be walked to the end (page cap hit,
 *   server ignored `page`, or fewer items came back than `total` promised).
 */
export type AudiobookshelfErrorKind =
    'not-configured' | 'network' | 'http' | 'malformed' | 'incomplete';

/** Identifies which request failed, for logging and error reporting. */
export interface AudiobookshelfRequestContext {
    libraryId?: string;
    itemId?: string;
    /** Zero-indexed page number, when the failure happened mid-pagination. */
    page?: number;
}

export interface AudiobookshelfRequestError extends AudiobookshelfRequestContext {
    kind: AudiobookshelfErrorKind;
    message: string;
    /** HTTP status code — only set when `kind === 'http'`. */
    status?: number;
    /** Node error cause code (e.g. `ENOTFOUND`) — only set when `kind === 'network'`. */
    code?: string;
    name?: string;
}

export type AudiobookshelfResult<T> =
    { ok: true; value: T } | { ok: false; error: AudiobookshelfRequestError };

/**
 * One row of `GET /api/libraries/:id/items?minified=1`, normalized so the
 * differ never has to optional-chain. Every field is present; anything ABS
 * omitted is `null` (or `0`/`false` where the diff needs a total order).
 */
export interface AudiobookItemMinified {
    /** ABS `libraryItemId` — the `external_ids.external_id` for this book. */
    id: string;
    libraryId: string;
    /** Hoisted from `media.metadata.title`; `''` when ABS has no title at all. */
    title: string;
    subtitle: string | null;
    authorName: string | null;
    narratorName: string | null;
    seriesName: string | null;
    publishedYear: string | null;
    coverPath: string | null;
    relPath: string | null;
    /** ABS media type discriminator (`'book'` | `'podcast'`). */
    mediaType: string | null;
    duration: number | null;
    numChapters: number | null;
    numAudioFiles: number | null;
    numFiles: number | null;
    size: number | null;
    /**
     * Filesystem mtime of the item in ms. This is the *file* mtime, so a
     * replaced audio file moves it even when `updatedAt` does not.
     */
    mtimeMs: number;
    addedAt: number;
    /**
     * ABS bumps the item row's `updatedAt` on nested media edits, so this
     * catches metadata *and* chapter changes.
     */
    updatedAt: number;
    /** Files vanished from disk. Maps to `has_files = false`, never a delete. */
    isMissing: boolean;
    isInvalid: boolean;
}

/** A single page of minified items, exactly as requested. */
export interface AudiobookItemPage {
    libraryId: string;
    items: AudiobookItemMinified[];
    /** Total items in the library as reported by ABS for this query. */
    total: number;
    /** Zero-indexed page that was requested (ABS convention). */
    page: number;
    /** Page size that was requested. */
    limit: number;
}

/** Every item in one ABS library, verified complete. */
export interface AudiobookLibrarySnapshot {
    libraryId: string;
    /** De-duplicated by `id`, in upstream page order. */
    items: AudiobookItemMinified[];
    /** `total` as reported by the last page fetched. */
    total: number;
    pagesFetched: number;
}

export interface ListLibraryItemsOptions {
    /** Page size. Defaults to 500 (the sweep page size). Clamped to 1..1000. */
    limit?: number;
    /** Zero-indexed page number (ABS convention). Defaults to 0. */
    page?: number;
}

export interface ListAllLibraryItemsOptions {
    /** Page size per request. Defaults to 500. Clamped to 1..1000. */
    limit?: number;
    /**
     * Hard cap on requests, so a server that ignores `page` cannot spin
     * forever. Hitting it yields an `incomplete` error, never a short list.
     */
    maxPages?: number;
}

export interface AudiobookAuthorRef {
    id: string | null;
    name: string;
}

export interface AudiobookSeriesRef {
    id: string | null;
    name: string;
    /** Position within the series, as a string ("1", "2.5") — ABS allows decimals. */
    sequence: string | null;
}

/** One entry of `media.chapters`, used as the modal's table of contents. */
export interface AudiobookChapter {
    /** ABS chapter index. Falls back to the array position when ABS omits it. */
    id: number;
    /** Offset in seconds from the start of the book. */
    start: number;
    /** Offset in seconds from the start of the book. */
    end: number;
    title: string;
}

/** `media.metadata` of an expanded item. */
export interface AudiobookMetadataExpanded {
    title: string;
    titleIgnorePrefix: string | null;
    subtitle: string | null;
    authors: AudiobookAuthorRef[];
    narrators: string[];
    series: AudiobookSeriesRef[];
    genres: string[];
    publishedYear: string | null;
    publishedDate: string | null;
    publisher: string | null;
    description: string | null;
    isbn: string | null;
    asin: string | null;
    language: string | null;
    explicit: boolean;
    abridged: boolean;
    /** ABS's pre-joined display strings — cheaper than re-joining `authors`. */
    authorName: string | null;
    narratorName: string | null;
    seriesName: string | null;
}

/** `media` of an expanded item. */
/**
 * One audio file of a book. Books are overwhelmingly multi-file in practice
 * (87% of a measured 1188-item library), so this is the normal case, not an
 * edge case: it is both the runtime source and the player's file list.
 */
export interface AudiobookAudioFile {
    index: number;
    /** AudiobookShelf addresses files by inode: `/api/items/:id/file/:ino`. */
    ino: string | null;
    /** Seconds. Null when AudiobookShelf could not probe the file. */
    duration: number | null;
    mimeType: string | null;
    codec: string | null;
}

export interface AudiobookMediaExpanded {
    id: string | null;
    libraryItemId: string | null;
    metadata: AudiobookMetadataExpanded;
    coverPath: string | null;
    tags: string[];
    chapters: AudiobookChapter[];
    /** Per-file durations and inodes; see {@link AudiobookAudioFile}. */
    audioFiles: AudiobookAudioFile[];
    /**
     * Total seconds. The expanded payload carries NO `media.duration`, so this
     * is summed from {@link AudiobookMediaExpanded.audioFiles} when absent.
     */
    duration: number | null;
    size: number | null;
    numTracks: number | null;
    numAudioFiles: number | null;
}

/** `GET /api/items/:id?expanded=1` — everything an insert/update needs. */
export interface AudiobookItemExpanded {
    id: string;
    libraryId: string | null;
    folderId: string | null;
    path: string | null;
    relPath: string | null;
    mediaType: string | null;
    /** Carried through so callers can confirm they fetched the revision they diffed. */
    mtimeMs: number;
    addedAt: number;
    updatedAt: number;
    isMissing: boolean;
    isInvalid: boolean;
    numFiles: number | null;
    size: number | null;
    media: AudiobookMediaExpanded;
}

/** Sweep page size from the design doc (§7 "page each ABS library with limit=500"). */
const DEFAULT_SWEEP_PAGE_SIZE = 500;
const MAX_SWEEP_PAGE_SIZE = 1000;
/** 1000 pages × 500 items = 500k books; a real library never reaches this. */
const DEFAULT_MAX_SWEEP_PAGES = 1000;

function clampPageSize(limit: number | undefined): number {
    if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_SWEEP_PAGE_SIZE;
    return Math.min(MAX_SWEEP_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

function clampPageNumber(page: number | undefined): number {
    if (typeof page !== 'number' || !Number.isFinite(page)) return 0;
    return Math.max(0, Math.floor(page));
}

function clampMaxPages(maxPages: number | undefined): number {
    if (typeof maxPages !== 'number' || !Number.isFinite(maxPages)) return DEFAULT_MAX_SWEEP_PAGES;
    return Math.max(1, Math.floor(maxPages));
}

/** `isRecord` also accepts arrays; the wire shapes here are all plain objects. */
function asObject(value: unknown): Record<string, unknown> | null {
    return isRecord(value) && !Array.isArray(value) ? value : null;
}

function failure<T>(
    kind: AudiobookshelfErrorKind,
    message: string,
    context: AudiobookshelfRequestContext = {},
): AudiobookshelfResult<T> {
    return { ok: false, error: { kind, message, ...context } };
}

/**
 * Parse an ABS boolean flag.
 *
 * `parseBooleanOr` (not `toBooleanOr`) because ABS has shipped these as `0`/`1`
 * in places. The fallback is deliberately `false`: an unreadable `isMissing`
 * must mean "present", the direction that leaves a book playable, never the one
 * that hides it.
 */
function absFlag(value: unknown): boolean {
    return parseBooleanOr(value, false);
}

function normalizeMinifiedItem(
    raw: unknown,
    fallbackLibraryId: string,
): AudiobookItemMinified | null {
    const item = asObject(raw);
    if (!item) return null;

    const id = toString(item.id);
    // No id means no diff key. Dropping it would read as "absent upstream" and
    // dismiss whatever local row it belongs to, so the caller must abort instead.
    if (!id) return null;

    const media = asObject(item.media) ?? {};
    const metadata = asObject(media.metadata) ?? {};

    return {
        id,
        libraryId: toString(item.libraryId) ?? fallbackLibraryId,
        title: toString(metadata.title) ?? '',
        subtitle: toString(metadata.subtitle) ?? null,
        authorName: toString(metadata.authorName) ?? null,
        narratorName: toString(metadata.narratorName) ?? null,
        seriesName: toString(metadata.seriesName) ?? null,
        publishedYear: toString(metadata.publishedYear) ?? null,
        coverPath: toString(media.coverPath) ?? null,
        relPath: toString(item.relPath) ?? null,
        mediaType: toString(item.mediaType) ?? null,
        duration: toNumber(media.duration) ?? null,
        numChapters: toNumber(media.numChapters) ?? null,
        numAudioFiles: toNumber(media.numAudioFiles) ?? null,
        numFiles: toNumber(item.numFiles) ?? null,
        size: toNumber(item.size) ?? null,
        mtimeMs: toNumber(item.mtimeMs) ?? 0,
        addedAt: toNumber(item.addedAt) ?? 0,
        updatedAt: toNumber(item.updatedAt) ?? 0,
        isMissing: absFlag(item.isMissing),
        isInvalid: absFlag(item.isInvalid),
    };
}

function normalizeChapter(raw: unknown, index: number): AudiobookChapter | null {
    const chapter = asObject(raw);
    if (!chapter) return null;

    const start = toNumber(chapter.start);
    if (start === undefined) return null;

    return {
        id: toNumber(chapter.id) ?? index,
        start,
        end: toNumber(chapter.end) ?? start,
        title: toString(chapter.title) ?? '',
    };
}

function normalizeAuthors(raw: unknown): AudiobookAuthorRef[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
        const author = asObject(entry);
        const name = author ? toString(author.name) : undefined;
        if (!author || name === undefined) return [];
        return [{ id: toString(author.id) ?? null, name }];
    });
}

function normalizeSeries(raw: unknown): AudiobookSeriesRef[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
        const series = asObject(entry);
        const name = series ? toString(series.name) : undefined;
        if (!series || name === undefined) return [];
        return [
            {
                id: toString(series.id) ?? null,
                name,
                sequence: toString(series.sequence) ?? null,
            },
        ];
    });
}

function normalizeExpandedMetadata(raw: Record<string, unknown>): AudiobookMetadataExpanded {
    return {
        title: toString(raw.title) ?? '',
        titleIgnorePrefix: toString(raw.titleIgnorePrefix) ?? null,
        subtitle: toString(raw.subtitle) ?? null,
        authors: normalizeAuthors(raw.authors),
        narrators: toStringArray(raw.narrators),
        series: normalizeSeries(raw.series),
        genres: toStringArray(raw.genres),
        publishedYear: toString(raw.publishedYear) ?? null,
        publishedDate: toString(raw.publishedDate) ?? null,
        publisher: toString(raw.publisher) ?? null,
        description: toString(raw.description) ?? null,
        isbn: toString(raw.isbn) ?? null,
        asin: toString(raw.asin) ?? null,
        language: toString(raw.language) ?? null,
        explicit: absFlag(raw.explicit),
        abridged: absFlag(raw.abridged),
        authorName: toString(raw.authorName) ?? null,
        narratorName: toString(raw.narratorName) ?? null,
        seriesName: toString(raw.seriesName) ?? null,
    };
}

/**
 * How long a persistent connection failure stays quiet between warnings.
 *
 * Long enough that a broken integration is a handful of lines an hour rather
 * than ~48, short enough that the log still says it is broken NOW — silence
 * that never comes back is how an outage gets mistaken for a fixed one.
 */
const CONNECTION_WARN_COOLDOWN_MS = 15 * 60 * 1000;

export class AudiobookshelfClient {
    private readonly baseUrlSource: SettingSource;
    private readonly apiKeySource: SettingSource;
    /** The connection (url|key) the latch and library cache below belong to. */
    private stateFor = '';
    private lastOpenSessions: { at: number; sessions: AudiobookSession[] } | null = null;
    private failed = false;
    /**
     * When the last non-fatal connection failure was logged.
     *
     * `connectionFailed` only latches on ENOTFOUND, and deliberately so: an
     * unresolvable hostname is a configuration error, while a refused or timed
     * out connect is usually transient, and latching THAT would take the whole
     * integration down until the next process restart (`isConfigured()` reads
     * the latch).
     *
     * But nothing throttled the other branch, so every failure that was not
     * ENOTFOUND re-logged on EVERY poll. Measured on prod: a connect timeout to
     * a misconfigured `AUDIOURL` produced one WARN every 75-90s, indefinitely,
     * from a comment that claims failures are "only logged once".
     */
    private lastConnectionWarnAt = 0;
    private libraryIds: string[] = [];
    private libraryNames: Map<string, string> = new Map();
    private initialized = false;
    private initPromise: Promise<void> | null = null;

    /**
     * URL/key are read on every use (the exported singleton passes functions
     * over the live config). When they change, the "unreachable" latch and the
     * cached library list — both facts about the OLD server — are dropped, so
     * a saved connection applies without a restart.
     */
    constructor(baseUrl: SettingSource, apiKey: SettingSource) {
        this.baseUrlSource = baseUrl;
        this.apiKeySource = apiKey;
        if (!this.configured) {
            logger.warn('Audiobookshelf not configured');
        }
        // Don't initialize at module load time - defer to first use
    }

    private get baseUrl(): string {
        this.syncConnectionState();
        return readSetting(this.baseUrlSource);
    }

    private get apiKey(): string {
        return readSetting(this.apiKeySource);
    }

    private get configured(): boolean {
        return !!(readSetting(this.baseUrlSource) && this.apiKey);
    }

    private get connectionFailed(): boolean {
        this.syncConnectionState();
        return this.failed;
    }

    private set connectionFailed(value: boolean) {
        this.syncConnectionState();
        this.failed = value;
    }

    private syncConnectionState(): void {
        const key = `${readSetting(this.baseUrlSource)}|${readSetting(this.apiKeySource)}`;
        if (key === this.stateFor) return;
        this.stateFor = key;
        this.lastOpenSessions = null;
        this.failed = false;
        this.lastConnectionWarnAt = 0;
        this.libraryIds = [];
        this.libraryNames = new Map();
        this.initialized = false;
        this.initPromise = null;
    }

    /**
     * Ensure libraries are initialized (lazy initialization)
     * Safe to call multiple times - only runs once
     */
    private async ensureInitialized(): Promise<void> {
        this.syncConnectionState();
        if (this.initialized || !this.configured) return;
        if (!this.initPromise) {
            // A discovery started for the old connection must not mark the
            // new one initialised (or write its library list) if a save lands
            // while it is in flight.
            const startedFor = this.stateFor;
            this.initPromise = this.initializeLibraries(startedFor).then(() => {
                if (this.stateFor === startedFor) this.initialized = true;
            });
        }
        return this.initPromise;
    }

    private isConfigured(): boolean {
        return this.configured && !this.connectionFailed;
    }

    /**
     * Whether this transient failure is worth another log line.
     *
     * First failure logs immediately; repeats stay quiet for the cooldown, so a
     * persistent outage leaves a periodic heartbeat instead of a wall. A success
     * calls {@link noteConnectionRecovered}, so a NEW outage always logs at once
     * rather than inheriting the previous one's silence.
     */
    private shouldWarnAboutConnection(): boolean {
        const now = Date.now();
        if (now - this.lastConnectionWarnAt < CONNECTION_WARN_COOLDOWN_MS) return false;
        this.lastConnectionWarnAt = now;
        return true;
    }

    private noteConnectionRecovered(): void {
        this.lastConnectionWarnAt = 0;
    }

    /**
     * The bit that actually identifies the failure.
     *
     * `fetch` collapses every network fault into the message "fetch failed" —
     * DNS, refused, timed out and TLS all read identically — and only
     * `cause.code` tells them apart. Logging the message alone is what made a
     * prod connect-timeout undiagnosable from the logs.
     */
    private describeFetchFailure(err: Error): Record<string, unknown> {
        // The base URL can carry user:password or a key in its query, and the
        // exception text can quote the request URL: scrub both before logging.
        const secrets = [this.apiKey];
        const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
        return {
            url: scrubConnectionText(this.baseUrl, secrets),
            message: scrubConnectionText(err.message, secrets),
            ...(cause?.code !== undefined ? { code: String(cause.code) } : {}),
            ...(cause?.message !== undefined && cause.message !== err.message
                ? { cause: scrubConnectionText(String(cause.message), secrets) }
                : {}),
        };
    }

    private createHeaders() {
        return {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
        };
    }

    private async initializeLibraries(startedFor: string): Promise<void> {
        try {
            const libraries = await this.getLibraries();
            if (this.stateFor !== startedFor) return;
            this.libraryIds = libraries.map((lib) => lib.id);
            this.libraryNames = new Map(libraries.map((lib) => [lib.id, lib.name]));
            if (libraries.length > 0) {
                logger.info('Libraries discovered', {
                    count: this.libraryIds.length,
                    libraries: libraries.map((lib) => ({
                        id: lib.id,
                        name: lib.name,
                    })),
                });
            }
        } catch (e) {
            logger.warn('Failed to initialize Audiobookshelf libraries', {
                error: e,
            });
        }
    }

    /**
     * `GET /api/libraries`, reporting every failure mode instead of collapsing
     * it into an empty list.
     *
     * {@link AudiobookshelfClient.getLibraries} cannot serve an operator-facing
     * library picker: it answers `[]` for "not configured", "server unreachable",
     * "401", "malformed body" AND "this server genuinely has no libraries", so
     * the UI would render "no libraries found" for a down server and the operator
     * would go looking in the wrong place. Callers that need to TELL THE OPERATOR
     * what went wrong must use this method.
     *
     * Note for callers that surface `error.kind`: `fetchJson` latches
     * `connectionFailed` on `ENOTFOUND`, after which `isConfigured()` is false
     * and this returns `not-configured` for what is really an unreachable server.
     * Build a fresh client per request (as the media source does) if the
     * distinction has to survive a first failure.
     */
    async listLibraries(): Promise<AudiobookshelfResult<AudiobookLibrary[]>> {
        const result = await this.fetchJson(`/api/libraries`, {});
        if (!result.ok) return result;

        // `libraries` absent is malformed, not empty: a body that never carried
        // the key is a different server than one reporting zero libraries, and
        // conflating them is what makes the `[]` return above unusable.
        if (!isRecord(result.value) || !Array.isArray(result.value.libraries)) {
            return failure('malformed', 'Response had no `libraries` array', {});
        }

        return { ok: true, value: result.value.libraries as AudiobookLibrary[] };
    }

    async getLibraries(): Promise<AudiobookLibrary[]> {
        // Deliberately swallows to `[]`: the display surfaces and
        // `initializeLibraries` treat an unreachable server as "no libraries"
        // and must not throw. `listLibraries()` is the reporting variant.
        const result = await this.listLibraries();
        return result.ok ? result.value : [];
    }

    private recentOpenSessions(): AudiobookSession[] {
        // A bounded display fallback, never used for authorization or stream policy.
        return this.lastOpenSessions && Date.now() - this.lastOpenSessions.at < 60_000
            ? this.lastOpenSessions.sessions
            : [];
    }

    async getSessions(
        options: { allowStaleForDisplay?: boolean } = {},
    ): Promise<AudiobookSession[]> {
        if (!this.isConfigured()) {
            return options.allowStaleForDisplay ? this.recentOpenSessions() : [];
        }
        try {
            const requestedFor = this.stateFor;
            const response = await fetchWithTimeout(
                joinUpstreamUrl(this.baseUrl, `/api/sessions/open`),
                {
                    headers: this.createHeaders(),
                },
            );

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = (await response.json()) as AudiobookSessionResponse;
            this.noteConnectionRecovered();
            const sessions = data.sessions || [];
            if (this.stateFor === requestedFor)
                this.lastOpenSessions = { at: Date.now(), sessions };
            return sessions;
        } catch (error) {
            // Only log once - connection failures are expected when Audiobookshelf is unreachable
            const err = error as Error;
            const causeCode = (err as { cause?: { code?: unknown } }).cause?.code;
            if (causeCode === 'ENOTFOUND') {
                if (!this.connectionFailed) {
                    this.connectionFailed = true;
                    logger.warn('Server not reachable', { url: this.baseUrl });
                }
            } else if (!this.connectionFailed && this.shouldWarnAboutConnection()) {
                logger.warn('Failed to get sessions', this.describeFetchFailure(err));
            }
            return options.allowStaleForDisplay ? this.recentOpenSessions() : [];
        }
    }

    // -----------------------------------------------------------------------
    // Watch-sync surface: per-user credentials + per-user progress
    // -----------------------------------------------------------------------

    /**
     * `GET /api/users` (admin-scoped) — every ABS account.
     *
     * ⚠️ **This list serialization returns `mediaProgress: []` for every user**,
     * even for accounts with dozens of progress rows. Verified on the live
     * server: all 26 accounts reported 0 here while `GET /api/users/:id`
     * returned 51 / 16 / 20 for the same users. Use it ONLY to map usernames to
     * ids — never as a progress source, or the connector silently syncs nothing.
     */
    async listUsers(signal?: AbortSignal): Promise<AudiobookUserSummary[]> {
        const result = await this.fetchJson(`/api/users`, {}, signal);
        if (!result.ok) {
            // Deliberately THROWS rather than returning [] like the display
            // methods do. An empty list is indistinguishable from "this user
            // has no ABS account", so swallowing an outage or an expired
            // operator key would silently report every unlinked user as
            // accountless and link nobody, with nothing in the pull result to
            // show for it.
            throw new Error(`Audiobookshelf listUsers failed: ${result.error.message}`);
        }
        const data = result.value as { users?: AudiobookUserSummary[] };
        return data.users ?? [];
    }

    /**
     * `POST /api/users` (admin-scoped) — provision an ABS account.
     *
     * Called only when a listener has no ABS counterpart and the operator has
     * left auto-provisioning on. The password is random and never surfaced:
     * these accounts are reached through Lumastra, which authenticates the user
     * itself and then acts with the per-user API key minted against this
     * account. ABS rejects an empty password, so one has to be supplied.
     *
     * `isActive` is explicit for the same reason it is on `createApiKey` — ABS
     * reads `!!req.body.isActive`, and an omitted flag yields an account that
     * cannot be used.
     */
    async createUser(input: { username: string; password: string }): Promise<AudiobookUserSummary> {
        // Raw `fetch`, like createApiKey above — NOT this class's `fetchJson`.
        // That helper's second parameter is a logging CONTEXT, not a RequestInit,
        // and it hard-codes `{ headers, signal }`, so a body and method handed to
        // it are silently dropped. Routed through it, this call went out as a GET
        // and came back with the user LIST, which has no `.user` — reported as
        // "createUser returned no user" from a request that never happened.
        const response = await fetchWithTimeout(joinUpstreamUrl(this.baseUrl, `/api/users`), {
            method: 'POST',
            headers: this.createHeaders(),
            body: JSON.stringify({
                username: input.username,
                password: input.password,
                type: 'user',
                isActive: true,
                // Verified against the live server: it stores these back as
                // `accessAllLibraries: true` with `librariesAccessible: []`,
                // which is how ABS spells "every library, including ones added
                // later".
                permissions: {
                    download: true,
                    update: true,
                    delete: false,
                    upload: false,
                    accessAllLibraries: true,
                    accessAllTags: true,
                    accessExplicitContent: true,
                },
            }),
        });
        if (!response.ok) {
            throw new Error(
                `Audiobookshelf createUser failed: HTTP ${response.status} for ${input.username}`,
            );
        }
        const data = (await response.json()) as { user?: AudiobookUserSummary };
        if (!data.user?.id) {
            throw new Error('Audiobookshelf createUser returned no user');
        }
        return data.user;
    }

    /**
     * `GET /api/users/:id` with the operator credential.
     *
     * Unlike the list serialization, this endpoint includes `mediaProgress`.
     * It lets watch-sync import an ABS-only listener without minting a per-user
     * key; playback still uses the listener's own key for upstream permissions.
     */
    async getUserAsAdmin(userId: string, signal?: AbortSignal): Promise<AudiobookMe> {
        const result = await this.fetchJson(`/api/users/${encodePathSegment(userId)}`, {}, signal);
        if (!result.ok) {
            throw new Error(`Audiobookshelf getUserAsAdmin failed: ${result.error.message}`);
        }
        return result.value as AudiobookMe;
    }

    /**
     * `POST /api/api-keys` (admin-scoped) — mint a per-user key.
     *
     * `isActive` is required by this signature on purpose: ABS reads
     * `!!req.body.isActive`, so omitting it returns 200 with a key whose
     * `isActive` is false, and that key 401s on every request. Verified on the
     * live server in both directions.
     */
    async createApiKey(input: {
        name: string;
        userId: string;
        isActive: true;
    }): Promise<AudiobookApiKey> {
        const response = await fetchWithTimeout(joinUpstreamUrl(this.baseUrl, `/api/api-keys`), {
            method: 'POST',
            headers: this.createHeaders(),
            body: JSON.stringify(input),
        });
        if (!response.ok) {
            throw new Error(`Audiobookshelf createApiKey failed: HTTP ${response.status}`);
        }
        const data = (await response.json()) as { apiKey?: AudiobookApiKey };
        const key = data.apiKey;
        if (!key?.apiKey) {
            throw new Error('Audiobookshelf createApiKey returned no key material');
        }
        return key;
    }

    /**
     * `GET /api/api-keys` (admin-scoped) — every key's METADATA.
     *
     * Deliberately returns {@link AudiobookApiKeyInfo}, which has no `apiKey`
     * field, because the listing never carries key material: verified on the live
     * server, a listed key exposes only
     * `id/name/userId/isActive/createdAt/updatedAt/lastUsedAt/expiresAt/
     * permissions/description/createdByUser(Id)/user`. That is why a previously
     * minted key can never be RE-USED — the secret is unrecoverable after
     * creation — and why the only available hygiene is to deactivate the old one
     * and mint a replacement.
     *
     * Note `lastUsedAt` exists here but was NULL on the live server for a key
     * that had demonstrably just been used, so do not build operator-facing
     * "last used" reporting on it without first establishing when ABS populates it.
     */
    async listApiKeys(): Promise<AudiobookApiKeyInfo[]> {
        const response = await fetchWithTimeout(joinUpstreamUrl(this.baseUrl, `/api/api-keys`), {
            headers: this.createHeaders(),
        });
        if (!response.ok) {
            throw new Error(`Audiobookshelf listApiKeys failed: HTTP ${response.status}`);
        }
        const data = (await response.json()) as { apiKeys?: AudiobookApiKeyInfo[] };
        return Array.isArray(data.apiKeys) ? data.apiKeys : [];
    }

    /** `PATCH /api/api-keys/:id { isActive: false }` — revoke without deleting. */
    async deactivateApiKey(apiKeyId: string): Promise<void> {
        const response = await fetchWithTimeout(
            joinUpstreamUrl(this.baseUrl, `/api/api-keys/${encodePathSegment(apiKeyId)}`),
            {
                method: 'PATCH',
                headers: this.createHeaders(),
                body: JSON.stringify({ isActive: false }),
            },
        );
        if (!response.ok) {
            throw new Error(`Audiobookshelf deactivateApiKey failed: HTTP ${response.status}`);
        }
    }

    /**
     * `GET /api/me` **as the given user**, using that user's own API key.
     *
     * This is the linked-user connector progress source. Deliberately not
     * `/api/me/items-in-progress`: that endpoint filters `!isFinished`, carries
     * neither `currentTime` nor `isFinished`, and defaults to `limit = 25`, so
     * finished books would be invisible, a 99%-listened book would squat in
     * Weiterhören forever, and completions would be uncountable.
     */
    async getMeAs(userApiKey: string, signal?: AbortSignal): Promise<AudiobookMe | null> {
        const response = await fetchWithTimeout(joinUpstreamUrl(this.baseUrl, `/api/me`), {
            headers: {
                Authorization: `Bearer ${userApiKey}`,
                'Content-Type': 'application/json',
            },
            signal,
        });
        if (!response.ok) {
            throw new AudiobookshelfUserAuthError(response.status);
        }
        return (await response.json()) as AudiobookMe;
    }

    /** Read just this book on playback open; 404 means no saved progress. */
    async getProgressAs(
        userApiKey: string,
        itemId: string,
        signal?: AbortSignal,
    ): Promise<AudiobookMediaProgress | undefined> {
        const response = await fetchWithTimeout(
            joinUpstreamUrl(this.baseUrl, `/api/me/progress/${encodePathSegment(itemId)}`),
            { headers: { Authorization: `Bearer ${userApiKey}` }, signal },
        );
        if (response.status === 404) return undefined;
        if (response.status === 405 || response.status === 501) {
            const me = await this.getMeAs(userApiKey, signal);
            if (!me) throw new Error('AudiobookShelf returned no current-user progress');
            return me.mediaProgress.find((p) => p.libraryItemId === itemId && !p.episodeId);
        }
        if (!response.ok) throw new AudiobookshelfUserAuthError(response.status);
        return (await response.json()) as AudiobookMediaProgress;
    }

    // -----------------------------------------------------------------------
    // Playback sessions — always AS THE LISTENING USER
    // -----------------------------------------------------------------------

    /**
     * `POST /api/items/:id/play` **as the given user**.
     *
     * The listener's own key, never the operator's: ABS applies per-user
     * library permissions, and an operator-key session would open playback for
     * books the listener is not entitled to upstream — and would file the
     * listening time against the wrong account.
     *
     * `startTime` is NOT a parameter here, because ABS ignores it: the session
     * always opens at the caller's own saved progress (measured both ways). A
     * caller that wants a different start position tells the CLIENT where to
     * start; it does not try to persuade this endpoint.
     */
    async startPlaybackSessionAs(
        userApiKey: string,
        itemId: string,
        input: {
            deviceId: string;
            clientName: string;
            clientVersion?: string;
            supportedMimeTypes: string[];
            forceTranscode?: boolean;
        },
    ): Promise<AudiobookPlaySession> {
        const response = await fetchWithTimeout(
            joinUpstreamUrl(this.baseUrl, `/api/items/${encodePathSegment(itemId)}/play`),
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${userApiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    deviceInfo: {
                        deviceId: input.deviceId,
                        clientName: input.clientName,
                        clientVersion: input.clientVersion,
                    },
                    supportedMimeTypes: input.supportedMimeTypes,
                    mediaPlayer: 'html5',
                    forceTranscode: input.forceTranscode === true,
                    forceDirectPlay: false,
                }),
            },
        );
        if (!response.ok) {
            throw new AudiobookshelfUserAuthError(response.status, `/api/items/${itemId}/play`);
        }
        const session = (await response.json()) as AudiobookPlaySession;
        if (!session?.id) {
            throw new Error('Audiobookshelf play session returned no session id');
        }
        return session;
    }

    /**
     * `POST /api/session/:id/sync` **as the given user**.
     *
     * Returns false when ABS no longer knows the session (its sessions are
     * in-memory and die on an ABS restart or the other-device rule). That is a
     * routine, non-fatal outcome — never a reason to stop playback — so it is a
     * return value rather than a throw. Everything else throws.
     */
    async syncSessionAs(
        userApiKey: string,
        sessionId: string,
        body: AudiobookSessionSyncBody,
    ): Promise<boolean> {
        return this.postSessionAs(userApiKey, sessionId, 'sync', body);
    }

    /**
     * `POST /api/session/:id/close`. Same not-found semantics as sync.
     *
     * A `null` body closes the session WITHOUT asserting a position. Measured
     * against the endpoint's own code: `SessionController.close` treats an empty
     * object as no sync data (`if (syncData && !Object.keys(syncData).length)
     * syncData = null`) and `closeSession` then only persists the session row —
     * `createUpdateMediaProgress` is never reached. That distinction is what
     * lets the stale-session reaper end an abandoned session without rewinding
     * a listener who has since moved to another device, since ABS's progress row
     * is last-write-wins with no history.
     */
    async closeSessionAs(
        userApiKey: string,
        sessionId: string,
        body: AudiobookSessionSyncBody | null,
    ): Promise<boolean> {
        return this.postSessionAs(userApiKey, sessionId, 'close', body);
    }

    /**
     * `PATCH /api/me/progress/:itemId` **as the given user** — the session-less
     * write to AudiobookShelf's own progress row.
     *
     * This is the ONLY way to move a listener's resume point without opening an
     * ABS playback session, which is what makes it the right primitive for
     * bookkeeping writes (an offline catch-up flush, the watch-sync sweep) as
     * opposed to live playback. A session exists to stream bytes; borrowing one
     * purely to assert a position drags in a stream slot, a minted token and the
     * paused-deck supersede, none of which a position write should cause.
     *
     * The progress row is last-write-wins with no history, so the caller is
     * responsible for only ever passing a position it has already arbitrated —
     * never a raw client-supplied one that may be older than what ABS holds.
     *
     * Returns false when ABS does not know the item (404), matching the
     * not-found semantics of the session calls above; everything else throws.
     */
    async patchProgressAs(
        userApiKey: string,
        itemId: string,
        body: { currentTime?: number; duration?: number; isFinished?: boolean },
    ): Promise<boolean> {
        const response = await fetchWithTimeout(
            joinUpstreamUrl(this.baseUrl, `/api/me/progress/${encodePathSegment(itemId)}`),
            {
                method: 'PATCH',
                headers: {
                    Authorization: `Bearer ${userApiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            },
        );
        if (response.status === 404) return false;
        if (!response.ok) {
            throw new AudiobookshelfUserAuthError(response.status, `/api/me/progress/${itemId}`);
        }
        return true;
    }

    /**
     * `PATCH /api/me/progress/:itemId { isFinished: true }` **as the given user**.
     *
     * The session `/sync` body has no finished field — verified: it carries only
     * `currentTime`, `timeListened` and `duration` — so syncing a position at the
     * very end does NOT mark a book read upstream. This is the only endpoint that
     * does, and measured on the live server it sets `isFinished: true` and
     * `progress: 1`.
     *
     * Only ever called for a genuine completion: the row is last-write-wins with
     * no history. Note this is no longer the only progress-row write made outside
     * a session — see `patchProgressAs`, which moves a position without touching
     * the finished flag.
     */
    async markFinishedAs(userApiKey: string, itemId: string): Promise<boolean> {
        return this.patchProgressAs(userApiKey, itemId, { isFinished: true });
    }

    private async postSessionAs(
        userApiKey: string,
        sessionId: string,
        action: 'sync' | 'close',
        body: AudiobookSessionSyncBody | null,
    ): Promise<boolean> {
        const response = await fetchWithTimeout(
            joinUpstreamUrl(this.baseUrl, `/api/session/${encodePathSegment(sessionId)}/${action}`),
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${userApiKey}`,
                    'Content-Type': 'application/json',
                },
                // `{}` rather than an omitted body: ABS reads `req.body` and
                // only nulls the sync data when it is an EMPTY OBJECT, so an
                // absent body would not take the no-progress-write path.
                body: JSON.stringify(body ?? {}),
            },
        );
        // 404 is "that session is gone", which is expected often enough that it
        // must not look like an outage. 401/403 is a dead key and is worth
        // knowing about, so it still throws.
        if (response.status === 404) return false;
        if (!response.ok) {
            throw new AudiobookshelfUserAuthError(
                response.status,
                `/api/session/${sessionId}/${action}`,
            );
        }
        return true;
    }

    async getLibraryItems(libraryId: string, limit: number): Promise<AudiobookItem[]> {
        if (!this.isConfigured()) {
            return [];
        }
        try {
            const response = await fetchWithTimeout(
                joinUpstreamUrl(
                    this.baseUrl,
                    `/api/libraries/${encodePathSegment(libraryId)}/items?limit=${limit}&collapseseries=1&minified=1`,
                ),
                {
                    headers: this.createHeaders(),
                },
            );

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = (await response.json()) as AudiobookLibraryResponse;
            return data.results || [];
        } catch (e) {
            logger.debug('Failed to fetch Audiobookshelf library items', {
                libraryId,
                error: e,
            });
            return [];
        }
    }

    /**
     * Perform a GET and parse the JSON body, reporting every failure mode
     * instead of collapsing it into an empty result.
     *
     * Side effects match the display methods above: an `ENOTFOUND` latches
     * `connectionFailed` so a dead server is only logged once per process. The
     * difference is purely in the return value — the caller always learns that
     * the request failed.
     */
    private async fetchJson(
        endpoint: string,
        context: AudiobookshelfRequestContext,
        signal?: AbortSignal,
    ): Promise<AudiobookshelfResult<unknown>> {
        if (!this.isConfigured()) {
            return failure(
                'not-configured',
                this.connectionFailed
                    ? 'Audiobookshelf server previously unreachable'
                    : 'Audiobookshelf is not configured',
                context,
            );
        }

        let response: Response;
        try {
            response = await fetchWithTimeout(joinUpstreamUrl(this.baseUrl, endpoint), {
                headers: this.createHeaders(),
                signal,
            });
        } catch (error) {
            const err = error as Error;
            const causeCode = (err as { cause?: { code?: unknown } }).cause?.code;
            const code = toString(causeCode);
            if (code === 'ENOTFOUND') {
                if (!this.connectionFailed) {
                    this.connectionFailed = true;
                    logger.warn('Server not reachable', { url: this.baseUrl });
                }
            } else if (!this.connectionFailed && this.shouldWarnAboutConnection()) {
                // Same throttle as getSessions(): this path is reached by polling
                // callers too, and "fetch failed" once per poll forever is noise
                // that hides the one line that mattered.
                logger.warn('Audiobookshelf request failed', {
                    ...context,
                    ...this.describeFetchFailure(err),
                });
            }
            return {
                ok: false,
                error: { kind: 'network', message: err.message, code, name: err.name, ...context },
            };
        }

        // The connection itself worked, whatever the status says — so a later
        // outage is a NEW event and must not inherit this one's cooldown.
        this.noteConnectionRecovered();

        if (!response.ok) {
            logger.warn('Audiobookshelf request returned an error status', {
                ...context,
                status: response.status,
            });
            return {
                ok: false,
                error: {
                    kind: 'http',
                    message: `HTTP error! status: ${response.status}`,
                    status: response.status,
                    ...context,
                },
            };
        }

        try {
            return { ok: true, value: (await response.json()) as unknown };
        } catch (error) {
            const err = error as Error;
            logger.warn('Audiobookshelf returned a non-JSON body', {
                ...context,
                message: err.message,
            });
            return failure(
                'malformed',
                `Response body was not valid JSON: ${err.message}`,
                context,
            );
        }
    }

    /**
     * Fetch one page of `GET /api/libraries/:id/items?minified=1` for the
     * reconcile sweep.
     *
     * Deliberately omits `collapseseries=1` (which
     * {@link AudiobookshelfClient.getLibraryItems} sets for the display
     * surfaces): collapsing folds every volume of a numbered serial into a
     * single synthetic entry, so the id set would be missing hundreds of real
     * library items and the differ would dismiss all of them.
     *
     * `total` is required rather than inferred — without it the paginator
     * cannot prove it saw the whole library.
     */
    async listLibraryItemsMinified(
        libraryId: string,
        options: ListLibraryItemsOptions = {},
    ): Promise<AudiobookshelfResult<AudiobookItemPage>> {
        const limit = clampPageSize(options.limit);
        const page = clampPageNumber(options.page);
        const context: AudiobookshelfRequestContext = { libraryId, page };
        if (!isSafePathSegment(libraryId)) {
            return failure('malformed', 'Unusable library id', context);
        }

        const result = await this.fetchJson(
            `/api/libraries/${encodePathSegment(libraryId)}/items?limit=${limit}&page=${page}&minified=1`,
            context,
        );
        if (!result.ok) return result;

        const payload = asObject(result.value);
        if (!payload) {
            return failure('malformed', 'Library items response was not an object', context);
        }
        if (!Array.isArray(payload.results)) {
            return failure('malformed', 'Library items response had no `results` array', context);
        }
        const total = toNumber(payload.total);
        if (total === undefined) {
            return failure(
                'malformed',
                'Library items response had no numeric `total`; completeness cannot be verified',
                context,
            );
        }

        const items: AudiobookItemMinified[] = [];
        for (const raw of payload.results) {
            const item = normalizeMinifiedItem(raw, libraryId);
            if (!item) {
                return failure(
                    'malformed',
                    'Library items response contained an entry without a usable id',
                    context,
                );
            }
            items.push(item);
        }

        return { ok: true, value: { libraryId, items, total, page, limit } };
    }

    /**
     * Page an ABS library until exhausted and return the complete item set.
     *
     * Fails closed for the deletion rail: the result is `ok: true` only when
     * every page was fetched successfully *and* the collected count reaches the
     * `total` ABS reported. A page error, a server that ignores `page`, the
     * page cap, or a shortfall against `total` all produce `ok: false`, so a
     * partial sweep can never be mistaken for "these ids disappeared upstream".
     *
     * The cost of that strictness is a skipped cycle when books are added
     * mid-sweep and `total` moves under us; the next sweep (~15 min) recovers.
     * The cost of the opposite choice is dismissing a live catalog.
     */
    async listAllLibraryItemsMinified(
        libraryId: string,
        options: ListAllLibraryItemsOptions = {},
    ): Promise<AudiobookshelfResult<AudiobookLibrarySnapshot>> {
        const limit = clampPageSize(options.limit);
        const maxPages = clampMaxPages(options.maxPages);

        const items: AudiobookItemMinified[] = [];
        const seen = new Set<string>();
        let total = 0;
        let pagesFetched = 0;

        for (let page = 0; page < maxPages; page++) {
            const result = await this.listLibraryItemsMinified(libraryId, { limit, page });
            if (!result.ok) return result;

            pagesFetched++;
            total = result.value.total;

            let added = 0;
            for (const item of result.value.items) {
                if (seen.has(item.id)) continue;
                seen.add(item.id);
                items.push(item);
                added++;
            }

            // A full page that contributed nothing new means the server is
            // replaying the same page — `page` is being ignored. Walking on
            // would spin until the cap and still return a short list.
            if (result.value.items.length > 0 && added === 0) {
                return failure(
                    'incomplete',
                    `Pagination did not advance at page ${page}: ${result.value.items.length} items returned, all already seen`,
                    { libraryId, page },
                );
            }

            // A short (or empty) page is the last page.
            if (result.value.items.length < limit) break;
            if (total > 0 && items.length >= total) break;
        }

        if (items.length < total) {
            return failure(
                'incomplete',
                `Collected ${items.length} of ${total} items for library ${libraryId} after ${pagesFetched} page(s)`,
                { libraryId },
            );
        }

        return { ok: true, value: { libraryId, items, total, pagesFetched } };
    }

    /**
     * Fetch `GET /api/items/:id?expanded=1` — the full item, including
     * `media.metadata` and `media.chapters`.
     *
     * `expanded=1` is what promotes `media` from the minified counters
     * (`numChapters`, `numTracks`) to the actual chapter and metadata objects
     * the row insert and the modal's table of contents need.
     */
    async getLibraryItemExpanded(
        itemId: string,
    ): Promise<AudiobookshelfResult<AudiobookItemExpanded>> {
        const context: AudiobookshelfRequestContext = { itemId };
        if (!isSafePathSegment(itemId)) {
            return failure('malformed', 'Unusable item id', context);
        }

        const result = await this.fetchJson(
            `/api/items/${encodePathSegment(itemId)}?expanded=1`,
            context,
        );
        if (!result.ok) return result;

        const item = asObject(result.value);
        if (!item) {
            return failure('malformed', 'Expanded item response was not an object', context);
        }

        const id = toString(item.id);
        if (!id) {
            return failure('malformed', 'Expanded item response had no id', context);
        }

        const media = asObject(item.media);
        if (!media) {
            return failure('malformed', 'Expanded item response had no `media` object', context);
        }

        const metadata = asObject(media.metadata);
        if (!metadata) {
            return failure('malformed', 'Expanded item response had no `media.metadata`', context);
        }

        // `chapters` is absent for podcasts and for books ABS has not parsed
        // yet; that is legitimately "no chapters". A present-but-unparseable
        // entry is not — silently dropping it would corrupt the table of
        // contents, so it fails the whole fetch.
        const chapters: AudiobookChapter[] = [];
        const rawChapters = media.chapters;
        if (rawChapters !== undefined && rawChapters !== null) {
            if (!Array.isArray(rawChapters)) {
                return failure('malformed', '`media.chapters` was not an array', context);
            }
            for (const [index, rawChapter] of rawChapters.entries()) {
                const chapter = normalizeChapter(rawChapter, index);
                if (!chapter) {
                    return failure(
                        'malformed',
                        `Chapter at index ${index} had no numeric \`start\``,
                        context,
                    );
                }
                chapters.push(chapter);
            }
        }

        // `audioFiles` carries the per-file durations and inodes. Both are
        // load-bearing: the expanded payload has NO `media.duration` (verified
        // against a real server — it exists only on the minified listing), so a
        // book's runtime has to be summed from here or every ingested row lands
        // with a NULL runtime. The `ino` is how the player addresses each file.
        const audioFiles: AudiobookAudioFile[] = [];
        const rawAudioFiles = media.audioFiles;
        if (rawAudioFiles !== undefined && rawAudioFiles !== null) {
            if (!Array.isArray(rawAudioFiles)) {
                return failure('malformed', '`media.audioFiles` was not an array', context);
            }
            for (const [index, rawFile] of rawAudioFiles.entries()) {
                if (!isRecord(rawFile)) continue;
                audioFiles.push({
                    index: toNumber(rawFile.index) ?? index,
                    ino: toString(rawFile.ino) ?? null,
                    duration: toNumber(rawFile.duration) ?? null,
                    mimeType: toString(rawFile.mimeType) ?? null,
                    codec: toString(rawFile.codec) ?? null,
                });
            }
        }

        // Prefer an explicit total when present (the minified shape has one);
        // otherwise sum the parts. A file with an unreadable duration
        // contributes 0 rather than poisoning the total with NaN.
        const summedDuration = audioFiles.reduce((total, f) => total + (f.duration ?? 0), 0);
        const duration = toNumber(media.duration) ?? (summedDuration > 0 ? summedDuration : null);

        return {
            ok: true,
            value: {
                id,
                libraryId: toString(item.libraryId) ?? null,
                folderId: toString(item.folderId) ?? null,
                path: toString(item.path) ?? null,
                relPath: toString(item.relPath) ?? null,
                mediaType: toString(item.mediaType) ?? null,
                mtimeMs: toNumber(item.mtimeMs) ?? 0,
                addedAt: toNumber(item.addedAt) ?? 0,
                updatedAt: toNumber(item.updatedAt) ?? 0,
                isMissing: absFlag(item.isMissing),
                isInvalid: absFlag(item.isInvalid),
                numFiles: toNumber(item.numFiles) ?? null,
                size: toNumber(item.size) ?? null,
                media: {
                    id: toString(media.id) ?? null,
                    libraryItemId: toString(media.libraryItemId) ?? null,
                    metadata: normalizeExpandedMetadata(metadata),
                    coverPath: toString(media.coverPath) ?? null,
                    tags: toStringArray(media.tags),
                    chapters,
                    audioFiles,
                    duration,
                    size: toNumber(media.size) ?? null,
                    numTracks: toNumber(media.numTracks) ?? audioFiles.length,
                    numAudioFiles: toNumber(media.numAudioFiles) ?? audioFiles.length,
                },
            },
        };
    }

    /**
     * Get items from all discovered libraries
     */
    async getAllLibraryItems(limit = 50): Promise<AudiobookItem[]> {
        if (!this.isConfigured()) {
            return [];
        }

        // Ensure libraries are loaded (lazy init)
        await this.ensureInitialized();

        if (this.libraryIds.length === 0) {
            return [];
        }

        // Distribute limit across libraries
        const perLibraryLimit = Math.ceil(limit / this.libraryIds.length);

        const results = await Promise.allSettled(
            this.libraryIds.map((libraryId) => this.getLibraryItems(libraryId, perLibraryLimit)),
        );

        const allItems = results
            .filter((r): r is PromiseFulfilledResult<AudiobookItem[]> => r.status === 'fulfilled')
            .flatMap((r) => r.value);

        return allItems.slice(0, limit);
    }

    async search(query: string, limit = 20): Promise<AudiobookItem[]> {
        if (!this.isConfigured()) {
            return [];
        }

        // Ensure libraries are loaded before searching (lazy init)
        await this.ensureInitialized();

        // If still no libraries discovered, try global search as fallback
        if (this.libraryIds.length === 0) {
            try {
                const response = await fetchWithTimeout(
                    joinUpstreamUrl(
                        this.baseUrl,
                        `/api/search/books?q=${encodeURIComponent(query)}&limit=${limit}`,
                    ),
                    {
                        headers: this.createHeaders(),
                    },
                );
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                const data = (await response.json()) as AudiobookSearchResponse;
                return data.results || [];
            } catch (error) {
                logger.error('Failed to search Audiobookshelf (global)', error as Error);
                return [];
            }
        }

        // Search across all discovered libraries
        try {
            const searchPromises = this.libraryIds.map(async (libraryId) => {
                try {
                    const perLibraryLimit = Math.max(1, Math.ceil(limit / this.libraryIds.length));
                    const searchUrl = joinUpstreamUrl(
                        this.baseUrl,
                        `/api/libraries/${encodePathSegment(libraryId)}/search?q=${encodeURIComponent(query)}&limit=${perLibraryLimit}`,
                    );

                    const response = await fetchWithTimeout(searchUrl, {
                        headers: this.createHeaders(),
                    });

                    if (!response.ok) {
                        logger.warn('Search failed for library', {
                            libraryId,
                            status: response.status,
                        });
                        return [];
                    }
                    type LibrarySearchEntry = {
                        libraryItem?: AudiobookItem;
                        id?: string;
                        media?: AudiobookMedia;
                    };

                    const data = (await response.json()) as AudiobookSearchResponse & {
                        book?: LibrarySearchEntry[];
                    };

                    // Handle the actual response structure: data.book contains array of { libraryItem: ... }
                    const books: Array<AudiobookItem | LibrarySearchEntry> =
                        data.book ?? data.results ?? [];
                    const libraryName = this.libraryNames.get(libraryId);
                    return books.map((bookObj) => {
                        // If it's wrapped in libraryItem, extract it
                        if ('libraryItem' in bookObj && bookObj.libraryItem) {
                            return {
                                id: bookObj.libraryItem.id,
                                media: bookObj.libraryItem.media,
                                libraryId,
                                libraryName,
                            };
                        }
                        // Otherwise assume it's already the correct format
                        if (
                            'id' in bookObj &&
                            typeof bookObj.id === 'string' &&
                            'media' in bookObj &&
                            bookObj.media
                        ) {
                            return {
                                id: bookObj.id,
                                media: bookObj.media,
                                libraryId,
                                libraryName,
                            };
                        }
                        return {
                            id: '',
                            media: {
                                metadata: { title: '' },
                                duration: 0,
                            },
                            libraryId,
                            libraryName,
                        };
                    });
                } catch (error) {
                    logger.warn('Failed to search library', {
                        libraryId,
                        error: String(error),
                    });
                    return [];
                }
            });

            const allResults = await Promise.all(searchPromises);
            const combinedResults = allResults.flat();

            // Remove duplicates and limit results
            const uniqueResults = combinedResults.filter(
                (item, index, self) => index === self.findIndex((t) => t.id === item.id),
            );

            return uniqueResults.slice(0, limit);
        } catch (error) {
            logger.error('Failed to search Audiobookshelf libraries', error as Error);
            return [];
        }
    }

    async getBookImage(libraryItemId: string): Promise<Response> {
        if (!this.isConfigured()) {
            throw new Error('Audiobookshelf not configured');
        }
        const response = await fetchWithTimeout(
            joinUpstreamUrl(this.baseUrl, `/api/items/${encodePathSegment(libraryItemId)}/cover`),
            {
                headers: this.createHeaders(),
            },
        );

        // Let the cover service distinguish an expected missing image from a
        // failed upstream. Only 404 is eligible for its short negative cache.
        if (!response.ok && response.status !== 404) {
            throw new Error(`Failed fetching Image from Audiobookshelf: HTTP ${response.status}`);
        }

        return response;
    }
}

export const audiobookshelfClient = new AudiobookshelfClient(
    () => config.AUDIOURL,
    () => config.AUDIOAPIKEY,
);
