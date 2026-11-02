// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/library/remote-libraries.ts
 *
 * GET /api/admin/library/remote-libraries?provider=audiobookshelf
 *
 * Admin-only: enumerate the libraries a remote media server hosts, so the
 * add-library form can offer a dropdown of real names instead of asking the
 * operator to type a synthetic `abs://<uuid>` path (which would mean going to
 * find that uuid in the remote server's own admin UI — configurable in name
 * only).
 *
 * The provider HTTP call lives behind `RemoteLibrarySource` — this endpoint has
 * no AudiobookShelf-specific knowledge beyond resolving the provider name.
 *
 * Response: {
 *   provider, label, mediaType, settingsHref, requiredKeys,
 *   status: 'ok' | 'not_configured' | 'unreachable',
 *   libraries?: [{ id, name, kind, supported, unsupportedReason?, path,
 *                  existing?: { libraryPathId, libraryGroupId, language, enabled } }],
 *   missingKeys?: string[],   // status === 'not_configured'
 *   message?: string,         // status === 'unreachable'
 * }
 *
 * A failure to reach the remote server is reported as a 200 with
 * `status: 'unreachable'`, NOT as a 5xx: the request itself succeeded, and the
 * form needs to render the reason inline next to a retry rather than show a
 * generic request-failed toast. `status` is never omitted, so a client that
 * forgets to branch renders nothing rather than silently treating an
 * unreachable server as an empty library list.
 *
 * Auth:    library:admin
 * Surface: internal
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getAllLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import {
    getRemoteLibrarySource,
    type RemoteLibraryOption,
} from '$lib/server/services/remote-library-sources.js';

/** What an already-configured library looks like in the response. */
interface ExistingRow {
    libraryPathId: string;
    libraryGroupId: string;
    language: string;
    enabled: boolean;
}

interface LibraryEntry extends RemoteLibraryOption {
    /** The `library_paths.path` sentinel this library would get. */
    path: string;
    /** Present when this upstream library already has a `library_paths` row. */
    existing?: ExistingRow;
}

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin'] },
    visibility: 'internal',
    request: {
        query: z.object({
            provider: z.string().min(1).max(64),
        }),
    },
    handlers: {
        GET: async (_event, ctx) => {
            const source = getRemoteLibrarySource(ctx.input!.query.provider);
            if (!source) {
                return ApiProblem.validationFailed(
                    `Unknown remote library provider: ${ctx.input!.query.provider}`,
                );
            }

            const base = {
                provider: source.provider,
                label: source.label,
                mediaType: source.mediaType,
                settingsHref: source.settingsHref,
                requiredKeys: source.requiredKeys,
            };

            const listing = await source.listLibraries();
            if (listing.status === 'not_configured') {
                return json({
                    ...base,
                    status: 'not_configured',
                    missingKeys: listing.missingKeys,
                });
            }
            if (listing.status === 'unreachable') {
                return json({ ...base, status: 'unreachable', message: listing.message });
            }

            // Annotate with what is already configured. Without this the operator
            // picks a library that already has a row and gets an idempotent
            // attach — correct, but indistinguishable from "nothing happened".
            // Keyed on `provider_path` (the upstream id), which is what the sweep
            // addresses; `path` is only a sentinel. Reads ALL rows, not just
            // enabled ones, so a DISABLED library is reported as already-added
            // rather than looking available and then colliding on UNIQUE(path).
            // (A library the operator *deleted* has no row at all and correctly
            // becomes selectable again.)
            const existingByUpstreamId = new Map<string, ExistingRow>();
            const sql = await aiDbService.getSql();
            if (sql) {
                for (const row of await getAllLibraryPaths(sql)) {
                    if (row.provider !== source.provider) continue;
                    const upstreamId = row.provider_path?.trim();
                    if (!upstreamId) continue;
                    existingByUpstreamId.set(upstreamId, {
                        libraryPathId: row.id,
                        libraryGroupId: row.library_group_id,
                        language: row.language,
                        enabled: row.enabled,
                    });
                }
            }

            const libraries: LibraryEntry[] = listing.libraries.map((lib) => ({
                ...lib,
                path: source.pathFor(lib.id),
                existing: existingByUpstreamId.get(lib.id),
            }));

            return json({ ...base, status: 'ok', libraries });
        },
    },
});
