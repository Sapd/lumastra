// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/admin/upload/[libraryPathId]/ancillary/[mediaItemId]
 *
 * Uploads a sidecar ancillary file (subtitle, chapter, resource) beside the
 * primary video file of an existing media item.
 *
 * Auth:    library:admin (admin-scoped)
 * Surface: internal
 *
 * Request:  multipart/form-data — `file` (File) + `type` ('subtitle'|'chapter'|'resource')
 * Response: { path, type }
 * Errors:   problem+json (incl. 503 dependency_unavailable)
 */

import { parseWebVTT } from '$lib/server/utils/webvtt-parser.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import { getLibraryPathById } from '$lib/server/database/queries/library-paths.queries.js';
import { getUploadSessionById } from '$lib/server/database/queries/upload-sessions.queries.js';
import { getFilesForMediaItem } from '$lib/server/database/queries/media-files.queries.js';
import {
    saveUploadedChapters,
    undoUploadedChapters,
    publishSidecar,
} from '$lib/server/services/uploaded-chapters.service.js';
import {
    validateAncillaryMime,
    ancillarySizeLimit,
    UPLOADABLE_LIBRARY_TYPES,
} from '$lib/server/services/upload-session.service.js';
import { resolveUnderRoot } from '$lib/server/utils/library-path-safety.js';
import { MEDIA_EXTENSIONS } from '$lib/server/utils/walk-directory.js';
import { sep, dirname, join, extname, basename } from 'node:path';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { enqueueDeltaPayload } from '$lib/server/tasks/builtin/native/file-delta-ingest-queue.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('upload.ancillary');

const ALLOWED_ANCILLARY_TYPES = new Set(['subtitle', 'chapter', 'resource']);

/** Derive sidecar filename beside the primary video file. */
function deriveSidecarPath(
    videoDirPath: string,
    videoBaseName: string,
    uploadedFilename: string,
    type: 'subtitle' | 'chapter' | 'resource',
): string {
    const ext = extname(uploadedFilename);
    const videoStem = videoBaseName.replace(/\.[^.]+$/, '');

    if (type === 'subtitle') {
        const uploadedStem = basename(uploadedFilename, ext);
        const suffix = uploadedStem !== videoStem ? `.${uploadedStem}${ext}` : ext;
        return join(videoDirPath, `${videoStem}${suffix}`);
    }

    if (type === 'chapter') {
        return join(videoDirPath, `${videoStem}.chapters${ext}`);
    }

    // resource: SECURITY — basename() strips path traversal vectors.
    const safeResourceName = basename(uploadedFilename);
    return join(videoDirPath, safeResourceName);
}

/** Parse a JSON chapter list: [{title, startMs}, ...] */
interface ChapterMarker {
    title: string;
    startMs: number;
    endMs?: number;
}

function parseJsonChapters(buf: Buffer): ChapterMarker[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(buf.toString('utf8'));
    } catch (err) {
        throw Object.assign(
            new Error(
                `Invalid JSON in chapter file: ${err instanceof Error ? err.message : String(err)}`,
            ),
            { statusCode: 400 },
        );
    }
    if (!Array.isArray(parsed)) {
        throw Object.assign(new Error('Chapter JSON must be an array'), { statusCode: 400 });
    }
    const isMs = (v: unknown): v is number =>
        typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e12;
    return (parsed as unknown[]).map((raw, i) => {
        // A null/non-object entry used to throw a TypeError (500), and NaN /
        // Infinity / negative times threw a RangeError in BigInt() below.
        const item = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<ChapterMarker>;
        if (!isMs(item.startMs)) {
            throw Object.assign(
                new Error(`Chapter[${i}]: startMs must be between 0 and 1000000000000 ms`),
                {
                    statusCode: 400,
                },
            );
        }
        if (item.endMs !== undefined && !isMs(item.endMs)) {
            throw Object.assign(
                new Error(`Chapter[${i}]: endMs must be between 0 and 1000000000000 ms`),
                {
                    statusCode: 400,
                },
            );
        }
        return {
            title: typeof item.title === 'string' ? item.title : `Chapter ${i + 1}`,
            startMs: item.startMs,
            endMs: item.endMs,
        };
    });
}

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin', 'admin'] },
    visibility: 'internal',
    // Multipart body — not a JSON body schema; mount() skips body parsing.
    raw: true,
    handlers: {
        POST: async (event) => {
            const { libraryPathId, mediaItemId } = event.params;
            if (!libraryPathId || !mediaItemId) {
                return ApiProblem.validationFailed('Missing route parameters');
            }

            if (!UUID_RE.test(mediaItemId)) return ApiProblem.notFound('Media item not found');
            if (!UUID_RE.test(libraryPathId)) return ApiProblem.notFound('Library path not found');

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const libraryPath = await getLibraryPathById(sql, libraryPathId);
            if (!libraryPath) return ApiProblem.notFound('Library path not found');
            if (!UPLOADABLE_LIBRARY_TYPES.has(libraryPath.media_type)) {
                return ApiProblem.validationFailed(
                    `Uploads not supported for library type: ${libraryPath.media_type}`,
                );
            }

            const files = await getFilesForMediaItem(sql, mediaItemId);
            const uploadId = event.url.searchParams.get('uploadId');
            let pinnedPath: string | undefined;
            if (uploadId) {
                if (!UUID_RE.test(uploadId))
                    return ApiProblem.validationFailed('Invalid upload session');
                const session = await getUploadSessionById(sql, uploadId);
                const caller = event.locals.principal?.username ?? event.locals.user?.username;
                if (!caller) return ApiProblem.unauthorized();
                if (
                    !session ||
                    session.uploader_user !== caller ||
                    session.library_path_id !== libraryPathId
                )
                    return ApiProblem.notFound('Upload session not found');
                if (session.status !== 'queued' || !session.final_path)
                    return ApiProblem.conflict('Upload has not finished importing.');
                pinnedPath = session.final_path;
            }
            const defaultFile = pinnedPath
                ? files.find((file) => file.file_path === pinnedPath)
                : (files.find((f) => f.is_default) ?? files[0]);
            if (!defaultFile) {
                return ApiProblem.notFound(
                    'Media item has no linked file — cannot place ancillary file',
                );
            }

            // SECURITY — IDOR guard: verify the media item's file lives inside this library path.
            const libraryRoot = libraryPath.path;
            const normalizedRoot = libraryRoot.endsWith(sep) ? libraryRoot : libraryRoot + sep;
            const fileIsUnderLibrary =
                defaultFile.file_path === libraryRoot ||
                defaultFile.file_path.startsWith(normalizedRoot);
            if (!fileIsUnderLibrary) {
                return ApiProblem.notFound(
                    'Media item does not belong to the specified library path',
                );
            }

            // Validate Content-Type
            const contentType = event.request.headers.get('content-type') ?? '';
            if (!contentType.includes('multipart/form-data')) {
                return ApiProblem.validationFailed('Content-Type must be multipart/form-data');
            }

            // CSRF guard (same-origin check)
            const url = new URL(event.request.url);
            const origin = event.request.headers.get('origin');
            const referer = event.request.headers.get('referer');
            let sourceHost: string | null = null;
            if (origin && origin !== 'null') {
                try {
                    sourceHost = new URL(origin).host;
                } catch {
                    sourceHost = null;
                }
            } else if (referer) {
                try {
                    sourceHost = new URL(referer).host;
                } catch {
                    sourceHost = null;
                }
            }
            if (sourceHost !== url.host) {
                return ApiProblem.forbidden('Cross-origin ancillary upload not allowed');
            }

            const formData = await event.request.formData();
            const undoReceiptId = formData.get('undoReceiptId');
            if (typeof undoReceiptId === 'string') {
                if (!UUID_RE.test(undoReceiptId))
                    return ApiProblem.validationFailed('Invalid recovery receipt');
                const path = await undoUploadedChapters(
                    sql,
                    mediaItemId,
                    defaultFile.id,
                    undoReceiptId,
                );
                return json({ path, type: 'chapter' });
            }
            const file = formData.get('file');
            const typeValue = formData.get('type');

            if (!(file instanceof File)) {
                return ApiProblem.validationFailed('Missing "file" field in form data');
            }
            if (typeof typeValue !== 'string' || !ALLOWED_ANCILLARY_TYPES.has(typeValue)) {
                return ApiProblem.validationFailed(
                    `Missing or invalid "type" field. Must be one of: ${[...ALLOWED_ANCILLARY_TYPES].join(', ')}`,
                );
            }

            const ancillaryType = typeValue as 'subtitle' | 'chapter' | 'resource';

            const validation = validateAncillaryMime(ancillaryType, file.name, file.type);
            if (!validation.valid) {
                return ApiProblem.validationFailed(validation.reason ?? 'Invalid ancillary file');
            }

            const maxBytes = ancillarySizeLimit(ancillaryType);
            if (file.size > maxBytes) {
                return ApiProblem.validationFailed(
                    `File too large (${file.size} bytes). Maximum for ${ancillaryType}: ${Math.round(maxBytes / 1024 / 1024)} MB`,
                );
            }

            const buf = Buffer.from(await file.arrayBuffer());

            // Validate a JSON chapter list BEFORE anything is written: a bad
            // file used to be left in the library as `<stem>.chapters.json`
            // after the 400.
            const jsonChapters =
                ancillaryType === 'chapter' && extname(file.name).toLowerCase() === '.json'
                    ? parseJsonChapters(buf)
                    : ancillaryType === 'chapter'
                      ? parseWebVTT(buf.toString('utf8')).cues.map((cue) => ({
                            title: cue.text,
                            startMs: cue.startSeconds * 1000,
                            endMs: cue.endSeconds * 1000,
                        }))
                      : null;

            if (
                ancillaryType === 'chapter' &&
                extname(file.name).toLowerCase() === '.vtt' &&
                !jsonChapters?.length
            )
                return ApiProblem.validationFailed(
                    'Choose a WebVTT file with chapter cues. Upload an empty JSON list to clear uploaded chapters.',
                );

            const videoFilePath = defaultFile.file_path;
            const videoDir = dirname(videoFilePath);
            const videoBase = basename(videoFilePath);

            const sidecarPath = deriveSidecarPath(videoDir, videoBase, file.name, ancillaryType);

            // SECURITY: defense-in-depth path traversal check.
            if (!resolveUnderRoot(libraryRoot, sidecarPath.slice(normalizedRoot.length))) {
                logger.warn('Derived sidecar path escapes library root — rejecting', {
                    sidecarPath,
                    libraryRoot,
                });
                return ApiProblem.validationFailed(
                    'Derived sidecar path is outside the library root',
                );
            }

            // Never let an ancillary upload replace the media item's own video
            // (or any media file): a resource named like the video used to
            // overwrite it.
            const sidecarBase = basename(sidecarPath);
            if (
                sidecarPath === videoFilePath ||
                MEDIA_EXTENSIONS.has(extname(sidecarBase).toLowerCase()) ||
                sidecarBase.startsWith('.')
            ) {
                return ApiProblem.validationFailed(
                    `Refusing to write ancillary file over "${sidecarBase}"`,
                );
            }

            const undoId = jsonChapters
                ? await saveUploadedChapters(
                      sql,
                      mediaItemId,
                      defaultFile.id,
                      sidecarPath,
                      buf,
                      jsonChapters,
                      event.locals.user?.username ?? 'admin',
                  )
                : await publishSidecar(sidecarPath, buf, async () => undefined);
            if (!jsonChapters) {
                try {
                    // Push before startRun — see file-delta-ingest-queue.ts:
                    // a deduped startRun (raced by finalize/ingest for the
                    // same libraryPathId) must not drop this sidecar.
                    await enqueueDeltaPayload(libraryPathId, {
                        upsert: [sidecarPath],
                        remove: [],
                    });
                    await orchestrator.startRun(
                        'file-delta-ingest',
                        { libraryPathId },
                        { trigger: { kind: 'in-process', sourceRoute: 'upload.ancillary' } },
                    );
                } catch (err) {
                    logger.warn('file-delta-ingest trigger for ancillary failed (non-fatal)', {
                        sidecarPath,
                        reason: err instanceof Error ? err.message : String(err),
                    });
                }
            }

            return json({ path: sidecarPath, type: ancillaryType, undoId });
        },
    },
});
