// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media Image Storage Service
 *
 * Stores custom artwork images for media items either from a URL or a file buffer.
 * Images are written to the media item's directory (or a fallback metadata directory)
 * and recorded in the media_artwork table.
 */

import * as path from 'path';
import { deriveImageProvider } from '$lib/shared/image-provenance.js';
import type { ImageProvider } from '$lib/schemas/image-candidates.js';
import { createHash, randomUUID } from 'node:crypto';
import { fitStem } from '$lib/server/utils/artwork-filename.js';
import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    seasonArtworkFileName,
    type ArtworkType,
    type MaterializableArtworkType,
} from '$lib/server/utils/media-extras.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    getFilesForMediaItem,
    findDescendantDirAnchors,
    type DescendantDirAnchor,
} from '$lib/server/database/queries/media-files.queries.js';
import { getEnabledLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import {
    upsertLocalArtwork,
    getOwnLocalArtwork,
    hasArtworkSuppressionForType,
} from '$lib/server/database/queries/media-artwork.queries.js';
import {
    clearProviderCdnCustomImageUrl,
    clearArtworkBlurhash,
} from '$lib/server/database/queries/media-items.queries.js';
import { withArtworkChoice } from './artwork-choice.service.js';
import { mutateImageCandidates } from './image-candidates.service.js';
import { getSelectedImageCandidate } from '$lib/server/database/queries/image-candidates.queries.js';
import { getImageProxyService } from '$lib/server/services/image-proxy/index.js';
import { resolveWritePath, metadataCentralBaseDir } from './metadata-storage.service.js';
import { safeWriteFile, safeUnlink, safeRename } from '$lib/server/utils/safe-fs.js';
import { writeFileNoFollow } from '$lib/server/utils/contained-fs.js';

const logger = Logger.for('MediaImageStorage');

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

const ALLOWED_CONTENT_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/avif',
]);

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/avif': '.avif',
};

type CustomUrlColumn =
    'custom_poster_url' | 'custom_backdrop_url' | 'custom_logo_url' | 'custom_thumb_url';

const ARTWORK_TYPE_TO_COLUMN: Partial<Record<ArtworkType, CustomUrlColumn>> = {
    poster: 'custom_poster_url',
    backdrop: 'custom_backdrop_url',
    logo: 'custom_logo_url',
    thumb: 'custom_thumb_url',
};

export type ImageSource =
    | {
          type: 'file';
          buffer: Buffer;
          contentType: string;
          sourceTag?: string;
          provider?: ImageProvider;
          providerRef?: string;
      }
    | {
          type: 'url';
          url: string;
          sourceTag?: string;
          provider?: ImageProvider;
          providerRef?: string;
      };

/**
 * Central directory for artwork storage.
 *
 * The base comes from `metadataCentralBaseDir()` so the `metadata-storage-writability`
 * health probe checks the very directory written here — when it was inlined, prod
 * ran for two days with an unwritable base (`/data` owned by root, app as uid 1000)
 * and the only symptom was `write-path-failed` items quietly dead-lettering.
 */
function artworkCentralDir(mediaItemId: string): string {
    return path.join(metadataCentralBaseDir(), '.metadata', mediaItemId);
}

function isPathUnder(childPath: string, parentPath: string): boolean {
    const relative = path.relative(parentPath, childPath);
    return (
        relative === '' ||
        (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative))
    );
}

/**
 * Deepest directory containing both paths, compared segment-wise so a shared
 * *prefix* never passes for a shared *folder* ("/a/Disc 1" and "/a/Disc 2"
 * share the text "/a/Disc " but only the folder "/a").
 */
function commonDir(a: string, b: string): string {
    const left = a.split('/');
    const right = b.split('/');
    const shared: string[] = [];
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
        if (left[i] !== right[i]) break;
        shared.push(left[i]);
    }
    return shared.join('/') || '/';
}

/**
 * Derive the folder that represents a container item (artist, series, album,
 * season) from where its descendants' files actually sit.
 *
 * Each anchor is one direct child, already collapsed to the folder holding all
 * of that child's files. What happens next depends on whether the child owns a
 * folder of its own:
 *
 *  - depth 1 — the child IS the file (track, episode). It contributes no
 *    directory level, so its folder is already the container's folder.
 *    An album split over `Album/CD 01` + `Album/CD 02` collapses to `Album`.
 *  - depth 2 — the child is itself a container (album, season) living in its
 *    own folder, so the container sits one level above it.
 *
 * Taking the common folder across children then handles both fan-outs: an
 * artist with three albums and an artist with one multi-disc album land on the
 * same artist folder.
 *
 * Every candidate must stay a STRICT descendant of a configured library root,
 * which does double duty:
 *
 *  - As a clamp. A series stored without season folders
 *    (/series/Show/ep.mkv, still depth 2 because the season row exists) would
 *    otherwise climb to the library root itself; stopping early yields
 *    /series/Show — the right answer for that layout.
 *  - As a guard. A flat library (/music/track.flac read as an artist) would
 *    otherwise resolve to /music or even /, scattering artwork over the root.
 *    Returning null sends the caller to central storage instead.
 */
export function deriveContainerDir(
    anchors: DescendantDirAnchor[],
    libraryRoots: string[],
): string | null {
    const roots = libraryRoots
        .map((root) => path.normalize(root).replace(/\/+$/, ''))
        .filter((root) => root.length > 0);

    const isStrictlyUnderRoot = (dir: string): boolean =>
        roots.some((root) => dir !== root && isPathUnder(dir, root));

    let containerDir: string | null = null;

    for (const anchor of anchors) {
        const childDir = commonDir(path.normalize(anchor.minDir), path.normalize(anchor.maxDir));
        if (!isStrictlyUnderRoot(childDir)) return null;

        // A child container occupies its own folder, so step up out of it —
        // unless doing so would leave the library, which means this layout
        // has no such folder level (a show stored without season folders).
        let candidate = childDir;
        if (anchor.depth >= 2) {
            const parent = path.dirname(childDir);
            if (parent !== childDir && isStrictlyUnderRoot(parent)) {
                candidate = parent;
            }
        }

        containerDir = containerDir === null ? candidate : commonDir(containerDir, candidate);
    }

    if (containerDir === null || !isStrictlyUnderRoot(containerDir)) return null;
    return containerDir;
}

/**
 * Resolve where an artwork file for this item should be written.
 *
 * Returns BOTH the final file path and the directory it resolved to. The
 * directory is what lets a caller decide the FILENAME after the fact — the
 * season/series collision rule (a season-folderless layout resolves both rows
 * to the same folder) can only be evaluated once the folder is known, and a
 * `fileNameOverride` parameter cannot express it because the filename would
 * have to be fixed before this function runs.
 *
 * The three resolution queries run exactly once regardless of the resolver.
 */
export async function resolveArtworkWritePath(
    sql: postgres.Sql,
    mediaItemId: string,
    defaultFileName: string,
    fileNameResolver?: (resolvedDir: string) => string,
): Promise<{ filePath: string; resolvedDir: string }> {
    const centralDir = artworkCentralDir(mediaItemId);

    const applyResolver = (filePath: string): { filePath: string; resolvedDir: string } => {
        const resolvedDir = path.dirname(filePath);
        if (!fileNameResolver) return { filePath, resolvedDir };
        return { filePath: path.join(resolvedDir, fileNameResolver(resolvedDir)), resolvedDir };
    };

    // Fast path — the item owns a file, so write next to it. Unchanged for
    // movies, episodes, tracks and extras.
    const files = await getFilesForMediaItem(sql, mediaItemId);
    const ownFilePath = files[0]?.file_path ?? null;
    if (ownFilePath) {
        const result = await resolveWritePath({
            mediaFilePath: ownFilePath,
            centralDir,
            fileName: defaultFileName,
        });
        return applyResolver(result.filePath);
    }

    // No own file. Container rows (artist, album, tv, season) never have one —
    // reach through to the descendants' files to locate the container's folder.
    const anchors = await findDescendantDirAnchors(sql, mediaItemId);
    const mediaDirPath =
        anchors.length > 0
            ? deriveContainerDir(
                  anchors,
                  (await getEnabledLibraryPaths(sql)).map((row) => row.path),
              )
            : null;

    if (!mediaDirPath) {
        // Nothing on disk represents this item: a discovery-only movie, a
        // LiveTV channel, a radio station, or a layout we can't safely derive a
        // folder from. "Alongside" is undefined here rather than violated, so
        // central is the only possible target — forcing it keeps a strict
        // 'alongside' deployment from turning every such upload into a 500.
        // Reads probe both locations, so the image still serves.
        const result = await resolveWritePath({
            mediaFilePath: null,
            centralDir,
            fileName: defaultFileName,
            strategyOverride: 'central',
        });
        return applyResolver(result.filePath);
    }

    const result = await resolveWritePath({
        mediaFilePath: null,
        mediaDirPath,
        centralDir,
        fileName: defaultFileName,
    });
    return applyResolver(result.filePath);
}

/**
 * The payload arrived intact and we are REFUSING it — an unsupported content type
 * or an oversized body. Distinct from a transport failure (404, DNS, timeout,
 * SSRF guard) because the two need opposite retry dispositions.
 *
 * Why this class exists: TMDB serves a meaningful number of title logos as SVG
 * (38 items in one prod library), and SVG is deliberately absent from
 * {@link ALLOWED_CONTENT_TYPES} — the image-proxy serve path excludes it too, as
 * an `<script>`-embedding XSS vector (image-proxy/service.ts:1178). Before this
 * split, that refusal surfaced as the generic `fetch-failed`, which
 * `provider-artwork-backfill.ts`'s `isRetryableSkip` treats as retryable, so 29
 * items ground through exponential backoff toward `maxAttempts: 30` — 145 failed
 * runs in 24h — re-deciding the same refusal every time (prod 2026-07-30).
 *
 * A refusal is a DECISION about a payload the provider will keep serving
 * identically, so it must be terminal. Lane A stages carry
 * `invalidatedBy: ['metadata.changed', 'identity.changed']`, which re-opens the
 * row if the provider ever swaps in a raster logo.
 */
export class UnsupportedImagePayloadError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnsupportedImagePayloadError';
    }
}

/**
 * Fetch and validate image data from a URL via ImageProxyService.
 *
 * Routing through ImageProxyService ensures:
 *  - SSRF guard (assertNotPrivateUrl + redirect re-validation)
 *  - Response caching (7-day disk cache, keyed by URL)
 *  - Consistent magic-byte content-type sniffing
 *
 * Throws {@link UnsupportedImagePayloadError} when the bytes arrived but are
 * unusable, and a plain `Error` when the fetch itself failed. Callers that retry
 * MUST distinguish the two — see the class doc.
 */
async function fetchFromUrl(
    sql: postgres.Sql,
    url: string,
): Promise<{ buffer: Buffer; contentType: string }> {
    const imageProxy = getImageProxyService(sql);
    const result = await imageProxy.fetchCustomUrl(url);

    if (!result) {
        throw new Error(`Failed to fetch image from URL: ${url}`);
    }

    const contentType = result.contentType.split(';')[0].trim().toLowerCase();

    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        throw new UnsupportedImagePayloadError(
            `Unsupported content type: ${contentType}. Allowed: ${[...ALLOWED_CONTENT_TYPES].join(', ')}`,
        );
    }

    if (result.buffer.length > MAX_FILE_SIZE) {
        throw new UnsupportedImagePayloadError(
            `Image exceeds maximum size of 20MB (got ${result.buffer.length} bytes)`,
        );
    }

    return { buffer: result.buffer, contentType };
}

/**
 * Store a custom artwork image for a media item.
 *
 * Writes the image to disk and upserts the media_artwork row.
 * Returns the file path and a serve URL for the stored image.
 */
export async function storeMediaImage(
    sql: postgres.Sql,
    mediaItemId: string,
    artworkType: ArtworkType,
    source: ImageSource,
    actor = 'admin',
): Promise<{ filePath: string; serveUrl: string; undoId?: string }> {
    let buffer: Buffer;
    let contentType: string;

    if (source.type === 'url') {
        const fetched = await fetchFromUrl(sql, source.url);
        buffer = fetched.buffer;
        contentType = fetched.contentType;
    } else {
        buffer = source.buffer;
        contentType = source.contentType.split(';')[0].trim().toLowerCase();

        if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
            throw new Error(
                `Unsupported content type: ${contentType}. Allowed: ${[...ALLOWED_CONTENT_TYPES].join(', ')}`,
            );
        }

        if (buffer.length > MAX_FILE_SIZE) {
            throw new Error(`Image exceeds maximum size of 20MB (got ${buffer.length} bytes)`);
        }
    }

    const ext = CONTENT_TYPE_TO_EXT[contentType];
    if (!ext) {
        throw new Error(`No file extension mapping for content type: ${contentType}`);
    }

    const fileName = `${artworkType}-${randomUUID()}${ext}`;
    const { filePath } = await resolveArtworkWritePath(sql, mediaItemId, fileName);
    await writeFileNoFollow(filePath, buffer);

    const serveUrl = `/api/image/custom/${mediaItemId}/${artworkType}`;

    let undoId: string | undefined;
    let commitMayHaveBeenSent = false;
    try {
        const persist = (tx: postgres.Sql) =>
            upsertLocalArtwork(tx, {
                mediaItemId,
                artworkType,
                filePath,
                localContentHash: createHash('sha256').update(buffer).digest('hex'),
                sourceTag: source.sourceTag ?? `admin:${source.type}`,
                provider:
                    source.provider ??
                    (source.type === 'url'
                        ? deriveImageProvider(source.url)
                        : deriveImageProvider(source.sourceTag ?? 'admin:file')),
                providerRef: source.providerRef ?? (source.type === 'url' ? source.url : filePath),
            });
        // Own the outer publication boundary so receipt/snapshot failures are
        // still definite rollbacks. Automatic artwork needs the same boundary.
        await withTx(sql, async (tx) => {
            if ((source.sourceTag ?? `admin:${source.type}`).startsWith('admin:')) {
                const recorded = await withArtworkChoice(
                    tx,
                    mediaItemId,
                    actor,
                    async (choiceTx) => {
                        if (!(await persist(choiceTx)))
                            throw new Error('Artwork could not be selected.');
                        return true;
                    },
                );
                undoId = recorded.undoId;
            } else if (!(await persist(tx))) throw new Error('Artwork could not be registered.');
            // postgres.js sends COMMIT only after this callback succeeds.
            commitMayHaveBeenSent = true;
        });
    } catch (err) {
        if (!commitMayHaveBeenSent) {
            await safeUnlink(filePath).catch((cleanupError: unknown) => {
                logger.warn('Could not remove unpublished artwork', {
                    mediaItemId,
                    filePath,
                    error: String(cleanupError),
                });
            });
        } else {
            // A rejected COMMIT acknowledgement cannot prove rollback. Retain
            // bytes which a committed candidate/receipt may already name.
            logger.warn(
                'Artwork publication failed with an uncertain commit outcome; retaining bytes',
                {
                    mediaItemId,
                    filePath,
                    error: String(err),
                },
            );
        }
        throw err;
    }

    logger.info('Stored custom artwork', {
        mediaItemId,
        artworkType,
        filePath,
        size: buffer.length,
    });

    // Purge the in-process image caches so the just-uploaded image is served
    // immediately instead of the prior inherited/empty result lingering for the
    // L1 TTL. Without this the editor's ?v= bust defeats the browser cache but
    // the server keeps returning the stale image for up to a few minutes.
    getImageProxyService().invalidateCatalogImage(mediaItemId);

    return { filePath, serveUrl, undoId };
}

/** Hide this item's artwork slot while retaining every candidate and file for Undo. */
export async function deleteMediaImage(
    sql: postgres.Sql,
    mediaItemId: string,
    artworkType: ArtworkType,
    actor = 'admin',
): Promise<boolean> {
    const candidate = await getSelectedImageCandidate(sql, mediaItemId, artworkType);
    if (!candidate) return false;
    await mutateImageCandidates(
        sql,
        mediaItemId,
        { action: 'hide', candidateId: candidate.id },
        actor,
    );
    return true;
}

/**
 * Why a materialization attempt did not produce a file. Every value is a normal,
 * expected outcome — none of them fail the enclosing run.
 */
export type MaterializeSkipReason =
    /** sourceTag started with 'admin:' — rejected, never fetched. */
    | 'admin-source-tag'
    /** sourceTag did not start with 'provider:' — rejected, never fetched. */
    | 'bad-source-tag'
    /** (mediaItemId, artworkType) tombstoned — rejected, never fetched. */
    | 'suppressed'
    /** getOwnLocalArtwork returned a row — never overwrite what is on disk. */
    | 'already-local'
    /** fetchFromUrl threw a TRANSPORT error (404, SSRF guard, DNS, timeout). */
    | 'fetch-failed'
    /**
     * The bytes arrived and were refused: content type outside
     * ALLOWED_CONTENT_TYPES (TMDB's SVG logos) or body over MAX_FILE_SIZE.
     * TERMINAL — see {@link UnsupportedImagePayloadError}.
     */
    | 'unsupported-content-type'
    /** CONTENT_TYPE_TO_EXT had no mapping. */
    | 'no-extension'
    /** resolveWritePath threw (strict 'alongside' on a read-only mount). */
    | 'write-path-failed'
    /** safeWriteFile / safeRename / the DB registration threw. */
    | 'write-failed'
    /** upsertLocalArtwork returned false (file-path tombstone); temp file unlinked. */
    | 'register-skipped';

export interface MaterializeProviderArtworkResult {
    materialized: boolean;
    /** Present iff materialized === false. */
    reason?: MaterializeSkipReason;
    /** Present iff materialized === true. */
    filePath?: string;
}

/** Called once the target DIRECTORY is known, before the final filename is chosen. */
export type ArtworkFileNameResolver = (resolvedDir: string, ext: string) => string;

/**
 * Materialize a provider's artwork URL into a durable local file + media_artwork row.
 *
 * The single seam every provider-driven caller uses. Differs from
 * {@link storeMediaImage} — the admin-upload path — in five ways, each of which
 * prevents a specific failure:
 *
 *  1. The sourceTag MUST carry the 'provider:' prefix. Provenance must distinguish provider output from manual uploads. An 'admin:*' tag is rejected
 *     outright — `upsertLocalArtwork` treats those as tombstone-CLEARING overrides
 *     (media-artwork.queries.ts:85,90), so a backfill using one would resurrect
 *     admin-removed artwork on every sweep.
 *  2. Suppression is checked by (item, type) BEFORE fetching. upsertLocalArtwork's
 *     own guard is keyed on file_path (:109-114), so a tombstone on folder.jpg
 *     does not stop a write to poster.jpg.
 *  3. upsertLocalArtwork's boolean return is HONORED. storeMediaImage discards it
 *     (:311), so a suppressed write leaves orphan bytes on disk with no row
 *     referencing them.
 *  4. An item that already owns local artwork for the type is skipped outright.
 *  5. It never throws. Per-item isolation: one unreadable mount or one 404 must
 *     not fail a multi-hour drain.
 */
export async function materializeProviderArtwork(
    sql: postgres.Sql,
    mediaItemId: string,
    artworkType: ArtworkType,
    url: string,
    sourceTag: string,
    fileNameResolver?: ArtworkFileNameResolver,
): Promise<MaterializeProviderArtworkResult> {
    // Policy 1 — provenance. Checked first: it costs nothing and an admin tag is
    // actively destructive.
    if (sourceTag.startsWith('admin:')) {
        return { materialized: false, reason: 'admin-source-tag' };
    }
    if (!sourceTag.startsWith('provider:')) {
        return { materialized: false, reason: 'bad-source-tag' };
    }

    // Policy 2 — durable Remove, by (item, type), before any bandwidth is spent.
    if (await hasArtworkSuppressionForType(sql, mediaItemId, artworkType)) {
        return { materialized: false, reason: 'suppressed' };
    }

    // Policy 4 — never overwrite what is already on disk for this item.
    if (await getOwnLocalArtwork(sql, mediaItemId, artworkType)) {
        return { materialized: false, reason: 'already-local' };
    }

    let buffer: Buffer;
    let contentType: string;
    try {
        const fetched = await fetchFromUrl(sql, url);
        buffer = fetched.buffer;
        contentType = fetched.contentType;
    } catch (err) {
        // A refused payload is a terminal decision, not a retryable failure.
        // Collapsing both into 'fetch-failed' made every SVG logo retry to the
        // attempt cap — see UnsupportedImagePayloadError.
        if (err instanceof UnsupportedImagePayloadError) {
            logger.debug('Provider artwork payload refused', {
                mediaItemId,
                artworkType,
                url,
                error: err.message,
            });
            return { materialized: false, reason: 'unsupported-content-type' };
        }
        logger.debug('Provider artwork fetch failed', {
            mediaItemId,
            artworkType,
            error: err instanceof Error ? err.message : String(err),
        });
        return { materialized: false, reason: 'fetch-failed' };
    }

    const ext = CONTENT_TYPE_TO_EXT[contentType];
    if (!ext) {
        return { materialized: false, reason: 'no-extension' };
    }

    // Distinct upstream references must never share a cache file: a retained
    // upload/provider candidate may still point at the conventional sidecar name.
    const referenceHash = createHash('sha256').update(url).digest('hex').slice(0, 16);
    let filePath: string;
    try {
        const resolved = await resolveArtworkWritePath(
            sql,
            mediaItemId,
            `${artworkType}-${referenceHash}${ext}`,
            fileNameResolver
                ? (dir) => {
                      const original = path.parse(fileNameResolver(dir, ext));
                      const suffix = `-${referenceHash}${original.ext}`;
                      return `${fitStem(original.name, suffix)}${suffix}`;
                  }
                : undefined,
        );
        filePath = resolved.filePath;
    } catch (err) {
        // Strict 'alongside' on a read-only mount throws in resolveWritePath
        // (metadata-storage.service.ts:132-136). Skip the item, keep the run alive —
        // health-invariants/metadata-storage-writability.ts already surfaces the
        // underlying misconfiguration.
        logger.debug('Provider artwork write path unresolvable', {
            mediaItemId,
            artworkType,
            error: err instanceof Error ? err.message : String(err),
        });
        return { materialized: false, reason: 'write-path-failed' };
    }

    // Temp sibling in the SAME directory: fs.rename cannot cross a filesystem, and
    // under 'alongside-prefer' the resolved directory may be an NFS mount while any
    // /tmp default is not.
    const tempPath = `${filePath}.lumastra-tmp-${randomUUID()}`;

    const cleanupTemp = async (): Promise<void> => {
        try {
            await safeUnlink(tempPath);
        } catch {
            // Best-effort. A stray .lumastra-tmp-* sibling is inert.
        }
    };

    try {
        await safeWriteFile(tempPath, buffer);
    } catch (err) {
        await cleanupTemp();
        logger.warn('Provider artwork temp write failed', {
            mediaItemId,
            artworkType,
            tempPath,
            error: err instanceof Error ? err.message : String(err),
        });
        return { materialized: false, reason: 'write-failed' };
    }

    // Strict ordering: clear a stale provider CDN URL BEFORE the upsert, because
    // upsertLocalArtwork claims custom_<type>_url only when it is NULL. NOT in one
    // transaction with it — we hold the pool handle and upsertLocalArtwork opens
    // its own withTx, so wrapping the pair would pin a pooled connection across a
    // CDN fetch and a filesystem write for thousands of items. A crash between the
    // two leaves the column NULL with no row, which the reaper sweeps.
    const urlColumn = ARTWORK_TYPE_TO_COLUMN[artworkType];
    if (urlColumn) {
        try {
            await clearProviderCdnCustomImageUrl(sql, mediaItemId, urlColumn);
        } catch (err) {
            await cleanupTemp();
            logger.warn('Provider artwork custom-url clear failed', {
                mediaItemId,
                artworkType,
                error: err instanceof Error ? err.message : String(err),
            });
            return { materialized: false, reason: 'write-failed' };
        }
    }

    let registered: boolean;
    try {
        registered = await upsertLocalArtwork(sql, {
            mediaItemId,
            artworkType,
            filePath,
            localContentHash: createHash('sha256').update(buffer).digest('hex'),
            sourceTag,
            provider:
                deriveImageProvider(sourceTag) !== 'unknown'
                    ? deriveImageProvider(sourceTag)
                    : deriveImageProvider(url),
            providerRef: url,
        });
    } catch (err) {
        await cleanupTemp();
        logger.warn('Provider artwork registration failed', {
            mediaItemId,
            artworkType,
            error: err instanceof Error ? err.message : String(err),
        });
        return { materialized: false, reason: 'write-failed' };
    }

    if (!registered) {
        // The exact file path is tombstoned. storeMediaImage would have left the
        // bytes on disk here to preserve an ambiguously committed publication —
        // orphan files accumulating on every sweep. The final path was never
        // created, so removing the temp leaves nothing behind.
        await cleanupTemp();
        return { materialized: false, reason: 'register-skipped' };
    }

    try {
        await safeRename(tempPath, filePath);
    } catch (err) {
        await cleanupTemp();
        logger.warn('Provider artwork rename failed', {
            mediaItemId,
            artworkType,
            filePath,
            error: err instanceof Error ? err.message : String(err),
        });
        return { materialized: false, reason: 'write-failed' };
    }

    // Best-effort: a stale placeholder colour is cosmetic, and the file is
    // already in place — never turn this into a materialization failure.
    try {
        await clearArtworkBlurhash(sql, mediaItemId, artworkType);
    } catch (err) {
        logger.debug('Blurhash invalidation failed', {
            mediaItemId,
            artworkType,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    logger.info('Materialized provider artwork', {
        mediaItemId,
        artworkType,
        filePath,
        sourceTag,
        size: buffer.length,
    });

    // Mirrors storeMediaImage:338 — purge the in-process image caches so the new
    // file is served immediately instead of the prior inherited/empty result
    // lingering for the L1 TTL.
    getImageProxyService().invalidateCatalogImage(mediaItemId);

    return { materialized: true, filePath };
}

/**
 * Build the filename resolver a SEASON's materialization must pass so it cannot
 * collide with its series' artwork.
 *
 * `deriveContainerDir` resolves a season and its series to the SAME folder in a
 * season-folderless layout (`Show/S01E01.mkv`): the episodes sit at depth 1, so
 * the season gets no step-up and lands on `Show/`; the series' step-up target is
 * the library root, which fails `isStrictlyUnderRoot`, so its candidate also stays
 * `Show/`. Both would write `poster.jpg`.
 *
 * The season takes `season01-poster.jpg` instead — the Sonarr/Kodi/Jellyfin
 * convention, so the file round-trips through the flat-convention reader and a
 * co-installed Jellyfin on the same library reads it correctly.
 *
 * The series directory is resolved ONCE here and captured, because the resolver
 * itself runs synchronously inside `resolveArtworkWritePath`.
 */
export async function buildSeasonArtworkFileNameResolver(
    sql: postgres.Sql,
    seriesMediaItemId: string,
    seasonNumber: number,
    artworkType: MaterializableArtworkType,
): Promise<ArtworkFileNameResolver> {
    let seriesDir: string | null = null;
    try {
        // The extension is irrelevant here — only the DIRECTORY is read.
        const resolved = await resolveArtworkWritePath(
            sql,
            seriesMediaItemId,
            `${artworkType}.jpg`,
        );
        seriesDir = resolved.resolvedDir;
    } catch {
        // The series' own write path is unresolvable (read-only strict
        // alongside, no library root). We cannot RULE OUT a collision, so
        // qualify unconditionally: a season-qualified filename in a season
        // folder is merely verbose, whereas a plain `poster.jpg` that turns out
        // to share the series' folder silently clobbers the series poster.
        seriesDir = null;
    }

    return (resolvedDir: string, ext: string): string =>
        seriesDir === null || resolvedDir === seriesDir
            ? seasonArtworkFileName(artworkType, seasonNumber, ext)
            : `${artworkType}${ext}`;
}
