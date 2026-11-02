// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import path from 'node:path';
import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';
import {
    safeStat,
    safeReaddir,
    safeMkdir,
    safeWriteFile,
    safeRename,
    safeUnlink,
} from '$lib/server/utils/safe-fs.js';
import {
    walkArtwork,
    albumPosterCandidates,
    type ArtworkEntry,
} from '$lib/server/utils/walk-directory.js';
import {
    ARTWORK_EXTENSIONS,
    artworkTypeFromStem,
    pickFallbackAlbumPosterImageName,
} from '$lib/server/utils/media-extras.js';
import { resolveAlbumDir, albumCoverMetadataPath } from '$lib/server/utils/music-scanner-utils.js';
import { findTracksUnderDir } from '$lib/server/database/queries/album-art.queries.js';
import {
    getOwnLocalArtwork,
    getLocalArtwork,
    deleteArtworkById,
    upsertLocalArtwork,
    lockArtworkOwners,
} from '$lib/server/database/queries/media-artwork.queries.js';
import {
    getLocalAlbumTracks,
    persistAlbumReleaseIdentifiers,
    findLocalAlbumArtCandidates,
    markLocalAlbumArtChecked,
} from '$lib/server/database/queries/album-local-art.queries.js';
import { parseAudioTags } from '$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/audio-tag-parser.js';
import { markAlbumProcessed } from '$lib/server/database/queries/album-enrichment.queries.js';
import { upsertCompletedRow } from '$lib/server/database/queries/stage-state.queries.js';
interface ArtworkContext {
    logger: Pick<TaskContext['logger'], 'debug' | 'info' | 'warn'>;
}

const MIME_TO_EXT: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
};

/**
 * Returns true if the media item already has a usable poster OF ITS OWN.
 *
 * A DB row on its own is not enough — if the file on disk has been renamed or
 * removed (common when a folder is re-encoded/renamed), the row is stale and
 * must be cleared so the scanner can re-extract art from the new location.
 *
 * Own rows only: an album must not count its ARTIST's image as its cover.
 * With the inheriting lookup, every poster-less album under an artist with an
 * image was "covered", so its cover.jpg was never registered while the scan
 * triage re-processed its tracks on every run (992 albums after the
 * 2026-10-01 wrong-cover repair). Ancestor rows are never touched here, so a
 * track still falls back to its album's poster when serving.
 */
export async function hasValidOwnPoster(
    sql: postgres.Sql,
    mediaItemId: string,
    context: ArtworkContext,
): Promise<boolean> {
    const existing = await getOwnLocalArtwork(sql, mediaItemId, 'poster');
    if (!existing) return false;
    if (!existing.file_path) {
        await deleteArtworkById(sql, existing.id);
        return false;
    }
    try {
        const stat = await safeStat(existing.file_path);
        if (stat.isFile() && stat.size > 0) return true;
        throw Object.assign(new Error('Artwork is empty or not a file'), { code: 'ENOENT' });
    } catch (err) {
        const code =
            err && typeof err === 'object' && 'code' in err
                ? String((err as { code?: unknown }).code)
                : undefined;
        // ESTALE = NFS handle to a deleted file; treat like ENOENT so the row
        // doesn't stick forever after the media backend rotates files.
        if (code !== 'ENOENT' && code !== 'ESTALE') {
            context.logger.warn('[FileScanner] Could not stat local artwork — preserving row', {
                mediaItemId,
                filePath: existing.file_path,
                errorCode: code,
            });
            return true;
        }
        try {
            await deleteArtworkById(sql, existing.id);
        } catch (deleteErr) {
            // Transient DB failure — preserve row and retry next scan rather
            // than aborting the whole track scan over a cleanup operation.
            context.logger.warn(
                '[FileScanner] Failed to delete stale local artwork row — preserving until next scan',
                {
                    mediaItemId,
                    artworkId: existing.id,
                    error: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
                },
            );
            return true;
        }
        context.logger.info('[FileScanner] Removed stale local artwork row (file missing)', {
            mediaItemId,
            stalePath: existing.file_path,
            errorCode: code,
        });
        return false;
    }
}

/**
 * Provenance marker written to media_items.custom_metadata.cover_art_source
 * so the admin UI (and future scan logic) can tell where the album cover
 * originated and decide when a better source should override it.
 */
type CoverArtSource =
    | { type: 'embedded'; track_id: string }
    | { type: 'track-poster'; track_id: string }
    | { type: 'folder' }
    | { type: 'cover-art-archive'; mbid?: string };

export function isPathUnder(childPath: string, parentDir: string): boolean {
    const rel = path.relative(parentDir, childPath);
    return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Detect whether a track folder is shared across multiple albums — e.g. a
 * "Various Artists" directory where every file at the top level belongs to
 * a different album. Writing `cover.jpg` into such a folder stomps on
 * siblings, so these albums get routed to per-album metadata storage.
 *
 * Disc subfolders (`CD1/`, `Disc 2/`) collapse to their parent album — we
 * resolve each track's album dir and only count those whose resolved dir
 * matches the target exactly.
 */
export async function isSharedAlbumDir(sql: postgres.Sql, albumDir: string): Promise<boolean> {
    const prefix = albumDir.endsWith(path.sep) ? albumDir : albumDir + path.sep;
    const rows = await findTracksUnderDir(sql, prefix);
    const albums = new Set<string>();
    for (const row of rows) {
        if (!row.album_id) continue;
        const { albumDir: resolved } = resolveAlbumDir(row.file_path);
        if (resolved === albumDir) {
            albums.add(row.album_id);
            // Early exit — caller only cares whether count > 1.
            if (albums.size > 1) return true;
        }
    }
    return false;
}

async function setAlbumCoverArtSource(
    sql: postgres.Sql,
    albumId: string,
    source: CoverArtSource,
): Promise<void> {
    await sql`
        UPDATE media_items
        SET custom_metadata = custom_metadata || ${sql.json({ cover_art_source: source })}
        WHERE id = ${albumId}
    `;
}

/**
 * Atomic write: write to a sibling `.tmp` and rename into place.
 * Prevents the image proxy serving a half-written file while the scanner
 * is overwriting cover art.
 */
async function writeFileAtomic(targetPath: string, data: Buffer): Promise<void> {
    const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
    await safeMkdir(path.dirname(targetPath), { recursive: true });
    try {
        await safeWriteFile(tmp, data);
        await safeRename(tmp, targetPath);
    } catch (err) {
        // Best-effort cleanup — don't mask the original error.
        await safeUnlink(tmp).catch(() => {});
        throw err;
    }
}

async function findSingleDirectAlbumImage(
    albumDir: string,
    context: ArtworkContext,
): Promise<ArtworkEntry | undefined> {
    try {
        const entries = await safeReaddir(albumDir);
        const directImages = [];
        for (const entry of entries) {
            if (
                entry.isFile() &&
                ARTWORK_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
                (await usableImageFile(path.join(albumDir, entry.name)))
            )
                directImages.push(entry);
        }
        const directPosters = directImages.filter((entry) => {
            const ext = path.extname(entry.name);
            return artworkTypeFromStem(path.basename(entry.name, ext)) === 'poster';
        });
        const fallbackPosterName =
            directPosters.length === 0
                ? pickFallbackAlbumPosterImageName(directImages.map((entry) => entry.name))
                : null;
        const picked =
            directPosters.length === 1
                ? directPosters[0]
                : fallbackPosterName
                  ? directImages.find((entry) => entry.name === fallbackPosterName)
                  : undefined;
        if (!picked) return undefined;
        return {
            filePath: path.join(albumDir, picked.name),
            artworkType: 'poster',
        };
    } catch (err) {
        context.logger.debug('[FileScanner] Direct album artwork lookup skipped', {
            albumDir,
            error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
    }
}

/** Prefer usable direct posters, then nested album art, then a named fallback image. */
export async function findAlbumFolderPoster(
    albumDir: string,
    entries: ArtworkEntry[],
    context: ArtworkContext,
): Promise<ArtworkEntry | undefined> {
    const posters = albumPosterCandidates(entries);
    const ordered = [
        ...posters.filter((entry) => path.dirname(entry.filePath) === albumDir),
        ...posters.filter((entry) => path.dirname(entry.filePath) !== albumDir),
    ];
    for (const poster of ordered) if (await usableImageFile(poster.filePath)) return poster;
    return findSingleDirectAlbumImage(albumDir, context);
}

/**
 * Persist album cover art if the album doesn't already have one,
 * or heal a misattributed cover that's leaked in from a now-shared folder.
 *
 * Priority:
 *   1) embedded art from audio tags (track-attributed, also upserted on the track)
 *   2) folder images — ONLY when albumDir is not shared across multiple albums
 *
 * Write target:
 *   - Dedicated writable folder: `{albumDir}/cover.{ext}` (historical behaviour, user-visible)
 *   - Read-only dedicated folder: `{BASE}/metadata/music/album-covers/{albumId}.{ext}`
 *   - Shared folder or CAA-sourced: `{BASE}/metadata/music/album-covers/{albumId}.{ext}`
 */
export async function persistAlbumArt(
    sql: postgres.Sql,
    albumId: string,
    albumDir: string,
    embeddedArt: { format: string; data: Buffer } | undefined,
    context: ArtworkContext,
    options: {
        sourceTrackId?: string;
        caaMbid?: string;
        /**
         * Callers that have already run `walkArtwork(albumDir)` can pass the
         * result to avoid a second readdir in the folder-fallback branch.
         */
        precomputedArtworkEntries?: ArtworkEntry[];
    } = {},
): Promise<void> {
    // Empty/corrupt buffer — treat as absent so callers don't have to filter.
    if (embeddedArt && embeddedArt.data.length === 0) {
        context.logger.debug('[FileScanner] Discarding zero-byte embedded art', { albumId });
        embeddedArt = undefined;
    }

    // Unknown MIME means the bytes aren't one of the image formats the proxy
    // can reliably serve; fall through to folder/CAA rather than write a file
    // whose extension disagrees with its content.
    if (embeddedArt && !(embeddedArt.format in MIME_TO_EXT)) {
        context.logger.debug('[FileScanner] Unsupported embedded image MIME — skipping', {
            albumId,
            format: embeddedArt.format,
        });
        embeddedArt = undefined;
    }

    const shared = await isSharedAlbumDir(sql, albumDir).catch((err) => {
        context.logger.warn('[FileScanner] Shared-folder detection failed; refusing folder art', {
            albumDir,
            error: err instanceof Error ? err.message : String(err),
        });
        return true;
    });

    const hasValid = await hasValidOwnPoster(sql, albumId, context);

    // Heal path — existing row points directly into a now-shared folder;
    // replace when we have a track-attributed embedded picture to anchor
    // this album specifically. `path.dirname(...) === albumDir` guards
    // against healing legitimate nested artwork (e.g. scans/booklet.jpg).
    if (hasValid) {
        if (!shared || !embeddedArt || !options.sourceTrackId) return;
        const existing = await getLocalArtwork(sql, albumId, 'poster');
        if (
            !existing ||
            existing.media_item_id !== albumId ||
            !existing.file_path ||
            !isPathUnder(existing.file_path, albumDir) ||
            path.dirname(existing.file_path) !== albumDir
        ) {
            return;
        }
        context.logger.info(
            '[FileScanner] Healing album cover — existing path is inside now-shared folder',
            { albumId, stalePath: existing.file_path },
        );
        // Fall through to write a fresh per-album metadata copy.
    }

    let artFilePath: string | null = null;
    let source: CoverArtSource | null = null;

    if (embeddedArt) {
        const ext = MIME_TO_EXT[embeddedArt.format];
        // CAA fetches aren't tied to a track — always park them under the
        // per-album metadata dir (not the user's music folder) so an OSS
        // deploy doesn't litter the library with auto-downloaded covers.
        const writeToMetadata = shared || !!options.caaMbid;
        const preferredArtFilePath = writeToMetadata
            ? albumCoverMetadataPath(albumId, ext)
            : path.join(albumDir, `cover${ext}`);
        artFilePath = preferredArtFilePath;
        try {
            await writeFileAtomic(artFilePath, embeddedArt.data);
            context.logger.debug('[FileScanner] Wrote embedded album art', {
                albumId,
                path: artFilePath,
                bytes: embeddedArt.data.length,
                target: writeToMetadata ? 'metadata' : 'alongside',
            });
        } catch (err) {
            context.logger.warn('[FileScanner] Failed to write embedded art', {
                albumId,
                path: artFilePath,
                error: err instanceof Error ? err.message : String(err),
            });
            const metadataArtFilePath = albumCoverMetadataPath(albumId, ext);
            if (metadataArtFilePath !== preferredArtFilePath) {
                try {
                    await writeFileAtomic(metadataArtFilePath, embeddedArt.data);
                    artFilePath = metadataArtFilePath;
                    context.logger.info(
                        '[FileScanner] Wrote embedded album art to metadata storage after alongside write failed',
                        {
                            albumId,
                            path: artFilePath,
                            bytes: embeddedArt.data.length,
                        },
                    );
                } catch (fallbackErr) {
                    context.logger.warn(
                        '[FileScanner] Failed to write embedded art to metadata storage',
                        {
                            albumId,
                            path: metadataArtFilePath,
                            error:
                                fallbackErr instanceof Error
                                    ? fallbackErr.message
                                    : String(fallbackErr),
                        },
                    );
                    artFilePath = null;
                }
            } else {
                artFilePath = null;
            }
        }
        if (artFilePath) {
            if (options.caaMbid) {
                source = { type: 'cover-art-archive', mbid: options.caaMbid };
            } else if (options.sourceTrackId) {
                source = { type: 'embedded', track_id: options.sourceTrackId };
            } else {
                // Contract violation — drop rather than persist an ambiguous
                // provenance (`track_id: ''`). All current callers pass one.
                context.logger.warn(
                    '[FileScanner] Embedded art persisted without sourceTrackId — discarding',
                    { albumId },
                );
                artFilePath = null;
                source = null;
            }
        }
    }

    // Folder fallback — only for dedicated folders. Images in shared folders
    // may belong to a sibling album, so refusing them is the safer default.
    if (!artFilePath && !shared) {
        const artworkEntries = options.precomputedArtworkEntries ?? (await walkArtwork(albumDir));
        // albumPosterCandidates excludes TV season-scoped images.
        const poster = await findAlbumFolderPoster(albumDir, artworkEntries, context);
        if (poster && (await usableImageFile(poster.filePath))) {
            artFilePath = poster.filePath;
            source = { type: 'folder' };
            context.logger.debug('[FileScanner] Found folder artwork', {
                albumId,
                path: path.basename(artFilePath),
            });
        }
    }

    if (!artFilePath || !source) return;

    // Transactional: album row, optional track row, and provenance marker
    // must all commit together — otherwise the UI shows a cover with a stale
    // or missing `cover_art_source`, or a track row without its album anchor.
    const trackIdToMirror = source.type === 'embedded' ? options.sourceTrackId : undefined;
    try {
        await withTx(sql, async (tx) => {
            await lockArtworkOwners(tx, trackIdToMirror ? [albumId, trackIdToMirror] : [albumId]);
            const registered = await upsertLocalArtwork(tx, {
                mediaItemId: albumId,
                artworkType: 'poster',
                filePath: artFilePath,
                provider: source.type === 'embedded' ? 'embedded' : 'local-folder',
                providerRef: source.type === 'embedded' ? source.track_id : artFilePath,
            });
            // If the album cover write was suppressed (admin removed this exact
            // cover file), skip the derived side-effects: don't mirror it to the
            // track and don't stamp cover_art_source, so custom_metadata never
            // claims a cover that has no media_artwork row.
            if (registered) {
                if (trackIdToMirror) {
                    await upsertLocalArtwork(tx, {
                        mediaItemId: trackIdToMirror,
                        artworkType: 'poster',
                        filePath: artFilePath,
                        provider: source.type === 'embedded' ? 'embedded' : 'local-folder',
                        providerRef: source.type === 'embedded' ? source.track_id : artFilePath,
                    });
                }
                await setAlbumCoverArtSource(tx, albumId, source);
            }
        });
        context.logger.info('[FileScanner] Set album cover art', {
            albumId,
            source: source.type,
            shared,
            path: path.basename(artFilePath),
        });
    } catch (err) {
        context.logger.warn('[FileScanner] Failed to persist album artwork transactionally', {
            albumId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

async function usableImageFile(filePath: string): Promise<boolean> {
    try {
        const stat = await safeStat(filePath);
        return stat.isFile() && stat.size > 0;
    } catch {
        return false;
    }
}

/** Recover from all linked tracks, without depending on network enrichment state. */
export async function recoverLocalAlbumArt(
    sql: postgres.Sql,
    albumId: string,
    logger: TaskContext['logger'],
    signal?: AbortSignal,
): Promise<boolean> {
    if (signal?.aborted) return false;
    const context = { logger };
    if (await hasValidOwnPoster(sql, albumId, context)) return true;
    const tracks = await getLocalAlbumTracks(sql, albumId);
    // Existing track artwork is already attributed to this album, even in a shared folder.
    for (const track of tracks) {
        if (signal?.aborted) return false;
        if (track.poster_path && (await usableImageFile(track.poster_path))) {
            if (
                await upsertLocalArtwork(sql, {
                    mediaItemId: albumId,
                    artworkType: 'poster',
                    filePath: track.poster_path,
                })
            ) {
                await setAlbumCoverArtSource(sql, albumId, {
                    type: 'track-poster',
                    track_id: track.track_id,
                });
                return true;
            }
        }
    }
    const dirs = new Set<string>();
    for (const track of tracks) {
        if (signal?.aborted) return false;
        if (!track.file_path) continue;
        const { albumDir } = resolveAlbumDir(track.file_path);
        if (dirs.has(albumDir)) continue;
        dirs.add(albumDir);
        await persistAlbumArt(sql, albumId, albumDir, undefined, context);
        if (await hasValidOwnPoster(sql, albumId, context)) return true;
    }
    // A missing/corrupt first track must not hide later embedded pictures or identifiers.
    for (const track of tracks) {
        if (signal?.aborted) return false;
        if (!track.file_path) continue;
        const tags = await parseAudioTags(track.file_path, { signal });
        if (signal?.aborted) return false;
        if (tags.parseError) continue;
        await persistAlbumReleaseIdentifiers(sql, albumId, tags);
        if (!tags.embeddedArt) continue;
        const { albumDir } = resolveAlbumDir(track.file_path);
        await persistAlbumArt(sql, albumId, albumDir, tags.embeddedArt, context, {
            sourceTrackId: track.track_id,
        });
        if (await hasValidOwnPoster(sql, albumId, context)) return true;
    }
    return false;
}

/**
 * Daily, oldest-checked-first local sweep. No stage eligibility or network guard:
 * no-match-upstream, no-image-bytes and ineligible rows all get a local attempt.
 * Durable check times let a budget-limited run resume at the untouched albums.
 */
export async function backfillLocalAlbumArt(
    sql: postgres.Sql,
    logger: TaskContext['logger'],
    signal: AbortSignal,
    processingVersion: number,
): Promise<number> {
    let recovered = 0;
    // Abort an in-flight tag read as well: one large album must not overrun the task watchdog.
    const localSignal = AbortSignal.any([signal, AbortSignal.timeout(5 * 60 * 1000)]);
    const deadline = Date.now() + 5 * 60 * 1000;
    while (!localSignal.aborted && Date.now() < deadline) {
        const candidates = await findLocalAlbumArtCandidates(sql, 50);
        if (!candidates.length) break;
        for (const album of candidates) {
            if (localSignal.aborted || Date.now() >= deadline) return recovered;
            try {
                if (
                    !(await hasValidOwnPoster(sql, album.id, { logger })) &&
                    (await recoverLocalAlbumArt(sql, album.id, logger, localSignal))
                ) {
                    if (localSignal.aborted) return recovered;
                    if (
                        !(await markAlbumProcessed(
                            sql as postgres.Sql<Record<string, never>>,
                            album.id,
                            processingVersion,
                            'success',
                        ))
                    )
                        throw new Error('Local cover marker write failed');
                    await upsertCompletedRow(sql, {
                        mediaItemId: album.id,
                        stageId: 'album-enrichment',
                        processingVersion,
                    });
                    recovered++;
                }
            } catch (err) {
                logger.warn('Local album artwork recovery failed', {
                    albumId: album.id,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            if (localSignal.aborted) return recovered;
            // Failed reads also get a daily cooldown, rather than hammering detached mounts.
            await markLocalAlbumArtChecked(sql, album.id);
        }
    }
    return recovered;
}
