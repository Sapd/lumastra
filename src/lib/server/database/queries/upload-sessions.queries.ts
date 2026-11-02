// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Query module for upload_sessions (migration 16.96.0).
 *
 * All functions take `sql: postgres.Sql` as the first parameter and have
 * no side effects beyond the stated SQL operation.
 */

import type postgres from 'postgres';

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

export type UploadSessionStatus = 'uploading' | 'assembling' | 'queued' | 'failed' | 'aborted';

export interface UploadSessionRow {
    id: string;
    library_path_id: string;
    uploader_user: string;
    filename: string;
    final_path?: string | null;
    mime_type: string;
    total_size: number; // BIGINT — postgres driver returns number for values < 2^53
    total_chunks: number;
    chunks_received: number;
    destination_folder: string;
    staging_dir: string;
    status: UploadSessionStatus;
    error_message: string | null;
    media_item_id: string | null;
    sha256_expected: string | null;
    sha256_actual: string | null;
    created_at: Date;
    updated_at: Date;
    expires_at: Date;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateUploadSessionParams {
    library_path_id: string;
    uploader_user: string;
    filename: string;
    mime_type: string;
    total_size: number;
    total_chunks: number;
    destination_folder: string;
    staging_dir: string;
    sha256_expected?: string | null;
}

export async function createUploadSession(
    sql: postgres.Sql,
    params: CreateUploadSessionParams,
): Promise<UploadSessionRow> {
    const rows = await sql<UploadSessionRow[]>`
        INSERT INTO upload_sessions (
            library_path_id,
            uploader_user,
            filename,
            mime_type,
            total_size,
            total_chunks,
            destination_folder,
            staging_dir,
            sha256_expected
        ) VALUES (
            ${params.library_path_id},
            ${params.uploader_user},
            ${params.filename},
            ${params.mime_type},
            ${params.total_size},
            ${params.total_chunks},
            ${params.destination_folder},
            ${params.staging_dir},
            ${params.sha256_expected ?? null}
        )
        RETURNING *
    `;
    const row = rows[0];
    if (!row) throw new Error('INSERT upload_sessions returned no row');
    return row;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getUploadSessionById(
    sql: postgres.Sql,
    id: string,
): Promise<UploadSessionRow | null> {
    const rows = await sql<UploadSessionRow[]>`
        SELECT * FROM upload_sessions WHERE id = ${id} LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Returns expired sessions, protecting assemblies updated within six hours.
 *
 * NOTE: 'queued' rows also need cleanup — a successfully finalized session sets
 * status='queued' (staging dir removed, but DB row remains). Including 'queued'
 * and 'aborted' here ensures permanent row accumulation is prevented.
 */
export async function findExpiredUploadSessions(
    sql: postgres.Sql,
    cutoff: Date,
    limit = 100,
): Promise<UploadSessionRow[]> {
    return sql<UploadSessionRow[]>`
        SELECT *
        FROM upload_sessions
        WHERE expires_at < ${cutoff}
          AND (status <> 'assembling' OR updated_at < ${cutoff}::timestamptz - INTERVAL '6 hours')
        ORDER BY expires_at ASC
        LIMIT ${limit}
    `;
}

/** Claim cleanup before touching disk; a concurrent assembly claim must win or lose atomically. */
export async function deleteExpiredUploadSession(
    sql: postgres.Sql,
    id: string,
    cutoff: Date,
): Promise<boolean> {
    const rows = await sql`
        DELETE FROM upload_sessions
        WHERE id = ${id} AND expires_at < ${cutoff}
          AND (status <> 'assembling' OR updated_at < ${cutoff}::timestamptz - INTERVAL '6 hours')
        RETURNING id
    `;
    return rows.length > 0;
}

/**
 * Returns the number of upload sessions that are currently active (in the
 * 'uploading' or 'assembling' state) for a given user.
 *
 * Used to enforce a per-user concurrent session cap before creating a new session.
 */
export async function countActiveUploadSessionsForUser(
    sql: postgres.Sql,
    uploaderUser: string,
): Promise<number> {
    const rows = await sql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n
        FROM upload_sessions
        WHERE uploader_user = ${uploaderUser}
          AND status IN ('uploading', 'assembling')
    `;
    return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function incrementChunksReceived(
    sql: postgres.Sql,
    id: string,
): Promise<number | null> {
    const rows = await sql<{ chunks_received: number }[]>`
        UPDATE upload_sessions
        SET chunks_received = chunks_received + 1,
            updated_at      = NOW(),
            -- A slow multi-GB upload can run past the 24h creation-time expiry;
            -- the sweeper would then delete the staging dir under it. Activity
            -- keeps the session alive.
            expires_at      = GREATEST(expires_at, NOW() + INTERVAL '24 hours')
        WHERE id = ${id}
          AND status = 'uploading'
        RETURNING chunks_received
    `;
    return rows[0]?.chunks_received ?? null;
}

export async function setUploadSessionStatus(
    sql: postgres.Sql,
    id: string,
    status: UploadSessionStatus,
    errorMessage?: string | null,
): Promise<void> {
    await sql`
        UPDATE upload_sessions
        SET status        = ${status},
            error_message = ${errorMessage ?? null},
            updated_at    = NOW()
        WHERE id = ${id}
    `;
}

/**
 * Atomically transitions an upload session from 'uploading' → 'assembling'.
 *
 * Returns true if the row was claimed (transition succeeded), false if the
 * session was already in a different state (concurrent finalize in progress,
 * already assembled, aborted, etc.).  Uses a conditional UPDATE … RETURNING
 * so the check-and-set is atomic under concurrent requests.
 */
export async function claimUploadSessionForAssembly(
    sql: postgres.Sql,
    id: string,
): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        UPDATE upload_sessions
        SET status     = 'assembling',
            updated_at = NOW(),
            expires_at = GREATEST(expires_at, NOW() + INTERVAL '6 hours')
        WHERE id     = ${id}
          AND status = 'uploading'
        RETURNING id
    `;
    return rows.length > 0;
}

/**
 * Hands an 'assembling' session back to 'uploading' after a finalize attempt
 * failed (ENOSPC, hash mismatch, target exists, …). Without this the session
 * stays 'assembling' forever: every retry gets 409 and it keeps counting
 * against the per-user session cap until the expiry sweep.
 */
export async function releaseUploadSessionAssemblyClaim(
    sql: postgres.Sql,
    id: string,
    errorMessage: string,
): Promise<void> {
    await sql`
        UPDATE upload_sessions
        SET status        = 'uploading',
            error_message = ${errorMessage},
            updated_at    = NOW()
        WHERE id     = ${id}
          AND status = 'assembling'
    `;
}

export async function finalizeUploadSession(
    sql: postgres.Sql,
    id: string,
    sha256Actual: string | null,
    mediaItemId?: string | null,
    finalPath?: string,
): Promise<void> {
    await sql`
        UPDATE upload_sessions
        SET status        = 'queued',
            sha256_actual = ${sha256Actual ?? null},
            media_item_id = COALESCE(${mediaItemId ?? null},media_item_id),
            final_path = COALESCE(${finalPath ?? null},final_path),
            updated_at    = NOW()
        WHERE id = ${id}
    `;
}

export async function abortUploadSession(sql: postgres.Sql, id: string): Promise<void> {
    await sql`
        UPDATE upload_sessions
        SET status     = 'aborted',
            updated_at = NOW()
        WHERE id = ${id}
          AND status IN ('uploading', 'assembling', 'failed')
    `;
}

/** Hard-delete a session row (called after staging dir has been cleaned up). */
export async function deleteUploadSession(sql: postgres.Sql, id: string): Promise<void> {
    await sql`DELETE FROM upload_sessions WHERE id = ${id}`;
}

/** Hard-delete all sessions older than cutoff — returns count deleted. */
export async function pruneExpiredUploadSessions(
    sql: postgres.Sql,
    cutoff: Date,
    limit = 100,
): Promise<number> {
    const result = await sql<{ count: string }[]>`
        WITH expired AS (
            SELECT id FROM upload_sessions
            WHERE expires_at < ${cutoff}
            ORDER BY expires_at ASC
            LIMIT ${limit}
        )
        DELETE FROM upload_sessions
        WHERE id IN (SELECT id FROM expired)
        RETURNING 1
    `;
    return result.length;
}

/** All library roots may contain the default .upload-staging directory. */
export async function uploadStagingLibraryRoots(sql: postgres.Sql): Promise<string[]> {
    const rows = await sql<{ path: string }[]>`SELECT path FROM library_paths`;
    return rows.map((row) => row.path);
}

/** Protect any session owning a staging directory, irrespective of status or expiry. */
export async function hasUploadStagingSession(
    sql: postgres.Sql,
    path: string,
    directoryName: string,
): Promise<boolean> {
    const rows =
        await sql`SELECT 1 FROM upload_sessions WHERE staging_dir = ${path} OR id::text = ${directoryName} LIMIT 1`;
    return rows.length > 0;
}
