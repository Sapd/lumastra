// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/library-paths.ts
 *
 * GET  /api/admin/library-paths   list all library paths  (library:admin)
 * POST /api/admin/library-paths   create a library path   (library:admin)
 *
 * POST validates group existence and media-type/provider consistency before
 * inserting. An omitted provider/fallback_providers on a non-empty group
 * defaults from the group's existing folders rather than 'tmdb'/[].
 *
 * Auth:    library:admin
 * Surface: internal
 *
 * Response (GET):  { items, page }
 * Response (POST 201): { path }
 * 503 dependency_unavailable on DB down.
 * 422 validation_failed on group-consistency errors, and for an audiobook
 *     library from a local folder (audiobooks come only from AudiobookShelf).
 */

import { resolveLibraryLanguage } from '$lib/server/services/library-language.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getAllLibraryPaths,
    getLibraryPathsByGroup,
    createLibraryPath,
    validateGroupConsistency,
    validateGroupProviderConsistency,
    normalizeLibraryPath,
} from '$lib/server/database/queries/library-paths.queries.js';
import { getLibraryGroupById } from '$lib/server/database/queries/library-groups.queries.js';
import { libraryPathCreateBodyRefined } from '$lib/schemas/admin.js';
import { afterLibraryPathChanged } from '$lib/server/services/library-path-sync.service.js';
import { mapLibraryPathToApi } from '$lib/server/mappers/library-path.mapper.js';
import { getRemoteLibrarySource } from '$lib/server/services/remote-library-sources.js';
import { checkLibraryRootForApi } from '$lib/server/services/library-root-validation.js';
import {
    isLocalAudiobookLibrary,
    LOCAL_AUDIOBOOK_LIBRARY_ERROR,
} from '$lib/shared/remote-library-sources.js';

/** Postgres unique-constraint violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: string }).code === '23505'
    );
}

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin'] },
    visibility: 'internal',
    request: {
        body: libraryPathCreateBodyRefined,
    },
    handlers: {
        GET: async (_event, _ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const paths = await getAllLibraryPaths(sql);
            return json(
                paginate(paths.map(mapLibraryPathToApi), {
                    limit: paths.length,
                    offset: 0,
                    hasMore: false,
                }),
            );
        },

        POST: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const body = ctx.input!.body;

            if (!body.library_group_id) {
                return ApiProblem.validationFailed('library_group_id is required');
            }

            const group = await getLibraryGroupById(sql, body.library_group_id);
            if (!group) {
                return ApiProblem.validationFailed('Library group not found');
            }

            const groupError = await validateGroupConsistency(
                sql,
                body.library_group_id,
                body.media_type,
            );
            if (groupError) return ApiProblem.validationFailed(groupError);

            // `provider`/`fallback_providers` carry no zod-level default (see
            // libraryPathCreateBodySchema) precisely so a NON-EMPTY group can
            // supply its own values here instead of always falling back to
            // 'tmdb'/[] — a new folder in an existing library inherits the
            // library's provider by default rather than silently mixing one in.
            // An empty group (first folder) has nothing to inherit from, so it
            // keeps the historical 'tmdb'/[] default.
            const siblingPaths = await getLibraryPathsByGroup(sql, body.library_group_id);
            const provider = body.provider ?? siblingPaths[0]?.provider ?? 'tmdb';
            const fallbackProviders =
                body.fallback_providers ?? siblingPaths[0]?.fallback_providers ?? [];

            const providerError = await validateGroupProviderConsistency(
                sql,
                body.library_group_id,
                provider,
                fallbackProviders,
            );
            if (providerError) return ApiProblem.validationFailed(providerError);

            if (isLocalAudiobookLibrary(body.media_type, provider)) {
                return ApiProblem.validationFailed(LOCAL_AUDIOBOOK_LIBRARY_ERROR);
            }

            // Remote providers: derive the sentinel `path` and the `provider_path`
            // lookup key from the picked upstream library, and validate the id
            // against the remote server's own list. That validation is the direct
            // analogue of the filesystem readability check the client performs
            // before calling here — an upstream id nobody recognises yields a row
            // that ingests nothing, forever, silently.
            const remoteSource = getRemoteLibrarySource(provider);
            let derived: { path: string; provider_path: string | null } | null = null;
            if (remoteSource) {
                const remoteLibraryId = body.remote_library_id;
                if (!remoteLibraryId) {
                    // Unreachable via the refinement; kept so a future schema edit
                    // cannot turn this into an `undefined` interpolated into SQL.
                    return ApiProblem.validationFailed('remote_library_id is required');
                }

                const listing = await remoteSource.listLibraries();
                if (listing.status === 'not_configured') {
                    return ApiProblem.validationFailed(
                        `${remoteSource.label} is not configured yet — set ${listing.missingKeys.join(' and ')} first.`,
                    );
                }
                if (listing.status === 'unreachable') {
                    return ApiProblem.validationFailed(
                        `Could not read the ${remoteSource.label} library list: ${listing.message}`,
                    );
                }
                const upstream = listing.libraries.find((lib) => lib.id === remoteLibraryId);
                if (!upstream) {
                    return ApiProblem.validationFailed(
                        `${remoteSource.label} has no library with id ${remoteLibraryId}`,
                    );
                }
                if (!upstream.supported) {
                    return ApiProblem.validationFailed(
                        upstream.unsupportedReason ??
                            `${remoteSource.label} library "${upstream.name}" cannot be ingested`,
                    );
                }

                derived = {
                    path: remoteSource.pathFor(remoteLibraryId),
                    provider_path: remoteLibraryId,
                };
            }

            // Filesystem folders are validated server-side (absolute, exists,
            // not '/', no overlap, allow-list); remote sentinels are derived.
            let fsPath: string | undefined;
            if (!derived) {
                const checked = await checkLibraryRootForApi(sql, body.path ?? '');
                if ('problem' in checked) return checked.problem;
                fsPath = checked.path;
            }

            let created;
            try {
                created = await createLibraryPath(sql, {
                    ...body,
                    provider,
                    // Remote sources have no declared language by default. New
                    // filesystem libraries use the effective metadata language.
                    language: resolveLibraryLanguage(body.language, provider),
                    fallback_providers: fallbackProviders,
                    // `path` is optional on the body but required on the insert. For
                    // filesystem providers the refinement guarantees it is present;
                    // for remote ones it is derived above and must win.
                    path: derived?.path ?? fsPath ?? '',
                    provider_path: derived ? derived.provider_path : body.provider_path,
                    library_group_id: body.library_group_id,
                });
            } catch (err) {
                // `library_paths` has a table-wide UNIQUE(path). Without this the
                // duplicate surfaces as a bare 500 saying nothing an operator can
                // act on, and it is genuinely reachable: the remote library picker
                // renders its "already added" markers from a list fetched when the
                // modal opened, so a concurrent admin, a second browser tab, or a
                // row whose `provider_path` is NULL (hand-inserted before the
                // picker existed, so the annotation cannot match it) all present a
                // selectable option whose derived sentinel already exists.
                if (!isUniqueViolation(err)) throw err;
                // Normalize before comparing: stored paths are normalized on
                // insert, so a collision caused BY normalization (a trailing
                // slash) would otherwise miss here and lose the "currently
                // disabled" hint that tells the operator what to do next.
                const conflictPath = normalizeLibraryPath(derived?.path ?? body.path ?? '');
                const existing = (await getAllLibraryPaths(sql)).find(
                    (p) => p.path === conflictPath,
                );
                return ApiProblem.validationFailed(
                    remoteSource
                        ? `That ${remoteSource.label} library is already added${
                              existing?.enabled === false ? ', but is currently disabled' : ''
                          }.`
                        : `A library for "${conflictPath}" already exists${
                              existing?.enabled === false ? ' but is currently disabled' : ''
                          }.`,
                );
            }
            await afterLibraryPathChanged(sql);
            return json({ path: mapLibraryPathToApi(created) }, { status: 201 });
        },
    },
});
