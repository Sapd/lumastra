// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type postgres from 'postgres';
import type { SyncFileItem } from '../../services/jellyfin-file-matcher.js';
import { PUSHABLE_SOURCES } from './user-media-events.queries.js';

interface LocalSyncFileRow {
    id: string;
    media_type: 'movie' | 'episode';
    title: string;
    file_path: string;
    file_size_bytes: string | null;
    root: string;
    combined: boolean;
    season_number: number | null;
    episode_number: number | null;
}
interface JellyfinPairingRow {
    media_id: string;
    external_id: string;
    media_type: 'movie' | 'episode';
    source: string | null;
}

/** Admin/system sync inventory: no user-facing catalog rows. Include duplicates even outside the push page. */
export async function getLocalSyncFiles(sql: postgres.Sql): Promise<LocalSyncFileRow[]> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- system-wide file identity reconciliation for Jellyfin sync, no catalog response
    return sql<LocalSyncFileRow[]>`
        SELECT mi.id, mi.media_type, mi.title, mf.file_path, mf.file_size_bytes::text,
               mi.season_number, mi.episode_number,
               lp.path AS root,
               (SELECT COUNT(*) > 1 FROM media_file_items sibling WHERE sibling.file_id = mf.id) AS combined
        FROM media_items mi
        JOIN media_file_items mfi ON mfi.media_item_id = mi.id
        JOIN media_files mf ON mf.id = mfi.file_id AND NOT mf.is_missing
        JOIN library_paths lp ON lp.library_group_id = mf.library_group_id AND lp.enabled
        WHERE mi.status = 'active' AND mi.has_files
          AND mi.media_type IN ('movie', 'episode')
    `;
}

export async function getJellyfinPairings(sql: postgres.Sql): Promise<JellyfinPairingRow[]> {
    return sql<
        JellyfinPairingRow[]
    >`SELECT media_id, external_id, media_type, source FROM external_ids WHERE provider = 'jellyfin'`;
}

/** Retry local changes that were previously drained before a pairing existed. */
export async function requeueNewJellyfinPairing(sql: postgres.Sql, mediaId: string): Promise<void> {
    await sql`
        UPDATE user_media_events
        SET pushed_to_providers = array_remove(pushed_to_providers, 'jellyfin'), sync_delivery = sync_delivery - 'jellyfin'
        WHERE media_id = ${mediaId}::uuid
          AND source = ANY(${sql.array([...PUSHABLE_SOURCES])})
    `;
}

/**
 * Current unresolved watch records, not a historical skipped-run count. Pulls
 * live in the durable buffer; local changes remain in the event log even when
 * the push queue drained them. An installed pairing clears the local finding.
 * Age uses first creation, so repeated pulls cannot reset the persistence clock.
 */
export async function queryJellyfinPairingStatus(
    sql: postgres.Sql,
    olderThanMinutes: number,
    eligible: readonly PushScope[],
    pullEligible: readonly string[],
): Promise<{ count: number; examples: string[] }> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items, callback-safety/require-has-files-with-active-status -- admin sync health count includes file-less watch history; returns no viewer catalog rows
    const [row] = await sql<Array<{ count: number; examples: string[] }>>`
        WITH candidates AS (
            SELECT c.* FROM jellyfin_file_inventory s,
            jsonb_to_recordset(s.candidates) AS c(media_id uuid, remote_id text, title text, conflict boolean)
        ), title_keys AS (
            SELECT c.remote_id, MIN(other.remote_id) AS key
            FROM candidates c JOIN candidates other ON other.media_id = c.media_id
            GROUP BY c.remote_id
        ), eligible AS (
            SELECT * FROM jsonb_to_recordset(${sql.json(eligible as unknown as postgres.JSONValue)}::jsonb) AS u(user_id uuid, since timestamptz)
        ), unmatched AS (
            SELECT COALESCE((SELECT key FROM title_keys WHERE remote_id = p.provider_id), p.provider_id) AS key, COALESCE(
                (SELECT c.title FROM candidates c WHERE c.remote_id = p.provider_id LIMIT 1),
                (SELECT a.title FROM watch_sync_activity a
                 WHERE a.provider = 'jellyfin' AND a.user_id = p.user_id
                   AND a.external_ref = 'jellyfin:' || p.provider_id AND a.title IS NOT NULL
                 ORDER BY a.id DESC LIMIT 1), p.provider_id
            ) AS title, p.created_at AS since,
            EXISTS (SELECT 1 FROM candidates c WHERE c.remote_id = p.provider_id AND c.conflict) AS conflict
            FROM watch_state_pending_resolution p
            JOIN users u ON u.id = p.user_id AND u.disabled_at IS NULL AND u.deleted_at IS NULL
            WHERE p.provider = 'jellyfin' AND p.user_id = ANY(${[...pullEligible]}::uuid[])
              AND EXISTS (SELECT 1 FROM candidates c WHERE c.remote_id = p.provider_id)
            UNION ALL
            SELECT k.key, mi.title, MIN(e.recorded_at) AS since, c.conflict
            FROM user_media_events e
            JOIN eligible u ON u.user_id = e.user_id AND (u.since IS NULL OR e.occurred_at >= u.since)
            JOIN users active ON active.id = e.user_id AND active.disabled_at IS NULL AND active.deleted_at IS NULL
            JOIN media_items mi ON mi.id = e.media_id AND mi.status = 'active'
            JOIN candidates c ON c.media_id = mi.id
            JOIN title_keys k ON k.remote_id = c.remote_id
            WHERE e.repudiated_at IS NULL AND e.source = ANY(${sql.array([...PUSHABLE_SOURCES])})
              AND mi.media_type IN ('movie', 'episode')
              AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = e.media_id AND ei.provider = 'jellyfin')
              -- Later episodes of a combined file ride on the linked earlier one.
              AND NOT EXISTS (
                  SELECT 1 FROM media_file_items own JOIN media_file_items sib
                      ON sib.file_id = own.file_id AND sib.media_item_id <> own.media_item_id AND sib.is_default
                  JOIN media_items sib_ep ON sib_ep.id = sib.media_item_id
                      AND sib_ep.status = 'active'
                      AND sib_ep.parent_id = mi.parent_id AND sib_ep.episode_number < mi.episode_number
                  JOIN external_ids sib_jf ON sib_jf.media_id = sib_ep.id AND sib_jf.provider = 'jellyfin'
                  WHERE own.media_item_id = e.media_id AND own.is_default)
            GROUP BY k.key, mi.id, mi.title, c.conflict
        ), aged AS (
            SELECT key, MAX(title) || CASE WHEN bool_or(conflict) THEN ' (conflicting provider IDs)' ELSE '' END AS title
            FROM unmatched WHERE since <= NOW() - ${olderThanMinutes} * INTERVAL '1 minute'
            GROUP BY key
        )
        SELECT (SELECT COUNT(*)::int FROM aged) AS count,
               ARRAY(SELECT DISTINCT title FROM aged ORDER BY title LIMIT 5) AS examples
    `;
    return row ?? { count: 0, examples: [] };
}

/** Existing public-provider identities retain priority over physical-file evidence. */
export async function getSyncProviderIdentities(
    sql: postgres.Sql,
): Promise<
    Array<{ media_id: string; provider: 'tmdb' | 'imdb'; external_id: string; media_type: string }>
> {
    return sql<
        Array<{
            media_id: string;
            provider: 'tmdb' | 'imdb';
            external_id: string;
            media_type: string;
        }>
    >`
        SELECT media_id, provider, external_id, media_type FROM external_ids
        WHERE provider IN ('tmdb', 'imdb') AND media_type IN ('movie', 'episode')
    `;
}

export interface PushScope {
    user_id: string;
    since: string | null;
}
export interface PairingCandidate {
    media_id: string;
    remote_id: string;
    title: string;
    conflict: boolean;
}
export interface FileInventoryState {
    generation: string | null;
    due: boolean;
    usable: boolean;
    refreshed_at: Date | null;
    inventory: SyncFileItem[];
    missing_ids: string[];
    missing_local_ids: string[];
    local_signature: string | null;
}

export async function getFileInventoryState(
    sql: postgres.Sql,
    includeInventory = true,
): Promise<FileInventoryState | undefined> {
    const [state] = await sql<FileInventoryState[]>`
        SELECT generation, attempted_at IS NULL OR attempted_at <= NOW() - INTERVAL '30 minutes' AS due,
               COALESCE(refreshed_at >= attempted_at, false) AS usable,
               refreshed_at, ${includeInventory ? sql`inventory` : sql`'[]'::jsonb`} AS inventory, missing_ids, missing_local_ids, local_signature FROM jellyfin_file_inventory WHERE singleton
    `;
    return state;
}

export interface FileInventoryNeed {
    /** A (throttled) fresh listing of Jellyfin is worth attempting. */
    needed: boolean;
    /**
     * No new listing is due, but a local id-less file appeared since the cached
     * one: compare it against the cached inventory, which is cheap and needs no
     * Jellyfin listing.
     */
    recompare: boolean;
    /** Local file fingerprint this verdict was judged against. */
    signature: string;
}

/** Remote history or eligible local events need fallback only if no Jellyfin id is stored. */
export async function needsFileInventory(
    sql: postgres.Sql,
    eligible: readonly PushScope[],
    incomingIds: readonly string[],
    pullEligible: readonly string[],
    discover = false,
): Promise<FileInventoryNeed> {
    const signature = await getLocalSyncSignature(sql);
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- background Jellyfin reconciliation eligibility; returns a boolean, not catalog rows
    const [row] = await sql<{ needed: boolean; recompare: boolean }[]>`
        WITH state AS (SELECT * FROM jellyfin_file_inventory WHERE singleton),
        candidates AS (
            SELECT c.* FROM state s, jsonb_to_recordset(s.candidates) AS c(media_id uuid, remote_id text)
        ), unresolved AS (
            SELECT p.provider_id AS remote_id, NULL::uuid AS media_id
            FROM watch_state_pending_resolution p
            WHERE p.provider = 'jellyfin' AND p.user_id = ANY(${[...pullEligible]}::uuid[])
              AND NOT EXISTS (SELECT 1 FROM external_ids e WHERE e.provider = 'jellyfin' AND e.external_id = p.provider_id)
            UNION ALL
            SELECT incoming.provider_id, NULL::uuid FROM unnest(${[...incomingIds]}::text[]) AS incoming(provider_id)
            WHERE NOT EXISTS (SELECT 1 FROM external_ids e WHERE e.provider = 'jellyfin' AND e.external_id = incoming.provider_id)
            UNION ALL
            SELECT NULL::text, e.media_id FROM user_media_events e
            JOIN media_items mi ON mi.id = e.media_id AND mi.status = 'active'
              AND mi.has_files AND mi.media_type IN ('movie', 'episode')
            JOIN jsonb_to_recordset(${sql.json(eligible as unknown as postgres.JSONValue)}::jsonb) AS u(user_id uuid, since timestamptz)
              ON u.user_id = e.user_id AND (u.since IS NULL OR e.occurred_at >= u.since)
            WHERE e.repudiated_at IS NULL AND e.source = ANY(${sql.array([...PUSHABLE_SOURCES])})
              AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = e.media_id AND ei.provider = 'jellyfin')
        ), idless AS (
            -- Local files that no public id can resolve and no Jellyfin id covers
            -- yet. Only these need file evidence; an episode counts as id-less when
            -- its series has no TMDB/IMDb id either (the series id resolves it).
            SELECT 1 FROM media_items mi
            WHERE ${discover} AND mi.status = 'active' AND mi.has_files
              AND mi.media_type IN ('movie', 'episode')
              AND NOT EXISTS (SELECT 1 FROM external_ids x WHERE x.media_id = mi.id
                  AND x.provider IN ('jellyfin', 'tmdb', 'imdb'))
              AND (mi.media_type = 'movie' OR NOT EXISTS (
                  SELECT 1 FROM media_items season
                  JOIN media_items series ON series.id = season.parent_id
                  JOIN external_ids x ON x.media_id = series.id AND x.provider IN ('tmdb', 'imdb')
                  WHERE season.id = mi.parent_id))
            LIMIT 1
        ) SELECT EXISTS (SELECT 1 FROM external_ids WHERE provider = 'jellyfin' AND source = 'watch-sync-file')
          -- Discovery needs no prior watch event: a fresh install must pair its
          -- id-less files before anyone plays them. Repeats only on a changed
          -- local scan (at most hourly) or the six-hour sweep.
          OR (EXISTS (SELECT 1 FROM idless) AND (
              NOT EXISTS (SELECT 1 FROM state WHERE refreshed_at IS NOT NULL)
              OR EXISTS (SELECT 1 FROM state WHERE refreshed_at <= now() - INTERVAL '6 hours')
              OR EXISTS (SELECT 1 FROM state WHERE local_signature IS DISTINCT FROM ${signature}
                  AND refreshed_at <= now() - INTERVAL '1 hour')
          ))
          OR (EXISTS (SELECT 1 FROM unresolved) AND (
              NOT EXISTS (SELECT 1 FROM state WHERE refreshed_at IS NOT NULL)
              OR EXISTS (SELECT 1 FROM state WHERE local_signature IS DISTINCT FROM ${signature})
              OR EXISTS (SELECT 1 FROM unresolved u JOIN candidates c ON c.media_id = u.media_id OR c.remote_id = u.remote_id)
              -- Discovery is independent of one-sided queue size; a remote-only
              -- change with no incoming play is discovered at most four times/day.
              OR EXISTS (SELECT 1 FROM state WHERE refreshed_at <= now() - INTERVAL '6 hours')
              OR EXISTS (SELECT 1 FROM unnest(${[...incomingIds]}::text[]) u(remote_id) WHERE NOT EXISTS (
                  SELECT 1 FROM state s, jsonb_array_elements(s.inventory) i WHERE i ->> 'id' = u.remote_id
              ))
          )) AS needed,
          -- A local id-less file that appeared after the cached listing (the fresh
          -- install scans its series while the first inventory runs) is paired from
          -- the cached listing, not from a new one: no Jellyfin traffic.
          (EXISTS (SELECT 1 FROM idless)
              AND EXISTS (SELECT 1 FROM state WHERE refreshed_at IS NOT NULL
                  AND COALESCE(refreshed_at >= attempted_at, false)
                  AND local_signature IS DISTINCT FROM ${signature})) AS recompare
    `;
    return {
        needed: row?.needed ?? false,
        recompare: row?.recompare ?? false,
        signature,
    };
}

/** Local scan fingerprint: changes invalidate negative discovery evidence. */
export async function getLocalSyncSignature(sql: postgres.Sql): Promise<string> {
    const [row] = await sql<{ signature: string }[]>`
        SELECT md5(COALESCE(string_agg(DISTINCT concat_ws('|', mfi.media_item_id, mf.file_path,
            mf.file_size_bytes, mf.is_missing, lp.path, lp.enabled), ',' ORDER BY concat_ws('|', mfi.media_item_id, mf.file_path,
            mf.file_size_bytes, mf.is_missing, lp.path, lp.enabled)), '')) AS signature
        FROM media_files mf JOIN media_file_items mfi ON mfi.file_id = mf.id
        JOIN library_paths lp ON lp.library_group_id = mf.library_group_id
    `;
    return row.signature;
}

export async function lockFilePairing(sql: postgres.Sql): Promise<void> {
    await sql`SET LOCAL lock_timeout = '2s'`;
    await sql`SELECT pg_advisory_xact_lock(hashtext('jellyfin-watch-sync-file-pairing'))`;
}

export async function claimFileInventory(sql: postgres.Sql, generation: string): Promise<void> {
    await sql`INSERT INTO jellyfin_file_inventory (singleton, attempted_at, generation)
              VALUES (true, now(), ${generation}) ON CONFLICT (singleton)
              DO UPDATE SET attempted_at = now(), generation = EXCLUDED.generation`;
}

export async function saveFileInventory(
    sql: postgres.Sql,
    inventory: readonly SyncFileItem[],
    missingIds: string[],
    missingLocalIds: string[],
    localSignature: string,
): Promise<void> {
    await sql`UPDATE jellyfin_file_inventory SET inventory = ${sql.json(inventory as unknown as postgres.JSONValue)}::jsonb,
        missing_ids = ${missingIds}::text[], missing_local_ids = ${missingLocalIds}::text[],
        local_signature = ${localSignature}, refreshed_at = now() WHERE singleton`;
}

/** Replaces only the cached listing; its refresh clock and absence bookkeeping stay. */
export async function saveFileInventoryItems(
    sql: postgres.Sql,
    inventory: readonly SyncFileItem[],
): Promise<void> {
    await sql`UPDATE jellyfin_file_inventory SET inventory = ${sql.json(inventory as unknown as postgres.JSONValue)}::jsonb WHERE singleton`;
}

export async function savePairingCandidates(
    sql: postgres.Sql,
    candidates: PairingCandidate[],
): Promise<void> {
    await sql`UPDATE jellyfin_file_inventory SET candidates = ${sql.json(candidates as unknown as postgres.JSONValue)}::jsonb WHERE singleton`;
}

/** Cached remote UUID is authoritative; otherwise honor the unambiguous login override. */
export async function getLinkedJellyfinUsers(
    sql: postgres.Sql,
    accounts: Array<{ Id: string; Name: string }>,
): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
        WITH remote AS (
            SELECT * FROM jsonb_to_recordset(${sql.json(accounts.map((u) => ({ id: u.Id.replaceAll('-', '').toLowerCase(), name: u.Name.toLowerCase() })))}::jsonb)
                AS r(id text, name text)
        )
        SELECT u.id FROM users u
        WHERE u.disabled_at IS NULL AND u.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM remote r WHERE CASE WHEN NULLIF(u.jellyfin_user_id, '') IS NOT NULL
                THEN replace(lower(u.jellyfin_user_id), '-', '') = r.id
                ELSE lower(COALESCE(u.jellyfin_username, u.username)) = r.name
                  AND NOT EXISTS (SELECT 1 FROM users other WHERE other.id <> u.id
                    AND other.disabled_at IS NULL AND other.deleted_at IS NULL
                    AND lower(COALESCE(other.jellyfin_username, other.username)) = r.name)
                END
          )
    `;
    return rows.map((row) => row.id);
}

/** Current actionable delivery failures and one-sided titles; separate from pairing warnings. */
export async function queryJellyfinDeliveryStatus(
    sql: postgres.Sql,
    eligible: readonly PushScope[],
    pullEligible: readonly string[],
): Promise<{ failed: { count: number; examples: string[] }; oneSided: number }> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items, callback-safety/require-has-files-with-active-status -- admin sync diagnostics, no catalog response
    const [row] = await sql<{ failed_count: number; examples: string[]; one_sided: number }[]>`
        WITH candidates AS (
            SELECT c.* FROM jellyfin_file_inventory s,
            jsonb_to_recordset(s.candidates) AS c(media_id uuid, remote_id text)
        ), local_pending AS (
            SELECT e.*, mi.title FROM user_media_events e
            JOIN media_items mi ON mi.id = e.media_id AND mi.status = 'active' AND mi.media_type IN ('movie', 'episode')
            JOIN jsonb_to_recordset(${sql.json(eligible as unknown as postgres.JSONValue)}::jsonb) AS u(user_id uuid, since timestamptz)
                ON u.user_id = e.user_id AND (u.since IS NULL OR e.occurred_at >= u.since)
            WHERE e.repudiated_at IS NULL AND e.source = ANY(${sql.array([...PUSHABLE_SOURCES])})
              AND NOT ('jellyfin' = ANY(e.pushed_to_providers))
        ), failures AS (
            SELECT DISTINCT ON (media_id) media_id, title || ': ' || (sync_delivery -> 'jellyfin' ->> 'last_reason') ||
                ' (attempt ' || (sync_delivery -> 'jellyfin' ->> 'attempts') || '; retry after ' ||
                (sync_delivery -> 'jellyfin' ->> 'next_attempt_at') || ')' AS description
            FROM local_pending
            WHERE sync_delivery -> 'jellyfin' ->> 'last_reason' IS NOT NULL
              AND sync_delivery -> 'jellyfin' ->> 'last_reason' NOT LIKE 'no provider id%'
              AND sync_delivery -> 'jellyfin' ->> 'last_reason' NOT LIKE 'Jellyfin holds a newer position%'
            ORDER BY media_id, recorded_at DESC
        ), one_sided AS (
            SELECT DISTINCT 'local:' || p.media_id::text AS key FROM local_pending p
            WHERE NOT EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = p.media_id AND e.provider = 'jellyfin')
              AND NOT EXISTS (SELECT 1 FROM candidates c WHERE c.media_id = p.media_id)
            UNION
            SELECT DISTINCT 'remote:' || p.provider_id FROM watch_state_pending_resolution p
            WHERE p.provider = 'jellyfin' AND p.user_id = ANY(${[...pullEligible]}::uuid[])
              AND NOT EXISTS (SELECT 1 FROM candidates c WHERE c.remote_id = p.provider_id)
              AND NOT EXISTS (SELECT 1 FROM external_ids e WHERE e.provider = 'jellyfin' AND e.external_id = p.provider_id)
        )
        SELECT (SELECT count(*)::int FROM failures) AS failed_count,
               ARRAY(SELECT description FROM failures ORDER BY description LIMIT 10) AS examples,
               (SELECT count(*)::int FROM one_sided) AS one_sided
    `;
    return {
        failed: { count: row?.failed_count ?? 0, examples: row?.examples ?? [] },
        oneSided: row?.one_sided ?? 0,
    };
}

/**
 * Drop a file-sourced Jellyfin link whose remote id no longer exists and make
 * the next inventory due. The dead id is marked missing so a non-fetching refresh
 * cannot reinstall it from the cached snapshot. Returns false when the link is
 * not file-sourced (ID-based links are never dropped here). The snapshot is
 * marked unrefreshed so discovery re-pairs the file even with no pending event.
 */
export async function invalidateStaleFileLink(
    sql: postgres.Sql,
    mediaId: string,
    remoteId: string,
): Promise<boolean> {
    const rows = await sql<{ media_type: string }[]>`
        DELETE FROM external_ids
        WHERE media_id = ${mediaId}::uuid AND provider = 'jellyfin' AND source = 'watch-sync-file'
          AND external_id = ${remoteId}
        RETURNING media_type
    `;
    if (rows.length === 0) return false;
    await sql`
        UPDATE jellyfin_file_inventory
        SET attempted_at = NULL, local_signature = NULL, refreshed_at = NULL,
            missing_ids = array_append(array_remove(missing_ids, ${remoteId}), ${remoteId})
        WHERE singleton
    `;
    return true;
}
