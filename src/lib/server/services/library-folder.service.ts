// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Library folder (library_paths row) update and delete, shared by the admin
 * surface (`defs/admin/library-paths-item.ts`) and the v1 surface
 * (`defs/library-paths/[id].ts`). The v1 handlers used to write the row
 * directly and skipped every rule the admin surface enforced (group
 * consistency, re-stamping files on a move, cache invalidation).
 *
 * Results are `{ ok } | { problem }` so both surfaces answer identically.
 */

import type postgres from 'postgres';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getLibraryGroupById } from '$lib/server/database/queries/library-groups.queries.js';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    getLibraryPathById,
    updateLibraryPath,
    deleteLibraryPath,
    restampLibraryPathFileGroups,
    validateGroupConsistency,
    validateGroupProviderConsistency,
    type LibraryPathRow,
    type UpdateLibraryPathParams,
} from '$lib/server/database/queries/library-paths.queries.js';
import { getAllLibraryGroupPermissions } from '$lib/server/database/queries/library-group-permissions.queries.js';
import { afterLibraryPathChanged } from '$lib/server/services/library-path-sync.service.js';
import { isRemoteLibraryProvider } from '$lib/server/services/remote-library-sources.js';
import { checkLibraryRootForApi } from '$lib/server/services/library-root-validation.js';
import {
    isLocalAudiobookLibrary,
    LOCAL_AUDIOBOOK_LIBRARY_ERROR,
} from '$lib/shared/remote-library-sources.js';
import { scopeGranted } from '$lib/server/tasks/api-auth.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    refreshAudiobookLibrarySettings,
    retireAudiobookLibraryPath,
    preserveAudiobookLibraryAgeRating,
} from '$lib/server/database/queries/audiobook-library.queries.js';

const logger = Logger.for('LibraryFolderService');

export type FolderResult<T> = { ok: true; value: T } | { ok: false; problem: Response };

/** Postgres unique-constraint violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: string }).code === '23505'
    );
}

// ---------------------------------------------------------------------------
// Access guard
// ---------------------------------------------------------------------------

/**
 * `library:admin` manages libraries; `access:admin` decides who may see them.
 * Moving a folder between libraries, deleting a folder, or deleting a library
 * changes which access group the files carry (visibility is per file, and a
 * deleted library's files end up in no group = visible to everyone). When any
 * of the libraries involved is restricted, that is an access change and needs
 * `access:admin` too. With no restriction configured (the common case) the
 * library scope alone is enough.
 *
 * Today every credential that can carry `library:admin` also carries
 * `access:admin` (only the coarse `admin` scope is mintable); this keeps the
 * split meaningful once fine-grained scopes become mintable.
 */
export async function requireAccessScopeIfRestricted(
    sql: postgres.Sql,
    groupIds: ReadonlyArray<string | null | undefined>,
    scopes: readonly string[] | undefined,
): Promise<Response | null> {
    if (scopes && scopeGranted([...scopes], 'access:admin')) return null;
    const ids = new Set(groupIds.filter((g): g is string => !!g));
    if (ids.size === 0) return null;
    const restricted = (await getAllLibraryGroupPermissions(sql)).some(
        (row) => ids.has(row.library_group_id) && row.allowed_groups.length > 0,
    );
    return restricted ? ApiProblem.scopeRequired(['access:admin']) : null;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateLibraryFolder(
    sql: postgres.Sql,
    id: string,
    body: UpdateLibraryPathParams,
    scopes: readonly string[] | undefined,
): Promise<FolderResult<LibraryPathRow>> {
    // A non-UUID id reached `WHERE id = $1` (uuid) as a 500.
    if (!UUID_RE.test(id)) {
        return { ok: false, problem: ApiProblem.notFound('Library path not found') };
    }
    const current = await getLibraryPathById(sql, id);
    if (!current) return { ok: false, problem: ApiProblem.notFound('Library path not found') };

    const patch: UpdateLibraryPathParams = { ...body };
    const { library_group_id, media_type } = patch;

    // Remote-provider rows: `path` is the row's identity end to end and
    // `provider_path` the only key the connector resolves libraries from, so
    // for a remote row both are derived, never edited.
    const touchesIdentity = patch.path !== undefined || patch.provider_path !== undefined;
    const targetProvider = patch.provider ?? current.provider;
    if (touchesIdentity && isRemoteLibraryProvider(targetProvider)) {
        return {
            ok: false,
            problem: ApiProblem.validationFailed(
                `path and provider_path are derived for the ${targetProvider} provider and cannot be changed. Remove this library and add the other one instead.`,
            ),
        };
    }
    // A provider change across the filesystem/remote boundary would leave a
    // remote row holding a disk path (or hand `abs://<id>` to the scanner).
    if (
        patch.provider !== undefined &&
        isRemoteLibraryProvider(patch.provider) !== isRemoteLibraryProvider(current.provider)
    ) {
        return {
            ok: false,
            problem: ApiProblem.validationFailed(
                `Cannot change a library's provider between ${current.provider} and ${patch.provider}: the two address their libraries differently (a folder path versus a derived remote sentinel). Remove this library and add it again under the other source.`,
            ),
        };
    }

    // A new folder path follows the same rules as a new folder.
    if (patch.path !== undefined && !isRemoteLibraryProvider(targetProvider)) {
        const checked = await checkLibraryRootForApi(sql, patch.path, { excludeId: id });
        if ('problem' in checked) return { ok: false, problem: checked.problem };
        patch.path = checked.path;
    }

    if (
        library_group_id !== undefined &&
        (!UUID_RE.test(library_group_id) || !(await getLibraryGroupById(sql, library_group_id)))
    ) {
        return { ok: false, problem: ApiProblem.validationFailed('Library group not found') };
    }

    const targetGroupId = library_group_id ?? current.library_group_id;
    const targetMediaType = media_type ?? current.media_type;

    if (library_group_id !== undefined && library_group_id !== current.library_group_id) {
        const denied = await requireAccessScopeIfRestricted(
            sql,
            [current.library_group_id, library_group_id],
            scopes,
        );
        if (denied) return { ok: false, problem: denied };
    }

    // Only a CHANGE to audiobook is refused. A local audiobook folder created
    // before this check existed stays editable.
    if (
        targetMediaType !== current.media_type &&
        isLocalAudiobookLibrary(targetMediaType, targetProvider)
    ) {
        return { ok: false, problem: ApiProblem.validationFailed(LOCAL_AUDIOBOOK_LIBRARY_ERROR) };
    }

    if (
        library_group_id !== undefined ||
        media_type !== undefined ||
        patch.provider !== undefined ||
        patch.fallback_providers !== undefined
    ) {
        const groupError = await validateGroupConsistency(sql, targetGroupId, targetMediaType, id);
        if (groupError) return { ok: false, problem: ApiProblem.validationFailed(groupError) };
        const providerError = await validateGroupProviderConsistency(
            sql,
            targetGroupId,
            targetProvider,
            patch.fallback_providers ?? current.fallback_providers,
            id,
        );
        if (providerError) {
            return { ok: false, problem: ApiProblem.validationFailed(providerError) };
        }
    }

    // A move to another library carries the files already scanned under this
    // folder with it, in the same transaction: access is decided per file.
    let updated: LibraryPathRow | null;
    try {
        updated = await withTx(sql, async (tx: postgres.Sql) => {
            const before = await getLibraryPathById(tx, id);
            const row = await updateLibraryPath(tx, id, patch);
            if (row && before && before.library_group_id !== row.library_group_id) {
                await restampLibraryPathFileGroups(tx, row.path, row.library_group_id);
            }
            if (
                row?.provider === 'audiobookshelf' &&
                before &&
                (before.language !== row.language ||
                    before.library_group_id !== row.library_group_id)
            ) {
                await refreshAudiobookLibrarySettings(
                    tx,
                    row.id,
                    row.language,
                    before.library_group_id !== row.library_group_id
                        ? row.library_group_id
                        : undefined,
                );
            }
            // Disabling an ABS source removes it from the sweep, which then never
            // revisits its books: retire them here, as a delete does. Re-enabling
            // needs no write; the next sweep clears the dismissal when the item
            // comes back from ABS.
            if (row?.provider === 'audiobookshelf' && before?.enabled && !row.enabled) {
                await retireAudiobookLibraryPath(tx, row.id);
            }
            return row;
        });
    } catch (err) {
        // UNIQUE(path) / UNIQUE(provider_path) — a race past the root check.
        if (!isUniqueViolation(err)) throw err;
        return {
            ok: false,
            problem: ApiProblem.conflict(
                'Another library folder already uses that path or provider path.',
            ),
        };
    }
    if (!updated) return { ok: false, problem: ApiProblem.notFound('Library path not found') };

    await afterLibraryPathChanged(sql);
    return { ok: true, value: updated };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export interface DeleteLibraryFolderResult {
    /** Files scanned under the folder that the background detach will retire. */
    filesToDetach: number;
    /** The detach run, when one was started. */
    detachRunId?: string;
    /** Scans of this folder that were cancelled (force only). */
    scansCancelled: number;
    /** Uploads into this folder that were aborted (force only). */
    uploadsAborted: number;
}

interface FolderActivity {
    scanRunIds: string[];
    uploadIds: string[];
}

async function activityFor(sql: postgres.Sql, row: LibraryPathRow): Promise<FolderActivity> {
    const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');
    const { runs } = await orchestrator.listRuns({
        taskId: 'file-library-scan',
        state: ['active', 'pending', 'cancelling'],
        limit: 200,
    });
    const scanRunIds = runs
        .filter(
            (run) => (run.input as { libraryPathId?: unknown } | null)?.libraryPathId === row.id,
        )
        .map((run) => run.id);
    const uploads = await sql<{ id: string }[]>`
        SELECT id FROM upload_sessions
        WHERE library_path_id = ${row.id}
          AND status IN ('uploading', 'assembling')
    `;
    return { scanRunIds, uploadIds: uploads.map((u) => u.id) };
}

/**
 * Removes a library folder as an operation, not a bare row drop:
 *  - refuses (409) while a scan of the folder runs or an upload into it is in
 *    flight, unless `force` — then the scans are cancelled and the uploads
 *    aborted first;
 *  - after the row is gone, retires the files scanned under it the way the
 *    scanner retires a file that vanished from disk (`deleteStaleMediaFile`:
 *    file rows removed, items left without files dismissed, user data kept),
 *    in a background run. Before this the items stayed listed but could not
 *    play (the folder left the read sandbox), and no scan ever revisited them.
 */
export async function deleteLibraryFolder(
    sql: postgres.Sql,
    id: string,
    opts: { force?: boolean; scopes?: readonly string[]; actor?: string },
): Promise<FolderResult<DeleteLibraryFolderResult>> {
    if (!UUID_RE.test(id)) {
        return { ok: false, problem: ApiProblem.notFound('Library path not found') };
    }
    const row = await getLibraryPathById(sql, id);
    if (!row) return { ok: false, problem: ApiProblem.notFound('Library path not found') };

    // The folder's files leave its library: an access change when restricted.
    const denied = await requireAccessScopeIfRestricted(sql, [row.library_group_id], opts.scopes);
    if (denied) return { ok: false, problem: denied };

    const activity = await activityFor(sql, row);
    const busy = activity.scanRunIds.length > 0 || activity.uploadIds.length > 0;
    if (busy && !opts.force) {
        return {
            ok: false,
            problem: ApiProblem.conflict(
                `This library folder is busy (${activity.scanRunIds.length} scan(s), ${activity.uploadIds.length} upload(s) in progress). Wait for them to finish or delete with force.`,
            ),
        };
    }

    let scansCancelled = 0;
    let uploadsAborted = 0;
    if (busy) {
        const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');
        for (const runId of activity.scanRunIds) {
            const res = await orchestrator.cancelRun(runId, {
                reason: `library folder deleted by ${opts.actor ?? 'admin'}`,
            });
            if (res.accepted) scansCancelled++;
        }
        try {
            const { requestFileScannerAbortForKey } =
                await import('$lib/server/tasks/builtin/native/media-sources/file-scanner.js');
            requestFileScannerAbortForKey(row.id);
        } catch {
            // best-effort in-process nudge
        }
        const { abortUpload } = await import('$lib/server/services/upload-session.service.js');
        const { getUploadSessionById } =
            await import('$lib/server/database/queries/upload-sessions.queries.js');
        for (const uploadId of activity.uploadIds) {
            const session = await getUploadSessionById(sql, uploadId);
            if (!session) continue;
            await abortUpload(sql, session);
            uploadsAborted++;
        }
    }

    const isFilesystem = !isRemoteLibraryProvider(row.provider) && row.path.startsWith('/');
    const [{ n: filesToDetach }] = isFilesystem
        ? await sql<{ n: number }[]>`
              SELECT COUNT(*)::int AS n FROM media_files
              WHERE file_path = ${row.path} OR starts_with(file_path, ${row.path} || '/')
          `
        : [{ n: 0 }];

    const deleted = await withTx(sql, async (tx) => {
        const removed = await deleteLibraryPath(tx, id);
        if (removed && row.provider === 'audiobookshelf') await retireAudiobookLibraryPath(tx, id);
        return removed;
    });
    if (!deleted) return { ok: false, problem: ApiProblem.notFound('Library path not found') };
    await afterLibraryPathChanged(sql);

    let detachRunId: string | undefined;
    if (filesToDetach > 0) {
        try {
            const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');
            const started = await orchestrator.startRun(
                'library-folder-detach',
                { path: row.path },
                { trigger: { kind: 'in-process', sourceRoute: 'library-folder.delete' } },
            );
            detachRunId = started.runId;
        } catch (err) {
            // The row is gone either way; the run can be started again from
            // the task page with { path }.
            logger.error('Could not start the detach run for a deleted library folder', {
                path: row.path,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return {
        ok: true,
        value: { filesToDetach, detachRunId, scansCancelled, uploadsAborted },
    };
}

// ---------------------------------------------------------------------------
// Library (group) delete
// ---------------------------------------------------------------------------

/**
 * Deletes a library group, shared by the admin and v1 surfaces. Refuses while
 * the library still has folders (library_paths → library_groups is ON DELETE
 * RESTRICT, which used to surface as a 500), and needs `access:admin` when the
 * library is restricted: its permission row cascades away with it.
 */
export async function deleteLibraryGroupChecked(
    sql: postgres.Sql,
    id: string,
    scopes: readonly string[] | undefined,
): Promise<FolderResult<true>> {
    if (!UUID_RE.test(id)) {
        return { ok: false, problem: ApiProblem.notFound('Library group not found') };
    }
    const { getLibraryPathsByGroup } =
        await import('$lib/server/database/queries/library-paths.queries.js');
    if ((await getLibraryPathsByGroup(sql, id)).length > 0) {
        return {
            ok: false,
            problem: ApiProblem.conflict(
                'This library still has folders. Remove its folders before deleting it.',
            ),
        };
    }
    const denied = await requireAccessScopeIfRestricted(sql, [id], scopes);
    if (denied) return { ok: false, problem: denied };

    const { deleteLibraryGroup } =
        await import('$lib/server/database/queries/library-groups.queries.js');
    const deleted = await withTx(sql, async (tx) => {
        await preserveAudiobookLibraryAgeRating(tx, id);
        return deleteLibraryGroup(tx, id);
    });
    if (!deleted) {
        return { ok: false, problem: ApiProblem.notFound('Library group not found') };
    }
    const { afterLibraryGroupChanged } =
        await import('$lib/server/services/library-path-sync.service.js');
    await afterLibraryGroupChanged();
    return { ok: true, value: true };
}
