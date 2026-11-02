// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Query module for `download_renditions` — the cached-artifact inventory behind
 * offline downloads. See migration 16.201.0 for why the table is shaped this way.
 *
 * Pure SQL only: election, state transitions and the reaper's bookkeeping. All
 * process orchestration (spawning ffmpeg, following another pod's encode) lives
 * in `services/download-rendition/`.
 */

import type postgres from 'postgres';

export type RenditionStatus = 'queued' | 'encoding' | 'ready' | 'failed';

export interface DownloadRenditionRow {
    id: string;
    file_id: string;
    media_item_id: string;
    rung_id: string;
    /** Encoded audio track, or null for a video-only artifact (encoded `-an`). */
    audio_index: number | null;
    status: RenditionStatus;
    progress_pct: number;
    size_bytes: string | null;
    artifact_name: string | null;
    error_code: string | null;
    /** Pod identity plus a unique encode-attempt token; also fences late writers. */
    owner_pod: string | null;
    heartbeat_at: Date | null;
    created_at: Date;
    updated_at: Date;
    last_accessed_at: Date;
}

const COLUMNS = `
    id, file_id, media_item_id, rung_id, audio_index, status, progress_pct,
    size_bytes::text AS size_bytes, artifact_name, error_code, owner_pod,
    heartbeat_at, created_at, updated_at, last_accessed_at
`;

/**
 * Claim the right to encode one (file, rung, audio track), or discover who
 * already holds it.
 *
 * `elected: true` means THIS caller inserted the row and must run the encode.
 * The `ON CONFLICT DO NOTHING` makes that true for exactly one caller across
 * every replica — the unique constraint is the election, so there is no lock to
 * leak if the winner dies (a stale owner is recovered by
 * {@link reclaimStaleEncode} instead).
 *
 * `elected: false` returns the existing row, which may be in any state: another
 * pod encoding it, a finished artifact to serve immediately, or a previous
 * failure the caller can choose to retry.
 */
/** How many times the election may lose to a concurrent reap before giving up. */
const MAX_ELECTION_ATTEMPTS = 3;

export async function electOrGetRendition(
    sql: postgres.Sql,
    params: {
        fileId: string;
        mediaItemId: string;
        rungId: string;
        audioIndex: number | null;
        podId: string;
    },
    attempt = 0,
): Promise<{ row: DownloadRenditionRow; elected: boolean }> {
    const inserted = await sql<DownloadRenditionRow[]>`
        INSERT INTO download_renditions
            (file_id, media_item_id, rung_id, audio_index, status, owner_pod, heartbeat_at)
        VALUES
            (${params.fileId}, ${params.mediaItemId}, ${params.rungId}, ${params.audioIndex},
             'queued', ${params.podId}, NOW())
        ON CONFLICT (file_id, rung_id, audio_index) DO NOTHING
        RETURNING ${sql.unsafe(COLUMNS)}
    `;

    if (inserted.length > 0) {
        return { row: inserted[0], elected: true };
    }

    const existing = await getRenditionByKey(sql, params.fileId, params.rungId, params.audioIndex);
    if (!existing) {
        // The winner's row was deleted between our INSERT and this SELECT — a
        // reap racing a request. Retry: the table is now empty for this key,
        // so the recursive call takes the INSERT branch.
        //
        // The bound is what makes this a retry rather than a hope. The comment
        // said "retry once" and nothing enforced it, so a reap that keeps
        // winning the race recurses without limit — a stack overflow inside a
        // request handler, on a path whose whole job is to be racy.
        if (attempt >= MAX_ELECTION_ATTEMPTS) {
            throw new Error(
                `electOrGetRendition: lost the election race ${MAX_ELECTION_ATTEMPTS} times for ` +
                    `file ${params.fileId} rung ${params.rungId} audio ${params.audioIndex}`,
            );
        }
        return electOrGetRendition(sql, params, attempt + 1);
    }
    return { row: existing, elected: false };
}

export async function getRendition(
    sql: postgres.Sql,
    id: string,
): Promise<DownloadRenditionRow | null> {
    const rows = await sql<DownloadRenditionRow[]>`
        SELECT ${sql.unsafe(COLUMNS)} FROM download_renditions WHERE id = ${id}
    `;
    return rows[0] ?? null;
}

export async function getRenditionByKey(
    sql: postgres.Sql,
    fileId: string,
    rungId: string,
    audioIndex: number | null,
): Promise<DownloadRenditionRow | null> {
    const rows = await sql<DownloadRenditionRow[]>`
        SELECT ${sql.unsafe(COLUMNS)} FROM download_renditions
        WHERE file_id = ${fileId} AND rung_id = ${rungId}
          -- NOT \`=\`. A video-only rendition stores NULL here, and \`= NULL\` is
          -- never true: the lookup would report "absent" for a row that exists,
          -- immediately after ON CONFLICT suppressed the insert because it does.
          -- electOrGetRendition would then lose its own race every attempt and
          -- throw. Reproduced live before this line existed.
          AND audio_index IS NOT DISTINCT FROM ${audioIndex}
    `;
    return rows[0] ?? null;
}

/** Every rendition known for a file — powers the picker's per-rung status. */
export async function listRenditionsForFile(
    sql: postgres.Sql,
    fileId: string,
): Promise<DownloadRenditionRow[]> {
    return sql<DownloadRenditionRow[]>`
        SELECT ${sql.unsafe(COLUMNS)} FROM download_renditions
        WHERE file_id = ${fileId}
        -- NULL (video-only) sorts last within a rung. Nothing reads this order
        -- for meaning; the picker keys by rung id.
        ORDER BY rung_id, audio_index
    `;
}

/** The owner token is fixed at election/takeover, never overwritten by a late encoder. */
export async function markEncoding(
    sql: postgres.Sql,
    id: string,
    ownerToken: string,
): Promise<boolean> {
    const rows = await sql`
        UPDATE download_renditions
        SET status = 'encoding', heartbeat_at = NOW(), updated_at = NOW()
        WHERE id = ${id} AND owner_pod = ${ownerToken} AND status IN ('queued', 'encoding')
        RETURNING id
    `;
    return rows.length > 0;
}

/** Progress and liveness, called by both progress events and the process timer. */
export async function updateProgress(
    sql: postgres.Sql,
    id: string,
    progressPct: number,
    ownerToken: string,
): Promise<boolean> {
    const rows = await sql`
        UPDATE download_renditions
        SET progress_pct = ${progressPct}, heartbeat_at = NOW(), updated_at = NOW()
        WHERE id = ${id} AND owner_pod = ${ownerToken} AND status IN ('queued', 'encoding')
        RETURNING id
    `;
    return rows.length > 0;
}

export async function markReady(
    sql: postgres.Sql,
    id: string,
    artifactName: string,
    sizeBytes: number,
    ownerToken: string,
): Promise<boolean> {
    const rows = await sql`
        UPDATE download_renditions
        SET status = 'ready', progress_pct = 100, artifact_name = ${artifactName},
            size_bytes = ${sizeBytes}, error_code = NULL, heartbeat_at = NULL,
            updated_at = NOW(), last_accessed_at = NOW()
        WHERE id = ${id} AND owner_pod = ${ownerToken} AND status IN ('queued', 'encoding')
        RETURNING id
    `;
    return rows.length > 0;
}

export async function markFailed(
    sql: postgres.Sql,
    id: string,
    errorCode: string,
    ownerToken: string,
): Promise<void> {
    await sql`
        UPDATE download_renditions
        SET status = 'failed', error_code = ${errorCode}, heartbeat_at = NULL, updated_at = NOW()
        WHERE id = ${id} AND owner_pod = ${ownerToken} AND status IN ('queued', 'encoding')
    `;
}

/**
 * Bump the LRU clock. Called on status polls and on every byte range served, so
 * an in-progress multi-hour download cannot be reaped out from under itself.
 */
export async function touchRendition(sql: postgres.Sql, id: string): Promise<void> {
    await sql`
        UPDATE download_renditions SET last_accessed_at = NOW() WHERE id = ${id}
    `;
}

/**
 * Re-elect an encode whose owner stopped heartbeating (pod killed mid-encode).
 *
 * Guarded on the stale heartbeat, so two replicas
 * racing to adopt the same corpse cannot both win. Returns true if this pod took
 * it over and must (re-)run the encode.
 */
export async function reclaimStaleEncode(
    sql: postgres.Sql,
    id: string,
    podId: string,
    staleAfterSeconds: number,
): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        UPDATE download_renditions
        SET owner_pod = ${podId}, heartbeat_at = NOW(), status = 'queued',
            progress_pct = 0, updated_at = NOW()
        WHERE id = ${id}
          AND status IN ('queued', 'encoding')
          AND (heartbeat_at IS NULL OR heartbeat_at < NOW() - MAKE_INTERVAL(secs => ${staleAfterSeconds}))
        RETURNING id
    `;
    return rows.length > 0;
}

/** Reset a failed rendition so a client-initiated retry re-runs the encode. */
export async function reopenFailed(sql: postgres.Sql, id: string, podId: string): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        UPDATE download_renditions
        SET status = 'queued', progress_pct = 0, error_code = NULL,
            owner_pod = ${podId}, heartbeat_at = NOW(), updated_at = NOW()
        WHERE id = ${id} AND status = 'failed'
        RETURNING id
    `;
    return rows.length > 0;
}

export async function totalCachedBytes(sql: postgres.Sql): Promise<number> {
    const rows = await sql<{ total: string }[]>`
        SELECT COALESCE(SUM(size_bytes), 0)::text AS total
        FROM download_renditions WHERE status = 'ready'
    `;
    return Number(rows[0]?.total ?? 0);
}

/**
 * Coldest ready artifacts first — the reaper deletes down the list until the
 * cache is back under budget.
 */
export async function evictionCandidates(
    sql: postgres.Sql,
    limit: number,
    /**
     * Renditions touched within this many seconds are not offered as
     * candidates.
     *
     * The reaper's only other protection is a per-PROCESS in-flight set, which
     * knows nothing about a download being served by a different replica — so
     * on a multi-pod deployment it will happily unlink a multi-gigabyte file
     * another pod is streaming, mid-transfer. `last_accessed_at` is stamped in
     * the database by the serve path itself, which makes it the one signal
     * every pod shares. A long download keeps re-touching as it pulls ranges,
     * so the window only has to outlast the gap between range requests, not
     * the download.
     */
    recentlyServedGraceSeconds = 900,
): Promise<DownloadRenditionRow[]> {
    return sql<DownloadRenditionRow[]>`
        SELECT ${sql.unsafe(COLUMNS)} FROM download_renditions
        WHERE status = 'ready'
          AND (
                last_accessed_at IS NULL
                OR last_accessed_at < NOW() - MAKE_INTERVAL(secs => ${recentlyServedGraceSeconds})
              )
        ORDER BY last_accessed_at ASC
        LIMIT ${limit}
    `;
}

/**
 * Drop the inventory row. The caller unlinks the file first: a row without a file
 * is a 404 the client can recover from by re-requesting, whereas a file without a
 * row is unreachable bytes nothing will ever reclaim.
 */
export async function deleteRendition(sql: postgres.Sql, id: string): Promise<void> {
    await sql`DELETE FROM download_renditions WHERE id = ${id}`;
}

/** Rows whose artifact the reaper should verify — used to detect orphaned files. */
export async function listReadyRenditions(sql: postgres.Sql): Promise<DownloadRenditionRow[]> {
    return sql<DownloadRenditionRow[]>`
        SELECT ${sql.unsafe(COLUMNS)} FROM download_renditions WHERE status = 'ready'
    `;
}

export interface ReadyRenditionSize {
    file_id: string;
    /** BIGINT as text — same convention as `DownloadRenditionRow.size_bytes`. */
    size_bytes: string;
    /** Ready rows for this (file, rung) across audio tracks. */
    ready_count: number;
}

/**
 * Exact sizes of finished artifacts for a set of files at one rung.
 *
 * Lets the candidates endpoint replace a bitrate x duration estimate with the
 * real number as soon as an artifact exists. It aggregates across audio tracks
 * because a candidate row carries no `audioIndex` — the client POSTs without
 * one and `renditions.ts` resolves the source's default itself — so several
 * ready rows can legitimately match one (file, rung). The largest is the
 * pessimistic pick; `ready_count > 1` is how the caller knows to report the
 * number as an estimate rather than exact.
 */
export async function readySizesForFiles(
    sql: postgres.Sql,
    fileIds: string[],
    rungId: string,
): Promise<ReadyRenditionSize[]> {
    if (fileIds.length === 0) return [];
    return sql<ReadyRenditionSize[]>`
        SELECT
            file_id,
            MAX(size_bytes)::text AS size_bytes,
            COUNT(*)::int AS ready_count
        FROM download_renditions
        WHERE file_id = ANY(${fileIds}::uuid[])
          AND rung_id = ${rungId}
          AND status = 'ready'
          AND size_bytes IS NOT NULL
        GROUP BY file_id
    `;
}

/**
 * Server-wide count of renditions in `queued` or `encoding` that are actually
 * LIVE — heartbeated within `staleAfterSeconds`.
 *
 * Advertised to clients as `prepareQueueDepth` so a pool on a busy server backs
 * off BEFORE it POSTs rather than learning by 503, and used as the global
 * backpressure input on the renditions POST. Deliberately not per-user: the
 * encode slot it describes is shared with live playback transcodes on the same
 * CPU, so what matters is the box's total, not one user's share of it.
 *
 * MUST be bounded by liveness, not raw status. A `queued` row is advanced by
 * NOTHING but a client re-POST (see `service.ts`'s module docstring); an app
 * killed, a pool turned off mid-flight, or a pod that dies mid-encode all
 * leave a row stuck in `queued`/`encoding` forever, since `reapToCap` only
 * ever touches `ready` rows. With the default backpressure ceiling of 8 (see
 * `SERIES_DOWNLOAD_QUEUE_BACKPRESSURE_FACTOR`), eight abandoned rows anywhere
 * on the box would otherwise 503 every pool permanently, with no recovery
 * path. `heartbeat_at` is stamped on election (`electOrGetRendition`) and
 * refreshed on a process timer as well as progress ticks (`updateProgress`), so a
 * row that is genuinely being worked on always has a fresh one; `staleAfterSeconds`
 * should be `config.DOWNLOAD_RENDITION_STALE_SECONDS`, the same threshold
 * `reclaimStaleEncode` already uses to decide a row is abandoned.
 */
export async function prepareQueueDepth(
    sql: postgres.Sql,
    staleAfterSeconds: number,
): Promise<number> {
    const [row] = await sql<[{ depth: number }]>`
        SELECT COUNT(*)::int AS depth
        FROM download_renditions
        WHERE status IN ('queued', 'encoding')
          AND heartbeat_at IS NOT NULL
          AND heartbeat_at > NOW() - MAKE_INTERVAL(secs => ${staleAfterSeconds})
    `;
    return row?.depth ?? 0;
}
