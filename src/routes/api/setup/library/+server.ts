// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/setup/library — admin-only: create a media library (one source +
 * media type) and start its ingest.
 *
 * Runs at the first-run wizard's library step (after the admin account exists),
 * so requireAdmin is appropriate, and stays admin-callable beyond onboarding.
 * Deliberately minimal — full library management lives in /admin/library.
 * Reuses the same primitives the admin UI does: createLibraryGroup →
 * createLibraryPath → afterLibraryPathChanged → orchestrator.startRun.
 *
 * ## Two kinds of library
 *
 * **Filesystem providers** send `{ path }`. The folder is validated for
 * readability FROM THIS NODE first: an unreadable path (typo / volume not
 * mounted) returns `{ ok:false, readable:false }` WITHOUT creating anything, so
 * the operator fixes it instead of scanning an empty mount.
 *
 * **Remote providers** ({@link isRemoteLibraryProvider}) send
 * `{ provider, remoteLibraryId }` and NEVER a path. Their `library_paths.path`
 * is a synthetic `<scheme>://<upstream-id>` sentinel derived here, and
 * `provider_path` carries the upstream id — which is the field the connector
 * actually addresses (`path` is not a lookup key). Deriving both here is the
 * point: a caller that could pass its own `path` could mistype the sentinel, and
 * a row whose `provider_path` is empty sweeps nothing while looking configured.
 *
 * Remote libraries are validated too, against the remote server's own library
 * list rather than against a disk. That is the direct analogue of the
 * readability check, and for the same reason: an id that upstream does not know
 * is almost always a typo or a server pointed at the wrong place, and a library
 * created from one ingests nothing forever with no operator-visible symptom.
 */

import { resolveLibraryLanguage } from '$lib/server/services/library-language.js';
import { libraryIngestKey } from '$lib/server/tasks/library-ingest-key.js';
import { readBoundedJson } from '$lib/server/utils/bounded-body-reader';
import { LIBRARY_GROUP_NAME_MAX_LENGTH } from '$lib/shared/library-group-limits.js';
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { isPathReadable } from '$lib/server/preflight/dependency-checks.js';
import { safeStat } from '$lib/server/utils/safe-fs.js';
import { createLibraryGroup } from '$lib/server/database/queries/library-groups.queries.js';
import {
    createLibraryPath,
    getAllLibraryPaths,
    updateLibraryPath,
    normalizeLibraryPath,
    type LibraryPathMediaType,
    type LibraryPathProvider,
} from '$lib/server/database/queries/library-paths.queries.js';
// `getRemoteLibrarySource` returning a source IS the "is this provider remote?"
// test — a separate `isRemoteLibraryProvider` call would be a second way to ask
// the same question, and the two could disagree if a provider were ever listed as
// remote without a source implementation.
import { getRemoteLibrarySource } from '$lib/server/services/remote-library-sources.js';
import { LIBRARY_PATH_PROVIDERS } from '$lib/schemas/common.js';
import { afterLibraryPathChanged } from '$lib/server/services/library-path-sync.service.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { BackpressureError } from '$lib/server/tasks/backpressure.js';
import { isRecord, toStringOr } from '$lib/utils/data-extraction.js';
import {
    isLocalAudiobookLibrary,
    LOCAL_AUDIOBOOK_LIBRARY_ERROR,
} from '$lib/shared/remote-library-sources.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getLocale } from '$lib/paraglide/runtime.js';
import * as m from '$lib/paraglide/messages.js';
import {
    assertLibraryRootAllowed,
    LibraryRootRejectedError,
} from '$lib/server/services/library-root-validation.js';

const ENDPOINT = '/api/setup/library';
const logger = Logger.for('SetupLibrary');

/** Postgres unique-constraint violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: string }).code === '23505'
    );
}

const MEDIA_TYPES: readonly LibraryPathMediaType[] = [
    'movie',
    'tv',
    'anime',
    'music',
    'audiobook',
    'home_video',
    'training',
    'educational',
    'personal',
];

/**
 * Friendly default group name per media type (operator can rename later).
 * Read live via a function, not a static map: `getLocale()` resolves the
 * CURRENT request's locale (paraglide's per-request context, set by the
 * server hook), so a German-UI wizard run gets "Filme"/"Serien"/... instead
 * of the hardcoded English that used to leak through regardless of locale.
 */
function defaultGroupName(mediaType: LibraryPathMediaType): string {
    const locale = getLocale();
    const names: Record<LibraryPathMediaType, string> = {
        movie: m.setup_library_default_name_movie({}, { locale }),
        tv: m.setup_library_default_name_tv({}, { locale }),
        anime: m.setup_library_default_name_anime({}, { locale }),
        music: m.setup_library_default_name_music({}, { locale }),
        audiobook: m.setup_library_default_name_audiobook({}, { locale }),
        home_video: m.setup_library_default_name_home_video({}, { locale }),
        training: m.setup_library_default_name_training({}, { locale }),
        educational: m.setup_library_default_name_educational({}, { locale }),
        personal: m.setup_library_default_name_personal({}, { locale }),
    };
    return names[mediaType];
}

export const POST: RequestHandler = requireAdmin(
    withErrorHandler(async ({ request, locals }) => {
        let body: unknown;
        try {
            body = await readBoundedJson(request);
        } catch {
            return ApiResponses.badRequest('Invalid request body', undefined, ENDPOINT);
        }
        if (!isRecord(body)) {
            return ApiResponses.badRequest('Invalid request body', undefined, ENDPOINT);
        }

        const providerRaw = toStringOr(body.provider, '').trim() || 'tmdb';
        if (!(LIBRARY_PATH_PROVIDERS as readonly string[]).includes(providerRaw)) {
            return ApiResponses.badRequest('Unknown provider', undefined, ENDPOINT);
        }
        const provider = providerRaw as LibraryPathProvider;
        const remoteSource = getRemoteLibrarySource(provider);

        const mediaType = toStringOr(body.mediaType, '') as LibraryPathMediaType;
        const language = resolveLibraryLanguage(toStringOr(body.language, ''), provider);
        if (!MEDIA_TYPES.includes(mediaType)) {
            return ApiResponses.badRequest('Unknown media type', undefined, ENDPOINT);
        }
        if (isLocalAudiobookLibrary(mediaType, provider)) {
            return ApiResponses.badRequest(LOCAL_AUDIOBOOK_LIBRARY_ERROR, undefined, ENDPOINT);
        }

        // `path` is derived for remote providers and supplied for filesystem ones,
        // so it cannot be resolved before the provider is known.
        let path: string;
        // The upstream library id. NULL for filesystem providers; for remote ones
        // it is the field the connector addresses, so an empty value here would
        // produce a row that looks configured and ingests nothing.
        let providerPath: string | null = null;
        let remoteLibraryName: string | undefined;

        if (remoteSource) {
            // Deliberately ignores `body.path`. See the header: the sentinel is
            // derived, never accepted, so no caller can mistype it.
            const remoteLibraryId = toStringOr(body.remoteLibraryId, '').trim();
            if (!remoteLibraryId) {
                return ApiResponses.badRequest(
                    `A ${remoteSource.label} library must be selected`,
                    undefined,
                    ENDPOINT,
                );
            }

            // The remote analogue of the readability check below: confirm the
            // upstream server actually has this library before creating a row
            // whose only symptom of being wrong is ingesting nothing forever.
            const listing = await remoteSource.listLibraries();
            if (listing.status === 'not_configured') {
                return ApiResponses.badRequest(
                    `${remoteSource.label} is not configured yet — set ${listing.missingKeys.join(' and ')} first.`,
                    undefined,
                    ENDPOINT,
                );
            }
            if (listing.status === 'unreachable') {
                return ApiResponses.badRequest(
                    `Could not read the ${remoteSource.label} library list: ${listing.message}`,
                    undefined,
                    ENDPOINT,
                );
            }
            const upstream = listing.libraries.find((lib) => lib.id === remoteLibraryId);
            if (!upstream) {
                return ApiResponses.badRequest(
                    `${remoteSource.label} has no library with id ${remoteLibraryId}`,
                    undefined,
                    ENDPOINT,
                );
            }
            if (!upstream.supported) {
                return ApiResponses.badRequest(
                    upstream.unsupportedReason ??
                        `${remoteSource.label} library "${upstream.name}" cannot be ingested`,
                    undefined,
                    ENDPOINT,
                );
            }

            path = normalizeLibraryPath(remoteSource.pathFor(remoteLibraryId));
            providerPath = remoteLibraryId;
            // The upstream label is untrusted. Match the admin group's limit,
            // and avoid leaving half of a surrogate pair at the truncation edge.
            remoteLibraryName = upstream.name
                .slice(0, LIBRARY_GROUP_NAME_MAX_LENGTH)
                .replace(/[\uD800-\uDBFF]$/u, '');
        } else {
            // Normalize BEFORE the readability check, the dedup comparison below,
            // AND the insert, so `/media/movies` and `/media/movies/` are treated
            // as the identical library rather than creating (and scanning) two of
            // them.
            path = normalizeLibraryPath(toStringOr(body.path, '').trim());
            if (!path) {
                return ApiResponses.badRequest('A folder path is required', undefined, ENDPOINT);
            }

            // Validate readability BEFORE creating anything — an unreadable path is
            // almost always a typo or an unmounted volume. Non-fatal: report it so the
            // wizard can prompt a fix rather than silently scan nothing.
            //
            // Gated on the provider CLASS, not on a `provider === 'audiobookshelf'`
            // literal: a remote row's `path` is a URI that can never `stat()`, and
            // the next remote provider must not have to find this line again.
            if (!(await isPathReadable(path))) {
                return json({ ok: false, readable: false });
            }
            // A readable regular file passes the access check, but the scan's
            // readdir can only fail on it: refuse before creating anything.
            const isDirectory = await safeStat(path).then(
                (st) => st.isDirectory(),
                () => false,
            );
            if (!isDirectory) return json({ ok: false, readable: true, notDirectory: true });
        }

        const sql = await aiDbService.getSql();
        if (!sql) {
            return ApiResponses.error('Database unavailable', undefined, 503, ENDPOINT);
        }

        // If this folder is already registered, attach to the EXISTING library
        // rather than creating a duplicate — keeps the endpoint idempotent (it
        // stays admin-callable beyond onboarding) and avoids a unique-violation
        // on re-submit. Look up ALL paths (not just enabled ones): library_paths
        // has a table-wide UNIQUE(path), so a DISABLED row (a previously-removed
        // library) would otherwise slip past an enabled-only check, hit the
        // unique constraint on insert, and 500. Re-enable such a row so the
        // folder actually scans.
        const existing = (await getAllLibraryPaths(sql)).find((p) => p.path === path);
        // Reusing it would scan the folder as its OLD type while the wizard shows
        // the one just picked (e.g. music files under "Movies": an empty library).
        if (existing && existing.media_type !== mediaType) {
            return json({
                ok: false,
                readable: true,
                conflict: 'media-type',
                existingMediaType: existing.media_type,
            });
        }

        // A new filesystem folder follows the same server-side rules as one
        // added in the admin UI (absolute, not '/', inside
        // LIBRARY_ALLOWED_ROOTS, no overlap with another library folder).
        // Re-using the exact existing folder above stays idempotent.
        if (!existing && !remoteSource) {
            try {
                path = await assertLibraryRootAllowed(sql, path);
            } catch (err) {
                if (!(err instanceof LibraryRootRejectedError)) throw err;
                return ApiResponses.badRequest(err.message, undefined, ENDPOINT);
            }
        }

        let libraryPathId: string;
        let groupId: string;
        if (existing) {
            libraryPathId = existing.id;
            groupId = existing.library_group_id;
            if (!existing.enabled) {
                await updateLibraryPath(sql, existing.id, { enabled: true });
                await afterLibraryPathChanged(sql);
            }
        } else {
            // No combined helper exists: create the group + path in ONE transaction
            // so a failed path insert can't leave an orphaned group behind.
            try {
                const result = await sql.begin(async (tx) => {
                    const group = await createLibraryGroup(tx, {
                        name: remoteLibraryName ?? defaultGroupName(mediaType),
                    });
                    const created = await createLibraryPath(tx, {
                        path,
                        media_type: mediaType,
                        language,
                        provider,
                        // Remote providers only. This — not `path` — is what the
                        // connector resolves an upstream library from, so omitting
                        // it produces a row the sweep skips with an error string.
                        provider_path: providerPath,
                        library_group_id: group.id,
                    });
                    return { groupId: group.id, libraryPathId: created.id };
                });
                libraryPathId = result.libraryPathId;
                groupId = result.groupId;
                // Refresh path-mapping / browse caches + the file-scanner watcher
                // (post-commit). Does NOT start a scan — that's the explicit startRun below.
                await afterLibraryPathChanged(sql);
            } catch (err) {
                // A concurrent submission may have created this identical
                // (normalized) path between our initial check and this insert —
                // library_paths has UNIQUE(path), so that race surfaces as a
                // 23505. Treat it as an idempotent success and attach to the
                // now-existing library rather than a spurious 500; the
                // transaction above already rolled back, so no orphaned group
                // was left behind.
                if (isUniqueViolation(err)) {
                    // Re-query ALL paths (incl. disabled): the conflicting row may
                    // be a disabled one the enabled-only dedup above didn't see, or
                    // one a concurrent submission just created.
                    const race = (await getAllLibraryPaths(sql)).find((p) => p.path === path);
                    if (!race) {
                        // Named binding: the logger's `object | Error` overload
                        // accepts this context object structurally, but a fresh
                        // literal trips excess-property checking against the Error
                        // arm — a variable reference is exempt.
                        const logContext = { path };
                        logger.error(
                            'Unique violation creating library_paths but no matching row found on re-query',
                            logContext,
                        );
                        return ApiResponses.error(
                            'Could not create the library',
                            undefined,
                            500,
                            ENDPOINT,
                        );
                    }
                    libraryPathId = race.id;
                    groupId = race.library_group_id;
                    if (!race.enabled) {
                        await updateLibraryPath(sql, race.id, { enabled: true });
                        await afterLibraryPathChanged(sql);
                    }
                } else {
                    const logContext = { error: String(err) };
                    logger.error('Could not create library from setup wizard', logContext);
                    return ApiResponses.error(
                        'Could not create the library',
                        undefined,
                        500,
                        ENDPOINT,
                    );
                }
            }
        }

        // Start the initial ingest. The library exists regardless of whether this
        // succeeds; a failure (queue at capacity OR any orchestrator hiccup) is
        // non-fatal — the task's own schedule still picks the new library up.
        //
        // The TASK depends on the source. `file-library-scan`'s first act is to
        // `readdir` `library_paths.path`, which for a remote provider is a
        // `<scheme>://<id>` URI: that run can only fail, and it would do so while
        // holding a `bulk` slot and writing a misleading run-history entry that
        // looks like the library failed to import. Each remote source names the
        // task that actually ingests it.
        const by = locals.user?.username ?? undefined;
        const ingestTaskId = remoteSource?.syncTaskId ?? 'file-library-scan';
        let runId: string | undefined;
        try {
            const r = await orchestrator.startRun(
                ingestTaskId,
                // `file-library-scan` wants `mode`; the remote sync tasks take only
                // a library scope. Passing `mode` to a task whose inputSchema does
                // not declare it would fail validation at enqueue time.
                remoteSource ? { libraryPathId } : { libraryPathId, mode: 'manual' },
                {
                    trigger: { kind: 'manual', by, sourceRoute: 'setup.library' },
                    idempotencyKey: libraryIngestKey(ingestTaskId, libraryPathId),
                },
            );
            runId = r.runId;
        } catch (err) {
            if (!(err instanceof BackpressureError)) {
                logger.warn('Library created but initial ingest could not start', {
                    error: String(err),
                    taskId: ingestTaskId,
                });
            }
        }

        return json({
            ok: true,
            readable: true,
            scanStarted: runId !== undefined,
            runId,
            libraryPathId,
            groupId,
        });
    }),
);
