// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/[id]/download-zip.ts — GET /api/media/{id}/download-zip
 *
 * A whole series, or one season (`?season=N`, season 0 only with `?specials=1`, or a season id),
 * as ONE archive for browsers that cannot write a folder (Safari, Firefox, iOS). The archive is a
 * STORE-only ZIP (video does not compress) with an exact Content-Length known before the first
 * byte is sent, laid out as `<series folder>/<season folder>/<file name>`: the same names
 * GET /api/media/{id}/download-list returns, from the same code path.
 *
 * Gate order, like the single-file download: cross-site 403, id resolution, library/age access
 * (404), FEATURE_MEDIA_DOWNLOAD (404) and the per-user permission (403, logged as denied).
 * Then, BEFORE any listing or file stat, a GET takes its own download lease (429 at the limit;
 * a HEAD takes none), and the preparation needs an admission (1 per user, 4 per server, shared
 * in Valkey; over it 429 `preparation_busy`). Preparation has a 60 s deadline (503
 * `preparation_timeout`) and stops when the client leaves or the tracker ends. The authorized
 * result (names, sizes, Content-Length) is cached for 5 minutes per (user, id, season,
 * specials), so a HEAD probe followed by the GET prepares once. The item list: a movie or a
 * single episode is 400, more than 5000 files is 413, nothing downloadable is 404. Every file
 * advertised as available is resolved, stat-ed and contained (download-path.ts) BEFORE the
 * headers go out; if any cannot be included the answer is 409 `files_unavailable` rather than a
 * short archive. Files are opened once with the descriptor verified when streamed.
 *
 * One archive = one lease and one download_events row (keyed on the requested series/season id;
 * no file or rendition id), bandwidth-limited as a whole. No Range support: a Range request gets
 * the full 200. HEAD answers the headers only (no lease, no log).
 *
 * Auth: user. Surface: internal (the web app is the only caller).
 */

import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { config } from '$lib/server/config.js';
import { getDb } from '$lib/server/database/index.js';
import { checkMediaAccess, checkMediaAccessBatch } from '$lib/server/middleware/media-access.js';
import {
    allowedFileIds,
    deniedLibraryGroupsFor,
} from '$lib/server/services/download-file-scope.js';
import {
    crossSiteForbiddenResponse,
    downloadForbiddenResponse,
    mediaAccessUserOf,
} from '$lib/server/services/download-access-guard.js';
import {
    buildDownloadList,
    parseSeason,
    type DownloadListItem,
} from '$lib/server/services/download-list.service.js';
import { noteHandoff, parseHandoffNonce } from '$lib/server/services/download-handoff.js';
import { PREP_DEADLINE_MS, acquirePreparation } from '$lib/server/services/download-preparation.js';
import {
    recordDownloadRefused,
    trackDownload,
    type DownloadTracker,
} from '$lib/server/services/download-tracking.js';
import { attachmentDisposition } from '$lib/server/utils/content-disposition.js';
import { openDownloadableFile, resolveDownloadablePath } from '$lib/server/utils/download-path.js';
import { observeStream, openedFileStream } from '$lib/server/utils/file-streaming.js';
import { Logger } from '$lib/server/utils/logger.js';
import { resolveMediaPath } from '$lib/server/utils/media-path-resolver.js';
import { throttleNodeStream } from '$lib/server/utils/throttled-stream.js';
import {
    predictZipSize,
    zipStoreReadable,
    type ZipEntrySource,
} from '$lib/server/utils/zip-store-stream.js';
import { resolveCatalogInternalId } from '../../catalog/resolve-id.js';

const logger = Logger.for('DownloadZip');

/** Files stat-ed at the same time while the archive size is computed (NFS/CIFS latency). */
const STAT_CONCURRENCY = 8;

interface ArchiveFile {
    item: DownloadListItem;
    /** Path inside the library, contained; re-contained when opened. */
    containerPath: string;
    /** Actual size on disk, what the archive announces. */
    size: number;
}

interface ResolvedArchive {
    files: ArchiveFile[];
    /** Advertised-available items that could not be included (missing, unreadable, outside the roots). */
    failed: number;
}

/**
 * Resolve and stat every item advertised as available. The caller refuses the request when any
 * of them fails: a short archive would look like a finished season. Stops early (undefined)
 * when the client has gone away.
 */
async function resolveArchiveFiles(
    sql: NonNullable<ReturnType<typeof getDb>>,
    items: DownloadListItem[],
    signal: AbortSignal,
): Promise<ResolvedArchive | undefined> {
    const out: (ArchiveFile | null)[] = new Array(items.length).fill(null);
    let failed = 0;
    for (let i = 0; i < items.length; i += STAT_CONCURRENCY) {
        if (signal.aborted) return undefined;
        await Promise.all(
            items.slice(i, i + STAT_CONCURRENCY).map(async (item, j) => {
                if (!item.available) return;
                const info = await resolveMediaPath(
                    item.filePath,
                    { skipLocalAccessCheck: true },
                    sql,
                );
                // Defense-in-depth, as in media-download-handler.ts: a tampered media_files row
                // must not put an arbitrary host file into an archive.
                // Strict download containment (canonical target inside a library root or an
                // extra download root, regular file): a file that fails it is unavailable.
                if (
                    !info?.isAccessible ||
                    !info.fileSize ||
                    !(await resolveDownloadablePath(
                        sql,
                        info.containerPath,
                        config.DOWNLOAD_ALLOWED_MOUNT_ROOTS,
                        item.mediaItemId,
                    ))
                ) {
                    failed += 1;
                    return;
                }
                out[i + j] = { item, containerPath: info.containerPath, size: info.fileSize };
            }),
        );
    }
    if (signal.aborted) return undefined;
    return { files: out.filter((f): f is ArchiveFile => f !== null), failed };
}

/** One archive holds at most this many files (the preparation stats every one of them). */
export const MAX_ARCHIVE_ENTRIES = 5000;

/** Authorized preparation results are reused for this long (a HEAD probe, then the GET). */
const PREP_CACHE_TTL_MS = 5 * 60_000;
const PREP_CACHE_MAX = 200;

interface Prepared {
    files: ArchiveFile[];
    names: string[];
    contentLength: number;
    zipName: string;
}

const prepCache = new Map<string, { at: number; value: Prepared }>();

/** Test hook. */
export function resetPreparationCacheForTests(): void {
    prepCache.clear();
}

/**
 * The caller's CURRENT access scope as part of the cache key: the denied library groups, the
 * age restriction and the download permission. A user whose scope changed never reuses a result
 * prepared under the old one.
 */
function scopeKey(
    denied: readonly string[] | null,
    user: { isAgeRestricted?: boolean; maxAgeRating?: number | null },
    mayDownload: boolean,
): string {
    const parts = [
        [...(denied ?? [])].sort().join(','),
        user.isAgeRestricted ? `age:${user.maxAgeRating ?? 0}` : 'age:-',
        mayDownload ? 'dl' : 'nodl',
    ].join('|');
    return crypto.createHash('sha1').update(parts).digest('hex').slice(0, 16);
}

/**
 * A cache hit must still be allowed NOW: every cached file id against the current file-level
 * library scope, every item against the current item-level access (library and age). Database
 * only, no file system. Anything else (or an error) is a miss.
 */
async function stillAuthorized(
    sql: NonNullable<ReturnType<typeof getDb>>,
    prepared: Prepared,
    accessUser: Parameters<typeof buildDownloadList>[2],
    denied: readonly string[] | null,
): Promise<boolean> {
    try {
        const fileIds = [...new Set(prepared.files.map((f) => f.item.fileId))];
        const okFiles = await allowedFileIds(sql, fileIds, denied);
        if (!fileIds.every((id) => okFiles.has(id))) return false;
        const itemIds = [...new Set(prepared.files.map((f) => f.item.mediaItemId))];
        const okItems = await checkMediaAccessBatch(sql, itemIds, accessUser);
        return itemIds.every((id) => okItems.has(id));
    } catch {
        return false;
    }
}

function cacheGet(key: string): Prepared | null {
    const hit = prepCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > PREP_CACHE_TTL_MS) {
        prepCache.delete(key);
        return null;
    }
    return hit.value;
}

function cachePut(key: string, value: Prepared): void {
    prepCache.delete(key);
    while (prepCache.size >= PREP_CACHE_MAX) {
        const oldest = prepCache.keys().next().value;
        if (oldest === undefined) break;
        prepCache.delete(oldest);
    }
    prepCache.set(key, { at: Date.now(), value });
}

const ABORTED = Symbol('aborted');

/** Settles with ABORTED as soon as `signal` aborts, even while `p` (blocked I/O) is still pending. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
    if (signal.aborted) {
        p.catch(() => {});
        return Promise.resolve(ABORTED);
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => resolve(ABORTED);
        signal.addEventListener('abort', onAbort, { once: true });
        p.then(
            (v) => {
                signal.removeEventListener('abort', onAbort);
                resolve(v);
            },
            (e) => {
                signal.removeEventListener('abort', onAbort);
                reject(e);
            },
        );
    });
}

/** `<series>/<season>/<file>`, with " (2)", " (3)" ... before the extension on a name clash. */
function archiveNames(seriesFolder: string, files: ArchiveFile[]): string[] {
    const seen = new Set<string>();
    return files.map(({ item }) => {
        const base = item.seasonFolder
            ? `${seriesFolder}/${item.seasonFolder}/${item.fileName}`
            : `${seriesFolder}/${item.fileName}`;
        let name = base;
        for (let n = 2; seen.has(name.toLowerCase()); n++) {
            const dot = base.lastIndexOf('.');
            const stem = dot > base.lastIndexOf('/') ? base.slice(0, dot) : base;
            const ext = dot > base.lastIndexOf('/') ? base.slice(dot) : '';
            name = `${stem} (${n})${ext}`;
        }
        seen.add(name.toLowerCase());
        return name;
    });
}

/**
 * Open once and verify the descriptor (see download-path.ts): the bytes are streamed from that
 * descriptor, so a link swapped in after the preparation cannot redirect the read.
 */
async function openVerified(
    sql: NonNullable<ReturnType<typeof getDb>>,
    path: string,
    itemKey: string,
    size: number,
): Promise<Readable> {
    const opened = await openDownloadableFile(
        sql,
        path,
        config.DOWNLOAD_ALLOWED_MOUNT_ROOTS,
        itemKey,
    );
    if (!opened) throw new Error('Media file is no longer inside a download root');
    if (opened.size !== size) {
        await opened.handle.close().catch(() => {});
        throw new Error('Media file changed size while the archive was being prepared');
    }
    return openedFileStream(opened);
}

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    raw: true,
    handlers: {
        GET: async (event) => {
            const crossSite = crossSiteForbiddenResponse(event.request, event.url);
            if (crossSite) return crossSite;

            const season = parseSeason(event.url.searchParams.get('season'));
            if (season === 'invalid') {
                return ApiProblem.validationFailed([
                    { field: 'season', message: 'season must be a non-negative integer' },
                ]);
            }
            const specials = event.url.searchParams.get('specials') === '1';

            const internalId = await resolveCatalogInternalId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const sql = getDb();
            const accessUser = mediaAccessUserOf(event.locals);
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            if (!accessUser || !(await checkMediaAccess(sql, internalId, accessUser))) {
                return ApiProblem.notFound('Media item not found');
            }

            // Same switch order as the single-file route: a disabled feature is a plain 404.
            if (!config.FEATURE_MEDIA_DOWNLOAD) return ApiProblem.notFound('Not Found');
            const forbidden = await downloadForbiddenResponse(event.locals);
            if (forbidden) {
                recordDownloadRefused(
                    event,
                    { mediaItemId: internalId, archive: true, surface: 'web' },
                    'denied',
                );
                return forbidden;
            }

            const isHead = event.request.method === 'HEAD';
            const userId = event.locals.user?.userId ?? 'anonymous';
            const denied = await deniedLibraryGroupsFor(sql, accessUser);
            const cacheKey = `${userId}|${internalId}|${season ?? ''}|${specials ? 1 : 0}|${scopeKey(denied, accessUser, true)}`;

            // GET holds its download slot (lease) from here on, so every later step counts
            // against the parallel limit. A HEAD takes none.
            let tracker: DownloadTracker | null = null;
            if (!isHead) {
                const tracked = await trackDownload(event, {
                    mediaItemId: internalId,
                    archive: true,
                    surface: 'web',
                });
                if (!tracked.ok) return tracked.response;
                tracker = tracked.tracker;
            }

            // Preparation can be cut from three sides: the client leaves, the tracker ends
            // (stall watchdog, revoked lease) or the 60 s deadline passes. One controller, one
            // verdict.
            const prepAbort = new AbortController();
            let timedOut = false;
            const onClientGone = () => prepAbort.abort();
            event.request.signal.addEventListener('abort', onClientGone, { once: true });
            if (event.request.signal.aborted) prepAbort.abort();
            tracker?.observer.setCancel?.(() => prepAbort.abort());
            const deadline = setTimeout(() => {
                timedOut = true;
                prepAbort.abort();
            }, PREP_DEADLINE_MS);

            /** The answer for an abandoned preparation: deadline, client gone, or tracker ended. */
            const abortedAnswer = (): Response => {
                if (timedOut) {
                    return ApiProblem.dependencyUnavailable(
                        'Preparing the download took too long',
                        {
                            reason: 'preparation_timeout',
                        },
                    );
                }
                // The client left: nothing to answer. The tracker ended: tell the caller.
                if (event.request.signal.aborted) return new Response(null, { status: 499 });
                return ApiProblem.dependencyUnavailable(
                    'The download was ended before it started',
                    {
                        reason: 'download_ended',
                    },
                );
            };

            let handedOff = false;
            try {
                let prepared = cacheGet(cacheKey);
                if (prepared && !(await stillAuthorized(sql, prepared, accessUser, denied))) {
                    prepCache.delete(cacheKey);
                    prepared = null;
                }
                if (!prepared) {
                    // The slot is freed as soon as the work ends OR is abandoned (deadline, client
                    // gone, tracker ended): a hung file-system call must not hold it. The listener
                    // is registered BEFORE the acquire, so an abort that lands while the acquire is
                    // pending is handled too. The late result of abandoned work is discarded.
                    let held: { release(): Promise<void> } | null = null;
                    const releaseOnAbort = () => void held?.release();
                    prepAbort.signal.addEventListener('abort', releaseOnAbort, { once: true });
                    const acquired = await acquirePreparation(userId);
                    if (!acquired.ok) {
                        prepAbort.signal.removeEventListener('abort', releaseOnAbort);
                        return ApiProblem.rateLimited(acquired.retryAfterSec, {
                            error: 'Another download is being prepared. Try again in a moment.',
                            reason: 'preparation_busy',
                        });
                    }
                    const admission = acquired;
                    held = admission;
                    if (prepAbort.signal.aborted) {
                        // Aborted while the acquire was pending: free the slot now, start no work.
                        await admission.release();
                        return abortedAnswer();
                    }
                    const work = prepare(
                        sql,
                        internalId,
                        accessUser,
                        season,
                        specials,
                        prepAbort.signal,
                    );
                    void work.then(
                        () => admission.release(),
                        () => admission.release(),
                    );
                    const result = await raceAbort(work, prepAbort.signal);
                    if (result === ABORTED) return abortedAnswer();
                    if (result.kind === 'response') return result.response;
                    prepared = result.prepared;
                    cachePut(cacheKey, prepared);
                }

                const { files, names, contentLength, zipName } = prepared;
                const headers: Record<string, string> = {
                    'Content-Type': 'application/zip',
                    'Content-Length': String(contentLength),
                    'Content-Disposition': attachmentDisposition(zipName, 'download.zip'),
                    'Accept-Ranges': 'none',
                    'Cache-Control': 'private, no-store',
                };
                if (isHead || !tracker) return new Response(null, { status: 200, headers });
                if (event.request.signal.aborted) return new Response(null, { status: 499 });
                // The tracker may have ended while preparing (stall watchdog, revoked lease):
                // never start streaming with a finished tracker.
                if (tracker.isFinished()) {
                    return ApiProblem.dependencyUnavailable(
                        'The download was ended before it started',
                        { reason: 'download_ended' },
                    );
                }

                tracker.setBytesTotal(contentLength);
                const entries: ZipEntrySource[] = files.map((f, i) => ({
                    name: names[i]!,
                    size: f.size,
                    openSource: () =>
                        openVerified(sql, f.containerPath, f.item.mediaItemId, f.size),
                }));
                const source = zipStoreReadable(entries);
                source.on('error', (err) => {
                    // The cached sizes may be stale: prepare again next time.
                    prepCache.delete(cacheKey);
                    logger.warn('archive stream failed', {
                        mediaItemId: internalId,
                        err: err instanceof Error ? err.message : String(err),
                    });
                });
                const body = observeStream(
                    throttleNodeStream(source, () => tracker!.rate()),
                    tracker.observer,
                );
                tracker.served(200);
                // The web queue's hand-off nonce, noted only now that the archive is prepared
                // and the 200 is about to be returned (like media-download-handler.ts).
                const handoff = parseHandoffNonce(event.url.searchParams.get('h'));
                const handoffUser = event.locals?.user?.userId;
                if (handoff && handoffUser) void noteHandoff(handoffUser, handoff);
                handedOff = true;
                return new Response(body, { status: 200, headers });
            } finally {
                clearTimeout(deadline);
                event.request.signal.removeEventListener('abort', onClientGone);
                // Any answer other than the streaming one gives the slot back without a log row.
                if (!handedOff) tracker?.discard();
            }
        },
    },
});

type PrepareResult = { kind: 'ok'; prepared: Prepared } | { kind: 'response'; response: Response };

/** List, check and size everything the archive holds. Every refusal is a `response`. */
async function prepare(
    sql: NonNullable<ReturnType<typeof getDb>>,
    internalId: string,
    accessUser: Parameters<typeof buildDownloadList>[2],
    season: number | null,
    specials: boolean,
    signal: AbortSignal,
): Promise<PrepareResult> {
    const refuse = (response: Response): PrepareResult => ({ kind: 'response', response });
    const list = await buildDownloadList(sql, internalId, accessUser, { season, specials });
    if (!list) return refuse(ApiProblem.notFound('Media item not found'));
    if (list.root.media_type !== 'tv' && list.root.media_type !== 'season') {
        // A plain 400 (the problem taxonomy has no 400): the item exists but is the wrong kind.
        return refuse(
            json(
                {
                    error: 'Only a series or a season can be downloaded as a ZIP',
                    code: 'not_an_archive',
                },
                { status: 400 },
            ),
        );
    }
    if (list.items.length > MAX_ARCHIVE_ENTRIES) {
        return refuse(
            ApiProblem.payloadTooLarge(
                `An archive holds at most ${MAX_ARCHIVE_ENTRIES} files; download a season at a time`,
                { reason: 'too_many_entries' },
            ),
        );
    }

    const resolved = await resolveArchiveFiles(sql, list.items, signal);
    // Aborted while the files were being checked: the caller's race already answered.
    if (!resolved) return refuse(new Response(null, { status: 499 }));
    if (resolved.failed > 0) {
        return refuse(
            ApiProblem.conflict('Some files of this download are not available', {
                reason: 'files_unavailable',
                details: `${resolved.failed} of ${resolved.failed + resolved.files.length} files are not available`,
            }),
        );
    }
    const { files } = resolved;
    if (files.length === 0) return refuse(ApiProblem.notFound('Nothing to download'));

    const names = archiveNames(list.seriesFolder, files);
    let contentLength: number;
    try {
        contentLength = predictZipSize(files.map((f, i) => ({ name: names[i]!, size: f.size })));
    } catch {
        return refuse(
            ApiProblem.payloadTooLarge('This archive is too large', {
                reason: 'archive_too_large',
            }),
        );
    }

    // One season (asked for by number, or the season id itself) names the file after it.
    const seasonFolders = new Set(files.map((f) => f.item.seasonFolder));
    const oneSeason =
        (season !== null || list.root.media_type === 'season') && seasonFolders.size === 1
            ? [...seasonFolders][0]
            : null;
    const zipName = `${list.seriesFolder}${oneSeason ? ` - ${oneSeason}` : ''}.zip`;
    return { kind: 'ok', prepared: { files, names, contentLength, zipName } };
}
