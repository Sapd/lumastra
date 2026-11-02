// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "Update a library" service — the per-library Settings form's Save button.
 *
 * A library = one `library_groups` row plus one or more `library_paths` rows.
 * `name`/`icon`/`description`/`max_age_rating` live on the group only.
 * `media_type`/`provider`/`fallback_providers` are LIBRARY-level facts even
 * though every runtime consumer (video-processor, metadata-matching, mappers)
 * reads them off the per-folder row.
 * A settings save therefore fans those three fields out to EVERY folder of the
 * group in one transaction, so the library can never end up with folders that
 * disagree about what they are.
 *
 * Why a service (not a route): per the three-tier rule, multi-table writes and
 * transactions live in services, not query modules or routes.
 */

import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    getLibraryGroupById,
    updateLibraryGroup,
    type LibraryGroupRow,
} from '$lib/server/database/queries/library-groups.queries.js';
import {
    getLibraryPathsByGroup,
    updateLibraryPath,
    type LibraryPathRow,
    type LibraryPathMediaType,
    type LibraryPathProvider,
} from '$lib/server/database/queries/library-paths.queries.js';
import {
    afterLibraryGroupChanged,
    afterLibraryPathChanged,
} from '$lib/server/services/library-path-sync.service.js';
import { isRemoteLibraryProvider } from '$lib/server/services/remote-library-sources.js';
import {
    isLocalAudiobookLibrary,
    LOCAL_AUDIOBOOK_LIBRARY_ERROR,
} from '$lib/shared/remote-library-sources.js';
import {
    upsertLibraryGroupPermission,
    deleteLibraryGroupPermission,
} from '$lib/server/database/queries/library-group-permissions.queries.js';
import { broadcastPermissionsInvalidation } from '$lib/server/cache/library-group-permissions-cache.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('LibraryUpdate');

export interface UpdateLibraryInput {
    name?: string;
    icon?: string | null;
    description?: string | null;
    max_age_rating?: number | null;
    /** Applied to every folder in the library. */
    media_type?: LibraryPathMediaType;
    /** Applied to every folder in the library. */
    provider?: LibraryPathProvider;
    /** Applied to every folder in the library. */
    fallback_providers?: LibraryPathProvider[];
    /**
     * Who may see the library ([] = everyone). Written in the same transaction
     * as the rest, so "save" is one commit. The caller must have checked the
     * access:admin scope — library:admin alone does not grant it.
     */
    allowed_groups?: string[];
}

export interface UpdateLibraryResult {
    group: LibraryGroupRow;
    paths: LibraryPathRow[];
}

/**
 * Thrown when the save would change media_type or provider on a library that
 * contains a remote-source folder (e.g. AudiobookShelf) — the route maps this
 * to a 409 with the message as-is, since it is already operator-readable.
 *
 * A remote folder's media_type/provider are fixed by the upstream source (its
 * `path` is a synthetic sentinel derived from them); silently overwriting them
 * here would leave the row unable to be addressed by anything that resolves
 * remote libraries.
 */
export class RemoteLibraryConflictError extends Error {}

/**
 * Thrown when the save would turn a folder library into an audiobook library.
 * Audiobooks come only from AudiobookShelf: the scanner imports audio files
 * only in music libraries, so the folder would import nothing. The route maps
 * this to a 422. A folder that already is one stays editable.
 */
export class LocalAudiobookLibraryError extends Error {
    constructor() {
        super(LOCAL_AUDIOBOOK_LIBRARY_ERROR);
    }
}

/**
 * Update a library's settings, fanning media_type/provider/fallback_providers
 * out to every folder in ONE transaction. Returns null when the group does not
 * exist. Throws {@link RemoteLibraryConflictError} when the change would
 * repoint a remote-source folder.
 */
export async function updateLibrary(
    sql: postgres.Sql,
    groupId: string,
    input: UpdateLibraryInput,
): Promise<UpdateLibraryResult | null> {
    const group = await getLibraryGroupById(sql, groupId);
    if (!group) return null;

    const paths = await getLibraryPathsByGroup(sql, groupId);

    const changesFolderIdentity = input.media_type !== undefined || input.provider !== undefined;
    if (changesFolderIdentity) {
        for (const p of paths) {
            if (!isRemoteLibraryProvider(p.provider)) continue;
            const mediaTypeChanges =
                input.media_type !== undefined && input.media_type !== p.media_type;
            const providerChanges = input.provider !== undefined && input.provider !== p.provider;
            if (mediaTypeChanges || providerChanges) {
                throw new RemoteLibraryConflictError(
                    `"${group.display_name ?? group.name}" contains a remote library folder (${p.provider}) — ` +
                        `its media type and provider are fixed by the remote source and cannot be changed here. ` +
                        `Remove that folder first if you need to change this.`,
                );
            }
        }
    }

    // A filesystem folder cannot become a remote one (or back) by a provider
    // change: the two address their libraries differently (a folder path vs a
    // derived remote sentinel). The folder-level PATCH refuses this flip; the
    // library-level fan-out has to refuse it too, or it writes a remote row
    // holding a disk path with no provider_path.
    if (input.provider !== undefined) {
        const crossing = paths.find(
            (p) => isRemoteLibraryProvider(p.provider) !== isRemoteLibraryProvider(input.provider),
        );
        if (crossing) {
            throw new RemoteLibraryConflictError(
                `Cannot change "${group.display_name ?? group.name}" between ${crossing.provider} and ${input.provider}: ` +
                    `a folder library and a remote library address their content differently. ` +
                    `Remove this library and add it again under the other source.`,
            );
        }
    }

    for (const p of paths) {
        const targetMediaType = input.media_type ?? p.media_type;
        if (
            targetMediaType !== p.media_type &&
            isLocalAudiobookLibrary(targetMediaType, input.provider ?? p.provider)
        ) {
            throw new LocalAudiobookLibraryError();
        }
    }

    const touchesFolders =
        input.media_type !== undefined ||
        input.provider !== undefined ||
        input.fallback_providers !== undefined;

    const result = await withTx(sql, async (tx: postgres.Sql) => {
        const updatedGroup = await updateLibraryGroup(tx, groupId, {
            name: input.name,
            icon: input.icon,
            description: input.description,
            max_age_rating: input.max_age_rating,
        });
        if (!updatedGroup) {
            // The group existed a moment ago (checked above) — treat a
            // mid-transaction disappearance as an error rather than silently
            // returning a partial result.
            throw new Error('Library group no longer exists');
        }

        const updatedPaths: LibraryPathRow[] = [];
        for (const p of paths) {
            if (!touchesFolders) {
                updatedPaths.push(p);
                continue;
            }
            const updated = await updateLibraryPath(tx, p.id, {
                media_type: input.media_type,
                provider: input.provider,
                fallback_providers: input.fallback_providers,
            });
            updatedPaths.push(updated ?? p);
        }

        if (input.allowed_groups !== undefined) {
            // Same semantics as PUT /api/admin/library-group-permissions: an
            // empty list removes the row (unrestricted), anything else upserts.
            if (input.allowed_groups.length === 0) {
                await deleteLibraryGroupPermission(tx, groupId);
            } else {
                await upsertLibraryGroupPermission(tx, {
                    libraryGroupId: groupId,
                    allowedGroups: input.allowed_groups,
                });
            }
        }

        return { group: updatedGroup, paths: updatedPaths };
    });

    if (input.allowed_groups !== undefined) broadcastPermissionsInvalidation();

    // Side-effects AFTER commit, mirroring the group-PATCH and path-PATCH defs.
    await afterLibraryGroupChanged();
    await afterLibraryPathChanged(sql);

    logger.info('Updated library', {
        groupId,
        touchedFolders: touchesFolders,
        folderCount: result.paths.length,
    });

    return result;
}
