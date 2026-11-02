// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Upload Session Service
 *
 * Handles staging-directory management, chunk writing, SHA-256 computation,
 * atomic rename to the final destination, and EXDEV (cross-device) fallback.
 *
 * All file I/O must happen in the worker container where /data is writable.
 * The app container mounts /data read-only — do not call these from app routes
 * directly; they are called from worker-resident task code (finalize route
 * proxies through the task queue for large files if needed, but for typical
 * sizes the finalize route itself runs in the worker process).
 */

import fs from 'node:fs';
import {
    mkdir,
    writeFile,
    rename,
    rm,
    readdir,
    open,
    readFile,
    copyFile,
    unlink,
    stat,
    realpath,
    link,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, dirname, extname, basename } from 'node:path';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import type postgres from 'postgres';
import {
    createUploadSession,
    incrementChunksReceived,
    claimUploadSessionForAssembly,
    finalizeUploadSession,
    abortUploadSession,
    releaseUploadSessionAssemblyClaim,
    deleteUploadSession,
    findExpiredUploadSessions,
    deleteExpiredUploadSession,
    uploadStagingLibraryRoots,
    hasUploadStagingSession,
    type UploadSessionRow,
    type CreateUploadSessionParams,
} from '$lib/server/database/queries/upload-sessions.queries.js';
import { resolveUnderRoot, realpathUnderRoot } from '$lib/server/utils/library-path-safety.js';
import { SUBTITLE_EXTENSIONS, MEDIA_EXTENSIONS } from '$lib/server/utils/walk-directory.js';

const logger = Logger.for('UploadSessionService');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Non-entertainment library types that accept uploads. */
export { UPLOADABLE_LIBRARY_TYPES } from '$lib/shared/uploadable-library-types.js';

/** Allowed MIME types for the primary video slot. */
export const ALLOWED_VIDEO_MIMES = new Set([
    'video/mp4',
    'video/x-matroska',
    'video/webm',
    'video/avi',
    'video/quicktime',
    'video/x-m4v',
    'video/x-msvideo',
    'video/mpeg',
    // What browsers report for the remaining MEDIA_EXTENSIONS (.wmv, .ts/.m2ts,
    // .ogv, .flv, .3gp) — the extension check below is the real gate; without
    // these the upload page accepted a file the init call then rejected.
    'video/x-ms-wmv',
    'video/mp2t',
    'video/vnd.dlna.mpeg-tts',
    'video/ogg',
    'video/x-flv',
    'video/3gpp',
    // Browsers send an empty type (the client maps that to octet-stream) for
    // extensions the OS has no MIME entry for, e.g. .mkv/.m2ts on many systems.
    'application/octet-stream',
]);

/** File extensions an attached resource may have (matches ALLOWED_RESOURCE_MIMES). */
export const ALLOWED_RESOURCE_EXTENSIONS = new Set(['.pdf', '.ppt', '.pptx', '.zip']);

/** Most filesystems cap one name component at 255 bytes. */
const MAX_FILENAME_BYTES = 255;

/** Configured chunk size in bytes — the only chunk size the server accepts. */
function chunkSizeBytes(): number {
    return config.UPLOAD_CHUNK_SIZE_MB * 1024 * 1024;
}

/**
 * Exact byte length chunk `index` must have for a file of `totalSize` bytes:
 * every chunk is full-size except the last, which holds the remainder.
 */
export function expectedChunkLength(totalSize: number, chunkBytes: number, index: number): number {
    return Math.min(chunkBytes, totalSize - index * chunkBytes);
}

/** Chunk files are `chunk-NNNNNN`; anything else in staging (`.part`, `_assembled`) is not one. */
const CHUNK_FILE_RE = /^chunk-\d{6}$/;

function httpError(message: string, statusCode: number): Error {
    return Object.assign(new Error(message), { statusCode });
}

async function pathExists(p: string): Promise<boolean> {
    try {
        await stat(p);
        return true;
    } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') return false;
        throw err;
    }
}

/** link() error codes meaning "this filesystem has no hard links" (CIFS, some FUSE mounts). */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

/**
 * Moves `src` to `dst` without ever replacing an existing `dst`.
 * Returns 'exists' (and leaves `src` alone) when `dst` is already there.
 *
 * rename() silently overwrites, so the primitive is link() + unlink(), which
 * fails atomically with EEXIST. Without hard-link support it falls back to an
 * existence check + rename (a narrow race, but no worse than before); across
 * devices (EXDEV) to an exclusive copy into a hidden temp name beside `dst`
 * that is then renamed, so a scanner never sees a half-copied file.
 */
export async function moveNoReplace(src: string, dst: string): Promise<'moved' | 'exists'> {
    try {
        await link(src, dst);
        await unlink(src);
        return 'moved';
    } catch (err) {
        const code = (err as { code?: string }).code ?? '';
        if (code === 'EEXIST') return 'exists';
        if (LINK_UNSUPPORTED.has(code)) {
            if (await pathExists(dst)) return 'exists';
            await rename(src, dst);
            return 'moved';
        }
        if (code !== 'EXDEV') throw err;
    }
    logger.info('EXDEV on link — falling back to exclusive copy', { from: src, to: dst });
    const tmp = join(dirname(dst), `.${basename(dst)}.${randomUUID()}.uploading`);
    try {
        await copyFile(src, tmp, fsConstants.COPYFILE_EXCL);
        if (await pathExists(dst)) return 'exists';
        await rename(tmp, dst);
    } finally {
        await unlink(tmp).catch(() => {});
    }
    await unlink(src);
    return 'moved';
}

/**
 * Resolves the destination directory for an upload and re-checks containment
 * after symlinks: a lexical check alone lets `destinationFolder` walk through a
 * symlink inside the library and land the file outside it.
 */
async function resolveDestinationDir(
    libraryRoot: string,
    destinationFolder: string,
): Promise<string> {
    const lexical = destinationFolder
        ? resolveUnderRoot(libraryRoot, destinationFolder)
        : libraryRoot;
    if (!lexical) {
        throw httpError(`destinationFolder escapes library root: ${destinationFolder}`, 400);
    }
    let realRoot: string;
    try {
        realRoot = await realpath(libraryRoot);
    } catch {
        realRoot = libraryRoot;
    }
    const realLexical =
        lexical === libraryRoot ? realRoot : join(realRoot, lexical.slice(libraryRoot.length + 1));
    const contained = await realpathUnderRoot(realRoot, realLexical);
    if (!contained) {
        throw httpError(`destinationFolder escapes library root: ${destinationFolder}`, 400);
    }
    return contained;
}

/** Allowed MIME types for attached resource files. */
export const ALLOWED_RESOURCE_MIMES = new Set([
    'application/pdf',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip',
]);

// ---------------------------------------------------------------------------
// Lumastraignore helper
// ---------------------------------------------------------------------------

/**
 * Ensures `.upload-staging` is listed in the library root's `.lumastraignore`.
 * The scanner walker does NOT skip dotdirs automatically; partial chunk files
 * would be ingested mid-upload without this guard.
 *
 * Idempotent — safe to call on every init request.
 */
export async function ensureUploadStagingIgnored(libraryRoot: string): Promise<void> {
    const ignoreFile = join(libraryRoot, '.lumastraignore');
    const entry = '.upload-staging';
    let contents = '';
    try {
        contents = fs.readFileSync(ignoreFile, 'utf8');
    } catch {
        // File doesn't exist yet — we'll create it.
    }
    const lines = contents.split('\n').map((l) => l.trim());
    if (lines.includes(entry)) return; // already present
    const newContents =
        (contents.endsWith('\n') || contents === '' ? contents : contents + '\n') + entry + '\n';
    await writeFile(ignoreFile, newContents, 'utf8');
}

// ---------------------------------------------------------------------------
// Staging dir resolution
// ---------------------------------------------------------------------------

/**
 * Returns the staging directory for a given upload session.
 *
 * If UPLOAD_STAGING_DIR is configured, the session directory lives there
 * (cross-device = EXDEV fallback on finalize). Otherwise the staging dir is
 * a sibling `.upload-staging/<uploadId>/` inside the library path root
 * (same filesystem → atomic rename).
 */
export function resolveStagingDir(libraryRoot: string, uploadId: string): string {
    const override = config.UPLOAD_STAGING_DIR;
    if (override) {
        return join(resolve(override), uploadId);
    }
    return join(libraryRoot, '.upload-staging', uploadId);
}

// ---------------------------------------------------------------------------
// Init upload
// ---------------------------------------------------------------------------

export interface InitUploadParams {
    sql: postgres.Sql;
    libraryPathId: string;
    libraryRoot: string;
    uploaderUser: string;
    filename: string;
    mimeType: string;
    totalSize: number;
    totalChunks: number;
    destinationFolder: string;
    sha256Expected?: string | null;
}

export interface InitUploadResult {
    uploadId: string;
    chunkSize: number;
    expiresAt: string;
}

/** Validates request, creates staging dir + DB row, returns session IDs. */
export async function initUpload(params: InitUploadParams): Promise<InitUploadResult> {
    const {
        sql,
        libraryPathId,
        libraryRoot,
        uploaderUser,
        filename,
        mimeType,
        totalSize,
        totalChunks,
        destinationFolder,
        sha256Expected,
    } = params;

    // Validate MIME type
    if (!ALLOWED_VIDEO_MIMES.has(mimeType)) {
        throw Object.assign(new Error(`Unsupported MIME type for primary video: ${mimeType}`), {
            statusCode: 400,
        });
    }

    // The stored name is basename()d at finalize; refuse up front a name the
    // filesystem would reject (ENAMETOOLONG) only after the whole file was sent.
    if (Buffer.byteLength(basename(filename), 'utf8') > MAX_FILENAME_BYTES) {
        throw httpError(`Filename is longer than ${MAX_FILENAME_BYTES} bytes`, 400);
    }

    // Validate file extension
    const ext = extname(filename).toLowerCase();
    if (!MEDIA_EXTENSIONS.has(ext)) {
        throw Object.assign(new Error(`Unsupported file extension for primary video: ${ext}`), {
            statusCode: 400,
        });
    }

    // Size limit
    const maxBytes = config.MAX_VIDEO_UPLOAD_GB * 1024 * 1024 * 1024;
    if (totalSize > maxBytes) {
        throw Object.assign(
            new Error(
                `File size ${totalSize} bytes exceeds limit of ${config.MAX_VIDEO_UPLOAD_GB} GB`,
            ),
            { statusCode: 400 },
        );
    }

    // The chunk count is the server's, derived from the declared size and the
    // configured chunk size — the client's `totalChunks` is advisory only.
    // Trusting it let a session declare totalSize=1 with thousands of chunks
    // (every chunk is length-checked against this layout in writeChunk), and a
    // client that guessed a different chunk size than UPLOAD_CHUNK_SIZE_MB got
    // its higher chunk indexes rejected mid-upload.
    const chunkBytes = chunkSizeBytes();
    const derivedTotalChunks = Math.ceil(totalSize / chunkBytes);
    if (totalChunks !== derivedTotalChunks) {
        logger.info('Client totalChunks differs from the server layout — using the server count', {
            clientTotalChunks: totalChunks,
            derivedTotalChunks,
        });
    }

    // destinationFolder safety: must be relative + contained, no dot segments
    // (`.upload-staging/<otherSession>` would land the file in a staging dir
    // that is deleted when that session ends), and no symlink escape.
    if (destinationFolder) {
        if (destinationFolder.split('/').some((seg) => seg.startsWith('.'))) {
            throw httpError(
                `destinationFolder must not contain hidden segments: ${destinationFolder}`,
                400,
            );
        }
    }
    const destDir = await resolveDestinationDir(libraryRoot, destinationFolder);

    // Refuse to start an upload that finalize would have to refuse anyway.
    if (await pathExists(join(destDir, basename(filename)))) {
        throw httpError(`A file named "${basename(filename)}" already exists in that folder`, 409);
    }

    const createParams: CreateUploadSessionParams = {
        library_path_id: libraryPathId,
        uploader_user: uploaderUser,
        filename,
        mime_type: mimeType,
        total_size: totalSize,
        total_chunks: derivedTotalChunks,
        destination_folder: destinationFolder,
        staging_dir: '', // will be set after we know the uploadId
        sha256_expected: sha256Expected ?? null,
    };

    // Create DB row first to get the uploadId
    const row = await createUploadSession(sql, createParams);
    const uploadId = row.id;

    // Derive staging dir now that we have the uploadId
    const stagingDir = resolveStagingDir(libraryRoot, uploadId);

    try {
        // Update staging_dir in DB
        await sql`
            UPDATE upload_sessions
            SET staging_dir = ${stagingDir}, updated_at = NOW()
            WHERE id = ${uploadId}
        `;

        // Create staging directory
        await mkdir(stagingDir, { recursive: true });
    } catch (err) {
        // A row left 'uploading' here would count against the per-user session
        // cap for 24h although no upload can ever use it.
        await deleteUploadSession(sql, uploadId).catch(() => {});
        throw err;
    }

    // Ensure .lumastraignore contains .upload-staging
    try {
        await ensureUploadStagingIgnored(libraryRoot);
    } catch (err) {
        logger.warn('Could not update .lumastraignore', {
            libraryRoot,
            reason: err instanceof Error ? err.message : String(err),
        });
    }

    logger.info('Upload session created', {
        uploadId,
        filename,
        totalSize,
        totalChunks: derivedTotalChunks,
    });

    return {
        uploadId,
        chunkSize: chunkBytes,
        expiresAt: row.expires_at.toISOString(),
    };
}

// ---------------------------------------------------------------------------
// Write chunk
// ---------------------------------------------------------------------------

/** Writes raw chunk bytes to `<stagingDir>/chunk-<NNN>`. */
export async function writeChunk(
    sql: postgres.Sql,
    session: UploadSessionRow,
    chunkIndex: number,
    data: Buffer,
): Promise<number> {
    if (session.status !== 'uploading') {
        throw Object.assign(new Error(`Upload session ${session.id} is not in uploading state`), {
            statusCode: 409,
        });
    }
    if (chunkIndex < 0 || chunkIndex >= session.total_chunks) {
        throw Object.assign(
            new Error(`Invalid chunk index ${chunkIndex} (total: ${session.total_chunks})`),
            { statusCode: 400 },
        );
    }

    // Every chunk but the last is exactly the configured size; the last holds
    // the remainder. Without this a session could write any amount of data
    // regardless of the declared (and size-capped) total, and a truncated
    // chunk would assemble into a corrupt video.
    const expectedLength = expectedChunkLength(
        Number(session.total_size),
        chunkSizeBytes(),
        chunkIndex,
    );
    if (data.length !== expectedLength) {
        throw httpError(
            `Chunk ${chunkIndex} has ${data.length} bytes, expected ${expectedLength}`,
            400,
        );
    }

    const chunkName = `chunk-${String(chunkIndex).padStart(6, '0')}`;
    const chunkPath = join(session.staging_dir, chunkName);

    // Write to a private temp file, then link it into place. The link fails
    // with EEXIST when the chunk already exists (a client retry), so the
    // counter is only incremented once per chunk; and a write that dies
    // midway (ENOSPC, dropped connection) leaves only a `.part` file that
    // finalize ignores — never a truncated `chunk-N` that a retry would then
    // mistake for a completed duplicate.
    const partPath = `${chunkPath}.${randomUUID()}.part`;
    let isNewChunk = true;
    try {
        const fd = await open(partPath, 'wx');
        try {
            await fd.write(data);
        } finally {
            await fd.close();
        }
        if ((await moveNoReplace(partPath, chunkPath)) === 'exists') {
            isNewChunk = false;
            logger.info('Duplicate chunk — skipping counter increment', {
                uploadId: session.id,
                chunkIndex,
            });
        }
    } finally {
        await unlink(partPath).catch(() => {});
    }

    if (!isNewChunk) {
        // Return the current counter without touching the DB.
        return session.chunks_received;
    }

    const newCount = await incrementChunksReceived(sql, session.id);
    if (newCount === null) {
        throw Object.assign(
            new Error('Failed to increment chunk counter — session may have been aborted'),
            { statusCode: 409 },
        );
    }
    return newCount;
}

// ---------------------------------------------------------------------------
// Finalize (assemble + rename)
// ---------------------------------------------------------------------------

export interface FinalizeUploadParams {
    sql: postgres.Sql;
    session: UploadSessionRow;
    libraryRoot: string;
    expectedTotalChunks: number;
    clientSha256?: string | null;
}

export interface FinalizeResult {
    finalPath: string;
    sha256: string;
}

/**
 * Assembles chunks into the final destination file, verifies integrity,
 * and atomically renames (or stream-copies on EXDEV) into place.
 */
export async function finalizeUpload(params: FinalizeUploadParams): Promise<FinalizeResult> {
    const { sql, session, libraryRoot, expectedTotalChunks, clientSha256 } = params;

    if (session.status !== 'uploading') {
        throw Object.assign(
            new Error(
                `Session ${session.id} is not in uploading state (current: ${session.status})`,
            ),
            { statusCode: 409 },
        );
    }

    // The session's own chunk count is authoritative: the client's
    // expectation is only cross-checked. Comparing the files on disk with the
    // client's number alone let init(10) + 3 chunks + finalize(3) assemble a
    // truncated file into the library.
    if (expectedTotalChunks !== session.total_chunks) {
        throw httpError(
            `Expected ${session.total_chunks} chunks for this upload, client reported ${expectedTotalChunks}`,
            422,
        );
    }
    const files = await readdir(session.staging_dir);
    const chunkFiles = files.filter((f) => CHUNK_FILE_RE.test(f)).sort();
    if (chunkFiles.length !== session.total_chunks) {
        throw Object.assign(
            new Error(
                `Expected ${expectedTotalChunks} chunks but found ${chunkFiles.length} in staging`,
            ),
            { statusCode: 422 },
        );
    }

    // Atomic CAS: only one concurrent finalize call wins the 'uploading' → 'assembling'
    // transition.  A second concurrent call will see 0 rows (the first already flipped
    // the status) and must back off with a 409 rather than proceeding with assembly.
    const claimed = await claimUploadSessionForAssembly(sql, session.id);
    if (!claimed) {
        throw Object.assign(
            new Error(`Session ${session.id} is already being finalized or has been finalized`),
            { statusCode: 409 },
        );
    }

    const assembledPath = join(session.staging_dir, '_assembled');
    try {
        return await assembleAndPlace(
            sql,
            session,
            libraryRoot,
            chunkFiles,
            assembledPath,
            clientSha256,
        );
    } catch (err) {
        // Hand the session back so the client can retry (or abort) instead of
        // being stuck behind a permanent 409 while the session keeps counting
        // against the per-user cap.
        await rm(assembledPath, { force: true }).catch(() => {});
        await releaseUploadSessionAssemblyClaim(
            sql,
            session.id,
            err instanceof Error ? err.message : String(err),
        ).catch(() => {});
        throw err;
    }
}

async function assembleAndPlace(
    sql: postgres.Sql,
    session: UploadSessionRow,
    libraryRoot: string,
    chunkFiles: string[],
    assembledPath: string,
    clientSha256: string | null | undefined,
): Promise<FinalizeResult> {
    // Build final path. The containment check runs again after mkdir so a
    // symlink created since init cannot redirect the file.
    const lexicalDest = await resolveDestinationDir(libraryRoot, session.destination_folder);
    await mkdir(lexicalDest, { recursive: true });
    const destFolder = await resolveDestinationDir(libraryRoot, session.destination_folder);

    // SECURITY: basename() strips any path components an attacker may have
    // embedded in the stored filename (e.g. "../../evil.mp4"). The extension
    // was validated at init time, but the component check is defense-in-depth.
    const safeFilename = basename(session.filename);
    const finalPath = join(destFolder, safeFilename);

    // Never replace an existing library file: an upload with the same name
    // (a re-encode, or two sessions racing) used to silently destroy it.
    if (await pathExists(finalPath)) {
        throw httpError(`A file named "${safeFilename}" already exists in that folder`, 409);
    }

    // Stream-assemble all chunks into one file in staging first.
    // Use async readFile (not fs.readFileSync) to avoid blocking the event loop
    // for the duration of assembly (up to 10 000 × 5 MB reads for a 50 GB file).
    const hash = createHash('sha256');
    const outFd = await open(assembledPath, 'w');
    try {
        for (const chunkFile of chunkFiles) {
            const chunkPath = join(session.staging_dir, chunkFile);
            const chunkBuf = await readFile(chunkPath);
            hash.update(chunkBuf);
            await outFd.write(chunkBuf);
        }
    } finally {
        await outFd.close();
    }

    const sha256Actual = hash.digest('hex');

    const assembledSize = (await stat(assembledPath)).size;
    if (assembledSize !== Number(session.total_size)) {
        throw httpError(
            `Assembled file has ${assembledSize} bytes, expected ${session.total_size}`,
            422,
        );
    }

    // Verify client hash if supplied
    if (clientSha256 && clientSha256.toLowerCase() !== sha256Actual) {
        await rm(assembledPath, { force: true });
        throw Object.assign(
            new Error(`SHA-256 mismatch: expected ${clientSha256}, got ${sha256Actual}`),
            { statusCode: 422 },
        );
    }

    // Move into place without ever replacing an existing file (closes the
    // race between the existence check above and here).
    if ((await moveNoReplace(assembledPath, finalPath)) === 'exists') {
        throw httpError(`A file named "${safeFilename}" already exists in that folder`, 409);
    }

    // Update DB row
    await finalizeUploadSession(sql, session.id, sha256Actual, null, finalPath);

    // Clean up staging directory (best-effort)
    try {
        await rm(session.staging_dir, { recursive: true, force: true });
    } catch (err) {
        logger.warn('Failed to clean staging dir after finalize', {
            stagingDir: session.staging_dir,
            reason: err instanceof Error ? err.message : String(err),
        });
    }

    logger.info('Upload finalized', {
        uploadId: session.id,
        finalPath,
        sha256: sha256Actual,
    });

    return { finalPath, sha256: sha256Actual };
}

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

/** Marks session aborted and deletes staging directory. */
export async function abortUpload(sql: postgres.Sql, session: UploadSessionRow): Promise<void> {
    await abortUploadSession(sql, session.id);

    try {
        await rm(session.staging_dir, { recursive: true, force: true });
    } catch (err) {
        logger.warn('Failed to remove staging dir on abort', {
            stagingDir: session.staging_dir,
            reason: err instanceof Error ? err.message : String(err),
        });
    }

    logger.info('Upload aborted', { uploadId: session.id });
}

// ---------------------------------------------------------------------------
// Ancillary file validation helpers
// ---------------------------------------------------------------------------

export function validateAncillaryMime(
    type: 'subtitle' | 'chapter' | 'resource',
    filename: string,
    mimeType: string,
): { valid: boolean; reason?: string } {
    const ext = extname(filename).toLowerCase();

    if (type === 'subtitle') {
        if (!SUBTITLE_EXTENSIONS.has(ext)) {
            return { valid: false, reason: `Unsupported subtitle extension: ${ext}` };
        }
        return { valid: true };
    }

    if (type === 'chapter') {
        if (ext !== '.vtt' && ext !== '.json') {
            return { valid: false, reason: `Chapter file must be .vtt or .json, got: ${ext}` };
        }
        return { valid: true };
    }

    if (type === 'resource') {
        // The MIME type is client-declared; the extension decides what the file
        // becomes on disk, so it is checked too.
        if (!ALLOWED_RESOURCE_EXTENSIONS.has(ext)) {
            return {
                valid: false,
                reason: `Unsupported resource extension: ${ext || '(none)'}. Allowed: ${[...ALLOWED_RESOURCE_EXTENSIONS].join(', ')}`,
            };
        }
        if (!ALLOWED_RESOURCE_MIMES.has(mimeType)) {
            return {
                valid: false,
                reason: `Unsupported resource MIME type: ${mimeType}. Allowed: ${[...ALLOWED_RESOURCE_MIMES].join(', ')}`,
            };
        }
        return { valid: true };
    }

    return { valid: false, reason: `Unknown ancillary type: ${String(type)}` };
}

export function ancillarySizeLimit(type: 'subtitle' | 'chapter' | 'resource'): number {
    if (type === 'subtitle') return config.MAX_SUBTITLE_UPLOAD_MB * 1024 * 1024;
    if (type === 'chapter') return config.MAX_CHAPTER_UPLOAD_MB * 1024 * 1024;
    return config.MAX_RESOURCE_UPLOAD_MB * 1024 * 1024;
}

// ---------------------------------------------------------------------------
// Expired session cleanup (called from database-cleanup task)
// ---------------------------------------------------------------------------

/** Collect rowless crash leftovers without following directory symlinks. */
async function cleanupOrphanedUploadStaging(sql: postgres.Sql): Promise<void> {
    const override = config.UPLOAD_STAGING_DIR;
    const roots = override
        ? [resolve(override)]
        : (await uploadStagingLibraryRoots(sql)).map((root) => join(root, '.upload-staging'));
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const root of new Set(roots)) {
        try {
            // Reject a substituted staging-root symlink as well as symlink entries.
            if (!(await fs.promises.lstat(root)).isDirectory()) continue;
            const realRoot = await realpath(root);
            const entries = await readdir(realRoot, { withFileTypes: true });
            for (const entry of entries) {
                if (
                    !entry.isDirectory() ||
                    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                        entry.name,
                    )
                )
                    continue;
                const path = resolveUnderRoot(realRoot, entry.name);
                if (!path || !(await realpathUnderRoot(realRoot, path))) continue;
                const info = await fs.promises.lstat(path);
                if (!info.isDirectory() || info.mtimeMs >= cutoff) continue;
                if (await hasUploadStagingSession(sql, join(root, entry.name), entry.name))
                    continue;
                await rm(path, { recursive: true, force: true });
            }
        } catch (err) {
            if ((err as { code?: string }).code !== 'ENOENT')
                logger.warn('Failed to sweep orphan upload staging', { root, error: err });
        }
    }
}

/**
 * Sweeps upload sessions past their expires_at:
 * - Atomically deletes rows that are still eligible for cleanup.
 * - Removes their staging directories on disk (best-effort).
 *
 * Returns the number of sessions cleaned up.
 */
export async function cleanupExpiredUploadSessions(
    sql: postgres.Sql,
    cutoff: Date = new Date(),
): Promise<number> {
    const expired = await findExpiredUploadSessions(sql, cutoff, 100);
    let cleaned = 0;

    for (const session of expired) {
        try {
            // The selection can predate a successful assembly claim. Recheck and
            // remove the row atomically before touching its staging directory;
            // if cleanup wins, the assembly claim cannot subsequently succeed.
            if (!(await deleteExpiredUploadSession(sql, session.id, cutoff))) continue;
        } catch (err) {
            logger.warn('cleanupExpiredUploadSessions: failed to delete expired DB row', {
                id: session.id,
                reason: err instanceof Error ? err.message : String(err),
            });
            continue;
        }
        cleaned++;
        try {
            await rm(session.staging_dir, { recursive: true, force: true });
        } catch (err) {
            logger.warn('cleanupExpiredUploadSessions: failed to rm staging dir', {
                id: session.id,
                stagingDir: session.staging_dir,
                reason: err instanceof Error ? err.message : String(err),
            });
        }
    }

    await cleanupOrphanedUploadStaging(sql);
    return cleaned;
}
