// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Composite "create a library" service. A library = one library_group plus one
// or more library_paths that all share the group's single media_type (a group
// may not mix media types — enforced application-side, see
// validateGroupConsistency). The group + every path are written in ONE
// transaction so a partial failure can't leave an empty group or orphaned
// paths. Cache/watcher side-effects run AFTER commit.
//
// Why a service (not a route): per the three-tier rule, multi-table writes and
// transactions live in services, not query modules or routes.

import type postgres from 'postgres';
import { resolveLibraryLanguage } from './library-language.js';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    createLibraryGroup,
    type LibraryGroupRow,
} from '$lib/server/database/queries/library-groups.queries';
import {
    createLibraryPath,
    normalizeLibraryPath,
    type LibraryPathRow,
    type LibraryPathMediaType,
    type LibraryPathProvider,
} from '$lib/server/database/queries/library-paths.queries';
import {
    afterLibraryGroupChanged,
    afterLibraryPathChanged,
} from '$lib/server/services/library-path-sync.service';
import { Logger } from '$lib/server/utils/logger';
import {
    isLocalAudiobookLibrary,
    LOCAL_AUDIOBOOK_LIBRARY_ERROR,
} from '$lib/shared/remote-library-sources';
import {
    assertLibraryRootAllowed,
    LibraryRootRejectedError,
} from '$lib/server/services/library-root-validation.js';
import { isRemoteLibraryProvider } from '$lib/server/services/remote-library-sources.js';

const logger = Logger.for('LibrarySetup');

/** Postgres unique-constraint violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: string }).code === '23505'
    );
}

export interface CreateLibraryPathInput {
    path: string;
    language?: string;
    provider?: LibraryPathProvider;
    fallback_providers?: LibraryPathProvider[];
    provider_path?: string | null;
    edition_label?: string | null;
    scan_chapters?: boolean;
}

export interface CreateLibraryInput {
    name: string;
    /** Applied to every path — the group's single media type. */
    media_type: LibraryPathMediaType;
    description?: string;
    icon?: string;
    sort_order?: number;
    max_age_rating?: number | null;
    metadata_provider_chain?: string[] | null;
    paths: CreateLibraryPathInput[];
}

export interface CreateLibraryResult {
    group: LibraryGroupRow;
    paths: LibraryPathRow[];
}

/**
 * Create a library group and all its paths atomically. Returns the created
 * group and paths. Throws if `paths` is empty or contains duplicate path
 * strings (caught by the route → 400). On success, refreshes browse caches and
 * the file-scanner watcher so the new library scans without a restart.
 */
/** A request the operator can fix (bad or conflicting folders): the API answers 4xx. */
export class LibrarySetupValidationError extends Error {
    constructor(
        message: string,
        readonly conflict = false,
        options?: { cause?: unknown },
    ) {
        super(message, options);
        this.name = 'LibrarySetupValidationError';
    }
}

export async function createLibrary(
    sql: postgres.Sql,
    input: CreateLibraryInput,
): Promise<CreateLibraryResult> {
    if (input.paths.length === 0) {
        throw new LibrarySetupValidationError('A library needs at least one folder path');
    }
    if (input.paths.some((p) => isLocalAudiobookLibrary(input.media_type, p.provider ?? 'tmdb'))) {
        throw new LibrarySetupValidationError(LOCAL_AUDIOBOOK_LIBRARY_ERROR);
    }
    // Remote sources (e.g. AudiobookShelf) are added through the folder
    // endpoint, which checks the remote library and derives the row's
    // identity; here they would become a remote row holding a disk path.
    if (input.paths.some((p) => isRemoteLibraryProvider(p.provider ?? 'tmdb'))) {
        throw new LibrarySetupValidationError(
            'Remote libraries are added as a folder of an existing library, not through library setup.',
        );
    }
    // Normalize once and reuse — the same normalizeLibraryPath() the insert and
    // the setup wizard apply — so dedup sees what will be stored: "/media",
    // "/media " and "/media/" are one folder, not a UNIQUE(path) error mid-insert.
    const cleanedPaths = input.paths.map((p) => ({
        ...p,
        path: normalizeLibraryPath(p.path),
    }));
    const seen = new Set<string>();
    for (const p of cleanedPaths) {
        if (seen.has(p.path)) {
            throw new LibrarySetupValidationError(`Duplicate folder path in request: ${p.path}`);
        }
        seen.add(p.path);
    }
    // Each folder follows the same server-side rules as a folder added on its
    // own (absolute, exists, not '/', inside LIBRARY_ALLOWED_ROOTS, no overlap
    // with an existing library folder) — and the new folders must not overlap
    // each other either.
    for (const p of cleanedPaths) {
        try {
            p.path = await assertLibraryRootAllowed(sql, p.path);
        } catch (err) {
            if (!(err instanceof LibraryRootRejectedError)) throw err;
            throw new LibrarySetupValidationError(
                err.message,
                err.reason === 'duplicate' || err.reason === 'overlaps',
            );
        }
    }
    for (const a of cleanedPaths) {
        for (const b of cleanedPaths) {
            if (a !== b && b.path.startsWith(`${a.path}/`)) {
                throw new LibrarySetupValidationError(
                    `"${b.path}" is inside "${a.path}". Library folders cannot contain one another.`,
                );
            }
        }
    }

    let result: CreateLibraryResult;
    try {
        result = await withTx(sql, async (tx: postgres.Sql) => {
            const group = await createLibraryGroup(tx, {
                name: input.name,
                description: input.description,
                icon: input.icon,
                sort_order: input.sort_order,
                max_age_rating: input.max_age_rating ?? null,
                metadata_provider_chain: input.metadata_provider_chain ?? null,
            });

            const paths: LibraryPathRow[] = [];
            for (const p of cleanedPaths) {
                // Every path inherits the library's single media_type, so the
                // group stays internally consistent by construction (no mixing).
                paths.push(
                    await createLibraryPath(tx, {
                        path: p.path,
                        media_type: input.media_type,
                        language: resolveLibraryLanguage(p.language, p.provider),
                        provider: p.provider,
                        fallback_providers: p.fallback_providers,
                        provider_path: p.provider_path ?? null,
                        edition_label: p.edition_label ?? null,
                        scan_chapters: p.scan_chapters,
                        library_group_id: group.id,
                    }),
                );
            }

            return { group, paths };
        });
    } catch (err) {
        // library_paths has UNIQUE(path) — surface a clean operator message
        // instead of a raw Postgres constraint string. The transaction has
        // already rolled back, so no partial library remains.
        if (isUniqueViolation(err)) {
            throw new LibrarySetupValidationError(
                'One of these folders is already part of another library. Remove it or pick a different folder.',
                true,
                { cause: err },
            );
        }
        throw err;
    }

    // Side-effects AFTER commit (the new rows are durable now). afterLibrary
    // PathChanged also kicks the file-scanner watcher so paths start scanning.
    await afterLibraryGroupChanged();
    await afterLibraryPathChanged(sql);

    logger.info('Created library', {
        groupId: result.group.id,
        name: result.group.name,
        mediaType: input.media_type,
        pathCount: result.paths.length,
    });

    return result;
}
